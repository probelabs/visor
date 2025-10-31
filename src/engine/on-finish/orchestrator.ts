import type { PRInfo } from '../../pr-analyzer';
import type { ReviewSummary } from '../../reviewer';
import type { VisorConfig, CheckConfig } from '../../types/config';
import {
  buildProjectionFrom,
  composeOnFinishContext,
  evaluateOnFinishGoto,
  recomputeAllValidFromHistory,
} from './utils';

type RunCheckFn = (id: string) => Promise<ReviewSummary>;

export async function runOnFinishChildren(
  runIds: string[],
  runCheck: RunCheckFn,
  config: VisorConfig,
  onFinishContext: any,
  debug: boolean,
  log: (msg: string) => void
): Promise<{ lastRunOutput?: unknown }> {
  let lastRunOutput: unknown = undefined;
  for (const id of runIds) {
    if (debug) log(`🔧 Debug: on_finish.run executing '${id}'`);
    const res = await runCheck(id);
    lastRunOutput = (res as any)?.output;
    // Evaluate optional child on_success.run_js and run
    try {
      const childCfg = (config.checks || {})[id] as CheckConfig | undefined;
      const childOnSuccess = childCfg?.on_success;
      if (childOnSuccess) {
        const vm = require('../../utils/sandbox');
        const sandbox = vm.createSecureSandbox();
        const scope = { ...onFinishContext, output: lastRunOutput } as any;
        const code = `
          const step = scope.step; const attempt = scope.attempt; const loop = scope.loop; const outputs = scope.outputs; const outputs_history = scope.outputs_history; const outputs_raw = scope.outputs_raw; const forEach = scope.forEach; const memory = scope.memory; const pr = scope.pr; const files = scope.files; const env = scope.env; const event = scope.event; const output = scope.output; const log = (...a)=> console.log('🔍 Debug:',...a);
          const __fn = () => {\n${childOnSuccess.run_js || ''}\n};
          const __res = __fn();
          return Array.isArray(__res) ? __res.filter(x => typeof x === 'string' && x) : [];
        `;
        const exec = sandbox.compile(code);
        const dynamic = exec({ scope }).run();
        const childRun = Array.from(
          new Set([...(childOnSuccess.run || []), ...dynamic].filter(Boolean))
        ) as string[];
        for (const c of childRun) await runCheck(c);
      }
    } catch {}
  }
  return { lastRunOutput };
}

export function decideRouting(
  checkName: string,
  checkConfig: CheckConfig,
  outputsForContext: Record<string, unknown>,
  outputsHistoryForContext: Record<string, unknown[]>,
  forEachStats: { items: unknown[] },
  prInfo: PRInfo,
  config: VisorConfig,
  debug: boolean,
  log: (msg: string) => void
): { gotoTarget: string | null } {
  const ctx = composeOnFinishContext(
    config?.memory,
    checkName,
    checkConfig,
    outputsForContext,
    outputsHistoryForContext,
    { items: (forEachStats?.items || [])?.length ?? 0 },
    prInfo
  );
  const onFinish = checkConfig.on_finish!;
  const gotoTarget = evaluateOnFinishGoto(onFinish, ctx, debug, log);
  return { gotoTarget };
}

export function projectOutputs(
  results: Map<string, ReviewSummary>,
  historySnapshot: Record<string, unknown[]>
): {
  outputsForContext: Record<string, unknown>;
  outputsHistoryForContext: Record<string, unknown[]>;
} {
  return buildProjectionFrom(results, historySnapshot);
}

export function computeAllValid(
  history: Record<string, unknown[]>,
  itemsCount: number
): boolean | undefined {
  return recomputeAllValidFromHistory(history, itemsCount);
}
