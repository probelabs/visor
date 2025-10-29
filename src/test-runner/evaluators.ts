import { RecordingOctokit } from './recorders/github-recorder';
import { validateCounts, type ExpectBlock } from './assertions';

type ExecStats = import('../check-execution-engine').ExecutionStatistics;
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
  const executed: Record<string, number> = {};
  for (const s of stats.checks) {
    if (!s.skipped && (s.totalRuns || 0) > 0) executed[s.checkName] = s.totalRuns || 0;
  }
  return executed;
}

export function evaluateCalls(
  errors: string[],
  expect: ExpectBlock,
  executed: Record<string, number>
): void {
  for (const call of expect.calls || []) {
    if (call.step) {
      validateCounts(call);
      const actual = executed[call.step] || 0;
      if (call.exactly !== undefined && actual !== call.exactly) {
        errors.push(`Expected step ${call.step} exactly ${call.exactly}, got ${actual}`);
      }
      if (call.at_least !== undefined && actual < call.at_least) {
        errors.push(`Expected step ${call.step} at_least ${call.at_least}, got ${actual}`);
      }
      if (call.at_most !== undefined && actual > call.at_most) {
        errors.push(`Expected step ${call.step} at_most ${call.at_most}, got ${actual}`);
      }
    }
  }
}

export function evaluateProviderCalls(
  errors: string[],
  expect: ExpectBlock,
  recorder: RecordingOctokit
): void {
  for (const call of expect.calls || []) {
    if (call.provider && String(call.provider).toLowerCase() === 'github') {
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
        if (!ok) errors.push(`Expected github ${call.op} args.contains not satisfied`);
      }
    }
  }
}

export function evaluateNoCalls(
  errors: string[],
  expect: ExpectBlock,
  executed: Record<string, number>,
  recorder: RecordingOctokit
): void {
  for (const nc of expect.no_calls || []) {
    if (nc.provider && String(nc.provider).toLowerCase() === 'github') {
      const op = mapGithubOp((nc as any).op || '');
      const matched = recorder.calls.filter(c => !op || c.op === op);
      if (matched.length > 0)
        errors.push(`Expected no github ${nc.op} calls, but found ${matched.length}`);
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
      errors.push(`No captured prompt for step ${p.step} at index ${String(p.index ?? 'last')}`);
      continue;
    }
    if (p.contains && !p.contains.every(s => prompt!.includes(s))) {
      errors.push(`Prompt for ${p.step} missing contains assertion`);
    }
    if (p.not_contains && !p.not_contains.every(s => !prompt!.includes(s))) {
      errors.push(`Prompt for ${p.step} contains forbidden text`);
    }
    if (p.matches && !parseRegex(p.matches).test(prompt)) {
      errors.push(`Prompt for ${p.step} does not match pattern`);
    }
  }
}

// Minimal deep-get and comparison helpers for outputs
function deepGet(obj: any, path: string): any {
  if (!path) return obj;
  const parts = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter(Boolean);
  let cur = obj;
  for (const p of parts) {
    if (cur == null) return undefined;
    cur = cur[p as any];
  }
  return cur;
}

function deepEqual(a: any, b: any): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== typeof b) return false;
  if (a && b && typeof a === 'object') {
    if (Array.isArray(a)) {
      if (!Array.isArray(b) || a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], (b as any)[i])) return false;
      return true;
    }
    const keys = Array.from(new Set([...Object.keys(a), ...Object.keys(b)]));
    for (const k of keys) if (!deepEqual(a[k], b[k])) return false;
    return true;
  }
  return false;
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
    const idx =
      o.index === 'first'
        ? 0
        : o.index === 'last'
          ? hist.length - 1
          : ((o.index as number) ?? hist.length - 1);
    const out = hist[idx];
    if (o.path) {
      const v = deepGet(out, o.path);
      if (o.equals !== undefined && !deepEqual(v, o.equals))
        errors.push(`outputs.path ${o.path} equals check failed`);
      if (o.matches && !parseRegex(o.matches).test(String(v)))
        errors.push(`outputs.path ${o.path} matches failed`);
    }
  }
}

export function evaluateCase(
  caseName: string,
  stats: ExecStats,
  recorder: RecordingOctokit,
  expect: ExpectBlock,
  strict: boolean,
  promptsByStep: Record<string, string[]>,
  _results: GroupedResults,
  outputHistory: Record<string, unknown[]>
): string[] {
  const errors: string[] = [];
  const executed = buildExecutedMap(stats);

  if (strict) {
    const expectedSteps = new Set(
      (expect.calls || []).filter(c => c.step).map(c => String(c.step))
    );
    for (const step of Object.keys(executed))
      if (!expectedSteps.has(step)) errors.push(`Step executed without expect: ${step}`);
  }

  evaluateCalls(errors, expect, executed);
  evaluateProviderCalls(errors, expect, recorder);
  evaluateNoCalls(errors, expect, executed, recorder);
  evaluatePrompts(errors, expect, promptsByStep);
  evaluateOutputs(errors, expect, outputHistory);
  return errors;
}
