import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  DEFAULT_TASK_LIVE_UPDATE_PROMPT,
  extractTraceSkillMetadata,
  isFrontendLiveUpdatesEnabled,
  resolveTaskLiveUpdatesConfig,
  summarizeTaskProgress,
  TaskLiveUpdateManager,
} from '../../../src/agent-protocol/task-live-updates';

const probeAnswer = jest.fn(async () => '- Progress: working');

jest.mock('@probelabs/probe', () => ({
  ProbeAgent: class FakeProbeAgent {
    async initialize() {}
    async answer(prompt: string) {
      return probeAnswer(prompt);
    }
  },
}));

describe('task-live-updates', () => {
  afterEach(() => {
    jest.useRealTimers();
    probeAnswer.mockClear();
  });

  it('resolves defaults from boolean config', () => {
    const resolved = resolveTaskLiveUpdatesConfig(true);
    expect(resolved).toBeTruthy();
    expect(resolved?.enabled).toBe(true);
    expect(resolved?.intervalSeconds).toBe(10);
    expect(resolved?.model).toBe('gemini-3.1-flash-lite-preview');
  });

  it('honors per-frontend overrides', () => {
    expect(
      isFrontendLiveUpdatesEnabled(
        { enabled: true, frontends: { slack: { enabled: false } } },
        'slack'
      )
    ).toBe(false);
    expect(
      isFrontendLiveUpdatesEnabled(
        { enabled: true, frontends: { slack: { enabled: false } } },
        'telegram'
      )
    ).toBe(true);
  });

  it('posts periodic updates and finalizes on the same manager', async () => {
    jest.useFakeTimers();

    const sink = {
      kind: 'test',
      start: jest.fn(async () => null),
      update: jest.fn(async () => ({ ref: { id: 'status-1' } })),
      complete: jest.fn(async () => null),
      fail: jest.fn(async () => null),
    };

    const manager = new TaskLiveUpdateManager(
      {
        taskId: 'task-1',
        requestText: 'Investigate the issue',
        traceRef: '/tmp/trace.ndjson',
        sink,
        config: {
          enabled: true,
          intervalSeconds: 1,
          model: 'gemini-3.1-flash-lite-preview',
          prompt: 'prompt',
          initialMessage: '',
          maxTraceChars: 4000,
        },
      },
      {
        serializeTrace: jest
          .fn()
          .mockResolvedValueOnce('trace-1')
          .mockResolvedValueOnce('trace-1')
          .mockResolvedValueOnce('trace-2'),
        extractSkillMetadata: jest.fn(async () => ({
          activatedSkills: ['code-explorer', 'engineer'],
          taskSummary: {
            tasksEnabled: true,
            source: 'snapshot',
            eventCount: 4,
            snapshotCount: 1,
            tasks: [
              { id: 'explore', title: 'Explore codebase', status: 'completed' },
              { id: 'implement', title: 'Implement changes', status: 'in_progress' },
            ],
            scopes: [
              {
                label: 'Main Agent',
                source: 'snapshot',
                eventCount: 2,
                snapshotCount: 1,
                tasks: [{ id: 'explore', title: 'Explore codebase', status: 'completed' }],
                children: [
                  {
                    label: 'Code Explorer',
                    source: 'snapshot',
                    eventCount: 2,
                    snapshotCount: 1,
                    tasks: [{ id: 'implement', title: 'Implement changes', status: 'in_progress' }],
                    children: [
                      {
                        label: 'Search Delegate',
                        source: 'events',
                        eventCount: 1,
                        snapshotCount: 0,
                        tasks: [
                          {
                            id: '__scope_1',
                            title: 'Search Delegate',
                            status: 'completed',
                            synthetic: true,
                          },
                        ],
                        children: [],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        })),
        summarizeProgress: jest
          .fn()
          .mockResolvedValueOnce('- looking at logs')
          .mockResolvedValueOnce('- running tests'),
      }
    );

    await manager.start();
    expect(sink.start).toHaveBeenCalledTimes(1);
    expect(sink.update).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(10_000);
    expect(sink.update).toHaveBeenCalledWith(expect.stringContaining('*Live Update*'));
    expect(sink.update).toHaveBeenCalledWith(expect.stringContaining('*Tasks*'));
    expect(sink.update).toHaveBeenCalledWith(expect.stringContaining('• [x] Explore codebase'));
    expect(sink.update).toHaveBeenCalledWith(expect.stringContaining('Code Explorer'));
    expect(sink.update).toHaveBeenCalledWith(expect.stringContaining('• [~] Implement changes'));
    expect(sink.update).not.toHaveBeenCalledWith(expect.stringContaining('Search Delegate'));
    expect(sink.update).toHaveBeenCalledWith(expect.stringContaining('- looking at logs'));
    expect(sink.update).toHaveBeenCalledWith(
      expect.stringContaining('_Metadata: elapsed 10s | first live update')
    );
    expect(sink.update).toHaveBeenCalledWith(
      expect.stringContaining('activated skills code-explorer, engineer')
    );

    await jest.advanceTimersByTimeAsync(1000);
    expect(sink.update).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1000);
    expect(sink.update).toHaveBeenCalledWith(expect.stringContaining('- running tests'));

    await manager.complete('Final answer');
    expect(sink.complete).toHaveBeenCalledWith('Final answer');
  });

  it('posts the final answer immediately when work finishes before the first tick', async () => {
    jest.useFakeTimers();

    const sink = {
      kind: 'test',
      start: jest.fn(async () => null),
      update: jest.fn(async () => null),
      complete: jest.fn(async () => ({ ref: { id: 'status-1' } })),
      fail: jest.fn(async () => null),
    };

    const manager = new TaskLiveUpdateManager(
      {
        taskId: 'task-fast',
        requestText: 'Short task',
        traceRef: '/tmp/trace.ndjson',
        sink,
        config: {
          enabled: true,
          intervalSeconds: 30,
          model: 'gemini-3.1-flash-lite-preview',
          prompt: 'prompt',
          initialMessage: '',
          maxTraceChars: 4000,
        },
      },
      {
        serializeTrace: jest.fn(async () => 'trace-1'),
        extractSkillMetadata: jest.fn(async () => undefined),
        summarizeProgress: jest.fn(async () => '- looking at logs'),
      }
    );

    await manager.start();
    await manager.complete('Final answer');
    await jest.advanceTimersByTimeAsync(15_000);

    expect(sink.update).not.toHaveBeenCalled();
    expect(sink.complete).toHaveBeenCalledWith('Final answer');
  });

  it('does not let an in-flight progress tick overwrite the final update', async () => {
    let resolveSummary: ((value: string | null) => void) | undefined;
    const summaryPromise = new Promise<string | null>(resolve => {
      resolveSummary = resolve;
    });

    const sink = {
      kind: 'test',
      start: jest.fn(async () => null),
      update: jest.fn(async () => null),
      complete: jest.fn(async () => null),
      fail: jest.fn(async () => null),
    };

    const manager = new TaskLiveUpdateManager(
      {
        taskId: 'task-race',
        requestText: 'Investigate the issue',
        traceRef: '/tmp/trace.ndjson',
        sink,
        config: {
          enabled: true,
          intervalSeconds: 10,
          model: 'gemini-3.1-flash-lite-preview',
          prompt: 'prompt',
          initialMessage: '',
          maxTraceChars: 4000,
        },
      },
      {
        serializeTrace: jest.fn(async () => 'trace-race-1'),
        extractSkillMetadata: jest.fn(async () => undefined),
        summarizeProgress: jest.fn(async () => summaryPromise),
      }
    );

    const tickPromise = manager.tick();
    await Promise.resolve();

    const completionPromise = manager.complete('Final answer');
    resolveSummary?.('- Progress: stale progress update');
    await completionPromise;
    await tickPromise;

    expect(sink.complete).toHaveBeenCalledWith('Final answer');
    expect(sink.update).not.toHaveBeenCalled();
  });

  it('does not delay final completion while a progress summary is still running', async () => {
    let resolveSummary: ((value: string | null) => void) | undefined;
    const summaryPromise = new Promise<string | null>(resolve => {
      resolveSummary = resolve;
    });

    const sink = {
      kind: 'test',
      start: jest.fn(async () => null),
      update: jest.fn(async () => null),
      complete: jest.fn(async () => null),
      fail: jest.fn(async () => null),
    };

    const manager = new TaskLiveUpdateManager(
      {
        taskId: 'task-complete-fast',
        requestText: 'Investigate the issue',
        traceRef: '/tmp/trace.ndjson',
        sink,
        config: {
          enabled: true,
          intervalSeconds: 10,
          model: 'gemini-3.1-flash-lite-preview',
          prompt: 'prompt',
          initialMessage: '',
          maxTraceChars: 4000,
        },
      },
      {
        serializeTrace: jest.fn(async () => 'trace-race-1'),
        extractSkillMetadata: jest.fn(async () => undefined),
        summarizeProgress: jest.fn(async () => summaryPromise),
      }
    );

    void manager.tick();
    await Promise.resolve();

    await manager.complete('Final answer');

    expect(sink.complete).toHaveBeenCalledWith('Final answer');
    expect(sink.update).not.toHaveBeenCalled();

    resolveSummary?.('- Progress: stale progress update');
    await Promise.resolve();
  });

  it('does not let a later interval callback lose track of the real in-flight tick before completion', async () => {
    jest.useFakeTimers();

    let resolveMetadata: ((value: undefined) => void) | undefined;
    const metadataPromise = new Promise<undefined>(resolve => {
      resolveMetadata = resolve;
    });

    const sink = {
      kind: 'test',
      start: jest.fn(async () => null),
      update: jest.fn(async () => null),
      complete: jest.fn(async () => null),
      fail: jest.fn(async () => null),
    };

    const manager = new TaskLiveUpdateManager(
      {
        taskId: 'task-scheduled-race',
        requestText: 'Investigate the issue',
        traceRef: '/tmp/trace.ndjson',
        sink,
        config: {
          enabled: true,
          intervalSeconds: 1,
          model: 'gemini-3.1-flash-lite-preview',
          prompt: 'prompt',
          initialMessage: '',
          maxTraceChars: 4000,
        },
      },
      {
        serializeTrace: jest
          .fn()
          .mockResolvedValueOnce('trace-initial')
          .mockResolvedValueOnce('trace-stale'),
        extractSkillMetadata: jest
          .fn()
          .mockResolvedValueOnce(undefined)
          .mockImplementationOnce(() => metadataPromise),
        summarizeProgress: jest
          .fn()
          .mockResolvedValueOnce('- Progress: initial live update')
          .mockResolvedValueOnce('- Progress: stale scheduled update'),
      }
    );

    await manager.start();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(sink.update).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1_000);
    await Promise.resolve();

    await jest.advanceTimersByTimeAsync(1_000);
    const completionPromise = manager.complete('Final answer');
    await Promise.resolve();

    resolveMetadata?.(undefined);
    await completionPromise;

    expect(sink.complete).toHaveBeenCalledWith('Final answer');
    expect(sink.update).toHaveBeenCalledTimes(1);
    expect(sink.update).not.toHaveBeenCalledWith(expect.stringContaining('stale scheduled update'));
  });

  it('appends task id to progress and final updates when enabled', async () => {
    jest.useFakeTimers();

    const sink = {
      kind: 'test',
      start: jest.fn(async () => null),
      update: jest.fn(async () => null),
      complete: jest.fn(async () => null),
      fail: jest.fn(async () => null),
    };

    const manager = new TaskLiveUpdateManager(
      {
        taskId: 'task-trace',
        requestText: 'Trace-aware task',
        traceRef: 'trace-123',
        traceId: 'trace-123',
        includeTraceId: true,
        sink,
        config: {
          enabled: true,
          intervalSeconds: 30,
          model: 'gemini-3.1-flash-lite-preview',
          prompt: 'prompt',
          initialMessage: '',
          maxTraceChars: 4000,
        },
      },
      {
        serializeTrace: jest.fn(async () => 'trace-1'),
        extractSkillMetadata: jest.fn(async () => undefined),
        summarizeProgress: jest.fn(async () => '- looking at logs'),
      }
    );

    await manager.start();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(sink.update).toHaveBeenCalledWith(expect.stringContaining('`task_id: task-trace`'));

    await manager.complete('Final answer');
    expect(sink.complete).toHaveBeenCalledWith('Final answer\n\n`task_id: task-trace`');
  });

  it('passes elapsed and previous-update timing context into progress summarization', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-03-21T06:00:00.000Z'));

    const sink = {
      kind: 'test',
      start: jest.fn(async () => null),
      update: jest.fn(async () => null),
      complete: jest.fn(async () => null),
      fail: jest.fn(async () => null),
    };
    const summarizeProgress = jest
      .fn()
      .mockResolvedValueOnce('- first update')
      .mockResolvedValueOnce('- second update');

    const manager = new TaskLiveUpdateManager(
      {
        taskId: 'task-metadata',
        requestText: 'Investigate the issue',
        traceRef: '/tmp/trace.ndjson',
        sink,
        config: {
          enabled: true,
          intervalSeconds: 10,
          model: 'gemini-3.1-flash-lite-preview',
          prompt: 'prompt',
          initialMessage: '',
          maxTraceChars: 4000,
        },
      },
      {
        serializeTrace: jest
          .fn()
          .mockResolvedValueOnce('trace-snapshot-1')
          .mockResolvedValueOnce('trace-snapshot-2'),
        extractSkillMetadata: jest.fn(async () => undefined),
        summarizeProgress,
      }
    );

    await manager.start();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(summarizeProgress).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        elapsedSeconds: 10,
        previousUpdateAt: undefined,
        secondsSincePreviousUpdate: undefined,
      })
    );

    jest.setSystemTime(new Date('2026-03-21T06:00:25.000Z'));
    await manager.tick();
    expect(summarizeProgress).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        elapsedSeconds: 25,
        previousUpdateAt: expect.any(Date),
        secondsSincePreviousUpdate: 15,
      })
    );
  });

  it('prefers trace_file over trace_id when refreshed trace state contains both', async () => {
    jest.useFakeTimers();

    const sink = {
      kind: 'test',
      start: jest.fn(async () => null),
      update: jest.fn(async () => null),
      complete: jest.fn(async () => null),
      fail: jest.fn(async () => null),
    };
    const serializeTrace = jest.fn(async () => 'trace-snapshot');

    const manager = new TaskLiveUpdateManager(
      {
        taskId: 'task-trace-preference',
        requestText: 'Investigate the issue',
        traceRef: 'trace-id-only',
        traceId: 'trace-id-only',
        resolveTraceState: () => ({
          traceRef: '/tmp/real-trace.ndjson',
          traceId: 'trace-id-only',
        }),
        sink,
        config: {
          enabled: true,
          intervalSeconds: 30,
          model: 'gemini-3.1-flash-lite-preview',
          prompt: 'prompt',
          initialMessage: '',
          maxTraceChars: 4000,
        },
      },
      {
        serializeTrace,
        extractSkillMetadata: jest.fn(async () => undefined),
        summarizeProgress: jest.fn(async () => '- Progress: tracing'),
      }
    );

    await manager.start();
    await jest.advanceTimersByTimeAsync(10_000);

    expect(serializeTrace).toHaveBeenCalledWith('/tmp/real-trace.ndjson', 4000, 'trace-id-only');
    expect(sink.update).toHaveBeenCalled();
  });

  it('extracts task metadata from the requested trace when a local NDJSON file contains multiple traces', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-live-updates-'));
    const traceFile = path.join(tempDir, 'mixed.ndjson');
    const wrongTraceId = '11111111111111111111111111111111';
    const rightTraceId = '22222222222222222222222222222222';

    const lines = [
      JSON.stringify({
        name: 'probe.event.task.created',
        traceId: wrongTraceId,
        spanId: 'span-wrong-task',
        startTime: [1, 0],
        endTime: [1, 1000],
        attributes: {
          'probe.event.name': 'task.created',
          'task.action': 'create',
          'task.id': 'fetch-pipeline-activity',
          'task.title': 'Fetch Pipeline Activity',
        },
        events: [],
        status: { code: 1 },
      }),
      JSON.stringify({
        name: 'visor.check',
        traceId: rightTraceId,
        spanId: 'span-build-config',
        startTime: [2, 0],
        endTime: [2, 1000],
        attributes: {
          'visor.check.id': 'build-config',
          'visor.check.output': JSON.stringify({ activated_skills: ['code-explorer'] }),
        },
        events: [],
        status: { code: 1 },
      }),
      JSON.stringify({
        name: 'probe.event.task.created',
        traceId: rightTraceId,
        spanId: 'span-right-task',
        startTime: [3, 0],
        endTime: [3, 1000],
        attributes: {
          'probe.event.name': 'task.created',
          'task.action': 'create',
          'task.id': 'validate-gateway',
          'task.title': 'Validate Gateway',
        },
        events: [],
        status: { code: 1 },
      }),
      JSON.stringify({
        name: 'probe.event.task.updated',
        traceId: rightTraceId,
        spanId: 'span-right-task-update',
        startTime: [4, 0],
        endTime: [4, 1000],
        attributes: {
          'probe.event.name': 'task.updated',
          'task.action': 'update',
          'task.id': 'validate-gateway',
          'task.new_status': 'in_progress',
          'task.fields_updated': 'status',
        },
        events: [],
        status: { code: 1 },
      }),
    ];

    fs.writeFileSync(traceFile, `${lines.join('\n')}\n`, 'utf8');

    try {
      const metadata = await extractTraceSkillMetadata(traceFile, rightTraceId);
      expect(metadata?.activatedSkills).toEqual(['code-explorer']);
      expect(metadata?.taskSummary?.tasks).toEqual([
        { id: 'validate-gateway', title: 'Validate Gateway', status: 'in_progress' },
      ]);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('refreshes only metadata every 5 seconds without making another LLM call', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-03-21T07:10:48.000Z'));

    const sink = {
      kind: 'test',
      start: jest.fn(async () => null),
      update: jest.fn(async () => null),
      complete: jest.fn(async () => null),
      fail: jest.fn(async () => null),
    };
    const summarizeProgress = jest.fn(async () =>
      [
        '- Progress: tracing the rate limiting path',
        '- Last done: identified the gateway middleware entry point',
        '- Now: following the enforcement flow through the gateway',
        '- Waiting on: nothing blocking right now',
      ].join('\n')
    );

    const manager = new TaskLiveUpdateManager(
      {
        taskId: 'task-refresh',
        requestText: 'How api rate limiting works?',
        traceRef: '/tmp/trace.ndjson',
        sink,
        config: {
          enabled: true,
          intervalSeconds: 30,
          model: 'gemini-3.1-flash-lite-preview',
          prompt: 'prompt',
          initialMessage: '',
          maxTraceChars: 4000,
        },
      },
      {
        serializeTrace: jest.fn(async () => 'trace-snapshot-1'),
        extractSkillMetadata: jest.fn(async () => undefined),
        summarizeProgress,
      }
    );

    await manager.start();
    await jest.advanceTimersByTimeAsync(10_000);

    expect(summarizeProgress).toHaveBeenCalledTimes(1);
    expect(sink.update).toHaveBeenCalledTimes(1);
    expect(sink.update).toHaveBeenLastCalledWith(
      expect.stringContaining('_Metadata: elapsed 10s | first live update')
    );

    jest.setSystemTime(new Date('2026-03-21T07:10:58.000Z'));
    await jest.advanceTimersByTimeAsync(5_000);

    expect(summarizeProgress).toHaveBeenCalledTimes(1);
    expect(sink.update).toHaveBeenCalledTimes(2);
    expect(sink.update).toHaveBeenLastCalledWith(
      expect.stringContaining(
        '_Metadata: elapsed 15s | previous update 5s ago | at 2026-03-21T07:10:58.000Z'
      )
    );
  });

  it('publishes a deterministic fallback update when semantic progress stalls', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-03-21T07:20:00.000Z'));

    const sink = {
      kind: 'test',
      start: jest.fn(async () => null),
      update: jest.fn(async () => null),
      complete: jest.fn(async () => null),
      fail: jest.fn(async () => null),
    };
    const summarizeProgress = jest
      .fn()
      .mockResolvedValueOnce(
        [
          '- Progress: tracing the rate limiting path',
          '- Last done: identified the gateway middleware entry point',
          '- Now: following the enforcement flow through the gateway',
          '- Waiting on: nothing blocking right now',
        ].join('\n')
      )
      .mockResolvedValueOnce(null);

    const manager = new TaskLiveUpdateManager(
      {
        taskId: 'task-stall',
        requestText: 'How api rate limiting works?',
        traceRef: '/tmp/trace.ndjson',
        sink,
        config: {
          enabled: true,
          intervalSeconds: 10,
          model: 'gemini-3.1-flash-lite-preview',
          prompt: 'prompt',
          initialMessage: '',
          maxTraceChars: 4000,
        },
      },
      {
        serializeTrace: jest
          .fn()
          .mockResolvedValueOnce('trace-snapshot-1')
          .mockResolvedValueOnce('trace-snapshot-2 search.delegate ai.request'),
        extractSkillMetadata: jest.fn(async () => undefined),
        summarizeProgress,
      }
    );

    await manager.start();
    await jest.advanceTimersByTimeAsync(10_000);
    expect(sink.update).toHaveBeenCalledTimes(1);

    jest.setSystemTime(new Date('2026-03-21T07:21:10.000Z'));
    await manager.tick();

    expect(summarizeProgress).toHaveBeenCalledTimes(2);
    expect(sink.update).toHaveBeenCalledTimes(2);
    expect(sink.update).toHaveBeenLastCalledWith(
      expect.stringContaining('Progress: tracing the rate limiting path')
    );
    expect(sink.update).toHaveBeenLastCalledWith(
      expect.stringContaining(
        'Some steps can stay quiet for up to 5 minutes before there is new news'
      )
    );
    expect(sink.update).toHaveBeenLastCalledWith(
      expect.stringContaining('Last done: identified the gateway middleware entry point')
    );
    expect(sink.update).toHaveBeenLastCalledWith(
      expect.stringContaining('Waiting on: nothing blocking right now')
    );
  });

  it('removes the stall notice once a new semantic update is available', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-03-21T07:20:00.000Z'));

    const sink = {
      kind: 'test',
      start: jest.fn(async () => null),
      update: jest.fn(async () => null),
      complete: jest.fn(async () => null),
      fail: jest.fn(async () => null),
    };
    const summarizeProgress = jest
      .fn()
      .mockResolvedValueOnce(
        [
          '- Progress: tracing the rate limiting path',
          '- Last done: identified the gateway middleware entry point',
          '- Now: following the enforcement flow through the gateway',
          '- Waiting on: nothing blocking right now',
        ].join('\n')
      )
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(
        [
          '- Progress: traced the request path into the limiter',
          '- Last done: verified where the middleware invokes the limiter',
          '- Now: checking how enforcement decisions are persisted',
          '- Waiting on: nothing blocking right now',
        ].join('\n')
      );

    const manager = new TaskLiveUpdateManager(
      {
        taskId: 'task-stall-reset',
        requestText: 'How api rate limiting works?',
        traceRef: '/tmp/trace.ndjson',
        sink,
        config: {
          enabled: true,
          intervalSeconds: 10,
          model: 'gemini-3.1-flash-lite-preview',
          prompt: 'prompt',
          initialMessage: '',
          maxTraceChars: 4000,
        },
      },
      {
        serializeTrace: jest
          .fn()
          .mockResolvedValueOnce('trace-snapshot-1')
          .mockResolvedValueOnce('trace-snapshot-2 search.delegate ai.request')
          .mockResolvedValueOnce('trace-snapshot-3 engineer tests'),
        extractSkillMetadata: jest.fn(async () => undefined),
        summarizeProgress,
      }
    );

    await manager.start();
    await jest.advanceTimersByTimeAsync(10_000);

    jest.setSystemTime(new Date('2026-03-21T07:21:10.000Z'));
    await manager.tick();
    expect(sink.update).toHaveBeenLastCalledWith(
      expect.stringContaining(
        'Some steps can stay quiet for up to 5 minutes before there is new news'
      )
    );

    jest.setSystemTime(new Date('2026-03-21T07:21:20.000Z'));
    await manager.tick();
    expect(sink.update).toHaveBeenLastCalledWith(
      expect.stringContaining('Progress: traced the request path into the limiter')
    );
    expect(sink.update).not.toHaveBeenLastCalledWith(
      expect.stringContaining(
        'Some steps can stay quiet for up to 5 minutes before there is new news'
      )
    );
  });

  it('falls back to a deterministic summary only when no prior semantic update exists', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-03-21T07:20:00.000Z'));

    const sink = {
      kind: 'test',
      start: jest.fn(async () => null),
      update: jest.fn(async () => null),
      complete: jest.fn(async () => null),
      fail: jest.fn(async () => null),
    };

    const manager = new TaskLiveUpdateManager(
      {
        taskId: 'task-stall-initial',
        requestText: 'How api rate limiting works?',
        traceRef: '/tmp/trace.ndjson',
        sink,
        config: {
          enabled: true,
          intervalSeconds: 10,
          model: 'gemini-3.1-flash-lite-preview',
          prompt: 'prompt',
          initialMessage: '',
          maxTraceChars: 4000,
        },
      },
      {
        serializeTrace: jest.fn(async () => 'trace-snapshot-1 search.delegate ai.request'),
        extractSkillMetadata: jest.fn(async () => undefined),
        summarizeProgress: jest.fn(async () => null),
      }
    );

    await manager.start();
    jest.setSystemTime(new Date('2026-03-21T07:21:10.000Z'));
    await manager.tick();

    expect(sink.update).toHaveBeenCalledTimes(1);
    expect(sink.update).toHaveBeenLastCalledWith(
      expect.stringContaining('still working through the same step; no new completed action yet')
    );
    expect(sink.update).toHaveBeenLastCalledWith(
      expect.stringContaining('Waiting on: search results and downstream analysis to finish')
    );
  });

  it('default prompt requires short progress-oriented updates with static metadata', () => {
    expect(DEFAULT_TASK_LIVE_UPDATE_PROMPT).toContain('overall progress');
    expect(DEFAULT_TASK_LIVE_UPDATE_PROMPT).toContain('last meaningful action');
    expect(DEFAULT_TASK_LIVE_UPDATE_PROMPT).toContain(
      'Timing metadata is provided only so you understand task pace and recency'
    );
    expect(DEFAULT_TASK_LIVE_UPDATE_PROMPT).toContain(
      'The system will append timing and task metadata separately'
    );
    expect(DEFAULT_TASK_LIVE_UPDATE_PROMPT).toContain('This is NOT the final answer');
    expect(DEFAULT_TASK_LIVE_UPDATE_PROMPT).toContain("Do NOT answer the user's original request");
    expect(DEFAULT_TASK_LIVE_UPDATE_PROMPT).toContain('Never write a complete answer');
    expect(DEFAULT_TASK_LIVE_UPDATE_PROMPT).toContain('Required output format');
    expect(DEFAULT_TASK_LIVE_UPDATE_PROMPT).toContain('- Progress:');
    expect(DEFAULT_TASK_LIVE_UPDATE_PROMPT).toContain('- Last done:');
    expect(DEFAULT_TASK_LIVE_UPDATE_PROMPT).toContain('- Now:');
    expect(DEFAULT_TASK_LIVE_UPDATE_PROMPT).toContain('- Waiting on:');
    expect(DEFAULT_TASK_LIVE_UPDATE_PROMPT).not.toContain('- Timing:');
    expect(DEFAULT_TASK_LIVE_UPDATE_PROMPT).toContain('Trace interpretation rules');
    expect(DEFAULT_TASK_LIVE_UPDATE_PROMPT).toContain('completion prompts');
    expect(DEFAULT_TASK_LIVE_UPDATE_PROMPT).toContain('preparing the final response');
  });

  it('injects timing metadata into the summarizer prompt', async () => {
    await summarizeTaskProgress({
      requestText: 'How api rate limiting works?',
      previousUpdate: '- inspected config loading',
      traceSnapshot: 'trace snapshot',
      config: {
        enabled: true,
        intervalSeconds: 10,
        model: 'gemini-3.1-flash-lite-preview',
        provider: 'google',
        prompt: 'system prompt',
        initialMessage: '',
        maxTraceChars: 4000,
      },
      startedAt: new Date('2026-03-21T06:00:00.000Z'),
      now: new Date('2026-03-21T06:00:42.000Z'),
      elapsedSeconds: 42,
      previousUpdateAt: new Date('2026-03-21T06:00:25.000Z'),
      secondsSincePreviousUpdate: 17,
    });

    expect(probeAnswer).toHaveBeenCalledWith(expect.stringContaining('<timing>'));
    expect(probeAnswer).toHaveBeenCalledWith(expect.stringContaining('elapsed: 42s'));
    expect(probeAnswer).toHaveBeenCalledWith(
      expect.stringContaining('last_update_at: 2026-03-21T06:00:25.000Z')
    );
    expect(probeAnswer).toHaveBeenCalledWith(
      expect.stringContaining('time_since_last_update: 17s')
    );
    expect(DEFAULT_TASK_LIVE_UPDATE_PROMPT).toContain(
      'The system will append timing and task metadata separately'
    );
  });
});
