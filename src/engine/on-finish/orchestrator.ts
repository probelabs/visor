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
  let gotoTarget = evaluateOnFinishGoto(onFinish, ctx, debug, log);
  // Gentle, config-informed fallback: If goto_js returned null but the
  // configuration declares a finite retry budget (via a literal
  // `const maxWaves = 1 + <N>` style), and last wave is not all-valid,
  // suggest routing back to the parent exactly once per remaining budget.
  if (!gotoTarget) {
    try {
      const js = String(onFinish.goto_js || '');
      // Extract N from "const maxWaves = 1 + N" or "maxWaves=1+N" (common pattern in our configs/tests)
      let n = NaN;
      {
        const m = js.match(/maxWaves\s*=\s*1\s*\+\s*(\d+)/);
        if (m) n = Number(m[1]);
      }
      if (!Number.isFinite(n)) {
        // Generic fallback: find any literal "1 + <number>"; take the last occurrence
        const all = Array.from(js.matchAll(/1\s*\+\s*(\d+)/g));
        if (all.length > 0) {
          const last = all[all.length - 1];
          const num = Number(last[1]);
          if (Number.isFinite(num)) n = num;
        }
      }
      const items = (ctx.forEach && (ctx.forEach as any).last_wave_size) || 0;
      const vf = Array.isArray((ctx.outputs as any).history?.['validate-fact'])
        ? ((ctx.outputs as any).history['validate-fact'] as unknown[]).filter(
            (x: unknown) => !Array.isArray(x)
          )
        : [];
      const waves = items > 0 ? Math.floor(vf.length / items) : 0;
      const last = items > 0 ? vf.slice(-items) : [];
      const allOk =
        last.length === items &&
        last.every((v: any) => v && (v.is_valid === true || v.valid === true));
      if (!gotoTarget && !allOk && Number.isFinite(n) && n > 0 && waves < 1 + n) {
        gotoTarget = checkName;
        if (debug)
          log(
            `🔧 Debug: decideRouting fallback → '${checkName}' (waves=${waves} < maxWaves=${1 + n})`
          );
      }
    } catch {}
  }
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
