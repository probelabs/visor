// Note: avoid importing concrete classes here to keep evaluator generic across runners
import type { SlackRecordedCall } from './recorders/slack-recorder';
import { validateCounts, type ExpectBlock, deepEqual, containsUnordered } from './assertions';
import { deepGet } from './utils/selectors';

type ExecStats = import('../types/execution').ExecutionStatistics;
type GroupedResults = import('../reviewer').GroupedCheckResults;

function parseRegex(raw: string): RegExp {
  try {
    let pattern = raw;
    let flags = '';
    const m = pattern.match(/^\(\?([gimsuy]+)\)/);
    if (m) {
      flags = m[1];
      pattern = pattern.slice(m[0].length);
    }
    return new RegExp(pattern, flags);
  } catch {
    return new RegExp('(?!)');
  }
}

function mapGithubOp(op: string): string {
  const map: Record<string, string> = {
    'labels.add': 'issues.addLabels',
    'issues.addLabels': 'issues.addLabels',
    'issues.createComment': 'issues.createComment',
    'pulls.createReview': 'pulls.createReview',
    'pulls.updateReview': 'pulls.updateReview',
    'checks.create': 'checks.create',
    'checks.update': 'checks.update',
  };
  return map[op] || op;
}

function buildExecutedMap(stats: ExecStats): Record<string, number> {
  const executed: Record<string, number> = Object.create(null);
  for (const s of stats.checks) {
    const name = (s as any)?.checkName;
    if (
      !s.skipped &&
      (s.totalRuns || 0) > 0 &&
      typeof name === 'string' &&
      name.trim().length > 0 &&
      name !== 'undefined'
    ) {
      executed[name] = s.totalRuns || 0;
    }
  }
  return executed;
}

/**
 * Build counts for generated rows only. Generated stats retain their opaque
 * checkName (nodeGenerationId) for exact/legacy assertions and carry the
 * logical id separately, so this map must never fall back to checkName.
 */
function buildLogicalExecutedMap(stats: ExecStats): Record<string, number> {
  const executed: Record<string, number> = Object.create(null);
  for (const s of stats.checks) {
    const name = (s as any)?.logicalCheckName;
    if (
      !s.skipped &&
      (s.totalRuns || 0) > 0 &&
      typeof name === 'string' &&
      name.trim().length > 0 &&
      name !== 'undefined'
    ) {
      executed[name] = (executed[name] || 0) + (s.totalRuns || 0);
    }
  }
  return executed;
}

type CallSelector = 'step' | 'logical_step' | 'provider' | 'invalid';

/**
 * Resolve the intentionally explicit selector used by a calls assertion.
 * Provider calls are a separate, backwards-compatible form with no step
 * selector. Exact `step` values are never normalized or aliased.
 */
function callSelector(call: any): CallSelector {
  const hasStep = call?.step !== undefined;
  const hasLogicalStep = call?.logical_step !== undefined;
  if (hasStep && hasLogicalStep) return 'invalid';
  if (hasStep) {
    return typeof call.step === 'string' && call.step.trim().length > 0 ? 'step' : 'invalid';
  }
  if (hasLogicalStep) {
    return typeof call.logical_step === 'string' && call.logical_step.trim().length > 0
      ? 'logical_step'
      : 'invalid';
  }
  if (call?.provider !== undefined) {
    return typeof call.provider === 'string' && call.provider.trim().length > 0
      ? 'provider'
      : 'invalid';
  }
  return 'invalid';
}

function reportInvalidCallSelector(errors: string[], call: any): void {
  const hasStep = call?.step !== undefined;
  const hasLogicalStep = call?.logical_step !== undefined;
  if (hasStep && hasLogicalStep) {
    errors.push('Call expectation cannot specify both step and logical_step');
  } else if (!hasStep && !hasLogicalStep && call?.provider === undefined) {
    errors.push('Call expectation must specify exactly one of step or logical_step');
  } else if (hasStep) {
    errors.push('Call expectation step must be a non-empty string');
  } else if (hasLogicalStep) {
    errors.push('Call expectation logical_step must be a non-empty string');
  } else {
    errors.push('Call expectation provider must be a non-empty string');
  }
}

// Middle‑truncate with explicit omitted-chars indicator and whitespace normalization
function previewMiddle(raw: unknown, max = 240): string {
  const s = String(raw ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  const len = s.length;
  if (len <= max) return s;
  const placeholder = ` … [+${len - max} chars omitted] … `;
  const budget = Math.max(16, max - placeholder.length);
  const head = Math.max(8, Math.floor(budget / 2));
  const tail = Math.max(8, budget - head);
  return s.slice(0, head) + placeholder + s.slice(len - tail);
}

export function evaluateCalls(
  errors: string[],
  expect: ExpectBlock,
  executed: Record<string, number>,
  logicalExecuted: Record<string, number> = Object.create(null)
): void {
  for (const call of expect.calls || []) {
    const selector = callSelector(call);
    if (selector === 'invalid') {
      reportInvalidCallSelector(errors, call);
      continue;
    }
    if (selector === 'provider') continue;

    validateCounts(call);
    const selected = selector === 'step' ? call.step : call.logical_step;
    const counts = selector === 'step' ? executed : logicalExecuted;
    const actual = counts[selected] || 0;
    const label = selector === 'step' ? 'step' : 'logical_step';
    if (call.exactly !== undefined && actual !== call.exactly) {
      errors.push(`Expected ${label} ${selected} exactly ${call.exactly}, got ${actual}`);
    }
    if (call.at_least !== undefined && actual < call.at_least) {
      errors.push(`Expected ${label} ${selected} at_least ${call.at_least}, got ${actual}`);
    }
    if (call.at_most !== undefined && actual > call.at_most) {
      errors.push(`Expected ${label} ${selected} at_most ${call.at_most}, got ${actual}`);
    }
  }
}

export function evaluateProviderCalls(
  errors: string[],
  expect: ExpectBlock,
  recorder: { calls: Array<{ provider: string; op: string; args: any; ts: number }> },
  slackRecorder?: { calls: SlackRecordedCall[] }
): void {
  for (const call of expect.calls || []) {
    // Step selectors are evaluated by evaluateCalls. A provider selector may
    // still be combined with one step selector, preserving the prior ability
    // to assert both effects in a single calls entry.
    if (callSelector(call) === 'invalid') continue;
    const provider = (call.provider || '').toLowerCase();
    if (provider === 'github') {
      validateCounts(call);
      const op = mapGithubOp(call.op || '');
      const matched = recorder.calls.filter(c => !op || c.op === op);
      const actual = matched.length;
      if (call.exactly !== undefined && actual !== call.exactly) {
        errors.push(`Expected github ${call.op} exactly ${call.exactly}, got ${actual}`);
      }
      if (call.at_least !== undefined && actual < call.at_least) {
        errors.push(`Expected github ${call.op} at_least ${call.at_least}, got ${actual}`);
      }
      if (call.at_most !== undefined && actual > call.at_most) {
        errors.push(`Expected github ${call.op} at_most ${call.at_most}, got ${actual}`);
      }
      if (call.args && (call.args as any).contains && op.endsWith('addLabels')) {
        const want = (call.args as any).contains as unknown[];
        const ok = matched.some(m => {
          const labels = (m.args as any)?.labels || [];
          return Array.isArray(labels) && want.every(w => labels.includes(w));
        });
        if (!ok) {
          const last = matched[matched.length - 1];
          const actual = (last && (last.args as any)?.labels) || [];
          errors.push(
            `Expected github ${call.op} to include labels ${JSON.stringify(want)}; got ${JSON.stringify(
              actual
            )}`
          );
        }
      }
    } else if (provider === 'slack') {
      validateCounts(call);
      const op = String(call.op || '');
      const calls = slackRecorder?.calls || [];
      const matched = calls.filter(c => !op || c.op === op);
      const actual = matched.length;
      if (call.exactly !== undefined && actual !== call.exactly) {
        errors.push(`Expected slack ${call.op} exactly ${call.exactly}, got ${actual}`);
      }
      if (call.at_least !== undefined && actual < call.at_least) {
        errors.push(`Expected slack ${call.op} at_least ${call.at_least}, got ${actual}`);
      }
      if (call.at_most !== undefined && actual > call.at_most) {
        errors.push(`Expected slack ${call.op} at_most ${call.at_most}, got ${actual}`);
      }
      if (call.args && (call.args as any).contains) {
        const want = (call.args as any).contains as unknown[];
        const ok = matched.some(m => {
          const text = (m.args as any)?.text || '';
          return want.every(w => String(text).includes(String(w)));
        });
        if (!ok) {
          const last = matched[matched.length - 1];
          const text = (last && (last.args as any)?.text) || '';
          errors.push(
            `Expected slack ${call.op} text to contain ${JSON.stringify(want)}; got ${JSON.stringify(
              text
            )}`
          );
        }
      }
    }
  }
}

export function evaluateNoCalls(
  errors: string[],
  expect: ExpectBlock,
  executed: Record<string, number>,
  recorder: { calls: Array<{ provider: string; op: string; args: any; ts: number }> },
  slackRecorder?: { calls: SlackRecordedCall[] }
): void {
  for (const nc of expect.no_calls || []) {
    const provider = (nc.provider || '').toLowerCase();
    if (provider === 'github') {
      const op = mapGithubOp((nc as any).op || '');
      const matched = recorder.calls.filter(c => !op || c.op === op);
      if (matched.length > 0)
        errors.push(`Expected no github ${nc.op} calls, but found ${matched.length}`);
    } else if (provider === 'slack') {
      const op = String((nc as any).op || '');
      const matched = (slackRecorder?.calls || []).filter(c => !op || c.op === op);
      if (matched.length > 0)
        errors.push(`Expected no slack ${nc.op} calls, but found ${matched.length}`);
    }
    if (nc.step && executed[nc.step] > 0) {
      errors.push(`Expected no step ${nc.step} calls, but executed ${executed[nc.step]}`);
    }
  }
}

export function evaluatePrompts(
  errors: string[],
  expect: ExpectBlock,
  promptsByStep: Record<string, string[]>
): void {
  for (const p of expect.prompts || []) {
    const arr = promptsByStep[p.step] || [];
    let prompt: string | undefined;
    const idxLabel = String(p.index ?? 'last');
    if (p.where) {
      const where = p.where;
      for (const candidate of arr) {
        let ok = true;
        if (where.contains) ok = ok && where.contains.every(s => candidate.includes(s));
        if (where.not_contains) ok = ok && where.not_contains.every(s => !candidate.includes(s));
        if (where.matches) {
          const re = parseRegex(where.matches);
          ok = ok && re.test(candidate);
        }
        if (ok) {
          prompt = candidate;
          break;
        }
      }
    } else {
      const idx =
        p.index === 'first'
          ? 0
          : p.index === 'last'
            ? arr.length - 1
            : ((p.index as number) ?? arr.length - 1);
      prompt = arr[idx];
    }
    if (!prompt) {
      errors.push(`No captured prompt for step ${p.step} at index ${idxLabel}`);
      continue;
    }
    if (p.contains && !p.contains.every(s => prompt!.includes(s))) {
      const missing = (p.contains as string[]).filter(s => !prompt!.includes(s));
      // (debug cleanup) avoid extra console noise on prompt assertion failures
      errors.push(
        `Prompt for ${p.step}@${idxLabel} expected to contain ${JSON.stringify(missing)}; got: ${previewMiddle(
          prompt
        )}`
      );
    }
    if (p.not_contains) {
      const present = (p.not_contains as string[]).filter(s => prompt!.includes(s));
      if (present.length > 0) {
        errors.push(
          `Prompt for ${p.step}@${idxLabel} contains forbidden ${JSON.stringify(
            present
          )}; got: ${previewMiddle(prompt)}`
        );
      }
    }
    if (p.matches && !parseRegex(p.matches).test(prompt)) {
      errors.push(
        `Prompt for ${p.step}@${idxLabel} expected to match ${p.matches}; got: ${previewMiddle(
          prompt
        )}`
      );
    }
  }
}

/**
 * Evaluate workflow_output assertions against computed workflow outputs.
 * Similar to evaluateOutputs but tests workflow-level outputs (defined in outputs: section)
 * rather than step outputs.
 */
export function evaluateWorkflowOutputs(
  errors: string[],
  expect: ExpectBlock,
  workflowOutputs: Record<string, unknown> | undefined
): void {
  const expectations = (expect as any).workflow_output;
  if (!Array.isArray(expectations) || expectations.length === 0) return;
  if (!workflowOutputs) {
    errors.push('workflow_output assertions present but no workflow outputs computed');
    return;
  }

  for (const o of expectations) {
    const path = o.path as string;
    if (!path) {
      errors.push('workflow_output assertion missing path');
      continue;
    }
    const v = deepGet(workflowOutputs, path);
    if (o.equals !== undefined && !deepEqual(v, o.equals)) {
      errors.push(
        `Workflow output ${path} expected ${JSON.stringify(o.equals)} but got ${JSON.stringify(v)}`
      );
    }
    if (o.equalsDeep !== undefined && !deepEqual(v, o.equalsDeep)) {
      errors.push(`Workflow output ${path} deepEquals failed`);
    }
    if (o.matches && !parseRegex(o.matches).test(String(v))) {
      errors.push(`Workflow output ${path} does not match ${o.matches}`);
    }
    if (o.contains) {
      const contents = Array.isArray(o.contains) ? o.contains : [o.contains];
      const strV = String(v);
      for (const c of contents) {
        if (!strV.includes(String(c))) {
          errors.push(`Workflow output ${path} expected to contain "${c}"`);
        }
      }
    }
    if (o.not_contains) {
      const contents = Array.isArray(o.not_contains) ? o.not_contains : [o.not_contains];
      const strV = String(v);
      for (const c of contents) {
        if (strV.includes(String(c))) {
          errors.push(`Workflow output ${path} should not contain "${c}"`);
        }
      }
    }
    if (o.contains_unordered) {
      if (!Array.isArray(v)) {
        errors.push(`Workflow output ${path} not an array for contains_unordered`);
      } else if (!containsUnordered(v as unknown[], o.contains_unordered)) {
        errors.push(`Workflow output ${path} missing elements (unordered)`);
      }
    }
    // Numeric comparison operators
    if (o.gt !== undefined) {
      if (typeof v !== 'number')
        errors.push(`Workflow output ${path} expected number for gt but got ${typeof v}`);
      else if (!(v > o.gt)) errors.push(`Workflow output ${path} expected > ${o.gt} but got ${v}`);
    }
    if (o.gte !== undefined) {
      if (typeof v !== 'number')
        errors.push(`Workflow output ${path} expected number for gte but got ${typeof v}`);
      else if (!(v >= o.gte))
        errors.push(`Workflow output ${path} expected >= ${o.gte} but got ${v}`);
    }
    if (o.lt !== undefined) {
      if (typeof v !== 'number')
        errors.push(`Workflow output ${path} expected number for lt but got ${typeof v}`);
      else if (!(v < o.lt)) errors.push(`Workflow output ${path} expected < ${o.lt} but got ${v}`);
    }
    if (o.lte !== undefined) {
      if (typeof v !== 'number')
        errors.push(`Workflow output ${path} expected number for lte but got ${typeof v}`);
      else if (!(v <= o.lte))
        errors.push(`Workflow output ${path} expected <= ${o.lte} but got ${v}`);
    }
  }
}

export function evaluateOutputs(
  errors: string[],
  expect: ExpectBlock,
  outputHistory: Record<string, unknown[]>
): void {
  for (const o of expect.outputs || []) {
    const hist = outputHistory[o.step] || [];
    if (!Array.isArray(hist) || hist.length === 0) {
      errors.push(`No output history for step ${o.step}`);
      continue;
    }
    let chosen: unknown | undefined;
    if (o.where) {
      for (const item of hist as any[]) {
        const probe = deepGet(item, o.where.path as string);
        if (o.where.equals !== undefined) {
          if ((probe as any) === (o.where.equals as any) || deepEqual(probe, o.where.equals)) {
            chosen = item;
            break;
          }
        } else if (o.where.matches) {
          const re = parseRegex(o.where.matches);
          if (re.test(String(probe))) {
            chosen = item;
            break;
          }
        }
      }
      if (chosen === undefined) {
        let hint = '';
        try {
          const arr = hist as any[];
          const sample = (arr && arr[0]) || {};
          const keys = sample && typeof sample === 'object' ? Object.keys(sample).slice(0, 6) : [];
          hint = keys.length
            ? ` (had ${arr.length} item(s); sample keys: ${keys.join(', ')})`
            : ` (had ${arr.length} item(s))`;
        } catch {}
        errors.push(`No output matched where selector for ${o.step}${hint}`);
        continue;
      }
    } else {
      const idx =
        o.index === 'first'
          ? 0
          : o.index === 'last'
            ? (hist as any[]).length - 1
            : ((o.index as number) ?? (hist as any[]).length - 1);
      chosen = (hist as any[])[idx];
    }
    const v = deepGet(chosen, o.path as string);
    if (o.equalsDeep !== undefined && !deepEqual(v, o.equalsDeep)) {
      errors.push(`Output ${o.step}.${o.path} deepEquals failed`);
    }
    if (o.equals !== undefined && (v as any) !== (o.equals as any)) {
      errors.push(
        `Output ${o.step}.${o.path} expected ${JSON.stringify(o.equals)} but got ${JSON.stringify(v)}`
      );
    }
    if (o.matches && !parseRegex(o.matches).test(String(v))) {
      errors.push(`Output ${o.step}.${o.path} does not match ${o.matches}`);
    }
    if (o.contains_unordered) {
      if (!Array.isArray(v))
        errors.push(`Output ${o.step}.${o.path} not an array for contains_unordered`);
      else if (!containsUnordered(v as unknown[], o.contains_unordered))
        errors.push(`Output ${o.step}.${o.path} missing elements (unordered)`);
    }
    // Numeric comparison operators
    if (o.gt !== undefined) {
      if (typeof v !== 'number')
        errors.push(`Output ${o.step}.${o.path} expected number for gt but got ${typeof v}`);
      else if (!(v > o.gt))
        errors.push(`Output ${o.step}.${o.path} expected > ${o.gt} but got ${v}`);
    }
    if (o.gte !== undefined) {
      if (typeof v !== 'number')
        errors.push(`Output ${o.step}.${o.path} expected number for gte but got ${typeof v}`);
      else if (!(v >= o.gte))
        errors.push(`Output ${o.step}.${o.path} expected >= ${o.gte} but got ${v}`);
    }
    if (o.lt !== undefined) {
      if (typeof v !== 'number')
        errors.push(`Output ${o.step}.${o.path} expected number for lt but got ${typeof v}`);
      else if (!(v < o.lt))
        errors.push(`Output ${o.step}.${o.path} expected < ${o.lt} but got ${v}`);
    }
    if (o.lte !== undefined) {
      if (typeof v !== 'number')
        errors.push(`Output ${o.step}.${o.path} expected number for lte but got ${typeof v}`);
      else if (!(v <= o.lte))
        errors.push(`Output ${o.step}.${o.path} expected <= ${o.lte} but got ${v}`);
    }
  }
}

/**
 * Evaluate llm_judge expectations asynchronously.
 * Called separately after evaluateCase since LLM calls are async.
 */
export async function evaluateLlmJudgeExpectations(
  expect: ExpectBlock,
  outputHistory: Record<string, unknown[]>,
  workflowOutputs?: Record<string, unknown>,
  judgeConfig?: import('./llm-judge').LlmJudgeConfig
): Promise<string[]> {
  const judges = (expect as any).llm_judge as
    | import('./llm-judge').LlmJudgeExpectation[]
    | undefined;
  if (!Array.isArray(judges) || judges.length === 0) return [];

  const { evaluateLlmJudge } = await import('./llm-judge');
  const errors: string[] = [];

  for (const judge of judges) {
    // Resolve the output to evaluate
    let output: unknown;
    if (judge.workflow_output) {
      output = workflowOutputs || {};
      if (judge.path) {
        output = deepGet(output, judge.path);
      }
    } else if (judge.step) {
      const hist = outputHistory[judge.step] || [];
      if (!Array.isArray(hist) || hist.length === 0) {
        errors.push(`LLM judge: no output history for step "${judge.step}"`);
        continue;
      }
      const idx =
        judge.index === 'first'
          ? 0
          : judge.index === 'last' || judge.index === undefined
            ? hist.length - 1
            : judge.index;
      output = hist[idx];
      if (judge.path) {
        output = deepGet(output, judge.path);
      }
    } else {
      // No step specified — use entire outputHistory as context
      output = outputHistory;
    }

    const result = await evaluateLlmJudge(judge, output, judgeConfig);
    errors.push(...result.errors);
  }

  return errors;
}

export function evaluateCase(
  caseName: string,
  stats: ExecStats,
  recorder: { calls: Array<{ provider: string; op: string; args: any; ts: number }> },
  slackRecorder: { calls: SlackRecordedCall[] } | undefined,
  expect: ExpectBlock,
  strict: boolean,
  promptsByStep: Record<string, string[]>,
  _results: GroupedResults,
  outputHistory: Record<string, unknown[]>,
  workflowOutputs?: Record<string, unknown>
): string[] {
  const errors: string[] = [];
  const executed = buildExecutedMap(stats);
  const logicalExecuted = buildLogicalExecutedMap(stats);
  const generatedLogicalNames = new Set<string>();
  for (const stat of stats.checks) {
    const logicalName = (stat as any)?.logicalCheckName;
    if (
      !stat.skipped &&
      (stat.totalRuns || 0) > 0 &&
      typeof logicalName === 'string' &&
      logicalName.trim().length > 0 &&
      logicalName !== 'undefined'
    ) {
      generatedLogicalNames.add(logicalName);
    }
  }

  // Augment executed map with nested step counts from outputHistory.
  // Dotted step names (e.g. "route-intent.classify") come from child journal
  // entries propagated by WorkflowCheckProvider and appear in outputHistory
  // but not in top-level execution stats.
  for (const key of Object.keys(outputHistory)) {
    // Generated logical ids are intentionally excluded from the exact-step
    // map. Their stats are keyed by nodeGenerationId and must be selected via
    // logical_step, even when the id happens to be dotted.
    if (key.includes('.') && !(key in executed) && !generatedLogicalNames.has(key)) {
      const hist = outputHistory[key];
      if (Array.isArray(hist) && hist.length > 0) {
        executed[key] = hist.length;
      }
    }
  }

  if (strict) {
    const expectedSteps = new Set<string>();
    const expectedLogicalSteps = new Set<string>();
    for (const call of expect.calls || []) {
      const selector = callSelector(call);
      if (selector === 'step') expectedSteps.add(String(call.step));
      else if (selector === 'logical_step') expectedLogicalSteps.add(String(call.logical_step));
    }

    // Evaluate stats row-by-row. A logical selector covers only generated rows
    // carrying logicalCheckName; it must not cover a top-level row whose
    // checkName happens to be the same logical string.
    const statNames = new Set<string>();
    for (const stat of stats.checks) {
      const checkName = (stat as any)?.checkName;
      if (
        stat.skipped ||
        (stat.totalRuns || 0) <= 0 ||
        typeof checkName !== 'string' ||
        checkName.trim().length === 0 ||
        checkName === 'undefined'
      ) {
        continue;
      }
      statNames.add(checkName);
      const logicalName = (stat as any)?.logicalCheckName;
      const hasLogicalName =
        typeof logicalName === 'string' &&
        logicalName.trim().length > 0 &&
        logicalName !== 'undefined';
      const covered =
        expectedSteps.has(checkName) ||
        (hasLogicalName && expectedLogicalSteps.has(logicalName));
      if (!covered) errors.push(`Step executed without expect: ${checkName}`);
    }

    // Preserve strict handling for nested steps inferred from output history.
    for (const step of Object.keys(executed)) {
      const coveredGeneratedLogicalStep =
        generatedLogicalNames.has(step) && expectedLogicalSteps.has(step);
      if (!statNames.has(step) && !expectedSteps.has(step) && !coveredGeneratedLogicalStep) {
        errors.push(`Step executed without expect: ${step}`);
      }
    }
  }

  evaluateCalls(errors, expect, executed, logicalExecuted);
  evaluateProviderCalls(errors, expect, recorder, slackRecorder);
  evaluateNoCalls(errors, expect, executed, recorder, slackRecorder);
  evaluatePrompts(errors, expect, promptsByStep);
  evaluateOutputs(errors, expect, outputHistory);
  evaluateWorkflowOutputs(errors, expect, workflowOutputs);
  return errors;
}
