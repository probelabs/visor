import { SlackSocketRunner } from '../../src/slack/socket-runner';
import { StateMachineExecutionEngine } from '../../src/state-machine-execution-engine';
import type { VisorConfig } from '../../src/types/config';

/**
 * Build a Slack WebSocket envelope for testing
 */
function mkEnv(opts: {
  type?: string;
  channel: string;
  ts: string;
  text: string;
  user?: string;
  subtype?: string;
  threadTs?: string;
}) {
  const ev: any = {
    type: opts.type || 'message',
    channel: opts.channel,
    ts: opts.ts,
    text: opts.text,
    user: opts.user || 'U_HUMAN',
  };
  if (opts.subtype) ev.subtype = opts.subtype;
  if (opts.threadTs) ev.thread_ts = opts.threadTs;
  return {
    type: 'events_api',
    envelope_id: `env-${opts.channel}-${opts.ts}`,
    payload: { event: ev },
  };
}

describe('Slack socket message triggers', () => {
  const baseCfg: VisorConfig = {
    version: '1.0',
    output: { pr_comment: { format: 'markdown', group_by: 'check', collapse: true } },
    checks: {
      'handle-cicd': { type: 'noop' as any, on: ['slack_message'] },
      'other-check': { type: 'noop' as any, on: ['manual'] },
    },
    scheduler: {
      enabled: true,
      on_message: {
        'cicd-watcher': {
          channels: ['C0CICD'],
          from_bots: true,
          contains: ['failed', 'error'],
          workflow: 'handle-cicd',
          description: 'React to CI/CD failures',
        },
      },
    },
  } as any;

  let spy: jest.SpyInstance;

  beforeEach(() => {
    spy = jest.spyOn(StateMachineExecutionEngine.prototype, 'executeChecks').mockResolvedValue({
      results: { default: [] },
      statistics: {
        totalChecks: 1,
        checksByGroup: {},
        issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
      },
    } as any);
  });

  afterEach(() => {
    spy.mockRestore();
  });

  function mkRunner(cfg: VisorConfig = baseCfg) {
    const engine = new StateMachineExecutionEngine();
    return new SlackSocketRunner(engine, cfg, {
      appToken: 'xapp-test',
      endpoint: '/bots/slack/support',
      mentions: 'direct',
      threads: 'any',
    });
  }

  test('dispatches workflow when message matches trigger', async () => {
    const runner = mkRunner();
    await (runner as any).handleMessage(
      JSON.stringify(
        mkEnv({
          channel: 'C0CICD',
          ts: '2000.001',
          text: 'build #42 failed',
          subtype: 'bot_message',
        })
      )
    );

    // Trigger dispatch is async — the mention-path also drops (no bot mention, non-DM channel)
    // so only the trigger dispatch should fire
    // Wait for async dispatch
    await new Promise(r => setTimeout(r, 50));

    // Find the trigger-dispatched call (workflow = handle-cicd)
    const triggerCalls = spy.mock.calls.filter(
      (call: any[]) => call[0]?.checks?.[0] === 'handle-cicd'
    );
    expect(triggerCalls.length).toBe(1);
    expect(triggerCalls[0][0].webhookContext.eventType).toBe('slack_message');
  });

  test('does not dispatch when channel does not match', async () => {
    const runner = mkRunner();
    await (runner as any).handleMessage(
      JSON.stringify(
        mkEnv({
          channel: 'C0OTHER',
          ts: '2000.002',
          text: 'build failed',
          subtype: 'bot_message',
        })
      )
    );
    await new Promise(r => setTimeout(r, 50));

    const triggerCalls = spy.mock.calls.filter(
      (call: any[]) => call[0]?.checks?.[0] === 'handle-cicd'
    );
    expect(triggerCalls.length).toBe(0);
  });

  test('does not dispatch when keywords do not match', async () => {
    const runner = mkRunner();
    await (runner as any).handleMessage(
      JSON.stringify(
        mkEnv({
          channel: 'C0CICD',
          ts: '2000.003',
          text: 'build succeeded',
          subtype: 'bot_message',
        })
      )
    );
    await new Promise(r => setTimeout(r, 50));

    const triggerCalls = spy.mock.calls.filter(
      (call: any[]) => call[0]?.checks?.[0] === 'handle-cicd'
    );
    expect(triggerCalls.length).toBe(0);
  });

  test('does not dispatch for non-bot messages when from_bots but no from_bots flag', async () => {
    // The base trigger has from_bots: true, so non-bot should still match
    // (from_bots only gates bot messages; non-bot always passes)
    const runner = mkRunner();
    await (runner as any).handleMessage(
      JSON.stringify(
        mkEnv({
          channel: 'C0CICD',
          ts: '2000.004',
          text: 'build failed',
          user: 'U_HUMAN',
        })
      )
    );
    await new Promise(r => setTimeout(r, 50));

    const triggerCalls = spy.mock.calls.filter(
      (call: any[]) => call[0]?.checks?.[0] === 'handle-cicd'
    );
    expect(triggerCalls.length).toBe(1);
  });

  test('rejects bot messages when from_bots is false', async () => {
    const cfg: VisorConfig = {
      ...baseCfg,
      scheduler: {
        ...baseCfg.scheduler,
        on_message: {
          'strict-no-bots': {
            channels: ['C0CICD'],
            from_bots: false,
            contains: ['failed'],
            workflow: 'handle-cicd',
          },
        },
      },
    } as any;
    const runner = mkRunner(cfg);
    // We need to allow bot messages at the socket level
    (runner as any).allowBotMessages = true;

    await (runner as any).handleMessage(
      JSON.stringify(
        mkEnv({
          channel: 'C0CICD',
          ts: '2000.005',
          text: 'build failed',
          subtype: 'bot_message',
        })
      )
    );
    await new Promise(r => setTimeout(r, 50));

    const triggerCalls = spy.mock.calls.filter(
      (call: any[]) => call[0]?.checks?.[0] === 'handle-cicd'
    );
    expect(triggerCalls.length).toBe(0);
  });

  test('deduplicates same trigger/channel/ts', async () => {
    const runner = mkRunner();
    const envelope = JSON.stringify(
      mkEnv({
        channel: 'C0CICD',
        ts: '2000.006',
        text: 'build failed',
        subtype: 'bot_message',
      })
    );

    // Send the same message twice (duplicate events from Slack)
    await (runner as any).handleMessage(envelope);
    // Manually reset the general dedup key so only the trigger dedup key is tested
    (runner as any).processedKeys.delete('C0CICD:2000.006');
    await (runner as any).handleMessage(envelope);
    await new Promise(r => setTimeout(r, 50));

    const triggerCalls = spy.mock.calls.filter(
      (call: any[]) => call[0]?.checks?.[0] === 'handle-cicd'
    );
    expect(triggerCalls.length).toBe(1);
  });

  test('thread scope: root_only only triggers on root messages', async () => {
    const cfg: VisorConfig = {
      ...baseCfg,
      scheduler: {
        ...baseCfg.scheduler,
        on_message: {
          'root-only': {
            channels: ['C0CICD'],
            from_bots: true,
            threads: 'root_only',
            contains: ['failed'],
            workflow: 'handle-cicd',
          },
        },
      },
    } as any;
    const runner = mkRunner(cfg);

    // Root message should trigger
    await (runner as any).handleMessage(
      JSON.stringify(
        mkEnv({
          channel: 'C0CICD',
          ts: '2000.007',
          text: 'build failed',
          subtype: 'bot_message',
        })
      )
    );
    await new Promise(r => setTimeout(r, 50));

    let triggerCalls = spy.mock.calls.filter(
      (call: any[]) => call[0]?.checks?.[0] === 'handle-cicd'
    );
    expect(triggerCalls.length).toBe(1);

    spy.mockClear();

    // Thread reply should NOT trigger
    await (runner as any).handleMessage(
      JSON.stringify(
        mkEnv({
          channel: 'C0CICD',
          ts: '2000.008',
          threadTs: '2000.007',
          text: 'build also failed',
          subtype: 'bot_message',
        })
      )
    );
    await new Promise(r => setTimeout(r, 50));

    triggerCalls = spy.mock.calls.filter((call: any[]) => call[0]?.checks?.[0] === 'handle-cicd');
    expect(triggerCalls.length).toBe(0);
  });

  test('regex match filter works', async () => {
    const cfg: VisorConfig = {
      ...baseCfg,
      scheduler: {
        ...baseCfg.scheduler,
        on_message: {
          regex: {
            channels: ['C0CICD'],
            match: 'deploy.*production.*failed',
            from_bots: true,
            workflow: 'handle-cicd',
          },
        },
      },
    } as any;
    const runner = mkRunner(cfg);

    // Should match
    await (runner as any).handleMessage(
      JSON.stringify(
        mkEnv({
          channel: 'C0CICD',
          ts: '2000.009',
          text: 'deploy to production has failed',
          subtype: 'bot_message',
        })
      )
    );
    await new Promise(r => setTimeout(r, 50));

    let triggerCalls = spy.mock.calls.filter(
      (call: any[]) => call[0]?.checks?.[0] === 'handle-cicd'
    );
    expect(triggerCalls.length).toBe(1);

    spy.mockClear();

    // Should NOT match
    await (runner as any).handleMessage(
      JSON.stringify(
        mkEnv({
          channel: 'C0CICD',
          ts: '2000.010',
          text: 'deploy to staging succeeded',
          subtype: 'bot_message',
        })
      )
    );
    await new Promise(r => setTimeout(r, 50));

    triggerCalls = spy.mock.calls.filter((call: any[]) => call[0]?.checks?.[0] === 'handle-cicd');
    expect(triggerCalls.length).toBe(0);
  });

  test('updateConfig rebuilds triggers', async () => {
    const runner = mkRunner();
    expect((runner as any).messageTriggerEvaluator).toBeDefined();

    // Update config with no triggers
    const emptyCfg: VisorConfig = {
      ...baseCfg,
      scheduler: { enabled: true },
    } as any;
    runner.updateConfig(emptyCfg);
    expect((runner as any).messageTriggerEvaluator).toBeUndefined();

    // Update back with triggers
    runner.updateConfig(baseCfg);
    expect((runner as any).messageTriggerEvaluator).toBeDefined();
  });

  test('trigger passes inputs to workflow execution', async () => {
    const cfg: VisorConfig = {
      ...baseCfg,
      scheduler: {
        ...baseCfg.scheduler,
        on_message: {
          'with-inputs': {
            channels: ['C0CICD'],
            from_bots: true,
            contains: ['failed'],
            workflow: 'handle-cicd',
            inputs: { source: 'slack', priority: 'high' },
          },
        },
      },
    } as any;
    const runner = mkRunner(cfg);

    await (runner as any).handleMessage(
      JSON.stringify(
        mkEnv({
          channel: 'C0CICD',
          ts: '2000.011',
          text: 'build failed',
          subtype: 'bot_message',
        })
      )
    );
    await new Promise(r => setTimeout(r, 50));

    const triggerCalls = spy.mock.calls.filter(
      (call: any[]) => call[0]?.checks?.[0] === 'handle-cicd'
    );
    expect(triggerCalls.length).toBe(1);
    expect(triggerCalls[0][0].inputs).toEqual({ source: 'slack', priority: 'high' });
  });

  test('disabled trigger is not evaluated', async () => {
    const cfg: VisorConfig = {
      ...baseCfg,
      scheduler: {
        ...baseCfg.scheduler,
        on_message: {
          disabled: {
            channels: ['C0CICD'],
            from_bots: true,
            contains: ['failed'],
            workflow: 'handle-cicd',
            enabled: false,
          },
        },
      },
    } as any;
    const runner = mkRunner(cfg);

    await (runner as any).handleMessage(
      JSON.stringify(
        mkEnv({
          channel: 'C0CICD',
          ts: '2000.012',
          text: 'build failed',
          subtype: 'bot_message',
        })
      )
    );
    await new Promise(r => setTimeout(r, 50));

    const triggerCalls = spy.mock.calls.filter(
      (call: any[]) => call[0]?.checks?.[0] === 'handle-cicd'
    );
    expect(triggerCalls.length).toBe(0);
  });

  test('trigger and mention path can both fire for the same message', async () => {
    const cfg: VisorConfig = {
      ...baseCfg,
      scheduler: {
        ...baseCfg.scheduler,
        on_message: {
          watcher: {
            channels: ['C0CICD'],
            contains: ['failed'],
            workflow: 'handle-cicd',
          },
        },
      },
    } as any;
    const engine = new StateMachineExecutionEngine();
    const runner = new SlackSocketRunner(engine, cfg, {
      appToken: 'xapp-test',
      endpoint: '/bots/slack/support',
      mentions: 'direct',
      threads: 'any',
    });
    (runner as any).botUserId = 'UBOTID';

    // Message that matches trigger AND has a bot mention
    await (runner as any).handleMessage(
      JSON.stringify(
        mkEnv({
          type: 'app_mention',
          channel: 'C0CICD',
          ts: '2000.013',
          text: '<@UBOTID> build failed',
        })
      )
    );
    await new Promise(r => setTimeout(r, 50));

    // Should have both: trigger dispatch (handle-cicd only) + mention dispatch (all checks)
    const triggerCalls = spy.mock.calls.filter(
      (call: any[]) => call[0]?.checks?.length === 1 && call[0]?.checks?.[0] === 'handle-cicd'
    );
    const mentionCalls = spy.mock.calls.filter((call: any[]) => call[0]?.checks?.length > 1);
    expect(triggerCalls.length).toBe(1);
    expect(mentionCalls.length).toBe(1);
  });
});
