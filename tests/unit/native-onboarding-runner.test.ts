import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync, spawnSync} from 'node:child_process';
import yaml from 'js-yaml';
import {
  assertPrivateCodexHome,
  assertCanonicalOwnedPathsUnchanged,
  assertCurrentProofRequirementHash,
  assertRecoveryRoots,
  commitInitializedProofBaseline,
  collectNativeComponentOpenChecks,
  configurePublicPromptCapture,
  inventoryAuthorDraft,
  loadRetainedOnboardingConfig,
  parseRecoveryArguments,
  readRecoveryReviewPackets,
  serializeRoleInvocation,
  stageRecoveryReviewPackets,
  summarizeNativePostflight,
} from '../../examples/agent-governance/native-onboarding/run-onboarding';

function recoveryReviewPacketFixture(root: string): {
  checkpointRoot: string;
  component: string;
  componentScope: any[];
  item: any;
  packet: any;
  projection: any;
  catalog: any;
  workItem: any;
  plan: any;
  packetPath: string;
} {
  const component = 'component-a';
  const itemId = 'SYS-REQ-001';
  const token = (value: string) => Buffer.from(value, 'utf8').toString('base64url');
  const checkpointRoot = path.join(root, 'retained-checkpoint');
  const componentDir = path.join(checkpointRoot, 'review-packets', token(component));
  fs.mkdirSync(componentDir, {recursive: true});
  const workItem = {
    component_id: component,
    baseline_commit: 'a'.repeat(40),
    project_id: 'project-a',
    sorted_owned_paths: ['src/component-a.go'],
  };
  const proofSnapshot = {
    catalog_entry: {id: itemId, component, priority_level: 'high'},
    req_show: {requirement: {id: itemId, component}},
    spec_graph: {id: itemId, edges: []},
  };
  const item = {
    id: itemId,
    component_id: component,
    file_path: 'specs/system/requirements/SYS-REQ-001.req.yaml',
    proof_file_hash: 'sha256:' + '1'.repeat(64),
    spec_review_role: 'spec-review-role',
    proof_snapshot: proofSnapshot,
    prepared_work_item: workItem,
  };
  const packet = {
    id: item.id,
    component_id: component,
    file_path: item.file_path,
    proof_file_hash: item.proof_file_hash,
    candidate: {decision: 'needs_changes'},
    catalog_entry: proofSnapshot.catalog_entry,
    req_show: proofSnapshot.req_show,
    spec_graph: proofSnapshot.spec_graph,
    prepared_work_item: workItem,
    freshness: 'pending_component_fan_in',
  };
  const componentScope = [{
    kind: 'keyed',
    key: component,
    expansionOwnerCheck: '["discover-project","materialize_catalog"]',
    subgraphInstanceId: 'c'.repeat(64),
  }];
  const packetScope = [...componentScope, {
    kind: 'keyed',
    key: item.id,
    expansionOwnerCheck: '["onboard-component","enumerate-native-requirements"]',
    subgraphInstanceId: 'd'.repeat(64),
  }];
  const claimId = 'e'.repeat(64);
  const projection = {
    claimsById: {
      [claimId]: {
        claimId,
        active: true,
        claim: 'native.review.packet@1',
        producerCheckId: 'collect-proof-evidence',
        scope: packetScope,
        payload: packet,
      },
    },
  };
  const catalog = {component_id: component, items: [item]};
  const plan = {
    validatorsByClaim: {
      'native.requirement.item@1': () => undefined,
      'native.review.packet@1': () => undefined,
    },
  };
  const packetPath = path.join(componentDir, token(item.id) + '.json');
  fs.writeFileSync(packetPath, JSON.stringify(packet, null, 2) + '\n', 'utf8');
  return {checkpointRoot, component, componentScope, item, packet, projection, catalog, workItem, plan, packetPath};
}

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

  it('merges active component gaps without hiding hard native failures or escalating audit/checklist gaps', () => {
    const projection = {
      claimsById: {
        active: {
          active: true,
          claim: 'native.component.summary@1',
          scope: [{kind: 'keyed', key: 'component-a'}],
          payload: {
            component_id: 'component-a',
            open_native_checks: [
              {name: 'checklist', exit_code: 4},
              {name: 'audit', exit_code: 3},
              {name: 'status', exit_code: 6},
              {name: 'validate', exit_code: 5},
            ],
          },
        },
        inactive: {
          active: false,
          claim: 'native.component.summary@1',
          scope: [{kind: 'keyed', key: 'component-old'}],
          payload: {component_id: 'component-old', open_native_checks: [{name: 'audit', exit_code: 9}]},
        },
      },
    };

    expect(collectNativeComponentOpenChecks(projection)).toEqual([
      {component_id: 'component-a', name: 'audit', exit_code: 3},
      {component_id: 'component-a', name: 'checklist', exit_code: 4},
      {component_id: 'component-a', name: 'status', exit_code: 6},
      {component_id: 'component-a', name: 'validate', exit_code: 5},
    ]);
    const summary = summarizeNativePostflight({
      requirements: {exit_code: 0},
      validation: {exit_code: 2},
      audit: {exit_code: 0},
      checklist: {exit_code: 0},
      status: {exit_code: 0},
    }, projection);
    expect(summary.open_native_checks).toEqual([
      {name: 'validation', exit_code: 2},
      {component_id: 'component-a', name: 'audit', exit_code: 3},
      {component_id: 'component-a', name: 'checklist', exit_code: 4},
      {component_id: 'component-a', name: 'status', exit_code: 6},
      {component_id: 'component-a', name: 'validate', exit_code: 5},
    ]);
    expect(summary.hard_failures).toEqual(['validation', 'component-a:status', 'component-a:validate']);
  });

  it('captures same-step prompts in distinct public files and disables inherited private history', () => {
    const aiDirectory = path.join(root, 'output', 'ai');
    const ambientDirectory = path.join(root, 'ambient-private-debug');
    const previousSessions = process.env.VISOR_DEBUG_AI_SESSIONS;
    const previousArtifacts = process.env.VISOR_DEBUG_ARTIFACTS;
    const prompt = 'public native onboarding prompt ✓';
    const info = {step: 'component/review', provider: 'codex', prompt};
    try {
      process.env.VISOR_DEBUG_AI_SESSIONS = 'true';
      process.env.VISOR_DEBUG_ARTIFACTS = ambientDirectory;
      const capture = configurePublicPromptCapture(aiDirectory);

      capture(info);
      capture(info);

      expect(process.env.VISOR_DEBUG_AI_SESSIONS).toBe('false');
      expect(process.env.VISOR_DEBUG_ARTIFACTS).toBe(aiDirectory);
      expect(fs.existsSync(ambientDirectory)).toBe(false);
      expect(fs.statSync(aiDirectory).mode & 0o777).toBe(0o700);

      const files = fs.readdirSync(aiDirectory);
      expect(files).toHaveLength(2);
      expect(new Set(files).size).toBe(2);
      expect(files[0]).toMatch(/^\d{8}-component_review-[0-9a-f]{64}\.json$/);
      expect(files[1]).toMatch(/^\d{8}-component_review-[0-9a-f]{64}\.json$/);
      const digest = createHash('sha256').update(prompt, 'utf8').digest('hex');
      for (const file of files) {
        const absolute = path.join(aiDirectory, file);
        expect(fs.statSync(absolute).mode & 0o777).toBe(0o600);
        const record = JSON.parse(fs.readFileSync(absolute, 'utf8'));
        expect(Object.keys(record).sort()).toEqual([
          'mode', 'prompt', 'promptBytes', 'promptDigest', 'provider', 'step',
        ]);
        expect(record).toEqual({
          mode: 'public-prompt-capture/v1',
          step: info.step,
          provider: info.provider,
          prompt,
          promptBytes: Buffer.byteLength(prompt, 'utf8'),
          promptDigest: `sha256:${digest}`,
        });
      }

      const currentCounter = Math.max(...files.map(file => Number(file.slice(0, 8))));
      const collision = path.join(
        aiDirectory,
        `${String(currentCounter + 1).padStart(8, '0')}-component_review-${digest}.json`,
      );
      fs.writeFileSync(collision, 'retained collision\n', {encoding: 'utf8', flag: 'wx', mode: 0o600});
      capture(info);
      const afterCollision = fs.readdirSync(aiDirectory);
      expect(afterCollision).toHaveLength(4);
      expect(fs.readFileSync(collision, 'utf8')).toBe('retained collision\n');
      expect(afterCollision).toContain(
        `${String(currentCounter + 2).padStart(8, '0')}-component_review-${digest}.json`,
      );
    } finally {
      if (previousSessions === undefined) delete process.env.VISOR_DEBUG_AI_SESSIONS;
      else process.env.VISOR_DEBUG_AI_SESSIONS = previousSessions;
      if (previousArtifacts === undefined) delete process.env.VISOR_DEBUG_ARTIFACTS;
      else process.env.VISOR_DEBUG_ARTIFACTS = previousArtifacts;
    }
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

  it('requires a complete sorted explicit recovery selection', () => {
    expect(parseRecoveryArguments({})).toBeUndefined();
    expect(() => parseRecoveryArguments({
      'recover-checkpoint': '/tmp/checkpoint.json',
    })).toThrow(/supplied together/);
    expect(() => parseRecoveryArguments({
      'recover-checkpoint': '/tmp/checkpoint.json',
      'prior-output': '/tmp/prior',
      'retry-generations': 'b'.repeat(64) + ',' + 'a'.repeat(64),
    })).toThrow(/sorted and unique/);
    expect(parseRecoveryArguments({
      'recover-checkpoint': '/tmp/checkpoint.json',
      'prior-output': '/tmp/prior',
      'retry-generations': 'a'.repeat(64) + ',' + 'b'.repeat(64),
    })).toEqual({
      checkpoint: '/tmp/checkpoint.json',
      priorOutput: '/tmp/prior',
      retryGenerationIds: ['a'.repeat(64), 'b'.repeat(64)],
    });
  });

  it('allows an initialized recovery subject but keeps checkpoint and output roots bounded', () => {
    const subject = path.join(root, 'recovery-subject');
    const original = path.join(root, 'recovery-original');
    const prior = path.join(root, 'recovery-prior');
    fs.mkdirSync(subject);
    fs.mkdirSync(original);
    fs.mkdirSync(path.join(prior, 'worktrees'), {recursive: true});
    execFileSync('git', ['init', '--quiet', subject]);
    execFileSync('git', ['init', '--quiet', original]);
    execFileSync('git', ['-C', subject, 'config', 'user.name', 'fixture']);
    execFileSync('git', ['-C', subject, 'config', 'user.email', 'fixture@example.invalid']);
    fs.writeFileSync(path.join(subject, 'proof.yaml'), 'project:\n  name: initialized\n', 'utf8');
    execFileSync('git', ['-C', subject, 'add', 'proof.yaml']);
    execFileSync('git', ['-C', subject, 'commit', '--quiet', '-m', 'initialized recovery fixture']);
    const checkpoint = path.join(prior, 'checkpoint.json');
    fs.writeFileSync(checkpoint, '{}\n', 'utf8');

    const roots = assertRecoveryRoots(subject, original, path.join(root, 'recovery-output'), prior, checkpoint);
    expect(roots.subject).toBe(fs.realpathSync(subject));
    expect(roots.priorOutput).toBe(fs.realpathSync(prior));
    expect(fs.existsSync(roots.output)).toBe(true);
    expect(() => assertRecoveryRoots(subject, original, path.join(prior, 'nested-output'), prior, checkpoint))
      .toThrow(/outside subject, protected original, and prior output/);
  });

  it('inventories only retained author drafts and permits unrelated canonical sibling progress', () => {
    const subject = path.join(root, 'draft-subject');
    const worker = path.join(root, 'draft-worktree');
    fs.mkdirSync(subject, {recursive: true});
    execFileSync('git', ['init', '--quiet', subject]);
    execFileSync('git', ['-C', subject, 'config', 'user.name', 'fixture']);
    execFileSync('git', ['-C', subject, 'config', 'user.email', 'fixture@example.invalid']);
    fs.writeFileSync(path.join(subject, 'owned.go'), 'package fixture\n\nconst Owned = 1\n', 'utf8');
    fs.writeFileSync(path.join(subject, 'sibling.go'), 'package fixture\n\nconst Sibling = 1\n', 'utf8');
    const baselineRequirement = path.join(subject, 'specs', 'system', 'requirements', 'SYS-REQ-A.req.yaml');
    fs.mkdirSync(path.dirname(baselineRequirement), {recursive: true});
    fs.writeFileSync(baselineRequirement, 'id: SYS-REQ-A\ncomponent: component-a\ndescription: existing\n', 'utf8');
    execFileSync('git', ['-C', subject, 'add', '--all']);
    execFileSync('git', ['-C', subject, 'commit', '--quiet', '-m', 'draft baseline']);
    const baseline = execFileSync('git', ['-C', subject, 'rev-parse', 'HEAD'], {encoding: 'utf8'}).trim();
    execFileSync('git', ['-C', subject, 'worktree', 'add', '--quiet', '--detach', worker, baseline]);

    fs.writeFileSync(path.join(worker, 'owned.go'), 'package fixture\n\nconst Owned = 2\n', 'utf8');
    const requirement = path.join(worker, 'specs', 'system', 'requirements', 'SYS-REQ-DRAFT.req.yaml');
    const variable = path.join(worker, 'specs', 'system', 'variables', 'DRAFT.vars.yaml');
    fs.mkdirSync(path.dirname(requirement), {recursive: true});
    fs.mkdirSync(path.dirname(variable), {recursive: true});
    fs.writeFileSync(requirement, 'id: SYS-REQ-DRAFT\ncomponent: component-a\ndescription: draft\n', 'utf8');
    fs.writeFileSync(variable, 'id: DRAFT\ncomponent: component-a\nvalue: 1\n', 'utf8');

    // An accepted sibling commit may advance the canonical subject without
    // changing the selected WorkItem's source or native paths.
    fs.writeFileSync(path.join(subject, 'sibling.go'), 'package fixture\n\nconst Sibling = 2\n', 'utf8');
    execFileSync('git', ['-C', subject, 'add', 'sibling.go']);
    execFileSync('git', ['-C', subject, 'commit', '--quiet', '-m', 'accepted sibling']);

    const inventory = inventoryAuthorDraft(worker, baseline, 'component-a', ['owned.go']);
    expect(inventory.files.map(file => file.path)).toEqual([
      'owned.go',
      'specs/system/requirements/SYS-REQ-DRAFT.req.yaml',
      'specs/system/variables/DRAFT.vars.yaml',
    ]);
    expect(inventory.files.every(file => file.sha256?.startsWith('sha256:'))).toBe(true);
    expect(() => assertCanonicalOwnedPathsUnchanged(subject, baseline, ['owned.go'])).not.toThrow();

    // A sibling cannot silently take over a retained native path.
    const canonicalRequirement = path.join(subject, 'specs/system/requirements/SYS-REQ-DRAFT.req.yaml');
    fs.mkdirSync(path.dirname(canonicalRequirement), {recursive: true});
    fs.copyFileSync(requirement, canonicalRequirement);
    expect(() => assertCanonicalOwnedPathsUnchanged(subject, baseline, [
      'specs/system/requirements/SYS-REQ-DRAFT.req.yaml',
    ])).toThrow(/changed WorkItem-owned paths/);
    fs.unlinkSync(canonicalRequirement);

    // A pre-existing native path cannot be relabeled by the replayed author.
    const relabeledRequirement = path.join(worker, 'specs/system/requirements/SYS-REQ-A.req.yaml');
    fs.writeFileSync(relabeledRequirement, 'id: SYS-REQ-A\ncomponent: component-b\ndescription: stolen\n', 'utf8');
    expect(() => inventoryAuthorDraft(worker, baseline, 'component-a', ['owned.go']))
      .toThrow(/outside WorkItem ownership: specs\/system\/requirements\/SYS-REQ-A\.req\.yaml/);
    fs.writeFileSync(relabeledRequirement, 'id: SYS-REQ-A\ncomponent: component-a\ndescription: existing\n', 'utf8');

    // An arbitrary dirty path in the retained author checkout is rejected.
    fs.writeFileSync(path.join(worker, 'unowned.txt'), 'not part of the WorkItem\n', 'utf8');
    expect(() => inventoryAuthorDraft(worker, baseline, 'component-a', ['owned.go']))
      .toThrow(/outside WorkItem ownership: unowned.txt/);
    fs.unlinkSync(path.join(worker, 'unowned.txt'));

    // A direct edit of an owned canonical path is also a pre-replay conflict.
    fs.writeFileSync(path.join(subject, 'owned.go'), 'package fixture\n\nconst Owned = 3\n', 'utf8');
    expect(() => assertCanonicalOwnedPathsUnchanged(subject, baseline, ['owned.go']))
      .toThrow(/changed WorkItem-owned paths: owned.go/);
    fs.writeFileSync(path.join(subject, 'owned.go'), 'package fixture\n\nconst Owned = 1\n', 'utf8');
    execFileSync('git', ['-C', subject, 'worktree', 'remove', '--force', worker]);
  });

  it('allows a chained checkpoint by its explicit disjoint checkpoint root', () => {
    const subject = path.join(root, 'chained-subject');
    const original = path.join(root, 'chained-original');
    const prior = path.join(root, 'chained-prior');
    const newer = path.join(root, 'chained-recovery-output');
    fs.mkdirSync(subject, {recursive: true});
    fs.mkdirSync(original, {recursive: true});
    fs.mkdirSync(path.join(prior, 'worktrees'), {recursive: true});
    fs.mkdirSync(newer, {recursive: true});
    execFileSync('git', ['init', '--quiet', subject]);
    execFileSync('git', ['init', '--quiet', original]);
    execFileSync('git', ['-C', subject, 'config', 'user.name', 'fixture']);
    execFileSync('git', ['-C', subject, 'config', 'user.email', 'fixture@example.invalid']);
    fs.writeFileSync(path.join(subject, 'proof.yaml'), 'project:\n  name: chained\n', 'utf8');
    execFileSync('git', ['-C', subject, 'add', 'proof.yaml']);
    execFileSync('git', ['-C', subject, 'commit', '--quiet', '-m', 'chained baseline']);
    const checkpoint = path.join(newer, 'checkpoint.json');
    fs.writeFileSync(checkpoint, '{}\n', 'utf8');

    const roots = assertRecoveryRoots(subject, original, path.join(root, 'chained-output'), prior, checkpoint);
    expect(roots.checkpoint).toBe(fs.realpathSync(checkpoint));
  });

  it('binds recovery config to retained inventory and role authority without Proof dispatch', async () => {
    const prior = path.join(root, 'retained-authority');
    const output = path.join(root, 'retained-authority-output');
    const commandRoot = path.join(prior, 'commands', 'preflight');
    const preflightRoot = path.join(prior, 'preflight');
    fs.mkdirSync(commandRoot, {recursive: true});
    fs.mkdirSync(preflightRoot, {recursive: true});
    fs.mkdirSync(output, {recursive: true});
    const shipped = yaml.load(fs.readFileSync(
      path.resolve(__dirname, '../../examples/agent-governance/native-onboarding/visor-onboarding.yaml'), 'utf8',
    )) as any;
    const resultSchema = shipped.subgraphs['discover-project'].checks.inspect.result_schema as string;
    const outputSchema = Buffer.from(resultSchema, 'utf8').toString('base64');
    const inventory = {
      version: 'proof.structural-inventory/v1',
      authority: {
        version: 'proof.project-authority/v1',
        project_id: 'retained-project',
        subject_fingerprint: `sha256:${'a'.repeat(64)}`,
      },
      sorted_paths: [],
    };
    const resolved = {
      version: 'proof.role-invocation/v1',
      role_id: 'onboard',
      role_source: 'builtin',
      stance: 'owner',
      subject: {kind: 'project', id: 'retained-project', fingerprint: `sha256:${'a'.repeat(64)}`},
      authority: 'read-only',
      output_schema_id: 'proof.component-catalog-candidate@1',
      output_schema: outputSchema,
      instructions: 'retained role instructions',
      invocation_digest: `sha256:${'b'.repeat(64)}`,
    };
    fs.writeFileSync(path.join(preflightRoot, 'inventory.json'), JSON.stringify(inventory), 'utf8');
    fs.writeFileSync(path.join(commandRoot, 'resolve-role-invocation.stdout'), JSON.stringify(resolved), 'utf8');
    fs.writeFileSync(path.join(commandRoot, 'resolve-role-invocation.stderr'), '', 'utf8');
    fs.writeFileSync(path.join(commandRoot, 'resolve-role-invocation.meta.json'), JSON.stringify({
      cwd: prior,
      started_at: '2026-09-07T00:00:00.000Z',
      finished_at: '2026-09-07T00:00:00.001Z',
      args: ['resolve-role-invocation'],
      status: 0,
      timed_out: false,
    }), 'utf8');

    const retained = await loadRetainedOnboardingConfig(prior, output);
    const inspect = retained.config.subgraphs['discover-project'].checks.inspect as any;
    expect(inspect.instructions).toBe('retained role instructions');
    expect(inspect.invocation.subject.id).toBe('retained-project');
    expect(fs.existsSync(path.join(output, 'recovery', 'config-authority', 'manifest.json'))).toBe(true);
    expect(JSON.parse(fs.readFileSync(
      path.join(output, 'recovery', 'config-authority', 'manifest.json'), 'utf8',
    )).files).toHaveLength(4);

    fs.writeFileSync(path.join(commandRoot, 'resolve-role-invocation.meta.json'), JSON.stringify({
      args: ['resolve-role-invocation'], status: 1, timed_out: false,
    }), 'utf8');
    await expect(loadRetainedOnboardingConfig(prior, path.join(root, 'rejected-authority-output')))
      .rejects.toThrow(/successful exact command/);
  });

  it('rejects an invalid checkpoint before Proof init or any command dispatch', () => {
    const subject = path.join(root, 'recovery-cli-subject');
    const original = path.join(root, 'recovery-cli-original');
    const prior = path.join(root, 'recovery-cli-prior');
    const output = path.join(root, 'recovery-cli-output');
    const home = path.join(root, 'recovery-cli-home');
    const proof = path.join(root, 'recovery-cli-proof');
    const marker = path.join(root, 'proof-invoked');
    for (const directory of [subject, original, home, path.join(prior, 'worktrees')]) fs.mkdirSync(directory, {recursive: true});
    execFileSync('git', ['init', '--quiet', subject]);
    execFileSync('git', ['init', '--quiet', original]);
    execFileSync('git', ['-C', subject, 'config', 'user.name', 'fixture']);
    execFileSync('git', ['-C', subject, 'config', 'user.email', 'fixture@example.invalid']);
    fs.writeFileSync(path.join(subject, 'proof.yaml'), 'project:\n  name: already-initialized\n', 'utf8');
    execFileSync('git', ['-C', subject, 'add', 'proof.yaml']);
    execFileSync('git', ['-C', subject, 'commit', '--quiet', '-m', 'initialized recovery CLI fixture']);
    fs.writeFileSync(path.join(prior, 'checkpoint.json'), '{}\n', 'utf8');
    fs.writeFileSync(path.join(home, 'config.toml'), 'model = "gpt-5.6-luna"\n', 'utf8');
    fs.writeFileSync(proof, `#!/bin/sh\nprintf invoked > ${marker}\n`, 'utf8');
    fs.chmodSync(proof, 0o755);
    const subjectProof = fs.readFileSync(path.join(subject, 'proof.yaml'), 'utf8');
    const runner = path.resolve(__dirname, '../../examples/agent-governance/native-onboarding/run-onboarding.ts');
    const env = {...process.env, CODEX_HOME: home, REQUEST_TIMEOUT: '1000', TS_NODE_TRANSPILE_ONLY: '1'};
    delete env.USE_CLAUDE_CODE;
    delete env.ANTHROPIC_API_KEY;
    delete env.OPENAI_API_KEY;
    delete env.OPENAI_BASE_URL;
    const result = spawnSync(process.execPath, ['-r', 'ts-node/register/transpile-only', runner,
      '--recover-checkpoint', path.join(prior, 'checkpoint.json'), '--prior-output', prior,
      '--retry-generations', 'a'.repeat(64), '--external-side-effects', 'absent',
      '--subject-root', subject, '--original-root', original, '--proof-bin', proof,
      '--output', output, '--timeout', '2000'], {encoding: 'utf8', env});
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Checkpoint/);
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.existsSync(path.join(output, 'commands'))).toBe(false);
    expect(fs.readFileSync(path.join(subject, 'proof.yaml'), 'utf8')).toBe(subjectProof);
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

  it('matches retained native review packets to claims and stages exact bytes', () => {
    const fixture = recoveryReviewPacketFixture(path.join(root, 'packet-positive'));
    const packets = readRecoveryReviewPackets(
      fixture.checkpointRoot,
      fixture.componentScope,
      fixture.component,
      fixture.workItem,
      fixture.catalog,
      fixture.projection,
      fixture.plan,
    );
    expect(packets).toHaveLength(1);
    expect(packets[0].id).toBe(fixture.item.id);
    expect(packets[0].claimId).toBe('e'.repeat(64));
    expect(packets[0].bytes).toEqual(Buffer.from(JSON.stringify(fixture.packet, null, 2) + '\n'));

    const output = path.join(root, 'packet-output');
    fs.mkdirSync(output, {recursive: true});
    const manifest = stageRecoveryReviewPackets(output, packets);
    const destination = path.join(output, 'review-packets', Buffer.from(fixture.component).toString('base64url'), `${Buffer.from(fixture.item.id).toString('base64url')}.json`);
    expect(fs.readFileSync(destination)).toEqual(packets[0].bytes);
    expect(fs.statSync(destination).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(destination)).mode & 0o777).toBe(0o700);
    expect(manifest.packets).toEqual([expect.objectContaining({
      component_id: fixture.component,
      id: fixture.item.id,
      claim_id: 'e'.repeat(64),
      destination: path.relative(output, destination),
      source_sha256: packets[0].sha256,
      destination_sha256: packets[0].sha256,
    })]);
    expect(() => stageRecoveryReviewPackets(output, packets)).toThrow(/EEXIST/);
  });

  it('requires the selected native review item to match the current Proof file hash and binding', () => {
    const fixture = recoveryReviewPacketFixture(path.join(root, 'current-proof-hash'));
    const current = [{
      id: fixture.item.id,
      componentId: fixture.component,
      filePath: fixture.item.file_path,
      proofFileHash: fixture.item.proof_file_hash,
    }];
    expect(() => assertCurrentProofRequirementHash(fixture.item, current)).not.toThrow();
    expect(() => assertCurrentProofRequirementHash(fixture.item, [{
      ...current[0],
      proofFileHash: 'sha256:' + '2'.repeat(64),
    }])).toThrow(/stale current Proof hash/);
    expect(() => assertCurrentProofRequirementHash(fixture.item, [{
      ...current[0],
      componentId: 'other-component',
    }])).toThrow(/stale current Proof hash/);
    expect(() => assertCurrentProofRequirementHash(fixture.item, [current[0], current[0]])).toThrow(/stale current Proof hash/);
  });

  it('rejects aggregate, extra, tampered, and cross-scope retained packets', () => {
    const aggregateFixture = recoveryReviewPacketFixture(path.join(root, 'packet-aggregate'));
    const aggregatePath = path.join(
      aggregateFixture.checkpointRoot,
      'review-packets',
      Buffer.from(aggregateFixture.component).toString('base64url') + '.json',
    );
    fs.writeFileSync(aggregatePath, '{}\n', 'utf8');
    expect(() => readRecoveryReviewPackets(
      aggregateFixture.checkpointRoot,
      aggregateFixture.componentScope,
      aggregateFixture.component,
      aggregateFixture.workItem,
      aggregateFixture.catalog,
      aggregateFixture.projection,
      aggregateFixture.plan,
    )).toThrow(/component aggregate/);

    const extraFixture = recoveryReviewPacketFixture(path.join(root, 'packet-extra'));
    fs.writeFileSync(path.join(path.dirname(extraFixture.packetPath), 'unexpected.json'), '{}\n', 'utf8');
    expect(() => readRecoveryReviewPackets(
      extraFixture.checkpointRoot,
      extraFixture.componentScope,
      extraFixture.component,
      extraFixture.workItem,
      extraFixture.catalog,
      extraFixture.projection,
      extraFixture.plan,
    )).toThrow(/packet set does not exactly match/);

    const duplicateFixture = recoveryReviewPacketFixture(path.join(root, 'packet-duplicate'));
    duplicateFixture.catalog.items.push({...duplicateFixture.item});
    expect(() => readRecoveryReviewPackets(
      duplicateFixture.checkpointRoot,
      duplicateFixture.componentScope,
      duplicateFixture.component,
      duplicateFixture.workItem,
      duplicateFixture.catalog,
      duplicateFixture.projection,
      duplicateFixture.plan,
    )).toThrow(/duplicate or invalid item IDs/);

    const tamperedFixture = recoveryReviewPacketFixture(path.join(root, 'packet-tampered'));
    fs.writeFileSync(tamperedFixture.packetPath, JSON.stringify({...tamperedFixture.packet, candidate: {decision: 'tampered'}}) + '\n', 'utf8');
    expect(() => readRecoveryReviewPackets(
      tamperedFixture.checkpointRoot,
      tamperedFixture.componentScope,
      tamperedFixture.component,
      tamperedFixture.workItem,
      tamperedFixture.catalog,
      tamperedFixture.projection,
      tamperedFixture.plan,
    )).toThrow(/does not match its checkpoint claim/);

    const scopeFixture = recoveryReviewPacketFixture(path.join(root, 'packet-scope'));
    scopeFixture.projection.claimsById['e'.repeat(64)].scope = scopeFixture.componentScope;
    expect(() => readRecoveryReviewPackets(
      scopeFixture.checkpointRoot,
      scopeFixture.componentScope,
      scopeFixture.component,
      scopeFixture.workItem,
      scopeFixture.catalog,
      scopeFixture.projection,
      scopeFixture.plan,
    )).toThrow(/scope/);
  });
});
