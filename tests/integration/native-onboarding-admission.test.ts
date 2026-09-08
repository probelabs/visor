import {describe, expect, it, jest} from '@jest/globals';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import yaml from 'js-yaml';
import {createExtendedLiquid} from '../../src/liquid-extensions';
import {canonicalGraphCheckpointJson, ExecutionJournal} from '../../src/snapshot-store';
import {canonicalJson, immutableCanonicalValue} from '../../src/state-machine/graph/claim-kernel';
import {compileClaimPlan} from '../../src/state-machine/graph/claim-plan';
import {governedResultDigest} from '../../src/providers/governed-proof-inspect-check-provider';

// The global Jest setup mocks asynchronous child_process.spawn. This fixture
// exercises the real managed Proof transport, so restore both module aliases
// before the provider imports are evaluated.
jest.unmock('child_process');
jest.unmock('node:child_process');

const configuredProof = process.env.PROOF_BIN || '';
const proofReady = (() => {
  try { const stat = fs.statSync(configuredProof); return path.isAbsolute(configuredProof) && stat.isFile() && (stat.mode & 0o111) !== 0; } catch { return false; }
})();
if (configuredProof && !proofReady) throw new Error(`PROOF_BIN is configured but is not an executable file: ${configuredProof}`);
const describeNative = configuredProof ? describe : describe.skip;
const ROOT = path.resolve(__dirname, '../..');
const CONFIG_PATH = path.join(ROOT, 'examples/agent-governance/native-onboarding/visor-onboarding.yaml');
const PROFILE = 'luna-xhigh-readonly-v1';
const PROOF_LOG = path.join(ROOT, 'results/native-onboarding-admission-proof.log');
const PROOF_TIMEOUT_MS = 15_000;
const PROOF_RUN_ID = `native-admission-${Date.now()}-${process.pid}`;
const PROOF_SOURCE_HASH = `sha256:${createHash('sha256').update(fs.readFileSync(__filename)).digest('hex')}`;

function proofDiagnostic(value: unknown, cwd: string): string {
  return String(value || '').replaceAll(cwd, '<fixture-root>').slice(0, 64 * 1024);
}

function proof(cwd: string, args: string[], input = '', label = args.join(' ')): string {
  const started = Number(process.hrtime.bigint()) / 1e6;
  fs.mkdirSync(path.dirname(PROOF_LOG), {recursive: true});
  fs.appendFileSync(PROOF_LOG, JSON.stringify({event: 'start', run_id: PROOF_RUN_ID, label, command: args, started_monotonic_ms: started}) + '\n');
  const result = spawnSync(configuredProof, args, {
    cwd, input, encoding: 'utf8', timeout: PROOF_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024,
    env: {...process.env, PROOF_BIN: configuredProof, PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', GOPROXY: 'off', GOSUMDB: 'off', GOTOOLCHAIN: 'local'},
  });
  const ended = Number(process.hrtime.bigint()) / 1e6;
  const stdout = proofDiagnostic(result.stdout, cwd);
  const stderr = proofDiagnostic(result.stderr, cwd);
  const error = result.error ? proofDiagnostic(result.error.message, cwd) : undefined;
  fs.appendFileSync(PROOF_LOG, JSON.stringify({event: 'end', run_id: PROOF_RUN_ID, label, command: args, started_monotonic_ms: started, ended_monotonic_ms: ended, exit_code: result.status, signal: result.signal, error, stdout, stderr}) + '\n');
  if (result.error || result.status !== 0) {
    const reason = error || stderr || `exit ${String(result.status)}`;
    throw new Error(`Proof ${label} failed: ${reason}`);
  }
  return String(result.stdout || '');
}

function proofJson(cwd: string, args: string[], input = '', label = args.join(' ')): any {
  return JSON.parse(proof(cwd, args, input, label));
}

function diagnostic(label: string, fields: Record<string, string | number | boolean | null> = {}): void {
  fs.mkdirSync(path.dirname(PROOF_LOG), {recursive: true});
  fs.appendFileSync(PROOF_LOG, JSON.stringify({event: 'milestone', run_id: PROOF_RUN_ID, label, monotonic_ms: Number(process.hrtime.bigint()) / 1e6, ...fields}) + '\n');
}

function git(cwd: string, args: string[]): void {
  const result = spawnSync('git', args, {cwd, encoding: 'utf8'});
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr || ''}`);
}

function componentData(subject: any): any {
  const first = subject.sorted_owned_paths[0];
  const coordinate = {path: first, line: 1};
  return immutableCanonicalValue({
    schema: 'reqproof.component-onboarding/v1', project: subject.project_id, shard: subject.component_id,
    reviewedFiles: subject.sorted_owned_paths.map((value: string) => ({path: value, coordinates: [coordinate]})),
    requirements: ['STK', 'SYS', 'SW', 'INT'].map((kind, index) => ({id: `${kind}-${subject.component_id}-${index + 1}`, text: `${kind} synthetic evidence`, coordinates: [coordinate]})),
    interfaces: [{name: `${subject.component_id}-boundary`, coordinates: [coordinate]}],
    findings: [{id: `finding-${subject.component_id}`, severity: 'info', title: 'Synthetic no-model fixture', calibration: 'confirmed', confidence: 1, coordinates: [coordinate]}],
    unknowns: [], repositoryMutated: false, commandsExecuted: false, checklistCompleted: false,
  });
}

function fakeRunnerFactory(candidate: any): any {
  // This is a labelled no-model seam for the governed inspect/spec-review
  // boundaries. The admission, revalidation, materialization, and reconcile
  // calls still execute against the pinned real Proof CLI below.
  return (request: any) => ({
    preview: () => ({source: 'probe-host-tools-call', tool: 'codex', promptDigest: `sha256:${'c'.repeat(64)}`, promptBytes: 0}),
    answer: () => {
      const data = request.invocation.role_id === 'onboard' && request.invocation.subject.kind === 'project'
        ? candidate
        : componentData(request.invocation.component_authority.subject);
      const bytes = canonicalJson(data);
      const d = 'a'.repeat(64);
      return {
        data,
        runtimeAttestation: {
          version: 'probe.governed-codex-attestation/v2', profileId: PROFILE,
          requested: {profileDigest: d, cwdDigest: d, probeToolsDigest: d, model: 'gpt-5.6-luna', reasoningEffort: 'xhigh', sandbox: 'read-only', approvalPolicy: 'never'},
          observed: {source: 'session_configured', model: 'gpt-5.6-luna', modelProviderId: 'openai', reasoningEffort: 'xhigh', approvalPolicy: 'never', cwdDigest: d, permissionProfileDigest: d, filesystem: 'restricted-read-root', network: 'restricted'},
          executionContext: {source: 'caller', invocationDigest: request.invocationDigest},
          dispatch: {source: 'probe-host-tools-call', tool: 'codex', promptDigest: `sha256:${'c'.repeat(64)}`, promptBytes: 0},
          evidence: {eventCount: 1}, usage: {status: 'unavailable'},
        },
        resultIdentity: {version: 'probe.governed-result-identity/v1', source: 'probe-host-schema-valid-json', resultDigest: governedResultDigest(data), canonicalBytes: Buffer.byteLength(bytes, 'utf8')},
      };
    }, cancel: () => undefined, close: () => undefined,
  });
}

function expectAdmittedManaged(result: any): void {
  expect(result.outcome.summary.output).toEqual(expect.objectContaining({Status: 'ADMITTED'}));
  expect(result.outcome.summary.output.__proof_admission_wire).toEqual(expect.any(String));
}

async function renderCarrier(source: string, outputs: Record<string, unknown>, cwd: string, output: string, baselineCommit: string): Promise<{result: any; value: any}> {
  const rendered = await createExtendedLiquid().parseAndRender(source, {outputs});
  const result = spawnSync('sh', ['-c', rendered], {
    cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
    env: {...process.env, PROOF_BIN: configuredProof, NATIVE_ONBOARDING_OUTPUT_DIR: output, NATIVE_ONBOARDING_BASELINE_COMMIT: baselineCommit},
  });
  let value: any;
  try { value = JSON.parse(result.stdout); } catch { value = undefined; }
  return {result, value};
}

function fixture(count: number): {root: string; output: string; projectId: string; components: string[]; baselineCommit: string} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-native-admission-'));
  const output = path.join(root, 'output'); fs.mkdirSync(output);
  const projectId = `native-admission-${count}`;
  const components = Array.from({length: count}, (_, index) => `component-${index + 1}`);
  for (const [index, component] of components.entries()) fs.writeFileSync(path.join(root, `${component}.go`), `package fixture\nfunc Value${index + 1}() int { return ${index + 1} }\n`);
  git(root, ['init', '--quiet']); git(root, ['config', 'user.name', 'native admission fixture']); git(root, ['config', 'user.email', 'native-admission@example.invalid']); git(root, ['add', '--all']); git(root, ['commit', '--quiet', '-m', 'fixture']);
  const baselineCommit = String(spawnSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).stdout || '').trim();
  if (!/^[0-9a-f]{40}$/.test(baselineCommit)) throw new Error('fixture did not produce an immutable git baseline commit');
  proof(root, ['init', '--name', projectId, '--template', 'go-package', '--scope', '.', '--strict'], '', `fixture N=${count} proof init`);
  for (const component of components) {
    proof(root, ['req', 'new', 'specs/system', '--component', component, '--description', `${component} obligation`, '--priority-level', 'major', '--format', 'json'], '', `fixture N=${count} req new ${component}`);
  }
  return {root, output, projectId, components, baselineCommit};
}

describeNative('native onboarding real Proof admission suffix (static capability; synthetic runner)', () => {
  jest.setTimeout(120_000);

  for (const count of [1, 5]) {
    it(`runs the shipped graph suffix through real Proof admission and reconciliation for N=${count}`, async () => {
      fs.mkdirSync(path.dirname(PROOF_LOG), {recursive: true});
      const existingLogBytes = fs.existsSync(PROOF_LOG) ? fs.statSync(PROOF_LOG).size : 0;
      fs.appendFileSync(PROOF_LOG, JSON.stringify({event: 'run_start', run_id: PROOF_RUN_ID, test_source_hash: PROOF_SOURCE_HASH, existing_log_bytes: existingLogBytes, test: `N=${count}`}) + '\n');
      diagnostic('test.start', {count});
      const paths = fixture(count);
      try {
        diagnostic('fixture.ready', {count});
        jest.resetModules();
        jest.doMock('child_process', () => jest.requireActual('child_process'));
        jest.doMock('node:child_process', () => jest.requireActual('node:child_process'));
        const [governedModule, admissionModule, catalogModule, admittedCatalogModule, reconcileModule, capabilityModule] = await Promise.all([
          import('../../src/providers/governed-proof-inspect-check-provider'),
          import('../../src/providers/proof-admit-check-provider'),
          import('../../src/providers/proof-catalog-check-providers'),
          import('../../src/providers/proof-admitted-catalog-check-provider'),
          import('../../src/providers/proof-project-reconcile-check-provider'),
          import('../../src/providers/proof-admission-cli-child'),
        ]);
        const {createGovernedProofInspectProviderForFocusedTest} = governedModule;
        const {createProofAdmitProviderFromCapability} = admissionModule;
        const {createProofStructuralInventoryProviderFromCapability, createProofCatalogRevalidationProviderFromCapability} = catalogModule;
        const {createProofAdmittedCatalogProviderFromCapability} = admittedCatalogModule;
        const {createProofProjectReconcileProviderFromCapability} = reconcileModule;
        const {createProofAdmissionCapability} = capabilityModule;
        const raw: any = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8'));
        const projectInspect = raw.subgraphs['discover-project'].checks.inspect;
        projectInspect.invocation.output_schema = Buffer.from(projectInspect.result_schema, 'utf8').toString('base64');
        const inventory = proofJson(paths.root, ['onboarding', 'inventory'], '', `N=${count} onboarding inventory`);
        const authority = inventory.authority;
        const projectInvocation = {role_id: 'onboard', stance: 'owner', subject: {kind: 'project', id: authority.project_id, fingerprint: authority.subject_fingerprint}, output_schema_id: projectInspect.invocation.output_schema_id, output_schema: projectInspect.invocation.output_schema};
        const resolved = proofJson(paths.root, ['resolve-role-invocation'], JSON.stringify(projectInvocation), `N=${count} resolve-role-invocation`);
        projectInspect.invocation.subject = projectInvocation.subject;
        projectInspect.invocation_digest = resolved.invocation_digest;
        projectInspect.instructions = resolved.instructions;
        const candidate = {version: 'proof.component-catalog-candidate/v1', project_id: paths.projectId, components: paths.components.map(component => ({id: component, responsibility: `${component} fixture`, owned_paths: [`${component}.go`], dependency_closure: [`${component}.go`]}))};
        const plan = compileClaimPlan(raw);
        const journal = new ExecutionJournal(plan);
        const capability = createProofAdmissionCapability(configuredProof);
        const governed = createGovernedProofInspectProviderForFocusedTest(fakeRunnerFactory(candidate), capability);
        const admission = createProofAdmitProviderFromCapability(capability);
        const completeManaged = async (nodeGenerationId: string, provider: any, extra: any = {}): Promise<any> => {
          const execution: any = journal.getGeneratedExecution(nodeGenerationId);
          const attempt = journal.startGeneratedAttempt(nodeGenerationId); journal.scheduleGeneratedAttempt(attempt);
          const binding = journal.deriveManagedRunBinding(attempt); journal.recordManagedRunAcquired(binding); journal.recordManagedRunStarted(binding);
          const invocation = execution.node.check.invocation;
          const phase = {check_id: execution.generation.checkId, ...(execution.generation.scope?.length === 2 && execution.generation.scope[1]?.key ? {component_id: execution.generation.scope[1].key} : {})};
          diagnostic('managed.starting', phase);
          const context: any = {claims: execution.claims};
          if (invocation?.subject?.kind === 'component') context.proofComponentAuthority = journal.getProofComponentInvocationAuthority(nodeGenerationId);
          if (extra.proofOnboardingStageContext) context.proofOnboardingStageContext = extra.proofOnboardingStageContext;
          const dependencyResults = new Map<string, any>();
          if (execution.generation.checkId === 'proof_admit' && execution.claims.candidate) dependencyResults.set('inspect', {issues: [], output: execution.claims.candidate.payload});
          if (execution.generation.checkId === 'spec_review_admit' && execution.claims.candidate) dependencyResults.set('spec_review', {issues: [], output: execution.claims.candidate.payload});
          const managed: any = provider.startManaged({prInfo: {} as any, checkConfig: execution.node.check, dependencyResults, executionContext: context, binding, executionConfigDigest: execution.node.executionConfigDigest, workingDirectory: paths.root, ...(execution.node.check.type === 'proof-admit' || execution.node.check.type === 'spec_review_admit' ? {proofAdmissionRequest: journal.getProofAdmissionRequest(nodeGenerationId)} : {}), ...(execution.node.check.type === 'proof-project-reconcile' ? {proofProjectReconciliationRequest: journal.getProofProjectReconciliationRequest(nodeGenerationId)} : {})});
          diagnostic('managed.start', phase);
          await managed.started;
          diagnostic('managed.started', phase);
          const outcome: any = await managed.outcome;
          diagnostic('managed.outcome', {...phase, status: String(outcome.kind)});
          await managed.close();
          diagnostic('managed.closed', phase);
          expect(String(outcome.kind)).toMatch(/^succeeded/);
          journal.completeManagedGeneratedAttempt({attempt, binding, payload: outcome.summary.output, executionConfigDigest: execution.node.executionConfigDigest, ...(outcome.proofCandidateEvidence ? {proofCandidateEvidence: outcome.proofCandidateEvidence, wireMode: outcome.wireMode} : {})});
          return {execution, outcome};
        };

        const request = journal.requestCatalogReconciliation({sessionId: `native-admission-${count}`, ownerCheck: 'project'});
        const catalogAttempt = journal.startCatalogRequestAttempt(request.requestId); journal.scheduleCatalogRequestAttempt({requestId: request.requestId, attemptId: catalogAttempt.attemptId, fence: catalogAttempt.fence});
        journal.completeAttempt({sessionId: request.sessionId, checkId: 'project', scope: [], attemptId: catalogAttempt.attemptId, fence: catalogAttempt.fence, payload: {projects: [{project_id: paths.projectId, root: '.'}]}});
        const structural = createProofStructuralInventoryProviderFromCapability(capability);
        const structuralGeneration: any = journal.queryReadyWork().find(value => value.checkId === 'structural_inventory');
        await completeManaged(structuralGeneration.nodeGenerationId, structural);
        diagnostic('structural.complete', {count});
        const inspectGeneration: any = journal.queryReadyWork().find(value => value.checkId === 'inspect' && value.scope.length === 1);
        await completeManaged(inspectGeneration.nodeGenerationId, governed);
        diagnostic('project.inspect.complete', {count});
        const discoveryAdmissionGeneration: any = journal.queryReadyWork().find(value => value.checkId === 'proof_admit' && value.scope.length === 1);
        const discoveryAdmission = await completeManaged(discoveryAdmissionGeneration.nodeGenerationId, admission);
        expectAdmittedManaged(discoveryAdmission);
        diagnostic('project.admission.complete', {count, status: 'ADMITTED'});
        const discoveryVerify: any = journal.queryReadyWork().find(value => value.checkId === 'verify' && value.scope.length === 1);
        const verifyAttempt = journal.startGeneratedAttempt(discoveryVerify.nodeGenerationId); journal.scheduleGeneratedAttempt(verifyAttempt); journal.completeGeneratedAttempt({attempt: verifyAttempt, payload: {}});
        const revalidateGeneration: any = journal.queryReadyWork().find(value => value.checkId === 'revalidate_catalog');
        await completeManaged(revalidateGeneration.nodeGenerationId, createProofCatalogRevalidationProviderFromCapability(capability));
        diagnostic('project.revalidate.complete', {count});
        const materializeGeneration: any = journal.queryReadyWork().find(value => value.checkId === 'materialize_catalog');
        await completeManaged(materializeGeneration.nodeGenerationId, createProofAdmittedCatalogProviderFromCapability(capability));
        diagnostic('project.materialize.complete', {count});
        const preparedByComponent = new Map<string, any>();
        const expectedWorkItemDigests = new Set<string>();

        const readyComponent = (checkId: string, componentId: string, expectedAliases: string[] = []): any => {
          const ready = journal.queryReadyWork().find(value => value.checkId === checkId && value.scope.length === 2 && value.scope[1]?.key === componentId);
          expect(ready).toBeDefined();
          if (!ready) return undefined;
          const execution: any = journal.getGeneratedExecution(ready.nodeGenerationId);
          for (const alias of expectedAliases) expect(execution.claims[alias]).toBeDefined();
          return ready;
        };
        for (const componentId of paths.components) {
          diagnostic('component.prefix.start', {count, component_id: componentId});
          const prepare = readyComponent('prepare-work-item', componentId, ['component']); const workItem = {...(prepare && (journal.getGeneratedExecution(prepare.nodeGenerationId) as any).claims.component.payload), baseline_commit: paths.baselineCommit};
          const pAttempt = journal.startGeneratedAttempt(prepare.nodeGenerationId); journal.scheduleGeneratedAttempt(pAttempt); journal.completeGeneratedAttempt({attempt: pAttempt, payload: workItem}); preparedByComponent.set(componentId, workItem);
          const role = readyComponent('role-onboard-component', componentId, ['component']); const roleAttempt = journal.startGeneratedAttempt(role.nodeGenerationId); journal.scheduleGeneratedAttempt(roleAttempt); journal.completeGeneratedAttempt({attempt: roleAttempt, payload: 'synthetic onboard role'});
          const target = readyComponent('checkout-target', componentId, ['work_item']); const targetAttempt = journal.startGeneratedAttempt(target.nodeGenerationId); journal.scheduleGeneratedAttempt(targetAttempt); journal.completeGeneratedAttempt({attempt: targetAttempt, payload: {component_id: componentId, baseline_commit: paths.baselineCommit, worktree_root: path.join(paths.output, 'worktrees', componentId)}});
          const checkout = readyComponent('checkout-worktree', componentId, ['target']); const checkoutAttempt = journal.startGeneratedAttempt(checkout.nodeGenerationId); journal.scheduleGeneratedAttempt(checkoutAttempt); journal.completeGeneratedAttempt({attempt: checkoutAttempt, payload: {success: true, path: paths.root, ref: paths.baselineCommit, commit: paths.baselineCommit, worktree_id: `synthetic-${componentId}`, repository: paths.root, is_worktree: true}});
          const author = readyComponent('author-native-component', componentId, ['work_item', 'checkout', 'role']); const authorAttempt = journal.startGeneratedAttempt(author.nodeGenerationId); journal.scheduleGeneratedAttempt(authorAttempt); journal.completeGeneratedAttempt({attempt: authorAttempt, payload: {synthetic: true}});
          const promote = readyComponent('promote-native-component', componentId, ['work_item', 'checkout', 'author']); const promoteAttempt = journal.startGeneratedAttempt(promote.nodeGenerationId); journal.scheduleGeneratedAttempt(promoteAttempt); journal.completeGeneratedAttempt({attempt: promoteAttempt, payload: {status: 'promoted', component_id: componentId, baseline_commit: paths.baselineCommit, accepted_paths: [], ignored_paths: [], rejected_paths: [], checkpoint: {baseline_commit: paths.baselineCommit, component_id: componentId, accepted_paths: [], ignored_paths: [], status: 'promoted'}}});
          const specRole = readyComponent('role-spec-review-component', componentId, ['component']); const specRoleAttempt = journal.startGeneratedAttempt(specRole.nodeGenerationId); journal.scheduleGeneratedAttempt(specRoleAttempt); journal.completeGeneratedAttempt({attempt: specRoleAttempt, payload: 'synthetic spec-review role'});
          const enumerate = readyComponent('enumerate-native-requirements', componentId, ['work_item', 'promotion', 'author', 'role']); const enumerateExecution: any = journal.getGeneratedExecution(enumerate.nodeGenerationId); const enumerated = await renderCarrier(enumerateExecution.node.check.exec, {work_item: workItem, promotion: {status: 'promoted'}, author: {synthetic: true}, role: 'synthetic spec-review role'}, paths.root, paths.output, paths.baselineCommit); expect(enumerated.result.status).toBe(0);
          // The public carrier is deterministic; the journal still owns the
          // generated claim identity and expansion.
          const enumAttempt = journal.startGeneratedAttempt(enumerate.nodeGenerationId); journal.scheduleGeneratedAttempt(enumAttempt); journal.completeGeneratedAttempt({attempt: enumAttempt, payload: enumerated.value});
          diagnostic('component.enumerate.complete', {count, component_id: componentId});
          const catalog: any = enumerated.value;
          const itemGenerations = () => journal.queryReadyWork().filter(value => value.checkId === 'review-native-item' && value.scope.length === 3 && value.scope[1]?.key === componentId);
          for (const itemGeneration of itemGenerations()) {
            const itemExecution: any = journal.getGeneratedExecution(itemGeneration.nodeGenerationId); const itemAttempt = journal.startGeneratedAttempt(itemGeneration.nodeGenerationId); journal.scheduleGeneratedAttempt(itemAttempt); journal.completeGeneratedAttempt({attempt: itemAttempt, payload: {decision: 'synthetic-no-model', requirement_id: itemExecution.claims.item.payload.id}});
            const collect: any = journal.queryReadyWork().find(value => value.checkId === 'collect-proof-evidence' && value.scope.length === 3 && value.scope[2]?.key === itemExecution.claims.item.payload.id); const collectExecution: any = journal.getGeneratedExecution(collect.nodeGenerationId); const collected = await renderCarrier(collectExecution.node.check.exec, {item: itemExecution.claims.item.payload, candidate: {decision: 'synthetic-no-model', requirement_id: itemExecution.claims.item.payload.id}}, paths.root, paths.output, paths.baselineCommit); expect(collected.result.status).toBe(0); const collectAttempt = journal.startGeneratedAttempt(collect.nodeGenerationId); journal.scheduleGeneratedAttempt(collectAttempt); journal.completeGeneratedAttempt({attempt: collectAttempt, payload: collected.value});
          }
          const waitForItems: any = readyComponent('wait-for-native-items', componentId); const waitAttempt = journal.startGeneratedAttempt(waitForItems.nodeGenerationId); journal.scheduleGeneratedAttempt(waitAttempt); journal.completeGeneratedAttempt({attempt: waitAttempt, payload: {}});
          const prepared = preparedByComponent.get(componentId); const reviewedGeneration: any = readyComponent('component-reviewed', componentId, ['work_item', 'catalog']); const reviewedExecution: any = journal.getGeneratedExecution(reviewedGeneration.nodeGenerationId); const reviewed = await renderCarrier(reviewedExecution.node.check.exec, {work_item: prepared, catalog}, paths.root, paths.output, paths.baselineCommit); expect(reviewed.result.status).toBe(0); const reviewedAttempt = journal.startGeneratedAttempt(reviewedGeneration.nodeGenerationId); journal.scheduleGeneratedAttempt(reviewedAttempt); journal.completeGeneratedAttempt({attempt: reviewedAttempt, payload: reviewed.value});
          diagnostic('component.reviewed.complete', {count, component_id: componentId});
          const validationGeneration: any = readyComponent('native-validation', componentId, ['component', 'reviewed']); const validationExecution: any = journal.getGeneratedExecution(validationGeneration.nodeGenerationId); const validation = await renderCarrier(validationExecution.node.check.exec, {component: prepared, reviewed: reviewed.value}, paths.root, paths.output, paths.baselineCommit); expect(validation.result.status).toBe(0); const validationAttempt = journal.startGeneratedAttempt(validationGeneration.nodeGenerationId); journal.scheduleGeneratedAttempt(validationAttempt); journal.completeGeneratedAttempt({attempt: validationAttempt, payload: validation.value});
          diagnostic('component.validation.complete', {count, component_id: componentId});
          const componentInspect: any = readyComponent('inspect', componentId); const initialExecution: any = journal.getGeneratedExecution(componentInspect.nodeGenerationId); expect(Object.keys(initialExecution.claims).sort()).toEqual(['component', 'reviewed']); const componentAuthority = journal.getProofComponentInvocationAuthority(componentInspect.nodeGenerationId); const initial = await completeManaged(componentInspect.nodeGenerationId, governed);
          diagnostic('component.inspect.complete', {count, component_id: componentId});
          const componentAdmission: any = readyComponent('proof_admit', componentId); const componentAdmissionResult = await completeManaged(componentAdmission.nodeGenerationId, admission); expectAdmittedManaged(componentAdmissionResult); expectedWorkItemDigests.add(componentAuthority.work_item_digest);
          diagnostic('component.admission.complete', {count, component_id: componentId, status: 'ADMITTED'});
          const staged: any = readyComponent('spec_review', componentId, ['component', 'candidate', 'admission']); const stagedExecution: any = journal.getGeneratedExecution(staged.nodeGenerationId); const stageContext = journal.getProofComponentOnboardingStageContext(staged.nodeGenerationId); const stagedResult = await completeManaged(staged.nodeGenerationId, governed, {proofOnboardingStageContext: stageContext});
          diagnostic('component.staged-review.complete', {count, component_id: componentId});
          const stagedAdmission: any = readyComponent('spec_review_admit', componentId); const stagedAdmissionResult = await completeManaged(stagedAdmission.nodeGenerationId, admission); expectAdmittedManaged(stagedAdmissionResult);
          diagnostic('component.staged-admission.complete', {count, component_id: componentId, status: 'ADMITTED'});
          const finalVerify: any = readyComponent('verify', componentId); const finalAttempt = journal.startGeneratedAttempt(finalVerify.nodeGenerationId); journal.scheduleGeneratedAttempt(finalAttempt); journal.completeGeneratedAttempt({attempt: finalAttempt, payload: {}});
          const initialClaim = initial.execution ? journal.getInstanceProjection().claimsById[journal.getGeneratedExecution(componentInspect.nodeGenerationId).generation.completedOutputClaimIds[0]] : undefined;
          const stagedClaim = stagedResult.execution ? journal.getInstanceProjection().claimsById[journal.getGeneratedExecution(staged.nodeGenerationId).generation.completedOutputClaimIds[0]] : undefined;
          expect(initialClaim?.parentClaimIds).toEqual(Object.values(initialExecution.claims).map((claim: any) => claim.claimId).sort());
          expect(stagedClaim?.parentClaimIds).toEqual(Object.values(stagedExecution.claims).map((claim: any) => claim.claimId).sort());
        }
        const reconcile: any = journal.queryReadyWork().find(value => value.checkId === 'project_reconcile'); expect(reconcile).toBeDefined(); const reconciled = await completeManaged(reconcile.nodeGenerationId, createProofProjectReconcileProviderFromCapability(capability));
        const reconciliationOutput: any = reconciled.outcome.summary.output;
        expect(reconciliationOutput.component_admissions).toHaveLength(count);
        expect(reconciliationOutput.component_admissions.map((value: any) => value.component_id).sort()).toEqual(paths.components.slice().sort());
        expect(new Set(reconciliationOutput.covered_work_item_digests).size).toBe(count);
        expect(new Set(reconciliationOutput.covered_work_item_digests)).toEqual(expectedWorkItemDigests);
        diagnostic('checkpoint.export.start', {count});
        const checkpoint = journal.exportGraphCheckpoint(request.sessionId);
        diagnostic('checkpoint.export.complete', {count, event_count: checkpoint.events.length});
        diagnostic('checkpoint.restore.start', {count});
        const restored = ExecutionJournal.restoreGraphCheckpoint(plan, JSON.parse(canonicalGraphCheckpointJson(checkpoint)));
        diagnostic('checkpoint.restore.complete', {count});
        diagnostic('checkpoint.replay.start', {count});
        expect(restored.getInstanceProjection()).toEqual(restored.replayInstanceProjection());
        diagnostic('checkpoint.replay.complete', {count});
        diagnostic('checkpoint.reexport.start', {count});
        expect(canonicalGraphCheckpointJson(restored.exportGraphCheckpoint(request.sessionId))).toBe(canonicalGraphCheckpointJson(checkpoint));
        diagnostic('checkpoint.reexport.complete', {count});
      } finally { fs.rmSync(paths.root, {recursive: true, force: true}); }
    });
  }
});
