import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from '@jest/globals';
import * as yaml from 'js-yaml';
import { runPreflight } from '../../examples/agent-governance/exp-0210-jsonparser-staged/run-live-demo';

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
    expect(source).not.toMatch(/createGovernedProofInspectProviderForFocusedTest|installProbe|synthetic-fixture|deterministic-fake-probe/);
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
});
