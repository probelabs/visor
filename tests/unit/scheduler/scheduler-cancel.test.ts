/**
 * Unit tests for scheduler cancellation bug fix
 *
 * Bug: When a user cancels a schedule, only the DB record is deleted.
 * The in-memory cron job or setTimeout continues running, so the
 * cancelled schedule still fires until the app restarts.
 *
 * Fix requires:
 * 1. Scheduler.cancelSchedule(id) — stops in-memory job + removes from Maps
 * 2. executeSchedule() — DB freshness check before executing (safety net)
 * 3. handleCancel() — calls scheduler.cancelSchedule() after DB delete
 */
import type { ScheduleStoreBackend, ScheduleStoreStats } from '../../../src/scheduler/store/types';
import type { Schedule } from '../../../src/scheduler/schedule-store';
import { ScheduleStore } from '../../../src/scheduler/schedule-store';

// Mock node-cron
const mockCronSchedule = jest.fn();
const mockCronValidate = jest.fn().mockReturnValue(true);
jest.mock('node-cron', () => ({
  schedule: (...args: any[]) => {
    const task = {
      stop: jest.fn(),
      start: jest.fn(),
    };
    mockCronSchedule(...args);
    (task as any)._callback = args[1];
    return task;
  },
  validate: (...args: any[]) => mockCronValidate(...args),
}));

// Mock logger
jest.mock('../../../src/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mock schedule-parser
jest.mock('../../../src/scheduler/schedule-parser', () => ({
  isValidCronExpression: jest.fn().mockReturnValue(true),
  getNextRunTime: jest.fn().mockReturnValue(new Date(Date.now() + 3600000)),
  parseScheduleExpression: jest.fn(),
}));

/**
 * In-memory mock backend that tracks all operations
 */
class MockBackend implements ScheduleStoreBackend {
  schedules = new Map<string, Schedule>();

  async initialize() {}
  async shutdown() {}
  async flush() {}

  async create(
    input: Omit<Schedule, 'id' | 'createdAt' | 'runCount' | 'failureCount' | 'status'>
  ): Promise<Schedule> {
    const schedule: Schedule = {
      ...input,
      id: `mock-${Date.now()}-${Math.random()}`,
      createdAt: Date.now(),
      runCount: 0,
      failureCount: 0,
      status: 'active',
    };
    this.schedules.set(schedule.id, schedule);
    return schedule;
  }

  async importSchedule(schedule: Schedule): Promise<void> {
    this.schedules.set(schedule.id, schedule);
  }

  async get(id: string) {
    return this.schedules.get(id);
  }

  async update(id: string, patch: Partial<Schedule>) {
    const existing = this.schedules.get(id);
    if (!existing) return undefined;
    const updated = { ...existing, ...patch, id: existing.id };
    this.schedules.set(id, updated);
    return updated;
  }

  async delete(id: string) {
    return this.schedules.delete(id);
  }

  async getByCreator(creatorId: string) {
    return [...this.schedules.values()].filter(s => s.creatorId === creatorId);
  }

  async getActiveSchedules() {
    return [...this.schedules.values()].filter(s => s.status === 'active');
  }

  async getDueSchedules(now?: number) {
    const ts = now ?? Date.now();
    return [...this.schedules.values()].filter(s => {
      if (s.status !== 'active') return false;
      if (!s.isRecurring && s.runAt) return s.runAt <= ts;
      if (s.isRecurring && s.nextRunAt) return s.nextRunAt <= ts;
      return false;
    });
  }

  async findByWorkflow(creatorId: string, workflowName: string) {
    return [...this.schedules.values()].filter(
      s => s.creatorId === creatorId && s.status === 'active' && s.workflow?.includes(workflowName)
    );
  }

  async getAll() {
    return [...this.schedules.values()];
  }

  async getStats(): Promise<ScheduleStoreStats> {
    const all = [...this.schedules.values()];
    return {
      total: all.length,
      active: all.filter(s => s.status === 'active').length,
      paused: all.filter(s => s.status === 'paused').length,
      completed: all.filter(s => s.status === 'completed').length,
      failed: all.filter(s => s.status === 'failed').length,
      recurring: all.filter(s => s.isRecurring).length,
      oneTime: all.filter(s => !s.isRecurring).length,
    };
  }

  async validateLimits() {}

  async tryAcquireLock() {
    return 'mock-token';
  }
  async releaseLock() {}
  async renewLock() {
    return true;
  }
}

/**
 * Helper to create a mock schedule with all required fields
 */
function makeSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'test-schedule-1',
    creatorId: 'user-1',
    timezone: 'UTC',
    schedule: '',
    originalExpression: 'test schedule',
    isRecurring: false,
    workflow: 'test-workflow',
    status: 'active',
    createdAt: Date.now(),
    runCount: 0,
    failureCount: 0,
    ...overrides,
  };
}

describe('Scheduler cancellation', () => {
  let backend: MockBackend;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    backend = new MockBackend();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('cancelSchedule method', () => {
    it('should exist as a public method on Scheduler', async () => {
      const { Scheduler } = await import('../../../src/scheduler/scheduler');
      const scheduler = new Scheduler({} as any, { enabled: false });
      expect(typeof scheduler.cancelSchedule).toBe('function');
    });

    it('should stop a cron job and remove it from the in-memory map', async () => {
      const { Scheduler } = await import('../../../src/scheduler/scheduler');
      const scheduler = new Scheduler({} as any, {
        enabled: false,
        checkIntervalMs: 999999,
      });

      const cronJobs = (scheduler as any).cronJobs as Map<string, any>;

      // Simulate a scheduled cron job
      const mockJob = { stop: jest.fn(), start: jest.fn() };
      cronJobs.set('sched-recurring-1', mockJob);
      expect(cronJobs.has('sched-recurring-1')).toBe(true);

      scheduler.cancelSchedule('sched-recurring-1');

      expect(mockJob.stop).toHaveBeenCalled();
      expect(cronJobs.has('sched-recurring-1')).toBe(false);
    });

    it('should clear a setTimeout and remove it from the in-memory map', async () => {
      const { Scheduler } = await import('../../../src/scheduler/scheduler');
      const scheduler = new Scheduler({} as any, {
        enabled: false,
        checkIntervalMs: 999999,
      });

      const oneTimeTimeouts = (scheduler as any).oneTimeTimeouts as Map<string, NodeJS.Timeout>;

      const timeout = setTimeout(() => {}, 60000);
      oneTimeTimeouts.set('sched-onetime-1', timeout);
      expect(oneTimeTimeouts.has('sched-onetime-1')).toBe(true);

      scheduler.cancelSchedule('sched-onetime-1');

      expect(oneTimeTimeouts.has('sched-onetime-1')).toBe(false);
    });

    it('should be a no-op for unknown schedule IDs', async () => {
      const { Scheduler } = await import('../../../src/scheduler/scheduler');
      const scheduler = new Scheduler({} as any, { enabled: false });

      expect(() => scheduler.cancelSchedule('nonexistent-id')).not.toThrow();
    });
  });

  describe('executeSchedule DB freshness check', () => {
    it('should not execute a schedule that was deleted from DB', async () => {
      const { Scheduler } = await import('../../../src/scheduler/scheduler');
      const scheduler = new Scheduler({} as any, {
        enabled: false,
        checkIntervalMs: 999999,
      });

      // Use createIsolated to wire up mock backend properly
      const store = ScheduleStore.createIsolated({}, undefined, backend);
      await store.initialize();
      (scheduler as any).store = store;

      // Create a schedule, then delete it from DB (simulating user cancel)
      const schedule = makeSchedule({ id: 'sched-deleted' });
      backend.schedules.set(schedule.id, schedule);
      backend.schedules.delete(schedule.id);

      const mockExecuteWorkflow = jest.fn().mockResolvedValue('done');
      (scheduler as any).executeWorkflow = mockExecuteWorkflow;

      await (scheduler as any).executeSchedule(schedule);

      // Workflow should NOT have been executed — schedule is gone from DB
      expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    });

    it('should not execute a schedule that was paused in DB', async () => {
      const { Scheduler } = await import('../../../src/scheduler/scheduler');
      const scheduler = new Scheduler({} as any, {
        enabled: false,
        checkIntervalMs: 999999,
      });

      const store = ScheduleStore.createIsolated({}, undefined, backend);
      await store.initialize();
      (scheduler as any).store = store;

      const schedule = makeSchedule({ id: 'sched-paused' });
      backend.schedules.set(schedule.id, { ...schedule, status: 'paused' });

      const mockExecuteWorkflow = jest.fn().mockResolvedValue('done');
      (scheduler as any).executeWorkflow = mockExecuteWorkflow;

      await (scheduler as any).executeSchedule(schedule);

      expect(mockExecuteWorkflow).not.toHaveBeenCalled();
    });

    it('should execute a schedule that is still active in DB', async () => {
      const { Scheduler } = await import('../../../src/scheduler/scheduler');
      const scheduler = new Scheduler({} as any, {
        enabled: false,
        checkIntervalMs: 999999,
      });

      const store = ScheduleStore.createIsolated({}, undefined, backend);
      await store.initialize();
      (scheduler as any).store = store;

      const schedule = makeSchedule({ id: 'sched-active' });
      backend.schedules.set(schedule.id, schedule);

      const mockExecuteWorkflow = jest.fn().mockResolvedValue('done');
      (scheduler as any).executeWorkflow = mockExecuteWorkflow;
      (scheduler as any).sendResult = jest.fn();

      await (scheduler as any).executeSchedule(schedule);

      // Workflow SHOULD have been executed — schedule is still active
      expect(mockExecuteWorkflow).toHaveBeenCalled();
    });
  });

  describe('handleCancel should notify scheduler', () => {
    it('should call scheduler.cancelSchedule after deleting from DB', async () => {
      jest.resetModules();

      // Re-mock dependencies after resetModules
      jest.mock('../../../src/logger', () => ({
        logger: {
          info: jest.fn(),
          warn: jest.fn(),
          error: jest.fn(),
          debug: jest.fn(),
        },
      }));

      jest.mock('../../../src/scheduler/schedule-parser', () => ({
        isValidCronExpression: jest.fn().mockReturnValue(true),
        getNextRunTime: jest.fn().mockReturnValue(new Date(Date.now() + 3600000)),
        parseScheduleExpression: jest.fn(),
      }));

      const mockCancelSchedule = jest.fn();
      jest.mock('../../../src/scheduler/scheduler', () => ({
        getScheduler: jest.fn().mockReturnValue({
          cancelSchedule: mockCancelSchedule,
        }),
        Scheduler: jest.fn(),
        resetScheduler: jest.fn(),
      }));

      const mockStore = {
        isInitialized: jest.fn().mockReturnValue(true),
        initialize: jest.fn().mockResolvedValue(undefined),
        createAsync: jest.fn(),
        getAsync: jest.fn(),
        getByCreatorAsync: jest.fn().mockResolvedValue([
          {
            id: 'sched-1',
            creatorId: 'user123',
            workflow: 'daily-report',
            status: 'active',
          },
        ]),
        updateAsync: jest.fn(),
        deleteAsync: jest.fn().mockResolvedValue(true),
      };

      jest.mock('../../../src/scheduler/schedule-store', () => ({
        ScheduleStore: {
          getInstance: jest.fn().mockReturnValue(mockStore),
        },
      }));

      const { handleScheduleAction } = await import('../../../src/scheduler/schedule-tool');

      const result = await handleScheduleAction(
        { action: 'cancel', schedule_id: 'sched-1' },
        { userId: 'user123', contextType: 'cli' }
      );

      expect(result.success).toBe(true);
      expect(mockStore.deleteAsync).toHaveBeenCalledWith('sched-1');
      // In-memory job should also be cancelled via the scheduler
      expect(mockCancelSchedule).toHaveBeenCalledWith('sched-1');
    });
  });
});
