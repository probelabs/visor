import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import yaml from 'js-yaml';
import Ajv from 'ajv';
import {loadConfig} from '../../src/sdk';
import {createExtendedLiquid} from '../../src/liquid-extensions';
import {GitCheckoutProvider} from '../../src/providers/git-checkout-provider';
import {worktreeManager} from '../../src/utils/worktree-manager';

type Json = Record<string, any>;

const CONFIG_PATH = path.resolve(__dirname, '../../examples/agent-governance/native-onboarding/visor-onboarding.yaml');
const RUNNER_PATH = path.resolve(__dirname, '../../examples/agent-governance/native-onboarding/run-onboarding.ts');

function readConfig(): Json {
  return yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')) as Json;
}

describe('native onboarding isolated writer wiring', () => {
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
    expect(checks['enumerate-native-requirements'].depends_on).toEqual(['promote-native-component']);
  });

  it('binds only the admitted WorkItem, exact checkout, and built-in role into the writer prompt', async () => {
    const config = readConfig();
    const author = config.subgraphs['onboard-component'].checks['author-native-component'];
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
      .toBeLessThan(source.indexOf('executeGroupedChecks'));
  });
});
