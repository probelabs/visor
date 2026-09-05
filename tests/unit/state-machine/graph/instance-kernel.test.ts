import {
  canonicalJson,
  sha256Canonical,
} from '../../../../src/state-machine/graph/claim-kernel';
import {
  canonicalCatalogKey,
  createInitialInstanceProjection,
  deriveCatalogRequestId,
  deriveControllerItemClaimId,
  deriveItemFingerprint,
  deriveManagedRunId,
  deriveNodeGenerationId,
  deriveProofCurrentCatalogAuthorityMutationDigest,
  deriveNodeInstanceId,
  deriveSubgraphInstanceId,
  InstanceKernelError,
  queryReadyGenerations,
  reduceInstanceEvent,
  reduceInstanceEventBatch,
  replayInstanceEvents,
  requireKeyedScopePath,
  validateTaggedScopePath,
  type ControllerItemClaimPublishedEvent,
  type GeneratedAttemptCompletedEvent,
  type GeneratedAttemptStartedEvent,
  type GeneratedCheckScheduledEvent,
  type GeneratedClaimPublishedEvent,
  type InstanceProjection,
  type InstanceRuntimeEvent,
  type KeyedScopePath,
  type ManagedRunAcquiredEvent,
  type ManagedRunAcquisitionFailedEvent,
  type ManagedRunBindingV1,
  type ManagedRunCancelRequestedEvent,
  type ManagedRunFailureCode,
  type ManagedRunStartedEvent,
  type ManagedRunTerminatedEvent,
  type NodeGenerationActivatedEvent,
  type NodeGenerationInactivatedEvent,
  type SubgraphExpandedEvent,
  type SubgraphTombstonedEvent,
} from '../../../../src/state-machine/graph/instance-kernel';
import { PROOF_CANDIDATE_CLAIM, PROOF_CATALOG_REVALIDATION_CLAIM } from '../../../../src/state-machine/graph/instance-plan';
import { governedResultDigest, validateProofCandidateEvidence } from '../../../../src/providers/governed-proof-inspect-check-provider';
import { validateProofComponentCandidateAdmissionBinding } from '../../../../src/providers/proof-catalog-check-providers';
import { proofCandidateEvidenceFingerprint } from '../../../../src/providers/proof-wire';
import { proofComponentCandidateEnvelopeJson, proofV1AdmissionReceiptID, proofV1DecisionJson } from '../../../../src/providers/proof-admission-cli-child';

const sessionId = 'session-1';
const expansionOwnerCheck = 'discover-components';
const graphSemanticDigest = sha256Canonical({ graph: 1 });
const expansionSpecDigest = sha256Canonical({ expansion: 1 });
const templateDigest = sha256Canonical({ template: 1 });
const catalogClaimId = sha256Canonical({ catalog: 1 });
const itemClaimRef = 'component.item@1';
const outputClaimRef = 'component.onboarded@1';

function expectKernelError(run: () => unknown, code: string): void {
  try {
    run();
    throw new Error(`Expected InstanceKernelError ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(InstanceKernelError);
    if (!(error instanceof InstanceKernelError)) throw error;
    expect(error.code).toBe(code);
  }
}

function expectAnyKernelError(run: () => unknown): void {
  try {
    run();
    throw new Error('Expected InstanceKernelError');
  } catch (error) {
    expect(error).toBeInstanceOf(InstanceKernelError);
  }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

function expectRecursivelyFrozen(value: unknown): void {
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    expectRecursivelyFrozen(nested);
  }
}

function instanceIdentity(itemKey = 'A') {
  const subgraphInstanceId = deriveSubgraphInstanceId({
    graphSemanticDigest,
    expansionOwnerCheck,
    parentSubgraphInstanceId: null,
    templateDigest,
    itemKey,
  });
  const scope: KeyedScopePath = [
    { kind: 'keyed', expansionOwnerCheck, key: itemKey, subgraphInstanceId },
  ];
  const nodeInstanceId = deriveNodeInstanceId({
    subgraphInstanceId,
    templateNodeKey: 'inspect',
  });
  return { itemKey, subgraphInstanceId, scope, nodeInstanceId };
}

function expanded(eventId = 1, itemKey = 'A'): SubgraphExpandedEvent {
  const identity = instanceIdentity(itemKey);
  return {
    version: 1,
    type: 'SubgraphExpanded',
    eventId,
    sessionId,
    scope: identity.scope,
    expansionOwnerCheck,
    graphSemanticDigest,
    expansionSpecDigest,
    templateDigest,
    parentSubgraphInstanceId: null,
    catalogClaimId,
    itemKey,
    subgraphInstanceId: identity.subgraphInstanceId,
    nodeInstanceIdsByTemplateNode: { inspect: identity.nodeInstanceId },
  };
}

function itemPublished(
  eventId: number,
  payload: { id: string; revision: number },
  incarnation: number,
  introducingCatalogClaimId = catalogClaimId
): ControllerItemClaimPublishedEvent {
  const identity = instanceIdentity(payload.id);
  const payloadFingerprint = deriveItemFingerprint(payload);
  const claimId = deriveControllerItemClaimId({
    claim: itemClaimRef,
    payloadFingerprint,
    expansionSpecDigest,
    catalogClaimId: introducingCatalogClaimId,
    subgraphInstanceId: identity.subgraphInstanceId,
    incarnation,
    scope: identity.scope,
  });
  return {
    version: 1,
    type: 'ControllerItemClaimPublished',
    eventId,
    sessionId,
    scope: identity.scope,
    expansionOwnerCheck,
    expansionSpecDigest,
    catalogClaimId: introducingCatalogClaimId,
    itemKey: payload.id,
    subgraphInstanceId: identity.subgraphInstanceId,
    incarnation,
    claimId,
    claim: itemClaimRef,
    payload,
    payloadFingerprint,
    parentClaimIds: [introducingCatalogClaimId],
  };
}

function activated(
  eventId: number,
  item: ControllerItemClaimPublishedEvent
): NodeGenerationActivatedEvent {
  const identity = instanceIdentity(item.itemKey);
  const executionConfigDigest = sha256Canonical({ check: 'inspect', revision: 1 });
  const activeInputClaimIds = [item.claimId];
  const nodeGenerationId = deriveNodeGenerationId({
    nodeInstanceId: identity.nodeInstanceId,
    incarnation: item.incarnation,
    itemFingerprint: item.payloadFingerprint,
    executionConfigDigest,
    activeInputClaimIds,
  });
  return {
    version: 1,
    type: 'NodeGenerationActivated',
    eventId,
    sessionId,
    scope: identity.scope,
    subgraphInstanceId: identity.subgraphInstanceId,
    nodeInstanceId: identity.nodeInstanceId,
    nodeGenerationId,
    templateNodeKey: 'inspect',
    checkId: 'inspect',
    incarnation: item.incarnation,
    itemFingerprint: item.payloadFingerprint,
    executionConfigDigest,
    activeInputClaimIds,
  };
}

function successfulGeneration(
  firstEventId: number,
  activation: NodeGenerationActivatedEvent
): readonly [
  GeneratedAttemptStartedEvent,
  GeneratedCheckScheduledEvent,
  GeneratedClaimPublishedEvent,
  GeneratedAttemptCompletedEvent,
] {
  const attemptId = sha256Canonical({ generation: activation.nodeGenerationId, attempt: 1 });
  const started: GeneratedAttemptStartedEvent = {
    version: 1,
    type: 'AttemptStarted',
    eventId: firstEventId,
    sessionId,
    scope: activation.scope,
    checkId: activation.checkId,
    attemptId,
    fence: 1,
    nodeInstanceId: activation.nodeInstanceId,
    nodeGenerationId: activation.nodeGenerationId,
  };
  const scheduled: GeneratedCheckScheduledEvent = {
    ...started,
    type: 'CheckScheduled',
    eventId: firstEventId + 1,
    claimIds: activation.activeInputClaimIds,
  };
  const payload = { id: activation.scope[0].key, inspected: true };
  const payloadFingerprint = sha256Canonical(payload);
  const claimId = sha256Canonical({
    claim: outputClaimRef,
    payloadFingerprint,
    producerCheckId: activation.checkId,
    scope: activation.scope,
    attemptId,
    fence: 1,
    parentClaimIds: [...activation.activeInputClaimIds].sort(),
  });
  const published: GeneratedClaimPublishedEvent = {
    ...started,
    type: 'ClaimPublished',
    eventId: firstEventId + 2,
    claimId,
    claim: outputClaimRef,
    payload,
    payloadFingerprint,
    producerCheckId: activation.checkId,
    parentClaimIds: activation.activeInputClaimIds,
    wireMode: 'generic',
  };
  const completed: GeneratedAttemptCompletedEvent = {
    ...started,
    type: 'AttemptCompleted',
    eventId: firstEventId + 3,
  };
  return [started, scheduled, published, completed];
}

function managedFixture() {
  const item = itemPublished(2, { id: 'A', revision: 1 }, 1);
  const activation = activated(3, item);
  const [attempt, scheduled] = successfulGeneration(4, activation);
  const events: InstanceRuntimeEvent[] = [expanded(), item, activation, attempt, scheduled];
  const projection = replayInstanceEvents(events);
  const authority = {
    sessionId,
    checkId: attempt.checkId,
    scope: attempt.scope,
    nodeInstanceId: attempt.nodeInstanceId,
    nodeGenerationId: attempt.nodeGenerationId,
    attemptId: attempt.attemptId,
    fence: attempt.fence,
  };
  const binding: ManagedRunBindingV1 = {
    managedRunId: deriveManagedRunId(authority),
    ...authority,
  };
  return { projection, events, attempt, binding };
}

function candidateEvidence(payload: unknown): any {
  const digest = 'sha256:9e4573c9aafd70eaf846fe2abbcc88a78a2f2ea2515f0a73a1ce3d98c6d6a6b2';
  const attestationDigest = '9e4573c9aafd70eaf846fe2abbcc88a78a2f2ea2515f0a73a1ce3d98c6d6a6b2';
  const invocation = { role_id: 'role', stance: 'owner', subject: { kind: 'project', id: 'fixture', fingerprint: `sha256:${'a'.repeat(64)}` }, output_schema_id: 'result', output_schema: Buffer.from('{"type":"object"}').toString('base64') };
  const invocationDigest = `sha256:${'b'.repeat(64)}`;
  const attestation = { version: 'probe.governed-codex-attestation/v2', profileId: 'luna-xhigh-readonly-v1', requested: { profileDigest: attestationDigest, cwdDigest: attestationDigest, probeToolsDigest: attestationDigest, model: 'gpt-5.6-luna', reasoningEffort: 'xhigh', sandbox: 'read-only', approvalPolicy: 'never' }, observed: { source: 'session_configured', model: 'gpt-5.6-luna', modelProviderId: 'openai', reasoningEffort: 'xhigh', approvalPolicy: 'never', cwdDigest: attestationDigest, permissionProfileDigest: attestationDigest, filesystem: 'restricted-read-root', network: 'restricted' }, executionContext: { source: 'caller', invocationDigest }, dispatch: { source: 'probe-host-tools-call', tool: 'codex', promptDigest: digest, promptBytes: 0 }, evidence: { eventCount: 1 }, usage: { status: 'unavailable' } };
  return { version: 'visor.proof-candidate-evidence/v1', role: { invocation, invocationDigest }, probe: { attestation, resultIdentity: { version: 'probe.governed-result-identity/v1', source: 'probe-host-schema-valid-json', resultDigest: digest, canonicalBytes: Buffer.byteLength(canonicalJson(payload), 'utf8') } } };
}

function stagedKernelFixture() {
  const base = managedFixture();
  const componentOwner = JSON.stringify(['discover-project', 'materialize_catalog']);
  const scope = base.attempt.scope.map(part => ({ ...part, expansionOwnerCheck: componentOwner })) as KeyedScopePath;
  const instance = base.projection.instancesById[base.attempt.nodeGenerationId
    ? base.projection.generationsById[base.attempt.nodeGenerationId].subgraphInstanceId
    : ''];
  if (!instance) throw new Error('fixture instance missing');
  const subject = { version: 'proof.component-subject/v1', project_id: 'fixture', component_id: 'A', sorted_owned_paths: ['packages/a'], sorted_dependency_closure: ['packages/a'], fingerprint: `sha256:${'a'.repeat(64)}` };
  const authority = { work_item_digest: `sha256:${'b'.repeat(64)}`, subject, candidate: { id: 'candidate' }, admission: { id: 'admission' }, work_item: { version: 'proof.component-work-item/v1', project_id: 'fixture', component_id: 'A', sorted_owned_paths: ['packages/a'], sorted_dependency_closure: ['packages/a'], proof_path_mapping: { paths: ['packages/a'], risk_tier: 'low', enforcement: 'required' }, proof_input_state: [], proof_component_subject: subject }, catalog_revalidation_receipt: { version: 'proof.catalog-revalidation-receipt/v1', decision: 'accepted', project_id: 'fixture', project_fingerprint: `sha256:${'1'.repeat(64)}`, boundary_fingerprint: `sha256:${'2'.repeat(64)}`, inventory_claim_id: `sha256:${'3'.repeat(64)}`, catalog_claim_id: `sha256:${'4'.repeat(64)}`, admission_candidate_id: `sha256:${'5'.repeat(64)}`, admission_result_digest: `sha256:${'6'.repeat(64)}`, admission_receipt_id: `sha256:${'7'.repeat(64)}`, component_authorities: [], receipt_id: '' } };
  const componentPayload = { component_id: 'A', proof_component_subject: subject, authority: { component_id: 'A', work_item_digest: authority.work_item_digest, subject } };
  const component = { ...base.projection.claimsById[instance.activeItemClaimId!], claim: 'component.work_item@1', payload: componentPayload, payloadFingerprint: sha256Canonical(componentPayload), producerCheckId: componentOwner, scope } as any;
  const priorPayload = { component_id: 'A', decision: 'accept' };
  const priorInvocation = { role_id: 'onboard', stance: 'owner', subject: { kind: 'component', id: 'A', fingerprint: subject.fingerprint }, component_authority: authority, output_schema_id: 'reqproof.component-onboarding/v1', output_schema: Buffer.from('{"type":"object"}').toString('base64') };
  const evidence = (payload: unknown, invocation: Record<string, unknown>) => {
    const resultDigest = governedResultDigest(payload);
    const invocationDigest = `sha256:${'c'.repeat(64)}`;
    const digest = 'd'.repeat(64);
    return { version: 'visor.proof-candidate-evidence/v1', role: { invocation, invocationDigest }, probe: { attestation: { version: 'probe.governed-codex-attestation/v2', profileId: 'luna-xhigh-readonly-v1', requested: { profileDigest: digest, cwdDigest: digest, probeToolsDigest: digest, model: 'gpt-5.6-luna', reasoningEffort: 'xhigh', sandbox: 'read-only', approvalPolicy: 'never' }, observed: { source: 'session_configured', model: 'gpt-5.6-luna', modelProviderId: 'openai', reasoningEffort: 'xhigh', approvalPolicy: 'never', cwdDigest: digest, permissionProfileDigest: digest, filesystem: 'restricted-read-root', network: 'restricted' }, executionContext: { source: 'caller', invocationDigest }, dispatch: { source: 'probe-host-tools-call', tool: 'codex', promptDigest: `sha256:${digest}`, promptBytes: 0 }, evidence: { eventCount: 1 }, usage: { status: 'unavailable' } }, resultIdentity: { version: 'probe.governed-result-identity/v1', source: 'probe-host-schema-valid-json', resultDigest, canonicalBytes: Buffer.byteLength(canonicalJson(payload), 'utf8') } } };
  };
  const priorEvidence = evidence(priorPayload, priorInvocation);
  const priorAttemptId = `e${'1'.repeat(63)}`;
  const priorCandidateFingerprint = proofCandidateEvidenceFingerprint(priorEvidence);
  const priorCandidate = { claimId: sha256Canonical({ claim: PROOF_CANDIDATE_CLAIM, payloadFingerprint: sha256Canonical(priorPayload), producerCheckId: 'inspect', scope, attemptId: priorAttemptId, fence: 1, parentClaimIds: [component.claimId], proofCandidateEvidenceFingerprint: priorCandidateFingerprint }), claim: PROOF_CANDIDATE_CLAIM, payload: priorPayload, payloadFingerprint: sha256Canonical(priorPayload), producerCheckId: 'inspect', producerAttemptId: priorAttemptId, producerFence: 1, parentClaimIds: [component.claimId], wireMode: 'generic', scope, active: true, kind: 'generated-output', subgraphInstanceId: instance.subgraphInstanceId, incarnation: instance.incarnation, nodeGenerationId: `e${'3'.repeat(63)}`, proofCandidateEvidence: priorEvidence, proofCandidateEvidenceFingerprint: priorCandidateFingerprint } as any;
  const priorBinding = { ManagedRunID: `e${'4'.repeat(63)}`, SessionID: sessionId, CheckID: 'inspect', Scope: scope.map(part => ({ Kind: 'keyed', ExpansionOwnerCheck: part.expansionOwnerCheck, Key: part.key, SubgraphInstanceID: part.subgraphInstanceId })), NodeInstanceID: `e${'5'.repeat(63)}`, NodeGenerationID: priorCandidate.nodeGenerationId, AttemptID: priorAttemptId, Fence: 1 };
  const priorTermination = { Version: 1, Type: 'ManagedRunTerminated', SessionID: sessionId, Scope: priorBinding.Scope, Binding: priorBinding, CleanupStatus: 'clean', ControllerDecision: 'completed', FailureCode: null };
  const priorEnvelope = { Version: 'proof.role-result-candidate-envelope/v1', Invocation: priorInvocation, InvocationDigest: priorEvidence.role.invocationDigest, RoleID: 'onboard', Stance: 'owner', Subject: priorInvocation.subject, AttestationVersion: priorEvidence.probe.attestation.version, ExecutionSource: 'caller', ProbeInvocationDigest: priorEvidence.probe.attestation.executionContext.invocationDigest, IdentityVersion: priorEvidence.probe.resultIdentity.version, IdentitySource: priorEvidence.probe.resultIdentity.source, ResultDigest: priorEvidence.probe.resultIdentity.resultDigest, CanonicalBytes: priorEvidence.probe.resultIdentity.canonicalBytes, ProbeResultBytes: Buffer.from(canonicalJson(priorPayload)).toString('base64'), VisorPayloadBytes: Buffer.from(canonicalJson(priorPayload)).toString('base64'), Publication: { Version: 1, Type: 'ClaimPublished', SessionID: sessionId, CheckID: 'inspect', Scope: priorBinding.Scope, NodeInstanceID: priorBinding.NodeInstanceID, NodeGenerationID: priorBinding.NodeGenerationID, AttemptID: priorBinding.AttemptID, Fence: 1, ClaimID: priorCandidate.claimId, Claim: priorCandidate.claim, PayloadFingerprint: priorCandidate.payloadFingerprint, ProducerCheckID: 'inspect', Payload: Buffer.from(canonicalJson(priorPayload)).toString('base64'), ParentClaimIDs: [component.claimId] }, Binding: priorBinding, Termination: priorTermination };
  const priorCandidateWire = proofComponentCandidateEnvelopeJson(priorEnvelope);
  const receipt: any = { Version: 'proof.role-result-candidate-admission/v1', Status: 'ADMITTED', CandidateID: `sha256:${'f'.repeat(64)}`, ProbeResultDigest: priorEvidence.probe.resultIdentity.resultDigest, ProbeCanonicalBytes: priorEvidence.probe.resultIdentity.canonicalBytes, ClaimID: priorCandidate.claimId, Claim: priorCandidate.claim, PayloadFingerprint: priorCandidate.payloadFingerprint, InvocationDigest: priorEvidence.role.invocationDigest, RoleID: 'onboard', Stance: 'owner', Subject: priorInvocation.subject, ProducerCheckID: 'inspect', ParentClaimIDs: [component.claimId], Binding: priorBinding, Termination: priorTermination, receipt_id: '' };
  receipt.receipt_id = proofV1AdmissionReceiptID(receipt);
  const priorAdmissionWire = proofV1DecisionJson({ version: 'proof.role-result-candidate-cli-decision/v1', status: 'ADMITTED', receipt, reject_code: null });
  const priorAdmission = { claimId: `f${'1'.repeat(63)}`, claim: 'proof.admitted_receipt@1', payload: { ...receipt, __proof_admission_wire: priorAdmissionWire }, payloadFingerprint: sha256Canonical({ ...receipt, __proof_admission_wire: priorAdmissionWire }), producerCheckId: 'proof_admit', producerAttemptId: `f${'2'.repeat(63)}`, producerFence: 1, parentClaimIds: [priorCandidate.claimId], wireMode: 'generic', scope, active: true, kind: 'generated-output', subgraphInstanceId: instance.subgraphInstanceId, incarnation: instance.incarnation, nodeGenerationId: `f${'3'.repeat(63)}` } as any;
  const stage = { version: 'proof.onboarding-stage-context/v1', stage_id: 'spec_review', prior_candidate: priorCandidateWire, prior_admission: priorAdmissionWire, prior_admission_claim_id: priorAdmission.claimId, prior_admission_payload_fingerprint: priorAdmission.payloadFingerprint };
  const stageInvocation = { ...priorInvocation, role_id: 'spec-review', onboarding_stage: stage };
  const stagePayload = { component_id: 'A', decision: 'review' };
  const stageEvidence = evidence(stagePayload, stageInvocation);
  const stageNodeInstanceId = deriveNodeInstanceId({ subgraphInstanceId: instance.subgraphInstanceId, templateNodeKey: 'spec_review' });
  const stageGenerationId = deriveNodeGenerationId({ nodeInstanceId: stageNodeInstanceId, incarnation: instance.incarnation, itemFingerprint: instance.activeItemClaimId ? base.projection.claimsById[instance.activeItemClaimId].payloadFingerprint : '', executionConfigDigest: sha256Canonical({ check: 'spec_review' }), activeInputClaimIds: [component.claimId, priorCandidate.claimId, priorAdmission.claimId].sort() });
  const stageAttemptId = `f${'4'.repeat(63)}`;
  const stageBinding = { managedRunId: deriveManagedRunId({ sessionId, checkId: 'spec_review', scope, nodeInstanceId: stageNodeInstanceId, nodeGenerationId: stageGenerationId, attemptId: stageAttemptId, fence: 1 }), sessionId, checkId: 'spec_review', scope, nodeInstanceId: stageNodeInstanceId, nodeGenerationId: stageGenerationId, attemptId: stageAttemptId, fence: 1 };
  const parentClaimIds = [component.claimId, priorCandidate.claimId, priorAdmission.claimId].sort();
  const stageClaimId = sha256Canonical({ claim: 'proof.component_spec_review_candidate@1', payloadFingerprint: sha256Canonical(stagePayload), producerCheckId: 'spec_review', scope, attemptId: stageAttemptId, fence: 1, parentClaimIds, proofCandidateEvidenceFingerprint: proofCandidateEvidenceFingerprint(stageEvidence) });
  const stageGeneration = { nodeGenerationId: stageGenerationId, nodeInstanceId: stageNodeInstanceId, subgraphInstanceId: instance.subgraphInstanceId, templateNodeKey: 'spec_review', checkId: 'spec_review', scope, incarnation: instance.incarnation, itemFingerprint: base.projection.claimsById[instance.activeItemClaimId!].payloadFingerprint, executionConfigDigest: sha256Canonical({ check: 'spec_review' }), activeInputClaimIds: parentClaimIds, status: 'running', attemptId: stageAttemptId, fence: 1, scheduled: true, completedOutputClaimIds: [] } as any;
  const event = { version: 1, type: 'ClaimPublished', eventId: base.projection.lastEventId + 2, sessionId, scope, checkId: 'spec_review', attemptId: stageAttemptId, fence: 1, nodeInstanceId: stageNodeInstanceId, nodeGenerationId: stageGenerationId, claimId: stageClaimId, claim: 'proof.component_spec_review_candidate@1', payload: stagePayload, payloadFingerprint: sha256Canonical(stagePayload), producerCheckId: 'spec_review', parentClaimIds, wireMode: 'generic', proofCandidateEvidence: stageEvidence, proofCandidateEvidenceFingerprint: proofCandidateEvidenceFingerprint(stageEvidence) } as any;
  const completed = { ...event, type: 'AttemptCompleted', eventId: event.eventId + 1 } as any;
  const terminal = { version: 1, type: 'ManagedRunTerminated', eventId: base.projection.lastEventId + 1, sessionId, scope, binding: stageBinding, cleanupStatus: 'clean', controllerDecision: 'completed', failureCode: null } as any;
  const projection = { ...base.projection, instancesById: { ...base.projection.instancesById, [instance.subgraphInstanceId]: { ...instance, scope, expansionOwnerCheck: componentOwner } }, claimsById: { ...base.projection.claimsById, [component.claimId]: component, [priorCandidate.claimId]: priorCandidate, [priorAdmission.claimId]: priorAdmission }, nodesById: { ...base.projection.nodesById, [stageNodeInstanceId]: { nodeInstanceId: stageNodeInstanceId, subgraphInstanceId: instance.subgraphInstanceId, templateNodeKey: 'spec_review', scope } }, generationsById: { ...base.projection.generationsById, [stageGenerationId]: stageGeneration }, activeGenerationIdByNode: { ...base.projection.activeGenerationIdByNode, [stageNodeInstanceId]: stageGenerationId }, attemptBindingsById: { ...base.projection.attemptBindingsById, [stageAttemptId]: stageGenerationId }, managedRunsByAttemptId: { ...base.projection.managedRunsByAttemptId, [stageAttemptId]: { binding: stageBinding, status: 'started' } } } as InstanceProjection;
  return { projection, event, completed, terminal, parentClaimIds, priorCandidate, priorAdmission, stageClaimId };
}

function managedEnvelope(binding: ManagedRunBindingV1, eventId: number) {
  return {
    version: 1 as const,
    eventId,
    sessionId: binding.sessionId,
    scope: binding.scope,
    binding,
  };
}

function managedAcquired(
  binding: ManagedRunBindingV1,
  eventId: number
): ManagedRunAcquiredEvent {
  return { ...managedEnvelope(binding, eventId), type: 'ManagedRunAcquired' };
}

function managedStarted(
  binding: ManagedRunBindingV1,
  eventId: number
): ManagedRunStartedEvent {
  return { ...managedEnvelope(binding, eventId), type: 'ManagedRunStarted' };
}

function managedTerminated(
  binding: ManagedRunBindingV1,
  eventId: number,
  input:
    | { readonly cleanupStatus: 'clean'; readonly controllerDecision: 'completed'; readonly failureCode: null }
    | {
        readonly cleanupStatus: 'clean' | 'unverified';
        readonly controllerDecision: 'failed';
        readonly failureCode: ManagedRunFailureCode;
      }
): ManagedRunTerminatedEvent {
  return { ...managedEnvelope(binding, eventId), type: 'ManagedRunTerminated', ...input };
}

function managedAttemptFailed(
  attempt: GeneratedAttemptStartedEvent,
  eventId: number,
  reason: ManagedRunFailureCode
) {
  return { ...attempt, type: 'AttemptFailed' as const, eventId, reason };
}

function managedAttemptCompleted(attempt: GeneratedAttemptStartedEvent, eventId: number) {
  return { ...attempt, type: 'AttemptCompleted' as const, eventId };
}

describe('Graph v2 C2 instance kernel', () => {
  it('uses tagged scopes and rejects ambiguous, extra, mixed, and malformed segments', () => {
    const parent = instanceIdentity('parent');
    const childId = deriveSubgraphInstanceId({
      graphSemanticDigest,
      parentSubgraphInstanceId: parent.subgraphInstanceId,
      expansionOwnerNodeInstanceId: parent.nodeInstanceId,
      templateDigest,
      itemKey: 'child',
    });
    const childScope: KeyedScopePath = [
      ...parent.scope,
      {
        kind: 'keyed',
        expansionOwnerCheck: 'nested-owner',
        key: 'child',
        subgraphInstanceId: childId,
      },
    ];
    expect(validateTaggedScopePath([])).toEqual([]);
    expect(
      validateTaggedScopePath([
        { kind: 'indexed', check: 'matrix', index: 0 },
        { kind: 'indexed', check: 'nested', index: 2 },
      ])
    ).toHaveLength(2);
    expect(requireKeyedScopePath(instanceIdentity().scope)).toEqual(instanceIdentity().scope);
    expect(requireKeyedScopePath(childScope, childScope)).toEqual(childScope);
    expectKernelError(
      () => requireKeyedScopePath(childScope, [childScope[1]]),
      'INVALID_SCOPE'
    );

    for (const invalid of [
      [{ check: 'legacy-untagged', index: 0 }],
      [{ kind: 'indexed', check: 'x', index: 0, extra: true }],
      [{ kind: 'indexed', check: 'x', index: Number.MAX_SAFE_INTEGER + 1 }],
      [
        { kind: 'indexed', check: 'x', index: 0 },
        instanceIdentity().scope[0],
      ],
      [...childScope, childScope[1]],
    ]) {
      expectKernelError(() => validateTaggedScopePath(invalid), 'INVALID_SCOPE');
    }
  });

  it('derives reorder-stable instance/node identities and canonical item keys', () => {
    const aBefore = instanceIdentity('A');
    const bBefore = instanceIdentity('B');
    const reordered = [instanceIdentity('B'), instanceIdentity('A')];
    expect(reordered[1]).toEqual(aBefore);
    expect(reordered[0]).toEqual(bBefore);
    expect(canonicalCatalogKey(1)).toBe('1');
    expect(canonicalCatalogKey('1')).toBe('1');
    expect(canonicalCatalogKey(-0)).toBe('0');
    expectKernelError(() => canonicalCatalogKey(''), 'INVALID_ITEM_KEY');
  });

  it('binds child identity to its exact parent and expansion-owner node', () => {
    const parentA = instanceIdentity('A');
    const parentB = instanceIdentity('B');
    const childForA = deriveSubgraphInstanceId({
      graphSemanticDigest,
      parentSubgraphInstanceId: parentA.subgraphInstanceId,
      expansionOwnerNodeInstanceId: parentA.nodeInstanceId,
      templateDigest,
      itemKey: 'same-spec',
    });
    const childForB = deriveSubgraphInstanceId({
      graphSemanticDigest,
      parentSubgraphInstanceId: parentB.subgraphInstanceId,
      expansionOwnerNodeInstanceId: parentB.nodeInstanceId,
      templateDigest,
      itemKey: 'same-spec',
    });
    const childForDifferentOwner = deriveSubgraphInstanceId({
      graphSemanticDigest,
      parentSubgraphInstanceId: parentA.subgraphInstanceId,
      expansionOwnerNodeInstanceId: deriveNodeInstanceId({
        subgraphInstanceId: parentA.subgraphInstanceId,
        templateNodeKey: 'different-owner',
      }),
      templateDigest,
      itemKey: 'same-spec',
    });

    expect(childForA).not.toBe(childForB);
    expect(childForA).not.toBe(childForDifferentOwner);
  });

  it('replays expansion, controller claim, activation, and bound generated lifecycle immutably', () => {
    const item = itemPublished(2, { id: 'A', revision: 1 }, 1);
    const activation = activated(3, item);
    const lifecycle = successfulGeneration(4, activation);
    const events: InstanceRuntimeEvent[] = [expanded(), item, activation, ...lifecycle];
    const live = events.reduce(reduceInstanceEvent, createInitialInstanceProjection());

    expect(queryReadyGenerations(live)).toEqual([]);
    expect(live.instancesById[item.subgraphInstanceId]).toMatchObject({
      status: 'active',
      incarnation: 1,
      activeItemClaimId: item.claimId,
    });
    expect(live.generationsById[activation.nodeGenerationId]).toMatchObject({
      status: 'completed',
      scheduled: true,
      completedOutputClaimIds: [lifecycle[2].claimId],
    });
    expect(live.claimsById[lifecycle[2].claimId]).toMatchObject({
      active: true,
      nodeGenerationId: activation.nodeGenerationId,
      parentClaimIds: [item.claimId],
    });
    expect(replayInstanceEvents(events)).toEqual(live);
    expect(Object.isFrozen(live)).toBe(true);
    expect(Object.isFrozen(live.generationsById[activation.nodeGenerationId])).toBe(true);
    expect(Object.isFrozen(live.claimsById[item.claimId].payload)).toBe(true);
  });

  it('binds candidate result identity to the exact canonical payload bytes', () => {
    const fixture = managedFixture();
    const item = itemPublished(2, { id: 'A', revision: 1 }, 1);
    const activation = activated(3, item);
    const [started, , published, completed] = successfulGeneration(7, activation);
    const payload = { id: 'A', inspected: true };
    const evidence = candidateEvidence(payload);
    const candidate = { ...published, claim: PROOF_CANDIDATE_CLAIM, wireMode: 'generic' as const, payload, payloadFingerprint: sha256Canonical(payload), proofCandidateEvidence: evidence, proofCandidateEvidenceFingerprint: sha256Canonical(evidence), claimId: sha256Canonical({ claim: PROOF_CANDIDATE_CLAIM, payloadFingerprint: sha256Canonical(payload), producerCheckId: started.checkId, scope: started.scope, attemptId: started.attemptId, fence: started.fence, parentClaimIds: [...activation.activeInputClaimIds].sort(), proofCandidateEvidenceFingerprint: sha256Canonical(evidence) }) } as GeneratedClaimPublishedEvent;
    const managedEvents = [...fixture.events, managedAcquired(fixture.binding, 6), managedStarted(fixture.binding, 7)];
    const managed = replayInstanceEvents(managedEvents);
    const terminated = managedTerminated(fixture.binding, 8, { cleanupStatus: 'clean', controllerDecision: 'completed', failureCode: null });
    const admittedEvents = [terminated, candidate, completed];
    const live = reduceInstanceEventBatch(managed, admittedEvents);
    expect(live.claimsById[candidate.claimId].proofCandidateEvidence).toEqual(evidence);
    expect(replayInstanceEvents([...managedEvents, ...admittedEvents])).toEqual(live);
    const oldPlainEvidence = { ...evidence, probe: { ...evidence.probe, resultIdentity: { ...evidence.probe.resultIdentity, resultDigest: 'sha256:321159a84d09d6a8030c0403bc98f6cf22f897bb5d6e448b8274e672ed203072' } } };
    const oldPlainFingerprint = sha256Canonical(oldPlainEvidence);
    const oldPlainCandidate = { ...candidate, proofCandidateEvidence: oldPlainEvidence, proofCandidateEvidenceFingerprint: oldPlainFingerprint, claimId: sha256Canonical({ claim: candidate.claim, payloadFingerprint: candidate.payloadFingerprint, producerCheckId: candidate.producerCheckId, scope: candidate.scope, attemptId: candidate.attemptId, fence: candidate.fence, parentClaimIds: [...candidate.parentClaimIds].sort(), proofCandidateEvidenceFingerprint: oldPlainFingerprint }) } as GeneratedClaimPublishedEvent;
    expectKernelError(() => reduceInstanceEventBatch(managed, [terminated, oldPlainCandidate, completed]), 'INVALID_PROOF_EVIDENCE');
    const tamperedPayload = { '10': 'ten', '2': 'two' };
    const tampered = { ...candidate, payload: tamperedPayload, payloadFingerprint: sha256Canonical(tamperedPayload), claimId: sha256Canonical({ claim: PROOF_CANDIDATE_CLAIM, payloadFingerprint: sha256Canonical(tamperedPayload), producerCheckId: started.checkId, scope: started.scope, attemptId: started.attemptId, fence: started.fence, parentClaimIds: [...activation.activeInputClaimIds].sort(), proofCandidateEvidenceFingerprint: sha256Canonical(evidence) }) } as GeneratedClaimPublishedEvent;
    expectKernelError(() => reduceInstanceEventBatch(managed, [terminated, tampered, completed]), 'INVALID_PROOF_EVIDENCE');
  });

  it('publishes a staged candidate only with its distinct three-parent lineage', () => {
    const fixture = stagedKernelFixture();
    expect(() => validateProofCandidateEvidence(fixture.event.proofCandidateEvidence)).not.toThrow();
    expect(() => validateProofComponentCandidateAdmissionBinding({ ...fixture.priorCandidate, proofAdmission: fixture.priorCandidate.proofCandidateEvidence, provenance: 'attempt', attemptId: fixture.priorCandidate.producerAttemptId, fence: fixture.priorCandidate.producerFence }, fixture.priorAdmission)).not.toThrow();
    const live = reduceInstanceEventBatch(fixture.projection, [fixture.terminal, fixture.event, fixture.completed]);
    const staged = live.claimsById[fixture.stageClaimId];
    expect(staged.parentClaimIds).toEqual(fixture.parentClaimIds);
    expect(fixture.priorAdmission.parentClaimIds).toEqual([fixture.priorCandidate.claimId]);
    expect(staged.claimId).not.toBe(fixture.priorCandidate.claimId);
    expect(live.generationsById[fixture.event.nodeGenerationId].completedOutputClaimIds).toEqual([fixture.stageClaimId]);
    const detached = { ...fixture.event, parentClaimIds: fixture.parentClaimIds.slice(1) } as any;
    expectKernelError(() => reduceInstanceEventBatch(fixture.projection, [fixture.terminal, detached, fixture.completed]), 'INVALID_PARENT_CLAIMS');
  });

  it('requires a clean managed terminal before direct Proof revalidation publication', () => {
    const item = itemPublished(2, { id: 'A', revision: 1 }, 1);
    const baseActivation = activated(3, item);
    const revalidationNode = deriveNodeInstanceId({
      subgraphInstanceId: baseActivation.subgraphInstanceId,
      templateNodeKey: 'revalidate_catalog',
    });
    const activation = {
      ...baseActivation,
      nodeInstanceId: revalidationNode,
      nodeGenerationId: deriveNodeGenerationId({
        nodeInstanceId: revalidationNode,
        incarnation: baseActivation.incarnation,
        itemFingerprint: baseActivation.itemFingerprint,
        executionConfigDigest: baseActivation.executionConfigDigest,
        activeInputClaimIds: baseActivation.activeInputClaimIds,
      }),
      templateNodeKey: 'revalidate_catalog' as const,
      checkId: 'revalidate_catalog',
    };
    const expansion = expanded();
    expansion.nodeInstanceIdsByTemplateNode = { inspect: expansion.nodeInstanceIdsByTemplateNode.inspect, revalidate_catalog: revalidationNode };
    const [started, scheduled] = successfulGeneration(4, activation);
    const payload = { version: 'proof.catalog-revalidation/v2' };
    const payloadFingerprint = sha256Canonical(payload);
    const publication: GeneratedClaimPublishedEvent = {
      ...started,
      type: 'ClaimPublished',
      eventId: 6,
      claimId: sha256Canonical({
        claim: PROOF_CATALOG_REVALIDATION_CLAIM,
        payloadFingerprint,
        producerCheckId: started.checkId,
        scope: started.scope,
        attemptId: started.attemptId,
        fence: started.fence,
        parentClaimIds: [...activation.activeInputClaimIds].sort(),
      }),
      claim: PROOF_CATALOG_REVALIDATION_CLAIM,
      payload,
      payloadFingerprint,
      producerCheckId: started.checkId,
      parentClaimIds: activation.activeInputClaimIds,
      wireMode: 'generic',
    };
    const prefix = replayInstanceEvents([expansion, item, activation, started, scheduled]);
    expectKernelError(() => reduceInstanceEvent(prefix, publication), 'MANAGED_TERMINAL_REQUIRED');
  });

  it('inactivates one incarnation exactly and activates only its replacement', () => {
    const firstItem = itemPublished(2, { id: 'A', revision: 1 }, 1);
    const firstActivation = activated(3, firstItem);
    const lifecycle = successfulGeneration(4, firstActivation);
    let projection = replayInstanceEvents([expanded(), firstItem, firstActivation, ...lifecycle]);
    const inactivated: NodeGenerationInactivatedEvent = {
      version: 1,
      type: 'NodeGenerationInactivated',
      eventId: 8,
      sessionId,
      scope: firstActivation.scope,
      subgraphInstanceId: firstActivation.subgraphInstanceId,
      nodeInstanceId: firstActivation.nodeInstanceId,
      nodeGenerationId: firstActivation.nodeGenerationId,
      incarnation: 1,
      outputClaimIds: [lifecycle[2].claimId],
      reason: 'superseded',
    };
    projection = reduceInstanceEvent(projection, inactivated);
    const nextCatalogClaimId = sha256Canonical({ catalog: 2 });
    const secondItem = itemPublished(9, { id: 'A', revision: 2 }, 2, nextCatalogClaimId);
    projection = reduceInstanceEvent(projection, secondItem);
    const secondActivation = activated(10, secondItem);
    projection = reduceInstanceEvent(projection, secondActivation);

    expect(firstActivation.nodeInstanceId).toBe(secondActivation.nodeInstanceId);
    expect(firstActivation.nodeGenerationId).not.toBe(secondActivation.nodeGenerationId);
    expect(projection.generationsById[firstActivation.nodeGenerationId].status).toBe('inactive');
    expect(projection.claimsById[firstItem.claimId].active).toBe(false);
    expect(projection.claimsById[lifecycle[2].claimId].active).toBe(false);
    expect(queryReadyGenerations(projection).map(value => value.nodeGenerationId)).toEqual([
      secondActivation.nodeGenerationId,
    ]);
  });

  it('tombstones without deleting history and fails closed on key re-add', () => {
    const item = itemPublished(2, { id: 'A', revision: 1 }, 1);
    const activation = activated(3, item);
    const lifecycle = successfulGeneration(4, activation);
    let projection = replayInstanceEvents([expanded(), item, activation, ...lifecycle]);
    const tombstone: SubgraphTombstonedEvent = {
      version: 1,
      type: 'SubgraphTombstoned',
      eventId: 8,
      sessionId,
      scope: activation.scope,
      expansionOwnerCheck,
      sourceCatalogClaimId: sha256Canonical({ catalog: 'remove' }),
      itemKey: 'A',
      subgraphInstanceId: activation.subgraphInstanceId,
      lastIncarnation: 1,
      nodeGenerationIds: [activation.nodeGenerationId],
      outputClaimIds: [lifecycle[2].claimId],
    };
    projection = reduceInstanceEvent(projection, tombstone);
    expect(projection.instancesById[activation.subgraphInstanceId].status).toBe('tombstoned');
    expect(projection.generationsById[activation.nodeGenerationId].status).toBe('inactive');
    expect(projection.claimsById[lifecycle[2].claimId].active).toBe(false);
    expectKernelError(() => reduceInstanceEvent(projection, expanded(9)), 'TOMBSTONED_KEY_READD_UNSUPPORTED');
  });

  it('keeps catalog requests FIFO and behind every ready or running generation', () => {
    const item = itemPublished(2, { id: 'A', revision: 1 }, 1);
    const activation = activated(3, item);
    let projection = replayInstanceEvents([expanded(), item, activation]);
    const requestId = deriveCatalogRequestId({
      sessionId,
      expansionOwnerCheck,
      ordinal: 1,
    });
    projection = reduceInstanceEvent(projection, {
      version: 1,
      type: 'CatalogReconciliationRequested',
      eventId: 4,
      sessionId,
      scope: [],
      requestId,
      requestOrdinal: 1,
      expansionOwnerCheck,
      status: 'pending',
    });
    const requestStart = {
      version: 1 as const,
      type: 'AttemptStarted' as const,
      eventId: 5,
      sessionId,
      scope: [] as const,
      requestId,
      checkId: expansionOwnerCheck,
      attemptId: sha256Canonical({ requestId, attempt: 1 }),
      fence: 2,
    };
    expectKernelError(
      () => reduceInstanceEvent(projection, requestStart),
      'GENERATED_WORK_PRECEDES_REQUEST'
    );
    expect(projection.requestsById[requestId].status).toBe('pending');
  });

  it('does not start a later FIFO request while its predecessor is running', () => {
    let projection = createInitialInstanceProjection();
    const ids = [1, 2].map(ordinal => deriveCatalogRequestId({
      sessionId, expansionOwnerCheck, ordinal,
    }));
    for (let index = 0; index < ids.length; index++) {
      projection = reduceInstanceEvent(projection, {
        version: 1, type: 'CatalogReconciliationRequested', eventId: index + 1,
        sessionId, scope: [], requestId: ids[index], requestOrdinal: index + 1,
        expansionOwnerCheck, status: 'pending',
      });
    }
    projection = reduceInstanceEvent(projection, {
      version: 1, type: 'AttemptStarted', eventId: 3, sessionId, scope: [],
      requestId: ids[0], checkId: expansionOwnerCheck,
      attemptId: sha256Canonical({ requestId: ids[0], attempt: 1 }), fence: 1,
    });
    expectKernelError(() => reduceInstanceEvent(projection, {
      version: 1, type: 'AttemptStarted', eventId: 4, sessionId, scope: [],
      requestId: ids[1], checkId: expansionOwnerCheck,
      attemptId: sha256Canonical({ requestId: ids[1], attempt: 1 }), fence: 2,
    }), 'GENERATED_WORK_PRECEDES_REQUEST');
  });

  it('rejects stale, cross-instance, and caller-forged lifecycle bindings without mutation', () => {
    const item = itemPublished(2, { id: 'A', revision: 1 }, 1);
    const activation = activated(3, item);
    const projection = replayInstanceEvents([expanded(), item, activation]);
    const before: InstanceProjection = projection;
    const [started, scheduled] = successfulGeneration(4, activation);
    expectKernelError(
      () => reduceInstanceEvent(projection, { ...started, nodeInstanceId: sha256Canonical('forged') }),
      'INVALID_GENERATION_BINDING'
    );
    expectKernelError(
      () => reduceInstanceEvent(reduceInstanceEvent(projection, started), { ...scheduled, claimIds: [] }),
      'INVALID_SCHEDULED_CLAIMS'
    );
    expect(projection).toBe(before);
    expect(projection.generationsById[activation.nodeGenerationId].status).toBe('ready');
  });
});

describe('Graph v2 C3 managed run lifecycle kernel', () => {
  it('atomically accepts one acquisition failure followed by its exact failed attempt', () => {
    const fixture = managedFixture();
    const acquisitionFailed: ManagedRunAcquisitionFailedEvent = {
      ...managedEnvelope(fixture.binding, 6),
      type: 'ManagedRunAcquisitionFailed',
      failureCode: 'MANAGED_START_FAILED',
    };
    const attemptFailed = managedAttemptFailed(fixture.attempt, 7, 'MANAGED_START_FAILED');

    expectKernelError(
      () => reduceInstanceEventBatch(fixture.projection, [acquisitionFailed]),
      'INVALID_MANAGED_BATCH'
    );
    expect(fixture.projection.lastEventId).toBe(5);

    const failed = reduceInstanceEventBatch(fixture.projection, [acquisitionFailed, attemptFailed]);
    expect(failed.managedRunsByAttemptId[fixture.binding.attemptId]).toEqual({
      binding: fixture.binding,
      status: 'acquisition_failed',
      controllerDecision: 'failed',
      failureCode: 'MANAGED_START_FAILED',
    });
    expect(failed.generationsById[fixture.binding.nodeGenerationId]).toMatchObject({
      status: 'failed',
      reason: 'MANAGED_START_FAILED',
    });
    expectKernelError(
      () => reduceInstanceEvent(failed, managedAcquired(fixture.binding, 8)),
      'INVALID_MANAGED_BINDING'
    );
  });

  it('accepts acquired, started, and one clean controller-completed terminal batch', () => {
    const fixture = managedFixture();
    const acquired = managedAcquired(fixture.binding, 6);
    const started = managedStarted(fixture.binding, 7);
    const beforeTerminal = replayInstanceEvents([...fixture.events, acquired, started]);
    const terminated = managedTerminated(fixture.binding, 8, {
      cleanupStatus: 'clean',
      controllerDecision: 'completed',
      failureCode: null,
    });
    const completed = managedAttemptCompleted(fixture.attempt, 9);

    expectKernelError(
      () => reduceInstanceEventBatch(beforeTerminal, [completed]),
      'INVALID_MANAGED_BATCH'
    );
    const final = reduceInstanceEventBatch(beforeTerminal, [terminated, completed]);
    expect(final.managedRunsByAttemptId[fixture.binding.attemptId]).toEqual({
      binding: fixture.binding,
      status: 'terminated',
      cleanupStatus: 'clean',
      controllerDecision: 'completed',
    });
    expect(final.generationsById[fixture.binding.nodeGenerationId].status).toBe('completed');
    expectKernelError(
      () => reduceInstanceEvent(final, { ...terminated, eventId: 10 }),
      'INVALID_MANAGED_BINDING'
    );
  });

  it.each<ManagedRunFailureCode>([
    'MANAGED_FATAL_SUMMARY',
    'MANAGED_FAIL_IF',
    'MANAGED_HALT_EXECUTION',
    'MANAGED_CLAIM_VALIDATION_FAILED',
  ])('keeps clean cleanup separate from controller failure %s', failureCode => {
    const fixture = managedFixture();
    const acquired = managedAcquired(fixture.binding, 6);
    const beforeTerminal = reduceInstanceEvent(fixture.projection, acquired);
    const terminated = managedTerminated(fixture.binding, 7, {
      cleanupStatus: 'clean',
      controllerDecision: 'failed',
      failureCode,
    });
    const attemptFailed = managedAttemptFailed(fixture.attempt, 8, failureCode);
    const final = reduceInstanceEventBatch(beforeTerminal, [terminated, attemptFailed]);

    expect(final.managedRunsByAttemptId[fixture.binding.attemptId]).toMatchObject({
      status: 'terminated',
      cleanupStatus: 'clean',
      controllerDecision: 'failed',
      failureCode,
    });
    expect(final.generationsById[fixture.binding.nodeGenerationId]).toMatchObject({
      status: 'failed',
      reason: failureCode,
    });
  });

  it('records one deadline cancellation with unverified failed cleanup', () => {
    const fixture = managedFixture();
    const acquired = managedAcquired(fixture.binding, 6);
    const cancelRequested: ManagedRunCancelRequestedEvent = {
      ...managedEnvelope(fixture.binding, 7),
      type: 'ManagedRunCancelRequested',
      reason: 'deadline',
    };
    const terminated = managedTerminated(fixture.binding, 8, {
      cleanupStatus: 'unverified',
      controllerDecision: 'failed',
      failureCode: 'MANAGED_CLOSE_FAILED',
    });
    const attemptFailed = managedAttemptFailed(fixture.attempt, 9, 'MANAGED_CLOSE_FAILED');
    const live = reduceInstanceEventBatch(
      replayInstanceEvents([...fixture.events, acquired, cancelRequested]),
      [terminated, attemptFailed]
    );

    expect(live.managedRunsByAttemptId[fixture.binding.attemptId]).toMatchObject({
      status: 'terminated',
      cleanupStatus: 'unverified',
      controllerDecision: 'failed',
      failureCode: 'MANAGED_CLOSE_FAILED',
    });
    expectKernelError(
      () => reduceInstanceEvent(live, { ...cancelRequested, eventId: 10 }),
      'INVALID_MANAGED_BINDING'
    );
  });

  it('accepts one valid clean deadline terminal after the current-fence cancel fact', () => {
    const fixture = managedFixture();
    const acquired = managedAcquired(fixture.binding, 6);
    const cancelRequested: ManagedRunCancelRequestedEvent = {
      ...managedEnvelope(fixture.binding, 7),
      type: 'ManagedRunCancelRequested',
      reason: 'deadline',
    };
    const terminated = managedTerminated(fixture.binding, 8, {
      cleanupStatus: 'clean',
      controllerDecision: 'failed',
      failureCode: 'MANAGED_DEADLINE_EXCEEDED',
    });
    const attemptFailed = managedAttemptFailed(
      fixture.attempt,
      9,
      'MANAGED_DEADLINE_EXCEEDED'
    );
    const cancelled = replayInstanceEvents([...fixture.events, acquired, cancelRequested]);
    const final = reduceInstanceEventBatch(cancelled, [terminated, attemptFailed]);

    expect(final.managedRunsByAttemptId[fixture.binding.attemptId]).toEqual({
      binding: fixture.binding,
      status: 'terminated',
      cancellationRequested: true,
      cleanupStatus: 'clean',
      controllerDecision: 'failed',
      failureCode: 'MANAGED_DEADLINE_EXCEEDED',
    });
    expect(final.generationsById[fixture.binding.nodeGenerationId]).toMatchObject({
      status: 'failed',
      reason: 'MANAGED_DEADLINE_EXCEEDED',
    });
  });

  it('rejects a late managed terminal after atomic acquisition failure', () => {
    const fixture = managedFixture();
    const acquisitionFailed: ManagedRunAcquisitionFailedEvent = {
      ...managedEnvelope(fixture.binding, 6),
      type: 'ManagedRunAcquisitionFailed',
      failureCode: 'MANAGED_START_FAILED',
    };
    const failed = reduceInstanceEventBatch(fixture.projection, [
      acquisitionFailed,
      managedAttemptFailed(fixture.attempt, 7, 'MANAGED_START_FAILED'),
    ]);
    const lateTerminal = managedTerminated(fixture.binding, 8, {
      cleanupStatus: 'clean',
      controllerDecision: 'failed',
      failureCode: 'MANAGED_POST_PROVIDER_FAILED',
    });

    expectAnyKernelError(() => reduceInstanceEvent(failed, lateTerminal));
    expect(failed.managedRunsByAttemptId[fixture.binding.attemptId]).toEqual({
      binding: fixture.binding,
      status: 'acquisition_failed',
      controllerDecision: 'failed',
      failureCode: 'MANAGED_START_FAILED',
    });
  });

  it('canonically replays every managed lifecycle shape without invoking collaborators', () => {
    const fixture = managedFixture();
    const acquired = managedAcquired(fixture.binding, 6);
    const acquiredProjection = reduceInstanceEvent(fixture.projection, acquired);
    const started = managedStarted(fixture.binding, 7);
    const startedProjection = reduceInstanceEvent(acquiredProjection, started);
    const cancelRequested: ManagedRunCancelRequestedEvent = {
      ...managedEnvelope(fixture.binding, 7),
      type: 'ManagedRunCancelRequested',
      reason: 'deadline',
    };
    const cancelledProjection = reduceInstanceEvent(acquiredProjection, cancelRequested);
    const acquisitionFailed: ManagedRunAcquisitionFailedEvent = {
      ...managedEnvelope(fixture.binding, 6),
      type: 'ManagedRunAcquisitionFailed',
      failureCode: 'MANAGED_START_FAILED',
    };
    const cleanCompleted = managedTerminated(fixture.binding, 8, {
      cleanupStatus: 'clean',
      controllerDecision: 'completed',
      failureCode: null,
    });
    const cleanFailed = managedTerminated(fixture.binding, 7, {
      cleanupStatus: 'clean',
      controllerDecision: 'failed',
      failureCode: 'MANAGED_FATAL_SUMMARY',
    });
    const unverifiedFailed = managedTerminated(fixture.binding, 8, {
      cleanupStatus: 'unverified',
      controllerDecision: 'failed',
      failureCode: 'MANAGED_CLOSE_FAILED',
    });
    const acquisitionAttemptFailed = managedAttemptFailed(
      fixture.attempt,
      7,
      'MANAGED_START_FAILED'
    );
    const completedAttempt = managedAttemptCompleted(fixture.attempt, 9);
    const cleanFailedAttempt = managedAttemptFailed(
      fixture.attempt,
      8,
      'MANAGED_FATAL_SUMMARY'
    );
    const unverifiedFailedAttempt = managedAttemptFailed(
      fixture.attempt,
      9,
      'MANAGED_CLOSE_FAILED'
    );

    type ReplayRow = {
      readonly name: string;
      readonly events: readonly InstanceRuntimeEvent[];
      readonly live: InstanceProjection;
      readonly expectedManaged: InstanceProjection['managedRunsByAttemptId'][string];
      readonly managedTerminalCount: number;
      readonly attemptTerminalCount: number;
    };
    const rows: readonly ReplayRow[] = [
      {
        name: 'acquisition-failed',
        events: [...fixture.events, acquisitionFailed, acquisitionAttemptFailed],
        live: reduceInstanceEventBatch(fixture.projection, [
          acquisitionFailed,
          acquisitionAttemptFailed,
        ]),
        expectedManaged: {
          binding: fixture.binding,
          status: 'acquisition_failed',
          controllerDecision: 'failed',
          failureCode: 'MANAGED_START_FAILED',
        },
        managedTerminalCount: 1,
        attemptTerminalCount: 1,
      },
      {
        name: 'acquired',
        events: [...fixture.events, acquired],
        live: acquiredProjection,
        expectedManaged: { binding: fixture.binding, status: 'acquired' },
        managedTerminalCount: 0,
        attemptTerminalCount: 0,
      },
      {
        name: 'cancel-requested',
        events: [...fixture.events, acquired, cancelRequested],
        live: cancelledProjection,
        expectedManaged: { binding: fixture.binding, status: 'cancel_requested', cancellationRequested: true },
        managedTerminalCount: 0,
        attemptTerminalCount: 0,
      },
      {
        name: 'clean-completed',
        events: [...fixture.events, acquired, started, cleanCompleted, completedAttempt],
        live: reduceInstanceEventBatch(startedProjection, [cleanCompleted, completedAttempt]),
        expectedManaged: {
          binding: fixture.binding,
          status: 'terminated',
          cleanupStatus: 'clean',
          controllerDecision: 'completed',
        },
        managedTerminalCount: 1,
        attemptTerminalCount: 1,
      },
      {
        name: 'clean-failed',
        events: [...fixture.events, acquired, cleanFailed, cleanFailedAttempt],
        live: reduceInstanceEventBatch(acquiredProjection, [cleanFailed, cleanFailedAttempt]),
        expectedManaged: {
          binding: fixture.binding,
          status: 'terminated',
          cleanupStatus: 'clean',
          controllerDecision: 'failed',
          failureCode: 'MANAGED_FATAL_SUMMARY',
        },
        managedTerminalCount: 1,
        attemptTerminalCount: 1,
      },
      {
        name: 'unverified-failed',
        events: [
          ...fixture.events,
          acquired,
          cancelRequested,
          unverifiedFailed,
          unverifiedFailedAttempt,
        ],
        live: reduceInstanceEventBatch(cancelledProjection, [
          unverifiedFailed,
          unverifiedFailedAttempt,
        ]),
        expectedManaged: {
          binding: fixture.binding,
          status: 'terminated',
          cancellationRequested: true,
          cleanupStatus: 'unverified',
          controllerDecision: 'failed',
          failureCode: 'MANAGED_CLOSE_FAILED',
        },
        managedTerminalCount: 1,
        attemptTerminalCount: 1,
      },
    ];
    expect(rows.map(row => row.name)).toEqual([
      'acquisition-failed',
      'acquired',
      'cancel-requested',
      'clean-completed',
      'clean-failed',
      'unverified-failed',
    ]);

    for (const row of rows) {
      const parsed = deepFreeze<InstanceRuntimeEvent[]>(
        JSON.parse(canonicalJson(row.events))
      );
      expectRecursivelyFrozen(parsed);
      expect(canonicalJson(parsed)).toBe(canonicalJson(row.events));

      const replayed = replayInstanceEvents(parsed);
      expect(replayed).toEqual(row.live);
      expectRecursivelyFrozen(replayed);
      expect(replayed.managedRunsByAttemptId).toEqual(row.live.managedRunsByAttemptId);
      expect(row.live.managedRunsByAttemptId[fixture.binding.attemptId]).toEqual(
        row.expectedManaged
      );
      expect(replayed.managedRunsByAttemptId[fixture.binding.attemptId]).toEqual(
        row.expectedManaged
      );
      expect(replayed.managedRunsByAttemptId[fixture.binding.attemptId].binding).toEqual(
        fixture.binding
      );

      const managedTerminal = (event: InstanceRuntimeEvent) =>
        event.type === 'ManagedRunAcquisitionFailed' || event.type === 'ManagedRunTerminated';
      const attemptTerminal = (event: InstanceRuntimeEvent) =>
        event.type === 'AttemptCompleted' || event.type === 'AttemptFailed';
      expect(row.events.filter(managedTerminal)).toHaveLength(row.managedTerminalCount);
      expect(parsed.filter(managedTerminal)).toHaveLength(row.managedTerminalCount);
      expect(row.events.filter(attemptTerminal)).toHaveLength(row.attemptTerminalCount);
      expect(parsed.filter(attemptTerminal)).toHaveLength(row.attemptTerminalCount);
      expect(
        Object.values(replayed.managedRunsByAttemptId).filter(run =>
          run.status === 'acquisition_failed' || run.status === 'terminated'
        )
      ).toHaveLength(row.managedTerminalCount);

      const readyBeforeSerialization = queryReadyGenerations(row.live).map(
        generation => generation.nodeGenerationId
      );
      const readyAfterReplay = queryReadyGenerations(replayed).map(
        generation => generation.nodeGenerationId
      );
      expect(readyAfterReplay).toEqual(readyBeforeSerialization);
      expect(readyAfterReplay).toEqual([]);
    }

  });

  it('rejects replayed managed terminal prefixes and non-adjacent terminal pairs', () => {
    const fixture = managedFixture();
    const acquisitionFailed: ManagedRunAcquisitionFailedEvent = {
      ...managedEnvelope(fixture.binding, 6),
      type: 'ManagedRunAcquisitionFailed',
      failureCode: 'MANAGED_START_FAILED',
    };
    const attemptFailed = managedAttemptFailed(fixture.attempt, 7, 'MANAGED_START_FAILED');

    expectKernelError(
      () => replayInstanceEvents([...fixture.events, acquisitionFailed]),
      'INVALID_MANAGED_BATCH'
    );
    expectKernelError(
      () =>
        replayInstanceEvents([
          ...fixture.events,
          acquisitionFailed,
          managedAcquired(fixture.binding, 7),
          { ...attemptFailed, eventId: 8 },
        ]),
      'INVALID_MANAGED_BATCH'
    );

    const acquired = managedAcquired(fixture.binding, 6);
    const terminated = managedTerminated(fixture.binding, 7, {
      cleanupStatus: 'clean',
      controllerDecision: 'failed',
      failureCode: 'MANAGED_FATAL_SUMMARY',
    });
    expectKernelError(
      () => replayInstanceEvents([...fixture.events, acquired, terminated]),
      'INVALID_MANAGED_BATCH'
    );
  });

  it('enforces cleanup, decision, failure-code, and cancel-state coherence', () => {
    const fixture = managedFixture();
    const acquired = managedAcquired(fixture.binding, 6);
    const acquiredProjection = reduceInstanceEvent(fixture.projection, acquired);
    const cancelRequested: ManagedRunCancelRequestedEvent = {
      ...managedEnvelope(fixture.binding, 7),
      type: 'ManagedRunCancelRequested',
      reason: 'deadline',
    };
    const cancelledProjection = reduceInstanceEvent(acquiredProjection, cancelRequested);

    const invalidRows: Array<{
      readonly projection: InstanceProjection;
      readonly eventId: number;
      readonly cleanupStatus: unknown;
      readonly controllerDecision: unknown;
      readonly failureCode: ManagedRunFailureCode;
    }> = [
      {
        projection: acquiredProjection,
        eventId: 7,
        cleanupStatus: 'dirty',
        controllerDecision: 'failed',
        failureCode: 'MANAGED_FATAL_SUMMARY',
      },
      {
        projection: acquiredProjection,
        eventId: 7,
        cleanupStatus: 'clean',
        controllerDecision: 'unknown',
        failureCode: 'MANAGED_FATAL_SUMMARY',
      },
      {
        projection: acquiredProjection,
        eventId: 7,
        cleanupStatus: 'clean',
        controllerDecision: 'failed',
        failureCode: 'MANAGED_CLOSE_FAILED',
      },
      {
        projection: acquiredProjection,
        eventId: 7,
        cleanupStatus: 'unverified',
        controllerDecision: 'failed',
        failureCode: 'MANAGED_FATAL_SUMMARY',
      },
      {
        projection: acquiredProjection,
        eventId: 7,
        cleanupStatus: 'clean',
        controllerDecision: 'failed',
        failureCode: 'MANAGED_DEADLINE_EXCEEDED',
      },
      {
        projection: cancelledProjection,
        eventId: 8,
        cleanupStatus: 'clean',
        controllerDecision: 'failed',
        failureCode: 'MANAGED_FATAL_SUMMARY',
      },
      {
        projection: acquiredProjection,
        eventId: 7,
        cleanupStatus: 'clean',
        controllerDecision: 'failed',
        failureCode: 'MANAGED_START_FAILED',
      },
    ];

    for (const row of invalidRows) {
      const terminated = {
        ...managedEnvelope(fixture.binding, row.eventId),
        type: 'ManagedRunTerminated',
        cleanupStatus: row.cleanupStatus,
        controllerDecision: row.controllerDecision,
        failureCode: row.failureCode,
      } as unknown as ManagedRunTerminatedEvent;
      const failed = managedAttemptFailed(
        fixture.attempt,
        row.eventId + 1,
        row.failureCode
      );
      if (row.controllerDecision === 'unknown') {
        expectKernelError(
          () => reduceInstanceEvent(row.projection, terminated),
          'INVALID_MANAGED_TERMINAL'
        );
      } else {
        expectKernelError(
          () => reduceInstanceEventBatch(row.projection, [terminated, failed]),
          'INVALID_MANAGED_TERMINAL'
        );
      }
    }

    const ordinaryCloseFailure = managedTerminated(fixture.binding, 7, {
      cleanupStatus: 'unverified',
      controllerDecision: 'failed',
      failureCode: 'MANAGED_CLOSE_FAILED',
    });
    expect(
      reduceInstanceEventBatch(acquiredProjection, [
        ordinaryCloseFailure,
        managedAttemptFailed(fixture.attempt, 8, 'MANAGED_CLOSE_FAILED'),
      ]).managedRunsByAttemptId[fixture.binding.attemptId]
    ).toMatchObject({
      status: 'terminated',
      cleanupStatus: 'unverified',
      failureCode: 'MANAGED_CLOSE_FAILED',
    });
  });

  it('compares all eight binding fields including deep exact scope without partial mutation', () => {
    const fixture = managedFixture();
    const otherScope = instanceIdentity('B').scope;
    const mutations: Array<{
      readonly name: string;
      readonly values: Partial<ManagedRunBindingV1>;
      readonly preserveRunId?: boolean;
    }> = [
      { name: 'session', values: { sessionId: 'wrong-session' } },
      { name: 'check', values: { checkId: 'wrong-check' } },
      { name: 'scope', values: { scope: otherScope } },
      { name: 'run', values: { managedRunId: sha256Canonical('wrong-run') }, preserveRunId: true },
      { name: 'instance', values: { nodeInstanceId: sha256Canonical('wrong-instance') } },
      { name: 'generation', values: { nodeGenerationId: sha256Canonical('wrong-generation') } },
      { name: 'attempt', values: { attemptId: sha256Canonical('wrong-attempt') } },
      { name: 'fence', values: { fence: fixture.binding.fence + 1 } },
    ];

    for (const mutation of mutations) {
      const changed = { ...fixture.binding, ...mutation.values };
      const authority = {
        sessionId: changed.sessionId,
        checkId: changed.checkId,
        scope: changed.scope,
        nodeInstanceId: changed.nodeInstanceId,
        nodeGenerationId: changed.nodeGenerationId,
        attemptId: changed.attemptId,
        fence: changed.fence,
      };
      const binding: ManagedRunBindingV1 = {
        ...changed,
        managedRunId: mutation.preserveRunId
          ? changed.managedRunId
          : deriveManagedRunId(authority),
      };
      const event = managedAcquired(binding, 6);
      expectAnyKernelError(() => reduceInstanceEvent(fixture.projection, event));
      expect(fixture.projection.lastEventId).toBe(5);
      expect(fixture.projection.managedRunsByAttemptId).toEqual({});
    }
  });

  it('associates an attempt terminal with the complete lifecycle binding', () => {
    const fixture = managedFixture();
    const acquiredProjection = reduceInstanceEvent(
      fixture.projection,
      managedAcquired(fixture.binding, 6)
    );
    const terminated = managedTerminated(fixture.binding, 7, {
      cleanupStatus: 'clean',
      controllerDecision: 'failed',
      failureCode: 'MANAGED_FATAL_SUMMARY',
    });
    const mutations: Array<Partial<GeneratedAttemptStartedEvent>> = [
      { sessionId: 'wrong-session' },
      { checkId: 'wrong-check' },
      { scope: instanceIdentity('B').scope },
      { nodeInstanceId: sha256Canonical('wrong-instance') },
      { nodeGenerationId: sha256Canonical('wrong-generation') },
      { attemptId: sha256Canonical('wrong-attempt') },
      { fence: fixture.attempt.fence + 1 },
    ];

    for (const mutation of mutations) {
      const failed = {
        ...managedAttemptFailed(fixture.attempt, 8, 'MANAGED_FATAL_SUMMARY'),
        ...mutation,
      };
      expectKernelError(
        () => reduceInstanceEventBatch(acquiredProjection, [terminated, failed]),
        'INVALID_MANAGED_BATCH'
      );
      expect(acquiredProjection.lastEventId).toBe(6);
      expect(acquiredProjection.managedRunsByAttemptId[fixture.binding.attemptId].status).toBe(
        'acquired'
      );
    }
  });

  it('rejects duplicate, late, wrong-code, and plain acquired-attempt terminal events', () => {
    const fixture = managedFixture();
    const acquired = managedAcquired(fixture.binding, 6);
    const acquiredProjection = reduceInstanceEvent(fixture.projection, acquired);
    expectKernelError(
      () => reduceInstanceEvent(acquiredProjection, { ...acquired, eventId: 7 }),
      'MANAGED_RUN_ALREADY_ACQUIRED'
    );
    expectKernelError(
      () =>
        reduceInstanceEvent(
          acquiredProjection,
          managedAttemptFailed(fixture.attempt, 7, 'MANAGED_POST_PROVIDER_FAILED')
        ),
      'MANAGED_TERMINAL_REQUIRED'
    );

    const started = managedStarted(fixture.binding, 7);
    const startedProjection = reduceInstanceEvent(acquiredProjection, started);
    expectKernelError(
      () => reduceInstanceEvent(startedProjection, { ...started, eventId: 8 }),
      'INVALID_MANAGED_TRANSITION'
    );
    const terminated = managedTerminated(fixture.binding, 8, {
      cleanupStatus: 'clean',
      controllerDecision: 'failed',
      failureCode: 'MANAGED_FAIL_IF',
    });
    expectKernelError(
      () =>
        reduceInstanceEventBatch(startedProjection, [
          terminated,
          managedAttemptFailed(fixture.attempt, 9, 'MANAGED_FATAL_SUMMARY'),
        ]),
      'INVALID_MANAGED_BATCH'
    );
    expect(startedProjection.lastEventId).toBe(7);
  });

  it('accepts the Proof application marker grammar only as an atomic batch header', () => {
    const identity = instanceIdentity('marker');
    const authorityId = sha256Canonical('authority');
    const header = {
      version: 1 as const,
      type: 'ProofCurrentCatalogAuthorityApplied' as const,
      eventId: 1,
      sessionId,
      scope: identity.scope,
      projectSubgraphInstanceId: sha256Canonical('project'),
      authorityId,
      mutationEventCount: 0,
      mutationEventsDigest: deriveProofCurrentCatalogAuthorityMutationDigest({ authorityId, mutations: [] }),
    };
    expectKernelError(
      () => reduceInstanceEventBatch(createInitialInstanceProjection(), [header]),
      'INVALID_PROOF_CURRENT_APPLICATION'
    );
    expectKernelError(
      () => reduceInstanceEventBatch(createInitialInstanceProjection(), [{ ...header, unexpected: true } as any]),
      'INVALID_PROOF_CURRENT_APPLICATION'
    );
  });
});
