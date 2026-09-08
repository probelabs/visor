import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import yaml from 'js-yaml';
import Ajv from 'ajv';
import {loadConfig} from '../../src/sdk';
import {compileClaimPlan} from '../../src/state-machine/graph/claim-plan';
import {createExtendedLiquid} from '../../src/liquid-extensions';
import {GitCheckoutProvider} from '../../src/providers/git-checkout-provider';
import {projectGovernedProofInspectConfig} from '../../src/providers/governed-proof-inspect-check-provider';
import {worktreeManager} from '../../src/utils/worktree-manager';
import {nativeOnboardingCountsAreConsistent} from '../../examples/agent-governance/native-onboarding/run-onboarding';

type Json = Record<string, any>;

const CONFIG_PATH = path.resolve(__dirname, '../../examples/agent-governance/native-onboarding/visor-onboarding.yaml');
const CHECKLIST_CONFIG_PATH = path.resolve(__dirname, '../../examples/agent-governance/native-onboarding/visor-checklist-onboarding.yaml');
const RUNNER_PATH = path.resolve(__dirname, '../../examples/agent-governance/native-onboarding/run-onboarding.ts');

function readConfig(): Json {
  return yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')) as Json;
}

function readChecklistConfig(): Json {
  return yaml.load(fs.readFileSync(CHECKLIST_CONFIG_PATH, 'utf8')) as Json;
}

describe('native onboarding isolated writer wiring', () => {
  it('accepts the shipped native selector with graph-owned dependencies at managed-run projection', () => {
    const config = readConfig();
    const check = config.subgraphs['onboard-component'].checks.inspect;
    expect(check.depends_on).toEqual(['native-validation']);
    expect(projectGovernedProofInspectConfig(check)).toMatchObject({
      type: 'governed-proof-inspect',
      profile: 'luna-xhigh-readonly-v1',
    });
  });

  it('keeps reviewed source provenance as a closed current-or-retained discriminator', async () => {
    const config = readConfig();
    const inspect = config.subgraphs['discover-project'].checks.inspect;
    // The runner replaces this placeholder with the Proof-resolved schema
    // before strict loading; mirror that deterministic preparation here.
    inspect.invocation.output_schema = Buffer.from(inspect.result_schema, 'utf8').toString('base64');
    const loaded = await loadConfig(config, {strict: true});
    const validate = compileClaimPlan(loaded).validatorsByClaim['native.component.reviewed@1'];
    const digest = 'sha256:' + 'a'.repeat(64);
    const review = {
      id: 'SYS-REQ-001', component_id: 'component-a', file_path: 'a.go', proof_file_hash: digest,
      candidate: {}, candidate_fingerprint: digest, packet_sha256: digest, retained_claim: null,
    };
    const base = {
      version: 'native.component.reviewed/v1', component_id: 'component-a',
      status: 'reviewed-native-requirement-items', item_count: 1, reviews: [review],
    };
    expect(() => validate({...base, source: {kind: 'current_graph', checkpoint_sha256: null, graph_semantic_digest: null, manifest_sha256: digest}})).not.toThrow();
    expect(() => validate({...base, source: {kind: 'retained_checkpoint', checkpoint_sha256: digest, graph_semantic_digest: 'b'.repeat(64), manifest_sha256: digest}})).not.toThrow();
    expect(() => validate({...base, source: {kind: 'current_graph', checkpoint_sha256: digest, graph_semantic_digest: null, manifest_sha256: digest}})).toThrow();
    expect(() => validate({...base, source: {kind: 'retained_checkpoint', checkpoint_sha256: null, graph_semantic_digest: 'b'.repeat(64), manifest_sha256: digest}})).toThrow();
    expect(() => validate({...base, source: {kind: 'retained_checkpoint', checkpoint_sha256: digest, graph_semantic_digest: 'not-a-digest', manifest_sha256: digest}})).toThrow();
  });

  it('declares the exact retained prefix and reuses only the permanent admission suffix', () => {
    const config = readConfig();
    const live = config.subgraphs['onboard-component'];
    const retained = config.subgraphs['onboard-component-retained'];
    expect(retained.input).toEqual({name: 'component', claim: 'component.work_item@1'});
    expect(Object.keys(retained.checks).sort()).toEqual([
      'component-reviewed', 'inspect', 'native-validation', 'proof_admit',
      'spec_review', 'spec_review_admit', 'verify',
    ].sort());
    expect(retained.checks['component-reviewed']).toEqual(expect.objectContaining({
      type: 'command',
      consumes: [{claim: 'component.work_item@1', as: 'component'}],
      emits: [{claim: 'native.component.reviewed@1', from: 'output'}],
    }));
    const retainedCommand = retained.checks['component-reviewed'].exec;
    expect(retainedCommand).toContain('__NATIVE_RETAINED_AGGREGATE_MAP_BASE64__');
    expect(retainedCommand).toContain("Buffer.from(encoded, 'base64')");
    expect(retainedCommand).not.toContain('NATIVE_ONBOARDING_OUTPUT_DIR');
    expect(retainedCommand).not.toContain('NATIVE_ONBOARDING_REVIEW_EXPORT');
    expect(retainedCommand).not.toContain('stdin');
    for (const nodeKey of ['native-validation', 'inspect', 'proof_admit', 'spec_review', 'spec_review_admit', 'verify']) {
      expect(retained.checks[nodeKey]).toBe(live.checks[nodeKey]);
    }
    expect(Object.keys(retained.checks)).not.toEqual(expect.arrayContaining([
      'author-native-component', 'promote-native-component', 'enumerate-native-requirements',
      'native-requirement-review', 'collect-proof-evidence',
    ]));
    for (const key of ['stdin', 'env', 'transform', 'transform_js', 'content', 'url', 'body', 'headers']) {
      (retained.checks['component-reviewed'] as any)[key] = key === 'stdin' ? '' : {};
      expect(() => compileClaimPlan(config as any)).toThrow();
      delete (retained.checks['component-reviewed'] as any)[key];
    }
  });

  it('passes strict claim-graph validation with the local checkout and promotion stages', async () => {
    const config = readConfig();
    const inspect = config.subgraphs['discover-project'].checks.inspect;
    // The runner replaces this placeholder with the Proof-resolved schema
    // before strict loading; mirror that deterministic preparation here.
    inspect.invocation.output_schema = Buffer.from(inspect.result_schema, 'utf8').toString('base64');
    const loaded = await loadConfig(config, {strict: true});
    const checks = (loaded as any).subgraphs['onboard-component'].checks;
    expect(checks['checkout-worktree'].type).toBe('git-checkout');
    expect(checks['checkout-worktree'].use_worktree).toBe(true);
    expect(checks['checkout-worktree'].persist_worktree).toBe(true);
    expect(checks['checkout-worktree'].resource_group).toBe('native-checkout-cache');
    expect(checks['author-native-component'].depends_on).toEqual(['role-onboard-component', 'checkout-worktree']);
    expect(checks['author-native-component'].resource_group).toBeUndefined();
    expect(checks['promote-native-component'].resource_group).toBe('proof-workspace-mutation');
    expect(checks['enumerate-native-requirements'].depends_on).toEqual([
      'promote-native-component',
      'role-spec-review-component',
    ]);
    expect(checks['enumerate-native-requirements'].expand).toEqual(expect.objectContaining({
      claim: 'native.requirement.catalog@1',
      template: 'native-requirement-review',
      items_pointer: '/items',
      key_pointer: '/id',
      item_claim: 'native.requirement.item@1',
    }));
    expect(checks['wait-for-native-items'].type).toBe('noop');
    expect(checks['wait-for-native-items'].consumes).toBeUndefined();
    expect(checks['wait-for-native-items'].wait_for_expansion).toEqual({
      owner: 'enumerate-native-requirements',
      terminal_node: 'collect-proof-evidence',
    });
    expect(checks['component-reviewed'].depends_on).toEqual(['wait-for-native-items']);
    expect(checks['component-reviewed'].consumes).toEqual([
      {claim: 'component.prepared_work_item@1', as: 'work_item'},
      {claim: 'native.requirement.catalog@1', as: 'catalog'},
    ]);
    expect(checks['review-native-component']).toBeUndefined();
    expect(checks['persist-review-packet']).toBeUndefined();
  });

  it('binds only the admitted WorkItem, exact checkout, and built-in role into the writer prompt', async () => {
    const checklistConfig = readChecklistConfig();
    const author = checklistConfig.subgraphs['checklist-onboard-component'].checks['author-native-component'];
    expect(author.ai).toEqual(expect.objectContaining({
      model: 'gpt-5.6-luna',
      codex_execution_profile: 'luna-xhigh-isolated-writer-v1',
      codex_working_directory_from: 'checkout-worktree',
      allowEdit: true,
      allowedTools: ['search', 'extract', 'listFiles'],
    }));
    expect(author.resource_group).toBeUndefined();
    expect(author.ai.allowBash).toBeUndefined();
    expect(author.ai.bashConfig).toBeUndefined();
    expect(author.ai_bash_config_js).toBeUndefined();
    expect(author.prompt).not.toContain('{{ outputs | json }}');
    expect(author.prompt).toContain('{{ outputs.work_item | json }}');
    expect(author.prompt).toContain('{{ outputs.checkout | json }}');
    expect(author.prompt).toContain('{{ outputs.role | json }}');
    expect(author.prompt).toContain('Native tools.apply_patch may edit only allowed');
    expect(author.prompt).toMatch(/The native exec carrier\s+may execute bounded Proof CLI commands/);
    expect(author.prompt).toMatch(/Do not use Probe MCP Bash or alternate\s+write paths\/roots/);
    expect(author.prompt).toContain('validate_passes');
    expect(author.prompt).toContain('annotation_validity');
    expect(author.prompt).toContain('levels_connected');
    expect(author.prompt).toContain('proof checklist show --format json');
    expect(author.prompt).toContain('sole checklist mutator');
    expect(author.prompt).not.toContain('process_checklist');
    expect(author.prompt).not.toMatch(/proof audit\s+--format json/);

    const liquid = createExtendedLiquid();
    const rendered = await liquid.parseAndRender(author.prompt, {
      outputs: {
        work_item: {component_id: 'component-a', sorted_owned_paths: ['a.go'], baseline_commit: 'a'.repeat(40)},
        checkout: {success: true, path: '/owned/worktrees/a', ref: 'a'.repeat(40), commit: 'a'.repeat(40), worktree_id: 'wt-a', repository: '/owned/repository', is_worktree: true},
        role: 'built-in role text',
      },
    });
    expect(rendered).toContain('component-a');
    expect(rendered).toContain('/owned/worktrees/a');
    expect(rendered).toContain('built-in role text');
    expect(rendered).not.toContain('materialize_catalog');
  });

  it('preserves the exact native WorkItem payload while adding only the runtime baseline', async () => {
    const config = readConfig();
    const checks = config.subgraphs['onboard-component'].checks;
    const prepare = checks['prepare-work-item'];
    const target = checks['checkout-target'];
    const checkout = checks['checkout-worktree'];
    const promotion = checks['promote-native-component'];
    const enumeration = checks['enumerate-native-requirements'];
    const workItem = {
      project_id: 'jsonparser',
      component_id: 'component-a',
      sorted_owned_paths: ['pkg/a.go'],
      sorted_dependency_closure: ['pkg/a.go', 'pkg/shared.go'],
      proof_path_mapping: {owned: ['pkg/a.go']},
      proof_input_state: [{input_kind: 'file', path: 'pkg/a.go', file_hash: 'sha256:' + '1'.repeat(64)}],
      proof_component_subject: {fingerprint: 'sha256:' + '2'.repeat(64)},
      authority: {work_item_digest: 'sha256:' + '3'.repeat(64)},
    };
    const liquid = createExtendedLiquid();
    const preparedExec = await liquid.parseAndRender(prepare.exec, {
      outputs: {component: workItem},
      env: {NATIVE_ONBOARDING_BASELINE_COMMIT: 'a'.repeat(40)},
    });
    const commandCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-native-onboarding-wiring-'));
    const prepared = spawnSync('sh', ['-c', preparedExec], {
      encoding: 'utf8',
      env: {...process.env, NATIVE_ONBOARDING_BASELINE_COMMIT: 'a'.repeat(40)},
      cwd: commandCwd,
    });
    fs.rmSync(commandCwd, {recursive: true, force: true});
    expect(prepared.status).toBe(0);
    expect(JSON.parse(prepared.stdout)).toEqual({...workItem, baseline_commit: 'a'.repeat(40)});

    expect(target.exec).toContain("createHash('sha256')");
    expect(target.exec).toContain('NATIVE_ONBOARDING_WORKTREE_ROOT');
    expect(target.exec).toContain('path.join(root, digest)');
    expect(checkout.repository).toBe('{{ env.VISOR_WORKSPACE_MAIN_PROJECT }}');
    expect(checkout.consumes).toEqual([{claim: 'component.checkout_target@1', as: 'target'}]);
    expect(checkout.ref).toBe('{{ outputs.target.baseline_commit }}');
    expect(checkout.working_directory).toBe('{{ outputs.target.worktree_root }}');
    expect(checkout.clean).toBe(false);

    expect(promotion.exec).toContain('promoteNativeDelta');
    expect(promotion.exec).toContain('canonicalRoot: process.env.VISOR_WORKSPACE_MAIN_PROJECT');
    expect(promotion.exec).toContain('baselineCommit: workItem.baseline_commit');
    expect(promotion.exec).toContain('writerCheckout: checkout');
    expect(promotion.exec).toContain('commitAcceptedArtifacts: true');
    expect(promotion.exec).toContain('NATIVE_ONBOARDING_TS_NODE');
    expect(enumeration.exec).toContain("promotion.status !== 'promoted'");
    expect(enumeration.exec).toContain('deps.work_item');
    expect(enumeration.exec).toContain('deps.promotion');
    expect(enumeration.exec).toContain('deps.role');
    expect(enumeration.exec).toContain('catalog_entry: row');
    expect(enumeration.exec).toContain('prepared_work_item: workItem');
  });

  it('binds one exact WorkItem and opaque Proof snapshot per generated requirement review', () => {
    const config = readConfig();
    const template = config.subgraphs['native-requirement-review'];
    const review = template.checks['review-native-item'];
    const collect = template.checks['collect-proof-evidence'];
    expect(template.input).toEqual({name: 'item', claim: 'native.requirement.item@1'});
    expect(review.ai).toEqual(expect.objectContaining({
      model: 'gpt-5.6-luna',
      codex_execution_profile: 'luna-xhigh-readonly-v1',
      allowEdit: false,
      allowBash: false,
      allowedTools: ['search', 'extract', 'listFiles'],
    }));
    expect(review.prompt).toContain('{{ outputs.item | json }}');
    expect(review.prompt).toContain('exactly one materialized');
    expect(review.prompt).toMatch(/Candidate\s+prose is evidence, not Proof state or approval/);
    expect(collect.consumes).toEqual([
      {claim: 'native.requirement.item@1', as: 'item'},
      {claim: 'native.review.candidate@1', as: 'candidate'},
    ]);
    expect(collect.exec).toContain('proof_snapshot.catalog_entry');
    expect(collect.exec).toContain('prepared_work_item: item.prepared_work_item');
    expect(collect.exec).toContain('pending_component_fan_in');
    expect(config.claim_types['native.requirement.item@1'].schema.additionalProperties).toBe(false);
    expect(config.claim_types['native.requirement.catalog@1'].schema.additionalProperties).toBe(false);
  });

  it('keeps component fan-in scoped, hash-fresh, and WorkItem-bound', () => {
    const config = readConfig();
    const fanIn = config.subgraphs['onboard-component'].checks['component-reviewed'];
    expect(fanIn.resource_group).toBe('proof-workspace-mutation');
    expect(fanIn.exec).toContain("run(['req', 'list', '--format', 'json'])");
    expect(fanIn.exec).toContain('current.length !== catalog.items.length');
    expect(fanIn.exec).toContain('component requirement hash changed');
    expect(fanIn.exec).toContain('same(packet.prepared_work_item, workItem)');
    expect(fanIn.exec).toContain('reviewed-native-requirement-items');
    expect(fanIn.exec).not.toContain('allExpectedIdentity');
    expect(fanIn.exec).not.toContain('per-requirement Graph-v2 expansion is deferred');
  });

  it('records the real GitCheckoutProvider success envelope against the closed checkout claim', async () => {
    const config = readConfig();
    const checkout = config.subgraphs['onboard-component'].checks['checkout-worktree'];
    const worktreeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-native-checkout-envelope-'));
    const previousRepository = process.env.VISOR_WORKSPACE_MAIN_PROJECT;
    process.env.VISOR_WORKSPACE_MAIN_PROJECT = process.cwd();
    const provider = new GitCheckoutProvider();
    const spy = jest.spyOn(worktreeManager, 'createWorktree').mockResolvedValue({
      id: 'fixture-worktree',
      path: worktreeRoot,
      ref: 'a'.repeat(40),
      commit: 'a'.repeat(40),
      metadata: {} as any,
      locked: false,
    } as any);
    try {
      const result = await provider.execute(
        {number: 1, title: 'checkout envelope', author: 'test', base: 'main', head: 'fixture', files: [], totalAdditions: 0, totalDeletions: 0} as any,
        {
          ...checkout,
          checkName: 'checkout-worktree',
        } as any,
        new Map([['target', {issues: [], output: {
          component_id: 'component-a',
          baseline_commit: 'a'.repeat(40),
          worktree_root: worktreeRoot,
        }} as any]]),
        {} as any,
      );
      const output = (result as any).output;
      const validate = new Ajv({allErrors: true, strict: false}).compile(config.claim_types['component.checkout@1'].schema);
      expect(validate(output)).toBe(true);
      expect(output).toEqual({
        success: true,
        path: worktreeRoot,
        ref: 'a'.repeat(40),
        commit: 'a'.repeat(40),
        worktree_id: 'fixture-worktree',
        repository: process.cwd(),
        is_worktree: true,
      });
      expect(spy).toHaveBeenCalledWith(
        process.cwd(),
        process.cwd(),
        'a'.repeat(40),
        expect.objectContaining({workingDirectory: worktreeRoot, clean: false, persistWorktree: true}),
      );
    } finally {
      spy.mockRestore();
      if (previousRepository === undefined) delete process.env.VISOR_WORKSPACE_MAIN_PROJECT;
      else process.env.VISOR_WORKSPACE_MAIN_PROJECT = previousRepository;
      fs.rmSync(worktreeRoot, {recursive: true, force: true});
    }
  });

  it('records initialized Proof baseline before exposing worktree runtime paths', () => {
    const source = fs.readFileSync(RUNNER_PATH, 'utf8');
    expect(source).toContain("NATIVE_ONBOARDING_WORKTREE_ROOT = path.join(roots.output, 'worktrees')");
    expect(source).toContain("NATIVE_ONBOARDING_TS_NODE = fs.realpathSync(require.resolve('ts-node/register/transpile-only'))");
    expect(source).toContain("baseline-checkpoint.json");
    expect(source).toContain("status: 'initialized-native-proof-baseline'");
    expect(source.indexOf("['init', '--name', 'jsonparser'"))
      .toBeLessThan(source.indexOf("baseline-checkpoint.json"));
    expect(source.indexOf("baseline-checkpoint.json"))
      .toBeLessThan(source.lastIndexOf('executeGroupedChecks'));
  });

  it('requires natural authoritative component and requirement counts', () => {
    const counts = (overrides: Partial<Parameters<typeof nativeOnboardingCountsAreConsistent>[0]> = {}) => ({
      expected_components: 1,
      native_requirements: 1,
      authored_components: 1,
      reviewed_items: 1,
      reviewed_components: 1,
      validated_components: 1,
      ...overrides,
    });
    expect(nativeOnboardingCountsAreConsistent(counts())).toBe(true);
    expect(nativeOnboardingCountsAreConsistent(counts({
      expected_components: 2,
      native_requirements: 3,
      authored_components: 2,
      reviewed_items: 3,
      reviewed_components: 2,
      validated_components: 2,
    }))).toBe(true);
    for (const field of ['reviewed_items', 'reviewed_components', 'validated_components'] as const) {
      expect(nativeOnboardingCountsAreConsistent(counts({[field]: 0}))).toBe(false);
    }
    expect(nativeOnboardingCountsAreConsistent(counts({native_requirements: 0, reviewed_items: 0}))).toBe(false);
    expect(nativeOnboardingCountsAreConsistent(counts({expected_components: 0, authored_components: 0, reviewed_components: 0, validated_components: 0}))).toBe(false);
    expect(nativeOnboardingCountsAreConsistent(counts({authored_components: 0}))).toBe(false);
  });
});
