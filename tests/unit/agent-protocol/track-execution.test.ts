import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { SqliteTaskStore } from '../../../src/agent-protocol/task-store';
import { trackExecution } from '../../../src/agent-protocol/track-execution';
import { trace } from '../../../src/telemetry/lazy-otel';

describe('trackExecution', () => {
  let store: SqliteTaskStore;
  let dbPath: string;

  beforeEach(async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-agent-tasks');
    fs.mkdirSync(tmpDir, { recursive: true });
    dbPath = path.join(tmpDir, `test-track-${crypto.randomUUID()}.db`);
    store = new SqliteTaskStore(dbPath);
    await store.initialize();
  });

  afterEach(async () => {
    await store.shutdown();
    try {
      fs.unlinkSync(dbPath);
      fs.unlinkSync(dbPath + '-wal');
      fs.unlinkSync(dbPath + '-shm');
    } catch {
      // ignore
    }
  });

  it('should create task and mark as completed on success', async () => {
    const { task, result } = await trackExecution(
      {
        taskStore: store,
        source: 'cli',
        messageText: 'test execution',
      },
      async () => ({ value: 42 })
    );

    expect(result).toEqual({ value: 42 });
    const updated = store.getTask(task.id);
    expect(updated!.status.state).toBe('completed');
  });

  it('should mark task as failed and re-throw on executor error', async () => {
    let taskId: string | undefined;

    await expect(
      trackExecution(
        {
          taskStore: store,
          source: 'cli',
          messageText: 'failing execution',
        },
        async () => {
          // Capture the task ID from the store before throwing
          const { tasks } = store.listTasks({ state: ['working'] });
          taskId = tasks[0]?.id;
          throw new Error('executor failed');
        }
      )
    ).rejects.toThrow('executor failed');

    expect(taskId).toBeDefined();
    const updated = store.getTask(taskId!);
    expect(updated!.status.state).toBe('failed');
  });

  it('should not throw when task was externally failed before completion', async () => {
    // Simulates the production bug: another process marks the task as failed
    // (e.g. failStaleTasks from a restarting instance) while the executor is running.
    // trackExecution should NOT throw — the execution itself succeeded.

    const { task, result } = await trackExecution(
      {
        taskStore: store,
        source: 'slack',
        messageText: 'long running execution',
      },
      async () => {
        // Simulate another instance marking this task as failed mid-execution.
        // Find the working task and externally fail it.
        const { tasks } = store.listTasks({ state: ['working'] });
        const workingTask = tasks[0];
        if (workingTask) {
          store.updateTaskState(workingTask.id, 'failed', {
            message_id: crypto.randomUUID(),
            role: 'agent',
            parts: [{ text: 'Process terminated unexpectedly' }],
          });
        }
        return { reviewSummary: { history: {} } };
      }
    );

    // Execution should succeed — no throw
    expect(result).toBeDefined();

    // Task ends up in 'failed' state (from the external update),
    // but trackExecution did not crash
    const updated = store.getTask(task.id);
    expect(updated!.status.state).toBe('failed');
  });

  it('should schedule evaluation when autoEvaluate is true', async () => {
    // Mock the dynamic import of task-evaluator
    const mockEvaluateAndStore = jest.fn().mockResolvedValue({});
    jest.mock('../../../src/agent-protocol/task-evaluator', () => ({
      evaluateAndStore: mockEvaluateAndStore,
    }));

    const { task } = await trackExecution(
      {
        taskStore: store,
        source: 'cli',
        messageText: 'auto-eval test',
        autoEvaluate: true,
      },
      async () => ({ value: 1 })
    );

    const updated = store.getTask(task.id);
    expect(updated!.status.state).toBe('completed');
    // The evaluation is scheduled via setTimeout(5s), so we just verify
    // the task completed without error — the fire-and-forget doesn't block
  });

  it('should schedule evaluation when VISOR_TASK_EVALUATE env is set', async () => {
    process.env.VISOR_TASK_EVALUATE = 'true';
    try {
      const { task } = await trackExecution(
        {
          taskStore: store,
          source: 'cli',
          messageText: 'env auto-eval test',
        },
        async () => ({ value: 2 })
      );

      const updated = store.getTask(task.id);
      expect(updated!.status.state).toBe('completed');
    } finally {
      delete process.env.VISOR_TASK_EVALUATE;
    }
  });

  it('should preserve executor result even when state transition fails', async () => {
    // The executor returns a result with reviewSummary.history containing AI text
    const { result } = await trackExecution(
      {
        taskStore: store,
        source: 'slack',
        messageText: 'execution with external failure',
      },
      async () => {
        // Externally fail the task during execution
        const { tasks } = store.listTasks({ state: ['working'] });
        if (tasks[0]) {
          store.updateTaskState(tasks[0].id, 'failed', {
            message_id: crypto.randomUUID(),
            role: 'agent',
            parts: [{ text: 'stale sweep' }],
          });
        }
        return { data: 'important result' };
      }
    );

    // The result should still be returned to the caller
    expect(result).toEqual({ data: 'important result' });
  });

  it('should publish live updates when a sink is configured', async () => {
    const sink = {
      kind: 'test',
      start: jest.fn(async () => null),
      update: jest.fn(async () => ({ ref: { message_id: 'msg-1' } })),
      complete: jest.fn(async () => ({ ref: { message_id: 'msg-1' } })),
      fail: jest.fn(async () => null),
    };

    const { task } = await trackExecution(
      {
        taskStore: store,
        source: 'slack',
        messageText: 'live update execution',
        liveUpdates: {
          config: true,
          sink,
        },
      },
      async () => ({
        reviewSummary: {
          history: {
            'generate-response': [{ text: 'Final response text' }],
          },
        },
      })
    );

    expect(sink.start).toHaveBeenCalledTimes(1);
    expect(sink.complete).toHaveBeenCalledWith('Final response text');
    const updated = store.getTask(task.id);
    expect(updated?.metadata?.message_id).toBe('msg-1');
  });

  it('should prefer trace_id over trace_file for live updates', async () => {
    const sink = {
      kind: 'test',
      start: jest.fn(async () => null),
      update: jest.fn(async () => null),
      complete: jest.fn(async () => null),
      fail: jest.fn(async () => null),
    };

    const originalTraceFile = process.env.VISOR_FALLBACK_TRACE_FILE;
    process.env.VISOR_FALLBACK_TRACE_FILE = '/tmp/test-trace.ndjson';

    const originalGetActiveSpan = (trace as any).getActiveSpan;
    (trace as any).getActiveSpan = jest.fn(() => ({
      spanContext: () => ({ traceId: 'trace-123', spanId: 'span-123' }),
    }));

    try {
      await trackExecution(
        {
          taskStore: store,
          source: 'slack',
          messageText: 'trace preference test',
          liveUpdates: {
            config: true,
            sink,
          },
        },
        async () => ({ value: 1 })
      );

      expect(sink.start).toHaveBeenCalledTimes(1);
      const { tasks } = store.listTasks({ state: ['completed'] });
      expect(tasks).toHaveLength(1);
      expect(tasks[0].metadata?.trace_id).toBe('trace-123');
      expect(tasks[0].metadata?.trace_file).toBe('/tmp/test-trace.ndjson');
    } finally {
      (trace as any).getActiveSpan = originalGetActiveSpan;
      if (originalTraceFile === undefined) delete process.env.VISOR_FALLBACK_TRACE_FILE;
      else process.env.VISOR_FALLBACK_TRACE_FILE = originalTraceFile;
    }
  });

  it('should not publish live updates when the feature is disabled', async () => {
    const sink = {
      kind: 'test',
      start: jest.fn(async () => null),
      update: jest.fn(async () => null),
      complete: jest.fn(async () => null),
      fail: jest.fn(async () => null),
    };

    await trackExecution(
      {
        taskStore: store,
        source: 'slack',
        messageText: 'live update disabled',
        liveUpdates: {
          config: { enabled: false },
          sink,
        },
      },
      async () => ({
        reviewSummary: {
          history: {
            'generate-response': [{ text: 'Final response text' }],
          },
        },
      })
    );

    expect(sink.start).not.toHaveBeenCalled();
    expect(sink.update).not.toHaveBeenCalled();
    expect(sink.complete).not.toHaveBeenCalled();
    expect(sink.fail).not.toHaveBeenCalled();
  });
});
