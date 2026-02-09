/**
 * Shared contract tests for ScheduleStoreBackend implementations
 *
 * Usage: import and call runBackendContractTests(backendFactory) from any
 * backend-specific test file.
 */
import type { ScheduleStoreBackend } from '../../../../src/scheduler/store/types';
import type { Schedule } from '../../../../src/scheduler/schedule-store';

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

/**
 * Run the full set of contract tests against any backend implementation
 */
export function runBackendContractTests(
  createBackend: () => Promise<{ backend: ScheduleStoreBackend; cleanup: () => Promise<void> }>
) {
  let backend: ScheduleStoreBackend;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const result = await createBackend();
    backend = result.backend;
    cleanup = result.cleanup;
    await backend.initialize();
  });

  afterEach(async () => {
    await backend.shutdown();
    await cleanup();
  });

  it('[contract] create → get round-trip', async () => {
    const created = await backend.create(scheduleInput());
    const retrieved = await backend.get(created.id);
    expect(retrieved).toBeDefined();
    expect(retrieved!.id).toBe(created.id);
    expect(retrieved!.workflow).toBe('test-workflow');
    expect(retrieved!.status).toBe('active');
    expect(retrieved!.runCount).toBe(0);
  });

  it('[contract] update changes fields', async () => {
    const created = await backend.create(scheduleInput());
    const updated = await backend.update(created.id, { status: 'paused', runCount: 5 });
    expect(updated!.status).toBe('paused');
    expect(updated!.runCount).toBe(5);
  });

  it('[contract] delete removes schedule', async () => {
    const created = await backend.create(scheduleInput());
    const deleted = await backend.delete(created.id);
    expect(deleted).toBe(true);
    expect(await backend.get(created.id)).toBeUndefined();
  });

  it('[contract] getActiveSchedules filters by status', async () => {
    await backend.create(scheduleInput({ workflow: 'active' }));
    const s2 = await backend.create(scheduleInput({ workflow: 'paused' }));
    await backend.update(s2.id, { status: 'paused' });

    const active = await backend.getActiveSchedules();
    expect(active).toHaveLength(1);
    expect(active[0].workflow).toBe('active');
  });

  it('[contract] getDueSchedules returns due schedules', async () => {
    await backend.create(scheduleInput({ workflow: 'due', runAt: Date.now() - 60000 }));
    await backend.create(scheduleInput({ workflow: 'not-due', runAt: Date.now() + 3600000 }));

    const due = await backend.getDueSchedules();
    expect(due).toHaveLength(1);
    expect(due[0].workflow).toBe('due');
  });

  it('[contract] getStats returns aggregate counts', async () => {
    await backend.create(scheduleInput({ isRecurring: true, schedule: '0 9 * * *' }));
    await backend.create(scheduleInput({ isRecurring: false }));

    const stats = await backend.getStats();
    expect(stats.total).toBe(2);
    expect(stats.recurring).toBe(1);
    expect(stats.oneTime).toBe(1);
    expect(stats.active).toBe(2);
  });

  it('[contract] JSON fields survive round-trip', async () => {
    const created = await backend.create(
      scheduleInput({
        workflowInputs: { key: 'value', arr: [1, 2] },
        outputContext: { type: 'slack', target: '#ch' },
      })
    );

    const retrieved = await backend.get(created.id);
    expect(retrieved!.workflowInputs).toEqual({ key: 'value', arr: [1, 2] });
    expect(retrieved!.outputContext).toEqual({ type: 'slack', target: '#ch' });
  });

  it('[contract] lock acquire / release cycle', async () => {
    const token = await backend.tryAcquireLock('test-id', 'node-a', 60);
    expect(token).toBeTruthy();

    await backend.releaseLock('test-id', token!);

    const token2 = await backend.tryAcquireLock('test-id', 'node-b', 60);
    expect(token2).toBeTruthy();
  });
}
