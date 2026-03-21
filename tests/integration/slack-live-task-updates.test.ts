import fs from 'fs';
import os from 'os';
import path from 'path';
import yaml from 'js-yaml';
import { SlackSocketRunner } from '../../src/slack/socket-runner';
import { StateMachineExecutionEngine } from '../../src/state-machine-execution-engine';
import { SqliteTaskStore } from '../../src/agent-protocol/task-store';
import type { VisorConfig } from '../../src/types/config';

const reactionsAdd = jest.fn(async () => ({ ok: true }));
const reactionsRemove = jest.fn(async () => ({ ok: true }));
const chatPostMessage = jest.fn(async ({ text }: any) => ({
  ok: true,
  ts: '2000.1',
  message: { ts: '2000.1', text },
}));
const chatUpdate = jest.fn(async () => ({ ok: true }));

const probeAnswer = jest.fn(async () => '- Inspecting the gateway rate-limiting path');
const serializeTraceForPrompt = jest.fn(async () => 'trace snapshot');

jest.mock('../../src/slack/client', () => ({
  SlackClient: class FakeSlackClient {
    public chat = { postMessage: chatPostMessage, update: chatUpdate };
    public reactions = { add: reactionsAdd, remove: reactionsRemove };
    async getBotUserId() {
      return 'UFAKEBOT';
    }
    async fetchThreadReplies() {
      return [];
    }
  },
}));

jest.mock('../../src/agent-protocol/trace-serializer', () => {
  const actual = jest.requireActual('../../src/agent-protocol/trace-serializer');
  return {
    ...actual,
    serializeTraceForPrompt: (...args: any[]) => serializeTraceForPrompt(...args),
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

function mkEnv(
  text: string,
  channel = 'D1',
  ts = '1800.1',
  opts?: { type?: string; thread_ts?: string }
) {
  const type = opts?.type || 'app_mention';
  const payload: any = { event: { type, channel, ts, text } };
  if (opts?.thread_ts) payload.event.thread_ts = opts.thread_ts;
  return { type: 'events_api', envelope_id: `env-${ts}`, payload };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushAsyncWork(iterations = 8) {
  for (let i = 0; i < iterations; i++) {
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(0);
  }
}

describe('Slack live task updates integration', () => {
  let taskStore: SqliteTaskStore;
  let dbPath: string;
  let traceFile: string;
  let executeChecksSpy: jest.SpyInstance;

  beforeEach(async () => {
    jest.useFakeTimers();
    reactionsAdd.mockClear();
    reactionsRemove.mockClear();
    chatPostMessage.mockClear();
    chatUpdate.mockClear();
    probeAnswer.mockClear();
    serializeTraceForPrompt.mockClear();
    process.env.SLACK_BOT_TOKEN = 'xoxb-test-token';

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-live-updates-'));
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
    delete process.env.SLACK_BOT_TOKEN;
    delete process.env.VISOR_FALLBACK_TRACE_FILE;
    executeChecksSpy.mockRestore();
    await taskStore.shutdown();
    try {
      fs.rmSync(path.dirname(dbPath), { recursive: true, force: true });
    } catch {}
  });

  function loadConfig(): VisorConfig {
    const raw = fs.readFileSync('examples/slack-simple-chat.yaml', 'utf8');
    return yaml.load(raw) as VisorConfig;
  }

  test('posts first live update at 10s and edits the same message on completion', async () => {
    const cfg = loadConfig();
    (cfg as any).task_live_updates = {
      enabled: true,
      interval_seconds: 30,
      provider: 'google',
      model: 'gemini-3.1-flash-lite-preview',
      frontends: { slack: { enabled: true } },
    };

    const pending = deferred<any>();
    executeChecksSpy.mockImplementation(() => pending.promise as any);

    const engine = new StateMachineExecutionEngine();

    const runner = new SlackSocketRunner(engine, cfg, {
      appToken: 'xapp-test',
      endpoint: '/bots/slack/support',
      mentions: 'all',
      threads: 'required',
    });
    runner.setTaskStore(taskStore, 'examples/slack-simple-chat.yaml');

    const handlePromise = (runner as any).handleMessage(
      JSON.stringify(mkEnv('How api rate limiting works?', 'D1', '1900.1', { type: 'app_mention' }))
    );

    await Promise.resolve();
    await Promise.resolve();
    expect(chatPostMessage).not.toHaveBeenCalled();
    expect(chatUpdate).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(10_000);
    await flushAsyncWork();

    expect(serializeTraceForPrompt).toHaveBeenCalled();
    expect(
      probeAnswer.mock.calls.some(call => String(call[0] || '').includes('<execution_trace>'))
    ).toBe(true);
    expect(chatPostMessage).toHaveBeenCalledTimes(1);
    expect(chatPostMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'D1',
        thread_ts: '1900.1',
        text: expect.stringContaining('Inspecting the gateway rate-limiting path'),
      })
    );
    expect(chatUpdate).not.toHaveBeenCalled();

    pending.resolve({
      reviewSummary: {
        history: {
          'generate-response': [{ text: 'Final answer text' }],
        },
      },
    });
    await handlePromise;

    expect(chatUpdate).toHaveBeenCalledTimes(1);
    expect(chatUpdate).toHaveBeenCalledWith({
      channel: 'D1',
      ts: '2000.1',
      text: 'Final answer text',
    });

    const { tasks } = taskStore.listTasks({ state: ['completed'] });
    expect(tasks).toHaveLength(1);
    const task = tasks[0];
    expect(task.metadata?.slack_live_update_ts).toBe('2000.1');
    const liveHistory = (task.history || []).filter(
      h => (h as any)?.metadata?.kind === 'task_live_update'
    );
    expect(liveHistory.map((h: any) => h.metadata?.stage)).toEqual(['progress', 'completed']);
  });

  test('does nothing in the live-update path when the feature is disabled', async () => {
    const cfg = loadConfig();
    (cfg as any).task_live_updates = { enabled: false };

    const pending = deferred<any>();
    executeChecksSpy.mockImplementation(() => pending.promise as any);

    const engine = new StateMachineExecutionEngine();

    const runner = new SlackSocketRunner(engine, cfg, {
      appToken: 'xapp-test',
      endpoint: '/bots/slack/support',
      mentions: 'all',
      threads: 'required',
    });
    runner.setTaskStore(taskStore, 'examples/slack-simple-chat.yaml');

    const handlePromise = (runner as any).handleMessage(
      JSON.stringify(mkEnv('How api rate limiting works?', 'D1', '2900.1', { type: 'app_mention' }))
    );

    await Promise.resolve();
    await Promise.resolve();
    await jest.advanceTimersByTimeAsync(15_000);
    await flushAsyncWork();
    expect(serializeTraceForPrompt).not.toHaveBeenCalled();
    expect(
      probeAnswer.mock.calls.some(call => String(call[0] || '').includes('<execution_trace>'))
    ).toBe(false);
    expect(chatPostMessage).not.toHaveBeenCalled();
    expect(chatUpdate).not.toHaveBeenCalled();

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
