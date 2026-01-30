import { SlackSocketRunner } from '../../src/slack/socket-runner';
import { StateMachineExecutionEngine } from '../../src/state-machine-execution-engine';
import type { VisorConfig } from '../../src/types/config';

describe('Slack socket gating (mentions / channel types)', () => {
  const baseCfg: VisorConfig = {
    version: '1.0',
    slack: { endpoint: '/bots/slack/support', mentions: 'all', threads: 'required' } as any,
    output: { pr_comment: { format: 'markdown', group_by: 'check', collapse: true } },
    checks: { ask: { type: 'human-input' as any, on: ['manual'] } },
  } as any;

  function mkEnv(opts: {
    type: string;
    channel: string;
    ts?: string;
    text?: string;
    subtype?: string;
  }) {
    const { type, channel, subtype } = opts;
    const ts = opts.ts || '1700.123';
    const text = opts.text || 'Hello bot!';
    return {
      type: 'events_api',
      envelope_id: `env-${channel}-${type}-${ts}`,
      payload: { event: { type, channel, ts, text, subtype } },
    };
  }

  test('DM root message accepted when mentions: all and threads: required', async () => {
    const cfg = baseCfg;
    const engine = new StateMachineExecutionEngine();
    const runner = new SlackSocketRunner(engine, cfg, {
      appToken: 'xapp-test',
      endpoint: '/bots/slack/support',
      mentions: 'all',
      threads: 'required',
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

    // DM-style channel id (D*); plain `message` is accepted when mentions: all
    await (runner as any).handleMessage(JSON.stringify(mkEnv({ type: 'message', channel: 'D1' })));
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  test('private channel (G*) requires explicit mention', async () => {
    const cfg = baseCfg;
    const engine = new StateMachineExecutionEngine();
    const runner = new SlackSocketRunner(engine, cfg, {
      appToken: 'xapp-test',
      endpoint: '/bots/slack/support',
      mentions: 'all',
      threads: 'required',
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

    // Plain message in G* channel should be ignored (no mention)
    await (runner as any).handleMessage(
      JSON.stringify(mkEnv({ type: 'message', channel: 'G1', ts: '1750.1', text: 'Hello bot!' }))
    );
    expect(spy).not.toHaveBeenCalled();

    // Explicit mention in same channel should be accepted
    (runner as any).botUserId = 'UFAKEBOT';
    await (runner as any).handleMessage(
      JSON.stringify(
        mkEnv({ type: 'message', channel: 'G1', ts: '1750.2', text: '<@UFAKEBOT> hi' })
      )
    );
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  test('public channel only reacts to app_mention, not plain message', async () => {
    const cfg = baseCfg;
    const engine = new StateMachineExecutionEngine();
    const runner = new SlackSocketRunner(engine, cfg, {
      appToken: 'xapp-test',
      endpoint: '/bots/slack/support',
      mentions: 'all',
      threads: 'required',
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

    // Plain message in C* channel should be ignored
    await (runner as any).handleMessage(
      JSON.stringify(mkEnv({ type: 'message', channel: 'C1', ts: '1800.1', text: 'Hello bot!' }))
    );
    expect(spy).not.toHaveBeenCalled();

    // Bot message with explicit mention should be accepted
    (runner as any).botUserId = 'UFAKEBOT';
    await (runner as any).handleMessage(
      JSON.stringify(
        mkEnv({
          type: 'message',
          subtype: 'bot_message',
          channel: 'C1',
          ts: '1800.15',
          text: '<@UFAKEBOT> hi from bot',
        })
      )
    );
    expect(spy).toHaveBeenCalledTimes(1);

    // app_mention in same channel should be accepted
    await (runner as any).handleMessage(
      JSON.stringify(
        mkEnv({ type: 'app_mention', channel: 'C1', ts: '1800.2', text: '<@UFAKEBOT> hi' })
      )
    );
    expect(spy).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  test('DM with mentions: direct requires app_mention', async () => {
    const cfg = baseCfg;
    const engine = new StateMachineExecutionEngine();
    const runner = new SlackSocketRunner(engine, cfg, {
      appToken: 'xapp-test',
      endpoint: '/bots/slack/support',
      mentions: 'direct',
      threads: 'required',
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

    // In DMs with mentions: direct, plain message should NOT trigger
    await (runner as any).handleMessage(
      JSON.stringify(mkEnv({ type: 'message', channel: 'D2', ts: '1900.1', text: 'hi' }))
    );
    expect(spy).not.toHaveBeenCalled();

    // app_mention should trigger
    await (runner as any).handleMessage(
      JSON.stringify(
        mkEnv({ type: 'app_mention', channel: 'D2', ts: '1900.2', text: '<@UFAKEBOT> hi' })
      )
    );
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
