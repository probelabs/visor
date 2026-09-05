import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from '@jest/globals';
import { createHash } from 'node:crypto';
import * as yaml from 'js-yaml';
import {
  aggregateFailureDiagnostics,
  installProbeFailureDiagnostics,
  runPreflight,
  sanitizeProbeFailureTaxonomy,
  serializeFailureDiagnostics,
} from '../../examples/agent-governance/exp-0210-jsonparser-staged/run-live-demo';
import { validateProofCandidateEvidence } from '../../src/providers/governed-proof-inspect-check-provider';
import { compileClaimPlan } from '../../src/state-machine/graph/claim-plan';
import { sha256Canonical } from '../../src/state-machine/graph/claim-kernel';

type AnyRecord = Record<string, any>;
const ROOT = path.resolve(__dirname, '../..');
const LIVE = path.join(ROOT, 'examples/agent-governance/exp-0210-jsonparser-staged/run-live-demo.ts');
const PROFILE = path.join(ROOT, 'examples/agent-governance/exp-0210-jsonparser-staged/visor.yaml');
const PINS = {
  visor: '025f53ce', baseline: 'cb835d480ac58e1b4be76afeac49e89ed651c3b5',
  fix: '3980c9c9b9919e643bd095fa4469bfa19e29f20c', proof: '543994bd68f2b6d6217749c4c19be737021b993a',
  probe: '0.6.0-rc334', codex: '0.150.1', profile: 'luna-xhigh-readonly-v1',
};
const STAGES = ['inspect', 'proof_admit', 'spec_review', 'spec_review_admit', 'verify'];
const DIAGNOSTICS_SCHEMA = 'urn:reqproof:agent-governance:exp-0210-failure-diagnostics:v1';
const FAILURE_PREDICATES = ['event_shape', 'jsonrpc', 'params_shape', 'response_id', 'meta_shape', 'session_shape', 'session_identity', 'model', 'model_provider', 'approval_policy', 'approvals_reviewer', 'reasoning_effort', 'rollout_path', 'cwd', 'permission_shape', 'session_type', 'permission_type', 'network', 'filesystem_shape', 'filesystem_type', 'entries', 'entry', 'access', 'path_shape', 'path_type', 'value_shape', 'kind', 'native_tool_evidence', 'internal_contract'];
const SCHEMA_SUBREASONS = ['response_json', 'schema_definition', 'schema_mismatch', 'result_identity'];
const SCHEMA_KEYWORDS = ['required', 'additionalProperties', 'type', 'pattern', 'enum', 'minItems', 'maxItems', 'multiple', 'unknown'];
const RETAINED_CHECKPOINT = '/tmp/visor-exp0210-live-luna.fom5fO/output/failure.checkpoint.json';
const RETAINED_PREFLIGHT = '/tmp/visor-exp0210-live-luna.fom5fO/output/preflight.json';

function focusedSubprocess(kind: 'valid' | 'checkpoint' | 'preflight'): { root: string; output: string; runner: string; result: ReturnType<typeof spawnSync> } {
  const shadow = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-exp0210-focused-shadow-'));
  const output = path.join(shadow, 'focused-output');
  const runnerRelative = 'examples/agent-governance/exp-0210-jsonparser-staged/run-live-demo.ts';
  const archive = spawnSync('git', ['archive', 'HEAD', '--', 'src', 'package.json', 'package-lock.json', 'tsconfig.json', 'examples/agent-governance/exp-0210-jsonparser-staged'], { cwd: ROOT, encoding: null, maxBuffer: 64 * 1024 * 1024 });
  if (archive.status !== 0 || !archive.stdout) throw new Error('unable to archive the Visor test shadow');
  const unpack = spawnSync('tar', ['-xf', '-', '-C', shadow], { input: archive.stdout });
  if (unpack.status !== 0) throw new Error('unable to unpack the Visor test shadow');
  const preflight = path.join(shadow, 'retained-preflight.json');
  const checkpoint = path.join(shadow, 'retained-checkpoint.json');
  fs.copyFileSync(RETAINED_PREFLIGHT, preflight); fs.copyFileSync(RETAINED_CHECKPOINT, checkpoint);
  if (kind === 'preflight') { const value = JSON.parse(fs.readFileSync(preflight, 'utf8')); value.graph.semantic_digest = '0'.repeat(64); fs.writeFileSync(preflight, `${JSON.stringify(value)}\n`); }
  if (kind === 'checkpoint') { const value = JSON.parse(fs.readFileSync(checkpoint, 'utf8')); value.graphSemanticDigest = '0'.repeat(64); fs.writeFileSync(checkpoint, `${JSON.stringify(value)}\n`); }
  const runner = path.join(shadow, runnerRelative);
  let source = fs.readFileSync(LIVE, 'utf8');
  if (kind !== 'valid') {
    source = source.replace(/const FOCUSED_PREFLIGHT = '[^']+';/, `const FOCUSED_PREFLIGHT = ${JSON.stringify(preflight)};`);
    source = source.replace(/const FOCUSED_CHECKPOINT = '[^']+';/, `const FOCUSED_CHECKPOINT = ${JSON.stringify(checkpoint)};`);
  }
  fs.writeFileSync(runner, source, { encoding: 'utf8', mode: 0o600 });
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(shadow, 'node_modules'), 'dir');
  for (const args of [['init', '-q'], ['config', 'user.email', 'visor-exp0210@example.invalid'], ['config', 'user.name', 'Visor EXP-0210'], ['add', '-A'], ['commit', '-qm', 'focused-preflight']]) {
    const git = spawnSync('git', args, { cwd: shadow, encoding: 'utf8' });
    if (git.status !== 0) throw new Error('unable to commit the Visor test shadow');
  }
  const head = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: shadow, encoding: 'utf8' }).stdout.trim();
  const digest = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const env = { ...process.env, VISOR_EXP0210_EXPECTED_VISOR_HEAD: head, VISOR_EXP0210_EXPECTED_YAML_SHA256: digest(path.join(shadow, 'examples/agent-governance/exp-0210-jsonparser-staged/visor.yaml')), VISOR_EXP0210_EXPECTED_RUNNER_SHA256: digest(runner) };
  delete env.GIT_DIR; delete env.GIT_WORK_TREE;
  const result = spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', runner, '--focused-diagnostic-preflight', '--output', output], { cwd: shadow, env, encoding: 'utf8', timeout: 120_000, maxBuffer: 32 * 1024 * 1024 });
  return { root: shadow, output, runner, result };
}

function diagnosticEntry(phase: string, component: string, index: number): AnyRecord {
  return {
    phase,
    check_id: 'spec_review',
    component_id: component,
    binding_digest: `sha256:${index.toString(16).padStart(64, '0')}`,
    taxonomy: sanitizeProbeFailureTaxonomy({ answerFailureStage: 'provider_engine' }),
  };
}

function request(component: string, error: Error): AnyRecord {
  return { binding: { checkId: 'spec_review', attemptId: component, scope: [{ key: 'jsonparser' }, { key: component }] }, error };
}

describe('EXP-0210 live preflight', () => {
  it('exposes dependency-only preflight with zero governed/model calls', () => {
    expect(typeof runPreflight).toBe('function');
    const source = fs.readFileSync(LIVE, 'utf8');
    const report = source.slice(source.indexOf('function preflightReport'), source.indexOf('function prepare'));
    const preflight = source.slice(source.indexOf('export function runPreflight'), source.indexOf('export function runJsonparserStagedLive'));
    expect(report).toContain("mode: 'preflight-only'");
    expect(report).toMatch(/governed_calls: 0, model_calls: 0, network_dispatches_requested: 0/);
    expect(report).toContain('preflight performs no Probe-agent initialization or governed/model/network dispatch');
    expect(preflight).not.toContain('childProcess(');
    expect(preflight).not.toContain('answerGoverned');
    for (const pin of ['VISOR_EXP0210_EXPECTED_VISOR_HEAD', 'VISOR_EXP0210_EXPECTED_YAML_SHA256', 'VISOR_EXP0210_EXPECTED_RUNNER_SHA256']) {
      expect(source).toContain(`process.env.${pin}`);
    }
  });

  it('rejects mixed/unknown CLI modes before claiming an absent output', () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-exp0210-cli-'));
    try {
      const cases = [
        ['--preflight-only', '--run-once'],
        ['--preflight-only', '--child', 'pause', '--controller-pid', '1'],
        ['--preflight-only', '--unsupported'],
      ];
      for (const flags of cases) {
        const output = path.join(parent, `out-${cases.indexOf(flags)}`);
        const child = spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', LIVE, ...flags, '--output', output], {
          cwd: ROOT, env: { ...process.env }, encoding: 'utf8', timeout: 30_000,
        });
        expect(child.status).toBe(1);
        expect(child.stderr).toBe('EXP-0210 live runner failed\n');
        expect(fs.existsSync(output)).toBe(false);
      }
    } finally { fs.rmSync(parent, { recursive: true, force: true }); }
  });

  it('keeps the graph/pins bounded and isolates live-child/private receipt paths', () => {
    const source = fs.readFileSync(LIVE, 'utf8');
    const config = yaml.load(fs.readFileSync(PROFILE, 'utf8')) as AnyRecord;
    const project = config.subgraphs['discover-project'].checks;
    const component = config.subgraphs['onboard-component'].checks;
    expect(project.inspect.profile).toBe(PINS.profile);
    expect(project.inspect.invocation.role_id).toBe('onboard');
    expect(project.inspect.invocation.output_schema_id).toBe('proof.component-catalog-candidate@1');
    expect(component.inspect.invocation.role_id).toBe('onboard');
    expect(component.spec_review.invocation.role_id).toBe('spec-review');
    expect(Object.keys(component)).toEqual(STAGES);
    expect(component.spec_review.consumes.map((value: AnyRecord) => value.claim)).toEqual([
      'component.work_item@1', 'proof.candidate@1', 'proof.admitted_receipt@1',
    ]);
    expect(component.verify.consumes.map((value: AnyRecord) => value.claim)).toEqual([
      'proof.candidate@1', 'proof.admitted_receipt@1', 'proof.component_spec_review_candidate@1', 'proof.component_spec_review_admitted_receipt@1',
    ]);
    const catalogSchema = config.claim_types['proof.candidate@1'].schema.oneOf[0];
    expect(catalogSchema.properties.components.minItems).toBe(2);
    expect(catalogSchema.properties.components.maxItems).toBe(32);
    expect(source).toContain(`const MAX_COMPONENTS = 4;`);
    expect(source).toContain(`const MAX_CALLS = 11;`);
    expect(source).toContain(`changed.length !== 1`);
    expect(source).toContain(`ids.length > MAX_COMPONENTS`);
    expect(source).toMatch(/function childEnvironment\(\).*API_KEY\|ACCESS_TOKEN\|SECRET\|PASSWORD\|EVALUATOR\|SUBJECT/);
    expect(source).toMatch(/spawnSync\(process\.execPath,[\s\S]*--child[\s\S]*childEnvironment\(\)/);
    expect(source).toContain("fs.openSync(file, 'wx', 0o600)");
    expect(source).toContain('output directory already contains terminal evidence');
    expect(source).toContain("'preflight.json'");
    expect(source).toContain("'run-once.started.json'");
    expect(source).toContain("'run-once.completed.json'");
    expect(source).toContain("'run-once.failure.json'");
    expect(source).not.toMatch(/createGovernedProofInspectProviderForFocusedTest|synthetic-fixture|deterministic-fake-probe/);
  });

  it('binds phase labels/budgets and fails truthfully before live work', () => {
    const source = fs.readFileSync(LIVE, 'utf8');
    for (const [name, value] of Object.entries({
      VISOR_COMMIT: PINS.visor, BASELINE_COMMIT: PINS.baseline, FIX_COMMIT: PINS.fix,
      PROOF_COMMIT: PINS.proof, PROBE_VERSION: PINS.probe, CODEX_VERSION: PINS.codex,
    })) expect(source).toContain(`const ${name} = '${value}';`);
    expect(source).toContain('VISOR_EXP0210_EXPECTED_VISOR_HEAD');
    expect(source).toContain('VISOR_EXP0210_EXPECTED_YAML_SHA256');
    expect(source).toContain('VISOR_EXP0210_EXPECTED_RUNNER_SHA256');
    expect(source).toMatch(/function frozenPins\(requireFrozen = false\)/);
    expect(source).toContain("if (requireFrozen && (!expectedHead || !expectedYaml || !expectedRunner))");
    expect(source).toContain("if (requireFrozen && !visorClean)");
    expect(source).toContain("const repoStatus = command('git', ['status', '--porcelain=v1', '--untracked-files=all']);");
    expect(source).toContain('const prepared = prepare(stage, true);');
    expect(source).toContain("if (before.git_status.length !== 0) throw new Error('subject checkout is not clean for the frozen run');");
    expect(source).toContain('login_verified: login.status === 0');
    expect(source).not.toContain('login_status:');

    const claim = source.slice(source.indexOf('function claimRunOutput'), source.indexOf('function publish'));
    expect(claim).toContain('fs.mkdirSync(target, { mode: 0o700 });');
    expect(claim).not.toContain('recursive: true');
    expect(claim).toContain('run-once output is already claimed');
    const runOnce = source.slice(source.indexOf('export function runJsonparserStagedLive'), source.indexOf('async function runChildMode'));
    expect(runOnce.indexOf('const stage = claimRunOutput(outputDirectory);')).toBeLessThan(runOnce.indexOf('try {'));

    const labels = ["childProcess('discovery'", "childProcess('pause'", "childProcess('resume'", "childProcess('replacement'"];
    const positions = labels.map(label => runOnce.indexOf(label));
    expect(positions.every((position, index) => position >= 0 && (index === 0 || position > positions[index - 1]))).toBe(true);
    expect(source).toMatch(/const PAUSE_CALLS = 7;/);
    expect(source).toMatch(/const RESUME_CALLS = 2;/);
    expect(source).toMatch(/const REPLACEMENT_CALLS = 2;/);
    expect(source).toContain('const DISCOVERY_TIMEOUT_MS = MANAGED_DEADLINE_MS + SUPERVISOR_CLEANUP_MS;');
    expect(source).toContain('const COMPONENT_TIMEOUT_MS = 61 * 60 * 1000 + SUPERVISOR_CLEANUP_MS;');
    expect(source).toContain('const timeout = mode === \'discovery\' ? DISCOVERY_TIMEOUT_MS : COMPONENT_TIMEOUT_MS;');
    expect(source).toContain('withGovernedProbeRunnerBudget(pauseBudget');
    expect(source).toContain('withGovernedProbeRunnerBudget(RESUME_CALLS');
    expect(source).toContain('withGovernedProbeRunnerBudget(REPLACEMENT_CALLS');

    const failure = source.slice(source.indexOf('function failureReceipt'), source.indexOf('export function runPreflight'));
    expect(failure).toContain("status: 'failed'");
    expect(failure).toContain('terminal: true');
    expect(failure).toContain('failure_code: code');
    expect(failure).toContain('retries: 0, fallback: false');
    expect(failure).not.toContain("status: 'passed'");
    expect(source).toContain("let value: number | 'unknown' = 'unknown';");
    expect(source).toContain("failureReceipt(stage, 'PREFLIGHT_FAILED', { governed_calls: 0, model_calls: 0, network_dispatches_requested: 0, completed_phases: [], checkpoint_evidence: [] }, 'preflight-only');");
    expect(source).toContain("const file = path.join(stage, 'failure.checkpoint.json');");
    expect(source).toContain("latest_checkpoint: latestCheckpoint");
    expect(source).toContain("replacementSuffix.length !== STAGES.length + 1");
    expect(source).toContain("reconcileAttempts.length !== 1");
  });

  it('aggregates pause and resume fragments without losing either rejection', () => {
    const pause = diagnosticEntry('pause', 'parser-core', 1);
    const resume = diagnosticEntry('resume', 'byte-conversion-backend', 2);
    const result = aggregateFailureDiagnostics([
      { schema: DIAGNOSTICS_SCHEMA, failures: [pause] },
      { schema: DIAGNOSTICS_SCHEMA, failures: [resume, pause, { ...resume, raw_output: 'secret' }] },
      { schema: 'wrong-schema', failures: [diagnosticEntry('replacement', 'ignored', 3)] },
    ]);
    expect(result).toHaveLength(2);
    expect(result.map(entry => [entry.phase, entry.component_id])).toEqual([
      ['pause', 'parser-core'], ['resume', 'byte-conversion-backend'],
    ]);
  });

  it('caps 33 concurrent rejections at 32 and writes bounded mode-0600 JSON', async () => {
    class RejectingProbe {
      answer(input: AnyRecord): Promise<never> { return Promise.reject(input.error); }
    }
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-exp0210-diagnostics-'));
    fs.mkdirSync(path.join(stage, '.private'), { mode: 0o700 });
    try {
      const restore = installProbeFailureDiagnostics('pause', stage, RejectingProbe);
      try {
        const calls = Array.from({ length: 33 }, (_, index) => request(`component-${index}`, Object.assign(new Error('raw secret output'), { answerFailureStage: 'provider_engine', path: '/private/secret' })));
        await Promise.all(calls.map(async input => expect(RejectingProbe.prototype.answer.call(new RejectingProbe(), input)).rejects.toBe(input.error)));
      } finally { restore(); }
      const file = path.join(stage, '.private', 'failure-diagnostics.pause.json');
      const bytes = fs.readFileSync(file);
      const body = JSON.parse(bytes.toString());
      expect(body.failures).toHaveLength(32);
      expect(new Set(body.failures.map((entry: AnyRecord) => entry.component_id))).toEqual(new Set(Array.from({ length: 32 }, (_, index) => `component-${index}`)));
      expect(new Set(body.failures.map((entry: AnyRecord) => entry.binding_digest)).size).toBe(32);
      expect(bytes.length).toBeLessThanOrEqual(32 * 1024);
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(serializeFailureDiagnostics(body.failures)).toBe(bytes.toString());
    } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  });

  it('keeps hostile paths, prompts, messages, and raw output outside the closed taxonomy', () => {
    const taxonomyCases = [
      ...['native_event_grammar', 'provider_engine', 'schema_result_validation', 'unknown'].map(answerFailureStage => ({ answerFailureStage })),
      ...['raw_item_predicate', 'live_envelope_session'].map(nativeEventFailureBoundary => ({ answerFailureStage: 'native_event_grammar', nativeEventFailureBoundary })),
      ...['session_sequence', 'envelope_shape', 'correlation', 'attestation'].map(nativeEventFailureSubreason => ({ answerFailureStage: 'native_event_grammar', nativeEventFailureBoundary: 'live_envelope_session', nativeEventFailureSubreason })),
      ...['thread_id', 'response_id'].map(nativeEventFailureCorrelationOperand => ({ answerFailureStage: 'native_event_grammar', nativeEventFailureBoundary: 'live_envelope_session', nativeEventFailureSubreason: 'correlation', nativeEventFailureCorrelationOperand })),
      ...FAILURE_PREDICATES.map(nativeEventFailureAttestationPredicate => ({ answerFailureStage: 'native_event_grammar', nativeEventFailureBoundary: 'live_envelope_session', nativeEventFailureSubreason: 'attestation', nativeEventFailureAttestationPredicate })),
      ...SCHEMA_SUBREASONS.map(schemaResultValidationSubreason => ({ answerFailureStage: 'schema_result_validation', schemaResultValidationSubreason })),
      ...SCHEMA_KEYWORDS.map(schemaResultValidationKeyword => ({ answerFailureStage: 'schema_result_validation', schemaResultValidationSubreason: 'schema_mismatch', schemaResultValidationKeyword })),
    ];
    for (const input of taxonomyCases) {
      const taxonomy = sanitizeProbeFailureTaxonomy(input);
      expect(Object.isFrozen(taxonomy)).toBe(true);
      expect(JSON.stringify(taxonomy)).not.toMatch(/secret|private|prompt|output|token/i);
    }
    const hostile = Object.assign(new Error('secret raw answer'), {
      answerFailureStage: 'schema_result_validation', schemaResultValidationSubreason: 'schema_mismatch', schemaResultValidationKeyword: 'type',
      path: '/private/secret/path', prompt: 'secret prompt', raw_output: 'secret model output', token: 'secret token',
    });
    const taxonomy = sanitizeProbeFailureTaxonomy(hostile);
    expect(taxonomy).toEqual({ answerFailureStage: 'schema_result_validation', schemaResultValidationSubreason: 'schema_mismatch', schemaResultValidationKeyword: 'type' });
    expect(JSON.stringify(taxonomy)).not.toMatch(/secret|private|prompt|output|token/i);
    const invalid = { ...diagnosticEntry('pause', 'parser-core', 1), raw_output: 'secret model output' };
    expect(aggregateFailureDiagnostics([{ schema: DIAGNOSTICS_SCHEMA, failures: [invalid] }])).toEqual([]);
  });

  it('restores the original wrapper and preserves rejected error identity', async () => {
    class RejectingProbe {
      answer(input: AnyRecord): Promise<never> { return Promise.reject(input.error); }
    }
    const stage = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-exp0210-restore-'));
    fs.mkdirSync(path.join(stage, '.private'), { mode: 0o700 });
    const original = Object.getOwnPropertyDescriptor(RejectingProbe.prototype, 'answer');
    const error = Object.assign(new Error('opaque secret'), { answerFailureStage: 'native_event_grammar', nativeEventFailureBoundary: 'raw_item_predicate' });
    const input = request('parser-core', error);
    try {
      const restore = installProbeFailureDiagnostics('resume', stage, RejectingProbe);
      await expect(new RejectingProbe().answer(input)).rejects.toBe(error);
      restore(); restore();
      expect(Object.getOwnPropertyDescriptor(RejectingProbe.prototype, 'answer')).toEqual(original);
      await expect(new RejectingProbe().answer(input)).rejects.toBe(error);
      const fragment = JSON.parse(fs.readFileSync(path.join(stage, '.private', 'failure-diagnostics.resume.json'), 'utf8'));
      expect(fragment.failures).toHaveLength(1);
      expect(fragment.failures[0]).toEqual(expect.objectContaining({ phase: 'resume', check_id: 'spec_review', component_id: 'parser-core' }));
    } finally { fs.rmSync(stage, { recursive: true, force: true }); }
  });

  it('rechecks the retained checkpoint oracle when the private artifact is available', () => {
    if (!fs.existsSync(RETAINED_CHECKPOINT)) return;
    const bytes = fs.readFileSync(RETAINED_CHECKPOINT);
    const checkpoint = JSON.parse(bytes.toString()) as AnyRecord;
    expect(createHash('sha256').update(bytes).digest('hex')).toBe('1c7a3a8ac34ad7059f2ff6343bd7f3038edf201c6936ee0177766a84c07fd249');
    expect(checkpoint.graphSemanticDigest).toBe('306b074949f3975a5396dfffe74fc335790f7c6247f9b6c0ea90a5555d8fb212');
    expect(checkpoint.events).toHaveLength(125);
    const componentEvents = checkpoint.events.filter((event: AnyRecord) => event.scope?.length === 2 && event.scope.at(-1)?.key);
    expect(new Set(componentEvents.map((event: AnyRecord) => event.scope.at(-1).key))).toEqual(new Set(['parser-core', 'unicode-escape-codec', 'byte-conversion-backend']));
    const governedStarts = checkpoint.events.filter((event: AnyRecord) => event.type === 'AttemptStarted' && ['inspect', 'spec_review'].includes(event.checkId));
    expect(governedStarts).toHaveLength(7);
    expect(governedStarts.reduce((counts: AnyRecord, event: AnyRecord) => { counts[event.checkId] = (counts[event.checkId] || 0) + 1; return counts; }, {})).toEqual({ inspect: 4, spec_review: 3 });
    expect(checkpoint.events.filter((event: AnyRecord) => event.type === 'ClaimPublished' && event.proofCandidateEvidence)).toHaveLength(4);
    expect(checkpoint.events.filter((event: AnyRecord) => event.type === 'AttemptFailed' && event.checkId === 'spec_review')).toHaveLength(3);
    const parserFailure = checkpoint.events.filter((event: AnyRecord) => event.type === 'AttemptFailed' && event.checkId === 'spec_review' && event.scope.at(-1)?.key === 'parser-core');
    expect(parserFailure).toHaveLength(1);
    expect(checkpoint.events.some((event: AnyRecord) => ['spec_review_admit', 'project_reconcile', 'reconcile'].includes(event.checkId))).toBe(false);
    expect(checkpoint.events.some((event: AnyRecord) => String(event.claim || '').startsWith('proof.component_spec_review_'))).toBe(false);
    for (const event of checkpoint.events.filter((value: AnyRecord) => value.type === 'ClaimPublished')) {
      expect(event.payloadFingerprint).toBe(sha256Canonical(event.payload));
      if (event.proofCandidateEvidence) expect(event.proofCandidateEvidenceFingerprint).toBe(sha256Canonical(event.proofCandidateEvidence));
    }
    const parserCandidate = checkpoint.events.find((event: AnyRecord) => event.type === 'ClaimPublished' && event.claim === 'proof.candidate@1' && event.scope.at(-1)?.key === 'parser-core');
    const parserAdmission = checkpoint.events.find((event: AnyRecord) => event.type === 'ClaimPublished' && event.claim === 'proof.admitted_receipt@1' && event.scope.at(-1)?.key === 'parser-core');
    expect(parserCandidate).toEqual(expect.objectContaining({ producerCheckId: 'inspect', wireMode: 'generic' }));
    expect(parserAdmission).toEqual(expect.objectContaining({ producerCheckId: 'proof_admit', parentClaimIds: [parserCandidate.claimId] }));
    expect(parserCandidate.sessionId).toBe(parserAdmission.sessionId);
    expect(parserCandidate.scope).toEqual(parserAdmission.scope);
    expect(parserCandidate.proofCandidateEvidence.probe.attestation.evidence.eventCount).toBe(1);
    expect(parserCandidate.proofCandidateEvidence.probe.resultIdentity.resultDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('hydrates the retained role and rejects forged target/digest before provider construction', () => {
    const source = fs.readFileSync(LIVE, 'utf8');
    const config = yaml.load(fs.readFileSync(PROFILE, 'utf8')) as AnyRecord;
    expect(compileClaimPlan(config).expansionPlan.graphSemanticDigest).toBe('c7730a647d15ad36c3378990041d7c4641da1782b05f026f0c4d3c18d78d10b1');
    expect(source).toContain('function resolveHistoricalProjectRole');
    expect(source).toContain('const historical = evidence.role.invocation;');
    expect(source).toContain('if (resolved.invocation_digest !== evidence.role.invocationDigest)');
    expect(source).toContain('check.invocation = JSON.parse(JSON.stringify(historical));');
    const derive = source.slice(source.indexOf('function deriveFocusedSpecReview'), source.indexOf('function safeFocusedError'));
    expect(derive).toContain("value.scope?.at(-1)?.key === 'parser-core'");
    expect(derive).toContain('if (failed.length !== 1)');
    const child = source.slice(source.indexOf('async function runFocusedSpecReviewChild'), source.indexOf('async function runChildMode'));
    expect(child.indexOf('const derivation = deriveFocusedSpecReview')).toBeLessThan(child.indexOf('createProofAdmissionCapability'));
    if (!fs.existsSync(RETAINED_CHECKPOINT)) return;
    const checkpoint = JSON.parse(fs.readFileSync(RETAINED_CHECKPOINT, 'utf8')) as AnyRecord;
    const failed = checkpoint.events.filter((event: AnyRecord) => event.type === 'AttemptFailed' && event.checkId === 'spec_review' && event.scope?.at(-1)?.key === 'parser-core');
    expect(failed).toHaveLength(1);
    expect(checkpoint.events.filter((event: AnyRecord) => event.type === 'AttemptFailed' && event.checkId === 'spec_review' && event.scope?.at(-1)?.key !== 'parser-core')).toHaveLength(2);
    const duplicate = [...checkpoint.events, failed[0]];
    expect(duplicate.filter((event: AnyRecord) => event.type === 'AttemptFailed' && event.checkId === 'spec_review' && event.scope?.at(-1)?.key === 'parser-core')).toHaveLength(2);
    const forged = checkpoint.events.map((event: AnyRecord) => event === failed[0] ? { ...event, scope: [{ ...event.scope.at(-1), key: 'forged-target' }] } : event);
    expect(forged.filter((event: AnyRecord) => event.type === 'AttemptFailed' && event.checkId === 'spec_review' && event.scope?.at(-1)?.key === 'parser-core')).toHaveLength(0);
    const candidate = checkpoint.events.find((event: AnyRecord) => event.type === 'ClaimPublished' && event.claim === 'proof.candidate@1' && event.scope?.at(-1)?.key === 'parser-core') as AnyRecord;
    const altered = JSON.parse(JSON.stringify(candidate.proofCandidateEvidence));
    altered.role.invocationDigest = `sha256:${'0'.repeat(64)}`;
    expect(() => validateProofCandidateEvidence(altered)).toThrow();
  });

  it('keeps retained preflight, lifecycle, ledger, and stdio evidence zero-call and inspectable', () => {
    const source = fs.readFileSync(LIVE, 'utf8');
    const focused = source.slice(source.indexOf('function focusedDiagnosticPreflightReport'), source.indexOf('function runFocusedDiagnosticPreflight'));
    expect(focused).toContain("schema: 'urn:reqproof:agent-governance:exp-0210-focused-diagnostic-preflight:v1'");
    expect(focused).toContain('governed_calls: 0, model_calls: 0');
    expect(focused).toContain('derivation: focusedDerivationSummary(derivation)');
    const summary = source.slice(source.indexOf('function focusedDerivationSummary'), source.indexOf('function focusedDiagnosticPreflightReport'));
    expect(summary).toContain('historical_binding');
    expect(summary).toContain('historical_termination');
    const child = source.slice(source.indexOf('async function runFocusedSpecReviewChild'), source.indexOf('async function runChildMode'));
    expect(child).toContain('timeline');
    expect(child).toContain('call_ledger');
    expect(child).toContain('checkpoint_sha256_before');
    expect(child).toContain('checkpoint_sha256_after');
    expect(source).toContain('function focusedChildStream');
    if (!fs.existsSync(RETAINED_CHECKPOINT)) return;
    const checkpoint = JSON.parse(fs.readFileSync(RETAINED_CHECKPOINT, 'utf8')) as AnyRecord;
    const preflightPath = '/tmp/visor-exp0210-live-luna.fom5fO/output/preflight.json';
    if (fs.existsSync(preflightPath)) {
      const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as AnyRecord;
      expect(preflight).toEqual(expect.objectContaining({ status: 'passed', mode: 'preflight-only', governed_calls: 0, model_calls: 0, network_dispatches_requested: 0, retries: 0, fallback: false }));
      expect(preflight.graph).toEqual(expect.objectContaining({ semantic_digest: checkpoint.graphSemanticDigest, compiled: true, dynamic_expansion: true, staged_profile: true }));
      expect(preflight.contract.stages).toEqual(STAGES);
      expect(preflight.evidence).toContain('no Probe-agent initialization');
    }
    const parser = checkpoint.events.filter((event: AnyRecord) => event.type === 'AttemptFailed' && event.checkId === 'spec_review' && event.scope?.at(-1)?.key === 'parser-core');
    const binding = parser[0]?.nodeGenerationId;
    expect(binding).toBeTruthy();
    expect(checkpoint.events.filter((event: AnyRecord) => event.type === 'ManagedRunAcquired' && event.binding?.nodeGenerationId === binding)).toHaveLength(1);
    expect(checkpoint.events.filter((event: AnyRecord) => event.type === 'ManagedRunTerminated' && event.binding?.nodeGenerationId === binding)).toHaveLength(1);
  });

  it('runs focused preflight in a clean subprocess and binds the generated report to retained history', () => {
    if (!fs.existsSync(RETAINED_CHECKPOINT) || !fs.existsSync(RETAINED_PREFLIGHT)) return;
    const run = focusedSubprocess('valid');
    try {
      expect(run.result.status).toBe(0);
      expect(run.result.stderr).toBe('');
      const report = JSON.parse(fs.readFileSync(path.join(run.output, 'focused-diagnostic-preflight.json'), 'utf8')) as AnyRecord;
      expect(report).toEqual(expect.objectContaining({ schema: 'urn:reqproof:agent-governance:exp-0210-focused-diagnostic-preflight:v1', status: 'passed', mode: 'focused-diagnostic-preflight', governed_calls: 0, model_calls: 0, network_dispatches_requested: 0, retries: 0, fallback: false }));
      expect(report.derivation).toEqual(expect.objectContaining({ checkpoint_sha256: 'sha256:1c7a3a8ac34ad7059f2ff6343bd7f3038edf201c6936ee0177766a84c07fd249', graph_semantic_digest: '306b074949f3975a5396dfffe74fc335790f7c6247f9b6c0ea90a5555d8fb212', component_id: 'parser-core', aliases: ['admission', 'candidate', 'component'] }));
      expect(report.derivation.historical_termination).toEqual({ controller_decision: 'failed', cleanup_status: 'clean', failure_code: 'MANAGED_OUTCOME_FAILED' });
      expect(report.preflight_receipt).toEqual(expect.objectContaining({ sha256: 'sha256:d46cd19eb7b7cc64165288caee36498591860da1d636a6f9bd2393ca07bb6507', graph_semantic_digest: report.derivation.graph_semantic_digest }));
      const source = fs.readFileSync(run.runner, 'utf8');
      const child = source.slice(source.indexOf('async function runFocusedSpecReviewChild'), source.indexOf('async function runChildMode'));
      expect(child.indexOf('consumeFocusedCapability')).toBeLessThan(child.indexOf('createProofAdmissionCapability'));
      const directDir = path.join(run.root, 'direct-child'); fs.mkdirSync(path.join(directDir, '.private'), { recursive: true, mode: 0o700 });
      const direct = spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', run.runner, '--child', 'focused-spec-review', '--output', directDir, '--controller-pid', String(process.pid)], { cwd: run.root, encoding: 'utf8', timeout: 30_000 });
      expect(direct.status).toBe(1); expect(direct.stderr).toBe('EXP-0210 focused child failed\n');
      expect(fs.existsSync(path.join(directDir, '.private', 'focused-spec-review.result.json'))).toBe(false);
    } finally { fs.rmSync(run.root, { recursive: true, force: true }); }
  }, 120_000);

  it('rejects mutated retained checkpoint and preflight digests before any provider path', () => {
    if (!fs.existsSync(RETAINED_CHECKPOINT) || !fs.existsSync(RETAINED_PREFLIGHT)) return;
    for (const kind of ['checkpoint', 'preflight'] as const) {
      const run = focusedSubprocess(kind);
      try {
        expect(run.result.status).toBe(1); expect(run.result.stderr).toBe('EXP-0210 live runner failed\n');
        const failure = JSON.parse(fs.readFileSync(path.join(run.output, 'run-once.failure.json'), 'utf8')) as AnyRecord;
        expect(failure).toEqual(expect.objectContaining({ status: 'failed', terminal: true, mode: 'preflight-only', failure_code: 'FOCUSED_PREFLIGHT_FAILED', governed_calls: 0, model_calls: 0, network_dispatches_requested: 0, retries: 0, fallback: false }));
        expect(fs.existsSync(path.join(run.output, 'focused-diagnostic-preflight.json'))).toBe(false);
      } finally { fs.rmSync(run.root, { recursive: true, force: true }); }
    }
  }, 120_000);
});
