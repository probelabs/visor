// Teams webhook runner tests for message filtering.
// Uses mock botbuilder SDK for Bot Framework API calls.

// Mock botbuilder before import
jest.mock('botbuilder', () => {
  return {
    CloudAdapter: jest.fn().mockImplementation(() => ({
      continueConversationAsync: jest.fn(),
      onTurnError: null,
      process: jest.fn(),
    })),
    ConfigurationBotFrameworkAuthentication: jest.fn(),
    TurnContext: {
      getConversationReference: jest.fn(activity => ({
        activityId: activity.id,
        bot: { id: 'bot-id', name: 'Bot' },
        channelId: 'msteams',
        conversation: activity.conversation || { id: 'conv-1' },
        serviceUrl: 'https://smba.trafficmanager.net/teams/',
      })),
    },
    MessageFactory: {
      text: jest.fn(t => ({ type: 'message', text: t })),
    },
    ActivityTypes: { Message: 'message' },
  };
});

import { TeamsWebhookRunner } from '../../src/teams/webhook-runner';
import { StateMachineExecutionEngine } from '../../src/state-machine-execution-engine';
import type { VisorConfig } from '../../src/types/config';
import type { TeamsMessageInfo } from '../../src/teams/adapter';

const baseCfg: VisorConfig = {
  version: '1',
  output: { pr_comment: { format: 'markdown', group_by: 'check', collapse: true } },
  checks: { reply: { type: 'ai' as any, on: ['manual'] } },
} as any;

function mkMsg(overrides: Partial<TeamsMessageInfo> = {}): TeamsMessageInfo {
  return {
    activityId: 'act.test1',
    conversationId: 'conv-1',
    conversationType: 'personal',
    from: {
      id: 'user-1',
      name: 'Test User',
    },
    text: 'Hello bot',
    timestamp: '2024-01-01T00:00:00.000Z',
    conversationReference: {
      activityId: 'act.test1',
      bot: { id: 'bot-id', name: 'Bot' },
      channelId: 'msteams',
      conversation: { id: 'conv-1' },
      serviceUrl: 'https://smba.trafficmanager.net/teams/',
    } as any,
    ...overrides,
  };
}

describe('TeamsWebhookRunner message gating', () => {
  test('text messages are accepted and dispatched', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new TeamsWebhookRunner(engine, baseCfg, {
      appId: 'test-app-id',
      appPassword: 'test-app-password',
    });

    const spy = jest
      .spyOn(StateMachineExecutionEngine.prototype, 'executeChecks')
      .mockResolvedValue({
        results: { default: [] },
        statistics: {
          totalChecks: 1,
          checksByGroup: {},
          issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
        },
      } as any);

    await (runner as any).handleMessage(mkMsg());

    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  test('skips messages without text content', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new TeamsWebhookRunner(engine, baseCfg, {
      appId: 'test-app-id',
      appPassword: 'test-app-password',
    });

    const spy = jest
      .spyOn(StateMachineExecutionEngine.prototype, 'executeChecks')
      .mockResolvedValue({} as any);

    await (runner as any).handleMessage(mkMsg({ text: '' }));

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('user allowlist filters messages', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new TeamsWebhookRunner(engine, baseCfg, {
      appId: 'test-app-id',
      appPassword: 'test-app-password',
      userAllowlist: ['user-1', 'user-2'],
    });

    const spy = jest
      .spyOn(StateMachineExecutionEngine.prototype, 'executeChecks')
      .mockResolvedValue({
        results: { default: [] },
        statistics: {
          totalChecks: 1,
          checksByGroup: {},
          issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
        },
      } as any);

    // Allowed user
    await (runner as any).handleMessage(
      mkMsg({
        activityId: 'act.allowed',
        from: { id: 'user-1', name: 'Allowed User' },
      })
    );
    expect(spy).toHaveBeenCalledTimes(1);

    // Not in allowlist
    await (runner as any).handleMessage(
      mkMsg({
        activityId: 'act.blocked',
        from: { id: 'user-blocked', name: 'Blocked User' },
      })
    );
    expect(spy).toHaveBeenCalledTimes(1); // Still 1

    spy.mockRestore();
  });

  test('deduplication prevents processing same activity twice', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new TeamsWebhookRunner(engine, baseCfg, {
      appId: 'test-app-id',
      appPassword: 'test-app-password',
    });

    const spy = jest
      .spyOn(StateMachineExecutionEngine.prototype, 'executeChecks')
      .mockResolvedValue({
        results: { default: [] },
        statistics: {
          totalChecks: 1,
          checksByGroup: {},
          issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
        },
      } as any);

    const msg = mkMsg({ activityId: 'act.dedup1' });

    await (runner as any).handleMessage(msg);
    await (runner as any).handleMessage(msg);

    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  test('skips processing when no checks configured', async () => {
    const emptyCfg: VisorConfig = {
      version: '1',
      output: { pr_comment: { format: 'markdown', group_by: 'check', collapse: true } },
      checks: {},
    } as any;

    const engine = new StateMachineExecutionEngine();
    const runner = new TeamsWebhookRunner(engine, emptyCfg, {
      appId: 'test-app-id',
      appPassword: 'test-app-password',
    });

    const spy = jest
      .spyOn(StateMachineExecutionEngine.prototype, 'executeChecks')
      .mockResolvedValue({} as any);

    await (runner as any).handleMessage(mkMsg({ activityId: 'act.empty' }));

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('skips bot own messages', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new TeamsWebhookRunner(engine, baseCfg, {
      appId: 'test-app-id',
      appPassword: 'test-app-password',
    });

    const spy = jest
      .spyOn(StateMachineExecutionEngine.prototype, 'executeChecks')
      .mockResolvedValue({} as any);

    // from.id matches appId => bot's own message
    await (runner as any).handleMessage(
      mkMsg({
        activityId: 'act.bot1',
        from: { id: 'test-app-id', name: 'Bot' },
      })
    );

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('handles engine execution errors gracefully', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new TeamsWebhookRunner(engine, baseCfg, {
      appId: 'test-app-id',
      appPassword: 'test-app-password',
    });

    jest
      .spyOn(StateMachineExecutionEngine.prototype, 'executeChecks')
      .mockRejectedValue(new Error('Engine boom'));

    // Should not throw
    await expect(
      (runner as any).handleMessage(mkMsg({ activityId: 'act.error1' }))
    ).resolves.toBeUndefined();

    jest.restoreAllMocks();
  });

  test('updateConfig updates the config', () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new TeamsWebhookRunner(engine, baseCfg, {
      appId: 'test-app-id',
      appPassword: 'test-app-password',
    });

    const newCfg = { ...baseCfg, checks: { newCheck: { type: 'ai' as any } } } as any;
    runner.updateConfig(newCfg);
    expect((runner as any).cfg).toBe(newCfg);
  });

  test('getClient returns the TeamsClient', () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new TeamsWebhookRunner(engine, baseCfg, {
      appId: 'test-app-id',
      appPassword: 'test-app-password',
    });

    const client = runner.getClient();
    expect(client.getAppId()).toBe('test-app-id');
  });

  test('setTaskStore sets the task store', () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new TeamsWebhookRunner(engine, baseCfg, {
      appId: 'test-app-id',
      appPassword: 'test-app-password',
    });

    const fakeStore = { addTask: jest.fn() } as any;
    runner.setTaskStore(fakeStore, '/path/to/config');
    expect((runner as any).taskStore).toBe(fakeStore);
    expect((runner as any).configPath).toBe('/path/to/config');
  });

  test('builds webhook data with correct endpoint and payload shape', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new TeamsWebhookRunner(engine, baseCfg, {
      appId: 'test-app-id',
      appPassword: 'test-app-password',
    });

    let capturedOpts: any;
    const spy = jest
      .spyOn(StateMachineExecutionEngine.prototype, 'executeChecks')
      .mockImplementation(async (opts: any) => {
        capturedOpts = opts;
        return {
          results: { default: [] },
          statistics: {
            totalChecks: 1,
            checksByGroup: {},
            issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
          },
        } as any;
      });

    await (runner as any).handleMessage(
      mkMsg({
        activityId: 'act.payload1',
        conversationId: 'conv-test',
        from: { id: 'user-1', name: 'Test User' },
        text: 'Test message',
      })
    );

    expect(capturedOpts.webhookContext).toBeDefined();
    const webhookData = capturedOpts.webhookContext.webhookData as Map<string, any>;
    const payload = webhookData.get('/bots/teams/message');
    expect(payload).toBeDefined();
    expect(payload.event.type).toBe('teams_message');
    expect(payload.event.conversation_id).toBe('conv-test');
    expect(payload.event.activity_id).toBe('act.payload1');
    expect(payload.event.text).toBe('Test message');
    expect(payload.event.from_id).toBe('user-1');
    expect(payload.event.from_name).toBe('Test User');
    expect(payload.teams_conversation).toBeDefined();
    expect(payload.teams_conversation_reference).toBeDefined();

    spy.mockRestore();
  });

  test('prepareConfigForRun injects teams frontend', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new TeamsWebhookRunner(engine, baseCfg, {
      appId: 'test-app-id',
      appPassword: 'test-app-password',
    });

    let capturedOpts: any;
    const spy = jest
      .spyOn(StateMachineExecutionEngine.prototype, 'executeChecks')
      .mockImplementation(async (opts: any) => {
        capturedOpts = opts;
        return {
          results: { default: [] },
          statistics: {
            totalChecks: 1,
            checksByGroup: {},
            issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
          },
        } as any;
      });

    await (runner as any).handleMessage(mkMsg({ activityId: 'act.frontend1' }));

    const config = capturedOpts.config;
    const frontends = config.frontends || [];
    const hasTeams = frontends.some((f: any) => f && f.name === 'teams');
    expect(hasTeams).toBe(true);

    spy.mockRestore();
  });

  test('constructor throws when appId is missing', () => {
    const engine = new StateMachineExecutionEngine();
    expect(
      () =>
        new TeamsWebhookRunner(engine, baseCfg, {
          appId: '',
          appPassword: 'test-app-password',
        })
    ).toThrow('TEAMS_APP_ID is required');
  });

  test('constructor throws when appPassword is missing', () => {
    const engine = new StateMachineExecutionEngine();
    expect(
      () =>
        new TeamsWebhookRunner(engine, baseCfg, {
          appId: 'test-app-id',
          appPassword: '',
        })
    ).toThrow('TEAMS_APP_PASSWORD is required');
  });

  test('processes groupChat conversation type', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new TeamsWebhookRunner(engine, baseCfg, {
      appId: 'test-app-id',
      appPassword: 'test-app-password',
    });

    let capturedOpts: any;
    const spy = jest
      .spyOn(StateMachineExecutionEngine.prototype, 'executeChecks')
      .mockImplementation(async (opts: any) => {
        capturedOpts = opts;
        return {
          results: { default: [] },
          statistics: {
            totalChecks: 1,
            checksByGroup: {},
            issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
          },
        } as any;
      });

    await (runner as any).handleMessage(
      mkMsg({
        activityId: 'act.group1',
        conversationType: 'groupChat',
        conversationId: 'group-conv-1',
      })
    );

    expect(spy).toHaveBeenCalledTimes(1);
    const webhookData = capturedOpts.webhookContext.webhookData as Map<string, any>;
    const payload = webhookData.get('/bots/teams/message');
    expect(payload.event.conversation_type).toBe('groupChat');

    spy.mockRestore();
  });

  test('empty allowlist accepts all users', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new TeamsWebhookRunner(engine, baseCfg, {
      appId: 'test-app-id',
      appPassword: 'test-app-password',
      userAllowlist: [],
    });

    const spy = jest
      .spyOn(StateMachineExecutionEngine.prototype, 'executeChecks')
      .mockResolvedValue({
        results: { default: [] },
        statistics: {
          totalChecks: 1,
          checksByGroup: {},
          issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
        },
      } as any);

    await (runner as any).handleMessage(
      mkMsg({
        activityId: 'act.anyuser',
        from: { id: 'random-user', name: 'Random' },
      })
    );

    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  test('sets workspace name from conversation ID hash', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new TeamsWebhookRunner(engine, baseCfg, {
      appId: 'test-app-id',
      appPassword: 'test-app-password',
    });

    let capturedOpts: any;
    const spy = jest
      .spyOn(StateMachineExecutionEngine.prototype, 'executeChecks')
      .mockImplementation(async (opts: any) => {
        capturedOpts = opts;
        return {
          results: { default: [] },
          statistics: {
            totalChecks: 1,
            checksByGroup: {},
            issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
          },
        } as any;
      });

    await (runner as any).handleMessage(mkMsg({ activityId: 'act.workspace1' }));

    const config = capturedOpts.config;
    expect(config.workspace).toBeDefined();
    expect(config.workspace.name).toMatch(/^teams-[0-9a-f]{8}$/);
    expect(config.workspace.cleanup_on_exit).toBe(false);

    spy.mockRestore();
  });

  test('different conversations get different workspace names', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new TeamsWebhookRunner(engine, baseCfg, {
      appId: 'test-app-id',
      appPassword: 'test-app-password',
    });

    const workspaceNames: string[] = [];
    const spy = jest
      .spyOn(StateMachineExecutionEngine.prototype, 'executeChecks')
      .mockImplementation(async (opts: any) => {
        workspaceNames.push(opts.config.workspace.name);
        return {
          results: { default: [] },
          statistics: {
            totalChecks: 1,
            checksByGroup: {},
            issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
          },
        } as any;
      });

    await (runner as any).handleMessage(
      mkMsg({
        activityId: 'act.ws1',
        conversationId: 'conv-aaa',
      })
    );
    await (runner as any).handleMessage(
      mkMsg({
        activityId: 'act.ws2',
        conversationId: 'conv-bbb',
      })
    );

    expect(workspaceNames.length).toBe(2);
    expect(workspaceNames[0]).not.toBe(workspaceNames[1]);

    spy.mockRestore();
  });
});
