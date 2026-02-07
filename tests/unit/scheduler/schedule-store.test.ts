/**
 * Unit tests for schedule-store.ts
 * Tests schedule CRUD operations and limits
 */
import * as fs from 'fs/promises';
import type { Schedule } from '../../../src/scheduler/schedule-store';
import { ScheduleStore } from '../../../src/scheduler/schedule-store';

// Mock fs/promises
jest.mock('fs/promises');

// Mock logger
jest.mock('../../../src/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

/**
 * Helper to create complete schedule data with defaults
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
  const mockFs = fs as jest.Mocked<typeof fs>;

  beforeEach(() => {
    jest.clearAllMocks();
    // Reset singleton
    ScheduleStore.resetInstance();

    mockFs.readFile.mockRejectedValue({ code: 'ENOENT' });
    mockFs.writeFile.mockResolvedValue(undefined);
    mockFs.mkdir.mockResolvedValue(undefined);
  });

  afterEach(() => {
    ScheduleStore.resetInstance();
  });

  describe('getInstance', () => {
    it('should return singleton instance', () => {
      const instance1 = ScheduleStore.getInstance();
      const instance2 = ScheduleStore.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe('initialize', () => {
    it('should load existing schedules from file', async () => {
      const existingSchedules = {
        schedules: [
          {
            id: 'test-1',
            creatorId: 'user1',
            workflow: 'workflow1',
            status: 'active',
            createdAt: Date.now(),
            timezone: 'UTC',
            schedule: '',
            isRecurring: false,
            originalExpression: 'in 1 hour',
            runCount: 0,
            failureCount: 0,
          },
        ],
      };

      mockFs.readFile.mockResolvedValue(JSON.stringify(existingSchedules));

      store = ScheduleStore.getInstance();
      await store.initialize();

      const loaded = store.getAll();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].id).toBe('test-1');
    });

    it('should handle corrupted file gracefully', async () => {
      mockFs.readFile.mockResolvedValue('not valid json');

      store = ScheduleStore.getInstance();
      await store.initialize();

      expect(store.getAll()).toHaveLength(0);
    });

    it('should handle missing file gracefully', async () => {
      mockFs.readFile.mockRejectedValue({ code: 'ENOENT' });

      store = ScheduleStore.getInstance();
      await store.initialize();

      expect(store.getAll()).toHaveLength(0);
    });
  });

  describe('create', () => {
    beforeEach(async () => {
      ScheduleStore.resetInstance();
      store = ScheduleStore.getInstance();
      await store.initialize();
    });

    it('should create schedule with generated id', () => {
      const schedule = store.create(
        createScheduleData({
          creatorId: 'user1',
          workflow: 'daily-report',
          runAt: Date.now() + 3600000,
        })
      );

      expect(schedule.id).toBeDefined();
      expect(schedule.id.length).toBe(36); // UUID format
      expect(schedule.creatorId).toBe('user1');
      expect(schedule.workflow).toBe('daily-report');
      expect(schedule.status).toBe('active');
    });

    it('should add schedule to store', () => {
      const schedule = store.create(
        createScheduleData({
          creatorId: 'user1',
          workflow: 'test',
        })
      );

      const retrieved = store.get(schedule.id);
      expect(retrieved).toBeDefined();
      expect(retrieved?.workflow).toBe('test');
    });

    it('should enforce per-user limits', async () => {
      // Reset and create store with limits
      ScheduleStore.resetInstance();
      store = ScheduleStore.getInstance(undefined, { maxPerUser: 2 });
      await store.initialize();

      store.create(createScheduleData({ creatorId: 'user1', workflow: 'w1' }));
      store.create(createScheduleData({ creatorId: 'user1', workflow: 'w2' }));

      expect(() => {
        store.create(createScheduleData({ creatorId: 'user1', workflow: 'w3' }));
      }).toThrow(/maximum|limit/i);
    });

    it('should enforce global limits', async () => {
      ScheduleStore.resetInstance();
      store = ScheduleStore.getInstance(undefined, { maxGlobal: 2 });
      await store.initialize();

      store.create(createScheduleData({ creatorId: 'user1', workflow: 'w1' }));
      store.create(createScheduleData({ creatorId: 'user2', workflow: 'w2' }));

      expect(() => {
        store.create(createScheduleData({ creatorId: 'user3', workflow: 'w3' }));
      }).toThrow(/limit/i);
    });

    it('should allow different users within per-user limit', async () => {
      ScheduleStore.resetInstance();
      store = ScheduleStore.getInstance(undefined, { maxPerUser: 2 });
      await store.initialize();

      store.create(createScheduleData({ creatorId: 'user1', workflow: 'w1' }));
      store.create(createScheduleData({ creatorId: 'user1', workflow: 'w2' }));
      // Different user should be able to create
      const schedule = store.create(createScheduleData({ creatorId: 'user2', workflow: 'w3' }));

      expect(schedule.id).toBeDefined();
    });
  });

  describe('get', () => {
    beforeEach(async () => {
      ScheduleStore.resetInstance();
      store = ScheduleStore.getInstance();
      await store.initialize();
    });

    it('should retrieve schedule by id', () => {
      const created = store.create(
        createScheduleData({
          creatorId: 'user1',
          workflow: 'test',
        })
      );

      const retrieved = store.get(created.id);
      expect(retrieved).toEqual(created);
    });

    it('should return undefined for non-existent id', () => {
      const result = store.get('non-existent-id');
      expect(result).toBeUndefined();
    });
  });

  describe('getByCreator', () => {
    beforeEach(async () => {
      ScheduleStore.resetInstance();
      store = ScheduleStore.getInstance();
      await store.initialize();
    });

    it('should return schedules for specific creator', () => {
      store.create(createScheduleData({ creatorId: 'user1', workflow: 'w1' }));
      store.create(createScheduleData({ creatorId: 'user1', workflow: 'w2' }));
      store.create(createScheduleData({ creatorId: 'user2', workflow: 'w3' }));

      const user1Schedules = store.getByCreator('user1');
      expect(user1Schedules).toHaveLength(2);
      expect(user1Schedules.every(s => s.creatorId === 'user1')).toBe(true);
    });

    it('should return empty array for user with no schedules', () => {
      const result = store.getByCreator('nonexistent');
      expect(result).toEqual([]);
    });
  });

  describe('update', () => {
    beforeEach(async () => {
      ScheduleStore.resetInstance();
      store = ScheduleStore.getInstance();
      await store.initialize();
    });

    it('should update schedule fields', () => {
      const created = store.create(
        createScheduleData({
          creatorId: 'user1',
          workflow: 'test',
        })
      );

      const updated = store.update(created.id, { status: 'paused' });

      expect(updated?.status).toBe('paused');
      expect(updated?.workflow).toBe('test'); // Other fields unchanged
    });

    it('should return undefined for non-existent schedule', () => {
      const result = store.update('non-existent', { status: 'paused' });
      expect(result).toBeUndefined();
    });

    it('should reflect update in subsequent get', () => {
      const created = store.create(
        createScheduleData({
          creatorId: 'user1',
          workflow: 'test',
        })
      );

      store.update(created.id, { status: 'paused' });

      const retrieved = store.get(created.id);
      expect(retrieved?.status).toBe('paused');
    });
  });

  describe('delete', () => {
    beforeEach(async () => {
      ScheduleStore.resetInstance();
      store = ScheduleStore.getInstance();
      await store.initialize();
    });

    it('should remove schedule', () => {
      const created = store.create(
        createScheduleData({
          creatorId: 'user1',
          workflow: 'test',
        })
      );

      const deleted = store.delete(created.id);

      expect(deleted).toBe(true);
      expect(store.get(created.id)).toBeUndefined();
    });

    it('should return false for non-existent schedule', () => {
      const result = store.delete('non-existent');
      expect(result).toBe(false);
    });

    it('should not affect other schedules', () => {
      const s1 = store.create(createScheduleData({ creatorId: 'user1', workflow: 'w1' }));
      const s2 = store.create(createScheduleData({ creatorId: 'user1', workflow: 'w2' }));

      store.delete(s1.id);

      expect(store.get(s2.id)).toBeDefined();
      expect(store.getAll()).toHaveLength(1);
    });
  });

  describe('getDueSchedules', () => {
    beforeEach(async () => {
      ScheduleStore.resetInstance();
      store = ScheduleStore.getInstance();
      await store.initialize();
    });

    it('should return one-time schedules that are due', () => {
      // Create schedule due in the past
      store.create(
        createScheduleData({
          creatorId: 'user1',
          workflow: 'past',
          runAt: Date.now() - 60000, // 1 minute ago
          isRecurring: false,
        })
      );

      // Create schedule due in the future
      store.create(
        createScheduleData({
          creatorId: 'user1',
          workflow: 'future',
          runAt: Date.now() + 3600000, // 1 hour from now
          isRecurring: false,
        })
      );

      const due = store.getDueSchedules();
      expect(due).toHaveLength(1);
      expect(due[0].workflow).toBe('past');
    });

    it('should return recurring schedules with due nextRunAt', () => {
      store.create(
        createScheduleData({
          creatorId: 'user1',
          workflow: 'recurring-due',
          schedule: '0 9 * * *',
          isRecurring: true,
          nextRunAt: Date.now() - 60000,
        })
      );

      store.create(
        createScheduleData({
          creatorId: 'user1',
          workflow: 'recurring-not-due',
          schedule: '0 9 * * *',
          isRecurring: true,
          nextRunAt: Date.now() + 3600000,
        })
      );

      const due = store.getDueSchedules();
      expect(due).toHaveLength(1);
      expect(due[0].workflow).toBe('recurring-due');
    });

    it('should not return paused schedules', () => {
      const schedule = store.create(
        createScheduleData({
          creatorId: 'user1',
          workflow: 'paused',
          runAt: Date.now() - 60000,
        })
      );
      store.update(schedule.id, { status: 'paused' });

      const due = store.getDueSchedules();
      expect(due).toHaveLength(0);
    });

    it('should not return completed schedules', () => {
      const schedule = store.create(
        createScheduleData({
          creatorId: 'user1',
          workflow: 'completed',
          runAt: Date.now() - 60000,
        })
      );
      store.update(schedule.id, { status: 'completed' });

      const due = store.getDueSchedules();
      expect(due).toHaveLength(0);
    });
  });

  describe('status updates', () => {
    beforeEach(async () => {
      ScheduleStore.resetInstance();
      store = ScheduleStore.getInstance();
      await store.initialize();
    });

    it('should mark one-time schedule as completed via update', () => {
      const schedule = store.create(
        createScheduleData({
          creatorId: 'user1',
          workflow: 'test',
          isRecurring: false,
        })
      );

      store.update(schedule.id, { status: 'completed' });

      const updated = store.get(schedule.id);
      expect(updated?.status).toBe('completed');
    });

    it('should update lastRunAt and keep recurring schedule active', () => {
      const now = Date.now();
      const schedule = store.create(
        createScheduleData({
          creatorId: 'user1',
          workflow: 'test',
          isRecurring: true,
          schedule: '0 9 * * *',
          nextRunAt: now - 60000, // Was due
        })
      );

      // Simulate what scheduler would do after execution
      store.update(schedule.id, {
        lastRunAt: now,
        runCount: schedule.runCount + 1,
      });

      const updated = store.get(schedule.id);
      expect(updated?.status).toBe('active'); // Still active
      expect(updated?.lastRunAt).toBeDefined();
    });
  });

  describe('getAll', () => {
    beforeEach(async () => {
      ScheduleStore.resetInstance();
      store = ScheduleStore.getInstance();
      await store.initialize();
    });

    it('should return all schedules', () => {
      store.create(createScheduleData({ creatorId: 'user1', workflow: 'w1' }));
      store.create(createScheduleData({ creatorId: 'user2', workflow: 'w2' }));
      store.create(createScheduleData({ creatorId: 'user3', workflow: 'w3' }));

      const all = store.getAll();
      expect(all).toHaveLength(3);
    });

    it('should return empty array when no schedules', () => {
      const all = store.getAll();
      expect(all).toEqual([]);
    });
  });
});
