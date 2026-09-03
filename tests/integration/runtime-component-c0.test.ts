import { describe, expect, it, jest } from '@jest/globals';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as yaml from 'js-yaml';
import { canonicalGraphCheckpointJson, ExecutionJournal } from '../../src/snapshot-store';
import { canonicalJson } from '../../src/state-machine/graph/claim-kernel';
import { compileClaimPlan } from '../../src/state-machine/graph/claim-plan';
import { proofCanonicalJson, proofTopLevelJson } from '../../src/providers/proof-wire';
import { goCompatibleProofJson } from '../../src/providers/proof-admission-cli-child';
import {
  deriveControllerItemClaimId,
  deriveItemFingerprint,
  deriveNodeGenerationId,
  deriveProofCurrentCatalogAuthorityId,
  deriveProofCurrentCatalogAuthorityMutationDigest,
  immutableInstanceProjection,
  reduceInstanceEvent,
} from '../../src/state-machine/graph/instance-kernel';

const PROOF_AUTHORITY = '/Users/buger/go/src/reqforge-exp-0207a-proof-cli-admission';
const EXP0209_PROFILE = '/Users/buger/go/src/visor-exp-0208-product-native-demo-pack/examples/agent-governance/exp-0209-discovery-egress/visor.yaml';
const PROFILE = 'luna-xhigh-readonly-v1';
const SCHEMA = Buffer.from('{"type":"object","additionalProperties":false}', 'utf8').toString('base64');
type ExecFileSync = typeof import('node:child_process').execFileSync;

function proofJSON(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') return Object.is(value, -0) ? '-0' : JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(proofJSON).join(',')}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort((left, right) => Buffer.from(left).compare(Buffer.from(right))).map(key => `${JSON.stringify(key)}:${proofJSON(object[key])}`).join(',')}}`;
}

function domainDigest(domain: string, value: string): string {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.alloc(8); length.writeBigUInt64BE(BigInt(bytes.length));
  return `sha256:${createHash('sha256').update(domain).update(Buffer.from([0])).update(length).update(bytes).digest('hex')}`;
}

function componentWorkItemWire(value: any): any {
  const mapping = value.proof_path_mapping;
  const subject = value.proof_component_subject;
  return {
    version: value.version,
    project_id: value.project_id,
    component_id: value.component_id,
    sorted_owned_paths: value.sorted_owned_paths,
    sorted_dependency_closure: value.sorted_dependency_closure,
    proof_path_mapping: {
      paths: mapping.paths,
      components: mapping.components,
      owner: mapping.owner,
      risk_tier: mapping.risk_tier,
      enforcement: mapping.enforcement,
    },
    proof_input_state: value.proof_input_state.map((row: any) => ({
      owner_kind: row.owner_kind,
      owner_id: row.owner_id,
      input_kind: row.input_kind,
      path: row.path,
      file_hash: row.file_hash,
    })),
    proof_component_subject: {
      version: subject.version,
      project_id: subject.project_id,
      component_id: subject.component_id,
      sorted_owned_paths: subject.sorted_owned_paths,
      sorted_dependency_closure: subject.sorted_dependency_closure,
      fingerprint: subject.fingerprint,
    },
  };
}

function rederiveCatalogRevalidationReceiptID(receipt: any): void {
  const authorities = receipt.component_authorities.map((authority: any) => ({
    component_id: authority.component_id,
    work_item_digest: authority.work_item_digest,
    subject: {
      version: authority.subject.version,
      project_id: authority.subject.project_id,
      component_id: authority.subject.component_id,
      sorted_owned_paths: authority.subject.sorted_owned_paths,
      sorted_dependency_closure: authority.subject.sorted_dependency_closure,
      fingerprint: authority.subject.fingerprint,
    },
  }));
  const lineage = receipt.project_lineage === null ? null : {
    version: receipt.project_lineage.version,
    fingerprint: receipt.project_lineage.fingerprint,
    object_format: receipt.project_lineage.object_format,
    baseline_revision: receipt.project_lineage.baseline_revision,
  };
  const unsigned = proofTopLevelJson({
    version: goCompatibleProofJson(receipt.version),
    decision: goCompatibleProofJson(receipt.decision),
    project_id: goCompatibleProofJson(receipt.project_id),
    project_fingerprint: goCompatibleProofJson(receipt.project_fingerprint),
    boundary_fingerprint: goCompatibleProofJson(receipt.boundary_fingerprint),
    inventory_claim_id: goCompatibleProofJson(receipt.inventory_claim_id),
    catalog_claim_id: goCompatibleProofJson(receipt.catalog_claim_id),
    admission_candidate_id: goCompatibleProofJson(receipt.admission_candidate_id),
    admission_result_digest: goCompatibleProofJson(receipt.admission_result_digest),
    admission_receipt_id: goCompatibleProofJson(receipt.admission_receipt_id),
    component_authorities: goCompatibleProofJson(authorities),
    project_lineage: goCompatibleProofJson(lineage),
    receipt_id: goCompatibleProofJson(''),
  });
  receipt.receipt_id = domainDigest('proof.catalog-revalidation-receipt/id/v2', unsigned);
}

function bare(seed: string): string { return createHash('sha256').update(seed).digest('hex'); }

function pinnedProofBinary(execFileSync: ExecFileSync): string {
  const configured = process.env.VISOR_PROOF_ADMISSION_BIN;
  if (configured) return configured;
  const binary = join(tmpdir(), `visor-runtime-c0-proof-${process.pid}`);
  if (existsSync(binary)) return binary;
  const source = mkdtempSync(join(tmpdir(), 'visor-runtime-c0-proof-source-'));
  const archive = execFileSync('git', ['-C', PROOF_AUTHORITY, 'archive', 'HEAD'], { maxBuffer: 256 * 1024 * 1024 });
  execFileSync('tar', ['-xf', '-', '-C', source], { input: archive, stdio: ['pipe', 'pipe', 'pipe'] });
  execFileSync('go', ['build', '-o', binary, './cmd/proof'], {
    cwd: source,
    env: { ...process.env, GOPROXY: 'off', GOSUMDB: 'off', GOTOOLCHAIN: 'local' },
    stdio: 'pipe',
  });
  rmSync(source, { recursive: true, force: true });
  return binary;
}

function makeAuthority(execFileSync: ExecFileSync, binary: string, root: string): Record<string, unknown> {
  const invoke = (args: string[], input: string): any => JSON.parse(execFileSync(binary, args, {
    cwd: root,
    input,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', GOPROXY: 'off', GOSUMDB: 'off', GOTOOLCHAIN: 'local' },
  }));
  const inventory = invoke(['onboarding', 'inventory'], '');
  const subject = { kind: 'project', id: inventory.authority.project_id, fingerprint: inventory.authority.subject_fingerprint };
  const projectInvocation = { role_id: 'onboard', stance: 'owner', subject, output_schema_id: 'proof.component-catalog-candidate@1', output_schema: SCHEMA };
  const resolved = invoke(['resolve-role-invocation'], JSON.stringify(projectInvocation));
  const candidatePayload = {
    version: 'proof.component-catalog-candidate/v1', project_id: inventory.authority.project_id,
    components: [
      { id: 'alpha', responsibility: 'alpha component', owned_paths: ['alpha.go'], dependency_closure: ['alpha.go'] },
      { id: 'beta', responsibility: 'beta component', owned_paths: ['beta.go'], dependency_closure: ['beta.go'] },
      { id: 'gamma', responsibility: 'gamma component', owned_paths: ['gamma.go'], dependency_closure: ['gamma.go'] },
    ],
  };
  const candidateText = proofJSON(candidatePayload);
  const candidateBytes = Buffer.from(candidateText, 'utf8');
  const scope = [{ Kind: 'keyed', ExpansionOwnerCheck: 'project', Key: inventory.authority.project_id, SubgraphInstanceID: bare('scope') }];
  const binding = { ManagedRunID: bare('managed'), SessionID: 'runtime-c0', CheckID: 'inspect', Scope: scope, NodeInstanceID: bare('node'), NodeGenerationID: bare('generation'), AttemptID: bare('attempt'), Fence: 1 };
  const publication = { Version: 1, Type: 'ClaimPublished', SessionID: binding.SessionID, CheckID: binding.CheckID, Scope: scope, NodeInstanceID: binding.NodeInstanceID, NodeGenerationID: binding.NodeGenerationID, AttemptID: binding.AttemptID, Fence: 1, ClaimID: bare('claim'), Claim: 'proof.candidate@1', PayloadFingerprint: createHash('sha256').update(candidateBytes).digest('hex'), ProducerCheckID: 'inspect', Payload: candidateBytes.toString('base64'), ParentClaimIDs: [bare('parent-a'), bare('parent-b')].sort() };
  const termination = { Version: 1, Type: 'ManagedRunTerminated', SessionID: binding.SessionID, Scope: scope, Binding: binding, CleanupStatus: 'clean', ControllerDecision: 'completed', FailureCode: null };
  const candidate = {
    Version: 'proof.role-result-candidate-envelope/v1', Invocation: projectInvocation, InvocationDigest: resolved.invocation_digest, RoleID: resolved.role_id, Stance: resolved.stance, Subject: resolved.subject,
    AttestationVersion: 'probe.governed-codex-attestation/v2', ExecutionSource: 'caller', ProbeInvocationDigest: resolved.invocation_digest,
    IdentityVersion: 'probe.governed-result-identity/v1', IdentitySource: 'probe-host-schema-valid-json', ResultDigest: domainDigest('probe.governed-result-identity/data/v1', candidateText), CanonicalBytes: candidateBytes.length,
    ProbeResultBytes: candidateBytes.toString('base64'), VisorPayloadBytes: candidateBytes.toString('base64'), Publication: publication, Binding: binding, Termination: termination,
  };
  const admissionWire = execFileSync(binary, ['admit-candidate'], {
    cwd: root,
    input: JSON.stringify({ version: 'proof.role-result-candidate-cli-request/v1', candidate }),
    encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', GOPROXY: 'off', GOSUMDB: 'off', GOTOOLCHAIN: 'local' },
  }).trimEnd();
  const admission = JSON.parse(admissionWire);
  expect(admission.status).toBe('ADMITTED');
  const revalidationInput = proofJSON({ version: 'proof.catalog-revalidation-request/v2', candidate: candidatePayload, admission });
  const revalidation = invoke(['onboarding', 'revalidate'], revalidationInput);
  const item = revalidation.work_items.find((value: any) => value.component_id === 'alpha');
  const row = revalidation.receipt.component_authorities.find((value: any) => value.component_id === 'alpha');
  if (!item || !row) throw new Error('real Proof revalidation omitted alpha authority');
  return {
    work_item_digest: row.work_item_digest,
    subject: row.subject,
    candidate: JSON.parse(candidateText),
    admission,
    work_item: item,
    catalog_revalidation_receipt: revalidation.receipt,
  };
}

function binding(): any {
  return {
    managedRunId: 'a'.repeat(64), sessionId: 'runtime-c0', checkId: 'inspect',
    scope: [{ kind: 'keyed', expansionOwnerCheck: 'project', key: 'journalservice', subgraphInstanceId: 'b'.repeat(64) }],
    nodeInstanceId: 'c'.repeat(64), nodeGenerationId: 'd'.repeat(64), attemptId: 'e'.repeat(64), fence: 1,
  };
}

function expectErrorCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect((error as { code?: string }).code).toBe(code);
  }
}

describe('runtime component C0 authority seam', () => {
  it('runs real pinned Proof C0 before a fake Probe and fails closed before Probe on malformed authority', async () => {
    jest.resetModules();
    jest.doMock('child_process', () => jest.requireActual('child_process'));
    jest.doMock('node:child_process', () => jest.requireActual('node:child_process'));
    const [{ execFileSync }, child, governed] = await Promise.all([
      import('node:child_process'),
      import('../../src/providers/proof-admission-cli-child'),
      import('../../src/providers/governed-proof-inspect-check-provider'),
    ]);
    expect(existsSync(PROOF_AUTHORITY)).toBe(true);
    const repository = mkdtempSync(join(tmpdir(), 'visor-runtime-c0-'));
    const root = join(repository, 'project'); mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'proof.yaml'), 'project:\n  name: journalservice\n', 'utf8');
    for (const name of ['alpha.go', 'beta.go', 'gamma.go']) writeFileSync(join(root, name), `package journal\n// ${name}\n`, 'utf8');
    execFileSync('git', ['init', '-q'], { cwd: repository });
    execFileSync('git', ['config', 'user.email', 'runtime-c0@example.invalid'], { cwd: repository });
    execFileSync('git', ['config', 'user.name', 'Runtime C0'], { cwd: repository });
    execFileSync('git', ['add', '.'], { cwd: repository });
    execFileSync('git', ['commit', '-qm', 'fixture'], { cwd: repository });
    let calls = 0;
    try {
      const binary = pinnedProofBinary(execFileSync);
      const authority = makeAuthority(execFileSync, binary, root);
      const capability = child.createProofAdmissionCapability(binary);
      const selector = {
        type: 'governed-proof-inspect', profile: PROFILE,
        invocation: { role_id: 'onboard', stance: 'owner', subject: { kind: 'component' }, output_schema_id: 'proof.findings/v1', output_schema: SCHEMA },
        consumes: [{ claim: 'component.work_item@1', as: 'component' }],
      };
      const fakeResult = (request: any) => {
        calls++;
        const data = { component_id: request.invocation.subject.id, status: 'ok' };
        const canonical = JSON.stringify(data);
        const digest = governed.governedResultDigest(data);
        return {
          data,
          runtimeAttestation: {
            version: 'probe.governed-codex-attestation/v2', profileId: PROFILE,
            requested: { profileDigest: 'a'.repeat(64), cwdDigest: 'a'.repeat(64), probeToolsDigest: 'a'.repeat(64), model: 'gpt-5.6-luna', reasoningEffort: 'xhigh', sandbox: 'read-only', approvalPolicy: 'never' },
            observed: { source: 'session_configured', model: 'gpt-5.6-luna', modelProviderId: 'openai', reasoningEffort: 'xhigh', approvalPolicy: 'never', cwdDigest: 'a'.repeat(64), permissionProfileDigest: 'a'.repeat(64), filesystem: 'restricted-read-root', network: 'restricted' },
            executionContext: { source: 'caller', invocationDigest: request.invocationDigest },
            dispatch: { source: 'probe-host-tools-call', tool: 'codex', promptDigest: `sha256:${'c'.repeat(64)}`, promptBytes: 0 },
            evidence: { eventCount: 1 }, usage: { status: 'unavailable' },
          },
          resultIdentity: { version: 'probe.governed-result-identity/v1', source: 'probe-host-schema-valid-json', resultDigest: digest, canonicalBytes: Buffer.byteLength(canonical, 'utf8') },
        };
      };
      const provider = governed.createGovernedProofInspectProviderForFocusedTest((request: any) => ({ answer: () => fakeResult(request), cancel: () => undefined, close: () => undefined }), capability);
      const componentClaim = { claimId: 'f'.repeat(64), claim: 'component.work_item@1', payload: { component_id: 'alpha', authority: { component_id: 'alpha', work_item_digest: authority.work_item_digest, subject: authority.subject } } };
      const run = provider.startManaged({ prInfo: {} as any, checkConfig: selector, dependencyResults: new Map(), executionContext: { claims: { component: componentClaim as any }, proofComponentAuthority: authority as any }, binding: binding(), executionConfigDigest: '1'.repeat(64), workingDirectory: root });
      await expect(run.started).resolves.toMatchObject({ kind: 'started' });
      const outcome: any = await run.outcome;
      expect(outcome.kind).toBe('succeeded-proof-candidate');
      expect(outcome.summary.output).toEqual({ component_id: 'alpha', status: 'ok' });
      expect(outcome.proofCandidateEvidence.role.invocation.component_authority).toEqual(authority);
      expect(governed.validateProofCandidateEvidence(outcome.proofCandidateEvidence)).toBeDefined();
      expect(calls).toBe(1);
      await run.close();

      const malformed = { ...authority, subject: { ...authority.subject, component_id: 'foreign' } };
      const rejected = provider.startManaged({ prInfo: {} as any, checkConfig: selector, dependencyResults: new Map(), executionContext: { claims: {}, proofComponentAuthority: malformed as any }, binding: binding(), executionConfigDigest: '1'.repeat(64), workingDirectory: root });
      await expect(rejected.outcome).rejects.toThrow(/PROOF_ADMISSION_UNAVAILABLE|GOVERNED_PROOF_INVALID|component authority/i);
      expect(calls).toBe(1);
      await rejected.close();

      const delayed = join(repository, 'delayed-proof');
      const delayedPid = join(repository, 'delayed-proof.pid');
      writeFileSync(delayed, `#!/usr/bin/env node
const fs = require('node:fs');
const { spawn } = require('node:child_process');
fs.writeFileSync(${JSON.stringify(delayedPid)}, String(process.pid));
setTimeout(() => {
  const child = spawn(${JSON.stringify(binary)}, process.argv.slice(2), { stdio: 'inherit' });
  child.once('exit', (code, signal) => process.exit(signal ? 1 : (code ?? 1)));
}, 300);
`, 'utf8');
      chmodSync(delayed, 0o755);
      const delayedProvider = governed.createGovernedProofInspectProviderForFocusedTest((request: any) => ({ answer: () => fakeResult(request), cancel: () => undefined, close: () => undefined }), child.createProofAdmissionCapability(delayed));
      const delayedRun = delayedProvider.startManaged({ prInfo: {} as any, checkConfig: selector, dependencyResults: new Map(), executionContext: { claims: { component: componentClaim as any }, proofComponentAuthority: authority as any }, binding: binding(), executionConfigDigest: '1'.repeat(64), workingDirectory: root });
      const deadline = Date.now() + 2000;
      while (!existsSync(delayedPid) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      expect(existsSync(delayedPid)).toBe(true);
      await expect(delayedRun.cancel('deadline', 1)).resolves.toMatchObject({ kind: 'cancelled' });
      await expect(delayedRun.outcome).rejects.toThrow();
      expect(calls).toBe(1);
      const pid = Number(readFileSync(delayedPid, 'utf8'));
      expect(() => process.kill(-pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
      await delayedRun.close();
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  }, 180000);

  it('assembles a materialized EXP-0209 component authority from the journal before real Proof C0', async () => {
    jest.resetModules();
    jest.doMock('child_process', () => jest.requireActual('child_process'));
    jest.doMock('node:child_process', () => jest.requireActual('node:child_process'));
    const [child, providers, admitModule, admittedModule, governed] = await Promise.all([
      import('../../src/providers/proof-admission-cli-child'),
      import('../../src/providers/proof-catalog-check-providers'),
      import('../../src/providers/proof-admit-check-provider'),
      import('../../src/providers/proof-admitted-catalog-check-provider'),
      import('../../src/providers/governed-proof-inspect-check-provider'),
    ]);
    expect(existsSync(PROOF_AUTHORITY)).toBe(true);
    const runSync = jest.requireActual<typeof import('node:child_process')>('node:child_process').execFileSync;
    const binary = pinnedProofBinary(runSync);
    const capability = child.createProofAdmissionCapability(binary);
    const repository = mkdtempSync(join(tmpdir(), 'visor-runtime-c0-journal-'));
    const root = join(repository, 'nested-project');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'proof.yaml'), 'project:\n  name: journalservice\n', 'utf8');
    for (const name of ['alpha.go', 'beta.go', 'gamma.go']) writeFileSync(join(root, name), `package journal\n// ${name}\n`, 'utf8');
    runSync('git', ['init', '-q'], { cwd: repository });
    runSync('git', ['config', 'user.email', 'runtime-journal@example.invalid'], { cwd: repository });
    runSync('git', ['config', 'user.name', 'Runtime Journal'], { cwd: repository });
    runSync('git', ['add', '.'], { cwd: repository });
    runSync('git', ['commit', '-qm', 'fixture'], { cwd: repository });
    try {
      const config: any = yaml.load(readFileSync(EXP0209_PROFILE, 'utf8'));
      config.checks.project.value.projects[0].root = root;
      const directInventory = JSON.parse(runSync(binary, ['onboarding', 'inventory'], {
        cwd: root, encoding: 'utf8', env: { ...process.env, PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', GOPROXY: 'off', GOSUMDB: 'off', GOTOOLCHAIN: 'local' },
      }));
      expect(directInventory.version).toBe('proof.structural-inventory/v1');
      const rootCheck = config.subgraphs['discover-project'].checks.inspect;
      const rootInvocation = {
        role_id: 'onboard', stance: 'owner',
        subject: { kind: 'project', id: directInventory.authority.project_id, fingerprint: directInventory.authority.subject_fingerprint },
        output_schema_id: rootCheck.invocation.output_schema_id, output_schema: rootCheck.invocation.output_schema,
      };
      const resolvedRoot = await child.resolveProofRoleInvocation(capability, rootInvocation, root);
      rootCheck.invocation = rootInvocation;
      rootCheck.instructions = resolvedRoot.instructions;
      rootCheck.invocation_digest = resolvedRoot.invocation_digest;
      rootCheck.result_schema = Buffer.from(rootInvocation.output_schema, 'base64').toString('utf8');
      const c0Schema = Buffer.from(JSON.stringify({ type: 'object', additionalProperties: false, required: ['component_id', 'status'], properties: { component_id: { type: 'string' }, status: { const: 'ok' } } }), 'utf8').toString('base64');
      config.subgraphs['onboard-component'].checks.inspect = {
        type: 'governed-proof-inspect', profile: PROFILE,
        invocation: { role_id: 'onboard', stance: 'owner', subject: { kind: 'component' }, output_schema_id: 'proof.findings/v1', output_schema: c0Schema },
        consumes: [{ claim: 'component.work_item@1', as: 'component' }], emits: [{ claim: 'proof.candidate@1', from: 'output' }],
      };
      config.subgraphs['onboard-component'].checks.proof_admit = {
        type: 'proof-admit', consumes: [{ claim: 'proof.candidate@1', as: 'candidate' }], emits: [{ claim: 'proof.admitted_receipt@1', from: 'output' }],
      };
      config.subgraphs['onboard-component'].checks.verify = {
        type: 'noop', consumes: [{ claim: 'proof.candidate@1', as: 'candidate' }, { claim: 'proof.admitted_receipt@1', as: 'receipt' }],
      };
      const plan = compileClaimPlan(config);
      const journal = new ExecutionJournal(plan);
      const sessionId = 'runtime-c0-journal-session';
      const completeManaged = async (nodeGenerationId: string, provider: any, dependencyResults = new Map<string, unknown>(), extra: Record<string, unknown> = {}) => {
        const execution = journal.getGeneratedExecution(nodeGenerationId);
        const attempt = journal.startGeneratedAttempt(nodeGenerationId);
        journal.scheduleGeneratedAttempt(attempt);
        const binding = journal.deriveManagedRunBinding(attempt);
        journal.recordManagedRunAcquired(binding);
        journal.recordManagedRunStarted(binding);
        const run = provider.startManaged({
          prInfo: {} as any, checkConfig: execution.node.check, dependencyResults, executionContext: { claims: execution.claims }, binding,
          executionConfigDigest: execution.node.executionConfigDigest, workingDirectory: root, ...extra,
        });
        await expect(run.started).resolves.toMatchObject({ kind: 'started' });
        const outcome: any = await run.outcome;
        expect(outcome.kind).toMatch(/^succeeded/);
        await expect(run.close()).resolves.toMatchObject({ status: 'clean', activeChildren: 0, activeResources: 0 });
        journal.completeManagedGeneratedAttempt({
          attempt, binding, payload: outcome.summary.output, executionConfigDigest: execution.node.executionConfigDigest,
          ...(outcome.proofCandidateEvidence ? { proofCandidateEvidence: outcome.proofCandidateEvidence, wireMode: outcome.wireMode } : {}),
        });
        return { execution, outcome };
      };
      const request = journal.requestCatalogReconciliation({ sessionId, ownerCheck: 'project' });
      const catalogAttempt = journal.startCatalogRequestAttempt(request.requestId);
      journal.scheduleCatalogRequestAttempt({ requestId: request.requestId, attemptId: catalogAttempt.attemptId, fence: catalogAttempt.fence });
      journal.completeAttempt({ sessionId, checkId: 'project', scope: [], attemptId: catalogAttempt.attemptId, fence: catalogAttempt.fence, payload: { projects: [{ project_id: directInventory.authority.project_id, root }] } });
      const inventoryGeneration = journal.queryReadyWork().find(value => value.checkId === 'structural_inventory')!;
      const structural = providers.createProofStructuralInventoryProviderFromCapability(capability);
      await completeManaged(inventoryGeneration.nodeGenerationId, structural);
      const inspectGeneration = journal.queryReadyWork().find(value => value.checkId === 'inspect')!;
      const candidateData = {
        version: 'proof.component-catalog-candidate/v1', project_id: directInventory.authority.project_id,
        components: [
          { id: 'alpha', responsibility: 'alpha component', owned_paths: ['alpha.go'], dependency_closure: ['alpha.go'], interfaces: [{ n: -0 }] },
          { id: 'beta', responsibility: 'beta component', owned_paths: ['beta.go'], dependency_closure: ['beta.go'] },
          { id: 'gamma', responsibility: 'gamma component', owned_paths: ['gamma.go'], dependency_closure: ['gamma.go'] },
        ],
      };
      const discovery = governed.createGovernedProofInspectProviderForFocusedTest(() => ({
        answer: (request: GovernedProbeRunnerRequest) => {
          const candidateText = proofJSON(candidateData);
          const candidateBytes = Buffer.from(candidateText, 'utf8');
          const digest = domainDigest('probe.governed-result-identity/data/v1', candidateText);
          const d = 'a'.repeat(64);
          return {
            data: candidateData,
            runtimeAttestation: {
              version: 'probe.governed-codex-attestation/v2', profileId: PROFILE,
              requested: { profileDigest: d, cwdDigest: d, probeToolsDigest: d, model: 'gpt-5.6-luna', reasoningEffort: 'xhigh', sandbox: 'read-only', approvalPolicy: 'never' },
              observed: { source: 'session_configured', model: 'gpt-5.6-luna', modelProviderId: 'openai', reasoningEffort: 'xhigh', approvalPolicy: 'never', cwdDigest: d, permissionProfileDigest: d, filesystem: 'restricted-read-root', network: 'restricted' },
              executionContext: { source: 'caller', invocationDigest: request.invocationDigest },
              dispatch: { source: 'probe-host-tools-call', tool: 'codex', promptDigest: `sha256:${d}`, promptBytes: 17 }, evidence: { eventCount: 1 }, usage: { status: 'unavailable' },
            },
            resultIdentity: { version: 'probe.governed-result-identity/v1', source: 'probe-host-schema-valid-json', resultDigest: digest, canonicalBytes: candidateBytes.length },
          };
        }, cancel: () => undefined, close: () => undefined,
      }));
      const inspectResult = await completeManaged(inspectGeneration.nodeGenerationId, discovery);
      const candidateOutput = inspectResult.outcome.summary.output;
      const admissionGeneration = journal.queryReadyWork().find(value => value.checkId === 'proof_admit')!;
      const admissionExecution = journal.getGeneratedExecution(admissionGeneration.nodeGenerationId);
      const admissionAttempt = journal.startGeneratedAttempt(admissionGeneration.nodeGenerationId);
      journal.scheduleGeneratedAttempt(admissionAttempt);
      const admissionBinding = journal.deriveManagedRunBinding(admissionAttempt);
      journal.recordManagedRunAcquired(admissionBinding);
      journal.recordManagedRunStarted(admissionBinding);
      const admissionRequest = journal.getProofAdmissionRequest(admissionGeneration.nodeGenerationId);
      const admissionProvider = admitModule.createProofAdmitProviderFromCapability(capability);
      const admissionRun = admissionProvider.startManaged({
        prInfo: {} as any, checkConfig: admissionExecution.node.check, dependencyResults: new Map([['inspect', { issues: [], output: candidateOutput }]]), executionContext: { claims: admissionExecution.claims }, binding: admissionBinding,
        executionConfigDigest: admissionExecution.node.executionConfigDigest, workingDirectory: root, proofAdmissionRequest: admissionRequest,
      });
      await expect(admissionRun.started).resolves.toMatchObject({ kind: 'started' });
      const admissionOutcome: any = await admissionRun.outcome;
      expect(admissionOutcome.kind).toBe('succeeded');
      await expect(admissionRun.close()).resolves.toMatchObject({ status: 'clean', activeChildren: 0, activeResources: 0 });
      journal.completeManagedGeneratedAttempt({ attempt: admissionAttempt, binding: admissionBinding, payload: admissionOutcome.summary.output, executionConfigDigest: admissionExecution.node.executionConfigDigest });
      const verifyGeneration = journal.queryReadyWork().find(value => value.checkId === 'verify')!;
      const verifyAttempt = journal.startGeneratedAttempt(verifyGeneration.nodeGenerationId);
      journal.scheduleGeneratedAttempt(verifyAttempt);
      journal.completeGeneratedAttempt({ attempt: verifyAttempt, payload: {} });
      const revalidationGeneration = journal.queryReadyWork().find(value => value.checkId === 'revalidate_catalog')!;
      // Journal-level guards: a reserved Proof revalidation cannot be
      // completed directly before its managed terminal, and a caller cannot
      // relabel a managed prefix as generic. Use isolated in-memory journal
      // forks because this prefix is intentionally not quiescent yet.
      const forkJournal = (source: any): any => {
        const fork = Object.create(Object.getPrototypeOf(source));
        for (const key of Object.keys(source)) {
          if (key === 'claimPlan') fork[key] = source[key];
          else if (key === 'attemptOrdinals' || key === 'requestOrdinals') fork[key] = new Map(source[key]);
          else fork[key] = JSON.parse(JSON.stringify(source[key]));
        }
        return fork;
      };
      const directJournal = forkJournal(journal);
      const directGeneration = directJournal.queryReadyWork().find(value => value.checkId === 'revalidate_catalog')!;
      const directAttempt = directJournal.startGeneratedAttempt(directGeneration.nodeGenerationId);
      directJournal.scheduleGeneratedAttempt(directAttempt);
      expectErrorCode(() => directJournal.completeGeneratedAttempt({ attempt: directAttempt, payload: {} }), 'MANAGED_TERMINAL_REQUIRED');
      const mismatchedJournal = forkJournal(journal);
      const mismatchedGeneration = mismatchedJournal.queryReadyWork().find(value => value.checkId === 'revalidate_catalog')!;
      const mismatchedAttempt = mismatchedJournal.startGeneratedAttempt(mismatchedGeneration.nodeGenerationId);
      mismatchedJournal.scheduleGeneratedAttempt(mismatchedAttempt);
      const mismatchedBinding = mismatchedJournal.deriveManagedRunBinding(mismatchedAttempt);
      mismatchedJournal.recordManagedRunAcquired(mismatchedBinding);
      mismatchedJournal.recordManagedRunStarted(mismatchedBinding);
      expectErrorCode(() => mismatchedJournal.completeManagedGeneratedAttempt({
        attempt: mismatchedAttempt,
        binding: mismatchedBinding,
        payload: {},
        executionConfigDigest: mismatchedGeneration.executionConfigDigest,
        wireMode: 'generic',
      }), 'INVALID_PROOF_EVIDENCE');
      const revalidator = providers.createProofCatalogRevalidationProviderFromCapability(capability);
      const revalidationResult = await completeManaged(revalidationGeneration.nodeGenerationId, revalidator);
      const materializeGeneration = journal.queryReadyWork().find(value => value.checkId === 'materialize_catalog')!;
      const materializer = admittedModule.createProofAdmittedCatalogProviderFromCapability(capability);
      const materializeExecution = journal.getGeneratedExecution(materializeGeneration.nodeGenerationId);
      await completeManaged(materializeGeneration.nodeGenerationId, materializer);
      const alphaGeneration: any = journal.queryReadyWork().find(value => value.templateNodeKey === 'inspect' && value.scope.length === 2 && journal.getGeneratedExecution(value.nodeGenerationId).claims.component?.payload.component_id === 'alpha');
      const componentGeneration: any = journal.queryReadyWork().find(value => value.templateNodeKey === 'inspect' && value.scope.length === 2 && journal.getGeneratedExecution(value.nodeGenerationId).claims.component?.payload.component_id === 'beta');
      expect(alphaGeneration).toBeDefined();
      expect(componentGeneration).toBeDefined();
      const authority = journal.getProofComponentInvocationAuthority(componentGeneration.nodeGenerationId);
      expect(authority.candidate).toEqual(expect.objectContaining({ version: 'proof.component-catalog-candidate/v1', project_id: directInventory.authority.project_id }));
      expect(authority.admission).toEqual(expect.objectContaining({ version: 'proof.role-result-candidate-cli-decision/v1', status: 'ADMITTED', receipt: expect.objectContaining({ Version: 'proof.role-result-candidate-admission/v2', Status: 'ADMITTED' }), reject_code: null }));
      expect(authority.work_item).toEqual(expect.objectContaining({ version: 'reqproof.onboarding-component-work-item/v1', component_id: 'beta' }));
      expect(authority.catalog_revalidation_receipt).toEqual(expect.objectContaining({ version: 'proof.catalog-revalidation-receipt/v2' }));

      // Pass A checkpoint harness: component proof_admit is Pass B, so terminalize
      // the ready inspect generation without activating any component descendants.
      // This leaves a quiescent journal while preserving the exact claims and
      // binding used below for the real Proof C0 invocation.
      let c0Attempt: ReturnType<ExecutionJournal['startGeneratedAttempt']> | undefined;
      let c0Binding: ReturnType<ExecutionJournal['deriveManagedRunBinding']> | undefined;
      // The compiled component template also has proof_admit/verify generations.
      // Keep Pass B unexecuted, but fail every ready component generation so the
      // checkpoint harness reaches the journal's required quiescent state.
      for (const readyComponent of journal.queryReadyWork().filter(value => value.scope.length === 2)) {
        const attempt = journal.startGeneratedAttempt(readyComponent.nodeGenerationId);
        journal.scheduleGeneratedAttempt(attempt);
        const binding = journal.deriveManagedRunBinding(attempt);
        if (readyComponent.nodeGenerationId === componentGeneration.nodeGenerationId) {
          c0Attempt = attempt;
          c0Binding = binding;
        }
        journal.failGeneratedAttempt(attempt, 'pass-a-checkpoint-harness');
      }
      expect(c0Attempt).toBeDefined();
      expect(c0Binding).toBeDefined();
      // The managed provider publishes a compact activation projection. The
      // aggregate authority retains only complete Proof WorkItems bytes, so
      // obtain that exact output from the pinned command and canonicalize it
      // with the production Proof serializer.
      const candidateClaim: any = materializeExecution.claims.candidate;
      const admissionClaim: any = materializeExecution.claims.receipt;
      const revalidationClaim: any = materializeExecution.claims.current_revalidation;
      const admissionDecision = JSON.parse((admissionClaim.payload as any).__proof_admission_wire);
      const workItemsRequest = (receipt: unknown) => `{"version":${proofCanonicalJson('proof.onboarding-work-items-request/v1')},"candidate":${proofCanonicalJson(candidateClaim.payload)},"admission":${proofCanonicalJson(admissionDecision)},"revalidation_receipt":${proofCanonicalJson(receipt)}}`;
      const runWorkItems = (receipt: unknown) => JSON.parse(runSync(binary, ['onboarding', 'work-items'], {
        cwd: root,
        input: workItemsRequest(receipt),
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', GOPROXY: 'off', GOSUMDB: 'off', GOTOOLCHAIN: 'local' },
      }));
      const historicalInstances = structuredClone(journal.getInstanceProjection().instancesById);
      const historicalNodes = structuredClone(journal.getInstanceProjection().nodesById);
      const historicalGenerations = structuredClone(journal.getInstanceProjection().generationsById);
      const historicalClaims = structuredClone(journal.getInstanceProjection().claimsById);
      const beforeAuthorityProjection = journal.getInstanceProjection();
      const eventsBeforeAuthority = journal.readRuntimeEvents();
      const checkpointBeforeAuthority = journal.exportGraphCheckpoint(sessionId);
      const historicalRevalidationBytes = proofCanonicalJson(revalidationResult.outcome.summary.output);
      const historicalWorkItems = runWorkItems((revalidationClaim.payload as any).receipt);
      const historicalWorkItemsBytes = proofCanonicalJson(historicalWorkItems);

      // C2a refresh harness: the historical candidate/admission remain fixed,
      // while one real workspace input changes before Proof revalidation.
      writeFileSync(join(root, 'alpha.go'), 'package journal\n// alpha.go changed for C2a\n', 'utf8');
      const refreshedRevalidation = JSON.parse(runSync(binary, ['onboarding', 'revalidate'], {
        cwd: root,
        input: proofJSON({ version: 'proof.catalog-revalidation-request/v2', candidate: candidateClaim.payload, admission: admissionDecision }),
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', GOPROXY: 'off', GOSUMDB: 'off', GOTOOLCHAIN: 'local' },
      }));
      const refreshedWorkItems = runWorkItems(refreshedRevalidation.receipt);
      // Preserve a valid Proof WorkItem with a signed zero in the actual
      // activation payload. The revalidation receipt authenticates its
      // production-compatible component WorkItem wire, so update that digest
      // and receipt ID rather than weakening validation.
      const signedZeroRevalidationItem = refreshedRevalidation.work_items.find((value: any) => value.component_id === 'alpha');
      const signedZeroWorkItemsItem = refreshedWorkItems.work_items.find((value: any) => value.component_id === 'alpha');
      expect(signedZeroRevalidationItem).toBeDefined();
      expect(signedZeroWorkItemsItem).toBeDefined();
      signedZeroRevalidationItem.proof_path_mapping.risk_tier = -0;
      signedZeroWorkItemsItem.proof_path_mapping.risk_tier = -0;
      const signedZeroDigest = `sha256:${createHash('sha256').update(goCompatibleProofJson(componentWorkItemWire(signedZeroRevalidationItem)), 'utf8').digest('hex')}`;
      const signedZeroAuthorityRow = refreshedRevalidation.receipt.component_authorities.find((value: any) => value.component_id === 'alpha');
      expect(signedZeroAuthorityRow).toBeDefined();
      signedZeroAuthorityRow.work_item_digest = signedZeroDigest;
      rederiveCatalogRevalidationReceiptID(refreshedRevalidation.receipt);
      const revalidationBytes = proofCanonicalJson(refreshedRevalidation);
      const workItemsBytes = proofCanonicalJson(refreshedWorkItems);
      const projectSubgraphInstanceId = journal.getInstanceProjection().instancesById[componentGeneration.subgraphInstanceId].parentSubgraphInstanceId!;
      const authorityEvent = journal.recordProofCurrentCatalogAuthority({ projectSubgraphInstanceId, revalidationBytes, workItemsBytes });
      expect(Object.keys(authorityEvent).sort()).toEqual([
        'authorityId', 'eventId', 'previousAuthorityId', 'projectSubgraphInstanceId', 'revalidationBytesBase64',
        'scope', 'sessionId', 'sourceCatalogClaimId', 'type', 'version', 'workItemsBytesBase64',
      ].sort());
      expect(authorityEvent.previousAuthorityId).toBe(authorityEvent.sourceCatalogClaimId);
      const authorityProjection: any = journal.getInstanceProjection().currentProofCatalogAuthorityByProject[projectSubgraphInstanceId];
      expect(authorityProjection.components).toHaveLength(3);
      expect(authorityProjection.components.map((row: any) => row.componentId)).toEqual(['alpha', 'beta', 'gamma']);
      expect(authorityProjection.components.map((row: any) => row.comparison)).toEqual(['changed', 'unchanged', 'unchanged']);
      expect(authorityEvent.authorityId).toBe(deriveProofCurrentCatalogAuthorityId(authorityEvent));
      const afterAuthorityProjection = journal.getInstanceProjection();
      expect(reduceInstanceEvent(beforeAuthorityProjection, authorityEvent)).toEqual(afterAuthorityProjection);
      expect(afterAuthorityProjection.instancesById).toEqual(historicalInstances);
      expect(afterAuthorityProjection.nodesById).toEqual(historicalNodes);
      expect(afterAuthorityProjection.generationsById).toEqual(historicalGenerations);
      expect(afterAuthorityProjection.claimsById).toEqual(historicalClaims);
      expect(journal.readRuntimeEvents().slice(0, eventsBeforeAuthority.length)).toEqual(eventsBeforeAuthority);
      expect(proofCanonicalJson(JSON.parse(Buffer.from(authorityEvent.revalidationBytesBase64, 'base64').toString('utf8')))).toBe(revalidationBytes);
      expect(proofCanonicalJson(JSON.parse(Buffer.from(authorityEvent.workItemsBytesBase64, 'base64').toString('utf8')))).toBe(workItemsBytes);
      expect(historicalRevalidationBytes).not.toBe(revalidationBytes);
      expect(historicalWorkItemsBytes).not.toBe(workItemsBytes);
      expect(journal.replayInstanceProjection()).toEqual(afterAuthorityProjection);
      expect(() => reduceInstanceEvent(beforeAuthorityProjection, { ...authorityEvent, unexpected: true } as any)).toThrow();
      const staleSource = { ...authorityEvent, sourceCatalogClaimId: '0'.repeat(64) };
      staleSource.authorityId = deriveProofCurrentCatalogAuthorityId(staleSource);
      expect(() => reduceInstanceEvent(beforeAuthorityProjection, staleSource)).toThrow();
      const staleSession = { ...authorityEvent, sessionId: 'foreign-session' };
      staleSession.authorityId = deriveProofCurrentCatalogAuthorityId(staleSession);
      expect(() => reduceInstanceEvent(beforeAuthorityProjection, staleSession)).toThrow();
      const beforeInvalidEvents = journal.readRuntimeEvents();
      const beforeInvalidProjection = journal.getInstanceProjection();
      const checkpointBeforeInvalid = journal.exportGraphCheckpoint(sessionId);
      expect(() => journal.recordProofCurrentCatalogAuthority({ projectSubgraphInstanceId, revalidationBytes: '{', workItemsBytes })).toThrow();
      expect(journal.readRuntimeEvents()).toEqual(beforeInvalidEvents);
      expect(journal.getInstanceProjection()).toEqual(beforeInvalidProjection);
      expect(journal.exportGraphCheckpoint(sessionId)).toEqual(checkpointBeforeInvalid);
      const secondAuthorityEvent = journal.recordProofCurrentCatalogAuthority({ projectSubgraphInstanceId, revalidationBytes, workItemsBytes });
      expect(secondAuthorityEvent.previousAuthorityId).toBe(authorityEvent.authorityId);
      expect(reduceInstanceEvent(afterAuthorityProjection, secondAuthorityEvent)).toEqual(journal.getInstanceProjection());
      // A predecessor authority can never be applied after a newer CAS
      // record, even while the graph is still quiescent.
      expect(() => journal.applyProofCurrentCatalogAuthority({ projectSubgraphInstanceId, authorityId: authorityEvent.authorityId })).toThrow(/stale|authority/i);
      const beforeApplyEvents = journal.readRuntimeEvents();
      const beforeApply = journal.getInstanceProjection();
      const applied = journal.applyProofCurrentCatalogAuthority({ projectSubgraphInstanceId, authorityId: secondAuthorityEvent.authorityId });
      expect(applied.mutationEventCount).toBeGreaterThan(0);
      expect(applied.mutationEventsDigest).toMatch(/^[0-9a-f]{64}$/);
      const afterApply = journal.getInstanceProjection();
      const appliedAuthorityBytes = JSON.parse(Buffer.from(
        afterApply.appliedProofCatalogAuthorityByProject[projectSubgraphInstanceId].revalidationBytesBase64,
        'base64'
      ).toString('utf8'));
      expect(Object.is(appliedAuthorityBytes.catalog.components.find((value: any) => value.id === 'alpha').interfaces[0].n, -0)).toBe(true);
      const appliedAlphaClaim = afterApply.claimsById[afterApply.instancesById[alphaGeneration.scope[1].subgraphInstanceId].activeItemClaimId!];
      expect(appliedAlphaClaim.wireMode).toBe('proof');
      expect(Object.is((appliedAlphaClaim.payload as any).proof_path_mapping?.risk_tier, -0)).toBe(true);
      // Beta is unchanged: its completed child keeps the original
      // historical authority across the changed-alpha apply.
      expect(journal.getProofComponentInvocationAuthority(componentGeneration.nodeGenerationId)).toEqual(authority);
      expect(afterApply.appliedProofCatalogAuthorityByProject[projectSubgraphInstanceId]).toEqual(
        expect.objectContaining({ authorityId: secondAuthorityEvent.authorityId })
      );
      expect(afterApply.instancesById[alphaGeneration.scope[1].subgraphInstanceId].incarnation).toBe(
        beforeApply.instancesById[alphaGeneration.scope[1].subgraphInstanceId].incarnation + 1
      );
      expect(afterApply.instancesById[componentGeneration.scope[1].subgraphInstanceId]).toEqual(
        beforeApply.instancesById[componentGeneration.scope[1].subgraphInstanceId]
      );
      const unchangedInstances = Object.values(beforeApply.instancesById).filter(instance =>
        instance.parentSubgraphInstanceId === projectSubgraphInstanceId && instance.itemKey !== 'alpha'
      );
      expect(unchangedInstances).toHaveLength(2);
      let unchangedGenerationCount = 0;
      for (const unchangedInstance of unchangedInstances) {
        const unchangedId = unchangedInstance.subgraphInstanceId;
        expect(afterApply.instancesById[unchangedId]).toEqual(unchangedInstance);
        for (const nodeInstanceId of Object.values(unchangedInstance.nodeInstanceIdsByTemplateNode)) {
          const generationId = beforeApply.activeGenerationIdByNode[nodeInstanceId];
          if (!generationId) continue;
          unchangedGenerationCount++;
          expect(afterApply.activeGenerationIdByNode[nodeInstanceId]).toBe(generationId);
          expect(afterApply.generationsById[generationId]).toEqual(beforeApply.generationsById[generationId]);
        }
        expect(Object.fromEntries(Object.entries(afterApply.claimsById).filter(([, claim]) => claim.subgraphInstanceId === unchangedId))).toEqual(
          Object.fromEntries(Object.entries(beforeApply.claimsById).filter(([, claim]) => claim.subgraphInstanceId === unchangedId))
        );
      }
      expect(unchangedGenerationCount).toBeGreaterThan(0);
      const alphaInstanceBefore = beforeApply.instancesById[alphaGeneration.scope[1].subgraphInstanceId];
      const alphaInstanceAfter = afterApply.instancesById[alphaGeneration.scope[1].subgraphInstanceId];
      expect(alphaInstanceAfter.subgraphInstanceId).toBe(alphaInstanceBefore.subgraphInstanceId);
      expect(alphaInstanceAfter.nodeInstanceIdsByTemplateNode).toEqual(alphaInstanceBefore.nodeInstanceIdsByTemplateNode);
      expect(alphaInstanceAfter.incarnation).toBe(alphaInstanceBefore.incarnation + 1);
      const readyAfterApply = journal.queryReadyWork().filter(value => value.scope.length === 2);
      expect(readyAfterApply).toHaveLength(1);
      expect(readyAfterApply[0].subgraphInstanceId).toBe(alphaGeneration.scope[1].subgraphInstanceId);
      expect(readyAfterApply[0].scheduled).toBe(false);
      expect(readyAfterApply[0].fence).toBeUndefined();
      expect(readyAfterApply[0].attemptId).toBeUndefined();
      const changedAuthority = journal.getProofComponentInvocationAuthority(readyAfterApply[0].nodeGenerationId);
      expect(changedAuthority.work_item).toEqual(expect.objectContaining({ component_id: 'alpha' }));
      expect(changedAuthority.catalog_revalidation_receipt).toEqual(expect.objectContaining({ version: 'proof.catalog-revalidation-receipt/v2' }));
      expect(journal.readRuntimeEvents().slice(0, beforeApplyEvents.length)).toEqual(beforeApplyEvents);
      const appliedEvents = journal.readRuntimeEvents();
      const appliedIndex = appliedEvents.findIndex(event => event.type === 'ProofCurrentCatalogAuthorityApplied');
      expect(appliedIndex).toBeGreaterThanOrEqual(0);
      const appliedMarker: any = appliedEvents[appliedIndex];
      const appliedGroup = appliedEvents.slice(appliedIndex, appliedIndex + appliedMarker.mutationEventCount + 1);
      const appliedController = appliedGroup.find((event: any) => event.type === 'ControllerItemClaimPublished');
      expect(appliedController).toBeDefined();
      expect(() => reduceInstanceEvent(beforeApply, appliedController as any)).toThrow();
      // Even if an attacker first gets one old generation inactivated, the
      // controller claim cannot be spliced in without the private validated
      // batch context. Model that already-reduced prefix with the authority
      // temporarily removed, then restore the live authority and retry.
      const firstInactivation = appliedGroup.find((event: any) => event.type === 'NodeGenerationInactivated');
      expect(firstInactivation).toBeDefined();
      const unprotectedPrefix = immutableInstanceProjection({
        ...beforeApply,
        currentProofCatalogAuthorityByProject: {},
        appliedProofCatalogAuthorityByProject: {},
        proofApplicationClaimIds: {},
      } as any);
      expect(() => reduceInstanceEvent(unprotectedPrefix, firstInactivation as any)).toThrow(/catalog|authority|application|generation/i);
      // Exercise the replacement with the real pinned Proof C0 admission
      // boundary before exporting the checkpoint.  The answer itself is
      // still a deterministic focused Probe answer; the subprocess and its
      // authenticated Proof candidate are real.
      let replacementC0Request: any;
      const replacementC0Provider = governed.createGovernedProofInspectProviderForFocusedTest((request: any) => ({
        answer: () => {
          replacementC0Request = request;
          const data = { component_id: request.invocation.subject.id, status: 'ok' };
          const bytes = canonicalJson(data);
          const d = 'a'.repeat(64);
          return {
            data,
            runtimeAttestation: {
              version: 'probe.governed-codex-attestation/v2', profileId: PROFILE,
              requested: { profileDigest: d, cwdDigest: d, probeToolsDigest: d, model: 'gpt-5.6-luna', reasoningEffort: 'xhigh', sandbox: 'read-only', approvalPolicy: 'never' },
              observed: { source: 'session_configured', model: 'gpt-5.6-luna', modelProviderId: 'openai', reasoningEffort: 'xhigh', approvalPolicy: 'never', cwdDigest: d, permissionProfileDigest: d, filesystem: 'restricted-read-root', network: 'restricted' },
              executionContext: { source: 'caller', invocationDigest: request.invocationDigest },
              dispatch: { source: 'probe-host-tools-call', tool: 'codex', promptDigest: `sha256:${'c'.repeat(64)}`, promptBytes: 0 }, evidence: { eventCount: 1 }, usage: { status: 'unavailable' },
            },
            resultIdentity: { version: 'probe.governed-result-identity/v1', source: 'probe-host-schema-valid-json', resultDigest: governed.governedResultDigest(data), canonicalBytes: Buffer.byteLength(bytes, 'utf8') },
          };
        }, cancel: () => undefined, close: () => undefined,
      }), capability);
      const replacementExecution = journal.getGeneratedExecution(readyAfterApply[0].nodeGenerationId);
      const replacementRun = replacementC0Provider.startManaged({
        prInfo: {} as any,
        checkConfig: replacementExecution.node.check,
        dependencyResults: new Map(),
        executionContext: { claims: replacementExecution.claims, proofComponentAuthority: changedAuthority },
        // C0 itself is exercised through the real pinned Proof capability;
        // keep this invocation side-effect free in the graph journal because
        // its focused answer intentionally is a findings payload, not the
        // component-catalog candidate emitted by the discovery inspect.
        binding: { ...binding(), nodeGenerationId: readyAfterApply[0].nodeGenerationId, nodeInstanceId: readyAfterApply[0].nodeInstanceId },
        executionConfigDigest: replacementExecution.node.executionConfigDigest,
        workingDirectory: root,
      });
      await expect(replacementRun.started).resolves.toMatchObject({ kind: 'started' });
      const replacementOutcome: any = await replacementRun.outcome;
      expect(replacementOutcome.kind).toBe('succeeded-proof-candidate');
      await expect(replacementRun.close()).resolves.toMatchObject({ status: 'clean', activeChildren: 0, activeResources: 0 });
      expect(replacementC0Request?.invocation.subject).toEqual({ kind: 'component', id: 'alpha', fingerprint: changedAuthority.subject.fingerprint });
      expect(replacementC0Request?.invocation.component_authority).toEqual(changedAuthority);
      // The unchanged components never enter the runner.  Leave the next
      // changed-stage generation terminal for checkpoint export.
      const preReplacementLifecycleEvents = journal.readRuntimeEvents();
      const previousFence = Math.max(0, ...preReplacementLifecycleEvents.map(event => 'fence' in event && typeof event.fence === 'number' ? event.fence : 0));
      let replacementLifecycleAttempt: any;
      for (const ready of journal.queryReadyWork().filter(value => value.scope.length === 2)) {
        const attempt = journal.startGeneratedAttempt(ready.nodeGenerationId);
        if (ready.subgraphInstanceId === alphaGeneration.scope[1].subgraphInstanceId) replacementLifecycleAttempt = attempt;
        journal.scheduleGeneratedAttempt(attempt);
        journal.failGeneratedAttempt(attempt, 'c2b-checkpoint-harness');
      }
      expect(replacementLifecycleAttempt?.fence).toBe(previousFence + 1);
      const replacementLifecycleEvents = journal.readRuntimeEvents().slice(preReplacementLifecycleEvents.length);
      expect(replacementLifecycleEvents.filter(event => event.type === 'AttemptStarted' && 'nodeGenerationId' in event)
        .map(event => (event as any).nodeGenerationId)).toEqual([replacementLifecycleAttempt.nodeGenerationId]);
      expect(replacementLifecycleEvents.filter(event => event.type === 'AttemptStarted' && 'nodeGenerationId' in event)
        .every(event => (event as any).scope[1].subgraphInstanceId === alphaGeneration.scope[1].subgraphInstanceId)).toBe(true);
      const afterReplacementLifecycle = journal.getInstanceProjection();
      const lifecycleAuthorityBytes = JSON.parse(Buffer.from(
        afterReplacementLifecycle.appliedProofCatalogAuthorityByProject[projectSubgraphInstanceId].revalidationBytesBase64,
        'base64'
      ).toString('utf8'));
      expect(Object.is(lifecycleAuthorityBytes.catalog.components.find((value: any) => value.id === 'alpha').interfaces[0].n, -0)).toBe(true);
      const lifecycleAlphaClaim = afterReplacementLifecycle.claimsById[afterReplacementLifecycle.instancesById[alphaGeneration.scope[1].subgraphInstanceId].activeItemClaimId!];
      expect(lifecycleAlphaClaim.wireMode).toBe('proof');
      expect(Object.is((lifecycleAlphaClaim.payload as any).proof_path_mapping?.risk_tier, -0)).toBe(true);
      const replayedAfterReplacementLifecycle = journal.replayInstanceProjection();
      const replayedAuthorityBytes = JSON.parse(Buffer.from(
        replayedAfterReplacementLifecycle.appliedProofCatalogAuthorityByProject[projectSubgraphInstanceId].revalidationBytesBase64,
        'base64'
      ).toString('utf8'));
      expect(Object.is(replayedAuthorityBytes.catalog.components.find((value: any) => value.id === 'alpha').interfaces[0].n, -0)).toBe(true);
      const replayedAlphaClaim = replayedAfterReplacementLifecycle.claimsById[replayedAfterReplacementLifecycle.instancesById[alphaGeneration.scope[1].subgraphInstanceId].activeItemClaimId!];
      expect(replayedAlphaClaim.wireMode).toBe('proof');
      expect(Object.is((replayedAlphaClaim.payload as any).proof_path_mapping?.risk_tier, -0)).toBe(true);
      // Once the replacement lifecycle is quiescent, a byte-identical
      // refresh is legal and emits a zero-mutation application. Persisted
      // Proof provenance must continue to select alpha's replacement claim;
      // unchanged beta remains on its original historical authority.
      const repeatedAuthorityEvent = journal.recordProofCurrentCatalogAuthority({
        projectSubgraphInstanceId,
        revalidationBytes,
        workItemsBytes,
      });
      const repeatedAuthorityProjection: any = journal.getInstanceProjection().currentProofCatalogAuthorityByProject[projectSubgraphInstanceId];
      expect(repeatedAuthorityProjection.components.map((row: any) => row.comparison)).toEqual(['unchanged', 'unchanged', 'unchanged']);
      expect(repeatedAuthorityProjection.components.find((row: any) => row.componentId === 'alpha').historicalItemClaimId)
        .toBe(journal.getInstanceProjection().instancesById[alphaGeneration.scope[1].subgraphInstanceId].activeItemClaimId);
      const repeatedApplied = journal.applyProofCurrentCatalogAuthority({
        projectSubgraphInstanceId,
        authorityId: repeatedAuthorityEvent.authorityId,
      });
      expect(repeatedApplied.mutationEventCount).toBe(0);
      const afterRepeatedApply = journal.getInstanceProjection();
      expect(afterRepeatedApply.appliedProofCatalogAuthorityByProject[projectSubgraphInstanceId]).toEqual(
        expect.objectContaining({ authorityId: repeatedAuthorityEvent.authorityId })
      );
      const repeatedChangedAuthority = journal.getProofComponentInvocationAuthority(readyAfterApply[0].nodeGenerationId);
      expect(repeatedChangedAuthority).toEqual(changedAuthority);
      expect(journal.getProofComponentInvocationAuthority(componentGeneration.nodeGenerationId)).toEqual(authority);
      expect(journal.replayInstanceProjection()).toEqual(afterRepeatedApply);
      expect(() => journal.applyProofCurrentCatalogAuthority({
        projectSubgraphInstanceId,
        authorityId: repeatedAuthorityEvent.authorityId,
      })).toThrow(/stale|already|authority/i);
      expect(() => journal.applyProofCurrentCatalogAuthority({ projectSubgraphInstanceId, authorityId: secondAuthorityEvent.authorityId })).toThrow();
      const stalePredecessor = { ...secondAuthorityEvent, previousAuthorityId: authorityEvent.sourceCatalogClaimId };
      stalePredecessor.authorityId = deriveProofCurrentCatalogAuthorityId(stalePredecessor);
      expect(() => reduceInstanceEvent(afterAuthorityProjection, stalePredecessor)).toThrow();
      const checkpoint = journal.exportGraphCheckpoint(sessionId);
      const canonicalCheckpointBytes = canonicalGraphCheckpointJson(checkpoint);
      const restoredFromCanonicalCheckpoint = ExecutionJournal.restoreGraphCheckpoint(
        plan,
        JSON.parse(canonicalCheckpointBytes)
      );
      const canonicalRestoredAuthorityBytes = JSON.parse(Buffer.from(
        restoredFromCanonicalCheckpoint.getInstanceProjection().appliedProofCatalogAuthorityByProject[projectSubgraphInstanceId].revalidationBytesBase64,
        'base64'
      ).toString('utf8'));
      expect(Object.is(canonicalRestoredAuthorityBytes.catalog.components.find((value: any) => value.id === 'alpha').interfaces[0].n, -0)).toBe(true);
      const canonicalRestoredProjection = restoredFromCanonicalCheckpoint.getInstanceProjection();
      const canonicalRestoredAlphaClaim = canonicalRestoredProjection.claimsById[canonicalRestoredProjection.instancesById[alphaGeneration.scope[1].subgraphInstanceId].activeItemClaimId!];
      expect(canonicalRestoredAlphaClaim.wireMode).toBe('proof');
      expect(Object.is((canonicalRestoredAlphaClaim.payload as any).proof_path_mapping?.risk_tier, -0)).toBe(true);
      expect(restoredFromCanonicalCheckpoint.getProofComponentInvocationAuthority(readyAfterApply[0].nodeGenerationId)).toEqual(repeatedChangedAuthority);
      expect(restoredFromCanonicalCheckpoint.getProofComponentInvocationAuthority(componentGeneration.nodeGenerationId)).toEqual(authority);

      const cloneValue = (value: any): any => Array.isArray(value)
        ? value.map(cloneValue)
        : value && typeof value === 'object'
          ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneValue(child)]))
          : value;
      const rehashCheckpoint = (value: any): any => {
        const body = {
          kind: value.kind,
          version: value.version,
          sessionId: value.sessionId,
          graphSemanticDigest: value.graphSemanticDigest,
          frontier: value.frontier,
          events: value.events,
        };
        value.integrity = { algorithm: 'sha256', digest: createHash('sha256').update(canonicalGraphCheckpointJson(body), 'utf8').digest('hex') };
        return value;
      };
      const renumberCheckpointEvents = (value: any): void => {
        value.events.forEach((event: any, index: number) => { event.eventId = index + 1; });
        value.frontier = { eventCount: value.events.length, lastEventId: value.events.length };
      };
      const appliedGroupInfo = (value: any): { index: number; marker: any; mutations: any[] } => {
        const index = value.events.findIndex((event: any) => event.type === 'ProofCurrentCatalogAuthorityApplied');
        expect(index).toBeGreaterThanOrEqual(0);
        const marker = value.events[index];
        return { index, marker, mutations: value.events.slice(index + 1, index + 1 + marker.mutationEventCount) };
      };
      const rederiveAppliedDigest = (value: any): void => {
        const { marker, mutations } = appliedGroupInfo(value);
        marker.mutationEventsDigest = deriveProofCurrentCatalogAuthorityMutationDigest({
          authorityId: marker.authorityId,
          mutations,
        });
      };
      // A separate pre-authority journal proves the no-op path independently
      // of the changed-alpha replacement above.  It must emit only the
      // aggregate marker (zero mutations), persist the exact Proof bytes, and
      // remain idempotent across replay and checkpoint restore.
      const unchangedJournal = ExecutionJournal.restoreGraphCheckpoint(plan, cloneValue(checkpointBeforeAuthority));
      const unchangedAuthorityEvent = unchangedJournal.recordProofCurrentCatalogAuthority({
        projectSubgraphInstanceId,
        revalidationBytes: historicalRevalidationBytes,
        workItemsBytes: historicalWorkItemsBytes,
      });
      const unchangedAuthorityProjection: any = unchangedJournal.getInstanceProjection().currentProofCatalogAuthorityByProject[projectSubgraphInstanceId];
      expect(unchangedAuthorityProjection.components.map((row: any) => row.comparison)).toEqual(['unchanged', 'unchanged', 'unchanged']);
      const unchangedApplied = unchangedJournal.applyProofCurrentCatalogAuthority({
        projectSubgraphInstanceId,
        authorityId: unchangedAuthorityEvent.authorityId,
      });
      expect(unchangedApplied.mutationEventCount).toBe(0);
      const unchangedAfterApply = unchangedJournal.getInstanceProjection();
      expect(unchangedAfterApply.appliedProofCatalogAuthorityByProject[projectSubgraphInstanceId]).toEqual(
        expect.objectContaining({
          authorityId: unchangedAuthorityEvent.authorityId,
          revalidationBytesBase64: unchangedAuthorityEvent.revalidationBytesBase64,
          workItemsBytesBase64: unchangedAuthorityEvent.workItemsBytesBase64,
        })
      );
      expect(unchangedJournal.replayInstanceProjection()).toEqual(unchangedAfterApply);
      expect(() => unchangedJournal.applyProofCurrentCatalogAuthority({
        projectSubgraphInstanceId,
        authorityId: unchangedAuthorityEvent.authorityId,
      })).toThrow(/stale|already|authority/i);
      const unchangedCheckpoint = unchangedJournal.exportGraphCheckpoint(sessionId);
      const unchangedRestored = ExecutionJournal.restoreGraphCheckpoint(plan, cloneValue(unchangedCheckpoint));
      expect(unchangedRestored.getInstanceProjection()).toEqual(unchangedAfterApply);
      expect(unchangedRestored.replayInstanceProjection()).toEqual(unchangedAfterApply);

      // Removing the atomic marker but preserving a perfectly contiguous
      // event prefix must still fail: the first inactivation is guarded by
      // the pending changed Proof authority.
      const strippedMarker = cloneValue(checkpoint) as any;
      const strippedInfo = appliedGroupInfo(strippedMarker);
      strippedMarker.events.splice(strippedInfo.index, 1);
      renumberCheckpointEvents(strippedMarker);
      rehashCheckpoint(strippedMarker);
      expect(() => ExecutionJournal.restoreGraphCheckpoint(plan, strippedMarker)).toThrow(/authority|application|catalog|generation|instance replay/i);

      // Proof lineage is immutable graph provenance. Removing both aggregate
      // authority records and the application marker must not downgrade the
      // retained first inactivation into a generic lifecycle event.
      const strippedProofAuthority = cloneValue(checkpoint) as any;
      strippedProofAuthority.events = strippedProofAuthority.events.filter((event: any) =>
        event.type !== 'ProofCurrentCatalogAuthorityRecorded' && event.type !== 'ProofCurrentCatalogAuthorityApplied'
      );
      expect(strippedProofAuthority.events.some((event: any) => event.type === 'NodeGenerationInactivated')).toBe(true);
      renumberCheckpointEvents(strippedProofAuthority);
      rehashCheckpoint(strippedProofAuthority);
      expect(() => ExecutionJournal.restoreGraphCheckpoint(plan, strippedProofAuthority)).toThrow(/authority|application|catalog|generation|instance replay/i);

      // A real EOF in the middle of the marker's suffix is rejected before
      // later events can make the graph appear quiescent.
      const truncatedSuffix = cloneValue(checkpoint) as any;
      const truncatedInfo = appliedGroupInfo(truncatedSuffix);
      expect(truncatedInfo.marker.mutationEventCount).toBeGreaterThan(1);
      truncatedSuffix.events = truncatedSuffix.events.slice(0, truncatedInfo.index + truncatedInfo.marker.mutationEventCount);
      renumberCheckpointEvents(truncatedSuffix);
      rehashCheckpoint(truncatedSuffix);
      expect(() => ExecutionJournal.restoreGraphCheckpoint(plan, truncatedSuffix)).toThrow(/truncated|authority|mutation|instance replay/i);

      // Reorder two valid mutations, then repair positional IDs and both
      // digests. Semantic batch grammar—not the outer hash—must reject it.
      const reorderedSuffix = cloneValue(checkpoint) as any;
      const reorderedInfo = appliedGroupInfo(reorderedSuffix);
      const firstMutationIndex = reorderedInfo.index + 1;
      [reorderedSuffix.events[firstMutationIndex], reorderedSuffix.events[firstMutationIndex + 1]] = [
        reorderedSuffix.events[firstMutationIndex + 1], reorderedSuffix.events[firstMutationIndex],
      ];
      renumberCheckpointEvents(reorderedSuffix);
      rederiveAppliedDigest(reorderedSuffix);
      rehashCheckpoint(reorderedSuffix);
      expect(() => ExecutionJournal.restoreGraphCheckpoint(plan, reorderedSuffix)).toThrow(/authority|mutation|generation|instance replay|checkpoint/i);

      // Add a duplicate valid mutation, repairing count, event positions and
      // aggregate integrity. The exact suffix grammar still rejects it.
      const extraMutation = cloneValue(checkpoint) as any;
      const extraInfo = appliedGroupInfo(extraMutation);
      extraMutation.events.splice(extraInfo.index + 2, 0, cloneValue(extraInfo.mutations[0]));
      extraMutation.events[extraInfo.index].mutationEventCount++;
      renumberCheckpointEvents(extraMutation);
      rederiveAppliedDigest(extraMutation);
      rehashCheckpoint(extraMutation);
      expect(() => ExecutionJournal.restoreGraphCheckpoint(plan, extraMutation)).toThrow(/authority|mutation|generation|instance replay|checkpoint/i);

      // Tamper the replacement WorkItem and repair every dependent generic
      // identity (claim, activation input, generation), aggregate digest, and
      // checkpoint digest. Validation must reach the authenticated Proof item
      // comparison rather than failing merely on a stale hash.
      const semanticPayloadTamper = cloneValue(checkpoint) as any;
      const semanticInfo = appliedGroupInfo(semanticPayloadTamper);
      const semanticController = semanticInfo.mutations.find((event: any) => event.type === 'ControllerItemClaimPublished' && event.claim === 'component.work_item@1');
      expect(semanticController).toBeDefined();
      const oldControllerClaimId = semanticController.claimId;
      semanticController.payload.authority.work_item_digest = `sha256:${'1'.repeat(64)}`;
      semanticController.payloadFingerprint = deriveItemFingerprint(semanticController.payload);
      semanticController.claimId = deriveControllerItemClaimId({
        claim: semanticController.claim,
        payloadFingerprint: semanticController.payloadFingerprint,
        expansionSpecDigest: semanticController.expansionSpecDigest,
        catalogClaimId: semanticController.catalogClaimId,
        subgraphInstanceId: semanticController.subgraphInstanceId,
        incarnation: semanticController.incarnation,
        scope: semanticController.scope,
      });
      const semanticActivation = semanticInfo.mutations.find((event: any) => event.type === 'NodeGenerationActivated' && event.templateNodeKey === 'inspect');
      expect(semanticActivation).toBeDefined();
      semanticActivation.activeInputClaimIds = semanticActivation.activeInputClaimIds.map((claimId: string) => claimId === oldControllerClaimId ? semanticController.claimId : claimId).sort();
      semanticActivation.itemFingerprint = semanticController.payloadFingerprint;
      semanticActivation.nodeGenerationId = deriveNodeGenerationId({
        nodeInstanceId: semanticActivation.nodeInstanceId,
        incarnation: semanticActivation.incarnation,
        itemFingerprint: semanticController.payloadFingerprint,
        executionConfigDigest: semanticActivation.executionConfigDigest,
        activeInputClaimIds: semanticActivation.activeInputClaimIds,
      });
      renumberCheckpointEvents(semanticPayloadTamper);
      rederiveAppliedDigest(semanticPayloadTamper);
      rehashCheckpoint(semanticPayloadTamper);
      expect(() => ExecutionJournal.restoreGraphCheckpoint(plan, semanticPayloadTamper)).toThrow(/authority|item|revalidation|instance replay|checkpoint/i);

      const tamperAppliedMarker = (mutate: (event: any) => void): any => {
        const tampered = cloneValue(checkpoint) as any;
        const marker = tampered.events.find((event: any) => event.type === 'ProofCurrentCatalogAuthorityApplied');
        expect(marker).toBeDefined();
        mutate(marker);
        return rehashCheckpoint(tampered);
      };
      expect(() => ExecutionJournal.restoreGraphCheckpoint(plan, tamperAppliedMarker(event => {
        event.mutationEventsDigest = '0'.repeat(64);
      }))).toThrow(/authority|mutation|digest|instance replay/i);
      expect(() => ExecutionJournal.restoreGraphCheckpoint(plan, tamperAppliedMarker(event => {
        event.mutationEventCount += 1;
      }))).toThrow(/authority|mutation|truncated|instance replay/i);
      const appliedEventIndex = checkpoint.events.findIndex(event => event.type === 'ProofCurrentCatalogAuthorityApplied');
      expect(appliedEventIndex).toBeGreaterThanOrEqual(0);
      const appliedEvent = checkpoint.events[appliedEventIndex] as any;
      const mutationEventIndex = appliedEventIndex + 1;
      const tamperAppliedMutation = (mutate: (events: any[]) => void): any => {
        const tampered = cloneValue(checkpoint) as any;
        mutate(tampered.events);
        return rehashCheckpoint(tampered);
      };
      expect(() => ExecutionJournal.restoreGraphCheckpoint(plan, tamperAppliedMutation(events => {
        events[mutationEventIndex].eventId += 1;
      }))).toThrow(/authority|event|mutation|instance replay/i);
      if (appliedEvent.mutationEventCount > 1) {
        expect(() => ExecutionJournal.restoreGraphCheckpoint(plan, tamperAppliedMutation(events => {
          const first = events[mutationEventIndex];
          events[mutationEventIndex] = events[mutationEventIndex + 1];
          events[mutationEventIndex + 1] = first;
        }))).toThrow(/authority|mutation|generation|instance replay|checkpoint|contiguous/i);
      }
      const tamperLastAuthority = (mutate: (event: any) => void): any => {
        const tampered = cloneValue(checkpoint) as any;
        const authorityEvents = tampered.events.filter((event: any) => event.type === 'ProofCurrentCatalogAuthorityRecorded');
        const last = authorityEvents[authorityEvents.length - 1];
        expect(last).toBeDefined();
        mutate(last);
        last.authorityId = deriveProofCurrentCatalogAuthorityId(last);
        return rehashCheckpoint(tampered);
      };
      const mutateSignedZeroAuthorityBytes = (event: any, field: 'revalidationBytesBase64' | 'workItemsBytesBase64'): void => {
        const decoded: any = JSON.parse(Buffer.from(event[field], 'base64').toString('utf8'));
        const component = decoded.catalog?.components?.find((value: any) => value.id === 'alpha');
        expect(component?.interfaces?.[0]?.n).toBeDefined();
        expect(Object.is(component.interfaces[0].n, -0)).toBe(true);
        component.interfaces[0].n = 0;
        event[field] = Buffer.from(proofCanonicalJson(decoded), 'utf8').toString('base64');
      };
      // Both persisted Proof-owned payloads are authenticated semantically,
      // not just by the outer checkpoint digest.  Rehashing a signed-zero
      // collapse must still fail the exact candidate/revalidation binding.
      expect(() => ExecutionJournal.restoreGraphCheckpoint(plan, tamperLastAuthority(event => mutateSignedZeroAuthorityBytes(event, 'revalidationBytesBase64')))).toThrow(/authority|revalidation|strict|instance replay/i);
      expect(() => ExecutionJournal.restoreGraphCheckpoint(plan, tamperLastAuthority(event => mutateSignedZeroAuthorityBytes(event, 'workItemsBytesBase64')))).toThrow(/authority|work-items|strict|instance replay/i);
      expect(() => ExecutionJournal.restoreGraphCheckpoint(plan, tamperLastAuthority(event => {
        event.sourceCatalogClaimId = '0'.repeat(64);
      }))).toThrow(/authority|catalog|source|instance replay/i);

      // The final checkpoint-level quiescence check is intentionally not
      // sufficient: this forged prefix terminalizes a request after the
      // aggregate event.  Restore must reject at the authority event boundary.
      const pendingJournal = ExecutionJournal.restoreGraphCheckpoint(plan, cloneValue(checkpointBeforeAuthority));
      const pendingRequest = pendingJournal.requestCatalogReconciliation({ sessionId, ownerCheck: 'project' });
      const pendingAttempt = pendingJournal.startCatalogRequestAttempt(pendingRequest.requestId);
      pendingJournal.scheduleCatalogRequestAttempt({ requestId: pendingRequest.requestId, attemptId: pendingAttempt.attemptId, fence: pendingAttempt.fence });
      const pendingFailure = pendingJournal.failAttempt({ sessionId, checkId: 'project', scope: [], attemptId: pendingAttempt.attemptId, fence: pendingAttempt.fence, reason: 'forged-terminal-after-authority' });
      const pendingTail = pendingJournal.readRuntimeEvents().slice(eventsBeforeAuthority.length);
      const pendingSetup = pendingTail.slice(0, -1);
      const forgedAuthority = { ...authorityEvent, eventId: eventsBeforeAuthority.length + pendingSetup.length + 1 };
      const forgedTerminal = { ...pendingFailure, eventId: forgedAuthority.eventId + 1 };
      const nonquiescent = cloneValue(checkpointBeforeAuthority) as any;
      nonquiescent.events = [...cloneValue(eventsBeforeAuthority), ...cloneValue(pendingSetup), forgedAuthority, forgedTerminal];
      nonquiescent.frontier = { eventCount: nonquiescent.events.length, lastEventId: nonquiescent.events.length };
      expect(() => ExecutionJournal.restoreGraphCheckpoint(plan, rehashCheckpoint(nonquiescent))).toThrow(/quiescent|started|pending|running/i);

      const restored = ExecutionJournal.restoreGraphCheckpoint(plan, cloneValue(checkpoint));
      const restoredAuthority = restored.getProofComponentInvocationAuthority(componentGeneration.nodeGenerationId);
      // Checkpoint restore must preserve the same historical authority for
      // unchanged beta; it must not relabel the completed child with the
      // changed-alpha aggregate's newer receipt.
      expect(restoredAuthority).toEqual(authority);
      expect(restored.getInstanceProjection().currentProofCatalogAuthorityByProject[projectSubgraphInstanceId]).toEqual(journal.getInstanceProjection().currentProofCatalogAuthorityByProject[projectSubgraphInstanceId]);
      const restoredComponentExecution = restored.getGeneratedExecution(componentGeneration.nodeGenerationId);
      const tampered: any = cloneValue(checkpoint);
      const workItemEvent = tampered.events.find((value: any) => value.type === 'ControllerItemClaimPublished' && value.claim === 'component.work_item@1' && value.payload.component_id === 'alpha');
      expect(workItemEvent).toBeDefined();
      workItemEvent.payload.authority.work_item_digest = `sha256:${'0'.repeat(64)}`;
      const checkpointBody = { kind: tampered.kind, version: tampered.version, sessionId: tampered.sessionId, graphSemanticDigest: tampered.graphSemanticDigest, frontier: tampered.frontier, events: tampered.events };
      tampered.integrity.digest = createHash('sha256').update(canonicalGraphCheckpointJson(checkpointBody), 'utf8').digest('hex');
      expect(() => ExecutionJournal.restoreGraphCheckpoint(plan, tampered)).toThrow();
      const tamperedAppliedPayload = cloneValue(checkpoint) as any;
      const appliedControllerEvent = tamperedAppliedPayload.events.slice(appliedEventIndex + 1, appliedEventIndex + appliedEvent.mutationEventCount + 1)
        .find((event: any) => event.type === 'ControllerItemClaimPublished');
      expect(appliedControllerEvent).toBeDefined();
      appliedControllerEvent.payload.authority.work_item_digest = `sha256:${'1'.repeat(64)}`;
      expect(() => ExecutionJournal.restoreGraphCheckpoint(plan, rehashCheckpoint(tamperedAppliedPayload))).toThrow(/authority|item|mutation|instance replay/i);
      let c0Request: GovernedProbeRunnerRequest | undefined;
      const c0Provider = governed.createGovernedProofInspectProviderForFocusedTest((request: GovernedProbeRunnerRequest) => ({
        answer: () => {
          c0Request = request;
          const data = { component_id: (request.invocation.subject as any).id, status: 'ok' };
          const bytes = canonicalJson(data);
          return {
            data,
            runtimeAttestation: {
              version: 'probe.governed-codex-attestation/v2', profileId: PROFILE,
              requested: { profileDigest: 'a'.repeat(64), cwdDigest: 'a'.repeat(64), probeToolsDigest: 'a'.repeat(64), model: 'gpt-5.6-luna', reasoningEffort: 'xhigh', sandbox: 'read-only', approvalPolicy: 'never' },
              observed: { source: 'session_configured', model: 'gpt-5.6-luna', modelProviderId: 'openai', reasoningEffort: 'xhigh', approvalPolicy: 'never', cwdDigest: 'a'.repeat(64), permissionProfileDigest: 'a'.repeat(64), filesystem: 'restricted-read-root', network: 'restricted' },
              executionContext: { source: 'caller', invocationDigest: request.invocationDigest },
              dispatch: { source: 'probe-host-tools-call', tool: 'codex', promptDigest: `sha256:${'c'.repeat(64)}`, promptBytes: 0 }, evidence: { eventCount: 1 }, usage: { status: 'unavailable' },
            },
            resultIdentity: { version: 'probe.governed-result-identity/v1', source: 'probe-host-schema-valid-json', resultDigest: governed.governedResultDigest(data), canonicalBytes: Buffer.byteLength(bytes, 'utf8') },
          };
        }, cancel: () => undefined, close: () => undefined,
      }), capability);
      const c0Run = c0Provider.startManaged({ prInfo: {} as any, checkConfig: restoredComponentExecution.node.check, dependencyResults: new Map(), executionContext: { claims: restoredComponentExecution.claims, proofComponentAuthority: restoredAuthority }, binding: c0Binding!, executionConfigDigest: restoredComponentExecution.node.executionConfigDigest, workingDirectory: root });
      await expect(c0Run.started).resolves.toMatchObject({ kind: 'started' });
      await expect(c0Run.outcome).resolves.toMatchObject({ kind: 'succeeded-proof-candidate' });
      expect(c0Request?.invocation).toEqual(expect.objectContaining({ subject: { kind: 'component', id: restoredAuthority.subject.component_id, fingerprint: restoredAuthority.subject.fingerprint }, component_authority: restoredAuthority }));
      await expect(c0Run.close()).resolves.toMatchObject({ status: 'clean', activeChildren: 0, activeResources: 0 });
    } finally {
      rmSync(repository, { recursive: true, force: true });
    }
  }, 180000);
});
