// WhatsApp frontend EventBus tests.
// Mirrors the pattern from telegram-frontend.test.ts:
// - Fake WhatsAppClient with jest.fn() API stubs
// - EventBus emission to trigger handlers
// - Verify correct WhatsApp API calls

import { EventBus } from '../../src/event-bus/event-bus';
import { WhatsAppFrontend } from '../../src/frontends/whatsapp-frontend';

function makeFakeWhatsApp() {
  return {
    sendMessage: jest.fn(async () => ({ ok: true, messageId: 'wamid.reply1' })),
    markAsRead: jest.fn(async () => ({ ok: true })),
    getPhoneNumberId: jest.fn(() => '15559876543'),
  } as any;
}

function makeCtx(
  bus: EventBus,
  whatsapp: any,
  opts: {
    from?: string;
    messageId?: string;
    checks?: Record<string, any>;
  } = {}
) {
  const from = opts.from ?? '15551234567';
  const messageId = opts.messageId ?? 'wamid.msg1';
  const map = new Map<string, unknown>();
  map.set('/bots/whatsapp/message', {
    event: {
      type: 'whatsapp_message',
      from,
      message_id: messageId,
      text: 'Hello bot',
    },
  });

  const fe = new WhatsAppFrontend();
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
    whatsapp,
  } as any);

  // Inject fake whatsapp client
  (fe as any).getWhatsApp = () => whatsapp;

  return fe;
}

describe('WhatsAppFrontend (event-bus)', () => {
  test('sends direct reply for AI checks with simple schemas', async () => {
    const bus = new EventBus();
    const whatsapp = makeFakeWhatsApp();
    makeCtx(bus, whatsapp);

    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'reply',
      scope: [],
      result: { issues: [], output: { text: 'Hello from AI!' } },
    });

    expect(whatsapp.sendMessage).toHaveBeenCalledTimes(1);
    const call = whatsapp.sendMessage.mock.calls[0][0];
    expect(call.to).toBe('15551234567');
    expect(call.text).toContain('Hello from AI!');
    expect(call.replyToMessageId).toBe('wamid.msg1');
  });

  test('does not send for non-AI / structured schema checks', async () => {
    const bus = new EventBus();
    const whatsapp = makeFakeWhatsApp();
    makeCtx(bus, whatsapp, {
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

    expect(whatsapp.sendMessage).not.toHaveBeenCalled();
  });

  test('sends reply for workflow checks with output.text', async () => {
    const bus = new EventBus();
    const whatsapp = makeFakeWhatsApp();
    makeCtx(bus, whatsapp, {
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

    expect(whatsapp.sendMessage).toHaveBeenCalledTimes(1);
    const call = whatsapp.sendMessage.mock.calls[0][0];
    expect(call.text).toContain('Workflow response');
  });

  test('sends error notice on CheckErrored', async () => {
    const bus = new EventBus();
    const whatsapp = makeFakeWhatsApp();
    makeCtx(bus, whatsapp);

    await bus.emit({
      type: 'CheckErrored',
      checkId: 'reply',
      scope: [],
      error: { message: 'AI provider timeout' },
    });

    expect(whatsapp.sendMessage).toHaveBeenCalledTimes(1);
    const call = whatsapp.sendMessage.mock.calls[0][0];
    expect(call.to).toBe('15551234567');
    expect(call.text).toContain('Check failed');
    expect(call.text).toContain('AI provider timeout');
    expect(call.replyToMessageId).toBe('wamid.msg1');
  });

  test('does not send duplicate errors', async () => {
    const bus = new EventBus();
    const whatsapp = makeFakeWhatsApp();
    makeCtx(bus, whatsapp);

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

    expect(whatsapp.sendMessage).toHaveBeenCalledTimes(1);
  });

  test('skips reply when from number is missing', async () => {
    const bus = new EventBus();
    const whatsapp = makeFakeWhatsApp();

    // Empty webhook data (no inbound event)
    const fe = new WhatsAppFrontend();
    fe.start({
      eventBus: bus,
      logger: console as any,
      config: { checks: { reply: { type: 'ai', schema: 'text' } } },
      run: { runId: 'r1' },
      webhookContext: { webhookData: new Map() },
      whatsapp,
    } as any);
    (fe as any).getWhatsApp = () => whatsapp;

    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'reply',
      scope: [],
      result: { issues: [], output: { text: 'Hello!' } },
    });

    expect(whatsapp.sendMessage).not.toHaveBeenCalled();
  });

  test('skips internal criticality checks', async () => {
    const bus = new EventBus();
    const whatsapp = makeFakeWhatsApp();
    makeCtx(bus, whatsapp, {
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

    expect(whatsapp.sendMessage).not.toHaveBeenCalled();
  });

  test('stop() unsubscribes all handlers', async () => {
    const bus = new EventBus();
    const whatsapp = makeFakeWhatsApp();
    const fe = makeCtx(bus, whatsapp);

    fe.stop();

    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'reply',
      scope: [],
      result: { issues: [], output: { text: 'After stop' } },
    });

    expect(whatsapp.sendMessage).not.toHaveBeenCalled();
  });

  test('no-op on CheckScheduled (no WhatsApp equivalent of reactions)', async () => {
    const bus = new EventBus();
    const whatsapp = makeFakeWhatsApp();
    makeCtx(bus, whatsapp);

    await bus.emit({ type: 'CheckScheduled', checkId: 'reply', scope: [] });

    expect(whatsapp.sendMessage).not.toHaveBeenCalled();
  });

  test('skips reply when output.text is empty/whitespace', async () => {
    const bus = new EventBus();
    const whatsapp = makeFakeWhatsApp();
    makeCtx(bus, whatsapp);

    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'reply',
      scope: [],
      result: { issues: [], output: { text: '   ' } },
    });

    expect(whatsapp.sendMessage).not.toHaveBeenCalled();
  });

  test('skips reply when output is null', async () => {
    const bus = new EventBus();
    const whatsapp = makeFakeWhatsApp();
    makeCtx(bus, whatsapp);

    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'reply',
      scope: [],
      result: { issues: [], output: null },
    });

    expect(whatsapp.sendMessage).not.toHaveBeenCalled();
  });

  test('skips reply for unknown check ID', async () => {
    const bus = new EventBus();
    const whatsapp = makeFakeWhatsApp();
    makeCtx(bus, whatsapp);

    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'nonexistent',
      scope: [],
      result: { issues: [], output: { text: 'Should not send' } },
    });

    expect(whatsapp.sendMessage).not.toHaveBeenCalled();
  });

  test('normalizes literal \\n escape sequences in output', async () => {
    const bus = new EventBus();
    const whatsapp = makeFakeWhatsApp();
    makeCtx(bus, whatsapp);

    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'reply',
      scope: [],
      result: { issues: [], output: { text: 'line1\\nline2\\nline3' } },
    });

    const call = whatsapp.sendMessage.mock.calls[0][0];
    expect(call.text).toContain('line1\nline2\nline3');
  });

  test('appends _rawOutput when present', async () => {
    const bus = new EventBus();
    const whatsapp = makeFakeWhatsApp();
    makeCtx(bus, whatsapp);

    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'reply',
      scope: [],
      result: { issues: [], output: { text: 'Main text', _rawOutput: 'Extra raw content' } },
    });

    const call = whatsapp.sendMessage.mock.calls[0][0];
    expect(call.text).toContain('Main text');
    expect(call.text).toContain('Extra raw content');
  });

  test('falls back to content field for AI text schema checks', async () => {
    const bus = new EventBus();
    const whatsapp = makeFakeWhatsApp();
    makeCtx(bus, whatsapp);

    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'reply',
      scope: [],
      result: { issues: [], content: 'Content fallback text' },
    });

    const call = whatsapp.sendMessage.mock.calls[0][0];
    expect(call.text).toContain('Content fallback text');
  });

  test('sends reply for log checks with group=chat', async () => {
    const bus = new EventBus();
    const whatsapp = makeFakeWhatsApp();
    makeCtx(bus, whatsapp, {
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

    expect(whatsapp.sendMessage).toHaveBeenCalledTimes(1);
    const call = whatsapp.sendMessage.mock.calls[0][0];
    expect(call.text).toContain('Chat log message');
  });

  test('sends Shutdown error message', async () => {
    const bus = new EventBus();
    const whatsapp = makeFakeWhatsApp();
    makeCtx(bus, whatsapp);

    await bus.emit({
      type: 'Shutdown',
      error: { message: 'Fatal crash' },
    });

    expect(whatsapp.sendMessage).toHaveBeenCalledTimes(1);
    const call = whatsapp.sendMessage.mock.calls[0][0];
    expect(call.text).toContain('Run failed');
    expect(call.text).toContain('Fatal crash');
  });

  test('Shutdown error does not send if error already notified', async () => {
    const bus = new EventBus();
    const whatsapp = makeFakeWhatsApp();
    makeCtx(bus, whatsapp);

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

    expect(whatsapp.sendMessage).toHaveBeenCalledTimes(1);
  });

  test('handles send failure gracefully', async () => {
    const bus = new EventBus();
    const whatsapp = makeFakeWhatsApp();
    whatsapp.sendMessage.mockResolvedValue({ ok: false, error: 'Rate limited' });
    makeCtx(bus, whatsapp);

    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'reply',
      scope: [],
      result: { issues: [], output: { text: 'Hello!' } },
    });

    expect(whatsapp.sendMessage).toHaveBeenCalledTimes(1);
  });

  test('skips AI checks with non-simple schemas', async () => {
    const bus = new EventBus();
    const whatsapp = makeFakeWhatsApp();
    makeCtx(bus, whatsapp, {
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

    expect(whatsapp.sendMessage).not.toHaveBeenCalled();
  });

  test('sends for AI checks with code-review schema', async () => {
    const bus = new EventBus();
    const whatsapp = makeFakeWhatsApp();
    makeCtx(bus, whatsapp, {
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

    expect(whatsapp.sendMessage).toHaveBeenCalledTimes(1);
  });

  test('sends for AI checks with markdown schema', async () => {
    const bus = new EventBus();
    const whatsapp = makeFakeWhatsApp();
    makeCtx(bus, whatsapp, {
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

    expect(whatsapp.sendMessage).toHaveBeenCalledTimes(1);
  });
});
