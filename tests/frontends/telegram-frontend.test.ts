// Telegram frontend EventBus tests.
// Mirrors the pattern from slack-frontend.test.ts:
// - Fake TelegramClient with jest.fn() API stubs
// - EventBus emission to trigger handlers
// - Verify correct Telegram API calls

import { EventBus } from '../../src/event-bus/event-bus';
import { TelegramFrontend } from '../../src/frontends/telegram-frontend';

// Build a fake TelegramClient matching the real interface
function makeFakeTelegram() {
  return {
    sendMessage: jest.fn(async () => ({ ok: true, message_id: 100 })),
    sendDocument: jest.fn(async () => ({ ok: true, message_id: 101 })),
    setMessageReaction: jest.fn(async () => true),
    getBotInfo: jest.fn(() => ({ id: 999, is_bot: true, first_name: 'Bot', username: 'test_bot' })),
    init: jest.fn(async () => ({ id: 999, is_bot: true, first_name: 'Bot', username: 'test_bot' })),
  } as any;
}

function makeCtx(
  bus: EventBus,
  telegram: any,
  opts: {
    chatId?: number;
    messageId?: number;
    checks?: Record<string, any>;
    messageThreadId?: number;
  } = {},
) {
  const chatId = opts.chatId ?? 12345;
  const messageId = opts.messageId ?? 42;
  const map = new Map<string, unknown>();
  map.set('/bots/telegram/message', {
    event: {
      type: 'message',
      chat_id: chatId,
      message_id: messageId,
      text: 'Hello bot',
      from: { id: 777, is_bot: false, first_name: 'User' },
      chat: { id: chatId, type: 'private' },
      ...(opts.messageThreadId ? { message_thread_id: opts.messageThreadId } : {}),
    },
  });

  const fe = new TelegramFrontend();
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
    telegram,
  } as any);

  // Inject fake telegram client
  (fe as any).getTelegram = () => telegram;

  return fe;
}

describe('TelegramFrontend (event-bus)', () => {
  test('posts direct reply for AI checks with simple schemas', async () => {
    const bus = new EventBus();
    const telegram = makeFakeTelegram();
    makeCtx(bus, telegram);

    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'reply',
      scope: [],
      result: { issues: [], output: { text: 'Hello from AI!' } },
    });

    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    const call = telegram.sendMessage.mock.calls[0][0];
    expect(call.chat_id).toBe(12345);
    expect(call.text).toContain('Hello from AI!');
    expect(call.parse_mode).toBe('HTML');
    expect(call.reply_to_message_id).toBe(42);
  });

  test('does not post for non-AI / structured schema checks', async () => {
    const bus = new EventBus();
    const telegram = makeFakeTelegram();
    makeCtx(bus, telegram, {
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

    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  test('posts reply for workflow checks with output.text', async () => {
    const bus = new EventBus();
    const telegram = makeFakeTelegram();
    makeCtx(bus, telegram, {
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

    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    const call = telegram.sendMessage.mock.calls[0][0];
    expect(call.text).toContain('Workflow response');
  });

  test('posts error notice on CheckErrored', async () => {
    const bus = new EventBus();
    const telegram = makeFakeTelegram();
    makeCtx(bus, telegram);

    await bus.emit({
      type: 'CheckErrored',
      checkId: 'reply',
      scope: [],
      error: { message: 'AI provider timeout' },
    });

    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    const call = telegram.sendMessage.mock.calls[0][0];
    expect(call.text).toContain('Check failed');
    expect(call.text).toContain('AI provider timeout');
    expect(call.reply_to_message_id).toBe(42);
  });

  test('adds ack reaction on CheckScheduled', async () => {
    const bus = new EventBus();
    const telegram = makeFakeTelegram();
    makeCtx(bus, telegram);

    await bus.emit({ type: 'CheckScheduled', checkId: 'reply', scope: [] });

    expect(telegram.setMessageReaction).toHaveBeenCalledTimes(1);
    const call = telegram.setMessageReaction.mock.calls[0][0];
    expect(call.chat_id).toBe(12345);
    expect(call.message_id).toBe(42);
    expect(call.emoji).toBe('👀');
  });

  test('finalizes reaction (👀→👍) on StateTransition to Completed', async () => {
    const bus = new EventBus();
    const telegram = makeFakeTelegram();
    makeCtx(bus, telegram);

    // First ack
    await bus.emit({ type: 'CheckScheduled', checkId: 'reply', scope: [] });
    expect(telegram.setMessageReaction).toHaveBeenCalledTimes(1);

    // State transition to Completed
    await bus.emit({
      type: 'StateTransition',
      from: 'Running',
      to: 'Completed',
      scope: [],
    });

    expect(telegram.setMessageReaction).toHaveBeenCalledTimes(2);
    const finalCall = telegram.setMessageReaction.mock.calls[1][0];
    expect(finalCall.emoji).toBe('👍');
  });

  test('does not post duplicate errors', async () => {
    const bus = new EventBus();
    const telegram = makeFakeTelegram();
    makeCtx(bus, telegram);

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

    // Only first error should be posted
    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
  });

  test('does not ack own bot messages', async () => {
    const bus = new EventBus();
    const telegram = makeFakeTelegram();
    // Bot info id matches the from.id in the event
    telegram.getBotInfo.mockReturnValue({ id: 777, is_bot: true, first_name: 'Bot' });

    const map = new Map<string, unknown>();
    map.set('/bots/telegram/message', {
      event: {
        type: 'message',
        chat_id: 12345,
        message_id: 42,
        text: 'Hello',
        from: { id: 777, is_bot: true, first_name: 'Bot' },
      },
    });

    const fe = new TelegramFrontend();
    fe.start({
      eventBus: bus,
      logger: console as any,
      config: { checks: { reply: { type: 'ai', schema: 'text' } } },
      run: { runId: 'r1' },
      webhookContext: { webhookData: map },
      telegram,
    } as any);
    (fe as any).getTelegram = () => telegram;

    await bus.emit({ type: 'CheckScheduled', checkId: 'reply', scope: [] });

    // Should not ack own message
    expect(telegram.setMessageReaction).not.toHaveBeenCalled();
  });

  test('includes message_thread_id in reply for forum topics', async () => {
    const bus = new EventBus();
    const telegram = makeFakeTelegram();
    makeCtx(bus, telegram, {
      chatId: -100123,
      messageThreadId: 555,
      checks: { reply: { type: 'ai', schema: 'text' } },
    });

    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'reply',
      scope: [],
      result: { issues: [], output: { text: 'Forum reply' } },
    });

    expect(telegram.sendMessage).toHaveBeenCalledTimes(1);
    const call = telegram.sendMessage.mock.calls[0][0];
    expect(call.message_thread_id).toBe(555);
  });

  test('skips reply when chat_id is missing', async () => {
    const bus = new EventBus();
    const telegram = makeFakeTelegram();

    // Empty webhook data (no inbound event)
    const fe = new TelegramFrontend();
    fe.start({
      eventBus: bus,
      logger: console as any,
      config: { checks: { reply: { type: 'ai', schema: 'text' } } },
      run: { runId: 'r1' },
      webhookContext: { webhookData: new Map() },
      telegram,
    } as any);
    (fe as any).getTelegram = () => telegram;

    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'reply',
      scope: [],
      result: { issues: [], output: { text: 'Hello!' } },
    });

    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  test('skips internal criticality checks', async () => {
    const bus = new EventBus();
    const telegram = makeFakeTelegram();
    makeCtx(bus, telegram, {
      checks: {
        internal: { type: 'ai', schema: 'text', criticality: 'internal' },
      },
    });

    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'internal',
      scope: [],
      result: { issues: [], output: { text: 'Should not be posted' } },
    });

    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });

  test('stop() unsubscribes all handlers', async () => {
    const bus = new EventBus();
    const telegram = makeFakeTelegram();
    const fe = makeCtx(bus, telegram);

    fe.stop();

    // Emit events after stop — should not trigger anything
    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'reply',
      scope: [],
      result: { issues: [], output: { text: 'After stop' } },
    });

    expect(telegram.sendMessage).not.toHaveBeenCalled();
  });
});
