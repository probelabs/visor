/* eslint-disable @typescript-eslint/no-explicit-any */
import * as fs from 'fs';
import * as path from 'path';

describe('Telemetry E2E — fail_if events and metrics', () => {
  const tracesDir = path.join(__dirname, '..', 'fixtures', 'temp', 'traces-failif');

  beforeEach(() => {
    fs.mkdirSync(tracesDir, { recursive: true });
    process.env.VISOR_TELEMETRY_ENABLED = 'true';
    process.env.VISOR_TELEMETRY_SINK = 'file';
    process.env.VISOR_TRACE_DIR = tracesDir;
    process.env.VISOR_TEST_METRICS = 'true';
  });

  afterEach(() => {
    delete process.env.VISOR_TEST_METRICS;
  });

  it('emits fail_if.evaluated and fail_if.triggered events and increments metric', async () => {
    const { initTelemetry, shutdownTelemetry } = await import('../../src/telemetry/opentelemetry');
    const { withActiveSpan } = await import('../../src/telemetry/trace-helpers');
    const { getTestMetricsSnapshot } = await import('../../src/telemetry/metrics');
    const { CheckExecutionEngine } = await import('../../src/check-execution-engine');

    await initTelemetry({ enabled: true, sink: 'file', file: { dir: tracesDir, ndjson: true } });

    await withActiveSpan('test.run', {}, async () => {
      const engine = new CheckExecutionEngine();
      const config: any = {
        version: '1.0',
        checks: {
          'sample': { type: 'noop', fail_if: 'true', group: 'test' },
        },
      };
      const reviewSummary = { issues: [] };
      await engine.evaluateFailureConditions('sample', reviewSummary as any, config);
    });

    await shutdownTelemetry();

    // Assert metric increment via test snapshot
    const snap = getTestMetricsSnapshot();
    expect(snap.fail_if_triggered).toBeGreaterThanOrEqual(1);

    // Verify NDJSON includes events
    const files = fs.readdirSync(tracesDir).filter(f => f.endsWith('.ndjson'));
    expect(files.length).toBeGreaterThan(0);
    const newest = files
      .map(f => ({ f, t: fs.statSync(path.join(tracesDir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)[0].f;
    const lines = fs
      .readFileSync(path.join(tracesDir, newest), 'utf8')
      .trim()
      .split(/\r?\n/)
      .map(l => JSON.parse(l));
    const hasEvaluated = lines.some((s: any) => (s.events || []).some((e: any) => e.name === 'fail_if.evaluated'));
    const hasTriggered = lines.some((s: any) => (s.events || []).some((e: any) => e.name === 'fail_if.triggered'));
    expect(hasEvaluated).toBe(true);
    expect(hasTriggered).toBe(true);
  });
});

