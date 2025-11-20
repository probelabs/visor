import { EventBus } from '../../src/event-bus/event-bus';
import { SlackFrontend } from '../../src/frontends/slack-frontend';

function makeFakeSlack() {
  const chat = {
    // underscore unused param to satisfy lint
    postMessage: jest.fn(async (_req: any) => ({ ts: '123.456', message: { ts: '123.456' } })),
    update: jest.fn(async (_req: any) => ({})),
  };
  return { chat } as any;
}

describe('SlackFrontend (event-bus)', () => {
  test('posts a message on first CheckCompleted and updates on subsequent completions', async () => {
    const bus = new EventBus();
    const slack = makeFakeSlack();
    const fe = new SlackFrontend({ defaultChannel: 'C1', debounceMs: 0 });
    fe.start({
      eventBus: bus,
      logger: console as any,
      config: { checks: { security: { group: 'review', schema: 'code-review' } } },
      run: { runId: 'r1' },
      // Inject fake Slack client directly
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any as any);

    // Inject slack after start (context is captured lexically)
    // We rely on SlackFrontend.getSlack reading from ctx at call time
    (fe as any).getSlack = () => slack;

    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'security',
      scope: [],
      result: { issues: [], content: 'Body 1' },
    });
    expect(slack.chat.postMessage).toHaveBeenCalledTimes(1);
    expect(slack.chat.update).not.toHaveBeenCalled();

    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'security',
      scope: [],
      result: { issues: [], content: 'Body 2' },
    });
    expect(slack.chat.update).toHaveBeenCalledTimes(1);
  });

  test('separate groups render to the same channel by default', async () => {
    const bus = new EventBus();
    const slack = makeFakeSlack();
    const fe = new SlackFrontend({ defaultChannel: 'C1', debounceMs: 0 });
    fe.start({
      eventBus: bus,
      logger: console as any,
      config: { checks: { overview: { group: 'overview' }, security: { group: 'review' } } },
      run: { runId: 'r2' },
    } as any);
    (fe as any).getSlack = () => slack;

    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'overview',
      scope: [],
      result: { issues: [], content: 'OV' },
    });
    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'security',
      scope: [],
      result: { issues: [], content: 'SEC' },
    });

    // Two posts because two groups (overview, review). Both to C1
    expect(slack.chat.postMessage).toHaveBeenCalledTimes(2);
    const channels = slack.chat.postMessage.mock.calls.map((c: any[]) => c[0].channel);
    expect(channels.sort()).toEqual(['C1', 'C1']);
  });
});
