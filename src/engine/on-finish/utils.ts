import { createSecureSandbox } from '../../utils/sandbox';
import type { PRInfo } from '../../pr-analyzer';
import type { ReviewSummary } from '../../reviewer';
import type { VisorConfig, CheckConfig, OnFinishConfig } from '../../types/config';
import { buildSandboxEnv } from '../../utils/env-exposure';
import { MemoryStore } from '../../memory-store';

export function buildProjectionFrom(
  results: Map<string, ReviewSummary>,
  historySnapshot: Record<string, unknown[]>
): {
  outputsForContext: Record<string, unknown>;
  outputsHistoryForContext: Record<string, unknown[]>;
} {
  const outputsForContext: Record<string, unknown> = {};
  for (const [name, result] of results.entries()) {
    const r = result as ReviewSummary & { output?: unknown };
    outputsForContext[name] = r.output !== undefined ? r.output : r;
  }
  const outputsHistoryForContext: Record<string, unknown[]> = {};
  for (const [check, arr] of Object.entries(historySnapshot || {})) {
    outputsHistoryForContext[check] = Array.isArray(arr) ? (arr as unknown[]) : [];
  }
  return { outputsForContext, outputsHistoryForContext };
}

export interface OnFinishContext {
  step: { id: string; tags: string[]; group?: string };
  attempt: number;
  loop: number;
  outputs: Record<string, unknown>;
  outputs_history: Record<string, unknown[]>;
  outputs_raw: Record<string, unknown>;
  forEach: unknown;
  memory: {
    get: (key: string, ns?: string) => unknown;
    has: (key: string, ns?: string) => boolean;
    getAll: (ns?: string) => Record<string, unknown>;
    set: (key: string, value: unknown, ns?: string) => void;
    clear: (ns?: string) => void;
    increment: (key: string, amount?: number, ns?: string) => number;
  };
  pr: { number: number; title?: string; author?: string; branch?: string; base?: string };
  files?: unknown;
  env: Record<string, string | undefined>;
  event: { name: string };
}

export function composeOnFinishContext(
  _memoryConfig: VisorConfig['memory'] | undefined,
  checkName: string,
  checkConfig: CheckConfig,
  outputsForContext: Record<string, unknown>,
  outputsHistoryForContext: Record<string, unknown[]>,
  forEachStats: any,
  prInfo: PRInfo
): OnFinishContext {
  // No MemoryStore in on_finish context — outputs and outputs_history are sufficient
  const outputs_raw: Record<string, unknown> = {};
  for (const [name, val] of Object.entries(outputsForContext))
    if (name !== 'history') outputs_raw[name] = val;
  const outputsMerged = { ...outputsForContext, history: outputsHistoryForContext } as Record<
    string,
    unknown
  >;
  // Memory helpers backed by MemoryStore, but exposed synchronously for
  // sandboxed goto_js/on_success.run_js compatibility.
  const memoryStore = MemoryStore.getInstance();
  const memoryHelpers = {
    get: (key: string, ns?: string) => memoryStore.get(key, ns),
    has: (key: string, ns?: string) => memoryStore.has(key, ns),
    getAll: (ns?: string) => memoryStore.getAll(ns),
    set: (key: string, value: unknown, ns?: string) => {
      const nsName = ns || memoryStore.getDefaultNamespace();
      const data: Map<string, Map<string, unknown>> = (memoryStore as any)['data'];
      if (!data.has(nsName)) data.set(nsName, new Map());
      data.get(nsName)!.set(key, value);
    },
    clear: (ns?: string) => {
      const data: Map<string, Map<string, unknown>> = (memoryStore as any)['data'];
      if (ns) data.delete(ns);
      else data.clear();
    },
    increment: (key: string, amount = 1, ns?: string) => {
      const nsName = ns || memoryStore.getDefaultNamespace();
      const data: Map<string, Map<string, unknown>> = (memoryStore as any)['data'];
      if (!data.has(nsName)) data.set(nsName, new Map());
      const nsMap = data.get(nsName)!;
      const current = nsMap.get(key);
      const numCurrent = typeof current === 'number' ? current : 0;
      const newValue = numCurrent + amount;
      nsMap.set(key, newValue);
      return newValue;
    },
  };

  return {
    step: { id: checkName, tags: checkConfig.tags || [], group: checkConfig.group },
    attempt: 1,
    loop: 0,
    outputs: outputsMerged,
    outputs_history: outputsHistoryForContext,
    outputs_raw,
    forEach: forEachStats,
    memory: memoryHelpers,
    pr: {
      number: prInfo.number,
      title: prInfo.title,
      author: prInfo.author,
      branch: prInfo.head,
      base: prInfo.base,
    },
    files: prInfo.files,
    env: buildSandboxEnv(process.env),
    event: { name: prInfo.eventType || 'manual' },
  };
}

export function evaluateOnFinishGoto(
  onFinish: NonNullable<OnFinishConfig>,
  onFinishContext: any,
  debug: boolean,
  log: (msg: string) => void
): string | null {
  let gotoTarget: string | null = null;
  if (onFinish.goto_js) {
    const sandbox = createSecureSandbox();
    try {
      const scope = onFinishContext;
      const code = `
        const step = scope.step; const attempt = scope.attempt; const loop = scope.loop; const outputs = scope.outputs; const outputs_history = scope.outputs_history; const outputs_raw = scope.outputs_raw; const forEach = scope.forEach; const pr = scope.pr; const files = scope.files; const env = scope.env; const event = scope.event; const log = (...a)=> console.log('🔍 Debug:',...a);
        const __fn = () => {\n${onFinish.goto_js}\n};
        return __fn();
      `;
      // Use shared compileAndRun helper for consistent behavior
      const { compileAndRun } = require('../../utils/sandbox');
      const result = compileAndRun(
        sandbox,
        code,
        { scope },
        { injectLog: false, wrapFunction: false }
      );
      gotoTarget = typeof result === 'string' && result ? result : null;
      if (debug) log(`🔧 Debug: on_finish.goto_js evaluated → ${String(gotoTarget)}`);
    } catch (e) {
      try {
        // Surface evaluation problems in debug logs to aid diagnosis
        const msg = e instanceof Error ? e.message : String(e);

        console.error(`✗ on_finish.goto_js: evaluation error: ${msg}`);
      } catch {}
      // Fall back to static goto
      if (onFinish.goto) gotoTarget = onFinish.goto;
    }
  } else if (onFinish.goto) {
    gotoTarget = onFinish.goto;
  }
  return gotoTarget;
}

export function recomputeAllValidFromHistory(
  history: Record<string, unknown[]>,
  forEachItemsCount: number
): boolean | undefined {
  const vfArr = Array.isArray(history['validate-fact'])
    ? (history['validate-fact'] as unknown[])
    : [];
  if (forEachItemsCount <= 0) return undefined;
  // If we have fewer per-item results than the wave size, the current wave
  // cannot be considered all-valid yet. Be pessimistic and return false so
  // on_finish can trigger another correction wave.
  if (vfArr.filter(v => !Array.isArray(v)).length < forEachItemsCount) {
    return false;
  }

  // If entries have per-item identifiers, compute verdict from the most recent
  // wave by walking backward and taking the last N distinct ids.
  const withIds = vfArr.filter(v => {
    const o = v as any;
    return o && (typeof o.fact_id === 'string' || typeof o.id === 'string');
  });

  if (withIds.length >= forEachItemsCount) {
    const seen = new Set<string>();
    const recent: any[] = [];
    for (let i = vfArr.length - 1; i >= 0 && recent.length < forEachItemsCount; i--) {
      const o = vfArr[i] as any;
      const key = (o && (o.fact_id || o.id)) as string | undefined;
      if (!key) continue;
      if (!seen.has(key)) {
        seen.add(key);
        recent.push(o);
      }
    }
    if (recent.length === forEachItemsCount) {
      return recent.every(o => o && (o.is_valid === true || o.valid === true));
    }
    // Fall through if we couldn't collect enough distinct ids
  }

  // ID-less shape: treat the last N entries as the current wave.
  // This matches unit-test expectations where history items are simple booleans.
  if (vfArr.length >= forEachItemsCount) {
    const lastN = vfArr.slice(-forEachItemsCount) as any[];
    return lastN.every(o => o && (o.is_valid === true || o.valid === true));
  }

  // Not enough signal to decide for the requested wave size.
  return false;
}
