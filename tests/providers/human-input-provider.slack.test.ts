import { EventBus } from '../../src/event-bus/event-bus';
import { HumanInputCheckProvider } from '../../src/providers/human-input-check-provider';
import type { PRInfo } from '../../src/pr-analyzer';
import { SlackFrontend } from '../../src/frontends/slack-frontend';
import { getPromptStateManager, resetPromptStateManager } from '../../src/slack/prompt-state';

function prInfo(): PRInfo {
  return {
    number: 1,
    title: 't',
    body: '',
    author: 'u',
    base: 'main',
    head: 'feature',
    files: [],
    totalAdditions: 0,
    totalDeletions: 0,
    isGitRepository: true,
    workingDirectory: process.cwd(),
  } as any;
}

function fakeSlack() {
  const chat = {
    postMessage: jest.fn(async (_req: any) => ({ ts: '234.567', message: { ts: '234.567' } })),
    update: jest.fn(async (_req: any) => ({})),
  };
  return { chat } as any;
}

describe('human-input provider — Slack pause/resume via event bus', () => {
  beforeEach(() => {
    resetPromptStateManager();
  });

  test('first event emits HumanInputRequested and second event resumes with answer', async () => {
    const bus = new EventBus();
    const slack = fakeSlack();
    // Start Slack frontend to handle HumanInputRequested (it will only update
    // prompt-state; it no longer posts the prompt message to Slack).
    const fe = new SlackFrontend({ defaultChannel: 'C1', debounceMs: 0 });
    const webhookMap1 = new Map<string, unknown>();
    webhookMap1.set('/bots/slack/support', {
      event: { type: 'app_mention', channel: 'C1', ts: '111.222', text: 'please start' },
    });
    fe.start({
      eventBus: bus,
      logger: console as any,
      config: { slack: { endpoint: '/bots/slack/support' } },
      run: { runId: 'runA' },
      webhookContext: { webhookData: webhookMap1 },
    } as any);
    (fe as any).getSlack = () => slack;

    const provider = new HumanInputCheckProvider();
    const cfg = {
      type: 'human-input',
      prompt: 'Your name?',
      endpoint: '/bots/slack/support',
    } as any;

    // First call: no waiting yet → provider emits HumanInputRequested; frontend posts prompt and sets waiting
    const res1 = await provider.execute(prInfo(), cfg, undefined, {
      eventBus: bus,
      webhookContext: { webhookData: webhookMap1 },
    } as any);
    // Frontend should not post a prompt message; it only records waiting state.
    expect(slack.chat.postMessage).not.toHaveBeenCalled();
    const mgr = getPromptStateManager();
    expect(mgr.getWaiting('C1', '111.222')).toBeDefined();
    // Provider now returns a fatal awaiting issue to pause the run
    expect(Array.isArray(res1.issues)).toBe(true);
    expect(res1.issues!.length).toBe(1);
    expect(res1.issues?.[0].ruleId).toMatch(/execution_error/);

    // Second call: user replies in same thread — provider detects waiting and consumes reply
    const webhookMap2 = new Map<string, unknown>();
    webhookMap2.set('/bots/slack/support', {
      event: { type: 'app_mention', channel: 'C1', ts: '111.222', text: 'John Doe' },
    });
    const res2 = await provider.execute(prInfo(), cfg, undefined, {
      eventBus: bus,
      webhookContext: { webhookData: webhookMap2 },
    } as any);

    // Should clear waiting and produce output text
    expect(mgr.getWaiting('C1', '111.222')).toBeUndefined();
    // @ts-expect-error output is added in provider
    expect(res2.output?.text).toContain('John Doe');
  });
});
