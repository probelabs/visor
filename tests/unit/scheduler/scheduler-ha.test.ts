/**
 * Unit tests for scheduler HA (high-availability) locking
 * Tests distributed lock acquisition, release, heartbeat, and conflict resolution
 */
import type { ScheduleStoreBackend, ScheduleStoreStats } from '../../../src/scheduler/store/types';
import type { Schedule } from '../../../src/scheduler/schedule-store';

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
 * In-memory mock backend for HA testing
 * This simulates 2 competing nodes using a shared lock map
 */
class MockBackend implements ScheduleStoreBackend {
  schedules = new Map<string, Schedule>();
  locks = new Map<string, { nodeId: string; token: string; expiresAt: number }>();

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

  async tryAcquireLock(scheduleId: string, nodeId: string, ttlSeconds: number) {
    const now = Date.now();
    const existing = this.locks.get(scheduleId);

    if (existing && existing.expiresAt > now) {
      if (existing.nodeId === nodeId) return existing.token;
      return null;
    }

    const token = `tok-${Math.random().toString(36).substring(7)}`;
    this.locks.set(scheduleId, { nodeId, token, expiresAt: now + ttlSeconds * 1000 });
    return token;
  }

  async releaseLock(scheduleId: string, lockToken: string) {
    const existing = this.locks.get(scheduleId);
    if (existing && existing.token === lockToken) {
      this.locks.delete(scheduleId);
    }
  }

  async renewLock(scheduleId: string, lockToken: string, ttlSeconds: number) {
    const existing = this.locks.get(scheduleId);
    if (!existing || existing.token !== lockToken) return false;
    existing.expiresAt = Date.now() + ttlSeconds * 1000;
    return true;
  }
}

describe('Scheduler HA Locking', () => {
  let backend: MockBackend;

  beforeEach(() => {
    backend = new MockBackend();
  });

  it('should acquire lock for a schedule', async () => {
    const token = await backend.tryAcquireLock('sched-1', 'node-a', 60);
    expect(token).toBeTruthy();
  });

  it('should prevent duplicate execution by another node', async () => {
    const tokenA = await backend.tryAcquireLock('sched-1', 'node-a', 60);
    expect(tokenA).toBeTruthy();

    const tokenB = await backend.tryAcquireLock('sched-1', 'node-b', 60);
    expect(tokenB).toBeNull(); // node-b blocked
  });

  it('should allow lock acquisition after release', async () => {
    const tokenA = await backend.tryAcquireLock('sched-1', 'node-a', 60);
    expect(tokenA).toBeTruthy();

    await backend.releaseLock('sched-1', tokenA!);

    const tokenB = await backend.tryAcquireLock('sched-1', 'node-b', 60);
    expect(tokenB).toBeTruthy();
  });

  it('should allow lock acquisition after TTL expiration', async () => {
    // Acquire lock with very short TTL
    const tokenA = await backend.tryAcquireLock('sched-1', 'node-a', 0);
    expect(tokenA).toBeTruthy();

    // Wait a tiny bit for expiration
    await new Promise(resolve => setTimeout(resolve, 10));

    // node-b can now acquire
    const tokenB = await backend.tryAcquireLock('sched-1', 'node-b', 60);
    expect(tokenB).toBeTruthy();
  });

  it('should renew lock successfully', async () => {
    const token = await backend.tryAcquireLock('sched-1', 'node-a', 60);
    expect(token).toBeTruthy();

    const renewed = await backend.renewLock('sched-1', token!, 120);
    expect(renewed).toBe(true);
  });

  it('should fail to renew with wrong token', async () => {
    await backend.tryAcquireLock('sched-1', 'node-a', 60);

    const renewed = await backend.renewLock('sched-1', 'wrong-token', 120);
    expect(renewed).toBe(false);
  });

  it('two nodes competing for same schedule — only one executes', async () => {
    const executionLog: string[] = [];

    // Simulate two nodes trying to execute the same schedule
    const executeAsNode = async (nodeId: string) => {
      const token = await backend.tryAcquireLock('sched-1', nodeId, 60);
      if (!token) return;

      try {
        executionLog.push(nodeId);
      } finally {
        await backend.releaseLock('sched-1', token);
      }
    };

    // Both try concurrently
    await Promise.all([executeAsNode('node-a'), executeAsNode('node-b')]);

    // Only one should have executed
    expect(executionLog).toHaveLength(1);
  });

  it('should handle multiple independent locks', async () => {
    const token1 = await backend.tryAcquireLock('sched-1', 'node-a', 60);
    const token2 = await backend.tryAcquireLock('sched-2', 'node-b', 60);

    expect(token1).toBeTruthy();
    expect(token2).toBeTruthy();

    // Each node has its own lock
    const token3 = await backend.tryAcquireLock('sched-1', 'node-b', 60);
    expect(token3).toBeNull(); // node-b blocked on sched-1
    const token4 = await backend.tryAcquireLock('sched-2', 'node-a', 60);
    expect(token4).toBeNull(); // node-a blocked on sched-2
  });
});
