/**
 * Unit tests for schedule-tool.ts
 * Tests permission checking, schedule creation, and tool context building
 */
import {
  handleScheduleAction,
  buildScheduleToolContext,
  ScheduleToolArgs,
  ScheduleToolContext,
} from '../../../src/scheduler/schedule-tool';
import { ScheduleStore } from '../../../src/scheduler/schedule-store';

// Mock the schedule store
jest.mock('../../../src/scheduler/schedule-store', () => {
  const mockStore = {
    isInitialized: jest.fn().mockReturnValue(true),
    initialize: jest.fn().mockResolvedValue(undefined),
    create: jest.fn(),
    get: jest.fn(),
    getByCreator: jest.fn().mockReturnValue([]),
    update: jest.fn(),
    delete: jest.fn(),
  };

  return {
    ScheduleStore: {
      getInstance: jest.fn().mockReturnValue(mockStore),
    },
  };
});

// Mock the schedule parser
jest.mock('../../../src/scheduler/schedule-parser', () => ({
  parseScheduleExpression: jest.fn().mockReturnValue({
    type: 'one-time',
    runAt: new Date(Date.now() + 3600000), // 1 hour from now
    cronExpression: null,
  }),
  getNextRunTime: jest.fn().mockReturnValue(new Date(Date.now() + 3600000)),
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

describe('Schedule Tool Permissions', () => {
  let mockStore: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockStore = (ScheduleStore.getInstance as jest.Mock)();
    mockStore.create.mockImplementation((data: any) => ({
      id: 'test-schedule-id',
      ...data,
      status: 'active',
      createdAt: Date.now(),
    }));
  });

  describe('Personal schedule permissions', () => {
    it('should allow personal schedule when allow_personal is true', async () => {
      const args: ScheduleToolArgs = {
        action: 'create',
        workflow: 'daily-report',
        expression: 'in 1 hour',
      };

      const context: ScheduleToolContext = {
        userId: 'user123',
        contextType: 'cli',
        scheduleType: 'personal',
        permissions: {
          allowPersonal: true,
        },
      };

      const result = await handleScheduleAction(args, context);
      expect(result.success).toBe(true);
      expect(mockStore.create).toHaveBeenCalled();
    });

    it('should deny personal schedule when allow_personal is false', async () => {
      const args: ScheduleToolArgs = {
        action: 'create',
        workflow: 'daily-report',
        expression: 'in 1 hour',
      };

      const context: ScheduleToolContext = {
        userId: 'user123',
        contextType: 'cli',
        scheduleType: 'personal',
        permissions: {
          allowPersonal: false,
        },
      };

      const result = await handleScheduleAction(args, context);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Personal schedules are not allowed');
      expect(mockStore.create).not.toHaveBeenCalled();
    });

    it('should allow personal schedule when permissions not specified', async () => {
      const args: ScheduleToolArgs = {
        action: 'create',
        workflow: 'daily-report',
        expression: 'in 1 hour',
      };

      const context: ScheduleToolContext = {
        userId: 'user123',
        contextType: 'cli',
        scheduleType: 'personal',
        // No permissions specified
      };

      const result = await handleScheduleAction(args, context);
      expect(result.success).toBe(true);
      expect(mockStore.create).toHaveBeenCalled();
    });
  });

  describe('Channel schedule permissions', () => {
    it('should allow channel schedule when allow_channel is true', async () => {
      const args: ScheduleToolArgs = {
        action: 'create',
        workflow: 'team-report',
        expression: 'every Monday at 9am',
        output_type: 'slack',
        output_target: '#general',
      };

      const context: ScheduleToolContext = {
        userId: 'user123',
        contextType: 'slack:user123',
        scheduleType: 'channel',
        permissions: {
          allowChannel: true,
        },
      };

      const result = await handleScheduleAction(args, context);
      expect(result.success).toBe(true);
    });

    it('should deny channel schedule when allow_channel is false', async () => {
      const args: ScheduleToolArgs = {
        action: 'create',
        workflow: 'team-report',
        expression: 'every Monday at 9am',
        output_type: 'slack',
        output_target: '#general',
      };

      const context: ScheduleToolContext = {
        userId: 'user123',
        contextType: 'slack:user123',
        scheduleType: 'channel',
        permissions: {
          allowChannel: false,
        },
      };

      const result = await handleScheduleAction(args, context);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Channel schedules are not allowed');
    });
  });

  describe('DM schedule permissions', () => {
    it('should allow DM schedule when allow_dm is true', async () => {
      const args: ScheduleToolArgs = {
        action: 'create',
        workflow: 'reminder',
        expression: 'tomorrow at 9am',
        output_type: 'slack',
        output_target: '@otheruser',
      };

      const context: ScheduleToolContext = {
        userId: 'user123',
        contextType: 'slack:user123',
        scheduleType: 'dm',
        permissions: {
          allowDm: true,
        },
      };

      const result = await handleScheduleAction(args, context);
      expect(result.success).toBe(true);
    });

    it('should deny DM schedule when allow_dm is false', async () => {
      const args: ScheduleToolArgs = {
        action: 'create',
        workflow: 'reminder',
        expression: 'tomorrow at 9am',
        output_type: 'slack',
        output_target: '@otheruser',
      };

      const context: ScheduleToolContext = {
        userId: 'user123',
        contextType: 'slack:user123',
        scheduleType: 'dm',
        permissions: {
          allowDm: false,
        },
      };

      const result = await handleScheduleAction(args, context);
      expect(result.success).toBe(false);
      expect(result.error).toContain('DM schedules are not allowed');
    });
  });

  describe('Workflow pattern permissions', () => {
    it('should allow workflow matching allowed pattern', async () => {
      const args: ScheduleToolArgs = {
        action: 'create',
        workflow: 'report-daily',
        expression: 'every day at 9am',
      };

      const context: ScheduleToolContext = {
        userId: 'user123',
        contextType: 'cli',
        scheduleType: 'personal',
        permissions: {
          allowedWorkflows: ['report-*', 'status-*'],
        },
      };

      const result = await handleScheduleAction(args, context);
      expect(result.success).toBe(true);
    });

    it('should deny workflow not matching any allowed pattern', async () => {
      const args: ScheduleToolArgs = {
        action: 'create',
        workflow: 'security-scan',
        expression: 'every day at 9am',
      };

      const context: ScheduleToolContext = {
        userId: 'user123',
        contextType: 'cli',
        scheduleType: 'personal',
        permissions: {
          allowedWorkflows: ['report-*', 'status-*'],
        },
      };

      const result = await handleScheduleAction(args, context);
      expect(result.success).toBe(false);
      expect(result.error).toContain('does not match any allowed patterns');
    });

    it('should deny workflow matching denied pattern', async () => {
      const args: ScheduleToolArgs = {
        action: 'create',
        workflow: 'admin-reset',
        expression: 'in 1 hour',
      };

      const context: ScheduleToolContext = {
        userId: 'user123',
        contextType: 'cli',
        scheduleType: 'personal',
        permissions: {
          deniedWorkflows: ['admin-*', 'dangerous-*'],
        },
      };

      const result = await handleScheduleAction(args, context);
      expect(result.success).toBe(false);
      expect(result.error).toContain('matches denied pattern');
    });

    it('should deny workflow matching denied pattern even if it matches allowed pattern', async () => {
      const args: ScheduleToolArgs = {
        action: 'create',
        workflow: 'admin-report',
        expression: 'in 1 hour',
      };

      const context: ScheduleToolContext = {
        userId: 'user123',
        contextType: 'cli',
        scheduleType: 'personal',
        permissions: {
          allowedWorkflows: ['*-report'], // Matches admin-report
          deniedWorkflows: ['admin-*'], // Also matches admin-report
        },
      };

      const result = await handleScheduleAction(args, context);
      expect(result.success).toBe(false);
      expect(result.error).toContain('matches denied pattern');
    });

    it('should allow any workflow when no patterns specified', async () => {
      const args: ScheduleToolArgs = {
        action: 'create',
        workflow: 'any-workflow-name',
        expression: 'in 1 hour',
      };

      const context: ScheduleToolContext = {
        userId: 'user123',
        contextType: 'cli',
        scheduleType: 'personal',
        permissions: {
          allowPersonal: true,
          // No workflow patterns
        },
      };

      const result = await handleScheduleAction(args, context);
      expect(result.success).toBe(true);
    });

    it('should handle ? wildcard in patterns', async () => {
      const args: ScheduleToolArgs = {
        action: 'create',
        workflow: 'report-v1',
        expression: 'in 1 hour',
      };

      const context: ScheduleToolContext = {
        userId: 'user123',
        contextType: 'cli',
        scheduleType: 'personal',
        permissions: {
          allowedWorkflows: ['report-v?'], // Matches single character after v
        },
      };

      const result = await handleScheduleAction(args, context);
      expect(result.success).toBe(true);

      // Should not match if more than one character
      const args2: ScheduleToolArgs = {
        action: 'create',
        workflow: 'report-v10',
        expression: 'in 1 hour',
      };

      const result2 = await handleScheduleAction(args2, context);
      expect(result2.success).toBe(false);
    });
  });

  describe('Combined permissions', () => {
    it('should check both schedule type and workflow permissions', async () => {
      const args: ScheduleToolArgs = {
        action: 'create',
        workflow: 'report-daily',
        expression: 'every day at 9am',
      };

      const context: ScheduleToolContext = {
        userId: 'user123',
        contextType: 'cli',
        scheduleType: 'personal',
        permissions: {
          allowPersonal: true,
          allowChannel: false,
          allowedWorkflows: ['report-*'],
        },
      };

      // Should succeed - personal allowed and workflow matches
      const result = await handleScheduleAction(args, context);
      expect(result.success).toBe(true);
    });

    it('should fail if schedule type denied even if workflow allowed', async () => {
      const args: ScheduleToolArgs = {
        action: 'create',
        workflow: 'report-daily',
        expression: 'every day at 9am',
        output_type: 'slack',
        output_target: '#general',
      };

      const context: ScheduleToolContext = {
        userId: 'user123',
        contextType: 'slack:user123',
        scheduleType: 'channel',
        permissions: {
          allowPersonal: true,
          allowChannel: false, // Channel not allowed
          allowedWorkflows: ['report-*'], // Workflow matches
        },
      };

      const result = await handleScheduleAction(args, context);
      expect(result.success).toBe(false);
      expect(result.error).toContain('Channel schedules are not allowed');
    });
  });
});

describe('buildScheduleToolContext', () => {
  describe('Slack context', () => {
    it('should build context from Slack source', () => {
      const context = buildScheduleToolContext(
        {
          slackContext: {
            userId: 'U12345',
            userName: 'testuser',
            timezone: 'America/New_York',
            channelType: 'channel',
          },
        },
        ['workflow1', 'workflow2'],
        { allowChannel: true }
      );

      expect(context.userId).toBe('U12345');
      expect(context.userName).toBe('testuser');
      expect(context.contextType).toBe('slack:U12345');
      expect(context.timezone).toBe('America/New_York');
      expect(context.availableWorkflows).toEqual(['workflow1', 'workflow2']);
      expect(context.scheduleType).toBe('channel');
      expect(context.permissions).toEqual({ allowChannel: true });
    });

    it('should determine schedule type from output target', () => {
      // Channel output
      const channelContext = buildScheduleToolContext(
        {
          slackContext: {
            userId: 'U12345',
            channelType: 'dm',
          },
        },
        undefined,
        undefined,
        { outputType: 'slack', outputTarget: '#general' }
      );
      expect(channelContext.scheduleType).toBe('channel');

      // User DM output
      const dmContext = buildScheduleToolContext(
        {
          slackContext: {
            userId: 'U12345',
            channelType: 'dm',
          },
        },
        undefined,
        undefined,
        { outputType: 'slack', outputTarget: '@user' }
      );
      expect(dmContext.scheduleType).toBe('dm');
    });

    it('should use channel type when no output specified', () => {
      const context = buildScheduleToolContext({
        slackContext: {
          userId: 'U12345',
          channelType: 'channel',
        },
      });

      expect(context.scheduleType).toBe('channel');
    });
  });

  describe('GitHub context', () => {
    it('should build context from GitHub source', () => {
      const context = buildScheduleToolContext(
        {
          githubContext: {
            login: 'octocat',
          },
        },
        ['workflow1']
      );

      expect(context.userId).toBe('octocat');
      expect(context.contextType).toBe('github:octocat');
      expect(context.timezone).toBe('UTC');
      expect(context.scheduleType).toBe('personal');
    });
  });

  describe('CLI context', () => {
    it('should build context from CLI source', () => {
      const originalUser = process.env.USER;
      process.env.USER = 'testuser';

      const context = buildScheduleToolContext({
        cliContext: {},
      });

      expect(context.userId).toBe('testuser');
      expect(context.contextType).toBe('cli');
      expect(context.scheduleType).toBe('personal');

      process.env.USER = originalUser;
    });

    it('should use explicit userId when provided', () => {
      const context = buildScheduleToolContext({
        cliContext: {
          userId: 'custom-user',
        },
      });

      expect(context.userId).toBe('custom-user');
    });
  });

  describe('Priority order', () => {
    it('should prefer Slack over GitHub over CLI', () => {
      const context = buildScheduleToolContext({
        slackContext: { userId: 'slack-user' },
        githubContext: { login: 'github-user' },
        cliContext: { userId: 'cli-user' },
      });

      expect(context.userId).toBe('slack-user');
      expect(context.contextType).toBe('slack:slack-user');
    });

    it('should use GitHub when Slack not available', () => {
      const context = buildScheduleToolContext({
        githubContext: { login: 'github-user' },
        cliContext: { userId: 'cli-user' },
      });

      expect(context.userId).toBe('github-user');
      expect(context.contextType).toBe('github:github-user');
    });
  });
});

describe('Schedule Tool Actions', () => {
  let mockStore: any;

  beforeEach(() => {
    jest.clearAllMocks();
    mockStore = (ScheduleStore.getInstance as jest.Mock)();
    mockStore.create.mockImplementation((data: any) => ({
      id: 'test-schedule-id',
      ...data,
      status: 'active',
      createdAt: Date.now(),
    }));
  });

  describe('list action', () => {
    it('should list user schedules', async () => {
      mockStore.getByCreator.mockReturnValue([
        {
          id: 'sched-1',
          workflow: 'daily-report',
          originalExpression: 'every day at 9am',
          status: 'active',
          isRecurring: true,
        },
        {
          id: 'sched-2',
          workflow: 'weekly-summary',
          originalExpression: 'every Monday',
          status: 'active',
          isRecurring: true,
        },
      ]);

      const result = await handleScheduleAction(
        { action: 'list' },
        { userId: 'user123', contextType: 'cli' }
      );

      expect(result.success).toBe(true);
      expect(result.schedules).toHaveLength(2);
      expect(mockStore.getByCreator).toHaveBeenCalledWith('user123');
    });

    it('should return empty message when no schedules', async () => {
      mockStore.getByCreator.mockReturnValue([]);

      const result = await handleScheduleAction(
        { action: 'list' },
        { userId: 'user123', contextType: 'cli' }
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain("don't have any active schedules");
    });
  });

  describe('cancel action', () => {
    it('should cancel owned schedule', async () => {
      // Now we search in user's own schedules first via getByCreator
      mockStore.getByCreator.mockReturnValue([
        {
          id: 'sched-1',
          creatorId: 'user123',
          workflow: 'daily-report',
        },
      ]);

      const result = await handleScheduleAction(
        { action: 'cancel', schedule_id: 'sched-1' },
        { userId: 'user123', contextType: 'cli' }
      );

      expect(result.success).toBe(true);
      expect(mockStore.delete).toHaveBeenCalledWith('sched-1');
    });

    it('should reject canceling other user schedule', async () => {
      // Other user's schedule won't be in this user's getByCreator results
      mockStore.getByCreator.mockReturnValue([]);

      const result = await handleScheduleAction(
        { action: 'cancel', schedule_id: 'sched-1' },
        { userId: 'user123', contextType: 'cli' }
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Could not find schedule');
      expect(mockStore.delete).not.toHaveBeenCalled();
    });

    it('should handle partial ID match', async () => {
      mockStore.get.mockReturnValue(undefined);
      mockStore.getByCreator.mockReturnValue([{ id: 'abcd1234-full-id', creatorId: 'user123' }]);

      const result = await handleScheduleAction(
        { action: 'cancel', schedule_id: 'abcd1234' },
        { userId: 'user123', contextType: 'cli' }
      );

      expect(result.success).toBe(true);
    });
  });

  describe('pause/resume actions', () => {
    it('should pause schedule', async () => {
      // Now we search in user's own schedules first via getByCreator
      mockStore.getByCreator.mockReturnValue([
        {
          id: 'sched-1',
          creatorId: 'user123',
          workflow: 'daily-report',
          status: 'active',
        },
      ]);
      mockStore.update.mockReturnValue({
        id: 'sched-1',
        creatorId: 'user123',
        workflow: 'daily-report',
        status: 'paused',
      });

      const result = await handleScheduleAction(
        { action: 'pause', schedule_id: 'sched-1' },
        { userId: 'user123', contextType: 'cli' }
      );

      expect(result.success).toBe(true);
      expect(mockStore.update).toHaveBeenCalledWith('sched-1', { status: 'paused' });
    });

    it('should resume schedule', async () => {
      // Now we search in user's own schedules first via getByCreator
      mockStore.getByCreator.mockReturnValue([
        {
          id: 'sched-1',
          creatorId: 'user123',
          workflow: 'daily-report',
          status: 'paused',
        },
      ]);
      mockStore.update.mockReturnValue({
        id: 'sched-1',
        creatorId: 'user123',
        workflow: 'daily-report',
        status: 'active',
      });

      const result = await handleScheduleAction(
        { action: 'resume', schedule_id: 'sched-1' },
        { userId: 'user123', contextType: 'cli' }
      );

      expect(result.success).toBe(true);
      expect(mockStore.update).toHaveBeenCalledWith('sched-1', { status: 'active' });
    });
  });

  describe('create action validation', () => {
    it('should require expression', async () => {
      const result = await handleScheduleAction(
        { action: 'create', workflow: 'test' },
        { userId: 'user123', contextType: 'cli' }
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('specify when');
    });

    it('should require workflow', async () => {
      const result = await handleScheduleAction(
        { action: 'create', expression: 'in 1 hour' },
        { userId: 'user123', contextType: 'cli' }
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('specify which workflow');
    });

    it('should validate workflow exists when availableWorkflows provided', async () => {
      const result = await handleScheduleAction(
        { action: 'create', workflow: 'nonexistent', expression: 'in 1 hour' },
        {
          userId: 'user123',
          contextType: 'cli',
          availableWorkflows: ['workflow1', 'workflow2'],
        }
      );

      expect(result.success).toBe(false);
      // Check that error mentions available workflows
      expect(result.error).toContain('Available workflows');
    });
  });
});
