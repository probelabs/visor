/**
 * Unit tests for schedule-tool.ts — message trigger actions
 * Tests create_trigger, list_triggers, delete_trigger, update_trigger
 */
import {
  handleScheduleAction,
  ScheduleToolArgs,
  ScheduleToolContext,
} from '../../../src/scheduler/schedule-tool';
import { ScheduleStore } from '../../../src/scheduler/schedule-store';

// Mock the schedule store
jest.mock('../../../src/scheduler/schedule-store', () => {
  const mockStore = {
    isInitialized: jest.fn().mockReturnValue(true),
    initialize: jest.fn().mockResolvedValue(undefined),
    // Schedule methods (stubs)
    createAsync: jest.fn(),
    getByCreatorAsync: jest.fn().mockResolvedValue([]),
    updateAsync: jest.fn(),
    deleteAsync: jest.fn().mockResolvedValue(true),
    // Trigger methods
    createTriggerAsync: jest.fn(),
    getTriggerAsync: jest.fn(),
    updateTriggerAsync: jest.fn(),
    deleteTriggerAsync: jest.fn().mockResolvedValue(true),
    getTriggersByCreatorAsync: jest.fn().mockResolvedValue([]),
    getActiveTriggersAsync: jest.fn().mockResolvedValue([]),
  };

  return {
    ScheduleStore: {
      getInstance: jest.fn().mockReturnValue(mockStore),
      setTriggersChangedCallback: jest.fn(),
    },
  };
});

// Mock the schedule parser
jest.mock('../../../src/scheduler/schedule-parser', () => ({
  isValidCronExpression: jest.fn().mockReturnValue(true),
  getNextRunTime: jest.fn().mockReturnValue(new Date(Date.now() + 3600000)),
}));

// Mock the scheduler
jest.mock('../../../src/scheduler/scheduler', () => ({
  getScheduler: jest.fn().mockReturnValue(null),
}));

// Mock logger
jest.mock('../../../src/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

function makeContext(overrides: Partial<ScheduleToolContext> = {}): ScheduleToolContext {
  return {
    userId: 'U123',
    userName: 'testuser',
    contextType: 'slack:U123',
    timezone: 'America/New_York',
    availableWorkflows: ['handle-cicd', 'security-scan', 'daily-report'],
    ...overrides,
  };
}

describe('Schedule Tool — Message Trigger Actions', () => {
  let mockStore: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockStore = (ScheduleStore.getInstance as jest.Mock)();
    mockStore.createTriggerAsync.mockImplementation((data: any) =>
      Promise.resolve({
        id: 'trigger-uuid-1234',
        createdAt: Date.now(),
        ...data,
      })
    );
  });

  describe('create_trigger', () => {
    it('should create a trigger with channels and contains filter', async () => {
      const args: ScheduleToolArgs = {
        action: 'create_trigger',
        workflow: 'handle-cicd',
        trigger_channels: ['C0CICD'],
        trigger_contains: ['failed', 'error'],
        trigger_description: 'Monitor CI/CD failures',
      };

      const result = await handleScheduleAction(args, makeContext());

      expect(result.success).toBe(true);
      expect(result.message).toContain('Message trigger created');
      expect(result.message).toContain('handle-cicd');
      expect(mockStore.createTriggerAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          creatorId: 'U123',
          workflow: 'handle-cicd',
          channels: ['C0CICD'],
          contains: ['failed', 'error'],
          fromBots: false,
          threads: 'any',
          status: 'active',
          enabled: true,
        })
      );
    });

    it('should create a trigger with regex match', async () => {
      const args: ScheduleToolArgs = {
        action: 'create_trigger',
        workflow: 'security-scan',
        trigger_channels: ['CSEC'],
        trigger_match: 'CVE-\\d{4}-\\d+',
      };

      const result = await handleScheduleAction(args, makeContext());

      expect(result.success).toBe(true);
      expect(mockStore.createTriggerAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          workflow: 'security-scan',
          matchPattern: 'CVE-\\d{4}-\\d+',
        })
      );
    });

    it('should create a trigger with from_bots enabled', async () => {
      const args: ScheduleToolArgs = {
        action: 'create_trigger',
        workflow: 'handle-cicd',
        trigger_channels: ['C0CICD'],
        trigger_contains: ['deploy'],
        trigger_from_bots: true,
      };

      const result = await handleScheduleAction(args, makeContext());

      expect(result.success).toBe(true);
      expect(mockStore.createTriggerAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          fromBots: true,
        })
      );
    });

    it('should create a trigger with thread scope', async () => {
      const args: ScheduleToolArgs = {
        action: 'create_trigger',
        workflow: 'handle-cicd',
        trigger_channels: ['C0CICD'],
        trigger_contains: ['alert'],
        trigger_threads: 'root_only',
      };

      const result = await handleScheduleAction(args, makeContext());

      expect(result.success).toBe(true);
      expect(mockStore.createTriggerAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          threads: 'root_only',
        })
      );
    });

    it('should fail when workflow is missing', async () => {
      const args: ScheduleToolArgs = {
        action: 'create_trigger',
        trigger_channels: ['C0CICD'],
        trigger_contains: ['failed'],
      };

      const result = await handleScheduleAction(args, makeContext());

      expect(result.success).toBe(false);
      expect(result.message).toContain('Missing workflow');
    });

    it('should fail when workflow does not exist', async () => {
      const args: ScheduleToolArgs = {
        action: 'create_trigger',
        workflow: 'nonexistent-workflow',
        trigger_channels: ['C0CICD'],
        trigger_contains: ['failed'],
      };

      const result = await handleScheduleAction(args, makeContext());

      expect(result.success).toBe(false);
      expect(result.message).toContain('not found');
    });

    it('should fail when no filters are specified', async () => {
      const args: ScheduleToolArgs = {
        action: 'create_trigger',
        workflow: 'handle-cicd',
      };

      const result = await handleScheduleAction(args, makeContext());

      expect(result.success).toBe(false);
      expect(result.message).toContain('Missing trigger filters');
    });

    it('should check permissions for denied workflows', async () => {
      const args: ScheduleToolArgs = {
        action: 'create_trigger',
        workflow: 'handle-cicd',
        trigger_channels: ['C0CICD'],
        trigger_contains: ['failed'],
      };

      const context = makeContext({
        permissions: {
          deniedWorkflows: ['handle-*'],
        },
      });

      const result = await handleScheduleAction(args, context);

      expect(result.success).toBe(false);
      expect(result.message).toContain('Permission denied');
    });

    it('should pass workflow inputs', async () => {
      const args: ScheduleToolArgs = {
        action: 'create_trigger',
        workflow: 'handle-cicd',
        trigger_channels: ['C0CICD'],
        trigger_contains: ['failed'],
        workflow_inputs: { severity: 'high' },
      };

      const result = await handleScheduleAction(args, makeContext());

      expect(result.success).toBe(true);
      expect(mockStore.createTriggerAsync).toHaveBeenCalledWith(
        expect.objectContaining({
          inputs: { severity: 'high' },
        })
      );
    });
  });

  describe('list_triggers', () => {
    it('should return empty list message when no triggers exist', async () => {
      mockStore.getTriggersByCreatorAsync.mockResolvedValue([]);

      const args: ScheduleToolArgs = { action: 'list_triggers' };
      const result = await handleScheduleAction(args, makeContext());

      expect(result.success).toBe(true);
      expect(result.message).toContain("don't have any message triggers");
    });

    it('should list active triggers', async () => {
      mockStore.getTriggersByCreatorAsync.mockResolvedValue([
        {
          id: 'trigger-1-full-uuid',
          creatorId: 'U123',
          workflow: 'handle-cicd',
          channels: ['C0CICD'],
          contains: ['failed'],
          fromBots: false,
          threads: 'any',
          status: 'active',
          enabled: true,
          createdAt: Date.now(),
        },
        {
          id: 'trigger-2-full-uuid',
          creatorId: 'U123',
          workflow: 'security-scan',
          channels: ['CSEC'],
          matchPattern: 'CVE-\\d+',
          fromBots: false,
          threads: 'any',
          status: 'active',
          enabled: false,
          createdAt: Date.now(),
        },
      ]);

      const args: ScheduleToolArgs = { action: 'list_triggers' };
      const result = await handleScheduleAction(args, makeContext());

      expect(result.success).toBe(true);
      expect(result.message).toContain('handle-cicd');
      expect(result.message).toContain('security-scan');
      expect(result.message).toContain('(disabled)');
    });

    it('should filter out deleted triggers', async () => {
      mockStore.getTriggersByCreatorAsync.mockResolvedValue([
        {
          id: 'trigger-active-uuid',
          creatorId: 'U123',
          workflow: 'handle-cicd',
          channels: ['C0CICD'],
          fromBots: false,
          threads: 'any',
          status: 'active',
          enabled: true,
          createdAt: Date.now(),
        },
        {
          id: 'trigger-deleted-uuid',
          creatorId: 'U123',
          workflow: 'old-workflow',
          channels: ['COLD'],
          fromBots: false,
          threads: 'any',
          status: 'deleted',
          enabled: true,
          createdAt: Date.now(),
        },
      ]);

      const args: ScheduleToolArgs = { action: 'list_triggers' };
      const result = await handleScheduleAction(args, makeContext());

      expect(result.success).toBe(true);
      expect(result.message).toContain('handle-cicd');
      expect(result.message).not.toContain('old-workflow');
    });
  });

  describe('delete_trigger', () => {
    it('should delete a trigger by full ID', async () => {
      mockStore.getTriggersByCreatorAsync.mockResolvedValue([
        {
          id: 'trigger-1-full-uuid',
          creatorId: 'U123',
          workflow: 'handle-cicd',
          channels: ['C0CICD'],
          fromBots: false,
          threads: 'any',
          status: 'active',
          enabled: true,
          createdAt: Date.now(),
        },
      ]);

      const args: ScheduleToolArgs = {
        action: 'delete_trigger',
        trigger_id: 'trigger-1-full-uuid',
      };

      const result = await handleScheduleAction(args, makeContext());

      expect(result.success).toBe(true);
      expect(result.message).toContain('Trigger deleted');
      expect(mockStore.deleteTriggerAsync).toHaveBeenCalledWith('trigger-1-full-uuid');
    });

    it('should delete a trigger by partial ID', async () => {
      mockStore.getTriggersByCreatorAsync.mockResolvedValue([
        {
          id: 'trigger-1-full-uuid',
          creatorId: 'U123',
          workflow: 'handle-cicd',
          channels: ['C0CICD'],
          fromBots: false,
          threads: 'any',
          status: 'active',
          enabled: true,
          createdAt: Date.now(),
        },
      ]);

      const args: ScheduleToolArgs = {
        action: 'delete_trigger',
        trigger_id: 'trigger-1',
      };

      const result = await handleScheduleAction(args, makeContext());

      expect(result.success).toBe(true);
      expect(mockStore.deleteTriggerAsync).toHaveBeenCalledWith('trigger-1-full-uuid');
    });

    it('should fail when trigger_id is missing', async () => {
      const args: ScheduleToolArgs = { action: 'delete_trigger' };
      const result = await handleScheduleAction(args, makeContext());

      expect(result.success).toBe(false);
      expect(result.message).toContain('Missing trigger ID');
    });

    it('should fail when trigger is not found', async () => {
      mockStore.getTriggersByCreatorAsync.mockResolvedValue([]);

      const args: ScheduleToolArgs = {
        action: 'delete_trigger',
        trigger_id: 'nonexistent',
      };

      const result = await handleScheduleAction(args, makeContext());

      expect(result.success).toBe(false);
      expect(result.message).toContain('Trigger not found');
    });

    it("should not allow deleting another user's trigger", async () => {
      mockStore.getTriggersByCreatorAsync.mockResolvedValue([]); // empty for U123

      const args: ScheduleToolArgs = {
        action: 'delete_trigger',
        trigger_id: 'other-user-trigger',
      };

      const result = await handleScheduleAction(args, makeContext());

      expect(result.success).toBe(false);
      expect(result.message).toContain('Trigger not found');
    });
  });

  describe('update_trigger', () => {
    it('should disable a trigger', async () => {
      mockStore.getTriggersByCreatorAsync.mockResolvedValue([
        {
          id: 'trigger-1-full-uuid',
          creatorId: 'U123',
          workflow: 'handle-cicd',
          channels: ['C0CICD'],
          fromBots: false,
          threads: 'any',
          status: 'active',
          enabled: true,
          createdAt: Date.now(),
        },
      ]);
      mockStore.updateTriggerAsync.mockResolvedValue({
        id: 'trigger-1-full-uuid',
        enabled: false,
      });

      const args: ScheduleToolArgs = {
        action: 'update_trigger',
        trigger_id: 'trigger-1-full-uuid',
        trigger_enabled: false,
      };

      const result = await handleScheduleAction(args, makeContext());

      expect(result.success).toBe(true);
      expect(result.message).toContain('disabled');
      expect(mockStore.updateTriggerAsync).toHaveBeenCalledWith('trigger-1-full-uuid', {
        enabled: false,
      });
    });

    it('should enable a trigger', async () => {
      mockStore.getTriggersByCreatorAsync.mockResolvedValue([
        {
          id: 'trigger-1-full-uuid',
          creatorId: 'U123',
          workflow: 'handle-cicd',
          channels: ['C0CICD'],
          fromBots: false,
          threads: 'any',
          status: 'active',
          enabled: false,
          createdAt: Date.now(),
        },
      ]);
      mockStore.updateTriggerAsync.mockResolvedValue({
        id: 'trigger-1-full-uuid',
        enabled: true,
      });

      const args: ScheduleToolArgs = {
        action: 'update_trigger',
        trigger_id: 'trigger-1-full-uuid',
        trigger_enabled: true,
      };

      const result = await handleScheduleAction(args, makeContext());

      expect(result.success).toBe(true);
      expect(result.message).toContain('enabled');
    });

    it('should fail when trigger_id is missing', async () => {
      const args: ScheduleToolArgs = {
        action: 'update_trigger',
        trigger_enabled: false,
      };

      const result = await handleScheduleAction(args, makeContext());

      expect(result.success).toBe(false);
      expect(result.message).toContain('Missing trigger ID');
    });

    it('should fail when trigger is not found', async () => {
      mockStore.getTriggersByCreatorAsync.mockResolvedValue([]);

      const args: ScheduleToolArgs = {
        action: 'update_trigger',
        trigger_id: 'nonexistent',
        trigger_enabled: false,
      };

      const result = await handleScheduleAction(args, makeContext());

      expect(result.success).toBe(false);
      expect(result.message).toContain('Trigger not found');
    });
  });
});
