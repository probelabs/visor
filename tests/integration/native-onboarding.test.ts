import { describe, expect, it } from '@jest/globals';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as yaml from 'js-yaml';
import { ConfigManager } from '../../src/config';

// The repository test setup mocks only asynchronous spawn by default.  This
// integration test intentionally exercises the real helper child process so it
// can prove incremental diagnostics and non-zero exit preservation.
jest.unmock('child_process');
jest.unmock('node:child_process');

// The helper is deliberately CommonJS so it remains directly runnable by the
// documented node command without adding a build step to the example.
const helper = require('../../examples/agent-governance/native-onboarding/run-demo.cjs') as {
  runDemo: (
    options: Record<string, unknown>
  ) => Promise<{ outputDirectory: string; report: Record<string, any> }>;
  childCommand: (
    visor: string,
    config: string,
    timeout: string,
    preflightOnly: boolean
  ) => { executable: string; args: string[] };
  validateRoots: (subject: string, original: string) => { subject: string; original: string };
};

const ROOT = resolve(__dirname, '../..');
const PROFILE = join(ROOT, 'examples/agent-governance/native-onboarding/visor.yaml');

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || ''}`);
}

function gitFixture(prefix: string): { root: string; original: string; proof: string } {
  const parent = mkdtempSync(join(require('node:os').tmpdir(), prefix));
  const original = join(parent, 'original');
  const root = join(parent, 'subject');
  mkdirSync(original);
  mkdirSync(root);
  for (const directory of [original, root]) {
    git(directory, ['init', '-q']);
    git(directory, ['config', 'user.email', 'native-onboarding@example.invalid']);
    git(directory, ['config', 'user.name', 'native-onboarding-test']);
    writeFileSync(
      join(directory, 'go.mod'),
      'module example.invalid/native-onboarding\n\ngo 1.22\n'
    );
    git(directory, ['add', 'go.mod']);
    git(directory, ['commit', '-qm', 'fixture']);
  }
  const proof = join(parent, 'proof');
  writeFileSync(proof, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  chmodSync(proof, 0o700);
  return { root, original, proof };
}

describe('native onboarding milestone A', () => {
  it('loads the human-readable YAML through ConfigManager and preserves the normal command-to-AI DAG', async () => {
    const raw = yaml.load(readFileSync(PROFILE, 'utf8')) as any;
    const manager = new ConfigManager();
    const loaded: any = await manager.loadConfig(PROFILE, { validate: true, mergeDefaults: true });
    const checks = loaded.steps || loaded.checks;
    expect(raw.workspace.enabled).toBe(false);
    expect(checks['preflight-init'].type).toBe('command');
    expect(checks['native-onboard'].type).toBe('ai');
    expect(checks['native-spec-review'].type).toBe('ai');
    expect(checks['native-onboard'].depends_on).toEqual(['role-onboard']);
    expect(checks['native-spec-review'].depends_on).toEqual(['role-spec-review']);
    expect(
      Object.values(checks).some((check: any) => check.type === 'governed-proof-inspect')
    ).toBe(false);
    expect(checks['native-onboard'].ai.provider).toBeUndefined();
    expect(checks['native-onboard'].ai.model).toBe('gpt-5.6-luna');
    expect(checks['native-onboard'].ai.prompt_type).toBe('engineer');
    expect(checks['native-onboard'].ai.bashConfig.disableDefaultAllow).toBe(true);
    expect(checks['native-spec-review'].ai.bashConfig.disableDefaultAllow).toBe(true);
  });

  it('resolves built-in roles at runtime and guards native writable scope', () => {
    const raw: any = yaml.load(readFileSync(PROFILE, 'utf8'));
    const onboard = raw.steps['native-onboard'];
    const review = raw.steps['native-spec-review'];
    expect(raw.steps['role-onboard'].exec).toContain('role show onboard --format agent');
    expect(raw.steps['role-spec-review'].exec).toContain('role show spec-review --format agent');
    expect(onboard.prompt).toContain("outputs['role-onboard']");
    expect(review.prompt).toContain("outputs['role-spec-review']");
    expect(onboard.prompt).not.toContain('ROLE: onboard');
    expect(review.prompt).not.toContain('ROLE: spec-review');
    expect(onboard.ai.bashConfig.workingDirectory).toBe('.');
    expect(review.ai.bashConfig.workingDirectory).toBe('.');
    expect(onboard.ai.extra_allowed_folders).toBeUndefined();
    expect(review.ai.extra_allowed_folders).toBeUndefined();
    expect(onboard.ai_bash_config_js).toContain('env.PROOF_BIN');
    expect(onboard.ai_bash_config_js).toContain('${proof}:*');
    expect(onboard.ai_bash_config_js).toContain("'go:test'");
    expect(onboard.ai_bash_config_js).toContain("'git:status'");
    expect(onboard.prompt).toContain('PROOF_EXECUTABLE=<absolute path>');
    expect(review.prompt).toContain('PROOF_EXECUTABLE=<absolute path>');
    expect(raw.steps['preflight-init'].exec).toContain('VISOR_WORKSPACE_MAIN_PROJECT');
    expect(raw.steps['preflight-init'].exec).toContain('VISOR_ORIGINAL_WORKDIR');
    expect(raw.steps['preflight-init'].exec).toContain('PROOF_BIN" init');
    expect(helper.childCommand('/tmp/visor.ts', PROFILE, '1000', true).args).toEqual(
      expect.arrayContaining(['--check', 'preflight-init', '--tags', 'preflight'])
    );
    expect(helper.childCommand('/tmp/visor.ts', PROFILE, '1000', false).args).toEqual(
      expect.arrayContaining(['--check', 'final-evidence', '--tags', 'native-onboarding'])
    );
  });

  it('fails closed before launch when roots are unavailable or outside the allowed boundary', () => {
    const root = mkdtempSync(join(require('node:os').tmpdir(), 'native-onboarding-boundary-'));
    expect(() => helper.validateRoots(join(root, 'missing'), root)).toThrow(/subjectRoot|ENOENT/);
    expect(() => helper.validateRoots(root, root)).toThrow(/differ/);
  });

  it('retains stdout, stderr, and report artifacts when a command fails', async () => {
    const fixture = gitFixture('native-onboarding-failure-');
    const output = join(fixture.root, '..', 'run-output');
    const fakeVisor = join(fixture.root, '..', 'fake-visor.sh');
    writeFileSync(
      fakeVisor,
      "#!/bin/sh\nprintf '%s\\n' 'partial stdout'\nprintf '%s\\n' 'partial stderr' >&2\nexit 17\n",
      { mode: 0o700 }
    );
    chmodSync(fakeVisor, 0o700);
    expect(spawnSync(fakeVisor, ['--probe'], { encoding: 'utf8' }).status).toBe(17);
    const result = await helper.runDemo({
      subjectRoot: fixture.root,
      originalRoot: fixture.original,
      output,
      visorBin: fakeVisor,
      proofBin: fixture.proof,
      config: PROFILE,
      timeout: '1000',
    });
    expect(result.report.exit_code).toBe(17);
    expect(result.report.execution_status).toBe('execution-failed');
    expect(result.report.terminal_status).toBe('failed-empty-native-requirements');
    expect(readFileSync(join(output, 'visor.stdout.log'), 'utf8')).toContain('partial stdout');
    expect(readFileSync(join(output, 'visor.stderr.log'), 'utf8')).toContain('partial stderr');
    expect(existsSync(join(output, 'report.json'))).toBe(true);
  });

  it('does not admit an empty native requirement set when the launcher exits zero', async () => {
    const fixture = gitFixture('native-onboarding-empty-');
    const output = join(fixture.root, '..', 'run-output');
    const fakeVisor = join(fixture.root, '..', 'fake-visor-success.sh');
    writeFileSync(
      fakeVisor,
      "#!/bin/sh\nprintf '%s\\n' 'model returned success without native files'\nexit 0\n",
      { mode: 0o700 }
    );
    chmodSync(fakeVisor, 0o700);
    const result = await helper.runDemo({
      subjectRoot: fixture.root,
      originalRoot: fixture.original,
      output,
      visorBin: fakeVisor,
      proofBin: fixture.proof,
      config: PROFILE,
      timeout: '1000',
    });
    expect(result.report.execution_status).toBe('execution-succeeded');
    expect(result.report.materialized.native_requirement_count).toBe(0);
    expect(result.report.terminal_status).toBe('failed-empty-native-requirements');
    expect(result.report.admission.status).toBe('not_claimed');
  });

  it('requires a run-owned completion marker for zero-model preflight success', async () => {
    const fixture = gitFixture('native-onboarding-preflight-');
    const output = join(fixture.root, '..', 'preflight-output');
    const fakeVisor = join(fixture.root, '..', 'fake-visor-preflight.sh');
    writeFileSync(
      fakeVisor,
      '#!/bin/sh\nprintf preflight-init-complete >"$NATIVE_ONBOARDING_OUTPUT_DIR/preflight-complete"\nexit 0\n',
      { mode: 0o700 }
    );
    chmodSync(fakeVisor, 0o700);
    const result = await helper.runDemo({
      subjectRoot: fixture.root,
      originalRoot: fixture.original,
      output,
      visorBin: fakeVisor,
      proofBin: fixture.proof,
      config: PROFILE,
      timeout: '1000',
      preflightOnly: true,
    });
    expect(result.report.execution_status).toBe('execution-succeeded');
    expect(result.report.terminal_status).toBe('preflight-complete');
  });
});
