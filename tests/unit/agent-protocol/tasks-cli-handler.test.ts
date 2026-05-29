import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { SqliteTaskStore } from '../../../src/agent-protocol/task-store';
import type { AgentMessage } from '../../../src/agent-protocol/types';
import { handleTasksCommand } from '../../../src/agent-protocol/tasks-cli-handler';
import { buildTraceReport } from '../../../src/agent-protocol/trace-serializer';

jest.mock('../../../src/agent-protocol/trace-serializer', () => ({
  buildTraceReport: jest.fn().mockResolvedValue({
    traceData: {
      spans: [],
      source: 'file',
      remoteTraceId: 'trace-correct-123',
      localTracePath: '/tmp/mixed-process-traces.ndjson',
    },
    taskSummary: null,
    headerText: 'Trace source: file\nTasks: no task telemetry found in this trace',
    tree: 'mock-trace-tree',
    text: 'Trace source: file\nTasks: no task telemetry found in this trace\n\nmock-trace-tree',
  }),
  fetchTraceSpans: jest.fn().mockResolvedValue([]),
  readTraceIdFromFile: jest.fn().mockResolvedValue(undefined),
}));

function makeMessage(text = 'Hello agent'): AgentMessage {
  return {
    message_id: crypto.randomUUID(),
    role: 'user',
    parts: [{ text, media_type: 'text/plain' }],
  };
}

describe('tasks CLI handler', () => {
  let store: SqliteTaskStore;
  let dbPath: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-agent-tasks');
    fs.mkdirSync(tmpDir, { recursive: true });
    const testDir = path.join(tmpDir, `case-${crypto.randomUUID()}`);
    fs.mkdirSync(path.join(testDir, '.visor'), { recursive: true });
    process.chdir(testDir);
    dbPath = path.join(testDir, '.visor', 'agent-tasks.db');
    store = new SqliteTaskStore(dbPath);
    await store.initialize();
    jest.clearAllMocks();
  });

  afterEach(async () => {
    await store.shutdown();
    try {
      fs.unlinkSync(dbPath);
      fs.unlinkSync(dbPath + '-wal');
      fs.unlinkSync(dbPath + '-shm');
    } catch {}
    process.chdir(originalCwd);
  });

  // -------------------------------------------------------------------------
  // listTasksRaw
  // -------------------------------------------------------------------------

  describe('listTasksRaw', () => {
    it('returns empty rows for empty DB', () => {
      const result = store.listTasksRaw({});
      expect(result.rows).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it('returns claimed_by and claimed_at fields', () => {
      const task = store.createTask({
        contextId: 'ctx-1',
        requestMessage: makeMessage('Review this PR'),
      });

      // Claim the task
      const claimed = store.claimNextSubmitted('worker-abc-123');
      expect(claimed).not.toBeNull();

      const { rows } = store.listTasksRaw({});
      expect(rows).toHaveLength(1);
      expect(rows[0].claimed_by).toBe('worker-abc-123');
      expect(rows[0].claimed_at).toBeTruthy();
      expect(rows[0].state).toBe('working');
      expect(rows[0].id).toBe(task.id);
    });

    it('extracts request message text from parts', () => {
      store.createTask({
        contextId: 'ctx-1',
        requestMessage: makeMessage('Analyze security vulnerabilities'),
      });

      const { rows } = store.listTasksRaw({});
      expect(rows[0].request_message).toBe('Analyze security vulnerabilities');
    });

    it('filters by state', () => {
      store.createTask({ contextId: 'ctx-1', requestMessage: makeMessage('Task 1') });
      store.createTask({ contextId: 'ctx-2', requestMessage: makeMessage('Task 2') });
      store.claimNextSubmitted('w1'); // moves one to working

      const { rows: working } = store.listTasksRaw({ state: ['working'] });
      expect(working).toHaveLength(1);
      expect(working[0].state).toBe('working');

      const { rows: submitted } = store.listTasksRaw({ state: ['submitted'] });
      expect(submitted).toHaveLength(1);
      expect(submitted[0].state).toBe('submitted');
    });

    it('filters by workflowId', () => {
      store.createTask({
        contextId: 'ctx-1',
        requestMessage: makeMessage('Security task'),
        workflowId: 'security-review',
      });
      store.createTask({
        contextId: 'ctx-2',
        requestMessage: makeMessage('Perf task'),
        workflowId: 'performance-review',
      });
      store.createTask({
        contextId: 'ctx-3',
        requestMessage: makeMessage('No workflow'),
      });

      const { rows, total } = store.listTasksRaw({ workflowId: 'security-review' });
      expect(rows).toHaveLength(1);
      expect(total).toBe(1);
      expect(rows[0].workflow_id).toBe('security-review');
    });

    it('respects limit', () => {
      for (let i = 0; i < 5; i++) {
        store.createTask({ contextId: `ctx-${i}`, requestMessage: makeMessage(`Task ${i}`) });
      }

      const { rows, total } = store.listTasksRaw({ limit: 2 });
      expect(rows).toHaveLength(2);
      expect(total).toBe(5);
    });
  });

  // -------------------------------------------------------------------------
  // listTasks with workflowId filter
  // -------------------------------------------------------------------------

  describe('listTasks with workflowId', () => {
    it('filters by workflowId', () => {
      store.createTask({
        contextId: 'ctx-1',
        requestMessage: makeMessage(),
        workflowId: 'agent-a',
      });
      store.createTask({
        contextId: 'ctx-2',
        requestMessage: makeMessage(),
        workflowId: 'agent-b',
      });

      const { tasks, total } = store.listTasks({ workflowId: 'agent-a' });
      expect(tasks).toHaveLength(1);
      expect(total).toBe(1);
      expect(tasks[0].workflow_id).toBe('agent-a');
    });
  });

  // -------------------------------------------------------------------------
  // handleTasksCommand integration
  // -------------------------------------------------------------------------

  describe('handleTasksCommand', () => {
    let originalLog: typeof console.log;
    let originalError: typeof console.error;
    let logOutput: string[];
    let errorOutput: string[];

    beforeEach(() => {
      logOutput = [];
      errorOutput = [];
      originalLog = console.log;
      originalError = console.error;
      console.log = (...args: unknown[]) => logOutput.push(args.map(String).join(' '));
      console.error = (...args: unknown[]) => errorOutput.push(args.map(String).join(' '));
    });

    afterEach(() => {
      console.log = originalLog;
      console.error = originalError;
    });

    // We can't easily test handleTasksCommand directly because it creates its
    // own SqliteTaskStore with default path. Instead we test the format helpers
    // and the store methods which are the core logic.

    it('cancel transitions submitted task to canceled', () => {
      const task = store.createTask({
        contextId: 'ctx-1',
        requestMessage: makeMessage('Cancel me'),
      });

      store.updateTaskState(task.id, 'canceled');
      const updated = store.getTask(task.id);
      expect(updated?.status.state).toBe('canceled');
    });

    it('cancel transitions working task to canceled', () => {
      store.createTask({
        contextId: 'ctx-1',
        requestMessage: makeMessage('Cancel me'),
      });
      const claimed = store.claimNextSubmitted('w1');
      expect(claimed).not.toBeNull();

      store.updateTaskState(claimed!.id, 'canceled');
      const updated = store.getTask(claimed!.id);
      expect(updated?.status.state).toBe('canceled');
    });

    it('cancel rejects terminal state tasks', () => {
      const task = store.createTask({
        contextId: 'ctx-1',
        requestMessage: makeMessage('Done'),
      });
      store.claimNextSubmitted('w1');
      store.updateTaskState(task.id, 'completed');

      expect(() => store.updateTaskState(task.id, 'canceled')).toThrow();
    });

    it('tasks trace keeps trace_file for local fallback while preferring trace_id remotely', async () => {
      const task = store.createTask({
        contextId: 'ctx-1',
        requestMessage: makeMessage('Trace me'),
        requestMetadata: {
          trace_id: 'trace-correct-123',
          trace_file: '/tmp/mixed-process-traces.ndjson',
        },
      });

      await handleTasksCommand(['trace', task.id.slice(0, 8)]);

      expect(buildTraceReport).toHaveBeenCalledWith(
        '/tmp/mixed-process-traces.ndjson',
        8000,
        undefined,
        undefined,
        'trace-correct-123'
      );
      expect(errorOutput).toEqual([]);
      expect(logOutput.some(line => line.includes('Trace source: file'))).toBe(true);
      expect(
        logOutput.some(line => line.includes('Tasks: no task telemetry found in this trace'))
      ).toBe(true);
      expect(logOutput).toContain('mock-trace-tree');
    });

    it('tasks trace prints a probe task summary when task telemetry exists', async () => {
      const task = store.createTask({
        contextId: 'ctx-1',
        requestMessage: makeMessage('Trace me'),
        requestMetadata: {
          trace_id: 'trace-correct-123',
          trace_file: '/tmp/mixed-process-traces.ndjson',
        },
      });

      (buildTraceReport as jest.Mock).mockResolvedValue({
        traceData: {
          spans: [],
          source: 'file',
          remoteTraceId: 'trace-correct-123',
          localTracePath: '/tmp/mixed-process-traces.ndjson',
        },
        taskSummary: {
          tasksEnabled: true,
          source: 'snapshot',
          eventCount: 5,
          snapshotCount: 2,
          tasks: [
            { id: 'live-updates', title: 'Inspect live update flow', status: 'in_progress' },
            { id: 'trace-spans', title: 'Inspect trace rendering', status: 'completed' },
          ],
          scopes: [
            {
              label: 'Main Agent',
              source: 'snapshot',
              eventCount: 3,
              snapshotCount: 1,
              tasks: [
                { id: 'live-updates', title: 'Inspect live update flow', status: 'in_progress' },
              ],
              children: [
                {
                  label: 'Code Explorer',
                  source: 'snapshot',
                  eventCount: 2,
                  snapshotCount: 1,
                  tasks: [
                    {
                      id: 'trace-spans',
                      title: 'Inspect trace rendering',
                      status: 'completed',
                    },
                  ],
                  children: [],
                },
              ],
            },
          ],
        },
        headerText:
          'Trace source: file\nTasks: 2 tracked (snapshot, 5 task events, 2 snapshots)\n  [~] Inspect live update flow\n  Code Explorer\n    [x] Inspect trace rendering',
        tree: 'mock-trace-tree',
        text: 'Trace source: file\nTasks: 2 tracked (snapshot, 5 task events, 2 snapshots)\n  [~] Inspect live update flow\n  Code Explorer\n    [x] Inspect trace rendering\n\nmock-trace-tree',
      });

      await handleTasksCommand(['trace', task.id.slice(0, 8)]);

      expect(logOutput.some(line => line.includes('Trace source: file'))).toBe(true);
      expect(
        logOutput.some(line =>
          line.includes('Tasks: 2 tracked (snapshot, 5 task events, 2 snapshots)')
        )
      ).toBe(true);
      expect(logOutput.some(line => line.includes('  [~] Inspect live update flow'))).toBe(true);
      expect(logOutput.some(line => line.includes('  Code Explorer'))).toBe(true);
      expect(logOutput.some(line => line.includes('    [x] Inspect trace rendering'))).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // Default active filter & search
  // -------------------------------------------------------------------------

  describe('buildFilter default behavior', () => {
    it('should show only active tasks by default (no --all flag)', () => {
      // Create tasks in various states
      const t1 = store.createTask({
        contextId: 'ctx-1',
        requestMessage: makeMessage('active task'),
      });
      const t2 = store.createTask({
        contextId: 'ctx-2',
        requestMessage: makeMessage('completed task'),
      });
      store.createTask({ contextId: 'ctx-3', requestMessage: makeMessage('submitted task') });

      store.updateTaskState(t1.id, 'working');
      store.updateTaskState(t2.id, 'working');
      store.updateTaskState(t2.id, 'completed');

      // Active filter: submitted + working
      const activeResult = store.listTasksRaw({
        state: ['submitted', 'working', 'input_required', 'auth_required'],
      });
      expect(activeResult.total).toBe(2); // t1 (working) + t3 (submitted)

      // All tasks
      const allResult = store.listTasksRaw({});
      expect(allResult.total).toBe(3);
    });
  });

  describe('search filter in listTasksRaw', () => {
    it('should filter tasks by search text', () => {
      store.createTask({
        contextId: 'ctx-1',
        requestMessage: makeMessage('How does authentication work?'),
      });
      store.createTask({
        contextId: 'ctx-2',
        requestMessage: makeMessage('Deploy to production'),
      });

      const result = store.listTasksRaw({ search: 'authentication' });
      expect(result.total).toBe(1);
      expect(result.rows[0].request_message).toContain('authentication');
    });

    it('should return empty for no matches', () => {
      store.createTask({
        contextId: 'ctx-1',
        requestMessage: makeMessage('Hello world'),
      });

      const result = store.listTasksRaw({ search: 'nonexistent' });
      expect(result.total).toBe(0);
    });
  });

  describe('instance filter in listTasksRaw', () => {
    it('should filter by claimed_by (instance)', () => {
      const t1 = store.createTask({ contextId: 'ctx-1', requestMessage: makeMessage('task 1') });
      store.createTask({ contextId: 'ctx-2', requestMessage: makeMessage('task 2') });

      store.claimNextSubmitted('instance-a');
      store.claimNextSubmitted('instance-b');

      const result = store.listTasksRaw({ claimedBy: 'instance-a' });
      expect(result.total).toBe(1);
      expect(result.rows[0].id).toBe(t1.id);
    });
  });

  describe('purge', () => {
    it('should delete old terminal tasks', () => {
      const t1 = store.createTask({ contextId: 'ctx-1', requestMessage: makeMessage('old task') });
      store.updateTaskState(t1.id, 'working');
      store.updateTaskState(t1.id, 'completed');

      const t2 = store.createTask({
        contextId: 'ctx-2',
        requestMessage: makeMessage('active task'),
      });

      // Purge with 0ms = delete all terminal
      const count = store.purgeOldTasks(0);
      expect(count).toBe(1);
      expect(store.getTask(t1.id)).toBeNull();
      expect(store.getTask(t2.id)).not.toBeNull();
    });
  });
});
