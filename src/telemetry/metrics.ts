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
let runCounter: ReturnType<typeof meter.createCounter> | undefined;
let runDurationHist: ReturnType<typeof meter.createHistogram> | undefined;
let aiCallCounter: ReturnType<typeof meter.createCounter> | undefined;
let runAiCallsHist: ReturnType<typeof meter.createHistogram> | undefined;

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
    runCounter = meter.createCounter('visor.run.total', {
      description: 'Total number of visor runs (workflow executions)',
      unit: '1',
    });
    runDurationHist = meter.createHistogram('visor.run.duration_ms', {
      description: 'Duration of a complete visor run in milliseconds',
      unit: 'ms',
    });
    aiCallCounter = meter.createCounter('visor.ai_call.total', {
      description: 'Total number of AI provider calls',
      unit: '1',
    });
    runAiCallsHist = meter.createHistogram('visor.run.ai_calls', {
      description: 'Number of AI calls per visor run',
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

/**
 * Record a visor run start. Call this when a visor.run span begins.
 * Attributes allow Grafana dashboards to break down by source, user, and workflow.
 */
export function recordRunStart(attrs: {
  source?: string;
  userId?: string;
  userName?: string;
  workflowId?: string;
  instanceId?: string;
}) {
  ensureInstruments();
  try {
    const labels: Record<string, string> = {};
    if (attrs.source) labels['visor.run.source'] = attrs.source;
    if (attrs.userId) labels['visor.run.user_id'] = attrs.userId;
    if (attrs.userName) labels['visor.run.user_name'] = attrs.userName;
    if (attrs.workflowId) labels['visor.run.workflow'] = attrs.workflowId;
    if (attrs.instanceId) labels['visor.instance_id'] = attrs.instanceId;
    runCounter?.add(1, labels);
  } catch {}
}

/**
 * Record visor run duration on completion.
 */
export function recordRunDuration(
  durationMs: number,
  attrs: {
    source?: string;
    userId?: string;
    workflowId?: string;
    success?: boolean;
  }
) {
  ensureInstruments();
  try {
    const labels: Record<string, string | boolean> = {};
    if (attrs.source) labels['visor.run.source'] = attrs.source;
    if (attrs.userId) labels['visor.run.user_id'] = attrs.userId;
    if (attrs.workflowId) labels['visor.run.workflow'] = attrs.workflowId;
    if (attrs.success !== undefined) labels['visor.run.success'] = attrs.success;
    runDurationHist?.record(durationMs, labels);
  } catch {}
}

// --- Per-run AI call tracking ---
// Uses a simple global counter that withVisorRun resets/reads around each run.
let _currentRunAiCalls = 0;

/**
 * Record an AI provider call. Call this every time an AI model is invoked.
 */
export function recordAiCall(attrs: { checkId?: string; model?: string; source?: string }) {
  ensureInstruments();
  _currentRunAiCalls++;
  try {
    const labels: Record<string, string> = {};
    if (attrs.checkId) labels['visor.check.id'] = attrs.checkId;
    if (attrs.model) labels['visor.ai.model'] = attrs.model;
    if (attrs.source) labels['visor.run.source'] = attrs.source;
    aiCallCounter?.add(1, labels);
  } catch {}
}

/**
 * Reset the per-run AI call counter. Call at the start of a visor run.
 */
export function resetRunAiCalls(): void {
  _currentRunAiCalls = 0;
}

/**
 * Record the per-run AI call count as a histogram observation. Call at run end.
 */
export function recordRunAiCalls(attrs: { source?: string; workflowId?: string }) {
  ensureInstruments();
  try {
    const labels: Record<string, string> = {};
    if (attrs.source) labels['visor.run.source'] = attrs.source;
    if (attrs.workflowId) labels['visor.run.workflow'] = attrs.workflowId;
    runAiCallsHist?.record(_currentRunAiCalls, labels);
  } catch {}
}

/**
 * Get the current per-run AI call count.
 */
export function getRunAiCalls(): number {
  return _currentRunAiCalls;
}

export function getTestMetricsSnapshot() {
  return { ...TEST_SNAPSHOT };
}

export function resetTestMetricsSnapshot() {
  Object.keys(TEST_SNAPSHOT).forEach(k => (TEST_SNAPSHOT[k] = 0));
}
