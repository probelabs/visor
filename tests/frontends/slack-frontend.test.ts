import { EventBus } from '../../src/event-bus/event-bus';
import { SlackFrontend } from '../../src/frontends/slack-frontend';
import { logger } from '../../src/logger';

function makeFakeSlack() {
  const chat = {
    // underscore unused param to satisfy lint
    postMessage: jest.fn(async (_req: any) => ({ ts: '123.456', message: { ts: '123.456' } })),
    update: jest.fn(async (_req: any) => ({})),
  };
  return { chat } as any;
}

describe('SlackFrontend (event-bus)', () => {
  afterEach(() => {
    logger.setSink(undefined);
  });

  test('posts direct reply for AI checks with simple schemas', async () => {
    const bus = new EventBus();
    const slack = makeFakeSlack();
    const fe = new SlackFrontend({ defaultChannel: 'C1', debounceMs: 0 });
    const map = new Map<string, unknown>();
    map.set('/bots/slack/support', {
      event: { type: 'app_mention', channel: 'C1', ts: '123.456', text: 'hi' },
    });
    fe.start({
      eventBus: bus,
      logger: console as any,
      config: {
        slack: { endpoint: '/bots/slack/support' },
        checks: {
          reply: { type: 'ai', group: 'chat', schema: 'plain' },
        },
      },
      run: { runId: 'r1' },
      webhookContext: { webhookData: map },
    } as any);
    (fe as any).getSlack = () => slack;

    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'reply',
      scope: [],
      result: { issues: [], output: { text: 'Hello!' } },
    });

    expect(slack.chat.postMessage).toHaveBeenCalledTimes(1);
    const [req] = slack.chat.postMessage.mock.calls[0];
    expect(req.channel).toBe('C1');
    expect(req.thread_ts).toBe('123.456');
    expect(req.text).toBe('Hello!');
  });

  test('appends task_id when telemetry is enabled in a tracked run', async () => {
    const bus = new EventBus();
    const slack = makeFakeSlack();
    const fe = new SlackFrontend({ defaultChannel: 'C1', debounceMs: 0 });
    const map = new Map<string, unknown>();
    map.set('/bots/slack/support', {
      event: { type: 'app_mention', channel: 'C1', ts: '123.456', text: 'hi' },
    });
    fe.start({
      eventBus: bus,
      logger: console as any,
      config: {
        slack: { endpoint: '/bots/slack/support', telemetry: { enabled: true } },
        checks: {
          reply: { type: 'ai', group: 'chat', schema: 'plain' },
        },
      },
      run: { runId: 'r1' },
      webhookContext: { webhookData: map },
    } as any);
    (fe as any).getSlack = () => slack;

    await logger.withTaskContext('task-123', async () => {
      await bus.emit({
        type: 'CheckCompleted',
        checkId: 'reply',
        scope: [],
        result: { issues: [], output: { text: 'Hello!' } },
      });
    });

    expect(slack.chat.postMessage).toHaveBeenCalledTimes(1);
    const [req] = slack.chat.postMessage.mock.calls[0];
    expect(req.text).toContain('`task_id: task-123`');
  });

  test('does not post a second direct reply when task live updates are enabled', async () => {
    const bus = new EventBus();
    const slack = makeFakeSlack();
    const fe = new SlackFrontend({ defaultChannel: 'C1', debounceMs: 0 });
    const map = new Map<string, unknown>();
    map.set('/bots/slack/support', {
      event: { type: 'app_mention', channel: 'C1', ts: '123.456', text: 'hi' },
    });
    fe.start({
      eventBus: bus,
      logger: console as any,
      config: {
        slack: { endpoint: '/bots/slack/support' },
        task_live_updates: { enabled: true },
        checks: {
          reply: { type: 'ai', group: 'chat', schema: 'plain' },
        },
      },
      run: { runId: 'r1' },
      webhookContext: { webhookData: map },
    } as any);
    (fe as any).getSlack = () => slack;

    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'reply',
      scope: [],
      result: { issues: [], output: { text: 'Hello!' } },
    });

    expect(slack.chat.postMessage).not.toHaveBeenCalled();
  });

  test('still posts the normal direct reply when task live updates are explicitly disabled', async () => {
    const bus = new EventBus();
    const slack = makeFakeSlack();
    const fe = new SlackFrontend({ defaultChannel: 'C1', debounceMs: 0 });
    const map = new Map<string, unknown>();
    map.set('/bots/slack/support', {
      event: { type: 'app_mention', channel: 'C1', ts: '123.456', text: 'hi' },
    });
    fe.start({
      eventBus: bus,
      logger: console as any,
      config: {
        slack: { endpoint: '/bots/slack/support' },
        task_live_updates: { enabled: false },
        checks: {
          reply: { type: 'ai', group: 'chat', schema: 'plain' },
        },
      },
      run: { runId: 'r1' },
      webhookContext: { webhookData: map },
    } as any);
    (fe as any).getSlack = () => slack;

    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'reply',
      scope: [],
      result: { issues: [], output: { text: 'Hello!' } },
    });

    expect(slack.chat.postMessage).toHaveBeenCalledTimes(1);
    const [req] = slack.chat.postMessage.mock.calls[0];
    expect(req.channel).toBe('C1');
    expect(req.thread_ts).toBe('123.456');
    expect(req.text).toBe('Hello!');
  });

  test('does not post for non-AI checks or structured schemas by default', async () => {
    const bus = new EventBus();
    const slack = makeFakeSlack();
    const fe = new SlackFrontend({ defaultChannel: 'C1', debounceMs: 0 });
    const map = new Map<string, unknown>();
    map.set('/bots/slack/support', {
      event: { type: 'app_mention', channel: 'C1', ts: '999.1', text: 'hi' },
    });
    fe.start({
      eventBus: bus,
      logger: console as any,
      config: {
        slack: { endpoint: '/bots/slack/support' },
        checks: {
          jsonRouter: {
            type: 'ai',
            group: 'chat',
            schema: {
              type: 'object',
              properties: { intent: { type: 'string' } },
              required: ['intent'],
            },
          },
          logStep: { type: 'log', group: 'other' },
        },
      },
      run: { runId: 'r2' },
      webhookContext: { webhookData: map },
    } as any);
    (fe as any).getSlack = () => slack;

    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'jsonRouter',
      scope: [],
      result: { issues: [], output: { intent: 'chat' } },
    });
    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'logStep',
      scope: [],
      result: { issues: [], output: { text: 'log' } },
    });

    expect(slack.chat.postMessage).not.toHaveBeenCalled();
  });

  test('posts reply for workflow checks with output.text', async () => {
    const bus = new EventBus();
    const slack = makeFakeSlack();
    const fe = new SlackFrontend({ defaultChannel: 'C1', debounceMs: 0 });
    const map = new Map<string, unknown>();
    map.set('/bots/slack/support', {
      event: { type: 'app_mention', channel: 'C1', ts: '777.1', text: 'hello' },
    });
    fe.start({
      eventBus: bus,
      logger: console as any,
      config: {
        slack: { endpoint: '/bots/slack/support' },
        checks: {
          chat: { type: 'workflow', workflow: 'assistant' },
        },
      },
      run: { runId: 'r4' },
      webhookContext: { webhookData: map },
    } as any);
    (fe as any).getSlack = () => slack;

    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'chat',
      scope: [],
      result: { issues: [], output: { text: 'AI response here', intent: 'chat' } },
    });

    expect(slack.chat.postMessage).toHaveBeenCalledTimes(1);
    const [req] = slack.chat.postMessage.mock.calls[0];
    expect(req.channel).toBe('C1');
    expect(req.thread_ts).toBe('777.1');
    expect(req.text).toBe('AI response here');
  });

  test('posts error fallback when workflow output.text is null but has system error issues', async () => {
    const bus = new EventBus();
    const slack = makeFakeSlack();
    const fe = new SlackFrontend({ defaultChannel: 'C1', debounceMs: 0 });
    const map = new Map<string, unknown>();
    map.set('/bots/slack/support', {
      event: { type: 'app_mention', channel: 'C1', ts: '888.1', text: 'do something' },
    });
    fe.start({
      eventBus: bus,
      logger: console as any,
      config: {
        slack: { endpoint: '/bots/slack/support' },
        checks: {
          chat: { type: 'workflow', workflow: 'assistant' },
        },
      },
      run: { runId: 'r5' },
      webhookContext: { webhookData: map },
    } as any);
    (fe as any).getSlack = () => slack;

    // Simulate: generate-response timed out, workflow output.text is null,
    // but error issues propagated up from the inner check
    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'chat',
      scope: [],
      result: {
        issues: [
          {
            file: 'system',
            line: 0,
            ruleId: 'system/ai-execution-error',
            message: 'AI review timed out after 1800000ms',
            severity: 'error',
            category: 'logic',
          },
        ],
        output: { text: null, intent: 'chat' },
      },
    });

    expect(slack.chat.postMessage).toHaveBeenCalledTimes(1);
    const [req] = slack.chat.postMessage.mock.calls[0];
    expect(req.text).toContain('timed out');
  });

  test('posts error notice for execution failures on completed checks', async () => {
    const bus = new EventBus();
    const slack = makeFakeSlack();
    const fe = new SlackFrontend({ defaultChannel: 'C1', debounceMs: 0 });
    const map = new Map<string, unknown>();
    map.set('/bots/slack/support', {
      event: { type: 'app_mention', channel: 'C1', ts: '555.777', text: 'hi' },
    });
    fe.start({
      eventBus: bus,
      logger: console as any,
      config: {
        slack: { endpoint: '/bots/slack/support' },
        checks: {
          cmd: { type: 'command' },
        },
      },
      run: { runId: 'r3' },
      webhookContext: { webhookData: map },
    } as any);
    (fe as any).getSlack = () => slack;

    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'cmd',
      scope: [],
      result: {
        issues: [
          {
            ruleId: 'cmd/command/timeout',
            message: 'Command execution timed out after 1000 milliseconds',
            severity: 'error',
            file: 'command',
            line: 0,
          },
        ],
      },
    });

    expect(slack.chat.postMessage).toHaveBeenCalledTimes(1);
    const [req] = slack.chat.postMessage.mock.calls[0];
    expect(req.text).toContain('Check failed');
    expect(req.text).toContain('Command execution timed out');
  });
});
