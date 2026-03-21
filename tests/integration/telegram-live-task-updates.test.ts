import fs from 'fs';
import os from 'os';
import path from 'path';
import { TelegramPollingRunner } from '../../src/telegram/polling-runner';
import { StateMachineExecutionEngine } from '../../src/state-machine-execution-engine';
import { SqliteTaskStore } from '../../src/agent-protocol/task-store';
import type { VisorConfig } from '../../src/types/config';

const botApi = {
  sendMessage: jest.fn(),
  sendDocument: jest.fn(),
  setMessageReaction: jest.fn(),
  getMe: jest.fn(),
  editMessageText: jest.fn(),
  deleteMessage: jest.fn(),
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

const probeAnswer = jest.fn(async () => '- Inspecting the gateway rate-limiting path');
const serializeTraceForPrompt = jest.fn(async () => 'trace snapshot');
const fetchTraceSpans = jest.fn(async () => []);

jest.mock('../../src/agent-protocol/trace-serializer', () => {
  const actual = jest.requireActual('../../src/agent-protocol/trace-serializer');
  return {
    ...actual,
    serializeTraceForPrompt: (...args: any[]) => serializeTraceForPrompt(...args),
    fetchTraceSpans: (...args: any[]) => fetchTraceSpans(...args),
  };
});

jest.mock('../../src/agent-protocol/task-trace-resolution', () => ({
  resolveTaskTraceReference: jest.fn(
    async (metadata?: { trace_id?: string; trace_file?: string }) => ({
      traceId: metadata?.trace_id,
      traceFile: metadata?.trace_file,
      primaryRef: metadata?.trace_id || metadata?.trace_file,
    })
  ),
}));

jest.mock('@probelabs/probe', () => ({
  ProbeAgent: class FakeProbeAgent {
    async initialize() {}
    async answer(prompt: string) {
      return probeAnswer(prompt);
    }
  },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function mkMsg() {
  return {
    message_id: 42,
    from: { id: 777, is_bot: false, first_name: 'User', username: 'user1' },
    chat: { id: 12345, type: 'private' as const, title: undefined, username: undefined },
    date: Math.floor(Date.now() / 1000),
    text: 'How api rate limiting works?',
  };
}

describe('Telegram live task updates integration', () => {
  let taskStore: SqliteTaskStore;
  let dbPath: string;
  let traceFile: string;
  let executeChecksSpy: jest.SpyInstance;

  beforeEach(async () => {
    jest.useFakeTimers();
    for (const fn of Object.values(botApi)) (fn as jest.Mock).mockClear();
    probeAnswer.mockClear();
    serializeTraceForPrompt.mockClear();
    fetchTraceSpans.mockClear();
    botApi.getMe.mockResolvedValue({
      id: 999,
      is_bot: true,
      first_name: 'TestBot',
      username: 'test_bot',
    });
    botApi.sendMessage.mockResolvedValue({ message_id: 2000 });
    botApi.editMessageText.mockResolvedValue({ message_id: 2000 });
    botApi.deleteMessage.mockResolvedValue(true);
    process.env.TELEGRAM_BOT_TOKEN = 'test-token';

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-telegram-live-updates-'));
    dbPath = path.join(tmpDir, 'agent-tasks.db');
    traceFile = path.join(tmpDir, 'trace.ndjson');
    fs.writeFileSync(traceFile, '');
    process.env.VISOR_FALLBACK_TRACE_FILE = traceFile;

    taskStore = new SqliteTaskStore(dbPath);
    await taskStore.initialize();

    executeChecksSpy = jest.spyOn(StateMachineExecutionEngine.prototype, 'executeChecks');
  });

  afterEach(async () => {
    jest.useRealTimers();
    delete process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.VISOR_FALLBACK_TRACE_FILE;
    executeChecksSpy.mockRestore();
    await taskStore.shutdown();
    try {
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    } catch {}
  });

  test('posts first live update at 10s and edits the same message on completion', async () => {
    const cfg: VisorConfig = {
      version: '1',
      output: { pr_comment: { format: 'markdown', group_by: 'check', collapse: true } },
      task_live_updates: {
        enabled: true,
        interval_seconds: 30,
        provider: 'google',
        model: 'gemini-3.1-flash-lite-preview',
        frontends: { telegram: { enabled: true } },
      } as any,
      checks: { reply: { type: 'ai' as any, on: ['manual'] } },
    } as any;

    const pending = deferred<any>();
    executeChecksSpy.mockImplementation(() => pending.promise as any);

    const engine = new StateMachineExecutionEngine();
    const runner = new TelegramPollingRunner(engine, cfg, {
      botToken: 'test-token',
      requireMention: false,
    });
    runner.setTaskStore(taskStore, 'test-telegram-live.yaml');
    await (runner as any).adapter.initialize();

    const handlePromise = (runner as any).handleMessage(mkMsg());

    await Promise.resolve();
    await Promise.resolve();
    expect(botApi.sendMessage).not.toHaveBeenCalled();
    expect(botApi.editMessageText).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(10_000);
    await Promise.resolve();

    expect(serializeTraceForPrompt).toHaveBeenCalled();
    expect(
      probeAnswer.mock.calls.some(call => String(call[0] || '').includes('<execution_trace>'))
    ).toBe(true);
    expect(botApi.sendMessage).toHaveBeenCalledTimes(1);
    expect(botApi.sendMessage.mock.calls[0][0]).toBe(12345);
    expect(botApi.sendMessage.mock.calls[0][1]).toContain(
      'Inspecting the gateway rate-limiting path'
    );

    pending.resolve({
      reviewSummary: {
        history: {
          'generate-response': [{ text: 'Final answer text' }],
        },
      },
    });
    await handlePromise;

    expect(botApi.editMessageText).toHaveBeenCalledTimes(1);
    expect(botApi.editMessageText.mock.calls[0][0]).toBe(12345);
    expect(botApi.editMessageText.mock.calls[0][1]).toBe(2000);
    expect(botApi.editMessageText.mock.calls[0][2]).toContain('Final answer text');

    const { tasks } = taskStore.listTasks({ state: ['completed'] });
    expect(tasks).toHaveLength(1);
    const task = tasks[0];
    expect(task.metadata?.telegram_live_update_message_id).toBe(2000);
    const liveHistory = (task.history || []).filter(
      h => (h as any)?.metadata?.kind === 'task_live_update'
    );
    expect(liveHistory.map((h: any) => h.metadata?.stage)).toEqual(['progress', 'completed']);
  });

  test('does nothing in the live-update path when the feature is disabled', async () => {
    const cfg: VisorConfig = {
      version: '1',
      output: { pr_comment: { format: 'markdown', group_by: 'check', collapse: true } },
      task_live_updates: { enabled: false } as any,
      checks: { reply: { type: 'ai' as any, on: ['manual'] } },
    } as any;

    const pending = deferred<any>();
    executeChecksSpy.mockImplementation(() => pending.promise as any);

    const engine = new StateMachineExecutionEngine();
    const runner = new TelegramPollingRunner(engine, cfg, {
      botToken: 'test-token',
      requireMention: false,
    });
    runner.setTaskStore(taskStore, 'test-telegram-live.yaml');
    await (runner as any).adapter.initialize();

    const handlePromise = (runner as any).handleMessage(mkMsg());

    await Promise.resolve();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(15_000);
    await Promise.resolve();

    expect(serializeTraceForPrompt).not.toHaveBeenCalled();
    expect(fetchTraceSpans).not.toHaveBeenCalled();
    expect(
      probeAnswer.mock.calls.some(call => String(call[0] || '').includes('<execution_trace>'))
    ).toBe(false);
    expect(botApi.sendMessage).not.toHaveBeenCalled();
    expect(botApi.editMessageText).not.toHaveBeenCalled();

    pending.resolve({
      reviewSummary: {
        history: {
          'generate-response': [{ text: 'Final answer text' }],
        },
      },
    });
    await handlePromise;

    const { tasks } = taskStore.listTasks({ state: ['completed'] });
    expect(tasks).toHaveLength(1);
    const task = tasks[0];
    const liveHistory = (task.history || []).filter(
      h => (h as any)?.metadata?.kind === 'task_live_update'
    );
    expect(liveHistory).toHaveLength(0);
  });
});
