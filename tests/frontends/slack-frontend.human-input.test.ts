import { EventBus } from '../../src/event-bus/event-bus';
import { SlackFrontend } from '../../src/frontends/slack-frontend';
import { getPromptStateManager, resetPromptStateManager } from '../../src/slack/prompt-state';

function makeFakeSlack() {
  const chat = {
    postMessage: jest.fn(async (_req: any) => ({ ts: '234.567', message: { ts: '234.567' } })),
    update: jest.fn(async (_req: any) => ({})),
  };
  return { chat } as any;
}

describe('SlackFrontend HumanInputRequested', () => {
  beforeEach(() => {
    resetPromptStateManager();
  });

  test('registers waiting state for thread without posting prompt message', async () => {
    const bus = new EventBus();
    const slack = makeFakeSlack();
    const fe = new SlackFrontend({ defaultChannel: 'C1', debounceMs: 0 });
    const webhookMap = new Map<string, unknown>();
    webhookMap.set('/bots/slack/support', {
      event: { type: 'app_mention', channel: 'C1', ts: '111.222', text: 'hey' },
    });
    fe.start({
      eventBus: bus,
      logger: console as any,
      config: { slack: { endpoint: '/bots/slack/support' } },
      run: { runId: 'run1' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      webhookContext: { webhookData: webhookMap } as any,
    } as any);
    (fe as any).getSlack = () => slack;
    await bus.emit({
      type: 'HumanInputRequested',
      checkId: 'ask',
      prompt: 'What is your name?',
    });

    // Slack frontend now only records waiting state; it does not post the
    // human-input prompt as a separate Slack message.
    expect(slack.chat.postMessage).not.toHaveBeenCalled();

    const mgr = getPromptStateManager();
    const waiting = mgr.getWaiting('C1', '111.222');
    expect(waiting).toBeDefined();
    expect(waiting?.checkName).toBe('ask');
    expect(waiting?.prompt).toContain('What is your name?');

    // Now simulate SnapshotSaved and ensure snapshotPath is attached
    await bus.emit({
      type: 'SnapshotSaved',
      checkId: 'ask',
      channel: 'C1',
      threadTs: '111.222',
      threadKey: 'C1:111.222',
      filePath: '/tmp/snap.json',
    });
    const waiting2 = mgr.getWaiting('C1', '111.222');
    expect(waiting2?.snapshotPath).toBe('/tmp/snap.json');
  });
});
