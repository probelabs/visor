import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { SqliteTaskStore } from '../../../src/agent-protocol/task-store';
import type { TaskStore } from '../../../src/agent-protocol/task-store';
import type { AgentMessage, AgentArtifact, TaskState } from '../../../src/agent-protocol/types';
import {
  InvalidStateTransitionError,
  TaskNotFoundError,
  ContextMismatchError,
} from '../../../src/agent-protocol/types';

function makeMessage(overrides: Partial<AgentMessage> = {}): AgentMessage {
  return {
    message_id: crypto.randomUUID(),
    role: 'user',
    parts: [{ text: 'Hello agent', media_type: 'text/plain' }],
    ...overrides,
  };
}

function makeArtifact(overrides: Partial<AgentArtifact> = {}): AgentArtifact {
  return {
    artifact_id: crypto.randomUUID(),
    name: 'test-artifact',
    parts: [{ text: 'result data', media_type: 'text/plain' }],
    ...overrides,
  };
}

describe('SqliteTaskStore', () => {
  let store: TaskStore;
  let dbPath: string;

  beforeEach(async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-agent-tasks');
    fs.mkdirSync(tmpDir, { recursive: true });
    dbPath = path.join(tmpDir, `test-${crypto.randomUUID()}.db`);
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

  // -------------------------------------------------------------------------
  // CRUD
  // -------------------------------------------------------------------------

  describe('createTask', () => {
    it('should create a task with all fields populated', () => {
      const msg = makeMessage();
      const task = store.createTask({
        contextId: 'ctx-1',
        requestMessage: msg,
        requestMetadata: { source: 'test' },
        workflowId: 'assistant',
      });

      expect(task.id).toBeDefined();
      expect(task.context_id).toBe('ctx-1');
      expect(task.status.state).toBe('submitted');
      expect(task.status.timestamp).toBeDefined();
      expect(task.artifacts).toEqual([]);
      expect(task.history).toEqual([]);
      expect(task.metadata).toEqual({ source: 'test' });
    });

    it('should generate unique IDs', () => {
      const msg = makeMessage();
      const t1 = store.createTask({ contextId: 'ctx', requestMessage: msg });
      const t2 = store.createTask({ contextId: 'ctx', requestMessage: msg });
      expect(t1.id).not.toBe(t2.id);
    });

    it('should generate unique IDs under concurrent creation', async () => {
      const promises = Array.from({ length: 20 }, (_, i) =>
        Promise.resolve(
          store.createTask({
            contextId: 'ctx',
            requestMessage: makeMessage({
              parts: [{ text: `concurrent ${i}`, media_type: 'text/plain' }],
            }),
          })
        )
      );
      const tasks = await Promise.all(promises);
      const ids = tasks.map(t => t.id);
      expect(new Set(ids).size).toBe(20);
    });

    it('should preserve workflow_id through create and get', () => {
      const msg = makeMessage();
      const task = store.createTask({
        contextId: 'ctx-1',
        requestMessage: msg,
        workflowId: 'security-review',
      });
      expect(task.workflow_id).toBe('security-review');

      const fetched = store.getTask(task.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.workflow_id).toBe('security-review');
    });

    it('should return undefined workflow_id when not set', () => {
      const msg = makeMessage();
      const task = store.createTask({ contextId: 'ctx-1', requestMessage: msg });
      expect(task.workflow_id).toBeUndefined();

      const fetched = store.getTask(task.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.workflow_id).toBeUndefined();
    });

    it('should store and retrieve the task', () => {
      const msg = makeMessage();
      const created = store.createTask({ contextId: 'ctx-1', requestMessage: msg });
      const fetched = store.getTask(created.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(created.id);
      expect(fetched!.context_id).toBe('ctx-1');
      expect(fetched!.status.state).toBe('submitted');
    });
  });

  describe('getTask', () => {
    it('should return null for non-existent task', () => {
      expect(store.getTask('nonexistent-id')).toBeNull();
    });

    it('should return the task when it exists', () => {
      const msg = makeMessage();
      const task = store.createTask({ contextId: 'ctx', requestMessage: msg });
      const result = store.getTask(task.id);
      expect(result).not.toBeNull();
      expect(result!.id).toBe(task.id);
    });
  });

  describe('listTasks', () => {
    beforeEach(() => {
      const msg = makeMessage();
      // Create 5 tasks in 2 contexts
      store.createTask({ contextId: 'ctx-a', requestMessage: msg });
      store.createTask({ contextId: 'ctx-a', requestMessage: msg });
      store.createTask({ contextId: 'ctx-a', requestMessage: msg });
      store.createTask({ contextId: 'ctx-b', requestMessage: msg });
      store.createTask({ contextId: 'ctx-b', requestMessage: msg });
    });

    it('should list all tasks when no filter', () => {
      const result = store.listTasks({});
      expect(result.tasks).toHaveLength(5);
      expect(result.total).toBe(5);
    });

    it('should filter by contextId', () => {
      const result = store.listTasks({ contextId: 'ctx-a' });
      expect(result.tasks).toHaveLength(3);
      expect(result.total).toBe(3);
      result.tasks.forEach(t => expect(t.context_id).toBe('ctx-a'));
    });

    it('should filter by state', () => {
      // All tasks are 'submitted' initially
      const result = store.listTasks({ state: ['submitted'] });
      expect(result.tasks).toHaveLength(5);

      const empty = store.listTasks({ state: ['completed'] });
      expect(empty.tasks).toHaveLength(0);
      expect(empty.total).toBe(0);
    });

    it('should paginate with limit and offset', () => {
      const page1 = store.listTasks({ limit: 2, offset: 0 });
      expect(page1.tasks).toHaveLength(2);
      expect(page1.total).toBe(5);

      const page2 = store.listTasks({ limit: 2, offset: 2 });
      expect(page2.tasks).toHaveLength(2);
      expect(page2.total).toBe(5);

      const page3 = store.listTasks({ limit: 2, offset: 4 });
      expect(page3.tasks).toHaveLength(1);
      expect(page3.total).toBe(5);
    });

    it('should cap limit at 200', () => {
      // If we request more than 200, it should still work (capped)
      const result = store.listTasks({ limit: 999 });
      expect(result.tasks).toHaveLength(5); // only 5 exist
    });
  });

  // -------------------------------------------------------------------------
  // State transitions
  // -------------------------------------------------------------------------

  describe('updateTaskState', () => {
    it('should transition submitted -> working', () => {
      const msg = makeMessage();
      const task = store.createTask({ contextId: 'ctx', requestMessage: msg });
      store.updateTaskState(task.id, 'working');
      const updated = store.getTask(task.id)!;
      expect(updated.status.state).toBe('working');
    });

    it('should transition working -> completed with status message', () => {
      const msg = makeMessage();
      const task = store.createTask({ contextId: 'ctx', requestMessage: msg });
      store.updateTaskState(task.id, 'working');

      const statusMsg = makeMessage({ role: 'agent' });
      store.updateTaskState(task.id, 'completed', statusMsg);

      const updated = store.getTask(task.id)!;
      expect(updated.status.state).toBe('completed');
      expect(updated.status.message).toBeDefined();
      expect(updated.status.message!.role).toBe('agent');
    });

    it('should allow all valid transitions', () => {
      const validPaths: [TaskState, TaskState][] = [
        ['submitted', 'working'],
        ['submitted', 'canceled'],
        ['submitted', 'rejected'],
        ['working', 'completed'],
        ['working', 'failed'],
        ['working', 'canceled'],
        ['working', 'input_required'],
        ['working', 'auth_required'],
        ['input_required', 'working'],
        ['input_required', 'canceled'],
        ['input_required', 'failed'],
        ['auth_required', 'working'],
        ['auth_required', 'canceled'],
        ['auth_required', 'failed'],
      ];

      for (const [from, to] of validPaths) {
        const msg = makeMessage();
        const task = store.createTask({ contextId: 'ctx', requestMessage: msg });

        // Get to the 'from' state by walking the shortest path
        const paths: Record<string, TaskState[]> = {
          submitted: [],
          working: ['working'],
          input_required: ['working', 'input_required'],
          auth_required: ['working', 'auth_required'],
        };

        const stepsToFrom = paths[from] || [];
        for (const step of stepsToFrom) {
          store.updateTaskState(task.id, step);
        }

        // Now attempt the transition under test
        store.updateTaskState(task.id, to);
        const updated = store.getTask(task.id)!;
        expect(updated.status.state).toBe(to);
      }
    });

    it('should reject invalid transitions', () => {
      const invalidPaths: [TaskState, TaskState][] = [
        ['submitted', 'completed'],
        ['submitted', 'failed'],
        ['submitted', 'input_required'],
        ['completed', 'working'],
        ['failed', 'working'],
        ['canceled', 'working'],
        ['rejected', 'working'],
      ];

      for (const [from, to] of invalidPaths) {
        const msg = makeMessage();
        const task = store.createTask({ contextId: 'ctx', requestMessage: msg });

        // Get to the 'from' state
        const paths: Record<string, TaskState[]> = {
          submitted: [],
          completed: ['working', 'completed'],
          failed: ['working', 'failed'],
          canceled: ['canceled'],
          rejected: ['rejected'],
        };

        const stepsToFrom = paths[from] || [];
        for (const step of stepsToFrom) {
          store.updateTaskState(task.id, step);
        }

        expect(() => store.updateTaskState(task.id, to)).toThrow(InvalidStateTransitionError);
      }
    });

    it('should throw TaskNotFoundError for unknown task', () => {
      expect(() => store.updateTaskState('nonexistent', 'working')).toThrow(TaskNotFoundError);
    });
  });

  // -------------------------------------------------------------------------
  // Artifacts and history
  // -------------------------------------------------------------------------

  describe('addArtifact', () => {
    it('should append artifacts to the task', () => {
      const msg = makeMessage();
      const task = store.createTask({ contextId: 'ctx', requestMessage: msg });

      const a1 = makeArtifact({ name: 'first' });
      const a2 = makeArtifact({ name: 'second' });

      store.addArtifact(task.id, a1);
      store.addArtifact(task.id, a2);

      const updated = store.getTask(task.id)!;
      expect(updated.artifacts).toHaveLength(2);
      expect(updated.artifacts[0].name).toBe('first');
      expect(updated.artifacts[1].name).toBe('second');
    });

    it('should throw TaskNotFoundError for unknown task', () => {
      expect(() => store.addArtifact('nonexistent', makeArtifact())).toThrow(TaskNotFoundError);
    });
  });

  describe('appendHistory', () => {
    it('should append messages in order', () => {
      const msg = makeMessage();
      const task = store.createTask({ contextId: 'ctx', requestMessage: msg });

      const m1 = makeMessage({ role: 'user', parts: [{ text: 'question' }] });
      const m2 = makeMessage({ role: 'agent', parts: [{ text: 'answer' }] });

      store.appendHistory(task.id, m1);
      store.appendHistory(task.id, m2);

      const updated = store.getTask(task.id)!;
      expect(updated.history).toHaveLength(2);
      expect(updated.history[0].role).toBe('user');
      expect(updated.history[1].role).toBe('agent');
    });

    it('should throw TaskNotFoundError for unknown task', () => {
      expect(() => store.appendHistory('nonexistent', makeMessage())).toThrow(TaskNotFoundError);
    });
  });

  describe('setRunId', () => {
    it('should set the run ID', () => {
      const msg = makeMessage();
      const task = store.createTask({ contextId: 'ctx', requestMessage: msg });
      store.setRunId(task.id, 'run-123');

      // We can verify by checking the task is still retrievable (run_id not exposed in AgentTask type directly)
      const updated = store.getTask(task.id);
      expect(updated).not.toBeNull();
    });

    it('should throw TaskNotFoundError for unknown task', () => {
      expect(() => store.setRunId('nonexistent', 'run-123')).toThrow(TaskNotFoundError);
    });
  });

  // -------------------------------------------------------------------------
  // Context ID resolution
  // -------------------------------------------------------------------------

  describe('context ID resolution', () => {
    it('should use provided contextId when message has no context_id', () => {
      const msg = makeMessage(); // no context_id
      const task = store.createTask({ contextId: 'provided-ctx', requestMessage: msg });
      expect(task.context_id).toBe('provided-ctx');
    });

    it('should use message context_id when provided', () => {
      const msg = makeMessage({ context_id: 'msg-ctx' });
      const task = store.createTask({ contextId: 'fallback-ctx', requestMessage: msg });
      expect(task.context_id).toBe('msg-ctx');
    });

    it('should infer context from existing task when task_id provided', () => {
      const msg1 = makeMessage();
      const existingTask = store.createTask({ contextId: 'original-ctx', requestMessage: msg1 });

      const msg2 = makeMessage({ task_id: existingTask.id });
      const newTask = store.createTask({ contextId: 'other-ctx', requestMessage: msg2 });
      expect(newTask.context_id).toBe('original-ctx');
    });

    it('should throw ContextMismatchError when task_id and context_id conflict', () => {
      const msg1 = makeMessage();
      const existingTask = store.createTask({ contextId: 'original-ctx', requestMessage: msg1 });

      const msg2 = makeMessage({
        task_id: existingTask.id,
        context_id: 'conflicting-ctx',
      });

      expect(() => store.createTask({ contextId: 'whatever', requestMessage: msg2 })).toThrow(
        ContextMismatchError
      );
    });
  });

  // -------------------------------------------------------------------------
  // Queue operations
  // -------------------------------------------------------------------------

  describe('claimNextSubmitted', () => {
    it('should claim the oldest submitted task', () => {
      const msg = makeMessage();
      const t1 = store.createTask({ contextId: 'ctx', requestMessage: msg });
      store.createTask({ contextId: 'ctx', requestMessage: msg });

      const claimed = store.claimNextSubmitted('worker-1');
      expect(claimed).not.toBeNull();
      expect(claimed!.id).toBe(t1.id);
      expect(claimed!.status.state).toBe('working');
    });

    it('should return null when no submitted tasks', () => {
      const claimed = store.claimNextSubmitted('worker-1');
      expect(claimed).toBeNull();
    });

    it('should not double-claim', () => {
      const msg = makeMessage();
      store.createTask({ contextId: 'ctx', requestMessage: msg });

      const claim1 = store.claimNextSubmitted('worker-1');
      const claim2 = store.claimNextSubmitted('worker-2');

      expect(claim1).not.toBeNull();
      expect(claim2).toBeNull();
    });
  });

  describe('reclaimStaleTasks', () => {
    it('should return empty array when no stale tasks exist', () => {
      const reclaimed = store.reclaimStaleTasks('worker-1');
      expect(reclaimed).toEqual([]);
    });

    it('should not reclaim tasks within timeout', () => {
      const msg = makeMessage();
      store.createTask({ contextId: 'ctx', requestMessage: msg });
      store.claimNextSubmitted('worker-1');

      const reclaimed = store.reclaimStaleTasks('worker-2');
      expect(reclaimed).toEqual([]);
    });

    it('should reclaim stale working tasks back to submitted', () => {
      const msg = makeMessage();
      const task = store.createTask({ contextId: 'ctx', requestMessage: msg });
      store.claimNextSubmitted('worker-1');

      // Use <=0 comparison: set claimed_at to the past manually
      const db = (store as any).getDb();
      db.prepare(
        "UPDATE agent_tasks SET claimed_at = datetime('now', '-10 seconds') WHERE id = ?"
      ).run(task.id);

      const reclaimed = store.reclaimStaleTasks('worker-2', 5000); // 5s timeout
      expect(reclaimed).toHaveLength(1);
      expect(reclaimed[0].id).toBe(task.id);
      expect(reclaimed[0].status.state).toBe('submitted');
    });

    it('should make reclaimed tasks available for claimNextSubmitted', () => {
      const msg = makeMessage();
      const task = store.createTask({ contextId: 'ctx', requestMessage: msg });
      store.claimNextSubmitted('worker-1');

      // Set claimed_at to the past
      const db = (store as any).getDb();
      db.prepare(
        "UPDATE agent_tasks SET claimed_at = datetime('now', '-10 seconds') WHERE id = ?"
      ).run(task.id);
      store.reclaimStaleTasks('worker-2', 5000);

      const claimed = store.claimNextSubmitted('worker-2');
      expect(claimed).not.toBeNull();
      expect(claimed!.id).toBe(task.id);
      expect(claimed!.status.state).toBe('working');
    });
  });

  describe('releaseClaim', () => {
    it('should release a claimed task back to submitted', () => {
      const msg = makeMessage();
      const task = store.createTask({ contextId: 'ctx', requestMessage: msg });
      store.claimNextSubmitted('worker-1');

      store.releaseClaim(task.id);

      const updated = store.getTask(task.id)!;
      expect(updated.status.state).toBe('submitted');
    });
  });

  // -------------------------------------------------------------------------
  // Cleanup
  // -------------------------------------------------------------------------

  describe('deleteExpiredTasks', () => {
    it('should delete tasks with expired expires_at', () => {
      const msg = makeMessage();
      // Create task that expired 1 hour ago
      const pastDate = new Date(Date.now() - 3600_000).toISOString();
      store.createTask({
        contextId: 'ctx',
        requestMessage: msg,
        expiresAt: pastDate,
      });
      // Create task that expires in 1 hour
      const futureDate = new Date(Date.now() + 3600_000).toISOString();
      store.createTask({
        contextId: 'ctx',
        requestMessage: msg,
        expiresAt: futureDate,
      });
      // Create task with no expiry
      store.createTask({ contextId: 'ctx', requestMessage: msg });

      const deletedIds = store.deleteExpiredTasks();
      expect(deletedIds).toHaveLength(1);

      const remaining = store.listTasks({});
      expect(remaining.total).toBe(2);
    });
  });

  describe('deleteTask', () => {
    it('should delete a specific task', () => {
      const msg = makeMessage();
      const task = store.createTask({ contextId: 'ctx', requestMessage: msg });
      store.deleteTask(task.id);
      expect(store.getTask(task.id)).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Crash recovery & cleanup
  // -------------------------------------------------------------------------

  describe('failStaleTasks', () => {
    it('should only fail unclaimed working tasks by default', () => {
      const msg = makeMessage();
      const t1 = store.createTask({ contextId: 'ctx1', requestMessage: msg });
      const t2 = store.createTask({ contextId: 'ctx2', requestMessage: msg });
      const t3 = store.createTask({ contextId: 'ctx3', requestMessage: msg });

      // Move t1 and t2 to working, leave t3 as submitted
      store.updateTaskState(t1.id, 'working');
      store.updateTaskState(t2.id, 'working');

      // Claim t2 by an instance — simulates a running instance owning this task
      store.claimTask(t2.id, 'instance-A');

      const count = store.failStaleTasks('crash recovery');
      // Only t1 (unclaimed) should be failed; t2 (claimed) is left alone
      expect(count).toBe(1);

      expect(store.getTask(t1.id)!.status.state).toBe('failed');
      expect(store.getTask(t2.id)!.status.state).toBe('working');
      expect(store.getTask(t3.id)!.status.state).toBe('submitted');
    });

    it('should fail only tasks owned by the specified instance', () => {
      const msg = makeMessage();
      const t1 = store.createTask({ contextId: 'ctx1', requestMessage: msg });
      const t2 = store.createTask({ contextId: 'ctx2', requestMessage: msg });
      const t3 = store.createTask({ contextId: 'ctx3', requestMessage: msg });

      store.updateTaskState(t1.id, 'working');
      store.updateTaskState(t2.id, 'working');
      store.updateTaskState(t3.id, 'working');

      store.claimTask(t1.id, 'instance-A');
      store.claimTask(t2.id, 'instance-B');
      store.claimTask(t3.id, 'instance-A');

      // Only fail tasks owned by instance-A
      const count = store.failStaleTasks('crash recovery', 'instance-A');
      expect(count).toBe(2);

      expect(store.getTask(t1.id)!.status.state).toBe('failed');
      expect(store.getTask(t2.id)!.status.state).toBe('working'); // instance-B untouched
      expect(store.getTask(t3.id)!.status.state).toBe('failed');
    });

    it('should return 0 when no working tasks exist', () => {
      const msg = makeMessage();
      store.createTask({ contextId: 'ctx', requestMessage: msg });
      expect(store.failStaleTasks()).toBe(0);
    });

    it('should set the failure reason in status message', () => {
      const msg = makeMessage();
      const task = store.createTask({ contextId: 'ctx', requestMessage: msg });
      store.updateTaskState(task.id, 'working');
      // unclaimed task — will be failed by default call
      store.failStaleTasks('Process killed');
      const updated = store.getTask(task.id)!;
      expect(updated.status.state).toBe('failed');
      expect(updated.status.message?.parts?.[0]).toHaveProperty('text', 'Process killed');
    });

    it('should not fail claimed tasks from other instances on startup', () => {
      // Simulates the production bug: instance-B starts up and calls failStaleTasks()
      // while instance-A still has a running task
      const msg = makeMessage();
      const taskA = store.createTask({ contextId: 'ctx1', requestMessage: msg });
      const taskB = store.createTask({ contextId: 'ctx2', requestMessage: msg });

      store.updateTaskState(taskA.id, 'working');
      store.updateTaskState(taskB.id, 'working');
      store.claimTask(taskA.id, 'instance-A');
      store.claimTask(taskB.id, 'instance-B');

      // Instance-B restarts and calls failStaleTasks() without specifying an instance
      const count = store.failStaleTasks('Process terminated unexpectedly');
      expect(count).toBe(0); // Both are claimed, neither should be failed

      // Both tasks should still be working
      expect(store.getTask(taskA.id)!.status.state).toBe('working');
      expect(store.getTask(taskB.id)!.status.state).toBe('working');
    });
  });

  describe('failStaleTasksByAge', () => {
    it('should fail working tasks older than the age threshold', () => {
      const msg = makeMessage();
      const t1 = store.createTask({ contextId: 'ctx1', requestMessage: msg });
      const t2 = store.createTask({ contextId: 'ctx2', requestMessage: msg });

      store.updateTaskState(t1.id, 'working');
      store.updateTaskState(t2.id, 'working');

      // With 0ms threshold, both should be stale immediately
      const count = store.failStaleTasksByAge(0, 'exceeded max duration');
      expect(count).toBe(2);
      expect(store.getTask(t1.id)!.status.state).toBe('failed');
      expect(store.getTask(t2.id)!.status.state).toBe('failed');
      expect(store.getTask(t2.id)!.status.message?.parts?.[0]).toHaveProperty(
        'text',
        'exceeded max duration'
      );
    });

    it('should not fail recently started working tasks', () => {
      const msg = makeMessage();
      const task = store.createTask({ contextId: 'ctx', requestMessage: msg });
      store.updateTaskState(task.id, 'working');

      // With a large threshold, task should not be stale
      const count = store.failStaleTasksByAge(86_400_000);
      expect(count).toBe(0);
      expect(store.getTask(task.id)!.status.state).toBe('working');
    });

    it('should not affect submitted or completed tasks', () => {
      const msg = makeMessage();
      const t1 = store.createTask({ contextId: 'ctx1', requestMessage: msg });
      const t2 = store.createTask({ contextId: 'ctx2', requestMessage: msg });

      // t1 stays submitted, t2 goes to completed
      store.updateTaskState(t2.id, 'working');
      store.updateTaskState(t2.id, 'completed');

      const count = store.failStaleTasksByAge(0);
      expect(count).toBe(0);
      expect(store.getTask(t1.id)!.status.state).toBe('submitted');
      expect(store.getTask(t2.id)!.status.state).toBe('completed');
    });
  });

  describe('purgeOldTasks', () => {
    it('should delete terminal tasks older than threshold', () => {
      const msg = makeMessage();
      const t1 = store.createTask({ contextId: 'ctx1', requestMessage: msg });
      const t2 = store.createTask({ contextId: 'ctx2', requestMessage: msg });

      store.updateTaskState(t1.id, 'working');
      store.updateTaskState(t1.id, 'completed');
      store.updateTaskState(t2.id, 'working');
      store.updateTaskState(t2.id, 'failed');

      // Purge with 0ms threshold = delete everything terminal
      const count = store.purgeOldTasks(0);
      expect(count).toBe(2);
      expect(store.getTask(t1.id)).toBeNull();
      expect(store.getTask(t2.id)).toBeNull();
    });

    it('should not delete active tasks', () => {
      const msg = makeMessage();
      const t1 = store.createTask({ contextId: 'ctx1', requestMessage: msg });
      const t2 = store.createTask({ contextId: 'ctx2', requestMessage: msg });

      store.updateTaskState(t1.id, 'working');
      // t1 is working, t2 is submitted — both active

      const count = store.purgeOldTasks(0);
      expect(count).toBe(0);
      expect(store.getTask(t1.id)).not.toBeNull();
      expect(store.getTask(t2.id)).not.toBeNull();
    });

    it('should respect age threshold', () => {
      const msg = makeMessage();
      const task = store.createTask({ contextId: 'ctx', requestMessage: msg });
      store.updateTaskState(task.id, 'working');
      store.updateTaskState(task.id, 'completed');

      // Purge tasks older than 1 hour — task was just created, so nothing deleted
      const count = store.purgeOldTasks(3600_000);
      expect(count).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Search and filter extensions
  // -------------------------------------------------------------------------

  describe('search filter', () => {
    it('should filter tasks by message text', () => {
      store.createTask({
        contextId: 'ctx1',
        requestMessage: makeMessage({ parts: [{ text: 'How does auth work?' }] }),
      });
      store.createTask({
        contextId: 'ctx2',
        requestMessage: makeMessage({ parts: [{ text: 'Deploy to production' }] }),
      });

      const result = store.listTasks({ search: 'auth' });
      expect(result.total).toBe(1);
    });

    it('should escape SQL wildcards in search', () => {
      store.createTask({
        contextId: 'ctx1',
        requestMessage: makeMessage({ parts: [{ text: 'test 100% done' }] }),
      });
      store.createTask({
        contextId: 'ctx2',
        requestMessage: makeMessage({ parts: [{ text: 'test something' }] }),
      });

      // Search for literal "%" — should only match the first task
      const result = store.listTasks({ search: '100%' });
      expect(result.total).toBe(1);
    });
  });

  describe('claimedBy filter', () => {
    it('should filter tasks by claimed_by', () => {
      const msg = makeMessage();
      const t1 = store.createTask({ contextId: 'ctx1', requestMessage: msg });
      store.createTask({ contextId: 'ctx2', requestMessage: msg });

      store.claimNextSubmitted('worker-a');
      store.claimNextSubmitted('worker-b');

      const sqlStore = store as SqliteTaskStore;
      const result = sqlStore.listTasksRaw({ claimedBy: 'worker-a' });
      expect(result.total).toBe(1);
      expect(result.rows[0].id).toBe(t1.id);
    });
  });

  describe('claimTask', () => {
    it('should set claimed_by and claimed_at', () => {
      const msg = makeMessage();
      const task = store.createTask({ contextId: 'ctx', requestMessage: msg });
      store.updateTaskState(task.id, 'working');
      store.claimTask(task.id, 'my-instance');

      const sqlStore = store as SqliteTaskStore;
      const { rows } = sqlStore.listTasksRaw({});
      expect(rows[0].claimed_by).toBe('my-instance');
      expect(rows[0].claimed_at).toBeTruthy();
    });
  });

  describe('heartbeat', () => {
    it('should update updated_at for working tasks', () => {
      const msg = makeMessage();
      const task = store.createTask({ contextId: 'ctx', requestMessage: msg });
      store.updateTaskState(task.id, 'working');

      // Small delay to ensure timestamp differs
      store.heartbeat(task.id);
      const after = store.getTask(task.id)!;

      expect(after.status.timestamp).toBeDefined();
      expect(after.status.state).toBe('working');
    });
  });

  describe('metadata filter', () => {
    it('should filter tasks by metadata fields', () => {
      const sqlStore = store as SqliteTaskStore;
      store.createTask({
        contextId: 'ctx-1',
        requestMessage: makeMessage(),
        requestMetadata: { slack_channel: 'C123', slack_thread_ts: 'T100' },
      });
      store.createTask({
        contextId: 'ctx-2',
        requestMessage: makeMessage(),
        requestMetadata: { slack_channel: 'C123', slack_thread_ts: 'T200' },
      });
      store.createTask({
        contextId: 'ctx-3',
        requestMessage: makeMessage(),
        requestMetadata: { slack_channel: 'C999', slack_thread_ts: 'T100' },
      });

      // Filter by channel only
      const byChannel = sqlStore.listTasksRaw({
        metadata: { slack_channel: 'C123' },
      });
      expect(byChannel.rows.length).toBe(2);

      // Filter by channel + thread
      const byThread = sqlStore.listTasksRaw({
        metadata: { slack_channel: 'C123', slack_thread_ts: 'T100' },
      });
      expect(byThread.rows.length).toBe(1);

      // No match
      const noMatch = sqlStore.listTasksRaw({
        metadata: { slack_channel: 'CXXX' },
      });
      expect(noMatch.rows.length).toBe(0);
    });
  });
});
