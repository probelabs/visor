import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { SqliteTaskStore } from '../../../src/agent-protocol/task-store';
import { TaskQueue } from '../../../src/agent-protocol/task-queue';
import type { TaskExecutor } from '../../../src/agent-protocol/task-queue';
import type { AgentMessage } from '../../../src/agent-protocol/types';

function makeMessage(): AgentMessage {
  return {
    message_id: crypto.randomUUID(),
    role: 'user',
    parts: [{ text: 'Hello agent' }],
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

describe('TaskQueue', () => {
  let store: SqliteTaskStore;
  let dbPath: string;

  beforeEach(async () => {
    const tmpDir = path.join(__dirname, '../../fixtures/tmp-task-queue');
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

  it('should claim and execute submitted tasks', async () => {
    const executed: string[] = [];
    const executor: TaskExecutor = async task => {
      executed.push(task.id);
      return { success: true, summary: 'Done' };
    };

    // Create a task
    const task = store.createTask({ contextId: 'ctx', requestMessage: makeMessage() });

    const queue = new TaskQueue(store, executor, null, { pollInterval: 50, maxConcurrent: 5 });
    queue.start();

    // Wait for the queue to pick it up
    await sleep(200);
    await queue.stop();

    expect(executed).toContain(task.id);

    // Task should be completed
    const updated = store.getTask(task.id)!;
    expect(updated.status.state).toBe('completed');
  });

  it('should mark failed tasks when executor throws', async () => {
    const executor: TaskExecutor = async () => {
      throw new Error('Boom');
    };

    const task = store.createTask({ contextId: 'ctx', requestMessage: makeMessage() });

    const queue = new TaskQueue(store, executor, null, { pollInterval: 50 });
    queue.start();
    await sleep(200);
    await queue.stop();

    const updated = store.getTask(task.id)!;
    expect(updated.status.state).toBe('failed');
  });

  it('should mark failed tasks when executor returns success=false', async () => {
    const executor: TaskExecutor = async () => {
      return { success: false, error: 'Something went wrong' };
    };

    const task = store.createTask({ contextId: 'ctx', requestMessage: makeMessage() });

    const queue = new TaskQueue(store, executor, null, { pollInterval: 50 });
    queue.start();
    await sleep(200);
    await queue.stop();

    const updated = store.getTask(task.id)!;
    expect(updated.status.state).toBe('failed');
  });

  it('should respect maxConcurrent limit', async () => {
    let concurrent = 0;
    let maxConcurrentSeen = 0;

    const executor: TaskExecutor = async () => {
      concurrent++;
      maxConcurrentSeen = Math.max(maxConcurrentSeen, concurrent);
      await sleep(100);
      concurrent--;
      return { success: true };
    };

    // Create 5 tasks
    for (let i = 0; i < 5; i++) {
      store.createTask({ contextId: 'ctx', requestMessage: makeMessage() });
    }

    const queue = new TaskQueue(store, executor, null, {
      pollInterval: 50,
      maxConcurrent: 2,
    });
    queue.start();
    await sleep(500);
    await queue.stop();

    // Should never exceed 2 concurrent
    expect(maxConcurrentSeen).toBeLessThanOrEqual(2);
  });

  it('should not double-claim tasks', async () => {
    const executed: string[] = [];
    const executor: TaskExecutor = async task => {
      executed.push(task.id);
      return { success: true };
    };

    const task = store.createTask({ contextId: 'ctx', requestMessage: makeMessage() });

    const q1 = new TaskQueue(store, executor, null, { pollInterval: 50 }, 'worker-1');
    const q2 = new TaskQueue(store, executor, null, { pollInterval: 50 }, 'worker-2');

    q1.start();
    q2.start();
    await sleep(300);
    await q1.stop();
    await q2.stop();

    // Task should only be executed once
    expect(executed.filter(id => id === task.id).length).toBe(1);
  });

  it('should handle empty task store gracefully', async () => {
    const executor: TaskExecutor = async () => ({ success: true });

    const queue = new TaskQueue(store, executor, null, { pollInterval: 50 });
    queue.start();
    await sleep(200);
    await queue.stop();

    // No errors, queue just idles
    expect(queue.getActiveCount()).toBe(0);
  });

  it('should stop accepting new tasks after stop', async () => {
    const executor: TaskExecutor = async () => ({ success: true });

    const queue = new TaskQueue(store, executor, null, { pollInterval: 50 });
    queue.start();
    await queue.stop();

    expect(queue.isRunning()).toBe(false);
  });

  it('should skip state transition when executor sets stateAlreadySet', async () => {
    const executor: TaskExecutor = async task => {
      // Executor handles its own state transition (like executeTaskViaEngine does)
      store.updateTaskState(task.id, 'completed', {
        message_id: 'done',
        role: 'agent',
        parts: [{ text: 'Done' }],
      });
      return { success: true, stateAlreadySet: true };
    };

    const task = store.createTask({ contextId: 'ctx', requestMessage: makeMessage() });

    const queue = new TaskQueue(store, executor, null, { pollInterval: 50 });
    queue.start();
    await sleep(200);
    await queue.stop();

    const updated = store.getTask(task.id)!;
    expect(updated.status.state).toBe('completed');
  });
});
