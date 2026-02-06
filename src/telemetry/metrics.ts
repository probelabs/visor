import { metrics } from './lazy-otel';

let initialized = false;
const meter = metrics.getMeter('visor');

// Test helpers (enabled with VISOR_TEST_METRICS=true)
const TEST_ENABLED = process.env.VISOR_TEST_METRICS === 'true';
const TEST_SNAPSHOT: { [k: string]: number } = { fail_if_triggered: 0 };

// Instruments (lazily created when first used)
let checkDurationHist: ReturnType<typeof meter.createHistogram> | undefined;
let providerDurationHist: ReturnType<typeof meter.createHistogram> | undefined;
let foreachDurationHist: ReturnType<typeof meter.createHistogram> | undefined;
let issuesCounter: ReturnType<typeof meter.createCounter> | undefined;
let activeChecks: ReturnType<typeof meter.createUpDownCounter> | undefined;
let failIfCounter: ReturnType<typeof meter.createCounter> | undefined;
let diagramBlocks: ReturnType<typeof meter.createCounter> | undefined;

function ensureInstruments() {
  if (initialized) return;
  try {
    checkDurationHist = meter.createHistogram('visor.check.duration_ms', {
      description: 'Duration of a check execution in milliseconds',
      unit: 'ms',
    });
    providerDurationHist = meter.createHistogram('visor.provider.duration_ms', {
      description: 'Duration of provider execution in milliseconds',
      unit: 'ms',
    });
    foreachDurationHist = meter.createHistogram('visor.foreach.item.duration_ms', {
      description: 'Duration of a forEach item execution in milliseconds',
      unit: 'ms',
    });
    issuesCounter = meter.createCounter('visor.check.issues', {
      description: 'Number of issues produced by checks',
      unit: '1',
    });
    activeChecks = meter.createUpDownCounter('visor.run.active_checks', {
      description: 'Number of checks actively running',
      unit: '1',
    });
    failIfCounter = meter.createCounter('visor.fail_if.triggered', {
      description: 'Number of times fail_if condition triggered',
      unit: '1',
    });
    diagramBlocks = meter.createCounter('visor.diagram.blocks', {
      description: 'Number of Mermaid diagram blocks emitted',
      unit: '1',
    });
    initialized = true;
  } catch {
    // Metrics may be unavailable if SDK not initialized; ignore gracefully
  }
}

export function recordCheckDuration(check: string, durationMs: number, group?: string) {
  ensureInstruments();
  try {
    checkDurationHist?.record(durationMs, {
      'visor.check.id': check,
      'visor.check.group': group || 'default',
    });
  } catch {}
}

export function recordProviderDuration(check: string, providerType: string, durationMs: number) {
  ensureInstruments();
  try {
    providerDurationHist?.record(durationMs, {
      'visor.check.id': check,
      'visor.provider.type': providerType,
    });
  } catch {}
}

export function recordForEachDuration(
  check: string,
  index: number,
  total: number,
  durationMs: number
) {
  ensureInstruments();
  try {
    foreachDurationHist?.record(durationMs, {
      'visor.check.id': check,
      'visor.foreach.index': index,
      'visor.foreach.total': total,
    });
  } catch {}
}

export function addIssues(check: string, severity: string, count = 1) {
  ensureInstruments();
  try {
    issuesCounter?.add(count, {
      'visor.check.id': check,
      severity,
    });
  } catch {}
}

export function incActiveCheck(check: string) {
  ensureInstruments();
  try {
    activeChecks?.add(1, { 'visor.check.id': check });
  } catch {}
}

export function decActiveCheck(check: string) {
  ensureInstruments();
  try {
    activeChecks?.add(-1, { 'visor.check.id': check });
  } catch {}
}

export function addFailIfTriggered(check: string, scope: 'global' | 'check') {
  ensureInstruments();
  try {
    failIfCounter?.add(1, { 'visor.check.id': check, scope });
  } catch {}
  if (TEST_ENABLED) TEST_SNAPSHOT.fail_if_triggered++;
}

export function addDiagramBlock(origin: 'content' | 'issue') {
  ensureInstruments();
  try {
    diagramBlocks?.add(1, { origin });
  } catch {}
}

export function getTestMetricsSnapshot() {
  return { ...TEST_SNAPSHOT };
}

export function resetTestMetricsSnapshot() {
  Object.keys(TEST_SNAPSHOT).forEach(k => (TEST_SNAPSHOT[k] = 0));
}
