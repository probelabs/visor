import { describe, expect, it } from '@jest/globals';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as yaml from 'js-yaml';
import { ConfigManager } from '../../src/config';
import { CommandCheckProvider } from '../../src/providers/command-check-provider';
import { AICheckProvider } from '../../src/providers/ai-check-provider';
import type { PRInfo } from '../../src/pr-analyzer';

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
    expect(raw.steps['role-onboard'].schema).toBe('plain');
    expect(raw.steps['role-spec-review'].schema).toBe('plain');
    expect(raw.steps['role-onboard'].transform_js).toContain('return String(output);');
    expect(raw.steps['role-spec-review'].transform_js).toContain('return String(output);');
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

  it('preserves complete built-in role text through the real command provider and dependent prompt', async () => {
    const raw: any = yaml.load(readFileSync(PROFILE, 'utf8'));
    const provider = new CommandCheckProvider();
    const aiProvider = new AICheckProvider();
    const prInfo: PRInfo = {
      number: 1,
      title: 'native role handoff',
      body: '',
      author: 'test-user',
      base: 'main',
      head: 'fixture',
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
    };
    const embedded =
      'ROLE PREFIX before JSON {"caller-module":"error-handling-pattern"} ROLE SUFFIX after JSON';

    for (const roleCheck of ['role-onboard', 'role-spec-review']) {
      const roleResult = await provider.execute(
        prInfo,
        {
          type: 'command',
          checkName: roleCheck,
          exec: `printf '%s' '${embedded}'`,
          schema: raw.steps[roleCheck].schema,
          transform_js: raw.steps[roleCheck].transform_js,
        },
        undefined
      );

      expect((roleResult as any).output).toBe(embedded);
      expect((roleResult as any).output).toContain('ROLE PREFIX before JSON');
      expect((roleResult as any).output).toContain('{"caller-module":"error-handling-pattern"}');
      expect((roleResult as any).output).toContain('ROLE SUFFIX after JSON');

      const renderedPrompt = await (aiProvider as any).renderPromptTemplate(
        `Role handoff:\n{{ outputs["${roleCheck}"] }}`,
        prInfo,
        undefined,
        new Map([[roleCheck, roleResult]])
      );
      expect(renderedPrompt).toContain(`Role handoff:\n${embedded}`);
    }
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

  it('reports retained native artifacts when execution exits zero without final evidence', async () => {
    const fixture = gitFixture('native-onboarding-artifacts-');
    const output = join(fixture.root, '..', 'run-output');
    const fakeVisor = join(fixture.root, '..', 'fake-visor-artifacts.sh');
    writeFileSync(
      fakeVisor,
      [
        '#!/bin/sh',
        'mkdir -p "$SUBJECT_ROOT/specs/system"',
        'printf \'[]\\n\' >"$NATIVE_ONBOARDING_OUTPUT_DIR/requirements-baseline.json"',
        'printf \'native requirement\\n\' >"$SUBJECT_ROOT/specs/system/REQ-001.req.yaml"',
        "printf 'partial success\\n'",
        "printf 'partial diagnostic\\n' >&2",
        'exit 0',
      ].join('\n'),
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
    expect(result.report.exit_code).toBe(0);
    expect(result.report.execution_status).toBe('execution-succeeded');
    expect(result.report.terminal_status).toBe('failed-execution-with-artifacts');
    expect(result.report.materialized.native_requirement_count).toBe(1);
    expect(result.report.materialized.native_requirement_delta_after_init).toBeNull();
    expect(result.report.materialized.native_requirement_delta_status).toBe('unknown');
    expect(result.report.materialized.native_requirement_delta_reason).toContain(
      'requirements-final.json is missing'
    );
    expect(readFileSync(join(output, 'visor.stdout.log'), 'utf8')).toContain('partial success');
    expect(readFileSync(join(output, 'visor.stderr.log'), 'utf8')).toContain('partial diagnostic');
    expect(existsSync(join(output, 'native', 'specs', 'system', 'REQ-001.req.yaml'))).toBe(true);
    const launch = JSON.parse(readFileSync(join(output, 'launch.json'), 'utf8'));
    expect(launch.environment.debug_ai_sessions).toBe(true);
  });

  it('does not claim completion from inventory delta when no native files exist', async () => {
    const fixture = gitFixture('native-onboarding-inventory-only-');
    const output = join(fixture.root, '..', 'run-output');
    const fakeVisor = join(fixture.root, '..', 'fake-visor-inventory-only.sh');
    writeFileSync(
      fakeVisor,
      [
        '#!/bin/sh',
        'printf \'[]\\n\' >"$NATIVE_ONBOARDING_OUTPUT_DIR/requirements-baseline.json"',
        'printf \'[{"id":"REQ-001"}]\\n\' >"$NATIVE_ONBOARDING_OUTPUT_DIR/requirements-final.json"',
        'printf final-evidence-complete >"$NATIVE_ONBOARDING_OUTPUT_DIR/final-evidence-complete"',
        'exit 0',
      ].join('\n'),
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
    expect(result.report.exit_code).toBe(0);
    expect(result.report.execution_status).toBe('execution-succeeded');
    expect(result.report.materialized.native_requirement_count).toBe(0);
    expect(result.report.materialized.native_requirement_delta_after_init).toBe(1);
    expect(result.report.materialized.native_requirement_delta_status).toBe('computed');
    expect(result.report.terminal_status).toBe('failed-empty-native-requirements');
  });

  it('bundles only the approved native artifacts and preserves source annotation diff', async () => {
    const fixture = gitFixture('native-onboarding-bundle-');
    const output = join(fixture.root, '..', 'run-output');
    const fakeVisor = join(fixture.root, '..', 'fake-visor-bundle.sh');
    writeFileSync(join(fixture.root, 'parser.go'), 'package parser\n');
    writeFileSync(join(fixture.root, 'parser_test.go'), 'package parser\n');
    writeFileSync(join(fixture.root, '.gitignore'), '.proof/\n');
    git(fixture.root, ['add', 'parser.go', 'parser_test.go', '.gitignore']);
    git(fixture.root, ['commit', '-qm', 'parser fixture']);
    writeFileSync(
      fakeVisor,
      [
        '#!/bin/sh',
        'mkdir -p "$SUBJECT_ROOT/specs/stakeholder" "$SUBJECT_ROOT/specs/system" "$SUBJECT_ROOT/specs/software" "$SUBJECT_ROOT/specs/integration"',
        'mkdir -p "$SUBJECT_ROOT/specs/other" "$SUBJECT_ROOT/proof/checklists/nested" "$SUBJECT_ROOT/docs"',
        'printf \'req\\n\' >"$SUBJECT_ROOT/specs/system/REQ-001.req.yaml"',
        'printf \'vars\\n\' >"$SUBJECT_ROOT/specs/system/REQ-001.vars.yaml"',
        'printf \'other\\n\' >"$SUBJECT_ROOT/specs/other/ignored.req.yaml"',
        'ln -s ../system/REQ-001.req.yaml "$SUBJECT_ROOT/specs/software/linked.req.yaml"',
        'printf \'state\\n\' >"$SUBJECT_ROOT/proof/checklists/onboard_v1.state.yaml"',
        'printf \'nested\\n\' >"$SUBJECT_ROOT/proof/checklists/nested/ignored.state.yaml"',
        'printf \'scope doc\\n\' >"$SUBJECT_ROOT/docs/get-string-requirements.md"',
        'printf \'irrelevant doc\\n\' >"$SUBJECT_ROOT/docs/other.md"',
        'printf \'proof\\n\' >"$SUBJECT_ROOT/proof.yaml"',
        'printf \'// annotation\\n\' >>"$SUBJECT_ROOT/parser.go"',
        'printf \'// test annotation\\n\' >>"$SUBJECT_ROOT/parser_test.go"',
        'printf \'# annotation\\n\' >>"$SUBJECT_ROOT/.gitignore"',
        'exit 17',
      ].join('\n'),
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
    expect(result.report.materialized.copied_native_artifacts).toEqual([
      'native/docs/get-string-requirements.md',
      'native/proof.yaml',
      'native/proof/checklists/onboard_v1.state.yaml',
      'native/specs/system/REQ-001.req.yaml',
      'native/specs/system/REQ-001.vars.yaml',
    ]);
    expect(existsSync(join(output, 'native', 'specs', 'software', 'linked.req.yaml'))).toBe(false);
    expect(existsSync(join(output, 'native', 'specs', 'other', 'ignored.req.yaml'))).toBe(false);
    expect(
      existsSync(join(output, 'native', 'proof', 'checklists', 'nested', 'ignored.state.yaml'))
    ).toBe(false);
    const sourcePatch = readFileSync(join(output, 'source-annotations.patch'), 'utf8');
    expect(sourcePatch).toContain('parser.go');
    expect(sourcePatch).toContain('parser_test.go');
    expect(result.report.artifacts.source_annotations.status).toBe('captured');
  });

  it('does not follow an allowed spec root symlink outside the subject', async () => {
    const fixture = gitFixture('native-onboarding-symlink-root-');
    const output = join(fixture.root, '..', 'run-output');
    const fakeVisor = join(fixture.root, '..', 'fake-visor-symlink-root.sh');
    const outside = join(fixture.root, '..', 'outside-native');
    mkdirSync(join(fixture.root, 'specs'), { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, 'secret.req.yaml'), 'outside native data\n');
    symlinkSync(outside, join(fixture.root, 'specs', 'system'));
    writeFileSync(fakeVisor, '#!/bin/sh\nprintf symlink-check\nexit 0\n', { mode: 0o700 });
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
    expect(result.report.materialized.copied_native_artifacts).toEqual([]);
    expect(result.report.materialized.native_requirement_count).toBe(0);
    expect(existsSync(join(output, 'native', 'specs', 'system', 'secret.req.yaml'))).toBe(false);
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
