import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { SqliteTaskStore } from '../../../src/agent-protocol/task-store';
import type { AgentMessage } from '../../../src/agent-protocol/types';

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

  beforeEach(async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-agent-tasks');
    fs.mkdirSync(tmpDir, { recursive: true });
    dbPath = path.join(tmpDir, `test-cli-${crypto.randomUUID()}.db`);
    store = new SqliteTaskStore(dbPath);
    await store.initialize();
  });

  afterEach(async () => {
    await store.shutdown();
    try {
      fs.unlinkSync(dbPath);
      fs.unlinkSync(dbPath + '-wal');
      fs.unlinkSync(dbPath + '-shm');
    } catch {}
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
  });
});
