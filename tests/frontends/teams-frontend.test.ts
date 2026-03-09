// Teams frontend EventBus tests.
// Mirrors the pattern from whatsapp-frontend.test.ts:
// - Fake TeamsClient with jest.fn() API stubs
// - EventBus emission to trigger handlers
// - Verify correct Teams API calls

jest.mock('botbuilder', () => {
  return {
    CloudAdapter: jest.fn().mockImplementation(() => ({
      continueConversationAsync: jest.fn(),
      onTurnError: null,
      process: jest.fn(),
    })),
    ConfigurationBotFrameworkAuthentication: jest.fn(),
    TurnContext: {
      getConversationReference: jest.fn(),
    },
    MessageFactory: {
      text: jest.fn(t => ({ type: 'message', text: t })),
    },
    ActivityTypes: { Message: 'message' },
  };
});

import { EventBus } from '../../src/event-bus/event-bus';
import { TeamsFrontend } from '../../src/frontends/teams-frontend';

function makeFakeTeams() {
  return {
    sendMessage: jest.fn(async () => ({ ok: true, activityId: 'act.reply1' })),
    getAdapter: jest.fn(() => ({})),
    getAppId: jest.fn(() => 'test-app-id'),
  } as any;
}

const fakeConversationRef = {
  activityId: 'act.msg1',
  bot: { id: 'bot-id', name: 'Bot' },
  channelId: 'msteams',
  conversation: { id: 'conv-1' },
  serviceUrl: 'https://smba.trafficmanager.net/teams/',
};

function makeCtx(
  bus: EventBus,
  teams: any,
  opts: {
    conversationId?: string;
    activityId?: string;
    checks?: Record<string, any>;
  } = {}
) {
  const activityId = opts.activityId ?? 'act.msg1';
  const map = new Map<string, unknown>();
  map.set('/bots/teams/message', {
    event: {
      type: 'teams_message',
      conversation_id: opts.conversationId ?? 'conv-1',
      activity_id: activityId,
      text: 'Hello bot',
      from_id: 'user-1',
      from_name: 'Test User',
    },
    teams_conversation: {
      transport: 'teams',
      thread: { id: 'conv-1' },
      messages: [],
      current: { role: 'user', text: 'Hello bot', timestamp: '2024-01-01T00:00:00.000Z' },
      attributes: {},
    },
    teams_conversation_reference: fakeConversationRef,
  });

  const fe = new TeamsFrontend();
  fe.start({
    eventBus: bus,
    logger: console as any,
    config: {
      checks: opts.checks ?? {
        reply: { type: 'ai', schema: 'text' },
      },
    },
    run: { runId: 'r1' },
    webhookContext: { webhookData: map },
    teams,
    teamsClient: teams,
  } as any);

  // Inject fake teams client
  (fe as any).getTeams = () => teams;

  return fe;
}

describe('TeamsFrontend (event-bus)', () => {
  test('sends direct reply for AI checks with simple schemas', async () => {
    const bus = new EventBus();
    const teams = makeFakeTeams();
    makeCtx(bus, teams);

    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'reply',
      scope: [],
      result: { issues: [], output: { text: 'Hello from AI!' } },
    });

    expect(teams.sendMessage).toHaveBeenCalledTimes(1);
    const call = teams.sendMessage.mock.calls[0][0];
    expect(call.conversationReference).toEqual(fakeConversationRef);
    expect(call.text).toContain('Hello from AI!');
    expect(call.replyToActivityId).toBe('act.msg1');
  });

  test('does not send for non-AI / structured schema checks', async () => {
    const bus = new EventBus();
    const teams = makeFakeTeams();
    makeCtx(bus, teams, {
      checks: {
        jsonRouter: {
          type: 'ai',
          schema: { type: 'object', properties: { intent: { type: 'string' } } },
        },
        logStep: { type: 'log', group: 'other' },
      },
    });

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

    expect(teams.sendMessage).not.toHaveBeenCalled();
  });

  test('sends reply for workflow checks with output.text', async () => {
    const bus = new EventBus();
    const teams = makeFakeTeams();
    makeCtx(bus, teams, {
      checks: {
        chat: { type: 'workflow', workflow: 'assistant' },
      },
    });

    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'chat',
      scope: [],
      result: { issues: [], output: { text: 'Workflow response' } },
    });

    expect(teams.sendMessage).toHaveBeenCalledTimes(1);
    const call = teams.sendMessage.mock.calls[0][0];
    expect(call.text).toContain('Workflow response');
  });

  test('sends error notice on CheckErrored', async () => {
    const bus = new EventBus();
    const teams = makeFakeTeams();
    makeCtx(bus, teams);

    await bus.emit({
      type: 'CheckErrored',
      checkId: 'reply',
      scope: [],
      error: { message: 'AI provider timeout' },
    });

    expect(teams.sendMessage).toHaveBeenCalledTimes(1);
    const call = teams.sendMessage.mock.calls[0][0];
    expect(call.conversationReference).toEqual(fakeConversationRef);
    expect(call.text).toContain('Check failed');
    expect(call.text).toContain('AI provider timeout');
    expect(call.replyToActivityId).toBe('act.msg1');
  });

  test('does not send duplicate errors', async () => {
    const bus = new EventBus();
    const teams = makeFakeTeams();
    makeCtx(bus, teams);

    await bus.emit({
      type: 'CheckErrored',
      checkId: 'reply',
      scope: [],
      error: { message: 'err1' },
    });
    await bus.emit({
      type: 'CheckErrored',
      checkId: 'reply',
      scope: [],
      error: { message: 'err2' },
    });

    expect(teams.sendMessage).toHaveBeenCalledTimes(1);
  });

  test('skips reply when conversation reference is missing', async () => {
    const bus = new EventBus();
    const teams = makeFakeTeams();

    // Empty webhook data (no inbound event)
    const fe = new TeamsFrontend();
    fe.start({
      eventBus: bus,
      logger: console as any,
      config: { checks: { reply: { type: 'ai', schema: 'text' } } },
      run: { runId: 'r1' },
      webhookContext: { webhookData: new Map() },
      teams,
      teamsClient: teams,
    } as any);
    (fe as any).getTeams = () => teams;

    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'reply',
      scope: [],
      result: { issues: [], output: { text: 'Hello!' } },
    });

    expect(teams.sendMessage).not.toHaveBeenCalled();
  });

  test('skips internal criticality checks', async () => {
    const bus = new EventBus();
    const teams = makeFakeTeams();
    makeCtx(bus, teams, {
      checks: {
        internal: { type: 'ai', schema: 'text', criticality: 'internal' },
      },
    });

    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'internal',
      scope: [],
      result: { issues: [], output: { text: 'Should not be sent' } },
    });

    expect(teams.sendMessage).not.toHaveBeenCalled();
  });

  test('stop() unsubscribes all handlers', async () => {
    const bus = new EventBus();
    const teams = makeFakeTeams();
    const fe = makeCtx(bus, teams);

    fe.stop();

    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'reply',
      scope: [],
      result: { issues: [], output: { text: 'After stop' } },
    });

    expect(teams.sendMessage).not.toHaveBeenCalled();
  });

  test('no-op on CheckScheduled (no Teams equivalent of reactions)', async () => {
    const bus = new EventBus();
    const teams = makeFakeTeams();
    makeCtx(bus, teams);

    await bus.emit({ type: 'CheckScheduled', checkId: 'reply', scope: [] });

    expect(teams.sendMessage).not.toHaveBeenCalled();
  });

  test('skips reply when output.text is empty/whitespace', async () => {
    const bus = new EventBus();
    const teams = makeFakeTeams();
    makeCtx(bus, teams);

    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'reply',
      scope: [],
      result: { issues: [], output: { text: '   ' } },
    });

    expect(teams.sendMessage).not.toHaveBeenCalled();
  });

  test('skips reply when output is null', async () => {
    const bus = new EventBus();
    const teams = makeFakeTeams();
    makeCtx(bus, teams);

    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'reply',
      scope: [],
      result: { issues: [], output: null },
    });

    expect(teams.sendMessage).not.toHaveBeenCalled();
  });

  test('skips reply for unknown check ID', async () => {
    const bus = new EventBus();
    const teams = makeFakeTeams();
    makeCtx(bus, teams);

    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'nonexistent',
      scope: [],
      result: { issues: [], output: { text: 'Should not send' } },
    });

    expect(teams.sendMessage).not.toHaveBeenCalled();
  });

  test('normalizes literal \\n escape sequences in output', async () => {
    const bus = new EventBus();
    const teams = makeFakeTeams();
    makeCtx(bus, teams);

    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'reply',
      scope: [],
      result: { issues: [], output: { text: 'line1\\nline2\\nline3' } },
    });

    const call = teams.sendMessage.mock.calls[0][0];
    expect(call.text).toContain('line1\nline2\nline3');
  });

  test('appends _rawOutput when present', async () => {
    const bus = new EventBus();
    const teams = makeFakeTeams();
    makeCtx(bus, teams);

    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'reply',
      scope: [],
      result: { issues: [], output: { text: 'Main text', _rawOutput: 'Extra raw content' } },
    });

    const call = teams.sendMessage.mock.calls[0][0];
    expect(call.text).toContain('Main text');
    expect(call.text).toContain('Extra raw content');
  });

  test('falls back to content field for AI text schema checks', async () => {
    const bus = new EventBus();
    const teams = makeFakeTeams();
    makeCtx(bus, teams);

    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'reply',
      scope: [],
      result: { issues: [], content: 'Content fallback text' },
    });

    const call = teams.sendMessage.mock.calls[0][0];
    expect(call.text).toContain('Content fallback text');
  });

  test('sends reply for log checks with group=chat', async () => {
    const bus = new EventBus();
    const teams = makeFakeTeams();
    makeCtx(bus, teams, {
      checks: {
        chatLog: { type: 'log', group: 'chat' },
      },
    });

    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'chatLog',
      scope: [],
      result: { issues: [], logOutput: 'Chat log message' },
    });

    expect(teams.sendMessage).toHaveBeenCalledTimes(1);
    const call = teams.sendMessage.mock.calls[0][0];
    expect(call.text).toContain('Chat log message');
  });

  test('sends Shutdown error message', async () => {
    const bus = new EventBus();
    const teams = makeFakeTeams();
    makeCtx(bus, teams);

    await bus.emit({
      type: 'Shutdown',
      error: { message: 'Fatal crash' },
    });

    expect(teams.sendMessage).toHaveBeenCalledTimes(1);
    const call = teams.sendMessage.mock.calls[0][0];
    expect(call.text).toContain('Run failed');
    expect(call.text).toContain('Fatal crash');
  });

  test('Shutdown error does not send if error already notified', async () => {
    const bus = new EventBus();
    const teams = makeFakeTeams();
    makeCtx(bus, teams);

    await bus.emit({
      type: 'CheckErrored',
      checkId: 'reply',
      scope: [],
      error: { message: 'err1' },
    });
    await bus.emit({
      type: 'Shutdown',
      error: { message: 'Fatal' },
    });

    expect(teams.sendMessage).toHaveBeenCalledTimes(1);
  });

  test('handles send failure gracefully', async () => {
    const bus = new EventBus();
    const teams = makeFakeTeams();
    teams.sendMessage.mockResolvedValue({ ok: false, error: 'Rate limited' });
    makeCtx(bus, teams);

    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'reply',
      scope: [],
      result: { issues: [], output: { text: 'Hello!' } },
    });

    expect(teams.sendMessage).toHaveBeenCalledTimes(1);
  });

  test('skips AI checks with non-simple schemas', async () => {
    const bus = new EventBus();
    const teams = makeFakeTeams();
    makeCtx(bus, teams, {
      checks: {
        custom: { type: 'ai', schema: 'custom-format' },
      },
    });

    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'custom',
      scope: [],
      result: { issues: [], output: { text: 'Should not send' } },
    });

    expect(teams.sendMessage).not.toHaveBeenCalled();
  });

  test('sends for AI checks with code-review schema', async () => {
    const bus = new EventBus();
    const teams = makeFakeTeams();
    makeCtx(bus, teams, {
      checks: {
        review: { type: 'ai', schema: 'code-review' },
      },
    });

    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'review',
      scope: [],
      result: { issues: [], output: { text: 'Code review result' } },
    });

    expect(teams.sendMessage).toHaveBeenCalledTimes(1);
  });

  test('sends for AI checks with markdown schema', async () => {
    const bus = new EventBus();
    const teams = makeFakeTeams();
    makeCtx(bus, teams, {
      checks: {
        doc: { type: 'ai', schema: 'markdown' },
      },
    });

    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'doc',
      scope: [],
      result: { issues: [], output: { text: 'Markdown output' } },
    });

    expect(teams.sendMessage).toHaveBeenCalledTimes(1);
  });
});
