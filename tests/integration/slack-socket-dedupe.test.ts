import { SlackSocketRunner } from '../../src/slack/socket-runner';
import { StateMachineExecutionEngine } from '../../src/state-machine-execution-engine';
import type { VisorConfig } from '../../src/types/config';

describe('Slack socket de-duplicates duplicate events (message + app_mention same ts)', () => {
  const cfg: VisorConfig = {
    version: '1.0',
    output: { pr_comment: { format: 'markdown', group_by: 'check', collapse: true } },
    checks: { ask: { type: 'human-input' as any } },
  } as any;

  function mkMsg(ts: string) {
    return {
      type: 'events_api',
      envelope_id: `env-msg-${ts}`,
      payload: { event: { type: 'message', channel: 'C1', ts, text: '<@UFAKEBOT> hello' } },
    };
  }
  function mkMention(ts: string) {
    return {
      type: 'events_api',
      envelope_id: `env-men-${ts}`,
      payload: { event: { type: 'app_mention', channel: 'C1', ts, text: '<@UFAKEBOT> hello' } },
    };
  }

  test('only one engine run for the same channel/ts', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new SlackSocketRunner(engine, cfg, {
      appToken: 'xapp',
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
    await (runner as any).handleMessage(JSON.stringify(mkMsg('4800.1')));
    await (runner as any).handleMessage(JSON.stringify(mkMention('4800.1')));
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
