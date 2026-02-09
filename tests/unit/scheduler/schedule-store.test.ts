/**
 * Unit tests for schedule-store.ts (refactored to use SQL backend)
 * Tests the ScheduleStore facade which delegates to a ScheduleStoreBackend
 */
import type { Schedule } from '../../../src/scheduler/schedule-store';
import { ScheduleStore } from '../../../src/scheduler/schedule-store';
import type { ScheduleStoreBackend, ScheduleStoreStats } from '../../../src/scheduler/store/types';
import type { ScheduleLimits } from '../../../src/scheduler/schedule-store';

// Mock logger
jest.mock('../../../src/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// Mock the store factory and json-migrator so we don't need real SQLite
jest.mock('../../../src/scheduler/store/index', () => ({
  createStoreBackend: jest.fn(),
}));

jest.mock('../../../src/scheduler/store/json-migrator', () => ({
  migrateJsonToBackend: jest.fn().mockResolvedValue(0),
}));

/**
 * In-memory mock backend for testing ScheduleStore delegation
 */
class InMemoryBackend implements ScheduleStoreBackend {
  private schedules = new Map<string, Schedule>();
  private idCounter = 0;
  initCalled = false;
  shutdownCalled = false;

  async initialize() {
    this.initCalled = true;
  }

  async shutdown() {
    this.shutdownCalled = true;
  }

  async create(
    input: Omit<Schedule, 'id' | 'createdAt' | 'runCount' | 'failureCount' | 'status'>
  ): Promise<Schedule> {
    const schedule: Schedule = {
      ...input,
      id: `mock-${++this.idCounter}`,
      createdAt: Date.now(),
      runCount: 0,
      failureCount: 0,
      status: 'active',
    };
    this.schedules.set(schedule.id, schedule);
    return schedule;
  }

  async importSchedule(schedule: Schedule): Promise<void> {
    if (!this.schedules.has(schedule.id)) {
      this.schedules.set(schedule.id, schedule);
    }
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
    const lw = workflowName.toLowerCase();
    return [...this.schedules.values()].filter(
      s =>
        s.creatorId === creatorId && s.status === 'active' && s.workflow?.toLowerCase().includes(lw)
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

  async validateLimits(creatorId: string, isRecurring: boolean, limits: ScheduleLimits) {
    if (limits.maxGlobal && this.schedules.size >= limits.maxGlobal) {
      throw new Error(`Global schedule limit reached (${limits.maxGlobal})`);
    }
    const userSchedules = [...this.schedules.values()].filter(s => s.creatorId === creatorId);
    if (limits.maxPerUser && userSchedules.length >= limits.maxPerUser) {
      throw new Error(`You have reached the maximum number of schedules (${limits.maxPerUser})`);
    }
    if (isRecurring && limits.maxRecurringPerUser) {
      const recurring = userSchedules.filter(s => s.isRecurring).length;
      if (recurring >= limits.maxRecurringPerUser) {
        throw new Error(
          `You have reached the maximum number of recurring schedules (${limits.maxRecurringPerUser})`
        );
      }
    }
  }

  async tryAcquireLock() {
    return 'mock-token';
  }
  async releaseLock() {}
  async renewLock() {
    return true;
  }
  async flush() {}
}

/**
 * Helper to create schedule input data
 */
function createScheduleData(
  overrides: Partial<Schedule> & { creatorId: string; workflow: string }
) {
  return {
    timezone: 'UTC',
    schedule: '',
    isRecurring: false,
    originalExpression: 'in 1 hour',
    ...overrides,
  };
}

describe('ScheduleStore', () => {
  let store: ScheduleStore;
  let mockBackend: InMemoryBackend;

  beforeEach(async () => {
    ScheduleStore.resetInstance();
    mockBackend = new InMemoryBackend();
    store = ScheduleStore.createIsolated(undefined, undefined, mockBackend);
    await store.initialize();
  });

  afterEach(() => {
    ScheduleStore.resetInstance();
  });

  describe('getInstance', () => {
    it('should return singleton instance', () => {
      ScheduleStore.resetInstance();
      const instance1 = ScheduleStore.getInstance();
      const instance2 = ScheduleStore.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe('initialize', () => {
    it('should initialize the backend', async () => {
      expect(mockBackend.initCalled).toBe(true);
    });

    it('should only initialize once', async () => {
      await store.initialize(); // Second call
      expect(store.isInitialized()).toBe(true);
    });
  });

  describe('createAsync', () => {
    it('should create schedule via backend', async () => {
      const schedule = await store.createAsync(
        createScheduleData({
          creatorId: 'user1',
          workflow: 'daily-report',
          runAt: Date.now() + 3600000,
        })
      );

      expect(schedule.id).toBeDefined();
      expect(schedule.creatorId).toBe('user1');
      expect(schedule.workflow).toBe('daily-report');
      expect(schedule.status).toBe('active');
    });

    it('should enforce per-user limits', async () => {
      ScheduleStore.resetInstance();
      const limitedBackend = new InMemoryBackend();
      const limitedStore = ScheduleStore.createIsolated(
        undefined,
        { maxPerUser: 2 },
        limitedBackend
      );
      await limitedStore.initialize();

      await limitedStore.createAsync(createScheduleData({ creatorId: 'user1', workflow: 'w1' }));
      await limitedStore.createAsync(createScheduleData({ creatorId: 'user1', workflow: 'w2' }));

      await expect(
        limitedStore.createAsync(createScheduleData({ creatorId: 'user1', workflow: 'w3' }))
      ).rejects.toThrow(/maximum|limit/i);
    });

    it('should enforce global limits', async () => {
      ScheduleStore.resetInstance();
      const limitedBackend = new InMemoryBackend();
      const limitedStore = ScheduleStore.createIsolated(
        undefined,
        { maxGlobal: 2 },
        limitedBackend
      );
      await limitedStore.initialize();

      await limitedStore.createAsync(createScheduleData({ creatorId: 'user1', workflow: 'w1' }));
      await limitedStore.createAsync(createScheduleData({ creatorId: 'user2', workflow: 'w2' }));

      await expect(
        limitedStore.createAsync(createScheduleData({ creatorId: 'user3', workflow: 'w3' }))
      ).rejects.toThrow(/limit/i);
    });
  });

  describe('getAsync', () => {
    it('should retrieve schedule by id', async () => {
      const created = await store.createAsync(
        createScheduleData({ creatorId: 'user1', workflow: 'test' })
      );
      const retrieved = await store.getAsync(created.id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.workflow).toBe('test');
    });

    it('should return undefined for non-existent id', async () => {
      const result = await store.getAsync('non-existent');
      expect(result).toBeUndefined();
    });
  });

  describe('updateAsync', () => {
    it('should update schedule fields', async () => {
      const created = await store.createAsync(
        createScheduleData({ creatorId: 'user1', workflow: 'test' })
      );

      const updated = await store.updateAsync(created.id, { status: 'paused' });

      expect(updated?.status).toBe('paused');
      expect(updated?.workflow).toBe('test');
    });

    it('should return undefined for non-existent schedule', async () => {
      const result = await store.updateAsync('non-existent', { status: 'paused' });
      expect(result).toBeUndefined();
    });
  });

  describe('deleteAsync', () => {
    it('should remove schedule', async () => {
      const created = await store.createAsync(
        createScheduleData({ creatorId: 'user1', workflow: 'test' })
      );

      const deleted = await store.deleteAsync(created.id);
      expect(deleted).toBe(true);
      expect(await store.getAsync(created.id)).toBeUndefined();
    });

    it('should return false for non-existent schedule', async () => {
      const result = await store.deleteAsync('non-existent');
      expect(result).toBe(false);
    });
  });

  describe('getByCreatorAsync', () => {
    it('should return schedules for specific creator', async () => {
      await store.createAsync(createScheduleData({ creatorId: 'user1', workflow: 'w1' }));
      await store.createAsync(createScheduleData({ creatorId: 'user1', workflow: 'w2' }));
      await store.createAsync(createScheduleData({ creatorId: 'user2', workflow: 'w3' }));

      const user1Schedules = await store.getByCreatorAsync('user1');
      expect(user1Schedules).toHaveLength(2);
      expect(user1Schedules.every(s => s.creatorId === 'user1')).toBe(true);
    });
  });

  describe('getDueSchedulesAsync', () => {
    it('should return one-time schedules that are due', async () => {
      await store.createAsync(
        createScheduleData({
          creatorId: 'user1',
          workflow: 'past',
          runAt: Date.now() - 60000,
          isRecurring: false,
        })
      );
      await store.createAsync(
        createScheduleData({
          creatorId: 'user1',
          workflow: 'future',
          runAt: Date.now() + 3600000,
          isRecurring: false,
        })
      );

      const due = await store.getDueSchedulesAsync();
      expect(due).toHaveLength(1);
      expect(due[0].workflow).toBe('past');
    });
  });

  describe('getAllAsync', () => {
    it('should return all schedules', async () => {
      await store.createAsync(createScheduleData({ creatorId: 'user1', workflow: 'w1' }));
      await store.createAsync(createScheduleData({ creatorId: 'user2', workflow: 'w2' }));

      const all = await store.getAllAsync();
      expect(all).toHaveLength(2);
    });
  });

  describe('getStatsAsync', () => {
    it('should return correct statistics', async () => {
      await store.createAsync(
        createScheduleData({
          creatorId: 'user1',
          workflow: 'w1',
          isRecurring: true,
          schedule: '0 9 * * *',
        })
      );
      const s2 = await store.createAsync(
        createScheduleData({ creatorId: 'user1', workflow: 'w2' })
      );
      await store.updateAsync(s2.id, { status: 'paused' });

      const stats = await store.getStatsAsync();
      expect(stats.total).toBe(2);
      expect(stats.active).toBe(1);
      expect(stats.paused).toBe(1);
      expect(stats.recurring).toBe(1);
      expect(stats.oneTime).toBe(1);
    });
  });

  describe('previousResponse', () => {
    it('should store and retrieve previousResponse', async () => {
      const schedule = await store.createAsync(
        createScheduleData({
          creatorId: 'user1',
          workflow: 'daily-report',
          isRecurring: true,
          schedule: '0 9 * * *',
        })
      );

      await store.updateAsync(schedule.id, {
        previousResponse: 'Here is the status report.',
      });

      const updated = await store.getAsync(schedule.id);
      expect(updated?.previousResponse).toBe('Here is the status report.');
    });

    it('should update previousResponse on subsequent runs', async () => {
      const schedule = await store.createAsync(
        createScheduleData({
          creatorId: 'user1',
          workflow: 'weekly-summary',
          isRecurring: true,
          schedule: '0 9 * * 1',
        })
      );

      await store.updateAsync(schedule.id, {
        previousResponse: 'Week 1 summary.',
        runCount: 1,
      });

      await store.updateAsync(schedule.id, {
        previousResponse: 'Week 2 summary.',
        runCount: 2,
      });

      const updated = await store.getAsync(schedule.id);
      expect(updated?.previousResponse).toBe('Week 2 summary.');
      expect(updated?.runCount).toBe(2);
    });
  });

  describe('getBackend', () => {
    it('should return the underlying backend', () => {
      const backend = store.getBackend();
      expect(backend).toBe(mockBackend);
    });
  });

  describe('shutdown', () => {
    it('should shut down the backend', async () => {
      await store.shutdown();
      expect(mockBackend.shutdownCalled).toBe(true);
    });
  });
});
