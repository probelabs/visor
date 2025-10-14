/* eslint-disable @typescript-eslint/no-explicit-any */
import * as fs from 'fs';
import * as path from 'path';

describe('Telemetry E2E — fail_if events and metrics', () => {
  const tracesDir = path.join(__dirname, '..', 'fixtures', 'temp', 'traces-failif');

  beforeEach(async () => {
    // Clean up trace directory
    if (fs.existsSync(tracesDir)) {
      fs.rmSync(tracesDir, { recursive: true });
    }
    fs.mkdirSync(tracesDir, { recursive: true });

    // Shutdown any existing telemetry from previous tests
    try {
      const { shutdownTelemetry, resetTelemetryForTesting } = await import(
        '../../src/telemetry/opentelemetry'
      );
      await shutdownTelemetry();
      resetTelemetryForTesting();
    } catch {
      // ignore
    }

    // Clear module cache for telemetry modules to ensure clean state
    delete require.cache[require.resolve('../../src/telemetry/opentelemetry')];
    delete require.cache[require.resolve('../../src/telemetry/trace-helpers')];
    delete require.cache[require.resolve('../../src/telemetry/metrics')];

    process.env.VISOR_TELEMETRY_ENABLED = 'true';
    process.env.VISOR_TELEMETRY_SINK = 'file';
    process.env.VISOR_TRACE_DIR = tracesDir;
    process.env.VISOR_TEST_METRICS = 'true';
  });

  afterEach(async () => {
    delete process.env.VISOR_TEST_METRICS;
    delete process.env.VISOR_TELEMETRY_ENABLED;
    delete process.env.VISOR_TELEMETRY_SINK;
    delete process.env.VISOR_TRACE_DIR;

    // Ensure telemetry is shutdown and cleaned up
    try {
      const { shutdownTelemetry } = await import('../../src/telemetry/opentelemetry');
      await shutdownTelemetry();
    } catch {
      // ignore if already shut down
    }
  });

  it('emits fail_if.evaluated and fail_if.triggered events and increments metric', async () => {
    // Check if OpenTelemetry is available
    let hasOpenTelemetry = false;
    try {
      require.resolve('@opentelemetry/sdk-node');
      hasOpenTelemetry = true;
    } catch {
      console.log('⚠️  OpenTelemetry not installed, skipping telemetry file tests');
    }

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
          sample: { type: 'noop', fail_if: 'true', group: 'test' },
        },
      };
      const reviewSummary = { issues: [] };
      await engine.evaluateFailureConditions('sample', reviewSummary as any, config);
    });

    // Give the BatchSpanProcessor time to export spans (default batch timeout is 1000ms)
    await new Promise(resolve => setTimeout(resolve, 1100));

    await shutdownTelemetry();

    // Assert metric increment via test snapshot
    const snap = getTestMetricsSnapshot();
    expect(snap.fail_if_triggered).toBeGreaterThanOrEqual(1);

    // Verify NDJSON includes events — robust across multiple files and empty files
    // Only check files if OpenTelemetry is available
    if (hasOpenTelemetry) {
      const files = fs.readdirSync(tracesDir).filter(f => f.endsWith('.ndjson'));
      expect(files.length).toBeGreaterThan(0);
      const lines = files
        .filter(f => fs.statSync(path.join(tracesDir, f)).size > 0)
        .flatMap(f =>
          fs
            .readFileSync(path.join(tracesDir, f), 'utf8')
            .trim()
            .split(/\r?\n/)
            .filter(Boolean)
            .map(l => JSON.parse(l))
        );
      const hasEvaluated = lines.some((s: any) =>
        (s.events || []).some((e: any) => e.name === 'fail_if.evaluated')
      );
      const hasTriggered = lines.some((s: any) =>
        (s.events || []).some((e: any) => e.name === 'fail_if.triggered')
      );
      expect(hasEvaluated).toBe(true);
      expect(hasTriggered).toBe(true);
    } else {
      // If OpenTelemetry is not available, at least verify metrics work
      console.log('✓ Metrics test passed (telemetry file tests skipped without OpenTelemetry)');
    }
  });
});
