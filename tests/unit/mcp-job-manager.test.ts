import { JobManager } from '../../src/mcp-job-manager';
import type { TaskStore } from '../../src/agent-protocol/task-store';
import type {
  AgentTask,
  TaskState,
  AgentMessage,
  AgentArtifact,
} from '../../src/agent-protocol/types';

/**
 * In-memory mock TaskStore for testing the JobManager without SQLite.
 */
function createMockTaskStore(): TaskStore {
  const tasks = new Map<string, AgentTask>();

  return {
    async initialize() {},
    async shutdown() {},

    createTask(params) {
      const id = require('crypto').randomUUID();
      const task: AgentTask = {
        id,
        context_id: params.contextId,
        status: {
          state: 'submitted',
          timestamp: new Date().toISOString(),
        },
        artifacts: [],
        history: [],
        metadata: params.requestMetadata,
        workflow_id: params.workflowId,
      };
      tasks.set(id, task);
      return task;
    },

    getTask(taskId: string) {
      return tasks.get(taskId) || null;
    },

    listTasks(filter) {
      const all = Array.from(tasks.values());
      return { tasks: all.slice(0, filter.limit || 50), total: all.length };
    },

    updateTaskState(taskId: string, newState: TaskState, statusMessage?: AgentMessage) {
      const task = tasks.get(taskId);
      if (!task) throw new Error(`Task ${taskId} not found`);
      task.status = {
        state: newState,
        message: statusMessage,
        timestamp: new Date().toISOString(),
      };
    },

    claimTask() {},
    heartbeat() {},
    addArtifact(taskId: string, artifact: AgentArtifact) {
      const task = tasks.get(taskId);
      if (task) task.artifacts.push(artifact);
    },
    appendHistory() {},
    setRunId() {},
    updateMetadata() {},
    claimNextSubmitted() {
      return null;
    },
    reclaimStaleTasks() {
      return [];
    },
    releaseClaim() {},
    failStaleTasks() {
      return 0;
    },
    failStaleTasksByAge() {
      return 0;
    },
    purgeOldTasks() {
      return 0;
    },
    deleteExpiredTasks() {
      return 0;
    },
    deleteTask() {},
  } as TaskStore;
}

describe('JobManager', () => {
  let manager: JobManager;
  let taskStore: TaskStore;

  beforeEach(() => {
    taskStore = createMockTaskStore();
    manager = new JobManager(taskStore);
  });

  it('should start a job and return running response immediately', () => {
    const response = manager.startJob(
      async () => {
        await new Promise(resolve => setTimeout(resolve, 5000));
        return { data: 'result' };
      },
      { messageText: 'test job' }
    );

    expect(response.job_id).toHaveLength(8);
    expect(response.done).toBe(false);
    expect(response.status).toBe('running');
    expect(response.polling.recommended_next_action).toBe('get_job');
    expect(response.polling.recommended_delay_seconds).toBe(0);
    expect(response.result).toBeNull();
    expect(response.error).toBeNull();
    expect(response.next_instruction_for_model).toContain('get_job');
  });

  it('should long-poll and return result when job completes during wait', async () => {
    // Job completes after 100ms — get_job should return as soon as it finishes
    const response = manager.startJob(
      async () => ({ content: [{ type: 'text', text: 'All good' }] }),
      { messageText: 'test job' }
    );

    const start = Date.now();
    const status = await manager.getJob(response.job_id);
    const elapsed = Date.now() - start;

    expect(status.status).toBe('completed');
    expect(status.done).toBe(true);
    expect(status.result).toBe('All good');
    expect(status.progress.percent).toBe(100);
    expect(status.polling.recommended_next_action).toBe('none');
    // Should resolve quickly, not wait the full 59 seconds
    expect(elapsed).toBeLessThan(5000);
  });

  it('should long-poll and return immediately for already-completed jobs', async () => {
    const response = manager.startJob(async () => ({ content: [{ type: 'text', text: 'done' }] }), {
      messageText: 'test',
    });

    // Wait for completion first
    await new Promise(resolve => setTimeout(resolve, 50));

    const start = Date.now();
    const status = await manager.getJob(response.job_id);
    const elapsed = Date.now() - start;

    expect(status.status).toBe('completed');
    expect(elapsed).toBeLessThan(100); // should be near-instant
  });

  it('should handle job failure via long poll', async () => {
    const response = manager.startJob(
      async () => {
        throw new Error('Something went wrong');
      },
      { messageText: 'failing job' }
    );

    const status = await manager.getJob(response.job_id);
    expect(status.status).toBe('failed');
    expect(status.done).toBe(true);
    expect(status.error).toBeTruthy();
    expect(status.error!.message).toBe('Something went wrong');
    expect(status.error!.retryable).toBe(true);
    expect(status.result).toBeNull();
  });

  it('should return expired for unknown job IDs immediately', async () => {
    const start = Date.now();
    const status = await manager.getJob('nonexistent');
    const elapsed = Date.now() - start;

    expect(status.status).toBe('expired');
    expect(status.done).toBe(true);
    expect(status.error!.code).toBe('JOB_EXPIRED');
    expect(elapsed).toBeLessThan(100); // no waiting for unknown jobs
  });

  it('should return 8-char job IDs (UUID prefix)', () => {
    const response = manager.startJob(async () => 'test', { messageText: 'test' });
    expect(response.job_id).toMatch(/^[0-9a-f]{8}$/);
  });

  it('should look up jobs by short ID prefix', async () => {
    const response = manager.startJob(
      async () => ({ content: [{ type: 'text', text: 'found it' }] }),
      { messageText: 'test' }
    );

    const status = await manager.getJob(response.job_id);
    expect(status.status).toBe('completed');
    expect(status.result).toBe('found it');
  });

  it('should store jobs as tasks visible to TaskStore', async () => {
    manager.startJob(async () => 'result', { messageText: 'visible task' });

    await new Promise(resolve => setTimeout(resolve, 50));

    const { tasks } = taskStore.listTasks({ limit: 10 });
    expect(tasks.length).toBe(1);
    expect(tasks[0].metadata?.source).toBe('mcp');
    expect(tasks[0].metadata?.async_job).toBe(true);
  });

  it('should pass workflowId to the task', () => {
    manager.startJob(async () => 'result', {
      messageText: 'test',
      workflowId: 'code-review',
    });

    const { tasks } = taskStore.listTasks({ limit: 10 });
    expect(tasks[0].workflow_id).toBe('code-review');
  });

  it('should extract result from plain string return', async () => {
    const response = manager.startJob(async () => 'plain string result', {
      messageText: 'test',
    });

    const status = await manager.getJob(response.job_id);
    expect(status.status).toBe('completed');
    expect(status.result).toBe('plain string result');
  });

  it('should handle non-Error thrown values', async () => {
    const response = manager.startJob(
      async () => {
        throw 'string error message';
      },
      { messageText: 'test' }
    );

    const status = await manager.getJob(response.job_id);
    expect(status.status).toBe('failed');
    expect(status.error!.message).toBe('string error message');
  });

  it('should allow concurrent getJob calls on the same job', async () => {
    const response = manager.startJob(
      async () => {
        await new Promise(resolve => setTimeout(resolve, 200));
        return { content: [{ type: 'text', text: 'concurrent result' }] };
      },
      { messageText: 'test' }
    );

    // Both should resolve with the same result
    const [status1, status2] = await Promise.all([
      manager.getJob(response.job_id),
      manager.getJob(response.job_id),
    ]);

    expect(status1.status).toBe('completed');
    expect(status2.status).toBe('completed');
    expect(status1.result).toBe('concurrent result');
    expect(status2.result).toBe('concurrent result');
  });

  it('should include all response fields in completed status', async () => {
    const response = manager.startJob(
      async () => ({ content: [{ type: 'text', text: 'full response' }] }),
      { messageText: 'test' }
    );

    const status = await manager.getJob(response.job_id);
    expect(status).toEqual(
      expect.objectContaining({
        job_id: expect.stringMatching(/^[0-9a-f]{8}$/),
        status: 'completed',
        done: true,
        progress: { percent: 100, step: 'completed', message: 'Job finished successfully' },
        polling: { recommended_next_action: 'none', recommended_delay_seconds: 0 },
        result: 'full response',
        error: null,
        user_message: 'The result is ready.',
        next_instruction_for_model: 'Use the result to answer the user.',
      })
    );
  });

  it('should respect custom long poll timeout', async () => {
    const shortManager = new JobManager(taskStore, { longPollTimeoutMs: 1000 });
    const response = shortManager.startJob(
      async () => {
        await new Promise(resolve => setTimeout(resolve, 5000));
        return 'late';
      },
      { messageText: 'slow job' }
    );

    const start = Date.now();
    const status = await shortManager.getJob(response.job_id);
    const elapsed = Date.now() - start;

    // Should timeout after ~1 second, not wait 59 seconds
    expect(status.done).toBe(false);
    expect(status.status).toBe('running');
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(3000);
  });
});
