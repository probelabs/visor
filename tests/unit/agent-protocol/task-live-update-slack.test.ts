import { SlackTaskLiveUpdateSink } from '../../../src/agent-protocol/task-live-update-slack';

describe('SlackTaskLiveUpdateSink', () => {
  it('posts the first progress update, then updates the same Slack message', async () => {
    const slack = {
      chat: {
        postMessage: jest.fn(async () => ({ ok: true, ts: '111.222' })),
        update: jest.fn(async () => ({ ok: true })),
        delete: jest.fn(async () => ({ ok: true })),
      },
    } as any;

    const sink = new SlackTaskLiveUpdateSink(slack, 'C123', '999.000');

    await sink.start();
    await sink.update('Still working');
    await sink.complete('Done');

    expect(slack.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(slack.chat.postMessage).toHaveBeenCalledWith({
      channel: 'C123',
      thread_ts: '999.000',
      text: 'Still working',
    });
    expect(slack.chat.update).toHaveBeenCalledTimes(1);
    expect(slack.chat.update).toHaveBeenNthCalledWith(1, {
      channel: 'C123',
      ts: '111.222',
      text: 'Done',
    });
    expect(slack.chat.delete).not.toHaveBeenCalled();
  });

  it('posts the final answer if the task finishes before the first progress update', async () => {
    const slack = {
      chat: {
        postMessage: jest.fn(async () => ({ ok: true, ts: '111.222' })),
        update: jest.fn(async () => ({ ok: true })),
        delete: jest.fn(async () => ({ ok: true })),
      },
    } as any;

    const sink = new SlackTaskLiveUpdateSink(slack, 'C123', '999.000');

    await sink.start();
    await sink.complete('Done');

    expect(slack.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(slack.chat.postMessage).toHaveBeenCalledWith({
      channel: 'C123',
      thread_ts: '999.000',
      text: 'Done',
    });
    expect(slack.chat.update).not.toHaveBeenCalled();
    expect(slack.chat.delete).not.toHaveBeenCalled();
  });

  it('falls back to a new Slack post when a progress update fails', async () => {
    const slack = {
      chat: {
        postMessage: jest
          .fn()
          .mockResolvedValueOnce({ ok: true, ts: '111.222' })
          .mockResolvedValueOnce({ ok: true, ts: '333.444' }),
        update: jest.fn(async () => ({ ok: false })),
        delete: jest.fn(async () => ({ ok: true })),
      },
    } as any;

    const sink = new SlackTaskLiveUpdateSink(slack, 'C123', '999.000');

    await sink.start();
    await sink.update('Still working');
    await sink.update('Still working again');

    expect(slack.chat.update).toHaveBeenCalledWith({
      channel: 'C123',
      ts: '111.222',
      text: 'Still working again',
    });
    expect(slack.chat.postMessage).toHaveBeenNthCalledWith(2, {
      channel: 'C123',
      thread_ts: '999.000',
      text: 'Still working again',
    });
    expect(slack.chat.delete).not.toHaveBeenCalled();
  });

  it('deletes the stale live update message when final fallback posts a new one', async () => {
    const slack = {
      chat: {
        postMessage: jest
          .fn()
          .mockResolvedValueOnce({ ok: true, ts: '111.222' })
          .mockResolvedValueOnce({ ok: true, ts: '333.444' }),
        update: jest.fn(async () => ({ ok: false, error: 'cant_update_message' })),
        delete: jest.fn(async () => ({ ok: true })),
      },
    } as any;

    const sink = new SlackTaskLiveUpdateSink(slack, 'C123', '999.000');

    await sink.start();
    await sink.update('Still working');
    await sink.complete('Done');

    expect(slack.chat.update).toHaveBeenCalledWith({
      channel: 'C123',
      ts: '111.222',
      text: 'Done',
    });
    expect(slack.chat.postMessage).toHaveBeenNthCalledWith(2, {
      channel: 'C123',
      thread_ts: '999.000',
      text: 'Done',
    });
    expect(slack.chat.delete).toHaveBeenCalledWith({
      channel: 'C123',
      ts: '111.222',
    });
  });
});
