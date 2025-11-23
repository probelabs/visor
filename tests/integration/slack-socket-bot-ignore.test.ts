import { SlackSocketRunner } from '../../src/slack/socket-runner';
import { StateMachineExecutionEngine } from '../../src/state-machine-execution-engine';
import type { VisorConfig } from '../../src/types/config';

describe('Slack socket ignores bot messages', () => {
  const cfg: VisorConfig = {
    version: '1.0',
    output: { pr_comment: { format: 'markdown', group_by: 'check', collapse: true } },
    checks: { ask: { type: 'human-input' as any } },
  } as any;

  function botEnv() {
    return {
      type: 'events_api',
      envelope_id: 'env-bot',
      payload: {
        event: {
          type: 'message',
          channel: 'C1',
          ts: '1700.1',
          text: 'bot says',
          subtype: 'bot_message',
          bot_id: 'B123',
        },
      },
    };
  }

  test('no executeChecks for bot_message', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new SlackSocketRunner(engine, cfg, {
      appToken: 'xapp',
      endpoint: '/bots/slack/support',
      mentions: 'all',
      threads: 'required',
    });
    const spy = jest.spyOn((StateMachineExecutionEngine as any).prototype, 'executeChecks');
    await (runner as any).handleMessage(JSON.stringify(botEnv()));
    expect(spy).not.toHaveBeenCalled();
  });
});
