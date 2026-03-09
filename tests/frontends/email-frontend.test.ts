// Email frontend EventBus tests.
// Mirrors the pattern from telegram-frontend.test.ts:
// - Fake EmailClient with jest.fn() API stubs
// - EventBus emission to trigger handlers
// - Verify correct email send calls with threading headers

import { EventBus } from '../../src/event-bus/event-bus';
import { EmailFrontend } from '../../src/frontends/email-frontend';

function makeFakeEmailClient() {
  return {
    sendEmail: jest.fn(async () => ({ ok: true, messageId: '<reply@visor>' })),
    getFromAddress: jest.fn(() => 'bot@test.com'),
    getReceiveBackend: jest.fn(() => 'imap'),
  } as any;
}

function makeCtx(
  bus: EventBus,
  emailClient: any,
  opts: {
    from?: string;
    subject?: string;
    messageId?: string;
    references?: string[];
    checks?: Record<string, any>;
  } = {},
) {
  const from = opts.from ?? 'user@test.com';
  const subject = opts.subject ?? 'Test Subject';
  const messageId = opts.messageId ?? '<msg1@test>';
  const map = new Map<string, unknown>();
  map.set('/bots/email/message', {
    event: {
      type: 'email_message',
      from,
      to: ['bot@test.com'],
      subject,
      text: 'Hello bot',
      messageId,
      references: opts.references || [],
    },
    sendConfig: { type: 'smtp' },
  });

  const fe = new EmailFrontend();
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
    emailClient,
  } as any);

  // Inject fake email client
  (fe as any).getEmailClient = () => emailClient;

  return fe;
}

describe('EmailFrontend (event-bus)', () => {
  test('sends direct reply for AI checks with simple schemas', async () => {
    const bus = new EventBus();
    const emailClient = makeFakeEmailClient();
    makeCtx(bus, emailClient);

    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'reply',
      scope: [],
      result: { issues: [], output: { text: 'Hello from AI!' } },
    });

    expect(emailClient.sendEmail).toHaveBeenCalledTimes(1);
    const call = emailClient.sendEmail.mock.calls[0][0];
    expect(call.to).toBe('user@test.com');
    expect(call.text).toContain('Hello from AI!');
    expect(call.html).toBeTruthy();
    expect(call.subject).toBe('Re: Test Subject');
    expect(call.inReplyTo).toBe('<msg1@test>');
    expect(call.references).toEqual(['<msg1@test>']);
  });

  test('includes full References chain in replies', async () => {
    const bus = new EventBus();
    const emailClient = makeFakeEmailClient();
    makeCtx(bus, emailClient, {
      messageId: '<msg2@test>',
      references: ['<root@test>', '<msg1@test>'],
    });

    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'reply',
      scope: [],
      result: { issues: [], output: { text: 'Threaded reply' } },
    });

    const call = emailClient.sendEmail.mock.calls[0][0];
    expect(call.inReplyTo).toBe('<msg2@test>');
    expect(call.references).toEqual(['<root@test>', '<msg1@test>', '<msg2@test>']);
  });

  test('does not send for non-AI / structured schema checks', async () => {
    const bus = new EventBus();
    const emailClient = makeFakeEmailClient();
    makeCtx(bus, emailClient, {
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

    expect(emailClient.sendEmail).not.toHaveBeenCalled();
  });

  test('sends reply for workflow checks with output.text', async () => {
    const bus = new EventBus();
    const emailClient = makeFakeEmailClient();
    makeCtx(bus, emailClient, {
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

    expect(emailClient.sendEmail).toHaveBeenCalledTimes(1);
    const call = emailClient.sendEmail.mock.calls[0][0];
    expect(call.text).toContain('Workflow response');
  });

  test('sends error email on CheckErrored', async () => {
    const bus = new EventBus();
    const emailClient = makeFakeEmailClient();
    makeCtx(bus, emailClient);

    await bus.emit({
      type: 'CheckErrored',
      checkId: 'reply',
      scope: [],
      error: { message: 'AI provider timeout' },
    });

    expect(emailClient.sendEmail).toHaveBeenCalledTimes(1);
    const call = emailClient.sendEmail.mock.calls[0][0];
    expect(call.to).toBe('user@test.com');
    expect(call.text).toContain('Check failed');
    expect(call.text).toContain('AI provider timeout');
    // Should still thread the error
    expect(call.inReplyTo).toBe('<msg1@test>');
  });

  test('does not send duplicate errors', async () => {
    const bus = new EventBus();
    const emailClient = makeFakeEmailClient();
    makeCtx(bus, emailClient);

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

    expect(emailClient.sendEmail).toHaveBeenCalledTimes(1);
  });

  test('skips reply when from address is missing', async () => {
    const bus = new EventBus();
    const emailClient = makeFakeEmailClient();

    // Empty webhook data (no inbound event)
    const fe = new EmailFrontend();
    fe.start({
      eventBus: bus,
      logger: console as any,
      config: { checks: { reply: { type: 'ai', schema: 'text' } } },
      run: { runId: 'r1' },
      webhookContext: { webhookData: new Map() },
      emailClient,
    } as any);
    (fe as any).getEmailClient = () => emailClient;

    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'reply',
      scope: [],
      result: { issues: [], output: { text: 'Hello!' } },
    });

    expect(emailClient.sendEmail).not.toHaveBeenCalled();
  });

  test('skips internal criticality checks', async () => {
    const bus = new EventBus();
    const emailClient = makeFakeEmailClient();
    makeCtx(bus, emailClient, {
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

    expect(emailClient.sendEmail).not.toHaveBeenCalled();
  });

  test('stop() unsubscribes all handlers', async () => {
    const bus = new EventBus();
    const emailClient = makeFakeEmailClient();
    const fe = makeCtx(bus, emailClient);

    fe.stop();

    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'reply',
      scope: [],
      result: { issues: [], output: { text: 'After stop' } },
    });

    expect(emailClient.sendEmail).not.toHaveBeenCalled();
  });

  test('no-op on CheckScheduled (no email equivalent of reactions)', async () => {
    const bus = new EventBus();
    const emailClient = makeFakeEmailClient();
    makeCtx(bus, emailClient);

    await bus.emit({ type: 'CheckScheduled', checkId: 'reply', scope: [] });

    // Email has no reaction equivalent — nothing should be called
    expect(emailClient.sendEmail).not.toHaveBeenCalled();
  });

  test('skips reply when output.text is empty/whitespace', async () => {
    const bus = new EventBus();
    const emailClient = makeFakeEmailClient();
    makeCtx(bus, emailClient);

    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'reply',
      scope: [],
      result: { issues: [], output: { text: '   ' } },
    });

    expect(emailClient.sendEmail).not.toHaveBeenCalled();
  });

  test('skips reply when output is null', async () => {
    const bus = new EventBus();
    const emailClient = makeFakeEmailClient();
    makeCtx(bus, emailClient);

    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'reply',
      scope: [],
      result: { issues: [], output: null },
    });

    expect(emailClient.sendEmail).not.toHaveBeenCalled();
  });

  test('skips reply for unknown check ID', async () => {
    const bus = new EventBus();
    const emailClient = makeFakeEmailClient();
    makeCtx(bus, emailClient);

    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'nonexistent',
      scope: [],
      result: { issues: [], output: { text: 'Should not send' } },
    });

    expect(emailClient.sendEmail).not.toHaveBeenCalled();
  });

  test('normalizes literal \\n escape sequences in output', async () => {
    const bus = new EventBus();
    const emailClient = makeFakeEmailClient();
    makeCtx(bus, emailClient);

    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'reply',
      scope: [],
      result: { issues: [], output: { text: 'line1\\nline2\\nline3' } },
    });

    const call = emailClient.sendEmail.mock.calls[0][0];
    expect(call.text).toBe('line1\nline2\nline3');
  });

  test('appends _rawOutput when present', async () => {
    const bus = new EventBus();
    const emailClient = makeFakeEmailClient();
    makeCtx(bus, emailClient);

    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'reply',
      scope: [],
      result: { issues: [], output: { text: 'Main text', _rawOutput: 'Extra raw content' } },
    });

    const call = emailClient.sendEmail.mock.calls[0][0];
    expect(call.text).toContain('Main text');
    expect(call.text).toContain('Extra raw content');
  });

  test('falls back to content field for AI text schema checks', async () => {
    const bus = new EventBus();
    const emailClient = makeFakeEmailClient();
    makeCtx(bus, emailClient);

    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'reply',
      scope: [],
      result: { issues: [], content: 'Content fallback text' },
    });

    const call = emailClient.sendEmail.mock.calls[0][0];
    expect(call.text).toContain('Content fallback text');
  });

  test('sends reply for log checks with group=chat', async () => {
    const bus = new EventBus();
    const emailClient = makeFakeEmailClient();
    makeCtx(bus, emailClient, {
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

    expect(emailClient.sendEmail).toHaveBeenCalledTimes(1);
    const call = emailClient.sendEmail.mock.calls[0][0];
    expect(call.text).toContain('Chat log message');
  });

  test('sends Shutdown error email', async () => {
    const bus = new EventBus();
    const emailClient = makeFakeEmailClient();
    makeCtx(bus, emailClient);

    await bus.emit({
      type: 'Shutdown',
      error: { message: 'Fatal crash' },
    });

    expect(emailClient.sendEmail).toHaveBeenCalledTimes(1);
    const call = emailClient.sendEmail.mock.calls[0][0];
    expect(call.text).toContain('Run failed');
    expect(call.text).toContain('Fatal crash');
  });

  test('Shutdown error does not send if error already notified', async () => {
    const bus = new EventBus();
    const emailClient = makeFakeEmailClient();
    makeCtx(bus, emailClient);

    // First error
    await bus.emit({
      type: 'CheckErrored',
      checkId: 'reply',
      scope: [],
      error: { message: 'err1' },
    });
    // Shutdown after
    await bus.emit({
      type: 'Shutdown',
      error: { message: 'Fatal' },
    });

    // Only one email sent (the first error)
    expect(emailClient.sendEmail).toHaveBeenCalledTimes(1);
  });

  test('handles send failure gracefully', async () => {
    const bus = new EventBus();
    const emailClient = makeFakeEmailClient();
    emailClient.sendEmail.mockResolvedValue({ ok: false, error: 'Connection refused' });
    makeCtx(bus, emailClient);

    // Should not throw
    await bus.emit({
      type: 'CheckCompleted',
      checkId: 'reply',
      scope: [],
      result: { issues: [], output: { text: 'Hello!' } },
    });

    expect(emailClient.sendEmail).toHaveBeenCalledTimes(1);
  });

  test('skips AI checks with non-simple schemas', async () => {
    const bus = new EventBus();
    const emailClient = makeFakeEmailClient();
    makeCtx(bus, emailClient, {
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

    expect(emailClient.sendEmail).not.toHaveBeenCalled();
  });

  test('sends for AI checks with code-review schema', async () => {
    const bus = new EventBus();
    const emailClient = makeFakeEmailClient();
    makeCtx(bus, emailClient, {
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

    expect(emailClient.sendEmail).toHaveBeenCalledTimes(1);
  });

  test('sends for AI checks with markdown schema', async () => {
    const bus = new EventBus();
    const emailClient = makeFakeEmailClient();
    makeCtx(bus, emailClient, {
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

    expect(emailClient.sendEmail).toHaveBeenCalledTimes(1);
  });
});
