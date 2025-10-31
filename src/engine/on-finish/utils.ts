import { MemoryStore } from '../../memory-store';
import { createSecureSandbox } from '../../utils/sandbox';
import type { PRInfo } from '../../pr-analyzer';
import type { ReviewSummary } from '../../reviewer';
import type { VisorConfig, CheckConfig, OnFinishConfig } from '../../types/config';
import { buildSandboxEnv } from '../../utils/env-exposure';

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

export function composeOnFinishContext(
  memoryConfig: VisorConfig['memory'] | undefined,
  checkName: string,
  checkConfig: CheckConfig,
  outputsForContext: Record<string, unknown>,
  outputsHistoryForContext: Record<string, unknown[]>,
  forEachStats: any,
  prInfo: PRInfo
) {
  const memoryStore = MemoryStore.getInstance(memoryConfig);
  const memory = {
    get: (key: string, ns?: string) => memoryStore.get(key, ns),
    has: (key: string, ns?: string) => memoryStore.has(key, ns),
    list: (ns?: string) => memoryStore.list(ns),
    getAll: (ns?: string) => {
      const keys = memoryStore.list(ns);
      const result: Record<string, unknown> = {};
      for (const key of keys) result[key] = memoryStore.get(key, ns);
      return result;
    },
    set: (key: string, value: unknown, ns?: string) => {
      const nsName = ns || memoryStore.getDefaultNamespace();
      if (!memoryStore['data'].has(nsName)) memoryStore['data'].set(nsName, new Map());
      memoryStore['data'].get(nsName)!.set(key, value);
    },
    increment: (key: string, amount: number, ns?: string) => {
      const current = memoryStore.get(key, ns);
      const numCurrent = typeof current === 'number' ? current : 0;
      const newValue = numCurrent + amount;
      const nsName = ns || memoryStore.getDefaultNamespace();
      if (!memoryStore['data'].has(nsName)) memoryStore['data'].set(nsName, new Map());
      memoryStore['data'].get(nsName)!.set(key, newValue);
      return newValue;
    },
  };
  const outputs_raw: Record<string, unknown> = {};
  for (const [name, val] of Object.entries(outputsForContext))
    if (name !== 'history') outputs_raw[name] = val;
  const outputsMerged = { ...outputsForContext, history: outputsHistoryForContext } as Record<
    string,
    unknown
  >;
  return {
    step: { id: checkName, tags: checkConfig.tags || [], group: checkConfig.group },
    attempt: 1,
    loop: 0,
    outputs: outputsMerged,
    outputs_history: outputsHistoryForContext,
    outputs_raw,
    forEach: forEachStats,
    memory,
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
        const __res = __fn();
        return (typeof __res === 'string' && __res) ? __res : null;
      `;
      const exec = sandbox.compile(code);
      const result = exec({ scope }).run();
      gotoTarget = typeof result === 'string' && result ? result : null;
      if (debug) log(`🔧 Debug: on_finish.goto_js evaluated → ${String(gotoTarget)}`);
    } catch (e) {
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
  const vfNow = (history['validate-fact'] || []) as unknown[];
  if (!Array.isArray(vfNow) || forEachItemsCount <= 0 || vfNow.length < forEachItemsCount)
    return undefined;
  const lastWave = vfNow.slice(-forEachItemsCount);
  const ok = lastWave.every((v: any) => v && (v.is_valid === true || v.valid === true));
  return ok;
}
