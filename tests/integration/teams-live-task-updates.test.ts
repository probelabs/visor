import fs from 'fs';
import os from 'os';
import path from 'path';
import { TeamsWebhookRunner } from '../../src/teams/webhook-runner';
import { StateMachineExecutionEngine } from '../../src/state-machine-execution-engine';
import { SqliteTaskStore } from '../../src/agent-protocol/task-store';
import type { VisorConfig } from '../../src/types/config';

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
    activityId: 'act.msg1',
    conversationId: 'conv-1',
    conversationType: 'personal' as const,
    from: {
      id: 'user-1',
      name: 'Test User',
    },
    text: 'How api rate limiting works?',
    timestamp: '2024-01-01T00:00:00.000Z',
    conversationReference: {
      activityId: 'act.msg1',
      bot: { id: 'bot-id', name: 'Bot' },
      channelId: 'msteams',
      conversation: { id: 'conv-1' },
      serviceUrl: 'https://smba.trafficmanager.net/teams/',
    } as any,
  };
}

describe('Teams live task updates integration', () => {
  let taskStore: SqliteTaskStore;
  let dbPath: string;
  let traceFile: string;
  let executeChecksSpy: jest.SpyInstance;

  beforeEach(async () => {
    jest.useFakeTimers();
    probeAnswer.mockClear();
    serializeTraceForPrompt.mockClear();
    fetchTraceSpans.mockClear();
    process.env.TEAMS_APP_ID = 'test-app-id';
    process.env.TEAMS_APP_PASSWORD = 'test-app-password';

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-teams-live-updates-'));
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
    delete process.env.TEAMS_APP_ID;
    delete process.env.TEAMS_APP_PASSWORD;
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
        frontends: { teams: { enabled: true } },
      } as any,
      checks: { reply: { type: 'ai' as any, on: ['manual'] } },
    } as any;

    const pending = deferred<any>();
    executeChecksSpy.mockImplementation(() => pending.promise as any);

    const fakeTeamsClient = {
      sendMessage: jest.fn(async () => ({ ok: true, activityId: 'act.reply1' })),
      updateMessage: jest.fn(async () => ({ ok: true, activityId: 'act.reply1' })),
      deleteMessage: jest.fn(async () => true),
    };

    const engine = new StateMachineExecutionEngine();
    const runner = new TeamsWebhookRunner(engine, cfg, {
      appId: 'test-app-id',
      appPassword: 'test-app-password',
    });
    (runner as any).client = fakeTeamsClient;
    runner.setTaskStore(taskStore, 'test-teams-live.yaml');

    const handlePromise = (runner as any).handleMessage(mkMsg());

    await Promise.resolve();
    await Promise.resolve();
    expect(fakeTeamsClient.sendMessage).not.toHaveBeenCalled();
    expect(fakeTeamsClient.updateMessage).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(10_000);
    await Promise.resolve();

    expect(serializeTraceForPrompt).toHaveBeenCalled();
    expect(
      probeAnswer.mock.calls.some(call => String(call[0] || '').includes('<execution_trace>'))
    ).toBe(true);
    expect(fakeTeamsClient.sendMessage).toHaveBeenCalledTimes(1);
    expect(fakeTeamsClient.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationReference: mkMsg().conversationReference,
        replyToActivityId: 'act.msg1',
        text: expect.stringContaining('Inspecting the gateway rate-limiting path'),
      })
    );

    pending.resolve({
      reviewSummary: {
        history: {
          'generate-response': [{ text: 'Final answer text' }],
        },
      },
    });
    await handlePromise;

    expect(fakeTeamsClient.updateMessage).toHaveBeenCalledTimes(1);
    expect(fakeTeamsClient.updateMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationReference: mkMsg().conversationReference,
        activityId: 'act.reply1',
        text: expect.stringContaining('Final answer text'),
      })
    );

    const { tasks } = taskStore.listTasks({ state: ['completed'] });
    expect(tasks).toHaveLength(1);
    const task = tasks[0];
    expect(task.metadata?.teams_live_update_activity_id).toBe('act.reply1');
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

    const fakeTeamsClient = {
      sendMessage: jest.fn(async () => ({ ok: true, activityId: 'act.reply1' })),
      updateMessage: jest.fn(async () => ({ ok: true, activityId: 'act.reply1' })),
      deleteMessage: jest.fn(async () => true),
    };

    const engine = new StateMachineExecutionEngine();
    const runner = new TeamsWebhookRunner(engine, cfg, {
      appId: 'test-app-id',
      appPassword: 'test-app-password',
    });
    (runner as any).client = fakeTeamsClient;
    runner.setTaskStore(taskStore, 'test-teams-live.yaml');

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
    expect(fakeTeamsClient.sendMessage).not.toHaveBeenCalled();
    expect(fakeTeamsClient.updateMessage).not.toHaveBeenCalled();

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
