// WhatsApp client tests using mock global.fetch.

import { WhatsAppClient } from '../../src/whatsapp/client';

const mockFetch = jest.fn();
(global as any).fetch = mockFetch;

beforeEach(() => {
  mockFetch.mockReset();
});

describe('WhatsAppClient constructor', () => {
  it('creates client with valid options', () => {
    const client = new WhatsAppClient({
      accessToken: 'test-token',
      phoneNumberId: '123456',
    });
    expect(client.getPhoneNumberId()).toBe('123456');
  });

  it('throws on empty accessToken', () => {
    expect(() => new WhatsAppClient({ accessToken: '', phoneNumberId: '123' })).toThrow(
      'accessToken is required'
    );
  });

  it('throws on empty phoneNumberId', () => {
    expect(() => new WhatsAppClient({ accessToken: 'tok', phoneNumberId: '' })).toThrow(
      'phoneNumberId is required'
    );
  });
});

describe('WhatsAppClient.sendMessage', () => {
  it('sends a simple text message', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id: 'wamid.test123' }] }),
    });

    const client = new WhatsAppClient({
      accessToken: 'test-token',
      phoneNumberId: '123456',
    });

    const result = await client.sendMessage({
      to: '15551234567',
      text: 'Hello!',
    });

    expect(result).toEqual({ ok: true, messageId: 'wamid.test123' });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain('graph.facebook.com');
    expect(url).toContain('123456/messages');
    expect(opts.headers.Authorization).toBe('Bearer test-token');

    const body = JSON.parse(opts.body);
    expect(body.messaging_product).toBe('whatsapp');
    expect(body.to).toBe('15551234567');
    expect(body.text.body).toBe('Hello!');
  });

  it('includes context.message_id for quoted replies', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id: 'wamid.reply1' }] }),
    });

    const client = new WhatsAppClient({
      accessToken: 'test-token',
      phoneNumberId: '123456',
    });

    await client.sendMessage({
      to: '15551234567',
      text: 'Reply',
      replyToMessageId: 'wamid.original',
    });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.context).toEqual({ message_id: 'wamid.original' });
  });

  it('auto-chunks long messages', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ messages: [{ id: 'wamid.chunk' }] }),
    });

    const client = new WhatsAppClient({
      accessToken: 'test-token',
      phoneNumberId: '123456',
    });

    const longText = 'a'.repeat(4000) + '\n' + 'b'.repeat(4000);
    await client.sendMessage({ to: '15551234567', text: longText });

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('returns error on API failure', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'Invalid phone number' } }),
    });

    const client = new WhatsAppClient({
      accessToken: 'test-token',
      phoneNumberId: '123456',
    });

    const result = await client.sendMessage({
      to: 'invalid',
      text: 'Hello',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Invalid phone number');
  });

  it('returns error on network failure', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    const client = new WhatsAppClient({
      accessToken: 'test-token',
      phoneNumberId: '123456',
    });

    const result = await client.sendMessage({
      to: '15551234567',
      text: 'Hello',
    });

    expect(result.ok).toBe(false);
    expect(result.error).toBe('Network error');
  });
});

describe('WhatsAppClient.markAsRead', () => {
  it('sends read receipt', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    });

    const client = new WhatsAppClient({
      accessToken: 'test-token',
      phoneNumberId: '123456',
    });

    const result = await client.markAsRead('wamid.msg1');
    expect(result.ok).toBe(true);

    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.messaging_product).toBe('whatsapp');
    expect(body.status).toBe('read');
    expect(body.message_id).toBe('wamid.msg1');
  });

  it('returns error on failure', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ error: { message: 'Message not found' } }),
    });

    const client = new WhatsAppClient({
      accessToken: 'test-token',
      phoneNumberId: '123456',
    });

    const result = await client.markAsRead('wamid.nonexistent');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('Message not found');
  });
});

describe('WhatsAppClient.verifyWebhookSignature', () => {
  it('returns true when no appSecret configured', () => {
    const client = new WhatsAppClient({
      accessToken: 'test-token',
      phoneNumberId: '123456',
    });

    expect(client.verifyWebhookSignature('body', 'any-sig')).toBe(true);
  });

  it('validates correct HMAC-SHA256 signature', () => {
    const { createHmac } = require('crypto');
    const secret = 'my-app-secret';
    const body = '{"test": true}';
    const expected = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

    const client = new WhatsAppClient({
      accessToken: 'test-token',
      phoneNumberId: '123456',
      appSecret: secret,
    });

    expect(client.verifyWebhookSignature(body, expected)).toBe(true);
  });

  it('rejects invalid signature', () => {
    const client = new WhatsAppClient({
      accessToken: 'test-token',
      phoneNumberId: '123456',
      appSecret: 'my-app-secret',
    });

    expect(client.verifyWebhookSignature('body', 'sha256=invalid')).toBe(false);
  });

  it('rejects empty signature header', () => {
    const client = new WhatsAppClient({
      accessToken: 'test-token',
      phoneNumberId: '123456',
      appSecret: 'my-app-secret',
    });

    expect(client.verifyWebhookSignature('body', '')).toBe(false);
  });
});

describe('WhatsAppClient.verifyChallenge', () => {
  it('returns challenge on valid subscription', () => {
    const client = new WhatsAppClient({
      accessToken: 'test-token',
      phoneNumberId: '123456',
      verifyToken: 'my-verify-token',
    });

    const result = client.verifyChallenge({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'my-verify-token',
      'hub.challenge': 'challenge123',
    });

    expect(result.ok).toBe(true);
    expect(result.challenge).toBe('challenge123');
  });

  it('rejects mismatched verify token', () => {
    const client = new WhatsAppClient({
      accessToken: 'test-token',
      phoneNumberId: '123456',
      verifyToken: 'my-verify-token',
    });

    const result = client.verifyChallenge({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'wrong-token',
      'hub.challenge': 'challenge123',
    });

    expect(result.ok).toBe(false);
  });

  it('rejects non-subscribe mode', () => {
    const client = new WhatsAppClient({
      accessToken: 'test-token',
      phoneNumberId: '123456',
      verifyToken: 'my-verify-token',
    });

    const result = client.verifyChallenge({
      'hub.mode': 'unsubscribe',
      'hub.verify_token': 'my-verify-token',
      'hub.challenge': 'challenge123',
    });

    expect(result.ok).toBe(false);
  });
});
