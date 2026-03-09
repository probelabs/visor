// Email client tests.
// Mocks imapflow, nodemailer, and resend to test routing and send/receive logic.

const mockSendMail = jest.fn();
const mockCreateTransport = jest.fn(() => ({ sendMail: mockSendMail }));
jest.mock('nodemailer', () => ({
  createTransport: mockCreateTransport,
}));

const mockResendSend = jest.fn();
const mockResendGet = jest.fn();
jest.mock('resend', () => ({
  Resend: class {
    emails = {
      send: mockResendSend,
      get: mockResendGet,
    };
    constructor(public apiKey: string) {}
  },
}));

jest.mock('imapflow', () => ({
  ImapFlow: class {
    connectCalled = false;
    async connect() {
      this.connectCalled = true;
    }
    async logout() {}
    async getMailboxLock() {
      return { release: jest.fn() };
    }
    async *fetch() {
      // Yields nothing in tests
    }
  },
}));

jest.mock('mailparser', () => ({
  simpleParser: jest.fn(),
}));

import { EmailClient } from '../../src/email/client';

beforeEach(() => {
  mockSendMail.mockReset();
  mockCreateTransport.mockClear();
  mockResendSend.mockReset();
  mockResendGet.mockReset();
});

describe('EmailClient constructor', () => {
  it('creates with SMTP send config', () => {
    const client = new EmailClient({
      receive: { type: 'imap', host: 'imap.test.com', auth: { user: 'u', pass: 'p' } },
      send: {
        type: 'smtp',
        host: 'smtp.test.com',
        auth: { user: 'u', pass: 'p' },
        from: 'bot@test.com',
      },
    });
    expect(client.getFromAddress()).toBe('bot@test.com');
  });

  it('creates with Resend send config', () => {
    const client = new EmailClient({
      send: { type: 'resend', apiKey: 'rk_test', from: 'bot@resend.dev' },
    });
    expect(client.getFromAddress()).toBe('bot@resend.dev');
  });

  it('throws when IMAP host is missing', () => {
    const origHost = process.env.EMAIL_IMAP_HOST;
    delete process.env.EMAIL_IMAP_HOST;
    try {
      expect(
        () =>
          new EmailClient({
            receive: { type: 'imap' },
            send: {
              type: 'smtp',
              host: 'smtp.test.com',
              auth: { user: 'u', pass: 'p' },
              from: 'a@b.com',
            },
          })
      ).toThrow('IMAP host is required');
    } finally {
      if (origHost) process.env.EMAIL_IMAP_HOST = origHost;
    }
  });

  it('throws when Resend API key is missing for receive', () => {
    const origKey = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    try {
      expect(
        () =>
          new EmailClient({
            receive: { type: 'resend' },
          })
      ).toThrow('Resend API key is required');
    } finally {
      if (origKey) process.env.RESEND_API_KEY = origKey;
    }
  });
});

describe('EmailClient.sendEmail via SMTP', () => {
  it('sends email through nodemailer transport', async () => {
    mockSendMail.mockResolvedValue({ messageId: '<msg1@test>' });
    const client = new EmailClient({
      send: {
        type: 'smtp',
        host: 'smtp.test.com',
        auth: { user: 'u', pass: 'p' },
        from: 'bot@test.com',
      },
    });

    const result = await client.sendEmail({
      to: 'user@test.com',
      subject: 'Test',
      text: 'Hello',
    });

    expect(result.ok).toBe(true);
    expect(result.messageId).toBe('<msg1@test>');
    expect(mockSendMail).toHaveBeenCalledTimes(1);
    const opts = mockSendMail.mock.calls[0][0];
    expect(opts.from).toBe('bot@test.com');
    expect(opts.to).toBe('user@test.com');
    expect(opts.subject).toBe('Test');
    expect(opts.text).toBe('Hello');
  });

  it('includes threading headers when provided', async () => {
    mockSendMail.mockResolvedValue({ messageId: '<msg2@test>' });
    const client = new EmailClient({
      send: {
        type: 'smtp',
        host: 'smtp.test.com',
        auth: { user: 'u', pass: 'p' },
        from: 'bot@test.com',
      },
    });

    await client.sendEmail({
      to: 'user@test.com',
      subject: 'Re: Test',
      text: 'Reply',
      inReplyTo: '<original@test>',
      references: ['<root@test>', '<original@test>'],
    });

    const opts = mockSendMail.mock.calls[0][0];
    expect(opts.inReplyTo).toBe('<original@test>');
    expect(opts.references).toBe('<root@test> <original@test>');
  });

  it('returns error on SMTP failure', async () => {
    mockSendMail.mockRejectedValue(new Error('Connection refused'));
    const client = new EmailClient({
      send: {
        type: 'smtp',
        host: 'smtp.test.com',
        auth: { user: 'u', pass: 'p' },
        from: 'bot@test.com',
      },
    });

    const result = await client.sendEmail({
      to: 'user@test.com',
      subject: 'Test',
      text: 'Hello',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Connection refused');
  });
});

describe('EmailClient.sendEmail via Resend', () => {
  it('sends email through Resend SDK', async () => {
    mockResendSend.mockResolvedValue({ data: { id: 'resend_abc' } });
    const client = new EmailClient({
      send: { type: 'resend', apiKey: 'rk_test', from: 'bot@resend.dev' },
    });

    const result = await client.sendEmail({
      to: 'user@test.com',
      subject: 'Test',
      text: 'Hello',
      html: '<p>Hello</p>',
    });

    expect(result.ok).toBe(true);
    expect(result.messageId).toContain('resend_abc');
    expect(mockResendSend).toHaveBeenCalledTimes(1);
    const opts = mockResendSend.mock.calls[0][0];
    expect(opts.from).toBe('bot@resend.dev');
    expect(opts.to).toEqual(['user@test.com']);
    expect(opts.html).toBe('<p>Hello</p>');
  });

  it('includes threading headers in Resend send', async () => {
    mockResendSend.mockResolvedValue({ data: { id: 'resend_def' } });
    const client = new EmailClient({
      send: { type: 'resend', apiKey: 'rk_test', from: 'bot@resend.dev' },
    });

    await client.sendEmail({
      to: 'user@test.com',
      subject: 'Re: Test',
      text: 'Reply',
      inReplyTo: '<original@test>',
      references: ['<root@test>', '<original@test>'],
    });

    const opts = mockResendSend.mock.calls[0][0];
    expect(opts.headers['In-Reply-To']).toBe('<original@test>');
    expect(opts.headers['References']).toBe('<root@test> <original@test>');
  });
});

describe('EmailClient.fetchResendEmail', () => {
  it('fetches and parses email from Resend API', async () => {
    mockResendGet.mockResolvedValue({
      data: {
        from: 'sender@test.com',
        to: ['recipient@test.com'],
        subject: 'Hello',
        text: 'Message body',
        html: '<p>Message body</p>',
        headers: {
          'message-id': '<msg1@resend>',
          'in-reply-to': '<parent@test>',
          references: '<root@test> <parent@test>',
        },
        created_at: '2024-01-01T00:00:00Z',
      },
    });

    const client = new EmailClient({
      receive: { type: 'resend', apiKey: 'rk_test' },
      send: { type: 'resend', apiKey: 'rk_test', from: 'bot@resend.dev' },
    });

    const email = await client.fetchResendEmail('email_123');
    expect(email).not.toBeNull();
    expect(email!.from).toBe('sender@test.com');
    expect(email!.subject).toBe('Hello');
    expect(email!.messageId).toBe('<msg1@resend>');
    expect(email!.inReplyTo).toBe('<parent@test>');
    expect(email!.references).toEqual(['<root@test>', '<parent@test>']);
  });

  it('returns null on fetch failure', async () => {
    mockResendGet.mockRejectedValue(new Error('Not found'));
    const client = new EmailClient({
      receive: { type: 'resend', apiKey: 'rk_test' },
      send: { type: 'resend', apiKey: 'rk_test', from: 'bot@resend.dev' },
    });

    const email = await client.fetchResendEmail('nonexistent');
    expect(email).toBeNull();
  });
});

describe('EmailClient.listReceivedEmails', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns emails from Resend /emails/receiving endpoint', async () => {
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
          {
            id: 'e2',
            from: 'bob@test.com',
            to: ['bot@test.com'],
            subject: 'Hi',
            created_at: '2024-01-01T01:00:00Z',
            message_id: '<e2@test>',
          },
        ],
        has_more: true,
      }),
    }) as any;

    const client = new EmailClient({
      receive: { type: 'resend', apiKey: 'rk_test' },
      send: { type: 'resend', apiKey: 'rk_test', from: 'bot@resend.dev' },
    });

    const result = await client.listReceivedEmails({ limit: 20 });
    expect(result.emails).toHaveLength(2);
    expect(result.emails[0].id).toBe('e1');
    expect(result.emails[0].from).toBe('alice@test.com');
    expect(result.hasMore).toBe(true);
    expect(result.lastId).toBe('e2');

    // Verify correct API call
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const callUrl = (globalThis.fetch as jest.Mock).mock.calls[0][0];
    expect(callUrl).toContain('/emails/receiving');
    expect(callUrl).toContain('limit=20');
  });

  it('passes after cursor for pagination', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [], has_more: false }),
    }) as any;

    const client = new EmailClient({
      receive: { type: 'resend', apiKey: 'rk_test' },
      send: { type: 'resend', apiKey: 'rk_test', from: 'bot@resend.dev' },
    });

    await client.listReceivedEmails({ after: 'cursor_abc' });
    const callUrl = (globalThis.fetch as jest.Mock).mock.calls[0][0];
    expect(callUrl).toContain('after=cursor_abc');
  });

  it('returns empty on API failure', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    }) as any;

    const client = new EmailClient({
      receive: { type: 'resend', apiKey: 'rk_test' },
      send: { type: 'resend', apiKey: 'rk_test', from: 'bot@resend.dev' },
    });

    const result = await client.listReceivedEmails();
    expect(result.emails).toHaveLength(0);
    expect(result.hasMore).toBe(false);
  });

  it('returns empty when no Resend config', async () => {
    const client = new EmailClient({
      send: {
        type: 'smtp',
        host: 'smtp.test.com',
        auth: { user: 'u', pass: 'p' },
        from: 'bot@test.com',
      },
    });

    const result = await client.listReceivedEmails();
    expect(result.emails).toHaveLength(0);
  });
});

describe('EmailClient IMAP operations', () => {
  it('connects and disconnects IMAP', async () => {
    const client = new EmailClient({
      receive: { type: 'imap', host: 'imap.test.com', auth: { user: 'u', pass: 'p' } },
      send: {
        type: 'smtp',
        host: 'smtp.test.com',
        auth: { user: 'u', pass: 'p' },
        from: 'bot@test.com',
      },
    });

    // connectImap creates ImapFlow and calls connect
    await client.connectImap();
    // disconnectImap calls logout
    await client.disconnectImap();
    // double disconnect is safe
    await client.disconnectImap();
  });

  it('fetchNewMessages returns empty when no unseen messages', async () => {
    const client = new EmailClient({
      receive: { type: 'imap', host: 'imap.test.com', auth: { user: 'u', pass: 'p' } },
      send: {
        type: 'smtp',
        host: 'smtp.test.com',
        auth: { user: 'u', pass: 'p' },
        from: 'bot@test.com',
      },
    });

    await client.connectImap();
    const messages = await client.fetchNewMessages();
    expect(messages).toEqual([]);
    await client.disconnectImap();
  });

  it('fetchNewMessages returns empty when not connected', async () => {
    const client = new EmailClient({
      receive: { type: 'imap', host: 'imap.test.com', auth: { user: 'u', pass: 'p' } },
      send: {
        type: 'smtp',
        host: 'smtp.test.com',
        auth: { user: 'u', pass: 'p' },
        from: 'bot@test.com',
      },
    });

    // No connectImap — client not ready
    const messages = await client.fetchNewMessages();
    expect(messages).toEqual([]);
  });

  it('connectImap is no-op for non-IMAP backend', async () => {
    const client = new EmailClient({
      receive: { type: 'resend', apiKey: 'rk_test' },
      send: { type: 'resend', apiKey: 'rk_test', from: 'bot@resend.dev' },
    });

    // Should not throw
    await client.connectImap();
  });
});

describe('EmailClient.verifyResendWebhook', () => {
  it('returns true when no webhook secret configured', async () => {
    const client = new EmailClient({
      receive: { type: 'resend', apiKey: 'rk_test' },
      send: { type: 'resend', apiKey: 'rk_test', from: 'bot@resend.dev' },
    });

    const result = await client.verifyResendWebhook('{}', {});
    expect(result).toBe(true);
  });
});

describe('EmailClient.fetchResendEmail edge cases', () => {
  it('handles email with array-format headers', async () => {
    mockResendGet.mockResolvedValue({
      data: {
        from: 'sender@test.com',
        to: ['recipient@test.com'],
        subject: 'Test',
        text: 'Body',
        headers: [
          { name: 'Message-ID', value: '<arr-header@test>' },
          { name: 'In-Reply-To', value: '<parent@test>' },
        ],
        created_at: '2024-01-01T00:00:00Z',
      },
    });

    const client = new EmailClient({
      receive: { type: 'resend', apiKey: 'rk_test' },
      send: { type: 'resend', apiKey: 'rk_test', from: 'bot@resend.dev' },
    });

    const email = await client.fetchResendEmail('e1');
    expect(email).not.toBeNull();
    expect(email!.messageId).toBe('<arr-header@test>');
    expect(email!.inReplyTo).toBe('<parent@test>');
  });

  it('generates fallback message-id when header missing', async () => {
    mockResendGet.mockResolvedValue({
      data: {
        from: 'sender@test.com',
        to: ['recipient@test.com'],
        subject: 'No header',
        text: 'Body',
        headers: {},
        created_at: '2024-01-01T00:00:00Z',
      },
    });

    const client = new EmailClient({
      receive: { type: 'resend', apiKey: 'rk_test' },
      send: { type: 'resend', apiKey: 'rk_test', from: 'bot@resend.dev' },
    });

    const email = await client.fetchResendEmail('e_no_header');
    expect(email).not.toBeNull();
    expect(email!.messageId).toContain('@resend');
    expect(email!.messageId).toContain('e_no_header');
  });

  it('handles from field as object with email property', async () => {
    mockResendGet.mockResolvedValue({
      data: {
        from: { email: 'obj-sender@test.com', name: 'Sender' },
        to: [{ email: 'obj-recipient@test.com', name: 'Recipient' }],
        subject: 'Object format',
        text: 'Body',
        headers: { 'message-id': '<obj@test>' },
        created_at: '2024-01-01T00:00:00Z',
      },
    });

    const client = new EmailClient({
      receive: { type: 'resend', apiKey: 'rk_test' },
      send: { type: 'resend', apiKey: 'rk_test', from: 'bot@resend.dev' },
    });

    const email = await client.fetchResendEmail('e_obj');
    expect(email).not.toBeNull();
    expect(email!.from).toBe('obj-sender@test.com');
    expect(email!.to).toEqual(['obj-recipient@test.com']);
  });

  it('uses body field as fallback when text is missing', async () => {
    mockResendGet.mockResolvedValue({
      data: {
        from: 'sender@test.com',
        to: ['recipient@test.com'],
        subject: 'Fallback',
        body: 'Fallback body content',
        headers: { 'message-id': '<fb@test>' },
        created_at: '2024-01-01T00:00:00Z',
      },
    });

    const client = new EmailClient({
      receive: { type: 'resend', apiKey: 'rk_test' },
      send: { type: 'resend', apiKey: 'rk_test', from: 'bot@resend.dev' },
    });

    const email = await client.fetchResendEmail('e_fb');
    expect(email).not.toBeNull();
    expect(email!.text).toBe('Fallback body content');
  });

  it('handles result without data wrapper', async () => {
    mockResendGet.mockResolvedValue({
      from: 'direct@test.com',
      to: ['recipient@test.com'],
      subject: 'Direct',
      text: 'Direct body',
      headers: { 'message-id': '<direct@test>' },
      created_at: '2024-01-01T00:00:00Z',
    });

    const client = new EmailClient({
      receive: { type: 'resend', apiKey: 'rk_test' },
      send: { type: 'resend', apiKey: 'rk_test', from: 'bot@resend.dev' },
    });

    const email = await client.fetchResendEmail('e_direct');
    expect(email).not.toBeNull();
    expect(email!.from).toBe('direct@test.com');
  });
});

describe('EmailClient.sendEmail edge cases', () => {
  it('sends to array of recipients via SMTP', async () => {
    mockSendMail.mockResolvedValue({ messageId: '<multi@test>' });
    const client = new EmailClient({
      send: {
        type: 'smtp',
        host: 'smtp.test.com',
        auth: { user: 'u', pass: 'p' },
        from: 'bot@test.com',
      },
    });

    await client.sendEmail({
      to: ['a@test.com', 'b@test.com'],
      subject: 'Multi',
      text: 'Hello',
    });

    const opts = mockSendMail.mock.calls[0][0];
    expect(opts.to).toBe('a@test.com, b@test.com');
  });

  it('includes HTML when provided via SMTP', async () => {
    mockSendMail.mockResolvedValue({ messageId: '<html@test>' });
    const client = new EmailClient({
      send: {
        type: 'smtp',
        host: 'smtp.test.com',
        auth: { user: 'u', pass: 'p' },
        from: 'bot@test.com',
      },
    });

    await client.sendEmail({
      to: 'user@test.com',
      subject: 'HTML',
      text: 'Plain',
      html: '<p>Rich</p>',
    });

    const opts = mockSendMail.mock.calls[0][0];
    expect(opts.html).toBe('<p>Rich</p>');
  });

  it('returns error on Resend send failure', async () => {
    mockResendSend.mockRejectedValue(new Error('Rate limited'));
    const client = new EmailClient({
      send: { type: 'resend', apiKey: 'rk_test', from: 'bot@resend.dev' },
    });

    const result = await client.sendEmail({
      to: 'user@test.com',
      subject: 'Test',
      text: 'Hello',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('Rate limited');
  });

  it('generates message-id when none provided', async () => {
    mockSendMail.mockResolvedValue({});
    const client = new EmailClient({
      send: {
        type: 'smtp',
        host: 'smtp.test.com',
        auth: { user: 'u', pass: 'p' },
        from: 'bot@test.com',
      },
    });

    await client.sendEmail({
      to: 'user@test.com',
      subject: 'Test',
      text: 'Hello',
    });

    const opts = mockSendMail.mock.calls[0][0];
    expect(opts.messageId).toBeTruthy();
    expect(opts.messageId).toContain('@visor');
  });

  it('reuses SMTP transport on second send', async () => {
    mockSendMail.mockResolvedValue({ messageId: '<reuse@test>' });
    const client = new EmailClient({
      send: {
        type: 'smtp',
        host: 'smtp.test.com',
        auth: { user: 'u', pass: 'p' },
        from: 'bot@test.com',
      },
    });

    await client.sendEmail({ to: 'a@test.com', subject: 'First', text: 'Hi' });
    await client.sendEmail({ to: 'b@test.com', subject: 'Second', text: 'Hi' });

    // createTransport called only once (lazy cached)
    expect(mockCreateTransport).toHaveBeenCalledTimes(1);
    expect(mockSendMail).toHaveBeenCalledTimes(2);
  });
});

describe('EmailClient constructor edge cases', () => {
  it('creates with send-only config (no receive)', () => {
    const client = new EmailClient({
      send: {
        type: 'smtp',
        host: 'smtp.test.com',
        auth: { user: 'u', pass: 'p' },
        from: 'bot@test.com',
      },
    });
    expect(client.getFromAddress()).toBe('bot@test.com');
    expect(client.getReceiveBackend()).toBe('imap'); // default
  });

  it('handles snake_case api_key in config', () => {
    const client = new EmailClient({
      receive: { type: 'resend', api_key: 'rk_snake' } as any,
      send: { type: 'resend', api_key: 'rk_snake', from: 'bot@resend.dev' } as any,
    });
    expect(client.getFromAddress()).toBe('bot@resend.dev');
  });

  it('throws when Resend API key is missing for send', () => {
    const origKey = process.env.RESEND_API_KEY;
    delete process.env.RESEND_API_KEY;
    try {
      expect(
        () =>
          new EmailClient({
            send: { type: 'resend', from: 'bot@resend.dev' },
          })
      ).toThrow('Resend API key is required for send');
    } finally {
      if (origKey) process.env.RESEND_API_KEY = origKey;
    }
  });

  it('throws when SMTP host is missing', () => {
    const origHost = process.env.EMAIL_SMTP_HOST;
    delete process.env.EMAIL_SMTP_HOST;
    try {
      expect(
        () =>
          new EmailClient({
            send: { type: 'smtp', auth: { user: 'u', pass: 'p' }, from: 'a@b.com' },
          })
      ).toThrow('SMTP host is required');
    } finally {
      if (origHost) process.env.EMAIL_SMTP_HOST = origHost;
    }
  });
});

describe('EmailClient.listReceivedEmails edge cases', () => {
  let originalFetch: typeof globalThis.fetch;
  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns empty on network error', async () => {
    globalThis.fetch = jest.fn().mockRejectedValue(new Error('Network error')) as any;
    const client = new EmailClient({
      receive: { type: 'resend', apiKey: 'rk_test' },
      send: { type: 'resend', apiKey: 'rk_test', from: 'bot@resend.dev' },
    });

    const result = await client.listReceivedEmails();
    expect(result.emails).toHaveLength(0);
    expect(result.hasMore).toBe(false);
  });

  it('handles missing data field in response', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ unexpected: 'format' }),
    }) as any;

    const client = new EmailClient({
      receive: { type: 'resend', apiKey: 'rk_test' },
      send: { type: 'resend', apiKey: 'rk_test', from: 'bot@resend.dev' },
    });

    const result = await client.listReceivedEmails();
    expect(result.emails).toHaveLength(0);
  });

  it('sends correct authorization header', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: [], has_more: false }),
    }) as any;

    const client = new EmailClient({
      receive: { type: 'resend', apiKey: 'rk_secret_123' },
      send: { type: 'resend', apiKey: 'rk_secret_123', from: 'bot@resend.dev' },
    });

    await client.listReceivedEmails();
    const callHeaders = (globalThis.fetch as jest.Mock).mock.calls[0][1].headers;
    expect(callHeaders['Authorization']).toBe('Bearer rk_secret_123');
  });
});

describe('EmailClient.deriveThreadId', () => {
  it('returns deterministic 16-char hex string', () => {
    const id1 = EmailClient.deriveThreadId('<root@test>');
    const id2 = EmailClient.deriveThreadId('<root@test>');
    expect(id1).toBe(id2);
    expect(id1.length).toBe(16);
    expect(/^[0-9a-f]+$/.test(id1)).toBe(true);
  });

  it('returns different IDs for different inputs', () => {
    const id1 = EmailClient.deriveThreadId('<msg1@test>');
    const id2 = EmailClient.deriveThreadId('<msg2@test>');
    expect(id1).not.toBe(id2);
  });
});
