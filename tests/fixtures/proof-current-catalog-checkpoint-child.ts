import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as yaml from 'js-yaml';
import type { PRInfo } from '../../src/pr-analyzer';
import { StateMachineExecutionEngine } from '../../src/state-machine-execution-engine';
import { CheckProviderRegistry } from '../../src/providers/check-provider-registry';
import type { GovernedProbeRunnerRequest } from '../../src/providers/governed-proof-inspect-check-provider';
import {
  createGovernedProofInspectProviderForFocusedTest,
  proofGovernedResultDigest,
} from '../../src/providers/governed-proof-inspect-check-provider';
import { immutableProofCanonicalValue, proofCanonicalJson, proofPayloadFingerprint } from '../../src/providers/proof-wire';
import { canonicalGraphCheckpointJson, ExecutionJournal } from '../../src/snapshot-store';
import { compileClaimPlan } from '../../src/state-machine/graph/claim-plan';
import { canonicalJson, immutableCanonicalValue, sha256Canonical } from '../../src/state-machine/graph/claim-kernel';
import { deriveProofCurrentCatalogAuthorityMutationDigest } from '../../src/state-machine/graph/instance-kernel';

const ROOT = path.resolve(__dirname, '../..');
const PROFILE_PATH = path.resolve(__dirname, '../../examples/agent-governance/exp-0209-discovery-egress/visor.yaml');
const PINNED_PROOF_COMMIT = 'b6662983f50d58c4fdede138fc0585627bd8cf8c';
const PROFILE = 'luna-xhigh-readonly-v1';
let proofBuildDirectory: string | undefined;
let proofBinaryPath: string | undefined;
const prInfo = {
  number: 1,
  title: 'Proof current catalog checkpoint',
  author: 'fixture',
  base: 'main',
  head: 'changed',
  files: [],
  totalAdditions: 0,
  totalDeletions: 0,
  eventType: 'manual',
} as PRInfo;

function domainDigest(domain: string, value: string): string {
  const bytes = Buffer.from(value, 'utf8');
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  return `sha256:${createHash('sha256').update(domain).update(Buffer.from([0])).update(length).update(bytes).digest('hex')}`;
}

const COMPONENT_FILES = ['alpha.go', 'beta.go', 'gamma.go'] as const;

function sourceDigests(root: string): Record<string, string> {
  return Object.fromEntries(COMPONENT_FILES.map(name => [
    name,
    createHash('sha256').update(fs.readFileSync(path.join(root, name))).digest('hex'),
  ]));
}

function checkpointWithEvents(checkpoint: any, events: any[]): any {
  const body = {
    kind: checkpoint.kind,
    version: checkpoint.version,
    sessionId: checkpoint.sessionId,
    graphSemanticDigest: checkpoint.graphSemanticDigest,
    frontier: { eventCount: events.length, lastEventId: events.length ? events[events.length - 1].eventId : 0 },
    events,
  };
  const integrity = createHash('sha256').update(canonicalGraphCheckpointJson(body), 'utf8').digest('hex');
  return { ...body, integrity: { algorithm: 'sha256', digest: integrity } };
}

function errorHasCode(error: unknown, code: string): boolean {
  let current: any = error;
  for (let depth = 0; current && depth < 6; depth++, current = current.cause) {
    if (current.code === code) return true;
  }
  return false;
}

function replaceClaimReferences(value: any, oldClaimId: string, newClaimId: string): any {
  if (typeof value === 'string' || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(item => replaceClaimReferences(item, oldClaimId, newClaimId));
  const result: Record<string, any> = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    if (childKey === 'claimId' && typeof childValue === 'string') {
      result[childKey] = childValue === oldClaimId ? newClaimId : childValue;
    } else if (['claimIds', 'outputClaimIds', 'parentClaimIds', 'completedOutputClaimIds'].includes(childKey)) {
      result[childKey] = (childValue as any[]).map(item => item === oldClaimId ? newClaimId : item);
    } else {
      result[childKey] = replaceClaimReferences(childValue, oldClaimId, newClaimId);
    }
  }
  return result;
}

function standaloneProjectReconciliationInactivation(checkpoint: any, projection: any): any {
  const project = Object.values(projection.instancesById).find((value: any) => value.itemKey === 'journalservice' && !value.parentSubgraphInstanceId) as any;
  const generation = Object.values(projection.generationsById).find((value: any) =>
    (value as any).subgraphInstanceId === project?.subgraphInstanceId &&
    (value as any).checkId === 'project_reconcile' &&
    (value as any).status === 'completed' &&
    projection.activeGenerationIdByNode[(value as any).nodeInstanceId] === (value as any).nodeGenerationId,
  ) as any;
  if (!project || !generation) throw new Error('continued project_reconcile generation missing for negative');
  const event = {
    version: 1,
    type: 'NodeGenerationInactivated',
    eventId: checkpoint.events.length + 1,
    sessionId: checkpoint.sessionId,
    scope: generation.scope,
    subgraphInstanceId: generation.subgraphInstanceId,
    nodeInstanceId: generation.nodeInstanceId,
    nodeGenerationId: generation.nodeGenerationId,
    incarnation: generation.incarnation,
    outputClaimIds: [...generation.completedOutputClaimIds].sort(),
    reason: 'superseded',
  };
  return checkpointWithEvents(checkpoint, [...checkpoint.events, event]);
}

function rebindRetiredProjectReceipt(checkpoint: any, projection: any): any {
  const retired = Object.values(projection.claimsById).find((value: any) =>
    value.claim === 'proof.project_reconciliation_receipt@1' && value.active === false,
  ) as any;
  if (!retired) throw new Error('retired project reconciliation receipt missing for negative');
  const eventIndex = checkpoint.events.findIndex((event: any) => event.type === 'ClaimPublished' && event.claimId === retired.claimId);
  if (eventIndex < 0) throw new Error('retired project reconciliation receipt event missing for negative');
  const original = checkpoint.events[eventIndex];
  const payload = immutableProofCanonicalValue({
    ...original.payload,
    component_admissions: original.payload.component_admissions.map((value: any, index: number) =>
      index === 0 ? { ...value, candidate_id: 'sha256:' + 'f'.repeat(64) } : value,
    ),
  });
  const payloadFingerprint = proofPayloadFingerprint(payload);
  const replacementClaimId = sha256Canonical({
    claim: original.claim,
    payloadFingerprint,
    producerCheckId: original.checkId,
    scope: original.scope,
    attemptId: original.attemptId,
    fence: original.fence,
    parentClaimIds: original.parentClaimIds,
  });
  if (replacementClaimId === retired.claimId) throw new Error('retired receipt rebind did not change claim identity');
  const events = checkpoint.events.map((event: any) => replaceClaimReferences(event, retired.claimId, replacementClaimId));
  events[eventIndex] = {
    ...events[eventIndex],
    payload,
    payloadFingerprint,
    claimId: replacementClaimId,
  };
  const headerIndex = events.findIndex((event: any) => event.type === 'ProofCurrentCatalogAuthorityApplied');
  if (headerIndex < 0) throw new Error('continued Proof authority application marker missing for negative');
  const header = events[headerIndex];
  const mutations = events.slice(headerIndex + 1, headerIndex + 1 + header.mutationEventCount);
  events[headerIndex] = {
    ...header,
    mutationEventsDigest: deriveProofCurrentCatalogAuthorityMutationDigest({ authorityId: header.authorityId, mutations }),
  };
  return checkpointWithEvents(checkpoint, events);
}

function fakeDiscovery(request: GovernedProbeRunnerRequest): unknown {
  const data = immutableProofCanonicalValue({
    version: 'proof.component-catalog-candidate/v1',
    project_id: 'journalservice',
    components: [
      { id: 'alpha', responsibility: 'HTTP adapter', owned_paths: ['alpha.go'], dependency_closure: ['alpha.go'], interfaces: [{ name: 'HTTP' }, { n: -0 }] },
      { id: 'beta', responsibility: 'service policy', owned_paths: ['beta.go'], dependency_closure: ['beta.go'], interfaces: [{ name: 'Policy' }] },
      { id: 'gamma', responsibility: 'storage domain', owned_paths: ['gamma.go'], dependency_closure: ['gamma.go'], interfaces: [{ name: 'Store' }] },
    ],
  });
  const d = 'a'.repeat(64);
  return {
    data,
    runtimeAttestation: {
      version: 'probe.governed-codex-attestation/v2', profileId: PROFILE,
      requested: { profileDigest: d, cwdDigest: d, probeToolsDigest: d, model: 'gpt-5.6-luna', reasoningEffort: 'xhigh', sandbox: 'read-only', approvalPolicy: 'never' },
      observed: { source: 'session_configured', model: 'gpt-5.6-luna', modelProviderId: 'openai', reasoningEffort: 'xhigh', approvalPolicy: 'never', cwdDigest: d, permissionProfileDigest: d, filesystem: 'restricted-read-root', network: 'restricted' },
      executionContext: { source: 'caller', invocationDigest: request.invocationDigest },
      dispatch: { source: 'probe-host-tools-call', tool: 'codex', promptDigest: `sha256:${d}`, promptBytes: 0 },
      evidence: { eventCount: 1 }, usage: { status: 'unavailable' },
    },
    resultIdentity: { version: 'probe.governed-result-identity/v1', source: 'probe-host-schema-valid-json', resultDigest: proofGovernedResultDigest(data), canonicalBytes: Buffer.byteLength(proofCanonicalJson(data), 'utf8') },
  };
}

function fakeComponent(request: GovernedProbeRunnerRequest): unknown {
  const authority = request.invocation.component_authority as Record<string, any>;
  const subject = authority.subject as Record<string, any>;
  const coordinate = (value: string) => ({ path: value, line: 1 });
  const reviewedFiles = subject.sorted_owned_paths.map((value: string) => ({ path: value, coordinates: [coordinate(value)] }));
  const data = immutableCanonicalValue({
    schema: 'reqproof.component-onboarding/v1', project: subject.project_id, shard: subject.component_id,
    reviewedFiles,
    requirements: ['STK', 'SYS', 'SW', 'INT'].map((kind, index) => ({ id: `${kind}-${subject.component_id}-${index + 1}`, text: `${kind} evidence`, coordinates: [coordinate(subject.sorted_owned_paths[0])] })),
    interfaces: [{ name: `${subject.component_id}-boundary`, coordinates: [coordinate(subject.sorted_owned_paths[0])] }],
    findings: [{ id: `finding-${subject.component_id}`, severity: 'info', title: 'No blocking finding', calibration: 'confirmed', confidence: 1, coordinates: [coordinate(subject.sorted_owned_paths[0])] }],
    unknowns: [], repositoryMutated: false, commandsExecuted: false, checklistCompleted: false,
  });
  const d = 'a'.repeat(64);
  return {
    data,
    runtimeAttestation: {
      version: 'probe.governed-codex-attestation/v2', profileId: PROFILE,
      requested: { profileDigest: d, cwdDigest: d, probeToolsDigest: d, model: 'gpt-5.6-luna', reasoningEffort: 'xhigh', sandbox: 'read-only', approvalPolicy: 'never' },
      observed: { source: 'session_configured', model: 'gpt-5.6-luna', modelProviderId: 'openai', reasoningEffort: 'xhigh', approvalPolicy: 'never', cwdDigest: d, permissionProfileDigest: d, filesystem: 'restricted-read-root', network: 'restricted' },
      executionContext: { source: 'caller', invocationDigest: request.invocationDigest },
      dispatch: { source: 'probe-host-tools-call', tool: 'codex', promptDigest: `sha256:${d}`, promptBytes: 0 },
      evidence: { eventCount: 1 }, usage: { status: 'unavailable' },
    },
    resultIdentity: { version: 'probe.governed-result-identity/v1', source: 'probe-host-schema-valid-json', resultDigest: domainDigest('probe.governed-result-identity/data/v1', canonicalJson(data)), canonicalBytes: Buffer.byteLength(canonicalJson(data), 'utf8') },
  };
}

function proofSourceRepository(): string {
  const configured = process.env.VISOR_PROOF_SOURCE_REPO;
  return configured ? path.resolve(configured) : path.resolve(ROOT, '../reqforge');
}

function cleanupProofBuild(): void {
  if (!proofBuildDirectory) return;
  fs.rmSync(proofBuildDirectory, { recursive: true, force: true });
  proofBuildDirectory = undefined;
  proofBinaryPath = undefined;
}

function proofBinary(): string {
  if (proofBinaryPath) return proofBinaryPath;
  const repository = proofSourceRepository();
  try {
    execFileSync('git', ['-C', repository, 'cat-file', '-e', `${PINNED_PROOF_COMMIT}^{commit}`], { stdio: 'pipe' });
  } catch (error) {
    throw new Error(`Proof source repository ${repository} does not contain pinned commit ${PINNED_PROOF_COMMIT}`, { cause: error });
  }
  proofBuildDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-c2c-proof-build-'));
  const source = path.join(proofBuildDirectory, 'source');
  fs.mkdirSync(source);
  proofBinaryPath = path.join(proofBuildDirectory, 'proof');
  try {
    const archive = execFileSync('git', ['-C', repository, 'archive', '--format=tar', PINNED_PROOF_COMMIT], { maxBuffer: 256 * 1024 * 1024 });
    execFileSync('tar', ['-xf', '-', '-C', source], { input: archive, stdio: ['pipe', 'pipe', 'pipe'] });
    execFileSync('go', ['build', '-o', proofBinaryPath, './cmd/proof'], { cwd: source, env: { ...process.env, GOPROXY: 'off', GOSUMDB: 'off', GOTOOLCHAIN: 'local' }, stdio: 'pipe' });
    return proofBinaryPath;
  } catch (error) {
    cleanupProofBuild();
    throw error;
  }
}

function configFor(root: string): any {
  const config = yaml.load(fs.readFileSync(PROFILE_PATH, 'utf8')) as any;
  config.checks.project.value.projects[0].root = root;
  return config;
}

function installFakeProbe(
  capability: object,
  calls: string[],
  probeDispatches: Array<{ kind: 'project' | 'component'; componentId?: string }>,
): () => void {
  const registry = CheckProviderRegistry.getInstance();
  const providers = Object.getOwnPropertyDescriptor(registry as any, 'providers')!.value as Map<string, unknown>;
  const previous = providers.get('governed-proof-inspect');
  const fake = createGovernedProofInspectProviderForFocusedTest((request: GovernedProbeRunnerRequest) => ({
    answer: async () => {
      const kind = (request.invocation.subject as Record<string, unknown>).kind;
      if (kind === 'project') {
        probeDispatches.push({ kind: 'project' });
        return fakeDiscovery(request);
      }
      const componentId = ((request.invocation.component_authority as any).subject.component_id) as string;
      calls.push(componentId);
      probeDispatches.push({ kind: 'component', componentId });
      return fakeComponent(request);
    },
    cancel: () => undefined,
    close: () => undefined,
  }), capability);
  providers.set('governed-proof-inspect', fake);
  return () => {
    if (previous) providers.set('governed-proof-inspect', previous);
    else providers.delete('governed-proof-inspect');
    CheckProviderRegistry.clearInstance();
  };
}

function invoke(binary: string, root: string, args: string[], input: string): any {
  return JSON.parse(execFileSync(binary, args, {
    cwd: root, input, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', GOPROXY: 'off', GOSUMDB: 'off', GOTOOLCHAIN: 'local' },
  }));
}

function setupConfig(config: any, binary: string, root: string, capability: any): void {
  const inventory = invoke(binary, root, ['onboarding', 'inventory'], '');
  const rootCheck = config.subgraphs['discover-project'].checks.inspect;
  const invocation = {
    role_id: 'onboard', stance: 'owner',
    subject: { kind: 'project', id: inventory.authority.project_id, fingerprint: inventory.authority.subject_fingerprint },
    output_schema_id: rootCheck.invocation.output_schema_id, output_schema: rootCheck.invocation.output_schema,
  };
  const resolved = JSON.parse(execFileSync(binary, ['resolve-role-invocation'], { cwd: root, input: JSON.stringify(invocation), encoding: 'utf8' }));
  rootCheck.invocation = invocation;
  rootCheck.instructions = resolved.instructions;
  rootCheck.invocation_digest = resolved.invocation_digest;
  rootCheck.result_schema = Buffer.from(invocation.output_schema, 'base64').toString('utf8');
  return capability;
}

async function produce(directory: string): Promise<void> {
  const repository = path.join(directory, 'repository');
  const root = path.join(repository, 'nested-project');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'proof.yaml'), 'project:\n  name: journalservice\n', 'utf8');
  for (const name of ['alpha.go', 'beta.go', 'gamma.go']) fs.writeFileSync(path.join(root, name), `package journal\n// ${name}\n`, 'utf8');
  execFileSync('git', ['init', '-q'], { cwd: repository });
  execFileSync('git', ['config', 'user.email', 'c2c@example.invalid'], { cwd: repository });
  execFileSync('git', ['config', 'user.name', 'C2c fixture'], { cwd: repository });
  execFileSync('git', ['add', '.'], { cwd: repository });
  execFileSync('git', ['commit', '-qm', 'c2c baseline'], { cwd: repository });
  const binary = proofBinary();
  const capability = require('../../src/providers/proof-admission-cli-child').createProofAdmissionCapability(binary);
  const config = configFor(root);
  setupConfig(config, binary, root, capability);
  const registry = CheckProviderRegistry.getInstance();
  registry.bootstrapProofAdmission(capability);
  const calls: string[] = [];
  const probeDispatches: Array<{ kind: 'project' | 'component'; componentId?: string }> = [];
  const restore = installFakeProbe(capability, calls, probeDispatches);
  try {
    const engine = new StateMachineExecutionEngine(root);
    const result = await engine.executeGroupedChecks(prInfo, ['project'], undefined, config, 'json', false, 3);
    const context = (engine as any)._lastContext;
    const projection = context.journal.getInstanceProjection();
    const checkpoint = context.journal.exportGraphCheckpoint(context.sessionId);
    const project = Object.values(projection.instancesById).find((value: any) => value.itemKey === 'journalservice' && !value.parentSubgraphInstanceId) as any;
    const reconciliationGeneration = Object.values(projection.generationsById).find((value: any) =>
      (value as any).subgraphInstanceId === project.subgraphInstanceId &&
      (value as any).checkId === 'project_reconcile' &&
      (value as any).status === 'completed',
    ) as any;
    if (!reconciliationGeneration) throw new Error('baseline project_reconcile generation missing');
    fs.writeFileSync(path.join(directory, 'baseline.json'), JSON.stringify({
      pid: process.pid,
      checkpoint: canonicalGraphCheckpointJson(checkpoint),
      projection,
      config,
      prInfo,
      projectSubgraphInstanceId: project.subgraphInstanceId,
      calls,
      probeDispatches,
      sourceDigests: sourceDigests(root),
      projectReconciliationRequest: context.journal.getProofProjectReconciliationRequest(reconciliationGeneration.nodeGenerationId),
      result,
    }), 'utf8');
  } finally {
    restore();
  }
}

async function continueFrom(directory: string): Promise<void> {
  const source = JSON.parse(fs.readFileSync(path.join(directory, 'baseline.json'), 'utf8'));
  const checkpoint = JSON.parse(source.checkpoint);
  const config = source.config;
  const root = config.checks.project.value.projects[0].root;
  const sourceBefore = sourceDigests(root);
  fs.writeFileSync(path.join(root, 'alpha.go'), 'package journal\n// alpha.go changed\n', 'utf8');
  const sourceAfter = sourceDigests(root);
  const editedPaths = COMPONENT_FILES.filter(name => sourceBefore[name] !== sourceAfter[name]);
  const binary = proofBinary();
  const candidateEvent = checkpoint.events.find((event: any) => event.type === 'ClaimPublished' && event.claim === 'proof.candidate@1' && event.scope.length === 1);
  const admissionEvent = checkpoint.events.find((event: any) => event.type === 'ClaimPublished' && event.claim === 'proof.admitted_receipt@1' && event.scope.length === 1);
  if (!candidateEvent || !admissionEvent) throw new Error('baseline Proof candidate/admission missing');
  const admission = JSON.parse(admissionEvent.payload.__proof_admission_wire);
  const request = proofCanonicalJson({ version: 'proof.catalog-revalidation-request/v2', candidate: candidateEvent.payload, admission });
  const revalidation = invoke(binary, root, ['onboarding', 'revalidate'], request);
  // Proof's Go decoder intentionally compares the request to its struct-field
  // order.  Preserve the exact admission wire emitted by the prior Proof
  // command while canonicalizing the other Proof values.
  const workItemsRequest = `{"version":${proofCanonicalJson('proof.onboarding-work-items-request/v1')},"candidate":${proofCanonicalJson(candidateEvent.payload)},"admission":${admissionEvent.payload.__proof_admission_wire},"revalidation_receipt":${proofCanonicalJson(revalidation.receipt)}}`;
  const workItems = invoke(binary, root, ['onboarding', 'work-items'], workItemsRequest);
  const revalidationBytes = proofCanonicalJson(revalidation);
  const workItemsBytes = proofCanonicalJson(workItems);
  const capability = require('../../src/providers/proof-admission-cli-child').createProofAdmissionCapability(binary);
  const registry = CheckProviderRegistry.getInstance();
  registry.bootstrapProofAdmission(capability);
  const calls: string[] = [];
  const probeDispatches: Array<{ kind: 'project' | 'component'; componentId?: string }> = [];
  const restore = installFakeProbe(capability, calls, probeDispatches);
  try {
    const engine = new StateMachineExecutionEngine(root);
    const continued = await engine.continueProofCurrentCatalogCheckpoint({ checkpoint, projectSubgraphInstanceId: source.projectSubgraphInstanceId, revalidationBytes, workItemsBytes, config, prInfo: source.prInfo, maxParallelism: 3 });
    const returnedCheckpoint = engine.exportGraphCheckpoint();
    const restored = ExecutionJournal.restoreGraphCheckpoint((engine as any)._lastContext.claimPlan, JSON.parse(canonicalGraphCheckpointJson(returnedCheckpoint)));
    const projection = engine.getInstanceProjection();
    const reconciliationGeneration = Object.values(projection.generationsById).find((value: any) =>
      value.subgraphInstanceId === source.projectSubgraphInstanceId &&
      value.checkId === 'project_reconcile' &&
      value.status === 'completed' &&
      value.status !== 'inactive',
    ) as any;
    if (!reconciliationGeneration) throw new Error('replacement project_reconcile generation missing');
    const canonicalCheckpoint = canonicalGraphCheckpointJson(returnedCheckpoint);
    const restoredCheckpoint = canonicalGraphCheckpointJson(restored.exportGraphCheckpoint(returnedCheckpoint.sessionId));
    fs.writeFileSync(path.join(directory, 'continuation.json'), JSON.stringify({
      pid: process.pid,
      checkpoint: canonicalCheckpoint,
      projection,
      restored: restored.getInstanceProjection(),
      replay: restored.replayInstanceProjection(),
      restoredReexport: restoredCheckpoint,
      calls,
      probeDispatches,
      editedPaths,
      sourceBefore,
      sourceAfter,
      authorityId: continued.authorityId,
      mutationEventCount: continued.mutationEventCount,
      revalidationBytes,
      workItemsBytes,
      projectReconciliationRequest: (engine as any)._lastContext.journal.getProofProjectReconciliationRequest(reconciliationGeneration.nodeGenerationId),
      result: continued.result,
    }), 'utf8');

    const secondCalls: string[] = [];
    const secondProbeDispatches: Array<{ kind: 'project' | 'component'; componentId?: string }> = [];
    const secondRestore = installFakeProbe(capability, secondCalls, secondProbeDispatches);
    try {
      const secondEngine = new StateMachineExecutionEngine(root);
      const repeated = await secondEngine.continueProofCurrentCatalogCheckpoint({ checkpoint: returnedCheckpoint, projectSubgraphInstanceId: source.projectSubgraphInstanceId, revalidationBytes, workItemsBytes, config, prInfo: source.prInfo, maxParallelism: 3 });
      const repeatedCheckpoint = secondEngine.exportGraphCheckpoint();
      const repeatProjection = secondEngine.getInstanceProjection();
      const repeatReceipts = Object.values(repeatProjection.claimsById).filter((claim: any) => claim.claim === 'proof.project_reconciliation_receipt@1');
      fs.writeFileSync(path.join(directory, 'repeat.json'), JSON.stringify({
        mutationEventCount: repeated.mutationEventCount,
        calls: secondCalls,
        probeDispatches: secondProbeDispatches,
        checkpoint: canonicalGraphCheckpointJson(repeatedCheckpoint),
        receiptCount: repeatReceipts.length,
      }), 'utf8');
    } finally {
      secondRestore();
    }
  } finally {
    restore();
  }
}

async function negativeFrom(directory: string): Promise<void> {
  const source = JSON.parse(fs.readFileSync(path.join(directory, 'baseline.json'), 'utf8'));
  const checkpoint = JSON.parse(source.checkpoint);
  const config = source.config;
  const root = config.checks.project.value.projects[0].root;
  const binary = proofBinary();
  const capability = require('../../src/providers/proof-admission-cli-child').createProofAdmissionCapability(binary);
  const registry = CheckProviderRegistry.getInstance();
  registry.bootstrapProofAdmission(capability);
  const calls: string[] = [];
  const probeDispatches: Array<{ kind: 'project' | 'component'; componentId?: string }> = [];
  const restore = installFakeProbe(capability, calls, probeDispatches);
  const attempt = async (input: any, marker: string): Promise<boolean> => {
    const engine = new StateMachineExecutionEngine(root);
    const priorContext = { marker: `${marker}-context` };
    const priorRunner = { marker: `${marker}-runner` };
    (engine as any)._lastContext = priorContext;
    (engine as any)._lastRunner = priorRunner;
    try {
      await engine.continueProofCurrentCatalogCheckpoint(input);
      return false;
    } catch {
      return (engine as any)._lastContext === priorContext && (engine as any)._lastRunner === priorRunner;
    }
  };
  try {
    const baseInput = { checkpoint, projectSubgraphInstanceId: source.projectSubgraphInstanceId, config, prInfo };
    const malformed = await attempt({ ...baseInput, revalidationBytes: '{', workItemsBytes: '{}' }, 'malformed');
    const foreign = await attempt({ ...baseInput, projectSubgraphInstanceId: 'missing-project', revalidationBytes: '{}', workItemsBytes: '{}' }, 'foreign');
    const pendingJournal = ExecutionJournal.restoreGraphCheckpoint(compileClaimPlan(config), checkpoint);
    pendingJournal.requestCatalogReconciliation({ sessionId: checkpoint.sessionId, ownerCheck: 'project' });
    const nonquiescent = pendingJournal.exportGraphCheckpoint(checkpoint.sessionId);
    const pending = await attempt({ ...baseInput, checkpoint: nonquiescent, revalidationBytes: '{}', workItemsBytes: '{}' }, 'nonquiescent');
    const continuedSource = JSON.parse(fs.readFileSync(path.join(directory, 'continuation.json'), 'utf8'));
    const continuedCheckpoint = JSON.parse(continuedSource.checkpoint);
    const continuedJournal = ExecutionJournal.restoreGraphCheckpoint(compileClaimPlan(config), continuedCheckpoint);
    const continuedProjection = continuedJournal.getInstanceProjection();
    let standaloneInactivation = false;
    try {
      ExecutionJournal.restoreGraphCheckpoint(
        compileClaimPlan(config),
        standaloneProjectReconciliationInactivation(continuedCheckpoint, continuedProjection),
      );
    } catch (error) {
      standaloneInactivation = errorHasCode(error, 'INVALID_PROOF_CURRENT_APPLICATION');
    }
    let retiredReceiptRebind = false;
    try {
      ExecutionJournal.restoreGraphCheckpoint(
        compileClaimPlan(config),
        rebindRetiredProjectReceipt(continuedCheckpoint, continuedProjection),
      );
    } catch (error) {
      retiredReceiptRebind = errorHasCode(error, 'CHECKPOINT_PLAN_AUTHORITY_MISMATCH');
    }
    fs.writeFileSync(path.join(directory, 'negative.json'), JSON.stringify({
      calls,
      malformed,
      foreign,
      nonquiescent: pending,
      standaloneInactivation,
      retiredReceiptRebind,
    }), 'utf8');
  } finally {
    restore();
  }
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  const directory = process.argv[3];
  if (!directory || (mode !== 'produce' && mode !== 'continue' && mode !== 'negative')) throw new Error('usage: proof-current-catalog-checkpoint-child.ts <produce|continue|negative> <dir>');
  if (mode === 'produce') await produce(directory);
  else if (mode === 'continue') await continueFrom(directory);
  else await negativeFrom(directory);
}

if (require.main === module) {
  main()
    .catch(error => {
      process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
      process.exitCode = 1;
    })
    .finally(cleanupProofBuild);
}
