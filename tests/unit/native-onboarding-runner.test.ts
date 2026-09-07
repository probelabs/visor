import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync, spawnSync} from 'node:child_process';
import yaml from 'js-yaml';
import {
  assertPrivateCodexHome,
  commitInitializedProofBaseline,
  serializeRoleInvocation,
  summarizeNativePostflight,
} from '../../examples/agent-governance/native-onboarding/run-onboarding';

describe('native onboarding runner boundaries', () => {
  let root: string;
  let previousCodexHome: string | undefined;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-native-onboarding-runner-'));
    previousCodexHome = process.env.CODEX_HOME;
  });

  afterEach(() => {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    fs.rmSync(root, {recursive: true, force: true});
  });

  it('accepts a private minimal Codex home and rejects configured MCP before dispatch', () => {
    const subject = path.join(root, 'subject');
    const original = path.join(root, 'original');
    const home = path.join(root, 'codex-home');
    fs.mkdirSync(subject);
    fs.mkdirSync(original);
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, 'config.toml'), 'model = "gpt-5.6-luna"\n', 'utf8');
    process.env.CODEX_HOME = home;

    expect(assertPrivateCodexHome(subject, original, path.join(root, 'output'))).toEqual({
      home: fs.realpathSync(home),
      configPresent: true,
    });

    fs.writeFileSync(path.join(home, 'config.toml'), '[mcp_servers.proof]\ncommand = "proof"\n', 'utf8');
    expect(() => assertPrivateCodexHome(subject, original, path.join(root, 'output-2')))
      .toThrow(/must not configure MCP/);
  });

  it('records validation and status failures while keeping audit/checklist gaps visible', () => {
    expect(summarizeNativePostflight({
      requirements: {exit_code: 0},
      validation: {exit_code: 2},
      audit: {exit_code: 4},
      checklist: {exit_code: 3},
      status: {exit_code: 0},
    })).toEqual({
      hard_failures: ['validation'],
      open_native_checks: [
        {name: 'validation', exit_code: 2},
        {name: 'audit', exit_code: 4},
        {name: 'checklist', exit_code: 3},
      ],
    });

    expect(summarizeNativePostflight({
      requirements: {exit_code: 0},
      validation: {exit_code: 0},
      audit: {exit_code: 0},
      checklist: {exit_code: 0},
      status: {exit_code: 7},
    }).hard_failures).toEqual(['status']);
  });

  it('serializes the resolver request as exact one-line Go-compatible JSON', () => {
    const invocation = {
      role_id: 'onboard',
      stance: 'owner',
      subject: {kind: 'project', id: 'project-1', fingerprint: 'sha256:' + 'a'.repeat(64)},
      output_schema_id: 'proof.project-discovery/v1',
      output_schema: 'eyJ0eXBlIjoib2JqZWN0In0=',
    };
    const wire = serializeRoleInvocation(invocation);
    expect(wire).not.toMatch(/[\r\n]/);
    expect(Object.keys(JSON.parse(wire))).toEqual([
      'role_id', 'stance', 'subject', 'output_schema_id', 'output_schema',
    ]);
    expect(JSON.parse(wire)).toEqual(invocation);
  });

  it('commits initialized Proof files and makes them present in a checkout at the recorded baseline', () => {
    const subject = path.join(root, 'subject-baseline');
    const worker = path.join(root, 'worker-baseline');
    fs.mkdirSync(subject, {recursive: true});
    execFileSync('git', ['init', '--quiet', subject]);
    execFileSync('git', ['-C', subject, 'config', 'user.name', 'fixture']);
    execFileSync('git', ['-C', subject, 'config', 'user.email', 'fixture@example.invalid']);
    fs.writeFileSync(path.join(subject, 'source.txt'), 'source baseline\n', 'utf8');
    execFileSync('git', ['-C', subject, 'add', '--all', '--', '.']);
    execFileSync('git', ['-C', subject, 'commit', '--quiet', '-m', 'source fixture']);
    const sourceRevision = execFileSync('git', ['-C', subject, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();

    fs.writeFileSync(path.join(subject, 'proof.yaml'), 'project:\n  name: fixture\n', 'utf8');
    fs.mkdirSync(path.join(subject, 'specs', 'system', 'requirements'), {recursive: true});
    fs.writeFileSync(
      path.join(subject, 'specs', 'system', 'requirements', 'SYS-REQ-001.req.yaml'),
      'id: SYS-REQ-001\ncomponent: fixture\n',
      'utf8',
    );
    const baselineCommit = commitInitializedProofBaseline(subject, sourceRevision);

    expect(baselineCommit).toMatch(/^[0-9a-f]{40}$/);
    expect(baselineCommit).not.toBe(sourceRevision);
    expect(execFileSync('git', ['-C', subject, 'status', '--porcelain'], {encoding: 'utf8'})).toBe('');
    expect(execFileSync('git', ['-C', subject, 'show', `${baselineCommit}:proof.yaml`], {encoding: 'utf8'})).toContain('name: fixture');
    expect(execFileSync('git', ['-C', subject, 'show', `${baselineCommit}:specs/system/requirements/SYS-REQ-001.req.yaml`], {encoding: 'utf8'})).toContain('SYS-REQ-001');

    execFileSync('git', ['-C', subject, 'worktree', 'add', '--quiet', '--detach', worker, baselineCommit]);
    expect(fs.readFileSync(path.join(worker, 'proof.yaml'), 'utf8')).toContain('name: fixture');
    expect(fs.readFileSync(path.join(worker, 'specs/system/requirements/SYS-REQ-001.req.yaml'), 'utf8')).toContain('SYS-REQ-001');
    execFileSync('git', ['-C', subject, 'worktree', 'remove', '--force', worker]);
  });

  it('runs the CLI guard without a module-scope ReferenceError before Proof dispatch', () => {
    const subject = path.join(root, 'subject-cli');
    const original = path.join(root, 'original-cli');
    const output = path.join(root, 'output-cli');
    const proof = path.join(root, 'proof-bin');
    fs.mkdirSync(subject);
    fs.mkdirSync(original);
    execFileSync('git', ['init', '--quiet', subject]);
    execFileSync('git', ['init', '--quiet', original]);
    fs.writeFileSync(proof, '#!/bin/sh\nexit 0\n', 'utf8');
    fs.chmodSync(proof, 0o755);
    const env = {...process.env};
    delete env.REQUEST_TIMEOUT;
    const runner = path.resolve(__dirname, '../../examples/agent-governance/native-onboarding/run-onboarding.ts');
    const result = spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', runner,
      '--subject-root', subject, '--original-root', original, '--proof-bin', proof,
      '--output', output, '--timeout', '1800000'], {encoding: 'utf8', env});
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('REQUEST_TIMEOUT must be an explicit positive inner budget');
    expect(result.stderr).not.toContain('ReferenceError');
    expect(fs.existsSync(output)).toBe(true);
  });

  it('documents the Proof inventory path contract in both discovery schemas', () => {
    const file = path.resolve(__dirname, '../../examples/agent-governance/native-onboarding/visor-onboarding.yaml');
    const config = yaml.load(fs.readFileSync(file, 'utf8')) as any;
    const claimProperties = config.claim_types['proof.candidate@1'].schema.properties.components.items.properties;
    const resultSchema = JSON.parse(config.subgraphs['discover-project'].checks.inspect.result_schema);
    const resultProperties = resultSchema.properties.components.items.properties;
    for (const properties of [claimProperties, resultProperties]) {
      expect(properties.owned_paths.description).toContain('inventory.sorted_paths');
      expect(properties.owned_paths.items.description).toContain('project-relative');
      expect(properties.dependency_closure.description).toContain('every owned_paths entry');
      expect(properties.dependency_closure.items.description).toContain('never a component ID');
    }
    expect(config.subgraphs['discover-project'].checks.inspect.message).toContain('owned_paths');
    expect(config.subgraphs['discover-project'].checks.inspect.message).toContain('transitive in-repository dependency files');
  });
});
