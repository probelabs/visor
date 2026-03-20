import fs from 'fs';
import os from 'os';
import path from 'path';

describe('ChildTraceTailer', () => {
  const tmpDir = path.join(os.tmpdir(), 'visor-child-trace-tests');

  beforeEach(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    jest.resetModules();
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    jest.restoreAllMocks();
  });

  it('streams appended child spans before stop and handles partial lines', async () => {
    const spansStarted: string[] = [];
    const spanEvents: Array<{ span: string; event: string }> = [];
    const spanParents: Array<{ span: string; parent: unknown }> = [];
    const tracer = {
      startSpan: jest.fn((name: string, _options?: unknown, parentContext?: unknown) => {
        spansStarted.push(name);
        spanParents.push({ span: name, parent: parentContext });
        return {
          addEvent: jest.fn((eventName: string) => {
            spanEvents.push({ span: name, event: eventName });
          }),
          setStatus: jest.fn(),
          end: jest.fn(),
        };
      }),
    };

    jest.doMock('../../../src/telemetry/trace-helpers', () => ({
      getTracer: () => tracer,
    }));
    jest.doMock('../../../src/telemetry/lazy-otel', () => ({
      context: {
        active: () => ({ ctx: 'parent' }),
        with: (_ctx: unknown, fn: () => void) => fn(),
      },
      trace: {
        setSpan: (_ctx: unknown, span: any) => ({ replayParent: span }),
      },
      SpanStatusCode: { ERROR: 2 },
    }));

    const { ChildTraceTailer } = await import('../../../src/sandbox/trace-ingester');
    const traceFile = path.join(tmpDir, `trace-${Date.now()}.ndjson`);
    fs.writeFileSync(traceFile, '', 'utf8');

    const tailer = new ChildTraceTailer(traceFile, { pollIntervalMs: 20 });
    tailer.start();

    const firstLine =
      JSON.stringify({
        traceId: 't1',
        spanId: 's1',
        name: 'alpha',
        startTime: [1, 0],
        endTime: [1, 1],
        events: [{ name: 'first-event', attributes: { a: 1 } }],
      }) + '\n';
    const secondLinePrefix = JSON.stringify({
      traceId: 't1',
      spanId: 's2',
      name: 'beta',
      startTime: [2, 0],
      endTime: [2, 1],
    });

    fs.appendFileSync(traceFile, firstLine, 'utf8');
    fs.appendFileSync(
      traceFile,
      secondLinePrefix.slice(0, Math.floor(secondLinePrefix.length / 2))
    );

    await new Promise(resolve => setTimeout(resolve, 80));

    expect(spansStarted).toContain('alpha');
    expect(spansStarted).not.toContain('beta');
    expect(spanEvents).toEqual([{ span: 'alpha', event: 'first-event' }]);

    fs.appendFileSync(
      traceFile,
      secondLinePrefix.slice(Math.floor(secondLinePrefix.length / 2)) + '\n'
    );

    await new Promise(resolve => setTimeout(resolve, 80));
    await tailer.stop();

    expect(spansStarted.filter(name => name === 'alpha')).toHaveLength(1);
    expect(spansStarted.filter(name => name === 'beta')).toHaveLength(1);
    expect(tracer.startSpan).toHaveBeenCalledTimes(2);
    expect(spanParents).toEqual([
      { span: 'alpha', parent: { ctx: 'parent' } },
      { span: 'beta', parent: { ctx: 'parent' } },
    ]);
  });

  it('replays child hierarchy under the replayed parent when parent is available', async () => {
    const spanParents: Array<{ span: string; parent: unknown }> = [];
    const tracer = {
      startSpan: jest.fn((name: string, _options?: unknown, parentContext?: unknown) => {
        spanParents.push({ span: name, parent: parentContext });
        return {
          addEvent: jest.fn(),
          setStatus: jest.fn(),
          end: jest.fn(),
        };
      }),
    };

    jest.doMock('../../../src/telemetry/trace-helpers', () => ({
      getTracer: () => tracer,
    }));
    jest.doMock('../../../src/telemetry/lazy-otel', () => ({
      context: {
        active: () => ({ ctx: 'bridge' }),
        with: (_ctx: unknown, fn: () => void) => fn(),
      },
      trace: {
        setSpan: (_ctx: unknown, span: any) => ({ replayParent: span }),
      },
      SpanStatusCode: { ERROR: 2 },
    }));

    const { ingestChildTrace } = await import('../../../src/sandbox/trace-ingester');
    const traceFile = path.join(tmpDir, `trace-parent-${Date.now()}.ndjson`);
    fs.writeFileSync(
      traceFile,
      [
        JSON.stringify({
          traceId: 't1',
          spanId: 'parent',
          name: 'visor.check.sandbox-probe',
          startTime: [1, 0],
          endTime: [2, 0],
        }),
        JSON.stringify({
          traceId: 't1',
          spanId: 'child',
          parentSpanId: 'parent',
          name: 'ai.request',
          startTime: [1, 1],
          endTime: [1, 9],
        }),
      ].join('\n') + '\n',
      'utf8'
    );

    ingestChildTrace(traceFile, { parentContext: { ctx: 'bridge' } });

    expect(spanParents).toHaveLength(2);
    expect(spanParents[0]).toEqual({
      span: 'visor.check.sandbox-probe',
      parent: { ctx: 'bridge' },
    });
    expect(spanParents[1].span).toBe('ai.request');
    expect(spanParents[1].parent).toEqual({
      replayParent: expect.objectContaining({
        addEvent: expect.any(Function),
        end: expect.any(Function),
      }),
    });
  });
});
