// Email polling runner tests for message filtering and Resend polling mode.
// Mocks imapflow, nodemailer, resend, and global fetch to test routing logic.

const mockSendMail = jest.fn();
jest.mock('nodemailer', () => ({
  createTransport: jest.fn(() => ({ sendMail: mockSendMail })),
}));

const mockResendSend = jest.fn();
const mockResendGet = jest.fn();
jest.mock('resend', () => ({
  Resend: class {
    emails = { send: mockResendSend, get: mockResendGet };
    constructor(public apiKey: string) {}
  },
}));

jest.mock('imapflow', () => ({
  ImapFlow: class {
    async connect() {}
    async logout() {}
    async getMailboxLock() {
      return { release: jest.fn() };
    }
    async *fetch() {}
  },
}));

jest.mock('mailparser', () => ({ simpleParser: jest.fn() }));

import { EmailPollingRunner } from '../../src/email/polling-runner';
import { StateMachineExecutionEngine } from '../../src/state-machine-execution-engine';
import type { VisorConfig } from '../../src/types/config';
import type { EmailMessage } from '../../src/email/client';

const baseCfg: VisorConfig = {
  version: '1',
  output: { pr_comment: { format: 'markdown', group_by: 'check', collapse: true } },
  checks: { reply: { type: 'ai' as any, on: ['manual'] } },
} as any;

beforeEach(() => {
  mockSendMail.mockReset();
  mockResendSend.mockReset();
  mockResendGet.mockReset();
});

function mkMsg(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return {
    id: '1',
    messageId: '<msg1@test>',
    from: 'User <user@test.com>',
    to: ['bot@test.com'],
    subject: 'Test',
    text: 'Hello bot',
    date: new Date('2024-01-01T12:00:00Z'),
    ...overrides,
  };
}

describe('EmailPollingRunner message gating', () => {
  test('processes valid email messages', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new EmailPollingRunner(engine, baseCfg, {
      receive: { type: 'imap', host: 'imap.test.com', auth: { user: 'u', pass: 'p' } },
      send: {
        type: 'smtp',
        host: 'smtp.test.com',
        auth: { user: 'u', pass: 'p' },
        from: 'bot@test.com',
      },
    });

    const spy = jest
      .spyOn(StateMachineExecutionEngine.prototype, 'executeChecks')
      .mockResolvedValue({
        results: { default: [] },
        statistics: {
          totalChecks: 1,
          checksByGroup: {},
          issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
        },
      } as any);

    await (runner as any).handleMessage(mkMsg());
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  test('skips messages without text content', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new EmailPollingRunner(engine, baseCfg, {
      receive: { type: 'imap', host: 'imap.test.com', auth: { user: 'u', pass: 'p' } },
      send: {
        type: 'smtp',
        host: 'smtp.test.com',
        auth: { user: 'u', pass: 'p' },
        from: 'bot@test.com',
      },
    });

    const spy = jest
      .spyOn(StateMachineExecutionEngine.prototype, 'executeChecks')
      .mockResolvedValue({} as any);

    await (runner as any).handleMessage(mkMsg({ text: '', html: undefined }));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('skips own bot messages', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new EmailPollingRunner(engine, baseCfg, {
      receive: { type: 'imap', host: 'imap.test.com', auth: { user: 'u', pass: 'p' } },
      send: {
        type: 'smtp',
        host: 'smtp.test.com',
        auth: { user: 'u', pass: 'p' },
        from: 'bot@test.com',
      },
    });

    const spy = jest
      .spyOn(StateMachineExecutionEngine.prototype, 'executeChecks')
      .mockResolvedValue({} as any);

    await (runner as any).handleMessage(mkMsg({ from: 'Bot <bot@test.com>' }));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('deduplication prevents processing same message twice', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new EmailPollingRunner(engine, baseCfg, {
      receive: { type: 'imap', host: 'imap.test.com', auth: { user: 'u', pass: 'p' } },
      send: {
        type: 'smtp',
        host: 'smtp.test.com',
        auth: { user: 'u', pass: 'p' },
        from: 'bot@test.com',
      },
    });

    const spy = jest
      .spyOn(StateMachineExecutionEngine.prototype, 'executeChecks')
      .mockResolvedValue({
        results: { default: [] },
        statistics: {
          totalChecks: 1,
          checksByGroup: {},
          issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
        },
      } as any);

    const msg = mkMsg();
    await (runner as any).handleMessage(msg);
    await (runner as any).handleMessage(msg); // Same message
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  test('sender allowlist filters messages', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new EmailPollingRunner(engine, baseCfg, {
      receive: { type: 'imap', host: 'imap.test.com', auth: { user: 'u', pass: 'p' } },
      send: {
        type: 'smtp',
        host: 'smtp.test.com',
        auth: { user: 'u', pass: 'p' },
        from: 'bot@test.com',
      },
      allowlist: ['allowed@test.com'],
    });

    const spy = jest
      .spyOn(StateMachineExecutionEngine.prototype, 'executeChecks')
      .mockResolvedValue({
        results: { default: [] },
        statistics: {
          totalChecks: 1,
          checksByGroup: {},
          issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
        },
      } as any);

    // Allowed sender
    await (runner as any).handleMessage(
      mkMsg({ messageId: '<a1@test>', from: 'allowed@test.com' })
    );
    expect(spy).toHaveBeenCalledTimes(1);

    // Not allowed
    await (runner as any).handleMessage(
      mkMsg({ messageId: '<a2@test>', from: 'blocked@test.com' })
    );
    expect(spy).toHaveBeenCalledTimes(1); // Still 1

    spy.mockRestore();
  });

  test('skips processing when no checks configured', async () => {
    const emptyCfg = { ...baseCfg, checks: {} } as any;
    const engine = new StateMachineExecutionEngine();
    const runner = new EmailPollingRunner(engine, emptyCfg, {
      receive: { type: 'imap', host: 'imap.test.com', auth: { user: 'u', pass: 'p' } },
      send: {
        type: 'smtp',
        host: 'smtp.test.com',
        auth: { user: 'u', pass: 'p' },
        from: 'bot@test.com',
      },
    });

    const spy = jest
      .spyOn(StateMachineExecutionEngine.prototype, 'executeChecks')
      .mockResolvedValue({} as any);

    await (runner as any).handleMessage(mkMsg());
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('injects email frontend into config for each run', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new EmailPollingRunner(engine, baseCfg, {
      receive: { type: 'imap', host: 'imap.test.com', auth: { user: 'u', pass: 'p' } },
      send: {
        type: 'smtp',
        host: 'smtp.test.com',
        auth: { user: 'u', pass: 'p' },
        from: 'bot@test.com',
      },
    });

    const spy = jest
      .spyOn(StateMachineExecutionEngine.prototype, 'executeChecks')
      .mockResolvedValue({
        results: { default: [] },
        statistics: {
          totalChecks: 1,
          checksByGroup: {},
          issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
        },
      } as any);

    await (runner as any).handleMessage(mkMsg());

    const callArgs = spy.mock.calls[0][0] as any;
    const frontends = callArgs.config.frontends;
    expect(frontends.some((f: any) => f.name === 'email')).toBe(true);

    spy.mockRestore();
  });
});

describe('EmailPollingRunner Resend polling mode', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('polls Resend API and processes new emails', async () => {
    // Mock listReceivedEmails response
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 'e1',
            from: 'alice@test.com',
            to: ['bot@test.com'],
            subject: 'Hello',
            created_at: '2024-01-01T00:00:00Z',
            message_id: '<e1@test>',
          },
        ],
        has_more: false,
      }),
    }) as any;

    // Mock fetchResendEmail
    mockResendGet.mockResolvedValue({
      data: {
        from: 'alice@test.com',
        to: ['bot@test.com'],
        subject: 'Hello',
        text: 'Hi there!',
        headers: { 'message-id': '<e1@test>' },
        created_at: '2024-01-01T00:00:00Z',
      },
    });

    const engine = new StateMachineExecutionEngine();
    const runner = new EmailPollingRunner(engine, baseCfg, {
      receive: { type: 'resend', api_key: 'rk_test' },
      send: { type: 'resend', api_key: 'rk_test', from: 'bot@resend.dev' },
    });

    const spy = jest
      .spyOn(StateMachineExecutionEngine.prototype, 'executeChecks')
      .mockResolvedValue({
        results: { default: [] },
        statistics: {
          totalChecks: 1,
          checksByGroup: {},
          issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
        },
      } as any);

    // Directly call the polling method
    await (runner as any).pollResendOnce();

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    expect(mockResendGet).toHaveBeenCalledWith('e1');
    expect(spy).toHaveBeenCalledTimes(1);

    spy.mockRestore();
  });

  test('advances cursor after polling', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 'e5',
            from: 'alice@test.com',
            to: ['bot@test.com'],
            subject: 'Test',
            created_at: '2024-01-01T00:00:00Z',
            message_id: '<e5@test>',
          },
        ],
        has_more: false,
      }),
    }) as any;

    mockResendGet.mockResolvedValue({
      data: {
        from: 'alice@test.com',
        to: ['bot@test.com'],
        subject: 'Test',
        text: 'Message',
        headers: { 'message-id': '<e5@test>' },
        created_at: '2024-01-01T00:00:00Z',
      },
    });

    const engine = new StateMachineExecutionEngine();
    const runner = new EmailPollingRunner(engine, baseCfg, {
      receive: { type: 'resend', api_key: 'rk_test' },
      send: { type: 'resend', api_key: 'rk_test', from: 'bot@resend.dev' },
    });

    jest.spyOn(StateMachineExecutionEngine.prototype, 'executeChecks').mockResolvedValue({
      results: { default: [] },
      statistics: {
        totalChecks: 1,
        checksByGroup: {},
        issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
      },
    } as any);

    await (runner as any).pollResendOnce();

    // Cursor should be updated
    expect((runner as any).resendLastSeenId).toBe('e5');

    // Second poll should use the cursor
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [], has_more: false }),
    }) as any;

    await (runner as any).pollResendOnce();

    const callUrl = (globalThis.fetch as jest.Mock).mock.calls[0][0];
    expect(callUrl).toContain('after=e5');

    jest.restoreAllMocks();
  });

  test('deduplicates Resend polling results', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 'e1',
            from: 'alice@test.com',
            to: ['bot@test.com'],
            subject: 'Hello',
            created_at: '2024-01-01T00:00:00Z',
            message_id: '<dup@test>',
          },
        ],
        has_more: false,
      }),
    }) as any;

    mockResendGet.mockResolvedValue({
      data: {
        from: 'alice@test.com',
        to: ['bot@test.com'],
        subject: 'Hello',
        text: 'Message',
        headers: { 'message-id': '<dup@test>' },
        created_at: '2024-01-01T00:00:00Z',
      },
    });

    const engine = new StateMachineExecutionEngine();
    const runner = new EmailPollingRunner(engine, baseCfg, {
      receive: { type: 'resend', api_key: 'rk_test' },
      send: { type: 'resend', api_key: 'rk_test', from: 'bot@resend.dev' },
    });

    const spy = jest
      .spyOn(StateMachineExecutionEngine.prototype, 'executeChecks')
      .mockResolvedValue({
        results: { default: [] },
        statistics: {
          totalChecks: 1,
          checksByGroup: {},
          issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
        },
      } as any);

    await (runner as any).pollResendOnce();
    await (runner as any).pollResendOnce(); // Same email again

    // Should only process once
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  test('Resend polling mode starts when no webhook_secret', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new EmailPollingRunner(engine, baseCfg, {
      receive: { type: 'resend', api_key: 'rk_test' },
      send: { type: 'resend', api_key: 'rk_test', from: 'bot@resend.dev' },
    });

    // hasWebhookSecret should be false
    expect((runner as any).hasWebhookSecret).toBe(false);
    expect((runner as any).receiveType).toBe('resend');
  });

  test('Resend polling handles empty response gracefully', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [], has_more: false }),
    }) as any;

    const engine = new StateMachineExecutionEngine();
    const runner = new EmailPollingRunner(engine, baseCfg, {
      receive: { type: 'resend', api_key: 'rk_test' },
      send: { type: 'resend', api_key: 'rk_test', from: 'bot@resend.dev' },
    });

    const spy = jest
      .spyOn(StateMachineExecutionEngine.prototype, 'executeChecks')
      .mockResolvedValue({} as any);

    // Should not throw
    await (runner as any).pollResendOnce();

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('Resend polling handles API error gracefully', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    }) as any;

    const engine = new StateMachineExecutionEngine();
    const runner = new EmailPollingRunner(engine, baseCfg, {
      receive: { type: 'resend', api_key: 'rk_test' },
      send: { type: 'resend', api_key: 'rk_test', from: 'bot@resend.dev' },
    });

    const spy = jest
      .spyOn(StateMachineExecutionEngine.prototype, 'executeChecks')
      .mockResolvedValue({} as any);

    // Should not throw
    await (runner as any).pollResendOnce();

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('Resend polling skips when fetchResendEmail returns null', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: [
          {
            id: 'e_bad',
            from: 'alice@test.com',
            to: ['bot@test.com'],
            subject: 'Test',
            created_at: '2024-01-01T00:00:00Z',
            message_id: '<ebad@test>',
          },
        ],
        has_more: false,
      }),
    }) as any;

    // fetchResendEmail returns null (e.g., email deleted between list and fetch)
    mockResendGet.mockResolvedValue({ data: null });

    const engine = new StateMachineExecutionEngine();
    const runner = new EmailPollingRunner(engine, baseCfg, {
      receive: { type: 'resend', api_key: 'rk_test' },
      send: { type: 'resend', api_key: 'rk_test', from: 'bot@resend.dev' },
    });

    const spy = jest
      .spyOn(StateMachineExecutionEngine.prototype, 'executeChecks')
      .mockResolvedValue({} as any);

    await (runner as any).pollResendOnce();

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('EmailPollingRunner HTML-only messages', () => {
  test('processes message with html but no text', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new EmailPollingRunner(engine, baseCfg, {
      receive: { type: 'imap', host: 'imap.test.com', auth: { user: 'u', pass: 'p' } },
      send: {
        type: 'smtp',
        host: 'smtp.test.com',
        auth: { user: 'u', pass: 'p' },
        from: 'bot@test.com',
      },
    });

    const spy = jest
      .spyOn(StateMachineExecutionEngine.prototype, 'executeChecks')
      .mockResolvedValue({
        results: { default: [] },
        statistics: {
          totalChecks: 1,
          checksByGroup: {},
          issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
        },
      } as any);

    // Message with HTML only (text is empty string)
    await (runner as any).handleMessage(
      mkMsg({ messageId: '<html-only@test>', text: '', html: '<p>HTML only email</p>' })
    );
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  test('skips message with no text and no html', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new EmailPollingRunner(engine, baseCfg, {
      receive: { type: 'imap', host: 'imap.test.com', auth: { user: 'u', pass: 'p' } },
      send: {
        type: 'smtp',
        host: 'smtp.test.com',
        auth: { user: 'u', pass: 'p' },
        from: 'bot@test.com',
      },
    });

    const spy = jest
      .spyOn(StateMachineExecutionEngine.prototype, 'executeChecks')
      .mockResolvedValue({} as any);

    await (runner as any).handleMessage(mkMsg({ text: '', html: undefined }));
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('EmailPollingRunner error handling', () => {
  test('engine execution error does not crash the runner', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new EmailPollingRunner(engine, baseCfg, {
      receive: { type: 'imap', host: 'imap.test.com', auth: { user: 'u', pass: 'p' } },
      send: {
        type: 'smtp',
        host: 'smtp.test.com',
        auth: { user: 'u', pass: 'p' },
        from: 'bot@test.com',
      },
    });

    const spy = jest
      .spyOn(StateMachineExecutionEngine.prototype, 'executeChecks')
      .mockRejectedValue(new Error('AI provider down'));

    // Should not throw
    await (runner as any).handleMessage(mkMsg({ messageId: '<err@test>' }));
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  test('config hot-swap works via updateConfig', () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new EmailPollingRunner(engine, baseCfg, {
      receive: { type: 'imap', host: 'imap.test.com', auth: { user: 'u', pass: 'p' } },
      send: {
        type: 'smtp',
        host: 'smtp.test.com',
        auth: { user: 'u', pass: 'p' },
        from: 'bot@test.com',
      },
    });

    const newCfg = { ...baseCfg, checks: { newCheck: { type: 'ai' as any } } } as any;
    runner.updateConfig(newCfg);
    expect((runner as any).cfg).toBe(newCfg);
  });

  test('stop() clears poll timer and stops processing', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new EmailPollingRunner(engine, baseCfg, {
      receive: { type: 'imap', host: 'imap.test.com', auth: { user: 'u', pass: 'p' } },
      send: {
        type: 'smtp',
        host: 'smtp.test.com',
        auth: { user: 'u', pass: 'p' },
        from: 'bot@test.com',
      },
    });

    await runner.stop();
    expect((runner as any).stopped).toBe(true);
  });

  test('getClient returns the email client', () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new EmailPollingRunner(engine, baseCfg, {
      receive: { type: 'imap', host: 'imap.test.com', auth: { user: 'u', pass: 'p' } },
      send: {
        type: 'smtp',
        host: 'smtp.test.com',
        auth: { user: 'u', pass: 'p' },
        from: 'bot@test.com',
      },
    });

    const client = runner.getClient();
    expect(client).toBeDefined();
    expect(client.getFromAddress()).toBe('bot@test.com');
  });

  test('setTaskStore stores task store reference', () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new EmailPollingRunner(engine, baseCfg, {
      receive: { type: 'imap', host: 'imap.test.com', auth: { user: 'u', pass: 'p' } },
      send: {
        type: 'smtp',
        host: 'smtp.test.com',
        auth: { user: 'u', pass: 'p' },
        from: 'bot@test.com',
      },
    });

    const fakeStore = { createTask: jest.fn() } as any;
    runner.setTaskStore(fakeStore, '/path/to/config.yaml');
    expect((runner as any).taskStore).toBe(fakeStore);
    expect((runner as any).configPath).toBe('/path/to/config.yaml');
  });
});

describe('EmailPollingRunner allowlist edge cases', () => {
  test('allowlist comparison is case-insensitive', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new EmailPollingRunner(engine, baseCfg, {
      receive: { type: 'imap', host: 'imap.test.com', auth: { user: 'u', pass: 'p' } },
      send: {
        type: 'smtp',
        host: 'smtp.test.com',
        auth: { user: 'u', pass: 'p' },
        from: 'bot@test.com',
      },
      allowlist: ['User@Test.COM'],
    });

    const spy = jest
      .spyOn(StateMachineExecutionEngine.prototype, 'executeChecks')
      .mockResolvedValue({
        results: { default: [] },
        statistics: {
          totalChecks: 1,
          checksByGroup: {},
          issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
        },
      } as any);

    // From is lowercase but allowlist has mixed case — should match due to normalization
    await (runner as any).handleMessage(mkMsg({ messageId: '<case@test>', from: 'user@test.com' }));
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  test('allowlist extracts email from display name format', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new EmailPollingRunner(engine, baseCfg, {
      receive: { type: 'imap', host: 'imap.test.com', auth: { user: 'u', pass: 'p' } },
      send: {
        type: 'smtp',
        host: 'smtp.test.com',
        auth: { user: 'u', pass: 'p' },
        from: 'bot@test.com',
      },
      allowlist: ['alice@test.com'],
    });

    const spy = jest
      .spyOn(StateMachineExecutionEngine.prototype, 'executeChecks')
      .mockResolvedValue({
        results: { default: [] },
        statistics: {
          totalChecks: 1,
          checksByGroup: {},
          issuesBySeverity: { critical: 0, error: 0, warning: 0, info: 0 },
        },
      } as any);

    // From includes display name
    await (runner as any).handleMessage(
      mkMsg({ messageId: '<display@test>', from: 'Alice Smith <alice@test.com>' })
    );
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
