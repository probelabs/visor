import {
  getTaskProgressToolDefinition,
  isTaskProgressTool,
  handleTaskProgressAction,
} from '../../../src/agent-protocol/task-progress-tool';

// Mock trace-serializer to avoid filesystem/network access
jest.mock('../../../src/agent-protocol/trace-serializer', () => ({
  serializeTraceForPrompt: jest.fn().mockResolvedValue('mock-trace-tree'),
  readTraceIdFromFile: jest.fn().mockResolvedValue('abc123'),
}));

describe('task-progress-tool', () => {
  describe('getTaskProgressToolDefinition', () => {
    it('should return a valid tool definition', () => {
      const def = getTaskProgressToolDefinition();
      expect(def.name).toBe('task_progress');
      expect(def.description).toBeTruthy();
      expect(def.inputSchema).toBeDefined();
      expect(def.inputSchema.properties).toHaveProperty('action');
      expect(def.inputSchema.properties).toHaveProperty('task_id');
      expect(def.inputSchema.required).toEqual(['action']);
    });
  });

  describe('isTaskProgressTool', () => {
    it('should return true for task_progress', () => {
      expect(isTaskProgressTool('task_progress')).toBe(true);
    });

    it('should return false for other names', () => {
      expect(isTaskProgressTool('schedule')).toBe(false);
      expect(isTaskProgressTool('task')).toBe(false);
    });
  });

  describe('handleTaskProgressAction', () => {
    const mockStore = {
      listTasksRaw: jest.fn(),
      getTask: jest.fn(),
    };

    beforeEach(() => {
      jest.clearAllMocks();
    });

    describe('list action', () => {
      it('should list active tasks', async () => {
        mockStore.listTasksRaw
          .mockReturnValueOnce({
            rows: [
              {
                id: 'task-1',
                state: 'working',
                created_at: new Date(Date.now() - 120_000).toISOString(),
                workflow_id: 'assistant',
                metadata: { slack_trigger_text: 'analyze this code' },
              },
            ],
          })
          .mockReturnValueOnce({ rows: [] });

        const result = await handleTaskProgressAction(
          { action: 'list' },
          { channelId: 'C123', threadTs: '1234.5678' },
          mockStore
        );

        expect(result.success).toBe(true);
        expect(result.message).toContain('task-1');
        expect(result.message).toContain('working');
        expect(result.message).toContain('analyze this code');
      });

      it('should show no tasks message when empty', async () => {
        mockStore.listTasksRaw.mockReturnValue({ rows: [] });

        const result = await handleTaskProgressAction(
          { action: 'list' },
          { channelId: 'C123' },
          mockStore
        );

        expect(result.success).toBe(true);
        expect(result.message).toContain('No active tasks');
      });

      it('should filter by channel and thread', async () => {
        mockStore.listTasksRaw.mockReturnValue({ rows: [] });

        await handleTaskProgressAction(
          { action: 'list' },
          { channelId: 'C123', threadTs: '1234.5678' },
          mockStore
        );

        expect(mockStore.listTasksRaw).toHaveBeenCalledWith(
          expect.objectContaining({
            metadata: { slack_channel: 'C123', slack_thread_ts: '1234.5678' },
          })
        );
      });
    });

    describe('trace action', () => {
      it('should return error if no task_id', async () => {
        const result = await handleTaskProgressAction({ action: 'trace' }, {}, mockStore);

        expect(result.success).toBe(false);
        expect(result.error).toContain('task_id is required');
      });

      it('should return error if task not found', async () => {
        mockStore.getTask.mockReturnValue(null);

        const result = await handleTaskProgressAction(
          { action: 'trace', task_id: 'unknown' },
          {},
          mockStore
        );

        expect(result.success).toBe(false);
        expect(result.error).toContain('Task not found');
      });

      it('should return basic info when no trace available', async () => {
        mockStore.getTask.mockReturnValue({
          state: 'working',
          created_at: new Date().toISOString(),
          workflow_id: 'assistant',
          metadata: { slack_trigger_text: 'do something' },
        });

        const result = await handleTaskProgressAction(
          { action: 'trace', task_id: 'task-1' },
          {},
          mockStore
        );

        expect(result.success).toBe(true);
        expect(result.message).toContain('No execution trace available');
        expect(result.message).toContain('working');
      });

      it('should return trace tree when trace_id available', async () => {
        mockStore.getTask.mockReturnValue({
          state: 'working',
          created_at: new Date().toISOString(),
          workflow_id: 'assistant',
          metadata: { trace_id: 'abc123', slack_trigger_text: 'analyze code' },
        });

        const result = await handleTaskProgressAction(
          { action: 'trace', task_id: 'task-1' },
          {},
          mockStore
        );

        expect(result.success).toBe(true);
        expect(result.message).toContain('Execution Trace');
        expect(result.message).toContain('mock-trace-tree');
      });

      it('should return trace tree when trace_file available', async () => {
        mockStore.getTask.mockReturnValue({
          state: 'completed',
          created_at: new Date().toISOString(),
          workflow_id: 'code-talk',
          metadata: { trace_file: '/tmp/traces/trace-1.ndjson' },
        });

        const result = await handleTaskProgressAction(
          { action: 'trace', task_id: 'task-2' },
          {},
          mockStore
        );

        expect(result.success).toBe(true);
        expect(result.message).toContain('Execution Trace');
        expect(result.message).toContain('mock-trace-tree');
      });
    });

    describe('unknown action', () => {
      it('should return error for unknown action', async () => {
        const result = await handleTaskProgressAction({ action: 'unknown' as any }, {}, mockStore);

        expect(result.success).toBe(false);
        expect(result.error).toContain('Unknown action');
      });
    });
  });
});
