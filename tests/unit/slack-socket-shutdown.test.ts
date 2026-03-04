import { SlackSocketRunner } from '../../src/slack/socket-runner';
import { StateMachineExecutionEngine } from '../../src/state-machine-execution-engine';
import type { VisorConfig } from '../../src/types/config';

describe('SlackSocketRunner graceful shutdown', () => {
  const cfg: VisorConfig = {
    version: '1.0',
    output: { pr_comment: { format: 'markdown', group_by: 'check', collapse: true } },
    checks: { echo: { type: 'noop' as any } },
  } as any;

  function makeRunner(): SlackSocketRunner {
    const engine = new StateMachineExecutionEngine();
    return new SlackSocketRunner(engine, cfg, {
      appToken: 'xapp-test',
      endpoint: '/bots/slack/support',
      mentions: 'all',
      threads: 'any',
    });
  }

  function mockClient(runner: SlackSocketRunner): jest.Mock {
    const postMessage = jest.fn().mockResolvedValue({ ok: true });
    (runner as any).client = { chat: { postMessage } } as any;
    return postMessage;
  }

  test('sends shutdown message to tracked threads', async () => {
    const runner = makeRunner();
    const postMessage = mockClient(runner);

    // Simulate tracking two threads
    (runner as any).trackThread('C1', '1700.1');
    (runner as any).trackThread('C2', '1700.2');

    await runner.notifyActiveThreadsOfShutdown();

    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C1',
        thread_ts: '1700.1',
        text: expect.stringContaining('restarted'),
      })
    );
    expect(postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C2',
        thread_ts: '1700.2',
        text: expect.stringContaining('retry'),
      })
    );
  });

  test('does not send message to untracked (completed) threads', async () => {
    const runner = makeRunner();
    const postMessage = mockClient(runner);

    const key = (runner as any).trackThread('C1', '1700.1');
    (runner as any).untrackThread(key);

    await runner.notifyActiveThreadsOfShutdown();

    expect(postMessage).not.toHaveBeenCalled();
  });

  test('no-op when no active threads', async () => {
    const runner = makeRunner();
    const postMessage = mockClient(runner);

    await runner.notifyActiveThreadsOfShutdown();

    expect(postMessage).not.toHaveBeenCalled();
  });

  test('no-op when no client', async () => {
    const runner = makeRunner();
    // client is not set (default)

    (runner as any).trackThread('C1', '1700.1');

    // Should not throw
    await runner.notifyActiveThreadsOfShutdown();
  });

  test('timeout prevents blocking on slow postMessage', async () => {
    jest.useFakeTimers();
    try {
      const runner = makeRunner();
      const postMessage = jest
        .fn()
        .mockImplementation(() => new Promise(resolve => setTimeout(resolve, 60000)));
      (runner as any).client = { chat: { postMessage } } as any;

      (runner as any).trackThread('C1', '1700.1');

      const p = runner.notifyActiveThreadsOfShutdown(200);
      jest.advanceTimersByTime(200);
      await p;

      expect(postMessage).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test('failure in one thread does not prevent notifying others', async () => {
    const runner = makeRunner();
    const postMessage = jest
      .fn()
      .mockRejectedValueOnce(new Error('channel_not_found'))
      .mockResolvedValueOnce({ ok: true });
    (runner as any).client = { chat: { postMessage } } as any;

    (runner as any).trackThread('C1', '1700.1');
    (runner as any).trackThread('C2', '1700.2');

    // Should not throw
    await runner.notifyActiveThreadsOfShutdown();

    expect(postMessage).toHaveBeenCalledTimes(2);
  });

  test('message does not mention product name', async () => {
    const runner = makeRunner();
    const postMessage = mockClient(runner);

    (runner as any).trackThread('C1', '1700.1');
    await runner.notifyActiveThreadsOfShutdown();

    const sentText = postMessage.mock.calls[0][0].text as string;
    expect(sentText.toLowerCase()).not.toContain('visor');
  });
});
