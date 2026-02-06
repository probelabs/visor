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
        const step = scope.step; const attempt = scope.attempt; const loop = scope.loop; const outputs = scope.outputs; const outputs_history = scope.outputs_history; const outputs_raw = scope.outputs_raw; const forEach = scope.forEach; const memory = scope.memory; const pr = scope.pr; const files = scope.files; const env = scope.env; const event = scope.event; const log = (...a)=> console.log('🔍 Debug:',...a);
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
      try {
        if (debug) {
          const hist =
            (onFinishContext &&
              onFinishContext.outputs &&
              (onFinishContext.outputs as any).history) ||
            {};
          const vf = Array.isArray(hist['validate-fact'])
            ? hist['validate-fact'].filter((x: any) => !Array.isArray(x))
            : [];
          const items =
            (onFinishContext &&
              onFinishContext.forEach &&
              (onFinishContext.forEach as any).last_wave_size) ||
            0;
          log(`🔧 Debug: goto_js result=${String(result)} items=${items} vf_count=${vf.length}`);
        }
      } catch {}
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
  const vfArrRaw = Array.isArray(history['validate-fact'])
    ? (history['validate-fact'] as unknown[])
    : [];
  if (forEachItemsCount <= 0) return undefined;

  // Consider only non-array entries (per-item results)
  const vfArr = vfArrRaw.filter(v => !Array.isArray(v)) as any[];
  if (vfArr.length < forEachItemsCount) return false;

  // 1) Prefer strict last-wave grouping when loop_idx metadata is present.
  const withLoop = vfArr.filter(
    v => v && typeof v === 'object' && Number.isFinite((v as any).loop_idx)
  ) as Array<{ loop_idx: number } & Record<string, unknown>>;
  if (withLoop.length >= forEachItemsCount) {
    const maxLoop = Math.max(...withLoop.map(v => Number(v.loop_idx)));
    const sameWave = withLoop.filter(v => Number(v.loop_idx) === maxLoop);
    try {
      if (process.env.VISOR_DEBUG === 'true') {
        console.error(
          `[ofAllValid] loop_idx=${maxLoop} sameWave=${sameWave.length} items=${forEachItemsCount}`
        );
      }
    } catch {}
    if (sameWave.length >= forEachItemsCount) {
      // If we have ids, take the last N distinct by id; otherwise, take last N
      const take = (() => {
        const withIds = sameWave.filter(
          o => typeof (o as any).fact_id === 'string' || typeof (o as any).id === 'string'
        );
        if (withIds.length >= forEachItemsCount) {
          const recent: any[] = [];
          const seen = new Set<string>();
          for (let i = sameWave.length - 1; i >= 0 && recent.length < forEachItemsCount; i--) {
            const o: any = sameWave[i];
            const key = (o.fact_id || o.id) as string | undefined;
            if (!key || seen.has(key)) continue;
            seen.add(key);
            recent.push(o);
          }
          if (recent.length === forEachItemsCount) return recent;
        }
        return sameWave.slice(-forEachItemsCount);
      })();
      const ok = take.every(o => o && ((o as any).is_valid === true || (o as any).valid === true));
      try {
        if (process.env.VISOR_DEBUG === 'true') {
          const vals = take.map(o => (o as any).is_valid ?? (o as any).valid);
          console.error(`[ofAllValid] loop verdicts=${JSON.stringify(vals)} ok=${ok}`);
        }
      } catch {}
      return ok;
    }
  }

  // 2) Fall back to last N distinct-by-id across the whole history
  const withIds = vfArr.filter(
    o => typeof (o as any).fact_id === 'string' || typeof (o as any).id === 'string'
  );
  if (withIds.length >= forEachItemsCount) {
    const recent: any[] = [];
    const seen = new Set<string>();
    for (let i = vfArr.length - 1; i >= 0 && recent.length < forEachItemsCount; i--) {
      const o: any = vfArr[i];
      const key = (o.fact_id || o.id) as string | undefined;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      recent.push(o);
    }
    if (recent.length === forEachItemsCount) {
      const ok = recent.every(o => o && (o.is_valid === true || o.valid === true));
      try {
        if (process.env.VISOR_DEBUG === 'true') {
          const vals = recent.map(o => (o as any).is_valid ?? (o as any).valid);
          console.error(`[ofAllValid] id-recent verdicts=${JSON.stringify(vals)} ok=${ok}`);
        }
      } catch {}
      return ok;
    }
  }

  // 3) Last-resort fallback: treat last N entries as current wave
  if (vfArr.length >= forEachItemsCount) {
    const lastN = vfArr.slice(-forEachItemsCount) as any[];
    const ok = lastN.every(o => o && (o.is_valid === true || o.valid === true));
    try {
      if (process.env.VISOR_DEBUG === 'true') {
        const vals = lastN.map(o => (o as any).is_valid ?? (o as any).valid);
        console.error(`[ofAllValid] tail verdicts=${JSON.stringify(vals)} ok=${ok}`);
      }
    } catch {}
    return ok;
  }

  return false;
}
