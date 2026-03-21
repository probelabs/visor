import { JobManager } from '../../src/mcp-job-manager';

describe('JobManager', () => {
  let manager: JobManager;

  beforeEach(() => {
    manager = new JobManager();
  });

  afterEach(() => {
    manager.dispose();
  });

  it('should start a job and return queued/running response immediately', () => {
    const response = manager.startJob(async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
      return { data: 'result' };
    });

    expect(response.job_id).toHaveLength(6);
    expect(response.done).toBe(false);
    expect(response.status).toMatch(/queued|running/);
    expect(response.polling.recommended_next_action).toBe('get_job');
    expect(response.polling.recommended_delay_seconds).toBe(10);
    expect(response.result).toBeNull();
    expect(response.error).toBeNull();
    expect(response.next_instruction_for_model).toContain('get_job');
  });

  it('should complete a job and return result via get_job', async () => {
    const response = manager.startJob(async () => {
      return { summary: 'All good' };
    });

    // Wait for the handler to complete
    await new Promise(resolve => setTimeout(resolve, 50));

    const status = manager.getJob(response.job_id);
    expect(status.status).toBe('completed');
    expect(status.done).toBe(true);
    expect(status.result).toEqual({ summary: 'All good' });
    expect(status.progress.percent).toBe(100);
    expect(status.polling.recommended_next_action).toBe('none');
    expect(status.next_instruction_for_model).toContain('result');
  });

  it('should handle job failure', async () => {
    const response = manager.startJob(async () => {
      throw new Error('Something went wrong');
    });

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

  it('should support idempotency keys', () => {
    const r1 = manager.startJob(async () => ({ data: 1 }), 'same-key');
    const r2 = manager.startJob(async () => ({ data: 2 }), 'same-key');

    // Should return the same job
    expect(r2.job_id).toBe(r1.job_id);
  });

  it('should allow different idempotency keys to create separate jobs', () => {
    const r1 = manager.startJob(async () => 1, 'key-a');
    const r2 = manager.startJob(async () => 2, 'key-b');

    expect(r2.job_id).not.toBe(r1.job_id);
  });

  it('should support progress updates', async () => {
    const response = manager.startJob(async updateProgress => {
      updateProgress({ percent: 50, step: 'halfway', message: 'Half done' });
      await new Promise(resolve => setTimeout(resolve, 50));
      return 'done';
    });

    // Give the handler a moment to call updateProgress
    await new Promise(resolve => setTimeout(resolve, 10));

    const status = manager.getJob(response.job_id);
    // Job may still be running with updated progress, or completed
    if (status.status === 'running') {
      expect(status.progress.percent).toBe(50);
      expect(status.progress.step).toBe('halfway');
    }
  });

  it('should clean up expired jobs', async () => {
    const response = manager.startJob(async () => 'result');

    await new Promise(resolve => setTimeout(resolve, 50));

    // Verify job exists
    expect(manager.getJob(response.job_id).status).toBe('completed');

    // Force the completedAt to be old
    const job = (manager as any).jobs.get(response.job_id);
    job.completedAt = Date.now() - 2 * 60 * 60 * 1000; // 2 hours ago

    manager.cleanup();

    // Job should now be expired
    expect(manager.getJob(response.job_id).status).toBe('expired');
  });

  it('should generate 6-character hex job IDs', () => {
    const response = manager.startJob(async () => 'test');
    expect(response.job_id).toMatch(/^[0-9a-f]{6}$/);
  });
});
