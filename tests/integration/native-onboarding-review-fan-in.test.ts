import {createHash} from 'node:crypto';
import {execFileSync, spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from '@jest/globals';
import yaml from 'js-yaml';
import {createExtendedLiquid} from '../../src/liquid-extensions';
import {compileClaimPlan} from '../../src/state-machine/graph/claim-plan';

const configuredProof = process.env.PROOF_BIN || '';
let proofReady = false;
if (configuredProof) {
  try {
    const stat = fs.statSync(configuredProof);
    proofReady = path.isAbsolute(configuredProof) && stat.isFile() && (stat.mode & 0o111) !== 0;
  } catch {
    proofReady = false;
  }
}
if (configuredProof && !proofReady) {
  throw new Error(`configured PROOF_BIN is not an executable: ${configuredProof}`);
}

const describeNative = configuredProof && proofReady ? describe : describe.skip;
const ROOT = path.resolve(__dirname, '../..');
const CONFIG_PATH = path.join(ROOT, 'examples/agent-governance/native-onboarding/visor-onboarding.yaml');

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, {cwd, encoding: 'utf8'});
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || ''}`);
  return String(result.stdout || '').trim();
}

function proof(cwd: string, args: string[]): string {
  return String(execFileSync(configuredProof, args, {
    cwd,
    encoding: 'utf8',
    env: {...process.env, PROOF_BIN: configuredProof},
  }));
}

function sha256(file: string): string {
  return `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`;
}

function token(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function aggregatePath(output: string, componentId: string): string {
  return path.join(output, 'review-packets', `${token(componentId)}.json`);
}

async function renderAndRun(
  source: string,
  outputs: Record<string, unknown>,
  cwd: string,
  outputDir: string,
): Promise<any> {
  const liquid = createExtendedLiquid();
  const rendered = await liquid.parseAndRender(source, {outputs});
  const result = spawnSync('sh', ['-c', rendered], {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      PROOF_BIN: configuredProof,
      NATIVE_ONBOARDING_OUTPUT_DIR: outputDir,
      NATIVE_ONBOARDING_BASELINE_COMMIT: 'a'.repeat(40),
    },
    maxBuffer: 32 * 1024 * 1024,
  });
  return {result, rendered};
}

function fixture(): {parent: string; subject: string; output: string} {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-native-onboarding-fan-in-'));
  const subject = path.join(parent, 'subject');
  const output = path.join(parent, 'output');
  fs.mkdirSync(subject);
  fs.mkdirSync(output);
  git(subject, ['init', '--quiet']);
  git(subject, ['config', 'user.name', 'native-onboarding-fan-in-test']);
  git(subject, ['config', 'user.email', 'native-onboarding-fan-in@example.invalid']);
  fs.writeFileSync(path.join(subject, 'go.mod'), 'module example.invalid/native-onboarding-fan-in\n\ngo 1.25\n');
  fs.writeFileSync(path.join(subject, 'component.go'), 'package component\n\nfunc Value() int { return 1 }\n');
  git(subject, ['add', '--all']);
  git(subject, ['commit', '--quiet', '-m', 'source fixture']);
  proof(subject, ['init', '--name', 'native-onboarding-fan-in', '--template', 'go-package', '--scope', '.', '--strict']);
  proof(subject, [
    'req', 'new', 'specs/system', '--component', 'component-a',
    '--fretish', 'the component_a shall always satisfy component_state > 0',
    '--variables', 'component_state', '--priority-level', 'major', '--format', 'json',
  ]);
  proof(subject, [
    'var', 'add', 'component-a', 'component_state', '--type', 'int', '--direction', 'input',
    '--description', 'component state',
  ]);
  return {parent, subject, output};
}

describeNative('native onboarding per-requirement fan-in', () => {
  jest.setTimeout(60_000);

  it('preserves opaque Proof metadata, permits sibling progress, and rejects stale own input', async () => {
    const paths = fixture();
    try {
      const raw = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8')) as any;
      // The live runner replaces this placeholder after Proof resolves the
      // governed inspect schema. Mirror that deterministic preparation before
      // compiling the exact shipped claim validators.
      const inspect = raw.subgraphs['discover-project'].checks.inspect;
      inspect.invocation.output_schema = Buffer.from(inspect.result_schema, 'utf8').toString('base64');
      const claimPlan = compileClaimPlan(raw);
      const checks = raw.subgraphs['onboard-component'].checks;
      const role = proof(paths.subject, ['role', 'show', 'spec-review', '--format', 'agent']);
      const workItem = {
        project_id: 'native-onboarding-fan-in',
        component_id: 'component-a',
        sorted_owned_paths: ['component.go'],
        proof_input_state: [{input_kind: 'file', path: 'component.go', file_hash: sha256(path.join(paths.subject, 'component.go'))}],
        proof_component_subject: {fingerprint: 'sha256:' + '1'.repeat(64)},
        baseline_commit: 'a'.repeat(40),
      };
      const enumeration = await renderAndRun(checks['enumerate-native-requirements'].exec, {
        work_item: workItem,
        promotion: {status: 'promoted'},
        author: {status: 'authored'},
        role,
      }, paths.subject, paths.output);
      expect(enumeration.result.status).toBe(0);
      const catalog = JSON.parse(enumeration.result.stdout);
      expect(catalog.component_id).toBe('component-a');
      expect(catalog.items).toHaveLength(1);
      const item = catalog.items[0];
      expect(item.prepared_work_item).toEqual(workItem);
      expect(item.proof_snapshot.catalog_entry.priority_level).toBe('major');
      expect(item.proof_snapshot.req_show.requirement._computed.file_hash).toBe(item.proof_file_hash);
      expect(() => claimPlan.validatorsByClaim['native.requirement.catalog@1'](catalog)).not.toThrow();
      expect(() => claimPlan.validatorsByClaim['native.requirement.item@1'](item)).not.toThrow();

      const collect = await renderAndRun(raw.subgraphs['native-requirement-review'].checks['collect-proof-evidence'].exec, {
        item,
        candidate: {decision: 'needs_more_evidence', source: 'zero-model-fixture'},
      }, paths.subject, paths.output);
      expect(collect.result.status).toBe(0);
      const packet = JSON.parse(collect.result.stdout);
      expect(packet.catalog_entry).toEqual(item.proof_snapshot.catalog_entry);
      expect(packet.prepared_work_item).toEqual(workItem);
      expect(() => claimPlan.validatorsByClaim['native.review.packet@1'](packet)).not.toThrow();

      const fanIn = await renderAndRun(checks['component-reviewed'].exec, {
        work_item: workItem,
        catalog,
      }, paths.subject, paths.output);
      expect(fanIn.result.status).toBe(0);
      const reviewed = JSON.parse(fanIn.result.stdout);
      expect(reviewed).toMatchObject({
        component_id: 'component-a',
        status: 'reviewed-native-requirement-items',
        item_count: 1,
      });
      expect(() => claimPlan.validatorsByClaim['native.component.reviewed@1'](reviewed)).not.toThrow();
      const reviewedAggregatePath = aggregatePath(paths.output, 'component-a');
      const aggregateBeforeSibling = fs.readFileSync(reviewedAggregatePath, 'utf8');

      // Execute the shipped native-validation carrier against the real Proof
      // fixture. This catches heredoc/JSONL parser regressions that a string
      // assertion on the graph cannot see.
      const validation = await renderAndRun(checks['native-validation'].exec, {
        component: workItem,
        reviewed,
      }, paths.subject, paths.output);
      expect(validation.result.status).toBe(0);
      const validationSummary = JSON.parse(validation.result.stdout);
      expect(validationSummary.component_id).toBe('component-a');
      expect(validationSummary.validation.exit_code).toBe(0);
      expect(validationSummary.validation.value).toBeDefined();
      // The fixture intentionally has no source annotations, so Proof reports
      // an open audit. The carrier must preserve that real nonzero exit while
      // still parsing every JSONL event instead of fabricating a parse error.
      expect(validationSummary.audit.exit_code).toBeGreaterThan(0);
      expect(validationSummary.audit.event_count).toBeGreaterThan(0);
      expect(validationSummary.audit.parse_error).toBeNull();
      expect(validationSummary.audit.events.some((event: any) => event.event === 'check_done')).toBe(true);

      proof(paths.subject, [
        'req', 'new', 'specs/system', '--component', 'component-b',
    '--fretish', 'the component_b shall always satisfy component_state > 0', '--format', 'json',
      ]);
      const sibling = await renderAndRun(checks['component-reviewed'].exec, {
        work_item: workItem,
        catalog,
      }, paths.subject, paths.output);
      expect(sibling.result.status).toBe(0);
      // A sibling catalog addition is legitimate progress and must not make
      // this component's aggregate stale or rewrite it.
      expect(fs.readFileSync(reviewedAggregatePath, 'utf8')).toBe(aggregateBeforeSibling);

      const expectRejectedWithoutAggregateChange = async (
        operation: string,
      ): Promise<any> => {
        const before = fs.existsSync(reviewedAggregatePath)
          ? fs.readFileSync(reviewedAggregatePath, 'utf8')
          : undefined;
        const attempt = await renderAndRun(checks['component-reviewed'].exec, {
          work_item: workItem,
          catalog,
        }, paths.subject, paths.output);
        expect(attempt.result.status).not.toBe(0);
        if (before === undefined) {
          expect(fs.existsSync(reviewedAggregatePath)).toBe(false);
        } else {
          expect(fs.readFileSync(reviewedAggregatePath, 'utf8')).toBe(before);
        }
        expect(`${operation}\n${attempt.result.stdout}\n${attempt.result.stderr}`).toMatch(/Proof|requirement|changed|catalog|hash|fan-in/i);
        return attempt;
      };

      // Adding a requirement owned by this component changes the native set;
      // the stale catalog must be rejected without rewriting its aggregate.
      proof(paths.subject, [
        'req', 'new', 'specs/system', '--component', 'component-a',
        '--description', 'component-a secondary native obligation',
        '--priority-level', 'minor', '--format', 'json',
      ]);
      const afterOwnAddition = JSON.parse(proof(paths.subject, ['req', 'list', '--format', 'json']));
      const addedOwnRequirement = afterOwnAddition.find((row: any) => row?.component === 'component-a' && row.id !== item.id);
      expect(addedOwnRequirement?.id).toEqual(expect.any(String));
      await expectRejectedWithoutAggregateChange('own requirement addition');
      proof(paths.subject, ['req', 'delete', addedOwnRequirement.id, '--force']);

      const ownFile = path.join(paths.subject, item.file_path);
      fs.appendFileSync(ownFile, '\n# stale fan-in fixture mutation\n');
      const stale = await expectRejectedWithoutAggregateChange('stale own input');
      expect(`${stale.result.stdout}\n${stale.result.stderr}`).toMatch(/hash changed|input changed|identity changed/);

      // Remove the original catalog requirement. The empty current component
      // set is a native deletion and must be rejected with the prior aggregate
      // untouched.
      proof(paths.subject, ['req', 'delete', item.id, '--force']);
      await expectRejectedWithoutAggregateChange('own requirement removal');
    } finally {
      fs.rmSync(paths.parent, {recursive: true, force: true});
    }
  });
});
