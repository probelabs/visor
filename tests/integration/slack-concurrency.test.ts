import { SlackSocketRunner } from '../../src/slack/socket-runner';
import { StateMachineExecutionEngine } from '../../src/state-machine-execution-engine';
import type { VisorConfig } from '../../src/types/config';
import { RateLimiter } from '../../src/slack/rate-limiter';

describe('Slack concurrency with SocketRunner', () => {
  const cfg: VisorConfig = {
    version: '1.0',
    output: { pr_comment: { format: 'markdown', group_by: 'check', collapse: true } },
    checks: { noop: { type: 'noop' as any } },
  } as any;

  beforeEach(() => {
    jest.spyOn((StateMachineExecutionEngine as any).prototype, 'executeChecks').mockResolvedValue({
      results: { default: [] },
      statistics: {
        totalChecks: 1,
        checksByGroup: {},
        issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
      },
    });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function mkEnv(channel: string, ts: string, text: string) {
    return {
      type: 'events_api',
      envelope_id: `env-${channel}-${ts}`,
      payload: { event: { type: 'app_mention', channel, ts, text } },
    };
  }

  test('different threads dispatch independently (two cold runs)', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new SlackSocketRunner(engine, cfg, {
      appToken: 'xapp-test',
      endpoint: '/bots/slack/support',
    });

    const p1 = (runner as any).handleMessage(JSON.stringify(mkEnv('C1', '111.100', 'first')));
    const p2 = (runner as any).handleMessage(JSON.stringify(mkEnv('C2', '222.200', 'second')));
    await Promise.all([p1, p2]);

    const coldSpy = (StateMachineExecutionEngine as any).prototype.executeChecks as jest.Mock;
    expect(coldSpy).toHaveBeenCalledTimes(2);
  });

  test('same thread is serialized when channel concurrent_requests=1', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new SlackSocketRunner(engine, cfg, {
      appToken: 'xapp-test',
      endpoint: '/bots/slack/support',
    });

    // Inject limiter directly (avoid start()) and stub check() to allow first, block second
    const limiter = new RateLimiter({ enabled: true, channel: { concurrent_requests: 1 } });
    jest
      .spyOn(limiter, 'check')
      .mockResolvedValueOnce({ allowed: true })
      .mockResolvedValueOnce({
        allowed: false,
        blocked_by: 'channel' as any,
        remaining: 0,
        limit: 1,
        reset: Date.now() + 1000,
      });
    jest.spyOn(limiter, 'release').mockResolvedValue();
    (runner as any).limiter = limiter;

    await (runner as any).handleMessage(JSON.stringify(mkEnv('C1', '333.300', 'first')));
    await (runner as any).handleMessage(JSON.stringify(mkEnv('C1', '333.301', 'second')));

    const coldSpy = (StateMachineExecutionEngine as any).prototype.executeChecks as jest.Mock;
    // Only one execution; second was rate-limited and dropped
    expect(coldSpy).toHaveBeenCalledTimes(1);
    // Stop limiter internal interval to silence open handle warning
    await limiter.shutdown();
  });
});
