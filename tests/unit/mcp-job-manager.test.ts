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
        await new Promise(resolve => setTimeout(resolve, 100));
        return { data: 'result' };
      },
      { messageText: 'test job' }
    );

    expect(response.job_id).toHaveLength(8); // first 8 chars of UUID
    expect(response.done).toBe(false);
    expect(response.status).toBe('running'); // task transitions to working immediately
    expect(response.polling.recommended_next_action).toBe('get_job');
    expect(response.polling.recommended_delay_seconds).toBe(10);
    expect(response.result).toBeNull();
    expect(response.error).toBeNull();
    expect(response.next_instruction_for_model).toContain('get_job');
  });

  it('should complete a job and return result via get_job', async () => {
    const response = manager.startJob(
      async () => ({ content: [{ type: 'text', text: 'All good' }] }),
      { messageText: 'test job' }
    );

    // Wait for the handler to complete
    await new Promise(resolve => setTimeout(resolve, 50));

    const status = manager.getJob(response.job_id);
    expect(status.status).toBe('completed');
    expect(status.done).toBe(true);
    expect(status.result).toBe('All good');
    expect(status.progress.percent).toBe(100);
    expect(status.polling.recommended_next_action).toBe('none');
    expect(status.next_instruction_for_model).toContain('result');
  });

  it('should handle job failure', async () => {
    const response = manager.startJob(
      async () => {
        throw new Error('Something went wrong');
      },
      { messageText: 'failing job' }
    );

    await new Promise(resolve => setTimeout(resolve, 50));

    const status = manager.getJob(response.job_id);
    expect(status.status).toBe('failed');
    expect(status.done).toBe(true);
    expect(status.error).toBeTruthy();
    expect(status.error!.message).toBe('Something went wrong');
    expect(status.error!.retryable).toBe(true);
    expect(status.result).toBeNull();
  });

  it('should return expired for unknown job IDs', () => {
    const status = manager.getJob('nonexistent');
    expect(status.status).toBe('expired');
    expect(status.done).toBe(true);
    expect(status.error).toBeTruthy();
    expect(status.error!.code).toBe('JOB_EXPIRED');
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

    await new Promise(resolve => setTimeout(resolve, 50));

    // Look up by the 8-char short ID
    const status = manager.getJob(response.job_id);
    expect(status.status).toBe('completed');
    expect(status.result).toBe('found it');
  });

  it('should store jobs as tasks visible to TaskStore', async () => {
    manager.startJob(async () => 'result', { messageText: 'visible task' });

    await new Promise(resolve => setTimeout(resolve, 50));

    // The task should be in the store
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
});
