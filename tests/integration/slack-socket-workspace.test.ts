import { createHash } from 'crypto';
import { SlackSocketRunner } from '../../src/slack/socket-runner';
import { StateMachineExecutionEngine } from '../../src/state-machine-execution-engine';
import type { VisorConfig } from '../../src/types/config';

function expectedWorkspaceName(channel: string, threadTs: string): string {
  const hash = createHash('sha256').update(`${channel}:${threadTs}`).digest('hex').slice(0, 8);
  return `slack-${hash}`;
}

describe('Slack socket workspace persistence across thread messages', () => {
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
    thread_ts?: string;
    text?: string;
  }) {
    const { type, channel, thread_ts } = opts;
    const ts = opts.ts || '1700.123';
    const text = opts.text || 'Hello bot!';
    return {
      type: 'events_api',
      envelope_id: `env-${channel}-${type}-${ts}`,
      payload: { event: { type, channel, ts, thread_ts, text } },
    };
  }

  test('injects workspace.name from thread identity into cfgForRun', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new SlackSocketRunner(engine, baseCfg, {
      appToken: 'xapp-test',
      endpoint: '/bots/slack/support',
      mentions: 'all',
      threads: 'required',
    });

    let capturedConfig: any = null;
    const spy = jest
      .spyOn(StateMachineExecutionEngine.prototype, 'executeChecks')
      .mockImplementation(async (opts: any) => {
        capturedConfig = opts.config;
        return {
          results: { default: [] },
          statistics: {
            totalChecks: 1,
            checksByGroup: {},
            issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
          },
        } as any;
      });

    // DM root message — thread_ts is undefined, so falls back to ts
    await (runner as any).handleMessage(
      JSON.stringify(
        mkEnv({
          type: 'message',
          channel: 'D123ABC',
          ts: '1700000000.123456',
        })
      )
    );

    expect(spy).toHaveBeenCalledTimes(1);
    expect(capturedConfig).toBeDefined();
    expect(capturedConfig.workspace).toBeDefined();
    expect(capturedConfig.workspace.name).toBe(
      expectedWorkspaceName('D123ABC', '1700000000.123456')
    );
    expect(capturedConfig.workspace.cleanup_on_exit).toBe(false);

    spy.mockRestore();
  });

  test('two messages in the same thread get the same workspace name', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new SlackSocketRunner(engine, baseCfg, {
      appToken: 'xapp-test',
      endpoint: '/bots/slack/support',
      mentions: 'all',
      threads: 'required',
    });

    const capturedConfigs: any[] = [];
    const spy = jest
      .spyOn(StateMachineExecutionEngine.prototype, 'executeChecks')
      .mockImplementation(async (opts: any) => {
        capturedConfigs.push(opts.config);
        return {
          results: { default: [] },
          statistics: {
            totalChecks: 1,
            checksByGroup: {},
            issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
          },
        } as any;
      });

    // First message: root of thread (no thread_ts, uses ts)
    await (runner as any).handleMessage(
      JSON.stringify(
        mkEnv({
          type: 'message',
          channel: 'D999',
          ts: '1700000000.111111',
        })
      )
    );

    // Second message: reply in same thread (thread_ts = parent's ts)
    await (runner as any).handleMessage(
      JSON.stringify(
        mkEnv({
          type: 'message',
          channel: 'D999',
          ts: '1700000000.222222',
          thread_ts: '1700000000.111111',
        })
      )
    );

    expect(capturedConfigs.length).toBe(2);
    // Both should have the same workspace name derived from the thread root ts
    const expected = expectedWorkspaceName('D999', '1700000000.111111');
    expect(capturedConfigs[0].workspace.name).toBe(expected);
    expect(capturedConfigs[1].workspace.name).toBe(expected);

    spy.mockRestore();
  });

  test('messages in different threads get different workspace names', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new SlackSocketRunner(engine, baseCfg, {
      appToken: 'xapp-test',
      endpoint: '/bots/slack/support',
      mentions: 'all',
      threads: 'required',
    });

    const capturedConfigs: any[] = [];
    const spy = jest
      .spyOn(StateMachineExecutionEngine.prototype, 'executeChecks')
      .mockImplementation(async (opts: any) => {
        capturedConfigs.push(opts.config);
        return {
          results: { default: [] },
          statistics: {
            totalChecks: 1,
            checksByGroup: {},
            issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
          },
        } as any;
      });

    // Thread 1
    await (runner as any).handleMessage(
      JSON.stringify(
        mkEnv({
          type: 'message',
          channel: 'D999',
          ts: '1700000000.111111',
        })
      )
    );

    // Thread 2 (different ts = different thread)
    await (runner as any).handleMessage(
      JSON.stringify(
        mkEnv({
          type: 'message',
          channel: 'D999',
          ts: '1700000000.333333',
        })
      )
    );

    expect(capturedConfigs.length).toBe(2);
    expect(capturedConfigs[0].workspace.name).toBe(
      expectedWorkspaceName('D999', '1700000000.111111')
    );
    expect(capturedConfigs[1].workspace.name).toBe(
      expectedWorkspaceName('D999', '1700000000.333333')
    );
    expect(capturedConfigs[0].workspace.name).not.toBe(capturedConfigs[1].workspace.name);

    spy.mockRestore();
  });

  test('preserves existing workspace config from cfgForRun', async () => {
    const cfgWithWorkspace: VisorConfig = {
      ...baseCfg,
      workspace: { enabled: true, base_path: '/custom/path' },
    } as any;

    const engine = new StateMachineExecutionEngine();
    const runner = new SlackSocketRunner(engine, cfgWithWorkspace, {
      appToken: 'xapp-test',
      endpoint: '/bots/slack/support',
      mentions: 'all',
      threads: 'required',
    });

    let capturedConfig: any = null;
    const spy = jest
      .spyOn(StateMachineExecutionEngine.prototype, 'executeChecks')
      .mockImplementation(async (opts: any) => {
        capturedConfig = opts.config;
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
      JSON.stringify(
        mkEnv({
          type: 'message',
          channel: 'D123',
          ts: '1700.500',
        })
      )
    );

    expect(spy).toHaveBeenCalledTimes(1);
    // Should merge workspace name into existing workspace config
    expect(capturedConfig.workspace.enabled).toBe(true);
    expect(capturedConfig.workspace.base_path).toBe('/custom/path');
    expect(capturedConfig.workspace.name).toBe(expectedWorkspaceName('D123', '1700.500'));
    expect(capturedConfig.workspace.cleanup_on_exit).toBe(false);

    spy.mockRestore();
  });
});
