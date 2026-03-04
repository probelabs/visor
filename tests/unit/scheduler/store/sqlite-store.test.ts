/**
 * Unit tests for KnexStoreBackend with SQLite driver
 * Uses a real SQLite database via Knex's better-sqlite3 dialect
 */
import { KnexStoreBackend } from '../../../../src/scheduler/store/knex-store';
import type { Schedule } from '../../../../src/scheduler/schedule-store';
import type { ScheduleStoreBackend } from '../../../../src/scheduler/store/types';
import os from 'os';
import path from 'path';
import fs from 'fs';

// Mock logger
jest.mock('../../../../src/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

/**
 * Helper to create schedule input data
 */
function scheduleInput(overrides: Partial<Schedule> = {}) {
  return {
    creatorId: 'user1',
    creatorContext: 'cli',
    creatorName: 'Test User',
    timezone: 'UTC',
    schedule: '',
    isRecurring: false,
    originalExpression: 'in 1 hour',
    workflow: 'test-workflow',
    ...overrides,
  };
}

describe('KnexStoreBackend (sqlite)', () => {
  let backend: ScheduleStoreBackend;
  let tmpDir: string;

  beforeEach(async () => {
    // Use a temp directory for each test
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-sqlite-test-'));
    const dbPath = path.join(tmpDir, 'test.db');
    backend = new KnexStoreBackend('sqlite', {
      driver: 'sqlite',
      connection: { filename: dbPath },
    });
    await backend.initialize();
  });

  afterEach(async () => {
    await backend.shutdown();
    // Clean up temp directory
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('initialize', () => {
    it('should create database and tables', async () => {
      // Already initialized in beforeEach
      const all = await backend.getAll();
      expect(all).toEqual([]);
    });

    it('should be idempotent (re-initialize)', async () => {
      // Initialize again - should not throw
      await backend.initialize();
      const all = await backend.getAll();
      expect(all).toEqual([]);
    });

    it('should enable WAL journal mode', async () => {
      // Access the underlying knex instance to verify WAL mode
      const knex = (backend as any).knex;
      const result = await knex.raw('PRAGMA journal_mode');
      // Knex returns an array of row objects for better-sqlite3
      const mode = Array.isArray(result) ? result[0]?.journal_mode : result?.journal_mode;
      expect(mode).toBe('wal');
    });

    it('should create parent directories recursively', async () => {
      const nestedDir = path.join(tmpDir, 'deep', 'nested', 'dir');
      const dbPath = path.join(nestedDir, 'test.db');
      const nested = new KnexStoreBackend('sqlite', {
        driver: 'sqlite',
        connection: { filename: dbPath },
      });
      await nested.initialize();
      expect(fs.existsSync(dbPath)).toBe(true);
      await nested.shutdown();
    });

    it('should use default path when no filename provided', async () => {
      // Just verify construction doesn't throw — we don't actually init
      // because it would create .visor/schedules.db in cwd
      const noFile = new KnexStoreBackend('sqlite', { driver: 'sqlite' });
      expect(noFile).toBeDefined();
    });
  });

  describe('create', () => {
    it('should create a schedule with generated id and timestamps', async () => {
      const schedule = await backend.create(scheduleInput());

      expect(schedule.id).toBeDefined();
      expect(schedule.id.length).toBe(36); // UUID format
      expect(schedule.creatorId).toBe('user1');
      expect(schedule.workflow).toBe('test-workflow');
      expect(schedule.status).toBe('active');
      expect(schedule.runCount).toBe(0);
      expect(schedule.failureCount).toBe(0);
      expect(schedule.createdAt).toBeGreaterThan(0);
    });

    it('should persist the schedule to the database', async () => {
      const created = await backend.create(scheduleInput());
      const retrieved = await backend.get(created.id);

      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe(created.id);
      expect(retrieved!.workflow).toBe('test-workflow');
    });

    it('should handle complex fields (JSON serialization)', async () => {
      const created = await backend.create(
        scheduleInput({
          workflowInputs: { key: 'value', nested: { a: 1 } },
          outputContext: {
            type: 'slack',
            target: '#general',
            threadId: 'ts123',
            metadata: { extra: true },
          },
        })
      );

      const retrieved = await backend.get(created.id);
      expect(retrieved!.workflowInputs).toEqual({ key: 'value', nested: { a: 1 } });
      expect(retrieved!.outputContext).toEqual({
        type: 'slack',
        target: '#general',
        threadId: 'ts123',
        metadata: { extra: true },
      });
    });

    it('should handle undefined optional fields', async () => {
      const created = await backend.create(
        scheduleInput({
          workflow: undefined,
          workflowInputs: undefined,
          outputContext: undefined,
          runAt: undefined,
        })
      );

      const retrieved = await backend.get(created.id);
      expect(retrieved!.workflow).toBeUndefined();
      expect(retrieved!.workflowInputs).toBeUndefined();
      expect(retrieved!.outputContext).toBeUndefined();
      expect(retrieved!.runAt).toBeUndefined();
    });
  });

  describe('get', () => {
    it('should return undefined for non-existent id', async () => {
      const result = await backend.get('non-existent');
      expect(result).toBeUndefined();
    });
  });

  describe('update', () => {
    it('should update specific fields', async () => {
      const created = await backend.create(scheduleInput());
      const updated = await backend.update(created.id, { status: 'paused' });

      expect(updated).toBeDefined();
      expect(updated!.status).toBe('paused');
      expect(updated!.workflow).toBe('test-workflow'); // unchanged
    });

    it('should not allow changing the id', async () => {
      const created = await backend.create(scheduleInput());
      const updated = await backend.update(created.id, { id: 'new-id' } as Partial<Schedule>);

      expect(updated!.id).toBe(created.id); // id unchanged
    });

    it('should return undefined for non-existent schedule', async () => {
      const result = await backend.update('non-existent', { status: 'paused' });
      expect(result).toBeUndefined();
    });

    it('should persist updates', async () => {
      const created = await backend.create(scheduleInput());
      await backend.update(created.id, {
        lastRunAt: Date.now(),
        runCount: 5,
        previousResponse: 'test response',
      });

      const retrieved = await backend.get(created.id);
      expect(retrieved!.runCount).toBe(5);
      expect(retrieved!.previousResponse).toBe('test response');
    });
  });

  describe('delete', () => {
    it('should remove a schedule', async () => {
      const created = await backend.create(scheduleInput());
      const deleted = await backend.delete(created.id);

      expect(deleted).toBe(true);
      expect(await backend.get(created.id)).toBeUndefined();
    });

    it('should return false for non-existent schedule', async () => {
      const result = await backend.delete('non-existent');
      expect(result).toBe(false);
    });

    it('should not affect other schedules', async () => {
      const s1 = await backend.create(scheduleInput({ workflow: 'w1' }));
      const s2 = await backend.create(scheduleInput({ workflow: 'w2' }));

      await backend.delete(s1.id);

      expect(await backend.get(s2.id)).toBeDefined();
      const all = await backend.getAll();
      expect(all).toHaveLength(1);
    });
  });

  describe('getByCreator', () => {
    it('should return schedules for specific creator', async () => {
      await backend.create(scheduleInput({ creatorId: 'user1', workflow: 'w1' }));
      await backend.create(scheduleInput({ creatorId: 'user1', workflow: 'w2' }));
      await backend.create(scheduleInput({ creatorId: 'user2', workflow: 'w3' }));

      const user1Schedules = await backend.getByCreator('user1');
      expect(user1Schedules).toHaveLength(2);
      expect(user1Schedules.every(s => s.creatorId === 'user1')).toBe(true);
    });

    it('should return empty array for unknown creator', async () => {
      const result = await backend.getByCreator('nonexistent');
      expect(result).toEqual([]);
    });
  });

  describe('getActiveSchedules', () => {
    it('should return only active schedules', async () => {
      await backend.create(scheduleInput({ workflow: 'active' }));
      const s2 = await backend.create(scheduleInput({ workflow: 'paused' }));
      await backend.update(s2.id, { status: 'paused' });

      const active = await backend.getActiveSchedules();
      expect(active).toHaveLength(1);
      expect(active[0].workflow).toBe('active');
    });
  });

  describe('getDueSchedules', () => {
    it('should return one-time schedules that are due', async () => {
      await backend.create(
        scheduleInput({ workflow: 'past', runAt: Date.now() - 60000, isRecurring: false })
      );
      await backend.create(
        scheduleInput({ workflow: 'future', runAt: Date.now() + 3600000, isRecurring: false })
      );

      const due = await backend.getDueSchedules();
      expect(due).toHaveLength(1);
      expect(due[0].workflow).toBe('past');
    });

    it('should return recurring schedules with due nextRunAt', async () => {
      await backend.create(
        scheduleInput({
          workflow: 'recurring-due',
          schedule: '0 9 * * *',
          isRecurring: true,
          nextRunAt: Date.now() - 60000,
        })
      );
      await backend.create(
        scheduleInput({
          workflow: 'recurring-not-due',
          schedule: '0 9 * * *',
          isRecurring: true,
          nextRunAt: Date.now() + 3600000,
        })
      );

      const due = await backend.getDueSchedules();
      expect(due).toHaveLength(1);
      expect(due[0].workflow).toBe('recurring-due');
    });

    it('should not return paused schedules', async () => {
      const s = await backend.create(
        scheduleInput({ workflow: 'paused', runAt: Date.now() - 60000 })
      );
      await backend.update(s.id, { status: 'paused' });

      const due = await backend.getDueSchedules();
      expect(due).toHaveLength(0);
    });
  });

  describe('findByWorkflow', () => {
    it('should find by case-insensitive substring', async () => {
      await backend.create(scheduleInput({ creatorId: 'user1', workflow: 'Daily-Report' }));
      await backend.create(scheduleInput({ creatorId: 'user1', workflow: 'security-scan' }));

      const results = await backend.findByWorkflow('user1', 'report');
      expect(results).toHaveLength(1);
      expect(results[0].workflow).toBe('Daily-Report');
    });

    it('should escape % in search term', async () => {
      await backend.create(scheduleInput({ creatorId: 'user1', workflow: '100%-done' }));
      await backend.create(scheduleInput({ creatorId: 'user1', workflow: 'other-workflow' }));

      // Searching for literal "%" should not act as SQL wildcard
      const results = await backend.findByWorkflow('user1', '100%');
      expect(results).toHaveLength(1);
      expect(results[0].workflow).toBe('100%-done');
    });

    it('should escape _ in search term', async () => {
      await backend.create(scheduleInput({ creatorId: 'user1', workflow: 'my_workflow' }));
      await backend.create(scheduleInput({ creatorId: 'user1', workflow: 'myXworkflow' }));

      // "_" should not match single character wildcard
      const results = await backend.findByWorkflow('user1', 'my_');
      expect(results).toHaveLength(1);
      expect(results[0].workflow).toBe('my_workflow');
    });

    it('should escape backslash in search term', async () => {
      await backend.create(scheduleInput({ creatorId: 'user1', workflow: 'path\\to\\flow' }));
      await backend.create(scheduleInput({ creatorId: 'user1', workflow: 'pathXtoXflow' }));

      const results = await backend.findByWorkflow('user1', '\\to\\');
      expect(results).toHaveLength(1);
      expect(results[0].workflow).toBe('path\\to\\flow');
    });

    it('should return empty for no matches', async () => {
      await backend.create(scheduleInput({ creatorId: 'user1', workflow: 'daily-report' }));

      const results = await backend.findByWorkflow('user1', 'nonexistent');
      expect(results).toEqual([]);
    });

    it('should only return active schedules', async () => {
      const s = await backend.create(
        scheduleInput({ creatorId: 'user1', workflow: 'paused-workflow' })
      );
      await backend.update(s.id, { status: 'paused' });

      const results = await backend.findByWorkflow('user1', 'paused');
      expect(results).toEqual([]);
    });
  });

  describe('getStats', () => {
    it('should return correct statistics', async () => {
      const s1 = await backend.create(scheduleInput({ isRecurring: true, schedule: '0 9 * * *' }));
      await backend.create(scheduleInput({ isRecurring: false }));
      const s3 = await backend.create(scheduleInput({ isRecurring: false }));
      await backend.update(s1.id, { status: 'paused' });
      await backend.update(s3.id, { status: 'failed' });

      const stats = await backend.getStats();
      expect(stats.total).toBe(3);
      expect(stats.active).toBe(1);
      expect(stats.paused).toBe(1);
      expect(stats.failed).toBe(1);
      expect(stats.recurring).toBe(1);
      expect(stats.oneTime).toBe(2);
    });

    it('should return all zeros for empty database', async () => {
      const stats = await backend.getStats();
      expect(stats.total).toBe(0);
      expect(stats.active).toBe(0);
      expect(stats.paused).toBe(0);
      expect(stats.completed).toBe(0);
      expect(stats.failed).toBe(0);
      expect(stats.recurring).toBe(0);
      expect(stats.oneTime).toBe(0);
    });
  });

  describe('importSchedule', () => {
    it('should import a schedule preserving its original ID', async () => {
      const schedule: Schedule = {
        id: 'custom-id-12345',
        creatorId: 'user1',
        timezone: 'UTC',
        schedule: '0 9 * * *',
        isRecurring: true,
        originalExpression: 'every day at 9am',
        workflow: 'imported-workflow',
        status: 'active',
        createdAt: 1700000000000,
        runCount: 10,
        failureCount: 2,
      };

      await backend.importSchedule(schedule);

      const retrieved = await backend.get('custom-id-12345');
      expect(retrieved).toBeDefined();
      expect(retrieved!.id).toBe('custom-id-12345');
      expect(retrieved!.workflow).toBe('imported-workflow');
      expect(retrieved!.runCount).toBe(10);
    });

    it('should be idempotent (skip existing IDs)', async () => {
      const schedule: Schedule = {
        id: 'import-idem-id',
        creatorId: 'user1',
        timezone: 'UTC',
        schedule: '',
        isRecurring: false,
        originalExpression: 'in 1 hour',
        workflow: 'original',
        status: 'active',
        createdAt: 1700000000000,
        runCount: 0,
        failureCount: 0,
      };

      await backend.importSchedule(schedule);
      // Import again with different data — should be skipped
      await backend.importSchedule({ ...schedule, workflow: 'changed' });

      const retrieved = await backend.get('import-idem-id');
      expect(retrieved!.workflow).toBe('original');

      const all = await backend.getAll();
      expect(all.filter(s => s.id === 'import-idem-id')).toHaveLength(1);
    });
  });

  describe('validateLimits', () => {
    it('should throw on global limit', async () => {
      await backend.create(scheduleInput({ creatorId: 'u1' }));
      await backend.create(scheduleInput({ creatorId: 'u2' }));

      await expect(backend.validateLimits('u3', false, { maxGlobal: 2 })).rejects.toThrow(/limit/i);
    });

    it('should throw on per-user limit', async () => {
      await backend.create(scheduleInput({ creatorId: 'user1' }));
      await backend.create(scheduleInput({ creatorId: 'user1' }));

      await expect(backend.validateLimits('user1', false, { maxPerUser: 2 })).rejects.toThrow(
        /maximum/i
      );
    });

    it('should throw on per-user recurring limit', async () => {
      await backend.create(
        scheduleInput({ creatorId: 'user1', isRecurring: true, schedule: '0 9 * * *' })
      );

      await expect(
        backend.validateLimits('user1', true, { maxRecurringPerUser: 1 })
      ).rejects.toThrow(/recurring/i);
    });

    it('should not throw when within limits', async () => {
      await backend.create(scheduleInput({ creatorId: 'user1' }));

      await expect(
        backend.validateLimits('user1', false, { maxPerUser: 5, maxGlobal: 100 })
      ).resolves.not.toThrow();
    });
  });

  describe('HA locking (in-memory)', () => {
    it('should acquire and release lock', async () => {
      await backend.create(scheduleInput());

      const token = await backend.tryAcquireLock('schedule-1', 'node-a', 60);
      expect(token).toBeTruthy();

      await backend.releaseLock('schedule-1', token!);

      // Can acquire again after release
      const token2 = await backend.tryAcquireLock('schedule-1', 'node-b', 60);
      expect(token2).toBeTruthy();
    });

    it('should prevent concurrent lock acquisition by different nodes', async () => {
      const token = await backend.tryAcquireLock('schedule-1', 'node-a', 60);
      expect(token).toBeTruthy();

      const token2 = await backend.tryAcquireLock('schedule-1', 'node-b', 60);
      expect(token2).toBeNull();
    });

    it('should allow same node to re-acquire', async () => {
      const token1 = await backend.tryAcquireLock('schedule-1', 'node-a', 60);
      const token2 = await backend.tryAcquireLock('schedule-1', 'node-a', 60);
      expect(token1).toBe(token2); // Same token returned
    });

    it('should renew lock', async () => {
      const token = await backend.tryAcquireLock('schedule-1', 'node-a', 60);
      expect(token).toBeTruthy();

      const renewed = await backend.renewLock('schedule-1', token!, 120);
      expect(renewed).toBe(true);
    });

    it('should fail to renew with wrong token', async () => {
      await backend.tryAcquireLock('schedule-1', 'node-a', 60);

      const renewed = await backend.renewLock('schedule-1', 'wrong-token', 120);
      expect(renewed).toBe(false);
    });

    it('should release only matching token', async () => {
      const token = await backend.tryAcquireLock('schedule-1', 'node-a', 60);

      // Release with wrong token — no-op
      await backend.releaseLock('schedule-1', 'wrong-token');

      // Another node still can't acquire
      const token2 = await backend.tryAcquireLock('schedule-1', 'node-b', 60);
      expect(token2).toBeNull();

      // Release with correct token
      await backend.releaseLock('schedule-1', token!);

      // Now another node can acquire
      const token3 = await backend.tryAcquireLock('schedule-1', 'node-b', 60);
      expect(token3).toBeTruthy();
    });
  });

  describe('shutdown', () => {
    it('should close the database', async () => {
      await backend.shutdown();
      // After shutdown, operations should throw
      await expect(backend.getAll()).rejects.toThrow();
    });
  });
});
