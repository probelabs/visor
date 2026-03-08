// Telegram polling runner tests for message filtering.
// Uses OpenClaw-style grammy mocking: jest.mock('grammy') replacing Bot class.

const botApi = {
  sendMessage: jest.fn(),
  sendDocument: jest.fn(),
  setMessageReaction: jest.fn(),
  getMe: jest.fn(),
};

jest.mock('grammy', () => ({
  Bot: class MockBot {
    api = botApi;
    catch = jest.fn();
    on = jest.fn();
    constructor(public token: string) {}
  },
  InputFile: class {},
}));

jest.mock('@grammyjs/runner', () => ({
  run: jest.fn(() => ({ stop: jest.fn() })),
}));

import { TelegramPollingRunner } from '../../src/telegram/polling-runner';
import { StateMachineExecutionEngine } from '../../src/state-machine-execution-engine';
import type { VisorConfig } from '../../src/types/config';
import type { TelegramMessageInfo } from '../../src/telegram/adapter';

const baseCfg: VisorConfig = {
  version: '1',
  output: { pr_comment: { format: 'markdown', group_by: 'check', collapse: true } },
  checks: { reply: { type: 'ai' as any, on: ['manual'] } },
} as any;

beforeEach(() => {
  botApi.getMe.mockResolvedValue({
    id: 999,
    is_bot: true,
    first_name: 'TestBot',
    username: 'test_bot',
  });
  for (const fn of Object.values(botApi)) {
    (fn as jest.Mock).mockClear();
  }
  botApi.getMe.mockResolvedValue({
    id: 999,
    is_bot: true,
    first_name: 'TestBot',
    username: 'test_bot',
  });
});

function mkMsg(overrides: Partial<TelegramMessageInfo> = {}): TelegramMessageInfo {
  return {
    message_id: 1,
    from: { id: 777, is_bot: false, first_name: 'User', username: 'user1' },
    chat: { id: 100, type: 'private', title: undefined, username: undefined },
    date: Math.floor(Date.now() / 1000),
    text: 'Hello bot',
    ...overrides,
  };
}

describe('TelegramPollingRunner message gating', () => {
  test('DM messages are always accepted (no mention required)', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new TelegramPollingRunner(engine, baseCfg, {
      botToken: 'test-token',
      requireMention: true, // Even with requireMention, DMs are accepted
    });

    // Initialize adapter
    await (runner as any).adapter.initialize();

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

    await (runner as any).handleMessage(mkMsg({
      chat: { id: 100, type: 'private', title: undefined, username: undefined },
      text: 'Hello from DM',
    }));

    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  test('group messages require mention when requireMention is true', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new TelegramPollingRunner(engine, baseCfg, {
      botToken: 'test-token',
      requireMention: true,
    });

    await (runner as any).adapter.initialize();

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

    // Plain message in group — should be ignored
    await (runner as any).handleMessage(mkMsg({
      message_id: 10,
      chat: { id: -200, type: 'group', title: 'Test Group', username: undefined },
      text: 'Hello everyone',
    }));
    expect(spy).not.toHaveBeenCalled();

    // Message with @mention — should be accepted
    await (runner as any).handleMessage(mkMsg({
      message_id: 11,
      chat: { id: -200, type: 'group', title: 'Test Group', username: undefined },
      text: '@test_bot what is the weather?',
    }));
    expect(spy).toHaveBeenCalledTimes(1);

    spy.mockRestore();
  });

  test('group messages accepted without mention when requireMention is false', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new TelegramPollingRunner(engine, baseCfg, {
      botToken: 'test-token',
      requireMention: false,
    });

    await (runner as any).adapter.initialize();

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

    await (runner as any).handleMessage(mkMsg({
      message_id: 20,
      chat: { id: -200, type: 'group', title: 'Test Group', username: undefined },
      text: 'Hello without mention',
    }));

    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  test('supergroup with reply-to-bot accepted even without mention', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new TelegramPollingRunner(engine, baseCfg, {
      botToken: 'test-token',
      requireMention: true,
    });

    await (runner as any).adapter.initialize();

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

    // Reply to bot message in supergroup
    await (runner as any).handleMessage(mkMsg({
      message_id: 30,
      chat: { id: -300, type: 'supergroup', title: 'Super Group', username: undefined },
      text: 'Replying to you',
      reply_to_message: {
        message_id: 29,
        from: { id: 999, is_bot: true, first_name: 'TestBot', username: 'test_bot' },
        chat: { id: -300, type: 'supergroup', title: 'Super Group', username: undefined },
        date: 1000,
        text: 'Bot said something',
      },
    }));

    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  test('channel posts are always accepted', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new TelegramPollingRunner(engine, baseCfg, {
      botToken: 'test-token',
      requireMention: true,
    });

    await (runner as any).adapter.initialize();

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

    await (runner as any).handleMessage(mkMsg({
      message_id: 40,
      chat: { id: -400, type: 'channel', title: 'Test Channel', username: 'test_channel' },
      text: 'Channel post',
      from: undefined, // Channel posts have no "from"
    }));

    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  test('skips messages without text content', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new TelegramPollingRunner(engine, baseCfg, {
      botToken: 'test-token',
    });

    await (runner as any).adapter.initialize();

    const spy = jest
      .spyOn(StateMachineExecutionEngine.prototype, 'executeChecks')
      .mockResolvedValue({} as any);

    await (runner as any).handleMessage(mkMsg({
      message_id: 50,
      text: undefined,
      caption: undefined,
    }));

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('skips own bot messages', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new TelegramPollingRunner(engine, baseCfg, {
      botToken: 'test-token',
    });

    await (runner as any).adapter.initialize();

    const spy = jest
      .spyOn(StateMachineExecutionEngine.prototype, 'executeChecks')
      .mockResolvedValue({} as any);

    // Message from the bot itself (id=999 matches botInfo.id)
    await (runner as any).handleMessage(mkMsg({
      message_id: 60,
      from: { id: 999, is_bot: true, first_name: 'TestBot', username: 'test_bot' },
      text: 'Bot echo',
    }));

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  test('chat allowlist filters messages', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new TelegramPollingRunner(engine, baseCfg, {
      botToken: 'test-token',
      chatAllowlist: [100, 200],
    });

    await (runner as any).adapter.initialize();

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

    // Allowed chat
    await (runner as any).handleMessage(mkMsg({
      message_id: 70,
      chat: { id: 100, type: 'private', title: undefined, username: undefined },
      text: 'Allowed',
    }));
    expect(spy).toHaveBeenCalledTimes(1);

    // Not in allowlist
    await (runner as any).handleMessage(mkMsg({
      message_id: 71,
      chat: { id: 999, type: 'private', title: undefined, username: undefined },
      text: 'Blocked',
    }));
    expect(spy).toHaveBeenCalledTimes(1); // Still 1

    spy.mockRestore();
  });

  test('deduplication prevents processing same message twice', async () => {
    const engine = new StateMachineExecutionEngine();
    const runner = new TelegramPollingRunner(engine, baseCfg, {
      botToken: 'test-token',
    });

    await (runner as any).adapter.initialize();

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

    const msg = mkMsg({ message_id: 80 });

    await (runner as any).handleMessage(msg);
    await (runner as any).handleMessage(msg); // Same message again

    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });

  test('skips processing when no checks configured', async () => {
    const emptyCfg: VisorConfig = {
      version: '1',
      output: { pr_comment: { format: 'markdown', group_by: 'check', collapse: true } },
      checks: {},
    } as any;

    const engine = new StateMachineExecutionEngine();
    const runner = new TelegramPollingRunner(engine, emptyCfg, {
      botToken: 'test-token',
    });

    await (runner as any).adapter.initialize();

    const spy = jest
      .spyOn(StateMachineExecutionEngine.prototype, 'executeChecks')
      .mockResolvedValue({} as any);

    await (runner as any).handleMessage(mkMsg({ message_id: 90 }));

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
