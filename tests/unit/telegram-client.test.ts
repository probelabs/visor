// Telegram client tests using OpenClaw-style grammy mocking.
// Mock the grammy Bot class with jest.fn() API stubs.

const botApi = {
  sendMessage: jest.fn(),
  sendDocument: jest.fn(),
  setMessageReaction: jest.fn(),
  getMe: jest.fn(),
};

const botCtorSpy = jest.fn();

jest.mock('grammy', () => ({
  Bot: class {
    api = botApi;
    catch = jest.fn();
    constructor(public token: string) {
      botCtorSpy(token);
    }
  },
  InputFile: class {
    constructor(
      public data: any,
      public filename?: string
    ) {}
  },
}));

import { TelegramClient } from '../../src/telegram/client';

beforeEach(() => {
  botCtorSpy.mockReset();
  for (const fn of Object.values(botApi)) {
    (fn as jest.Mock).mockReset();
  }
});

describe('TelegramClient constructor', () => {
  it('creates a grammy Bot with the token', () => {
    new TelegramClient('test-token-123');
    expect(botCtorSpy).toHaveBeenCalledWith('test-token-123');
  });

  it('throws on empty token', () => {
    expect(() => new TelegramClient('')).toThrow('botToken is required');
  });
});

describe('TelegramClient.init', () => {
  it('calls getMe and returns bot info', async () => {
    botApi.getMe.mockResolvedValue({
      id: 12345,
      is_bot: true,
      first_name: 'TestBot',
      username: 'test_bot',
    });
    const client = new TelegramClient('tok');
    const info = await client.init();
    expect(info).toEqual({
      id: 12345,
      is_bot: true,
      first_name: 'TestBot',
      username: 'test_bot',
    });
    expect(client.getBotInfo()).toEqual(info);
  });
});

describe('TelegramClient.sendMessage', () => {
  it('sends a simple text message', async () => {
    botApi.sendMessage.mockResolvedValue({ message_id: 42 });
    const client = new TelegramClient('tok');
    const result = await client.sendMessage({
      chat_id: 123,
      text: 'Hello!',
    });
    expect(result).toEqual({ ok: true, message_id: 42 });
    expect(botApi.sendMessage).toHaveBeenCalledTimes(1);
    expect(botApi.sendMessage.mock.calls[0][0]).toBe(123);
    expect(botApi.sendMessage.mock.calls[0][1]).toBe('Hello!');
  });

  it('sends with HTML parse mode', async () => {
    botApi.sendMessage.mockResolvedValue({ message_id: 43 });
    const client = new TelegramClient('tok');
    await client.sendMessage({
      chat_id: 123,
      text: '<b>Bold</b>',
      parse_mode: 'HTML',
    });
    const params = botApi.sendMessage.mock.calls[0][2];
    expect(params.parse_mode).toBe('HTML');
  });

  it('sends with reply_to_message_id', async () => {
    botApi.sendMessage.mockResolvedValue({ message_id: 44 });
    const client = new TelegramClient('tok');
    await client.sendMessage({
      chat_id: 123,
      text: 'Reply',
      reply_to_message_id: 10,
    });
    const params = botApi.sendMessage.mock.calls[0][2];
    expect(params.reply_parameters).toEqual({ message_id: 10 });
  });

  it('sends with message_thread_id for forum topics', async () => {
    botApi.sendMessage.mockResolvedValue({ message_id: 45 });
    const client = new TelegramClient('tok');
    await client.sendMessage({
      chat_id: -100123,
      text: 'Forum reply',
      message_thread_id: 999,
    });
    const params = botApi.sendMessage.mock.calls[0][2];
    expect(params.message_thread_id).toBe(999);
  });

  it('chunks long messages', async () => {
    botApi.sendMessage.mockResolvedValue({ message_id: 50 });
    const client = new TelegramClient('tok');
    // Create a message that exceeds 4096 chars
    const longText = 'a'.repeat(4000) + '\n' + 'b'.repeat(4000);
    await client.sendMessage({ chat_id: 123, text: longText });
    expect(botApi.sendMessage).toHaveBeenCalledTimes(2);
  });

  it('falls back to plain text on HTML parse error', async () => {
    botApi.sendMessage
      .mockRejectedValueOnce({ description: "can't parse entities" })
      .mockResolvedValueOnce({ message_id: 51 });
    const client = new TelegramClient('tok');
    const result = await client.sendMessage({
      chat_id: 123,
      text: 'Bad <b>html',
      parse_mode: 'HTML',
    });
    expect(result.ok).toBe(true);
    expect(botApi.sendMessage).toHaveBeenCalledTimes(2);
    // Second call should not have parse_mode
    const retryParams = botApi.sendMessage.mock.calls[1][2];
    expect(retryParams.parse_mode).toBeUndefined();
  });

  it('returns error on non-HTML failure', async () => {
    botApi.sendMessage.mockRejectedValue({ description: 'chat not found' });
    const client = new TelegramClient('tok');
    const result = await client.sendMessage({
      chat_id: 999,
      text: 'Hello',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('chat not found');
  });
});

describe('TelegramClient.setMessageReaction', () => {
  it('sets emoji reaction', async () => {
    botApi.setMessageReaction.mockResolvedValue(true);
    const client = new TelegramClient('tok');
    const result = await client.setMessageReaction({
      chat_id: 123,
      message_id: 42,
      emoji: '👍',
    });
    expect(result).toBe(true);
    expect(botApi.setMessageReaction).toHaveBeenCalledWith(123, 42, [
      { type: 'emoji', emoji: '👍' },
    ]);
  });

  it('returns false on failure (non-fatal)', async () => {
    botApi.setMessageReaction.mockRejectedValue(new Error('no permissions'));
    const client = new TelegramClient('tok');
    const result = await client.setMessageReaction({
      chat_id: 123,
      message_id: 42,
      emoji: '👍',
    });
    expect(result).toBe(false);
  });
});

describe('TelegramClient.sendDocument', () => {
  it('sends a document', async () => {
    botApi.sendDocument.mockResolvedValue({ message_id: 60 });
    const client = new TelegramClient('tok');
    const buf = Buffer.from('file contents');
    const result = await client.sendDocument({
      chat_id: 123,
      document: buf,
      filename: 'test.txt',
      caption: 'A file',
    });
    expect(result).toEqual({ ok: true, message_id: 60 });
    expect(botApi.sendDocument).toHaveBeenCalledTimes(1);
  });

  it('returns error on failure', async () => {
    botApi.sendDocument.mockRejectedValue({ description: 'file too large' });
    const client = new TelegramClient('tok');
    const result = await client.sendDocument({
      chat_id: 123,
      document: Buffer.from('x'),
      filename: 'big.bin',
    });
    expect(result.ok).toBe(false);
    expect(result.error).toBe('file too large');
  });
});
