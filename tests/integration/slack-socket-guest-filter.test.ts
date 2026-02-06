import { SlackSocketRunner } from '../../src/slack/socket-runner';
import { StateMachineExecutionEngine } from '../../src/state-machine-execution-engine';
import type { VisorConfig } from '../../src/types/config';

describe('Slack socket guest user filtering', () => {
  const baseCfg: VisorConfig = {
    version: '1.0',
    slack: { endpoint: '/bots/slack/support', mentions: 'all', threads: 'required' } as any,
    output: { pr_comment: { format: 'markdown', group_by: 'check', collapse: true } },
    checks: { ask: { type: 'human-input' as any, on: ['manual'] } },
  } as any;

  function mkEnv(opts: { channel: string; ts?: string; text?: string; user?: string }) {
    const ts = opts.ts || '1700.123';
    const text = opts.text || 'Hello bot!';
    const user = opts.user || 'U12345';
    return {
      type: 'events_api',
      envelope_id: `env-${opts.channel}-${ts}`,
      payload: {
        event: {
          type: 'app_mention',
          channel: opts.channel,
          ts,
          text,
          user,
        },
      },
    };
  }

  // Mock SlackClient for user info - create fresh mock for each test
  let mockClient: {
    getBotUserId: jest.Mock;
    getUserInfo: jest.Mock;
  };

  beforeEach(() => {
    mockClient = {
      getBotUserId: jest.fn().mockResolvedValue('UBOTID'),
      getUserInfo: jest.fn(),
    };
  });

  test('filters out single-channel guest when allowGuests=false (default)', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new SlackSocketRunner(engine, baseCfg, {
      appToken: 'xapp-test',
      endpoint: '/bots/slack/support',
      mentions: 'all',
      threads: 'required',
      allowGuests: false,
    });

    // Inject mock client
    (runner as any).client = mockClient;
    (runner as any).botUserId = 'UBOTID';

    // Mock getUserInfo to return single-channel guest
    mockClient.getUserInfo.mockResolvedValue({
      ok: true,
      user: {
        id: 'UGUEST1',
        is_restricted: false,
        is_ultra_restricted: true, // single-channel guest
      },
    });

    const spy = jest.spyOn((StateMachineExecutionEngine as any).prototype, 'executeChecks');

    await (runner as any).handleMessage(
      JSON.stringify(mkEnv({ channel: 'C1', ts: '2000.1', user: 'UGUEST1' }))
    );

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('filters out multi-channel guest when allowGuests=false', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new SlackSocketRunner(engine, baseCfg, {
      appToken: 'xapp-test',
      endpoint: '/bots/slack/support',
      mentions: 'all',
      threads: 'required',
      allowGuests: false,
    });

    (runner as any).client = mockClient;
    (runner as any).botUserId = 'UBOTID';

    // Mock getUserInfo to return multi-channel guest
    mockClient.getUserInfo.mockResolvedValue({
      ok: true,
      user: {
        id: 'UGUEST2',
        is_restricted: true, // multi-channel guest
        is_ultra_restricted: false,
      },
    });

    const spy = jest.spyOn((StateMachineExecutionEngine as any).prototype, 'executeChecks');

    await (runner as any).handleMessage(
      JSON.stringify(mkEnv({ channel: 'C1', ts: '2001.1', user: 'UGUEST2' }))
    );

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('allows guest users when allowGuests=true', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new SlackSocketRunner(engine, baseCfg, {
      appToken: 'xapp-test',
      endpoint: '/bots/slack/support',
      mentions: 'all',
      threads: 'required',
      allowGuests: true,
    });

    (runner as any).client = mockClient;
    (runner as any).botUserId = 'UBOTID';

    // Mock getUserInfo to return single-channel guest
    mockClient.getUserInfo.mockResolvedValue({
      ok: true,
      user: {
        id: 'UGUEST3',
        is_restricted: false,
        is_ultra_restricted: true, // single-channel guest
      },
    });

    const spy = jest
      .spyOn((StateMachineExecutionEngine as any).prototype, 'executeChecks')
      .mockResolvedValue({
        results: { default: [] },
        statistics: {
          totalChecks: 1,
          checksByGroup: {},
          issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
        },
      });

    await (runner as any).handleMessage(
      JSON.stringify(mkEnv({ channel: 'C1', ts: '2002.1', user: 'UGUEST3' }))
    );

    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  test('allows regular users when allowGuests=false', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new SlackSocketRunner(engine, baseCfg, {
      appToken: 'xapp-test',
      endpoint: '/bots/slack/support',
      mentions: 'all',
      threads: 'required',
      allowGuests: false,
    });

    (runner as any).client = mockClient;
    (runner as any).botUserId = 'UBOTID';

    // Mock getUserInfo to return regular user (not a guest)
    mockClient.getUserInfo.mockResolvedValue({
      ok: true,
      user: {
        id: 'UREGULAR',
        is_restricted: false,
        is_ultra_restricted: false,
      },
    });

    const spy = jest
      .spyOn((StateMachineExecutionEngine as any).prototype, 'executeChecks')
      .mockResolvedValue({
        results: { default: [] },
        statistics: {
          totalChecks: 1,
          checksByGroup: {},
          issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
        },
      });

    await (runner as any).handleMessage(
      JSON.stringify(mkEnv({ channel: 'C1', ts: '2003.1', user: 'UREGULAR' }))
    );

    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  test('caches user info for 5 minutes', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new SlackSocketRunner(engine, baseCfg, {
      appToken: 'xapp-test',
      endpoint: '/bots/slack/support',
      mentions: 'all',
      threads: 'required',
      allowGuests: false,
    });

    (runner as any).client = mockClient;
    (runner as any).botUserId = 'UBOTID';

    mockClient.getUserInfo.mockResolvedValue({
      ok: true,
      user: {
        id: 'UCACHED',
        is_restricted: false,
        is_ultra_restricted: false,
        email: 'test@example.com',
        name: 'testuser',
      },
    });

    const spy = jest
      .spyOn((StateMachineExecutionEngine as any).prototype, 'executeChecks')
      .mockResolvedValue({
        results: { default: [] },
        statistics: {
          totalChecks: 1,
          checksByGroup: {},
          issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
        },
      });

    // First call
    await (runner as any).handleMessage(
      JSON.stringify(mkEnv({ channel: 'C1', ts: '2004.1', user: 'UCACHED' }))
    );

    // Second call with same user - should use cache
    await (runner as any).handleMessage(
      JSON.stringify(mkEnv({ channel: 'C1', ts: '2004.2', user: 'UCACHED' }))
    );

    // getUserInfo should only be called once due to caching
    expect(mockClient.getUserInfo).toHaveBeenCalledTimes(1);

    spy.mockRestore();
  });

  test('handles API failure gracefully - allows user by default', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new SlackSocketRunner(engine, baseCfg, {
      appToken: 'xapp-test',
      endpoint: '/bots/slack/support',
      mentions: 'all',
      threads: 'required',
      allowGuests: false,
    });

    (runner as any).client = mockClient;
    (runner as any).botUserId = 'UBOTID';

    // Mock getUserInfo to fail
    mockClient.getUserInfo.mockResolvedValue({ ok: false });

    const spy = jest
      .spyOn((StateMachineExecutionEngine as any).prototype, 'executeChecks')
      .mockResolvedValue({
        results: { default: [] },
        statistics: {
          totalChecks: 1,
          checksByGroup: {},
          issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
        },
      });

    await (runner as any).handleMessage(
      JSON.stringify(mkEnv({ channel: 'C1', ts: '2005.1', user: 'UUNKNOWN' }))
    );

    // Should allow user when API fails (graceful degradation)
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
