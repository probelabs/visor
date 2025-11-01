import type { PRInfo } from '../pr-analyzer';
import type { ReviewSummary } from '../reviewer';
import { MemoryStore } from '../memory-store';

/**
 * Build a common provider template context with PR info, outputs (current),
 * outputs.history (all runs), outputs_raw (aggregate -raw deps) and an alias
 * outputs_history / outputs_history_stage. Optionally attaches read-only
 * memory helpers (get/has/list/getAll).
 */
const PR_CACHE_LIMIT = 16;
const prCache = new Map<string, any>();

function prCacheKey(pr: PRInfo): string {
  // Hash on stable fields + file list summary to avoid rebuilding the same structure repeatedly
  let sum = 0;
  for (const f of pr.files) sum += (f.additions || 0) + (f.deletions || 0) + (f.changes || 0);
  return [pr.number, pr.title, pr.author, pr.base, pr.head, pr.files.length, sum].join('|');
}

export function buildProviderTemplateContext(
  prInfo: PRInfo,
  dependencyResults?: Map<string, ReviewSummary>,
  memoryStore?: MemoryStore,
  outputHistory?: Map<string, unknown[]>,
  stageHistoryBase?: Record<string, number>,
  opts: { attachMemoryReadHelpers?: boolean } = { attachMemoryReadHelpers: true }
): Record<string, unknown> {
  const context: Record<string, unknown> = {};

  // PR context with tiny cache
  const key = prCacheKey(prInfo);
  let prObj = prCache.get(key);
  if (!prObj) {
    prObj = {
      number: prInfo.number,
      title: prInfo.title,
      body: prInfo.body,
      author: prInfo.author,
      base: prInfo.base,
      head: prInfo.head,
      totalAdditions: prInfo.totalAdditions,
      totalDeletions: prInfo.totalDeletions,
      files: prInfo.files.map(f => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.changes,
      })),
    };
    prCache.set(key, prObj);
    if (prCache.size > PR_CACHE_LIMIT) {
      const first = prCache.keys().next();
      if (!first.done) prCache.delete(first.value);
    }
  }
  context.pr = prObj;

  // outputs and history
  const outputs: Record<string, unknown> = {};
  const outputsRaw: Record<string, unknown> = {};
  const history: Record<string, unknown[]> = {};

  if (dependencyResults) {
    for (const [checkName, result] of dependencyResults.entries()) {
      if (typeof checkName !== 'string') continue;
      const summary = result as ReviewSummary & { output?: unknown };
      if (checkName.endsWith('-raw')) {
        const name = checkName.slice(0, -4);
        outputsRaw[name] = summary.output !== undefined ? summary.output : summary;
      } else {
        outputs[checkName] = summary.output !== undefined ? summary.output : summary;
      }
    }
  }

  if (outputHistory) {
    for (const [checkName, historyArray] of outputHistory) {
      history[checkName] = historyArray;
    }
  }

  const historyStage: Record<string, unknown[]> = {};
  try {
    if (outputHistory && stageHistoryBase) {
      for (const [checkName, historyArray] of outputHistory) {
        const start = stageHistoryBase[checkName] || 0;
        const arr = Array.isArray(historyArray) ? (historyArray as unknown[]) : [];
        historyStage[checkName] = arr.slice(start);
      }
    }
  } catch {}

  (outputs as any).history = history;
  context.outputs = outputs;
  (context as any).outputs_history = history;
  (context as any).outputs_history_stage = historyStage;
  (context as any).outputs_raw = outputsRaw;

  if (opts.attachMemoryReadHelpers && memoryStore) {
    context.memory = {
      get: (key: string, ns?: string) => memoryStore.get(key, ns),
      has: (key: string, ns?: string) => memoryStore.has(key, ns),
      list: (ns?: string) => memoryStore.list(ns),
      getAll: (ns?: string) => memoryStore.getAll(ns),
    } as Record<string, unknown>;
  }

  return context;
}
