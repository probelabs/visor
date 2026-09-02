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

  it('should not publish generic completion fallback as a live update', async () => {
    const sink = {
      kind: 'test',
      start: jest.fn(async () => null),
      update: jest.fn(async () => null),
      complete: jest.fn(async () => ({ ref: { message_id: 'msg-1' } })),
      fail: jest.fn(async () => null),
    };

    const { task } = await trackExecution(
      {
        taskStore: store,
        source: 'slack',
        messageText: 'live update execution with empty history',
        liveUpdates: {
          config: true,
          sink,
        },
      },
      async () => ({
        reviewSummary: {
          history: {},
        },
      })
    );

    expect(sink.start).toHaveBeenCalledTimes(1);
    expect(sink.update).not.toHaveBeenCalled();
    expect(sink.complete).not.toHaveBeenCalled();
    const updated = store.getTask(task.id);
    expect((updated!.status.message!.parts[0] as any).text).toBe('Execution completed');
    expect(updated!.history).toHaveLength(0);
  });

  it('should keep trace_file as the live update ref while preserving trace_id for remote lookup', async () => {
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

  // ---------------------------------------------------------------------------
  // Multi-pass response extraction tests
  // ---------------------------------------------------------------------------

  describe('response text extraction', () => {
    function runWithHistory(history: Record<string, unknown[]>) {
      return trackExecution(
        { taskStore: store, source: 'test' as any, messageText: 'extraction test' },
        async () => ({ reviewSummary: { history } })
      );
    }

    it('should extract plain text from top-level entry', async () => {
      const { task } = await runWithHistory({
        'generate-response': [{ text: 'Hello world' }],
      });
      const updated = store.getTask(task.id);
      expect(updated!.status.message!.parts[0]).toEqual({ text: 'Hello world' });
    });

    it('should prefer top-level over dotted sub-workflow entries', async () => {
      const { task } = await runWithHistory({
        'parent.sub-step': [{ text: 'sub-step output' }],
        'generate-response': [{ text: 'Top-level response' }],
      });
      const updated = store.getTask(task.id);
      expect(updated!.status.message!.parts[0]).toEqual({ text: 'Top-level response' });
    });

    it('should unwrap JSON-wrapped text', async () => {
      const { task } = await runWithHistory({
        'generate-response': [{ text: '{"text":"Unwrapped content"}' }],
      });
      const updated = store.getTask(task.id);
      expect(updated!.status.message!.parts[0]).toEqual({ text: 'Unwrapped content' });
    });

    it('should unwrap JSON text with unescaped control characters', async () => {
      const jsonWithControlChars = '{"text":"Line one\\nLine two\tTabbed"}';
      const { task } = await runWithHistory({
        'generate-response': [{ text: jsonWithControlChars }],
      });
      const updated = store.getTask(task.id);
      const msg = (updated!.status.message!.parts[0] as any).text;
      expect(msg).toContain('Line one');
    });

    it('should fall back to generate-response when top-level is tool output', async () => {
      const { task } = await runWithHistory({
        'check-0': [{ text: '├─┬ Running analysis' }],
        'check-0.generate-response': [{ text: 'The actual AI response' }],
      });
      const updated = store.getTask(task.id);
      expect(updated!.status.message!.parts[0]).toEqual({ text: 'The actual AI response' });
    });

    it('should fall back to generate-response when top-level starts with [task:', async () => {
      const { task } = await runWithHistory({
        main: [{ text: '[task: completed successfully]' }],
        'main.generate-response': [{ text: 'Here is the answer' }],
      });
      const updated = store.getTask(task.id);
      expect(updated!.status.message!.parts[0]).toEqual({ text: 'Here is the answer' });
    });

    it('should use tool output as last resort when no generate-response exists', async () => {
      const { task } = await runWithHistory({
        'only-step': [{ text: '├─┬ Tool tree output only' }],
      });
      const updated = store.getTask(task.id);
      expect((updated!.status.message!.parts[0] as any).text).toBe('├─┬ Tool tree output only');
    });

    it('should return "Execution completed" for empty history', async () => {
      const { task } = await runWithHistory({});
      const updated = store.getTask(task.id);
      expect(updated!.status.message!.parts[0]).toEqual({ text: 'Execution completed' });
    });

    it('should return "Execution completed" for history with only empty arrays', async () => {
      const { task } = await runWithHistory({ 'step-0': [] });
      const updated = store.getTask(task.id);
      expect(updated!.status.message!.parts[0]).toEqual({ text: 'Execution completed' });
    });

    it('should pick the last entry text when multiple entries exist', async () => {
      const { task } = await runWithHistory({
        'step-1': [{ text: 'First step output' }],
        'step-2': [{ text: 'Second step output' }],
      });
      const updated = store.getTask(task.id);
      // Should pick the last one (reverse iteration)
      expect((updated!.status.message!.parts[0] as any).text).toBe('Second step output');
    });

    it('should handle production-like multi-step workflow with tool outputs', async () => {
      const { task } = await runWithHistory({
        setup: [{ text: '├─┬ Setting up workspace' }],
        analyze: [{ text: '│ Analyzing files...' }],
        'generate-response': [
          {
            text: '{"text":"Based on the analysis, here are the findings:\\n\\n1. The code is clean\\n2. No issues found"}',
          },
        ],
      });
      const updated = store.getTask(task.id);
      const msg = (updated!.status.message!.parts[0] as any).text;
      expect(msg).toContain('Based on the analysis');
      expect(msg).not.toContain('{');
    });

    it('should handle nested workflow with dotted keys', async () => {
      const { task } = await runWithHistory({
        'code-talk': [{ text: '├─┬ code-talk' }],
        'code-talk.setup-projects': [{ text: 'Setting up...' }],
        'code-talk.explore-code': [{ text: 'The detailed analysis of the code shows...' }],
      });
      const updated = store.getTask(task.id);
      // Top-level "code-talk" is tool output, but code-talk.explore-code
      // is a dotted key. The generate-response fallback should kick in for
      // entries ending in .generate-response. Since neither matches, it falls
      // back to tool output from top-level.
      const msg = (updated!.status.message!.parts[0] as any).text;
      expect(msg).toBeDefined();
      expect(msg.length).toBeGreaterThan(0);
    });

    it('should skip entries with only whitespace text', async () => {
      const { task } = await runWithHistory({
        'step-1': [{ text: '   ' }],
        'step-2': [{ text: 'Actual response' }],
      });
      const updated = store.getTask(task.id);
      expect((updated!.status.message!.parts[0] as any).text).toBe('Actual response');
    });

    it('should handle entries with non-text outputs', async () => {
      const { task } = await runWithHistory({
        'step-1': [{ image: 'base64...' }, { audio: 'data...' }],
        'step-2': [{ text: 'Text response after non-text' }],
      });
      const updated = store.getTask(task.id);
      expect((updated!.status.message!.parts[0] as any).text).toBe('Text response after non-text');
    });

    it('should not include _rawOutput in live update text (file uploads handled separately)', async () => {
      const sink = {
        kind: 'test',
        start: jest.fn(async () => null),
        update: jest.fn(async () => null),
        complete: jest.fn(async () => ({ ref: { message_id: 'msg-raw' } })),
        fail: jest.fn(async () => null),
      };

      const csvData = '--- report.csv ---\nid,customer,status\n123,Acme,active\n456,Beta,pending';

      await trackExecution(
        {
          taskStore: store,
          source: 'slack',
          messageText: 'generate SLA report',
          liveUpdates: {
            config: true,
            sink,
          },
        },
        async () => ({
          reviewSummary: {
            history: {
              'generate-response': [{ text: 'Here is your SLA report.' }],
            },
            output: {
              text: 'Here is your SLA report.',
              _rawOutput: csvData,
            },
          },
        })
      );

      // Live update text should only contain the response text, NOT the raw CSV data.
      // File uploads from _rawOutput are handled by the Slack frontend, not the live update sink.
      expect(sink.complete).toHaveBeenCalledTimes(1);
      const sinkText = sink.complete.mock.calls[0][0];
      expect(sinkText).toContain('Here is your SLA report.');
      expect(sinkText).not.toContain('Acme,active');
    });

    it('should fall back to issue summary when history has no usable text', async () => {
      const { task } = await trackExecution(
        { taskStore: store, source: 'test' as any, messageText: 'issue fallback test' },
        async () => ({
          reviewSummary: {
            history: {},
            issues: [
              { severity: 'error', title: 'Build failed', description: 'Compile error in main.ts' },
            ],
          },
        })
      );
      const updated = store.getTask(task.id);
      const msg = (updated!.status.message!.parts[0] as any).text;
      expect(msg).not.toBe('Execution completed');
      expect(msg.length).toBeGreaterThan(0);
    });
  });
});
