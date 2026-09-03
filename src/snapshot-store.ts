/*
 * Internal snapshot store for incremental adoption of snapshot+scope execution.
 * Phase 0: journal only — no behavior change, used for future visibility work.
 */

import type { ReviewSummary } from './reviewer';
import { createHash } from 'crypto';
import type { EventTrigger } from './types/config';
import type { CandidateClaimInput } from './providers/check-provider.interface';
import {
  buildClaimPublishedEvent,
  canonicalJson,
  createInitialClaimProjection,
  exactActiveClaimIds,
  immutableCanonicalValue,
  immutableRuntimeEvent,
  ClaimKernelError,
  reduceClaimEvent,
  replayClaimEvents,
  sha256Canonical,
  type AttemptCompletedEvent,
  type AttemptFailedEvent,
  type AttemptStartedEvent,
  type CheckScheduledEvent,
  type ClaimProjection,
  type ClaimRuntimeEvent,
} from './state-machine/graph/claim-kernel';
import type { ClaimPlan } from './state-machine/graph/claim-plan';
import {
  createInitialInstanceProjection,
  deriveCatalogRequestId,
  canonicalCatalogKey,
  deriveControllerItemClaimId,
  deriveItemFingerprint,
  deriveManagedRunId,
  deriveNodeGenerationId,
  deriveNodeInstanceId,
  deriveSubgraphInstanceId,
  immutableInstanceEvent,
  immutableInstanceProjection,
  queryReadyGenerations,
  reduceInstanceEvent,
  reduceInstanceEventBatch,
  replayInstanceEvents,
  projectExpansionCoverage,
  type CatalogReconciliationRequestedEvent,
  type CatalogRequestAttemptStartedEvent,
  type CatalogRequestCheckScheduledEvent,
  type InstanceProjection,
  type InstanceClaimProjection,
  type InstanceRuntimeEvent,
  type ExpansionCoverageProjection,
  type NodeGenerationProjection,
  type KeyedScopePath,
  type RootScopePath,
  type GeneratedAttemptStartedEvent,
  type GeneratedCheckScheduledEvent,
  type GeneratedClaimPublishedEvent,
  type ManagedRunAcquisitionFailureCode,
  type ManagedRunBindingV1,
  type ManagedRunCleanupStatus,
  type ManagedRunFailureCode,
  type ManagedRunTerminatedEvent,
} from './state-machine/graph/instance-kernel';
import {
  PROOF_ADMIT_NODE_KEY,
  PROOF_CANDIDATE_CLAIM,
  PROOF_ADMITTED_RECEIPT_CLAIM,
  PROOF_CATALOG_REVALIDATION_CLAIM,
  PROOF_STRUCTURAL_INVENTORY_CLAIM,
  PROOF_CATALOG_REVALIDATION_PROVIDER_TYPE,
} from './state-machine/graph/instance-plan';
import { goCompatibleProofJson, proofCandidateAdmissionRequestJson, proofComponentCandidateEnvelopeJson } from './providers/proof-admission-cli-child';
import {
  governedCanonicalJson,
  governedPayloadFingerprint,
  governedResultDigest,
  governedWireModeFromEvidence,
  governedProofCandidateEvidenceJson,
  proofCandidateEvidenceFingerprint,
  immutableGovernedValue,
  immutableProofCandidateEvidence,
  type GovernedWireMode,
} from './providers/proof-wire';
import { validateProofCandidateEvidence, validateProofComponentInvocationAuthority, isGovernedProofComponentSelector, type ProofCandidateEvidenceV1, type ProofComponentInvocationAuthorityV1 } from './providers/governed-proof-inspect-check-provider';
import { validateProofCandidateAdmissionBinding, validateProofCatalogRevalidationProjection, validateProofComponentCandidateAdmissionBinding } from './providers/proof-catalog-check-providers';
import {
  qualifiedNestedExpansionOwner,
  resolveJsonPointer,
  type CompiledExpansion,
  type CompiledTemplateNode,
} from './state-machine/graph/instance-plan';

export type ScopePath = Array<{ check: string; index: number }>;

type CatalogAttemptStartedEvent = AttemptStartedEvent & CatalogRequestAttemptStartedEvent;
type CatalogCheckScheduledEvent = CheckScheduledEvent & CatalogRequestCheckScheduledEvent;
type CatalogScheduleAuthority = Pick<
  CatalogRequestAttemptStartedEvent,
  'requestId' | 'attemptId' | 'fence'
>;
type GeneratedScheduleAuthority = Pick<
  GeneratedAttemptStartedEvent,
  'nodeGenerationId' | 'attemptId' | 'fence'
>;
type WithoutEventId<T> = T extends { readonly eventId: number } ? Omit<T, 'eventId'> : never;
type StagedInstanceRuntimeEvent = WithoutEventId<InstanceRuntimeEvent>;

/** The portable, canonical Graph-v2 runtime prefix. */
export interface GraphJournalCheckpointV1 {
  readonly kind: 'visor.graph-journal-checkpoint';
  readonly version: 1;
  readonly sessionId: string;
  readonly graphSemanticDigest: string;
  readonly frontier: {
    readonly eventCount: number;
    readonly lastEventId: number;
  };
  readonly events: readonly (ClaimRuntimeEvent | InstanceRuntimeEvent)[];
  readonly integrity: {
    readonly algorithm: 'sha256';
    readonly digest: string;
  };
}

export class GraphJournalCheckpointError extends Error {
  readonly code:
  | 'INVALID_CHECKPOINT_ENVELOPE'
  | 'CHECKPOINT_INTEGRITY_MISMATCH'
  | 'CHECKPOINT_GRAPH_MISMATCH'
  | 'INVALID_CHECKPOINT_PREFIX'
  | 'CHECKPOINT_SESSION_MISMATCH'
  | 'CHECKPOINT_PLAN_AUTHORITY_MISMATCH'
  | 'CHECKPOINT_NOT_QUIESCENT';

  constructor(
    code: GraphJournalCheckpointError['code'],
    message: string,
    options?: { cause?: unknown }
  ) {
    super(message, options);
    this.name = 'GraphJournalCheckpointError';
    this.code = code;
  }
}

const CHECKPOINT_SHA256 = /^[0-9a-f]{64}$/;

function checkpointObject(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function checkpointHasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function checkpointString(value: unknown, field: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new GraphJournalCheckpointError('INVALID_CHECKPOINT_ENVELOPE', `${field} must be a non-empty string`);
  }
}

function checkpointSafeInteger(value: unknown, field: string, minimum = 0): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new GraphJournalCheckpointError('INVALID_CHECKPOINT_ENVELOPE', `${field} must be a safe integer >= ${minimum}`);
  }
}

function checkpointExactEventKeys(event: Record<string, unknown>, expected: readonly string[]): void {
  if (!checkpointHasExactKeys(event, expected)) {
    throw new GraphJournalCheckpointError('INVALID_CHECKPOINT_PREFIX', `Runtime event ${String(event.type)} has unknown or missing fields`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!checkpointObject(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function proofDomainDigest(domain: string, encoded: string): string {
  const bytes = Buffer.from(encoded, 'utf8');
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  return `sha256:${createHash('sha256').update(domain, 'utf8').update(Buffer.from([0])).update(length).update(bytes).digest('hex')}`;
}

function componentAuthorityFailure(detail: string): never {
  throw new ClaimKernelError('INVALID_PROOF_COMPONENT_AUTHORITY', detail);
}

function exactParentIds(actual: readonly string[], expected: readonly string[], label: string): void {
  const sorted = [...actual].sort();
  if (actual.length !== expected.length || new Set(actual).size !== actual.length ||
      canonicalJson(actual) !== canonicalJson(sorted) || canonicalJson(actual) !== canonicalJson([...expected].sort())) {
    componentAuthorityFailure(`${label} parents are not the exact sorted lineage`);
  }
}

function claimAt(
  projection: InstanceProjection,
  claimId: string,
  label: string,
  expectedClaim: string,
): InstanceClaimProjection {
  const claim = projection.claimsById[claimId];
  if (!claim || !claim.active || claim.claim !== expectedClaim) {
    componentAuthorityFailure(`${label} is missing, inactive, or has the wrong claim`);
  }
  return claim;
}

function generatedClaimView(claim: InstanceClaimProjection, label: string): CandidateClaimInput {
  if (claim.kind !== 'generated-output' || claim.producerAttemptId === undefined || claim.producerFence === undefined) {
    componentAuthorityFailure(`${label} is not an attempt-produced claim`);
  }
  return {
    claimId: claim.claimId,
    claim: claim.claim,
    payload: claim.payload,
    payloadFingerprint: claim.payloadFingerprint,
    producerCheckId: claim.producerCheckId,
    scope: claim.scope,
    parentClaimIds: claim.parentClaimIds,
    wireMode: claim.wireMode,
    provenance: 'attempt',
    attemptId: claim.producerAttemptId,
    fence: claim.producerFence,
    ...(claim.proofCandidateEvidence ? { proofAdmission: claim.proofCandidateEvidence } : {}),
  } as CandidateClaimInput;
}

/**
 * Pure, direct Proof component lineage assembly.  The component item is the
 * only starting point: all other claims are resolved through its exact
 * catalog parent and that catalog's four authenticated inputs.  In
 * particular, this must never search the projection for a matching component
 * ID, admission, or revalidation from another project/attempt.
 */
function assembleProofComponentInvocationAuthority(
  projection: InstanceProjection,
  component: InstanceClaimProjection,
  admissionRequest: string,
): ProofComponentInvocationAuthorityV1 {
  if (!component.active || component.kind !== 'controller-item' || component.claim !== 'component.work_item@1' ||
      !component.controllerCatalogClaimId || component.parentClaimIds.length !== 1 ||
      component.parentClaimIds[0] !== component.controllerCatalogClaimId) {
    componentAuthorityFailure('activated component WorkItem is not bound to one controller catalog');
  }
  const catalog = claimAt(projection, component.controllerCatalogClaimId, 'component catalog', 'component.catalog@1');
  const parentScope = component.scope.slice(0, -1);
  const parentScopeSegment = parentScope[parentScope.length - 1];
  const catalogProducer = catalog.nodeGenerationId ? projection.generationsById[catalog.nodeGenerationId] : undefined;
  if (catalog.kind !== 'generated-output' || catalog.producerCheckId !== 'materialize_catalog' ||
      canonicalJson(catalog.scope) !== canonicalJson(parentScope) ||
      !parentScopeSegment || catalog.subgraphInstanceId !== parentScopeSegment.subgraphInstanceId ||
      !catalogProducer || catalogProducer.checkId !== 'materialize_catalog' || catalogProducer.status !== 'completed' ||
      !catalogProducer.completedOutputClaimIds.includes(catalog.claimId) ||
      catalog.producerAttemptId !== catalogProducer.attemptId || catalog.producerFence !== catalogProducer.fence) {
    componentAuthorityFailure('component catalog is not the exact materialization parent');
  }
  const catalogParents = catalog.parentClaimIds;
  if (catalogParents.length !== 4 || new Set(catalogParents).size !== 4 ||
      canonicalJson(catalogParents) !== canonicalJson([...catalogParents].sort())) {
    componentAuthorityFailure('component catalog parent set is not exact');
  }
  const parents = catalogParents.map(claimId => projection.claimsById[claimId]);
  if (parents.some(parent => !parent || !parent.active)) componentAuthorityFailure('component catalog has an inactive parent');
  const inventory = parents.find(parent => parent.claim === PROOF_STRUCTURAL_INVENTORY_CLAIM);
  const candidate = parents.find(parent => parent.claim === PROOF_CANDIDATE_CLAIM);
  const admission = parents.find(parent => parent.claim === PROOF_ADMITTED_RECEIPT_CLAIM);
  const revalidation = parents.find(parent => parent.claim === PROOF_CATALOG_REVALIDATION_CLAIM);
  if (!inventory || !candidate || !admission || !revalidation ||
      [inventory, candidate, admission, revalidation].some((claim, index, all) => all.indexOf(claim) !== index)) {
    componentAuthorityFailure('component catalog does not have one exact Proof lineage parent of each kind');
  }
  for (const claim of [inventory, candidate, admission, revalidation]) {
    if (canonicalJson(claim.scope) !== canonicalJson(catalog.scope)) componentAuthorityFailure('Proof lineage scope is detached');
  }
  if (candidate.producerCheckId !== 'inspect' || candidate.kind !== 'generated-output' ||
      candidate.proofCandidateEvidence === undefined || governedWireModeFromEvidence(candidate.proofCandidateEvidence) !== 'proof' ||
      candidate.proofCandidateEvidence.role.invocation.output_schema_id !== 'proof.component-catalog-candidate@1') {
    componentAuthorityFailure('catalog parent is not a governed Proof candidate');
  }
  if (candidate.parentClaimIds.length !== 2 || !candidate.parentClaimIds.includes(inventory.claimId) ||
      candidate.parentClaimIds.some(parentId => !projection.claimsById[parentId]?.active) ||
      canonicalJson(candidate.parentClaimIds) !== canonicalJson([...candidate.parentClaimIds].sort())) {
    componentAuthorityFailure('candidate ancestry is not exact');
  }
  exactParentIds(admission.parentClaimIds, [candidate.claimId], 'admission');
  if (admission.kind !== 'generated-output' || admission.producerCheckId !== PROOF_ADMIT_NODE_KEY ||
      canonicalJson(admission.scope) !== canonicalJson(candidate.scope)) {
    componentAuthorityFailure('admission is not the exact proof_admit result');
  }
  exactParentIds(revalidation.parentClaimIds, [inventory.claimId, candidate.claimId, admission.claimId], 'revalidation');
  if (revalidation.kind !== 'generated-output' || revalidation.producerCheckId !== 'revalidate_catalog' ||
      canonicalJson(revalidation.scope) !== canonicalJson(candidate.scope)) {
    componentAuthorityFailure('revalidation is not the exact current catalog projection');
  }

  let candidateEnvelope: Record<string, unknown>;
  try {
    const parsed = JSON.parse(admissionRequest) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || !parsed.candidate || typeof parsed.candidate !== 'object' || Array.isArray(parsed.candidate)) {
      componentAuthorityFailure('admission request has no candidate envelope');
    }
    candidateEnvelope = parsed.candidate as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ClaimKernelError) throw error;
    componentAuthorityFailure('admission request is not valid JSON');
  }
  const candidateView = generatedClaimView(candidate, 'candidate');
  const admissionView = generatedClaimView(admission, 'admission');
  let admitted: ReturnType<typeof validateProofCandidateAdmissionBinding>;
  try {
    admitted = validateProofCandidateAdmissionBinding(candidateView, admissionView);
  } catch (error) {
    componentAuthorityFailure(`candidate admission binding is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const publication = candidateEnvelope.Publication;
  if (!publication || typeof publication !== 'object' || Array.isArray(publication) ||
      (publication as Record<string, unknown>).ClaimID !== candidate.claimId ||
      (publication as Record<string, unknown>).Claim !== candidate.claim ||
      (publication as Record<string, unknown>).PayloadFingerprint !== candidate.payloadFingerprint ||
      canonicalJson((publication as Record<string, unknown>).ParentClaimIDs) !== canonicalJson(candidate.parentClaimIds)) {
    componentAuthorityFailure('admission candidate envelope is detached from the candidate claim');
  }
  const candidateID = proofDomainDigest('proof.role-result-candidate-envelope/id/v1', proofComponentCandidateEnvelopeJson(candidateEnvelope));
  if (admitted.receipt.CandidateID !== candidateID) {
    componentAuthorityFailure('admission receipt CandidateID is detached from the authenticated candidate envelope');
  }
  let revalidationProjection: Record<string, unknown>;
  const inventoryPayload = inventory.payload;
  const projectID = (candidate.payload as Record<string, unknown>)?.project_id;
  if (typeof projectID !== 'string' || !inventoryPayload || typeof inventoryPayload !== 'object') componentAuthorityFailure('Proof lineage project is unavailable');
  try {
    revalidationProjection = validateProofCatalogRevalidationProjection(
      revalidation.payload,
      inventoryPayload as Record<string, unknown>,
      admitted.candidate,
      admissionView,
      projectID,
      generatedClaimView(revalidation, 'revalidation'),
      inventory.claimId,
    );
  } catch (error) {
    componentAuthorityFailure(`current revalidation is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const componentPayload = component.payload;
  if (!componentPayload || typeof componentPayload !== 'object' || Array.isArray(componentPayload)) componentAuthorityFailure('component WorkItem payload is invalid');
  const payload = componentPayload as Record<string, unknown>;
  const mapping = payload.proof_path_mapping;
  const subject = payload.proof_component_subject;
  const workItem = {
    version: payload.version,
    project_id: payload.project_id,
    component_id: payload.component_id,
    sorted_owned_paths: payload.sorted_owned_paths,
    sorted_dependency_closure: payload.sorted_dependency_closure,
    proof_path_mapping: mapping && { paths: (mapping as Record<string, unknown>).paths, components: (mapping as Record<string, unknown>).components, owner: (mapping as Record<string, unknown>).owner, risk_tier: (mapping as Record<string, unknown>).risk_tier, enforcement: (mapping as Record<string, unknown>).enforcement },
    proof_input_state: Array.isArray(payload.proof_input_state) ? (payload.proof_input_state as Array<Record<string, unknown>>).map(row => ({ owner_kind: row.owner_kind, owner_id: row.owner_id, input_kind: row.input_kind, path: row.path, file_hash: row.file_hash })) : payload.proof_input_state,
    proof_component_subject: subject && { version: (subject as Record<string, unknown>).version, project_id: (subject as Record<string, unknown>).project_id, component_id: (subject as Record<string, unknown>).component_id, sorted_owned_paths: (subject as Record<string, unknown>).sorted_owned_paths, sorted_dependency_closure: (subject as Record<string, unknown>).sorted_dependency_closure, fingerprint: (subject as Record<string, unknown>).fingerprint },
  };
  const revalidationReceipt = (revalidationProjection as Record<string, unknown>).receipt;
  const row = revalidationReceipt && typeof revalidationReceipt === 'object' && !Array.isArray(revalidationReceipt)
    ? ((revalidationReceipt as Record<string, unknown>).component_authorities as unknown[] | undefined)?.find(value => value && typeof value === 'object' && !Array.isArray(value) && (value as Record<string, unknown>).component_id === payload.component_id) as Record<string, unknown> | undefined
    : undefined;
  const workItemDigest = `sha256:${createHash('sha256').update(goCompatibleProofJson(workItem), 'utf8').digest('hex')}`;
  const compact = payload.authority;
  if (!row || !compact || typeof compact !== 'object' || Array.isArray(compact) ||
      canonicalJson(compact) !== canonicalJson({ component_id: row.component_id, work_item_digest: row.work_item_digest, subject: row.subject }) ||
      row.work_item_digest !== workItemDigest || canonicalJson(row.subject) !== canonicalJson(subject)) {
    componentAuthorityFailure('component WorkItem compact authority is detached from current revalidation');
  }
  let admissionDecision: unknown;
  try { admissionDecision = JSON.parse(admitted.wire); } catch {
    componentAuthorityFailure('admission decision wire is not JSON');
  }
  return validateProofComponentInvocationAuthority({
    work_item_digest: row.work_item_digest,
    subject: row.subject,
    candidate: admitted.candidate.payload,
    // Preserve the complete authenticated decision (version/status/receipt/
    // reject_code), not just its receipt projection.
    admission: admissionDecision,
    work_item: workItem,
    catalog_revalidation_receipt: revalidationReceipt,
  });
}

/** Bind the dynamic C0 invocation digest to the exact child admission in the
 * same component instance. This is deliberately optional while the child
 * inspect is pre-admission; once proof_admit has completed, absence is a
 * terminal lineage error rather than an invitation to search globally. */
function validateComponentChildAdmission(
  projection: InstanceProjection,
  subgraphInstanceId: string,
  requireCompleted: boolean,
): void {
  const generations = Object.values(projection.generationsById).filter(generation => generation.subgraphInstanceId === subgraphInstanceId);
  const inspectGenerations = generations.filter(generation => generation.templateNodeKey === 'inspect' && generation.status === 'completed');
  if (inspectGenerations.length === 0) {
    if (requireCompleted) componentAuthorityFailure('component admission has no completed inspect candidate');
    return;
  }
  if (inspectGenerations.length !== 1) componentAuthorityFailure('component inspect candidate lineage is ambiguous');
  const inspect = inspectGenerations[0];
  const candidateClaims = inspect.completedOutputClaimIds.map(claimId => projection.claimsById[claimId]).filter(claim => claim?.claim === PROOF_CANDIDATE_CLAIM);
  if (candidateClaims.length !== 1) componentAuthorityFailure('component inspect has no unique candidate output');
  const admitGenerations = generations.filter(generation => generation.templateNodeKey === PROOF_ADMIT_NODE_KEY && generation.status === 'completed');
  if (admitGenerations.length === 0) {
    if (requireCompleted) componentAuthorityFailure('component admission has not completed');
    return;
  }
  if (admitGenerations.length !== 1) componentAuthorityFailure('component admission lineage is ambiguous');
  const admissionGeneration = admitGenerations[0];
  const candidate = candidateClaims[0];
  if (admissionGeneration.activeInputClaimIds.length !== 1 || admissionGeneration.activeInputClaimIds[0] !== candidate.claimId) {
    componentAuthorityFailure('component admission does not consume the exact child candidate');
  }
  const admissionClaims = admissionGeneration.completedOutputClaimIds.map(claimId => projection.claimsById[claimId]).filter(claim => claim?.claim === PROOF_ADMITTED_RECEIPT_CLAIM);
  if (admissionClaims.length !== 1) componentAuthorityFailure('component admission has no unique receipt output');
  try {
    validateProofComponentCandidateAdmissionBinding(generatedClaimView(candidate, 'component candidate'), generatedClaimView(admissionClaims[0], 'component admission'));
  } catch (error) {
    componentAuthorityFailure(`component admission is detached from its resolved C0 invocation: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function checkpointWrap(
  code: GraphJournalCheckpointError['code'],
  message: string,
  error: unknown
): GraphJournalCheckpointError {
  if (error instanceof GraphJournalCheckpointError) return error;
  return new GraphJournalCheckpointError(code, message, { cause: error });
}

type CheckpointRuntimeEvent = ClaimRuntimeEvent | InstanceRuntimeEvent;

const ATTEMPT_BASE_KEYS = ['version', 'type', 'eventId', 'sessionId', 'checkId', 'scope', 'attemptId', 'fence'] as const;

function eventHasNodeDiscriminator(event: Record<string, unknown>): boolean {
  return hasOwn(event, 'nodeInstanceId') || hasOwn(event, 'nodeGenerationId');
}

function eventHasRequestDiscriminator(event: Record<string, unknown>): boolean {
  return hasOwn(event, 'requestId');
}

function validateCheckpointEventShape(value: unknown): CheckpointRuntimeEvent {
  let event = checkpointObject(value);
  if (!event || typeof event.type !== 'string') {
    throw new GraphJournalCheckpointError('INVALID_CHECKPOINT_PREFIX', 'Runtime event must be an object with a discriminator');
  }

  // Checkpoint v1 predates the explicit generated-publication wire mode.  It
  // is safe to migrate at the trusted restore boundary: non-candidate
  // generated claims were always graph-canonical, while candidate mode is
  // derivable only from its validated governed evidence invocation.
  if (event.type === 'ClaimPublished' && eventHasNodeDiscriminator(event) && !hasOwn(event, 'wireMode')) {
    let wireMode: GovernedWireMode = 'generic';
    if (event.claim === PROOF_CANDIDATE_CLAIM) {
      try {
        wireMode = governedWireModeFromEvidence(validateProofCandidateEvidence(event.proofCandidateEvidence));
      } catch (error) {
        throw checkpointWrap('INVALID_CHECKPOINT_PREFIX', 'Legacy Proof candidate publication cannot derive its wire mode', error);
      }
    }
    event = { ...event, wireMode };
  }

  const exact = (keys: readonly string[]): void => checkpointExactEventKeys(event, keys);
  const base = (): void => {
    if (event.version !== 1 || typeof event.eventId !== 'number' || !Number.isSafeInteger(event.eventId) || event.eventId < 1 ||
        typeof event.sessionId !== 'string' || event.sessionId.length === 0 || typeof event.scope === 'undefined') {
      throw new GraphJournalCheckpointError('INVALID_CHECKPOINT_PREFIX', `Runtime event ${event.type} has invalid base fields`);
    }
  };

  switch (event.type) {
    case 'CatalogReconciliationRequested':
      exact(['version', 'type', 'eventId', 'sessionId', 'scope', 'requestId', 'requestOrdinal', 'expansionOwnerCheck', 'status']);
      base();
      if (typeof event.requestId !== 'string' || typeof event.expansionOwnerCheck !== 'string' || event.status !== 'pending' ||
          typeof event.requestOrdinal !== 'number' || !Number.isSafeInteger(event.requestOrdinal) || event.requestOrdinal < 1) {
        throw new GraphJournalCheckpointError('INVALID_CHECKPOINT_PREFIX', 'Catalog request event has invalid fields');
      }
      return event as unknown as CatalogReconciliationRequestedEvent;
    case 'SubgraphExpanded': {
      const nested = event.parentSubgraphInstanceId !== null;
      exact(nested
        ? ['version', 'type', 'eventId', 'sessionId', 'scope', 'expansionOwnerCheck', 'graphSemanticDigest', 'expansionSpecDigest', 'templateDigest', 'parentSubgraphInstanceId', 'expansionOwnerNodeInstanceId', 'catalogClaimRef', 'catalogClaimId', 'itemKey', 'subgraphInstanceId', 'nodeInstanceIdsByTemplateNode']
        : ['version', 'type', 'eventId', 'sessionId', 'scope', 'expansionOwnerCheck', 'graphSemanticDigest', 'expansionSpecDigest', 'templateDigest', 'parentSubgraphInstanceId', 'catalogClaimId', 'itemKey', 'subgraphInstanceId', 'nodeInstanceIdsByTemplateNode']);
      base();
      if (typeof event.expansionOwnerCheck !== 'string' || typeof event.graphSemanticDigest !== 'string' ||
          typeof event.expansionSpecDigest !== 'string' || typeof event.templateDigest !== 'string' ||
          (nested && (typeof event.expansionOwnerNodeInstanceId !== 'string' || typeof event.catalogClaimRef !== 'string')) ||
          typeof event.catalogClaimId !== 'string' || typeof event.itemKey !== 'string' ||
          typeof event.subgraphInstanceId !== 'string' || !isRecord(event.nodeInstanceIdsByTemplateNode)) {
        throw new GraphJournalCheckpointError('INVALID_CHECKPOINT_PREFIX', 'Expanded subgraph event has invalid fields');
      }
      return event as unknown as InstanceRuntimeEvent;
    }
    case 'ControllerItemClaimPublished':
      exact(['version', 'type', 'eventId', 'sessionId', 'scope', 'expansionOwnerCheck', 'expansionSpecDigest', 'catalogClaimId', 'itemKey', 'subgraphInstanceId', 'incarnation', 'claimId', 'claim', 'payload', 'payloadFingerprint', 'parentClaimIds']);
      base();
      if (typeof event.expansionOwnerCheck !== 'string' || typeof event.expansionSpecDigest !== 'string' || typeof event.catalogClaimId !== 'string' ||
          typeof event.itemKey !== 'string' || typeof event.subgraphInstanceId !== 'string' || typeof event.incarnation !== 'number' || !Number.isSafeInteger(event.incarnation) || event.incarnation < 1 ||
          typeof event.claimId !== 'string' || typeof event.claim !== 'string' || typeof event.payloadFingerprint !== 'string' ||
          !Array.isArray(event.parentClaimIds)) throw new GraphJournalCheckpointError('INVALID_CHECKPOINT_PREFIX', 'Controller item event has invalid fields');
      return event as unknown as InstanceRuntimeEvent;
    case 'NodeGenerationInactivated':
      exact(['version', 'type', 'eventId', 'sessionId', 'scope', 'subgraphInstanceId', 'nodeInstanceId', 'nodeGenerationId', 'incarnation', 'outputClaimIds', 'reason']);
      base();
      if (typeof event.subgraphInstanceId !== 'string' || typeof event.nodeInstanceId !== 'string' || typeof event.nodeGenerationId !== 'string' ||
          typeof event.incarnation !== 'number' || !Number.isSafeInteger(event.incarnation) || event.incarnation < 0 || !Array.isArray(event.outputClaimIds) || event.reason !== 'superseded') {
        throw new GraphJournalCheckpointError('INVALID_CHECKPOINT_PREFIX', 'Generation inactivation event has invalid fields');
      }
      return event as unknown as InstanceRuntimeEvent;
    case 'NodeGenerationActivated':
      exact(hasOwn(event, 'nestedExpansionCatalogClaimRef')
        ? ['version', 'type', 'eventId', 'sessionId', 'scope', 'subgraphInstanceId', 'nodeInstanceId', 'nodeGenerationId', 'templateNodeKey', 'checkId', 'incarnation', 'itemFingerprint', 'executionConfigDigest', 'activeInputClaimIds', 'nestedExpansionCatalogClaimRef']
        : ['version', 'type', 'eventId', 'sessionId', 'scope', 'subgraphInstanceId', 'nodeInstanceId', 'nodeGenerationId', 'templateNodeKey', 'checkId', 'incarnation', 'itemFingerprint', 'executionConfigDigest', 'activeInputClaimIds']);
      base();
      if (typeof event.subgraphInstanceId !== 'string' || typeof event.nodeInstanceId !== 'string' || typeof event.nodeGenerationId !== 'string' || typeof event.templateNodeKey !== 'string' || typeof event.checkId !== 'string' ||
          typeof event.incarnation !== 'number' || !Number.isSafeInteger(event.incarnation) || event.incarnation < 0 || typeof event.itemFingerprint !== 'string' || typeof event.executionConfigDigest !== 'string' || !Array.isArray(event.activeInputClaimIds) ||
          (hasOwn(event, 'nestedExpansionCatalogClaimRef') && typeof event.nestedExpansionCatalogClaimRef !== 'string')) throw new GraphJournalCheckpointError('INVALID_CHECKPOINT_PREFIX', 'Generation activation event has invalid fields');
      return event as unknown as InstanceRuntimeEvent;
    case 'SubgraphTombstoned':
      exact(['version', 'type', 'eventId', 'sessionId', 'scope', 'expansionOwnerCheck', 'sourceCatalogClaimId', 'itemKey', 'subgraphInstanceId', 'lastIncarnation', 'nodeGenerationIds', 'outputClaimIds']);
      base();
      if (typeof event.expansionOwnerCheck !== 'string' || typeof event.sourceCatalogClaimId !== 'string' || typeof event.itemKey !== 'string' || typeof event.subgraphInstanceId !== 'string' || typeof event.lastIncarnation !== 'number' || !Number.isSafeInteger(event.lastIncarnation) || event.lastIncarnation < 0 || !Array.isArray(event.nodeGenerationIds) || !Array.isArray(event.outputClaimIds)) throw new GraphJournalCheckpointError('INVALID_CHECKPOINT_PREFIX', 'Tombstone event has invalid fields');
      return event as unknown as InstanceRuntimeEvent;
    case 'ManagedRunAcquisitionFailed':
      exact(['version', 'type', 'eventId', 'sessionId', 'scope', 'binding', 'failureCode']);
      base();
      if (!isRecord(event.binding) || typeof event.failureCode !== 'string') throw new GraphJournalCheckpointError('INVALID_CHECKPOINT_PREFIX', 'Managed acquisition event has invalid fields');
      return event as unknown as InstanceRuntimeEvent;
    case 'ManagedRunAcquired':
    case 'ManagedRunStarted':
      exact(['version', 'type', 'eventId', 'sessionId', 'scope', 'binding']);
      base();
      if (!isRecord(event.binding)) throw new GraphJournalCheckpointError('INVALID_CHECKPOINT_PREFIX', 'Managed lifecycle event has invalid binding');
      return event as unknown as InstanceRuntimeEvent;
    case 'ManagedRunCancelRequested':
      exact(['version', 'type', 'eventId', 'sessionId', 'scope', 'binding', 'reason']);
      base();
      if (!isRecord(event.binding) || event.reason !== 'deadline') throw new GraphJournalCheckpointError('INVALID_CHECKPOINT_PREFIX', 'Managed cancel event has invalid fields');
      return event as unknown as InstanceRuntimeEvent;
    case 'ManagedRunTerminated':
      exact(['version', 'type', 'eventId', 'sessionId', 'scope', 'binding', 'cleanupStatus', 'controllerDecision', 'failureCode']);
      base();
      if (!isRecord(event.binding) || (event.cleanupStatus !== 'clean' && event.cleanupStatus !== 'unverified') || (event.controllerDecision !== 'completed' && event.controllerDecision !== 'failed') || (event.failureCode !== null && typeof event.failureCode !== 'string')) throw new GraphJournalCheckpointError('INVALID_CHECKPOINT_PREFIX', 'Managed terminal event has invalid fields');
      return event as unknown as InstanceRuntimeEvent;
    case 'AttemptStarted':
    case 'CheckScheduled':
    case 'AttemptCompleted':
    case 'AttemptFailed': {
      const node = eventHasNodeDiscriminator(event);
      const request = eventHasRequestDiscriminator(event);
      if (node && request) throw new GraphJournalCheckpointError('INVALID_CHECKPOINT_PREFIX', `${event.type} cannot carry request and node discriminators`);
      const keys: string[] = [...ATTEMPT_BASE_KEYS];
      if (node) keys.push('nodeInstanceId', 'nodeGenerationId');
      else if (request) keys.push('requestId');
      if (event.type === 'CheckScheduled') keys.push('claimIds');
      if (event.type === 'AttemptCompleted' && request) keys.push('catalogClaimId');
      if (event.type === 'AttemptFailed') keys.push('reason');
      exact(keys);
      base();
      if (typeof event.checkId !== 'string' || typeof event.attemptId !== 'string' || typeof event.fence !== 'number' || !Number.isSafeInteger(event.fence) || event.fence < 1 ||
          (node && (typeof event.nodeInstanceId !== 'string' || typeof event.nodeGenerationId !== 'string')) ||
          (request && typeof event.requestId !== 'string') || (event.type === 'CheckScheduled' && !Array.isArray(event.claimIds)) ||
          (event.type === 'AttemptCompleted' && request && typeof event.catalogClaimId !== 'string') || (event.type === 'AttemptFailed' && typeof event.reason !== 'string')) {
        throw new GraphJournalCheckpointError('INVALID_CHECKPOINT_PREFIX', `${event.type} has invalid fields`);
      }
      return event as unknown as CheckpointRuntimeEvent;
    }
    case 'ClaimPublished': {
      const node = eventHasNodeDiscriminator(event);
      if (eventHasRequestDiscriminator(event)) throw new GraphJournalCheckpointError('INVALID_CHECKPOINT_PREFIX', 'ClaimPublished cannot carry requestId');
      const sidecar = event.claim === PROOF_CANDIDATE_CLAIM && hasOwn(event, 'proofCandidateEvidence');
      if (event.claim === PROOF_CANDIDATE_CLAIM && (!sidecar || !hasOwn(event, 'proofCandidateEvidenceFingerprint')) || event.claim !== PROOF_CANDIDATE_CLAIM && (hasOwn(event, 'proofCandidateEvidence') || hasOwn(event, 'proofCandidateEvidenceFingerprint'))) throw new GraphJournalCheckpointError('INVALID_CHECKPOINT_PREFIX', 'Proof evidence sidecar fields are not paired or reserved');
      const evidenceKeys = sidecar ? ['proofCandidateEvidence', 'proofCandidateEvidenceFingerprint'] : [];
      const keys = node
        ? [...ATTEMPT_BASE_KEYS, 'nodeInstanceId', 'nodeGenerationId', 'claimId', 'claim', 'payload', 'payloadFingerprint', 'producerCheckId', 'parentClaimIds', 'wireMode', ...evidenceKeys]
        : [...ATTEMPT_BASE_KEYS, 'claimId', 'claim', 'payload', 'payloadFingerprint', 'producerCheckId', 'parentClaimIds', ...evidenceKeys];
      exact(keys);
      base();
      if (typeof event.checkId !== 'string' || typeof event.attemptId !== 'string' || typeof event.fence !== 'number' || !Number.isSafeInteger(event.fence) || event.fence < 1 ||
          typeof event.claimId !== 'string' || typeof event.claim !== 'string' || typeof event.payloadFingerprint !== 'string' || typeof event.producerCheckId !== 'string' || !Array.isArray(event.parentClaimIds) ||
          (node && (typeof event.nodeInstanceId !== 'string' || typeof event.nodeGenerationId !== 'string' || (event.wireMode !== 'generic' && event.wireMode !== 'proof'))) || (sidecar && typeof event.proofCandidateEvidenceFingerprint !== 'string')) throw new GraphJournalCheckpointError('INVALID_CHECKPOINT_PREFIX', 'Claim publication has invalid fields');
      return event as unknown as CheckpointRuntimeEvent;
    }
    default:
      throw new GraphJournalCheckpointError('INVALID_CHECKPOINT_PREFIX', `Unknown runtime event type ${event.type}`);
  }
}

function routeCheckpointEvent(event: CheckpointRuntimeEvent): { claim: boolean; instance: boolean } {
  if (event.type === 'ClaimPublished') return 'nodeGenerationId' in event ? { claim: false, instance: true } : { claim: true, instance: false };
  if (event.type === 'AttemptStarted' || event.type === 'CheckScheduled' || event.type === 'AttemptCompleted' || event.type === 'AttemptFailed') {
    if ('nodeGenerationId' in event) return { claim: false, instance: true };
    if ('requestId' in event) return { claim: true, instance: true };
    return { claim: true, instance: false };
  }
  return { claim: false, instance: true };
}

function checkpointAuthorityFailure(message: string): never {
  throw new GraphJournalCheckpointError('CHECKPOINT_PLAN_AUTHORITY_MISMATCH', message);
}

function expansionForCheckpoint(
  plan: ClaimPlan,
  owner: string,
  nested: boolean
): CompiledExpansion {
  const expansion = nested
    ? plan.expansionPlan?.byNestedOwner[owner]
    : plan.expansionPlan?.byOwner[owner];
  if (!expansion) checkpointAuthorityFailure(`Unknown compiled expansion owner ${owner}`);
  return expansion;
}

function validateCheckpointPlanAuthority(
  event: InstanceRuntimeEvent,
  plan: ClaimPlan,
  claimProjection: ClaimProjection,
  instanceProjection: InstanceProjection,
  legacyProofWireMode = false,
): void {
  const expansionPlan = plan.expansionPlan;
  if (!expansionPlan?.active) checkpointAuthorityFailure('Checkpoint requires an active expansion plan');
  const asRecord = event as unknown as Record<string, unknown>;
  if (event.type === 'CatalogReconciliationRequested') {
    expansionForCheckpoint(plan, event.expansionOwnerCheck, false);
    return;
  }
  if (event.type === 'SubgraphExpanded') {
    const nested = event.parentSubgraphInstanceId !== null;
    const expansion = expansionForCheckpoint(plan, event.expansionOwnerCheck, nested);
    if (event.graphSemanticDigest !== expansion.graphSemanticDigest ||
        event.expansionSpecDigest !== expansion.expansionSpecDigest ||
        event.templateDigest !== expansion.templateDigest ||
        event.catalogClaimId.length === 0 || event.itemKey.length === 0) {
      checkpointAuthorityFailure('Expanded subgraph does not match the compiled expansion authority');
    }
    const templateKeys = [...expansion.template.templateNodeKeys].sort();
    const eventKeys = Object.keys(event.nodeInstanceIdsByTemplateNode).sort();
    if (canonicalJson(templateKeys) !== canonicalJson(eventKeys)) {
      checkpointAuthorityFailure('Expanded subgraph node key set does not match the compiled template');
    }
    if (!nested) {
      const catalog = claimProjection.claims[event.catalogClaimId];
      if (!catalog || claimProjection.activeClaimIdsByRef[expansion.catalogClaimRef] !== event.catalogClaimId || catalog.claim !== expansion.catalogClaimRef || catalog.producerCheckId !== event.expansionOwnerCheck || catalog.scope.length !== 0) {
        checkpointAuthorityFailure('Root expansion catalog claim is not the exact projected authority');
      }
    }
    return;
  }
  if (event.type === 'ControllerItemClaimPublished') {
    const instance = instanceProjection.instancesById[event.subgraphInstanceId];
    if (!instance) checkpointAuthorityFailure('Controller item claim references an unknown instance');
    const nested = !!instance.parentSubgraphInstanceId;
    const expansion = expansionForCheckpoint(plan, event.expansionOwnerCheck, nested);
    if (instance.expansionOwnerCheck !== event.expansionOwnerCheck ||
        event.expansionSpecDigest !== expansion.expansionSpecDigest || event.claim !== expansion.itemClaimRef) {
      checkpointAuthorityFailure('Controller item claim does not match the compiled expansion authority');
    }
    if (!nested) {
      const catalog = claimProjection.claims[event.catalogClaimId];
      if (!catalog || claimProjection.activeClaimIdsByRef[expansion.catalogClaimRef] !== event.catalogClaimId || catalog.claim !== expansion.catalogClaimRef) {
        checkpointAuthorityFailure('Controller item catalog claim is not the exact active plan authority');
      }
    }
    try { expansion.itemValidator(event.payload); } catch (error) {
      throw new GraphJournalCheckpointError('CHECKPOINT_PLAN_AUTHORITY_MISMATCH', 'Controller item payload violates the compiled item validator', { cause: error });
    }
    return;
  }
  if (event.type === 'NodeGenerationActivated') {
    const instance = instanceProjection.instancesById[event.subgraphInstanceId];
    if (!instance) checkpointAuthorityFailure('Generation activation references an unknown instance');
    const expansion = expansionForCheckpoint(plan, instance.expansionOwnerCheck, !!instance.parentSubgraphInstanceId);
    const node = expansion.template.nodesByKey[event.templateNodeKey];
    const nestedOwner = qualifiedNestedExpansionOwner(expansion.template.name, event.templateNodeKey);
    const nestedExpansion = expansionPlan.byNestedOwner[nestedOwner];
    if (!node || event.executionConfigDigest !== node.executionConfigDigest ||
        (nestedExpansion ? event.nestedExpansionCatalogClaimRef !== nestedExpansion.catalogClaimRef : hasOwn(asRecord, 'nestedExpansionCatalogClaimRef'))) {
      checkpointAuthorityFailure('Generation activation does not match the compiled template node authority');
    }
    return;
  }
  if ('nodeGenerationId' in event && event.type === 'ClaimPublished') {
    const generation = instanceProjection.generationsById[event.nodeGenerationId];
    if (!generation) checkpointAuthorityFailure('Generated claim references an unknown generation');
    const expansion = expansionForCheckpoint(plan, instanceProjection.instancesById[generation.subgraphInstanceId].expansionOwnerCheck, !!instanceProjection.instancesById[generation.subgraphInstanceId].parentSubgraphInstanceId);
    const node = expansion.template.nodesByKey[generation.templateNodeKey];
    if (!node || !node.emissions.some(emission => emission.claim === event.claim)) checkpointAuthorityFailure('Generated claim is not declared by its compiled template node');
    const sidecar = event.claim === PROOF_CANDIDATE_CLAIM;
    const compiledWireMode = compiledManagedProofWireMode(generation, node);
    if (event.wireMode !== 'generic' && event.wireMode !== 'proof') checkpointAuthorityFailure('Generated claim wire mode is invalid');
    if (compiledWireMode === 'proof' && event.wireMode !== 'proof' &&
        !(legacyProofWireMode && event.wireMode === 'generic' && event.claim === PROOF_CATALOG_REVALIDATION_CLAIM)) {
      checkpointAuthorityFailure('Proof catalog publication is not using its compiled Proof wire mode');
    }
    if (compiledWireMode !== 'proof' && event.claim !== PROOF_CANDIDATE_CLAIM && event.wireMode !== 'generic') checkpointAuthorityFailure('Proof wire mode is reserved for governed evidence');
    if (compiledWireMode === 'proof') {
      const managed = generation.attemptId ? instanceProjection.managedRunsByAttemptId[generation.attemptId] : undefined;
      if (!managed || managed.status !== 'terminated' || managed.cleanupStatus !== 'clean' || managed.controllerDecision !== 'completed' || managed.failureCode !== undefined) {
        checkpointAuthorityFailure('Proof catalog publication lacks a clean managed terminal');
      }
      if (event.claim === PROOF_CATALOG_REVALIDATION_CLAIM &&
          (event.wireMode === 'proof' || (legacyProofWireMode && event.wireMode === 'generic'))) {
        // Validate the semantic Proof lineage for both modern Proof bytes and
        // the narrowly supported pre-wire-mode migration. This must run before
        // replaying descendants so a rehashed -0 -> 0 publication cannot hide
        // behind a freshly recomputed outer checkpoint digest.
        validateProofRevalidationLineage(event, generation, instanceProjection);
      }
    }
    if (sidecar) {
      if (generation.templateNodeKey !== 'inspect' || node.check.type !== 'governed-proof-inspect' || !hasOwn(event as unknown as Record<string, unknown>, 'proofCandidateEvidence') || !hasOwn(event as unknown as Record<string, unknown>, 'proofCandidateEvidenceFingerprint') || event.proofCandidateEvidenceFingerprint !== proofCandidateEvidenceFingerprint(event.proofCandidateEvidence)) {
        checkpointAuthorityFailure('Generated proof candidate evidence is not bound to the compiled inspect authority');
      }
      try {
        const evidence = validateProofCandidateEvidence(event.proofCandidateEvidence);
        if (event.wireMode !== governedWireModeFromEvidence(evidence)) checkpointAuthorityFailure('Generated claim wire mode is detached from governed invocation');
        const candidatePayload = governedCanonicalJson(event.payload, event.wireMode);
        const selector = isGovernedProofComponentSelector(node.check.invocation);
        const invocation = evidence.role.invocation as Record<string, unknown>;
        const selectorBound = selector && invocation.role_id === 'onboard' && invocation.stance === 'owner' && invocation.output_schema_id === (node.check.invocation as Record<string, unknown>).output_schema_id && invocation.output_schema === (node.check.invocation as Record<string, unknown>).output_schema && !!invocation.component_authority && invocation.subject && typeof invocation.subject === 'object' && (invocation.subject as Record<string, unknown>).kind === 'component';
        if ((!selector && (evidence.role.invocationDigest !== node.check.invocation_digest || canonicalJson(evidence.role.invocation) !== canonicalJson(node.check.invocation))) || (selector && !selectorBound) || evidence.probe.resultIdentity.resultDigest !== governedResultDigest(event.payload, event.wireMode) || evidence.probe.resultIdentity.canonicalBytes !== Buffer.byteLength(candidatePayload, 'utf8')) {
          checkpointAuthorityFailure('Generated proof candidate evidence is detached from compiled inspect or payload authority');
        }
      } catch (error) {
        if (error instanceof GraphJournalCheckpointError) throw error;
        throw new GraphJournalCheckpointError('CHECKPOINT_PLAN_AUTHORITY_MISMATCH', 'Generated proof candidate evidence is invalid', { cause: error });
      }
    } else if (hasOwn(event as unknown as Record<string, unknown>, 'proofCandidateEvidence') || hasOwn(event as unknown as Record<string, unknown>, 'proofCandidateEvidenceFingerprint')) {
      checkpointAuthorityFailure('Generated evidence sidecars are reserved for proof candidates');
    }
    try { plan.validatorsByClaim[event.claim](event.payload); } catch (error) {
      throw new GraphJournalCheckpointError('CHECKPOINT_PLAN_AUTHORITY_MISMATCH', 'Generated claim payload violates the compiled claim validator', { cause: error });
    }
  }
}

function checkpointBody(value: Record<string, unknown>): Record<string, unknown> {
  return {
    kind: value.kind,
    version: value.version,
    sessionId: value.sessionId,
    graphSemanticDigest: value.graphSemanticDigest,
    frontier: value.frontier,
    events: value.events,
  };
}

/* Checkpoints retain Proof's wire bytes for generated payloads. The envelope
 * and all historical generic values continue to use the graph canonicalizer;
 * only an explicitly governed ClaimPublished payload opts into Proof JSON. */
/** Canonical bytes used for both checkpoint integrity and file publication. */
export function canonicalGraphCheckpointJson(value: unknown): string {
  const active = new Set<object>();
  const encode = (current: unknown): string => {
    if (current === null || typeof current === 'boolean' || typeof current === 'string') return JSON.stringify(current);
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) throw new Error('non-finite number is not canonical JSON');
      return JSON.stringify(current);
    }
    if (current === undefined || typeof current === 'function' || typeof current === 'symbol' || typeof current === 'bigint') throw new Error('unsupported checkpoint JSON value');
    if (active.has(current as object)) throw new Error('checkpoint value is cyclic');
    active.add(current as object);
    try {
      if (Array.isArray(current)) return `[${current.map(item => encode(item)).join(',')}]`;
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) throw new Error('checkpoint object is not plain');
      const record = current as Record<string, unknown>;
      const generated = record.type === 'ClaimPublished' && hasOwn(record, 'nodeGenerationId');
      return `{${Object.keys(record).sort().map(key => {
        const encoded = generated && key === 'payload'
          ? governedCanonicalJson(record[key], record.wireMode === 'proof' ? 'proof' : 'generic')
          : generated && key === 'proofCandidateEvidence'
            ? governedProofCandidateEvidenceJson(record[key])
            : encode(record[key]);
        return `${JSON.stringify(key)}:${encoded}`;
      }).join(',')}}`;
    } finally { active.delete(current as object); }
  };
  return encode(value);
}

function sha256Checkpoint(value: unknown): string {
  return createHash('sha256').update(canonicalGraphCheckpointJson(value), 'utf8').digest('hex');
}

function immutableCheckpointValue<T>(value: T): T {
  const freeze = (current: unknown): unknown => {
    if (current && typeof current === 'object') {
      for (const child of Object.values(current as Record<string, unknown>)) freeze(child);
      Object.freeze(current);
    }
    return current;
  };
  return freeze(JSON.parse(canonicalGraphCheckpointJson(value))) as T;
}

function parseGraphCheckpoint(input: unknown): GraphJournalCheckpointV1 {
  try {
    canonicalGraphCheckpointJson(input);
  } catch (error) {
    throw checkpointWrap('INVALID_CHECKPOINT_ENVELOPE', 'Checkpoint is not canonical JSON', error);
  }
  const value = checkpointObject(input);
  if (!value || !checkpointHasExactKeys(value, ['kind', 'version', 'sessionId', 'graphSemanticDigest', 'frontier', 'events', 'integrity'])) {
    throw new GraphJournalCheckpointError('INVALID_CHECKPOINT_ENVELOPE', 'Checkpoint envelope has unknown or missing fields');
  }
  if (value.kind !== 'visor.graph-journal-checkpoint' || value.version !== 1) {
    throw new GraphJournalCheckpointError('INVALID_CHECKPOINT_ENVELOPE', 'Unsupported checkpoint kind or version');
  }
  checkpointString(value.sessionId, 'Checkpoint sessionId');
  checkpointString(value.graphSemanticDigest, 'Checkpoint graphSemanticDigest');
  const frontier = checkpointObject(value.frontier);
  const integrity = checkpointObject(value.integrity);
  if (!frontier || !checkpointHasExactKeys(frontier, ['eventCount', 'lastEventId']) || !integrity || !checkpointHasExactKeys(integrity, ['algorithm', 'digest'])) {
    throw new GraphJournalCheckpointError('INVALID_CHECKPOINT_ENVELOPE', 'Checkpoint frontier or integrity shape is invalid');
  }
  checkpointSafeInteger(frontier.eventCount, 'frontier.eventCount');
  checkpointSafeInteger(frontier.lastEventId, 'frontier.lastEventId');
  if (integrity.algorithm !== 'sha256' || typeof integrity.digest !== 'string' || !CHECKPOINT_SHA256.test(integrity.digest)) {
    throw new GraphJournalCheckpointError('INVALID_CHECKPOINT_ENVELOPE', 'Checkpoint integrity algorithm or digest is invalid');
  }
  if (!Array.isArray(value.events)) throw new GraphJournalCheckpointError('INVALID_CHECKPOINT_ENVELOPE', 'Checkpoint events must be an array');
  const expectedDigest = sha256Checkpoint(checkpointBody(value));
  if (integrity.digest !== expectedDigest) {
    throw new GraphJournalCheckpointError('CHECKPOINT_INTEGRITY_MISMATCH', 'Checkpoint integrity digest does not match its canonical body');
  }
  return value as unknown as GraphJournalCheckpointV1;
}

function validateCheckpointPrefix(checkpoint: GraphJournalCheckpointV1): readonly CheckpointRuntimeEvent[] {
  const frontier = checkpoint.frontier;
  const rawEvents = checkpoint.events;
  if (frontier.eventCount !== rawEvents.length || frontier.lastEventId !== (rawEvents.length === 0 ? 0 : rawEvents.length)) {
    throw new GraphJournalCheckpointError('INVALID_CHECKPOINT_PREFIX', 'Checkpoint frontier does not describe the event prefix');
  }
  const events = rawEvents.map(validateCheckpointEventShape);
  for (const [index, event] of events.entries()) {
    if (event.eventId !== index + 1) throw new GraphJournalCheckpointError('INVALID_CHECKPOINT_PREFIX', 'Checkpoint event IDs must be contiguous from 1');
    if (event.sessionId !== checkpoint.sessionId) throw new GraphJournalCheckpointError('CHECKPOINT_SESSION_MISMATCH', 'Checkpoint event session differs from its envelope session');
  }
  return events;
}

function reconstructCheckpointAllocators(
  events: readonly CheckpointRuntimeEvent[]
): { nextFence: number; attemptOrdinals: Map<string, number>; requestOrdinals: Map<string, number> } {
  let nextFence = 0;
  const attemptOrdinals = new Map<string, number>();
  const requestOrdinals = new Map<string, number>();
  const generatedStarts = new Set<string>();
  for (const event of events) {
    if (event.type === 'CatalogReconciliationRequested') {
      const prior = requestOrdinals.get(event.expansionOwnerCheck) || 0;
      if (event.requestOrdinal !== prior + 1 || event.requestId !== deriveCatalogRequestId({
        sessionId: event.sessionId,
        expansionOwnerCheck: event.expansionOwnerCheck,
        ordinal: event.requestOrdinal,
      })) {
        throw new GraphJournalCheckpointError('INVALID_CHECKPOINT_PREFIX', 'Catalog request ordinal is not the next derived ordinal');
      }
      requestOrdinals.set(event.expansionOwnerCheck, event.requestOrdinal);
    }
    if (event.type !== 'AttemptStarted') continue;
    nextFence++;
    if (event.fence !== nextFence) throw new GraphJournalCheckpointError('INVALID_CHECKPOINT_PREFIX', 'Attempt fences must be one contiguous global sequence');
    if ('nodeGenerationId' in event) {
      const generatedKey = canonicalJson({ nodeGenerationId: event.nodeGenerationId, scope: event.scope });
      if (generatedStarts.has(generatedKey) || event.attemptId !== sha256Canonical({ nodeGenerationId: event.nodeGenerationId, ordinal: 1 })) {
        throw new GraphJournalCheckpointError('INVALID_CHECKPOINT_PREFIX', 'Generated attempt identity or ordinal is invalid');
      }
      generatedStarts.add(generatedKey);
      continue;
    }
    const authority = { sessionId: event.sessionId, checkId: event.checkId, scope: event.scope };
    const key = canonicalJson(authority);
    const ordinal = (attemptOrdinals.get(key) || 0) + 1;
    if (event.attemptId !== sha256Canonical({ ...authority, ordinal })) {
      throw new GraphJournalCheckpointError('INVALID_CHECKPOINT_PREFIX', 'Attempt identity is not derived from its reconstructed ordinal');
    }
    attemptOrdinals.set(key, ordinal);
  }
  return { nextFence, attemptOrdinals, requestOrdinals };
}

function ensureCheckpointQuiescent(claimProjection: ClaimProjection, instanceProjection: InstanceProjection): void {
  if (Object.values(claimProjection.attempts).some(attempt => attempt.status === 'started')) {
    throw new GraphJournalCheckpointError('CHECKPOINT_NOT_QUIESCENT', 'Checkpoint contains a started root or catalog attempt');
  }
  if (Object.values(instanceProjection.requestsById).some(request => request.status === 'pending' || request.status === 'running')) {
    throw new GraphJournalCheckpointError('CHECKPOINT_NOT_QUIESCENT', 'Checkpoint contains a pending or running catalog request');
  }
  if (Object.values(instanceProjection.generationsById).some(generation => generation.status === 'ready' || generation.status === 'running')) {
    throw new GraphJournalCheckpointError('CHECKPOINT_NOT_QUIESCENT', 'Checkpoint contains a ready or running generation');
  }
  if (Object.values(instanceProjection.managedRunsByAttemptId).some(run => run.status === 'acquired' || run.status === 'started' || run.status === 'cancel_requested')) {
    throw new GraphJournalCheckpointError('CHECKPOINT_NOT_QUIESCENT', 'Checkpoint contains a nonterminal managed run');
  }
}

export interface JournalEntry {
  commitId: number;
  sessionId: string;
  scope: ScopePath;
  checkId: string;
  event: EventTrigger | undefined;
  result: ReviewSummary & { output?: unknown; content?: string };
}

/**
 * Proof's revalidation output is byte-owned only for the sealed
 * revalidate_catalog generated check. Keep the decision here, at the journal boundary,
 * so direct completion and provider-returned metadata cannot relabel a
 * generic publication.
 */
function compiledManagedProofWireMode(
  generation: { readonly templateNodeKey: string; readonly checkId: string },
  node: CompiledTemplateNode
): GovernedWireMode {
  const expectedClaim = generation.templateNodeKey === 'revalidate_catalog' && generation.checkId === 'revalidate_catalog'
      ? PROOF_CATALOG_REVALIDATION_CLAIM
      : undefined;
  const expectedType = expectedClaim === PROOF_CATALOG_REVALIDATION_CLAIM
      ? PROOF_CATALOG_REVALIDATION_PROVIDER_TYPE
      : undefined;
  if (!expectedClaim || node.check.type !== expectedType || node.emissions.length !== 1) return 'generic';
  const emission = node.emissions[0] as unknown as Record<string, unknown>;
  const keys = Reflect.ownKeys(emission);
  return Object.getPrototypeOf(emission) === Object.prototype && keys.length === 2 &&
    keys.includes('claim') && keys.includes('from') && emission.claim === expectedClaim && emission.from === 'output'
    ? 'proof'
    : 'generic';
}

/**
 * The pre-wire-mode v1 checkpoint format represented generated publications as
 * generic values. A revalidation publication may retain that representation
 * only when the complete historical candidate/admission/revalidation chain
 * still validates. This is intentionally used at restore only; modern live
 * completion always emits the compiled Proof mode.
 */
function validateProofRevalidationLineage(
  event: GeneratedClaimPublishedEvent,
  generation: NodeGenerationProjection,
  instanceProjection: InstanceProjection,
): void {
  const parents = generation.activeInputClaimIds.map(claimId => instanceProjection.claimsById[claimId]);
  const inventory = parents.find(claim => claim?.claim === PROOF_STRUCTURAL_INVENTORY_CLAIM);
  const candidate = parents.find(claim => claim?.claim === PROOF_CANDIDATE_CLAIM);
  const admission = parents.find(claim => claim?.claim === PROOF_ADMITTED_RECEIPT_CLAIM);
  if (!inventory || !candidate || !admission || !inventory.active || !candidate.active || !admission.active) {
    checkpointAuthorityFailure('Proof revalidation lacks its complete candidate/admission lineage');
  }
  const candidateView = generatedClaimView(candidate, 'candidate');
  const admissionView = generatedClaimView(admission, 'admission');
  const candidatePayload = candidate.payload as Record<string, unknown>;
  const projectID = candidatePayload && typeof candidatePayload.project_id === 'string'
    ? candidatePayload.project_id
    : undefined;
  if (!projectID || !inventory.payload || typeof inventory.payload !== 'object') {
    checkpointAuthorityFailure('Proof revalidation has no project-bound candidate/inventory');
  }
  const revalidationView = {
    claimId: event.claimId,
    claim: event.claim,
    payload: event.payload,
    payloadFingerprint: event.payloadFingerprint,
    producerCheckId: event.producerCheckId,
    scope: event.scope,
    parentClaimIds: event.parentClaimIds,
    wireMode: event.wireMode,
    provenance: 'attempt' as const,
    attemptId: event.attemptId,
    fence: event.fence,
  } as CandidateClaimInput;
  try {
    validateProofCatalogRevalidationProjection(
      event.payload,
      inventory.payload as Record<string, unknown>,
      candidateView,
      admissionView,
      projectID,
      revalidationView,
      inventory.claimId,
    );
  } catch (error) {
    checkpointAuthorityFailure(`Proof revalidation failed strict lineage validation: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export class ExecutionJournal {
  private commit = 0;
  private entries: JournalEntry[] = [];
  private runtimeEvents: Array<ClaimRuntimeEvent | InstanceRuntimeEvent> = [];
  private claimProjection: ClaimProjection = createInitialClaimProjection();
  private instanceProjection: InstanceProjection = createInitialInstanceProjection();
  private nextFence = 0;
  private attemptOrdinals = new Map<string, number>();
  private requestOrdinals = new Map<string, number>();

  constructor(private readonly claimPlan?: ClaimPlan) {}

  /**
   * Validate the self-authenticating checkpoint envelope before any external
   * authority or provider is consulted. Graph-plan authority is checked later
   * by restoreGraphCheckpoint once the trusted configuration is available.
   */
  static validateGraphCheckpointIntegrity(input: unknown): GraphJournalCheckpointV1 {
    return immutableCheckpointValue(parseGraphCheckpoint(input));
  }

  /** Export the immutable Graph-v2 runtime prefix and its canonical integrity digest. */
  exportGraphCheckpoint(sessionId: string): GraphJournalCheckpointV1 {
    checkpointString(sessionId, 'sessionId');
    const plan = this.requireClaimPlan();
    if (!plan.expansionPlan?.active) {
      throw new GraphJournalCheckpointError('CHECKPOINT_GRAPH_MISMATCH', 'Graph journal checkpoints require an active expansion plan');
    }
    const events = immutableCheckpointValue(this.runtimeEvents) as readonly CheckpointRuntimeEvent[];
    if (events.some(event => event.sessionId !== sessionId)) {
      throw new GraphJournalCheckpointError('CHECKPOINT_SESSION_MISMATCH', 'Runtime event session differs from export session');
    }
    const body = {
      kind: 'visor.graph-journal-checkpoint' as const,
      version: 1 as const,
      sessionId,
      graphSemanticDigest: plan.expansionPlan.graphSemanticDigest,
      frontier: { eventCount: events.length, lastEventId: events.length === 0 ? 0 : events.length },
      events,
    };
    return immutableCheckpointValue({
      ...body,
      integrity: { algorithm: 'sha256' as const, digest: sha256Checkpoint(body) },
    });
  }

  /** Restore a fresh journal only after complete envelope, authority, replay, and frontier validation. */
  static restoreGraphCheckpoint(claimPlan: ClaimPlan, input: unknown): ExecutionJournal {
    const checkpoint = parseGraphCheckpoint(input);
    if (!claimPlan || !claimPlan.active || !claimPlan.expansionPlan?.active) {
      throw new GraphJournalCheckpointError('CHECKPOINT_GRAPH_MISMATCH', 'Checkpoint restore requires an active claim and expansion plan');
    }
    if (checkpoint.graphSemanticDigest !== claimPlan.expansionPlan.graphSemanticDigest) {
      throw new GraphJournalCheckpointError('CHECKPOINT_GRAPH_MISMATCH', 'Checkpoint graph digest does not match the current compiled plan');
    }

    const validatedEvents = validateCheckpointPrefix(checkpoint);
    const events = immutableCheckpointValue(validatedEvents) as readonly CheckpointRuntimeEvent[];
    const claimEvents: ClaimRuntimeEvent[] = [];
    const instanceEvents: InstanceRuntimeEvent[] = [];
    let claimPrefix = createInitialClaimProjection();
    let instancePrefix = createInitialInstanceProjection();
    for (const event of events) {
      const route = routeCheckpointEvent(event);
      if (route.claim) {
        claimEvents.push(event as ClaimRuntimeEvent);
        try {
          claimPrefix = reduceClaimEvent(claimPrefix, event as ClaimRuntimeEvent, claimPlan);
        } catch (error) {
          throw checkpointWrap('INVALID_CHECKPOINT_PREFIX', 'Checkpoint root claim replay failed', error);
        }
      }
      if (route.instance) {
        instanceEvents.push(event as InstanceRuntimeEvent);
        const rawEvent = checkpoint.events[event.eventId - 1] as unknown as Record<string, unknown> | undefined;
        const legacyProofWireMode = event.type === 'ClaimPublished' && 'nodeGenerationId' in event &&
          event.claim === PROOF_CATALOG_REVALIDATION_CLAIM && event.wireMode === 'generic' &&
          !!rawEvent && (!hasOwn(rawEvent, 'wireMode') || rawEvent.wireMode === 'generic');
        validateCheckpointPlanAuthority(event as InstanceRuntimeEvent, claimPlan, claimPrefix, instancePrefix, legacyProofWireMode);
        try {
          // Preview each event to make plan authority checks resolve against the exact
          // projection prefix; replayInstanceEvents below remains the final reducer.
          instancePrefix = reduceInstanceEvent(instancePrefix, event as InstanceRuntimeEvent);
        } catch (error) {
          throw checkpointWrap('INVALID_CHECKPOINT_PREFIX', 'Checkpoint instance replay failed', error);
        }
      }
    }

    let claimProjection: ClaimProjection;
    let instanceProjection: InstanceProjection;
    try {
      claimProjection = replayClaimEvents(claimEvents, claimPlan);
    } catch (error) {
      throw checkpointWrap('INVALID_CHECKPOINT_PREFIX', 'Checkpoint root claim replay failed', error);
    }
    try {
      instanceProjection = replayInstanceEvents(instanceEvents);
    } catch (error) {
      throw checkpointWrap('INVALID_CHECKPOINT_PREFIX', 'Checkpoint instance replay failed', error);
    }
    ensureCheckpointQuiescent(claimProjection, instanceProjection);
    const allocators = reconstructCheckpointAllocators(events);

    const restored = new ExecutionJournal(claimPlan);
    // Keep the journal's internal lane appendable while retaining immutable event values.
    restored.runtimeEvents = events.map(event => immutableCheckpointValue(event)) as Array<CheckpointRuntimeEvent>;
    restored.claimProjection = immutableCanonicalValue(claimProjection);
    restored.instanceProjection = immutableInstanceProjection(instanceProjection);
    restored.nextFence = allocators.nextFence;
    restored.attemptOrdinals = allocators.attemptOrdinals;
    restored.requestOrdinals = allocators.requestOrdinals;
    try {
      restored.validateComponentAuthorityLineage();
    } catch (error) {
      throw checkpointWrap('CHECKPOINT_PLAN_AUTHORITY_MISMATCH', 'Checkpoint component Proof authority replay failed', error);
    }
    return restored;
  }

  beginSnapshot(): number {
    return this.commit;
  }

  commitEntry(entry: {
    sessionId: string;
    scope: ScopePath;
    checkId: string;
    result: ReviewSummary & { output?: unknown; content?: string };
    event?: EventTrigger;
  }): JournalEntry {
    const committed: JournalEntry = {
      sessionId: entry.sessionId,
      scope: entry.scope,
      checkId: entry.checkId,
      result: entry.result,
      event: entry.event,
      commitId: ++this.commit,
    };
    this.entries.push(committed);
    return committed;
  }

  readVisible(sessionId: string, commitMax: number, event?: EventTrigger): JournalEntry[] {
    return this.entries.filter(
      e =>
        e.sessionId === sessionId && e.commitId <= commitMax && (event ? e.event === event : true)
    );
  }

  private requireClaimPlan(): ClaimPlan {
    if (!this.claimPlan?.active) {
      throw new ClaimKernelError('CLAIM_MODE_INACTIVE', 'Runtime claim journal is inactive');
    }
    return this.claimPlan;
  }

  private appendRuntimeEvent<T extends ClaimRuntimeEvent>(event: T): T {
    const plan = this.requireClaimPlan();
    const stored = immutableRuntimeEvent(event);
    const projected = reduceClaimEvent(this.claimProjection, stored, plan);
    this.runtimeEvents.push(stored);
    this.claimProjection = projected;
    return stored;
  }

  private nextRuntimeEventId(): number {
    return Math.max(this.claimProjection.lastEventId, this.instanceProjection.lastEventId) + 1;
  }

  private appendInstanceEvent<T extends InstanceRuntimeEvent>(event: T): T {
    this.requireClaimPlan();
    const stored = immutableInstanceEvent(event);
    const projected = reduceInstanceEvent(this.instanceProjection, stored);
    this.runtimeEvents.push(stored);
    this.instanceProjection = projected;
    return stored;
  }

  requestCatalogReconciliation(input: {
    sessionId: string;
    ownerCheck: string;
  }): CatalogReconciliationRequestedEvent {
    const expansion = this.requireClaimPlan().expansionPlan?.byOwner[input.ownerCheck];
    if (!expansion) {
      throw new ClaimKernelError('UNKNOWN_EXPANSION_OWNER', `Unknown expansion owner ${input.ownerCheck}`);
    }
    const ordinal = (this.requestOrdinals.get(input.ownerCheck) || 0) + 1;
    this.requestOrdinals.set(input.ownerCheck, ordinal);
    return this.appendInstanceEvent({
      version: 1,
      type: 'CatalogReconciliationRequested',
      eventId: this.nextRuntimeEventId(),
      sessionId: input.sessionId,
      scope: [],
      requestId: deriveCatalogRequestId({
        sessionId: input.sessionId,
        expansionOwnerCheck: input.ownerCheck,
        ordinal,
      }),
      requestOrdinal: ordinal,
      expansionOwnerCheck: input.ownerCheck,
      status: 'pending',
    });
  }

  getOldestPendingCatalogRequest() {
    const id = this.instanceProjection.requestOrder.find(
      requestId => this.instanceProjection.requestsById[requestId].status === 'pending'
    );
    return id ? this.instanceProjection.requestsById[id] : undefined;
  }

  startCatalogRequestAttempt(requestId: string): CatalogAttemptStartedEvent {
    const request = this.instanceProjection.requestsById[requestId];
    if (!request || request.status !== 'pending') throw new ClaimKernelError('INVALID_REQUEST_STATE', `Request ${requestId} is not pending`);
    const scope: ScopePath & RootScopePath = [];
    const authority = { sessionId: request.sessionId, checkId: request.expansionOwnerCheck, scope };
    const ordinalKey = canonicalJson(authority); const ordinal=(this.attemptOrdinals.get(ordinalKey)||0)+1;
    this.attemptOrdinals.set(ordinalKey,ordinal); const fence=++this.nextFence;
    const event = immutableCanonicalValue<CatalogAttemptStartedEvent>({version:1,type:'AttemptStarted',eventId:this.nextRuntimeEventId(),...authority,attemptId:sha256Canonical({...authority,ordinal}),fence,requestId});
    const claim = reduceClaimEvent(this.claimProjection,event,this.requireClaimPlan());
    const instance = reduceInstanceEvent(this.instanceProjection,event);
    this.runtimeEvents.push(event); this.claimProjection=claim; this.instanceProjection=instance;
    return event;
  }

  scheduleCatalogRequestAttempt(input: CatalogScheduleAuthority): CatalogCheckScheduledEvent {
    const request = this.instanceProjection.requestsById[input.requestId];
    if (!request) {
      throw new ClaimKernelError('UNKNOWN_REQUEST', `Unknown catalog request ${input.requestId}`);
    }
    const scope: ScopePath & RootScopePath = [];
    const claimIds = exactActiveClaimIds(
      this.requireClaimPlan(),
      this.claimProjection,
      request.expansionOwnerCheck
    );
    const event = immutableCanonicalValue<CatalogCheckScheduledEvent>({
      version: 1,
      type: 'CheckScheduled',
      eventId: this.nextRuntimeEventId(),
      sessionId: request.sessionId,
      checkId: request.expansionOwnerCheck,
      scope,
      requestId: request.requestId,
      attemptId: input.attemptId,
      fence: input.fence,
      claimIds: [...claimIds],
    });
    const claim=reduceClaimEvent(this.claimProjection,event,this.requireClaimPlan());
    const instance=reduceInstanceEvent(this.instanceProjection,event);
    this.runtimeEvents.push(event); this.claimProjection=claim; this.instanceProjection=instance;
    return event;
  }

  startGeneratedAttempt(nodeGenerationId: string): GeneratedAttemptStartedEvent {
    const generation = this.instanceProjection.generationsById[nodeGenerationId];
    if (!generation || generation.status !== 'ready') {
      throw new ClaimKernelError('GENERATION_NOT_READY', `Generation ${nodeGenerationId} is not ready`);
    }
    const fence = ++this.nextFence;
    const ordinalKey = canonicalJson({ nodeGenerationId, scope: generation.scope });
    const ordinal = (this.attemptOrdinals.get(ordinalKey) || 0) + 1;
    this.attemptOrdinals.set(ordinalKey, ordinal);
    return this.appendInstanceEvent({
      version: 1,
      type: 'AttemptStarted',
      eventId: this.nextRuntimeEventId(),
      sessionId: this.instanceProjection.instancesById[generation.subgraphInstanceId].sessionId,
      checkId: generation.checkId,
      scope: generation.scope,
      attemptId: sha256Canonical({ nodeGenerationId, ordinal }),
      fence,
      nodeInstanceId: generation.nodeInstanceId,
      nodeGenerationId,
    });
  }

  scheduleGeneratedAttempt(input: GeneratedScheduleAuthority): GeneratedCheckScheduledEvent {
    const generation = this.instanceProjection.generationsById[input.nodeGenerationId];
    if (!generation) {
      throw new ClaimKernelError(
        'UNKNOWN_GENERATION',
        `Unknown generation ${input.nodeGenerationId}`
      );
    }
    const instance = this.instanceProjection.instancesById[generation.subgraphInstanceId];
    return this.appendInstanceEvent({
      version: 1,
      type: 'CheckScheduled',
      eventId: this.nextRuntimeEventId(),
      sessionId: instance.sessionId,
      checkId: generation.checkId,
      scope: generation.scope,
      attemptId: input.attemptId,
      fence: input.fence,
      nodeInstanceId: generation.nodeInstanceId,
      nodeGenerationId: generation.nodeGenerationId,
      claimIds: [...generation.activeInputClaimIds],
    });
  }

  private compiledExpansionForInstance(subgraphInstanceId: string): CompiledExpansion {
    const instance = this.instanceProjection.instancesById[subgraphInstanceId];
    if (!instance) {
      throw new ClaimKernelError('UNKNOWN_INSTANCE', `Unknown instance ${subgraphInstanceId}`);
    }
    const expansionPlan = this.requireClaimPlan().expansionPlan!;
    const expansion = instance.parentSubgraphInstanceId
      ? expansionPlan.byNestedOwner[instance.expansionOwnerCheck]
      : expansionPlan.byOwner[instance.expansionOwnerCheck];
    if (!expansion || expansion.expansionSpecDigest !== instance.expansionSpecDigest) {
      throw new ClaimKernelError(
        'INVALID_EXPANSION_AUTHORITY',
        `Instance ${subgraphInstanceId} is not bound to one exact compiled expansion`
      );
    }
    return expansion;
  }

  /** Revalidate every completed component selector against the current exact
   * WorkItem/catalog/Proof lineage. This is shared by normal replay and
   * checkpoint restore, so a rehashed substitution cannot survive projection
   * rebuilding. */
  private validateComponentAuthorityLineage(): void {
    for (const generation of Object.values(this.instanceProjection.generationsById)) {
      if (generation.status !== 'completed') continue;
      const instance = this.instanceProjection.instancesById[generation.subgraphInstanceId];
      if (!instance) componentAuthorityFailure('component generation instance is unavailable');
      if (instance.status !== 'active') continue;
      const expansion = this.compiledExpansionForInstance(instance.subgraphInstanceId);
      const node = expansion.template.nodesByKey[generation.templateNodeKey];
      if (!node || node.check.type !== 'governed-proof-inspect' || !isGovernedProofComponentSelector(node.check.invocation)) continue;
      const authority = this.getProofComponentInvocationAuthority(generation.nodeGenerationId);
      const output = generation.completedOutputClaimIds
        .map(claimId => this.instanceProjection.claimsById[claimId])
        .find(claim => claim?.claim === PROOF_CANDIDATE_CLAIM);
      if (!output?.proofCandidateEvidence) componentAuthorityFailure('completed component inspect has no Proof evidence');
      const invocation = output.proofCandidateEvidence.role.invocation as Record<string, unknown>;
      if (!invocation.component_authority || governedCanonicalJson(invocation.component_authority, 'proof') !== governedCanonicalJson(authority, 'proof')) {
        componentAuthorityFailure('completed component inspect authority is detached from exact lineage');
      }
      validateComponentChildAdmission(this.instanceProjection, instance.subgraphInstanceId, false);
    }
  }

  getGeneratedExecution(nodeGenerationId: string) {
    const generation = this.instanceProjection.generationsById[nodeGenerationId];
    if (!generation) throw new ClaimKernelError('UNKNOWN_GENERATION', `Unknown generation ${nodeGenerationId}`);
    const instance = this.instanceProjection.instancesById[generation.subgraphInstanceId];
    const expansion = this.compiledExpansionForInstance(instance.subgraphInstanceId);
    const node = expansion.template.nodesByKey[generation.templateNodeKey];
    const claims: Record<string, CandidateClaimInput> = {};
    for (const consumption of node.consumptions) {
      const claim = generation.activeInputClaimIds
        .map(id => this.instanceProjection.claimsById[id])
        .find(candidate => candidate?.claim === consumption.claim);
      if (!claim) throw new ClaimKernelError('CLAIM_NOT_READY', `Missing generated input ${consumption.claim}`);
      if (
        (claim.kind === 'controller-item' && !claim.controllerCatalogClaimId) ||
        (claim.kind === 'generated-output' &&
          (!claim.producerAttemptId || claim.producerFence === undefined))
      ) {
        throw new ClaimKernelError(
          'INVALID_CLAIM_PROVENANCE',
          `Claim ${claim.claimId} lacks authoritative producer provenance`
        );
      }
      const provenance = claim.kind === 'controller-item'
        ? {
            provenance: 'controller' as const,
            catalogClaimId: claim.controllerCatalogClaimId as string,
            incarnation: claim.incarnation,
          }
        : {
            provenance: 'attempt' as const,
            attemptId: claim.producerAttemptId as string,
            fence: claim.producerFence as number,
          };
      claims[consumption.as] = Object.freeze({
        claimId: claim.claimId,
        claim: claim.claim,
        payload: claim.payload,
        payloadFingerprint: claim.payloadFingerprint,
        producerCheckId: claim.producerCheckId,
        scope: claim.scope,
        parentClaimIds: claim.parentClaimIds,
        wireMode: claim.wireMode,
        ...provenance,
        ...(claim.claim === PROOF_CANDIDATE_CLAIM && claim.proofCandidateEvidence && claim.proofCandidateEvidenceFingerprint
          ? { proofAdmission: claim.proofCandidateEvidence }
          : {}),
      });
    }
    return Object.freeze({ generation, node, claims: Object.freeze(claims) });
  }

  /** Assemble the complete controller-owned authority for a component C0
   * activation. The catalog item carries only the compact subject/digest;
   * the raw candidate, admission, WorkItem and current receipt are recovered
   * from the journal's authenticated claims and Proof admission wire. */
  getProofComponentInvocationAuthority(nodeGenerationId: string): ProofComponentInvocationAuthorityV1 {
    const execution = this.getGeneratedExecution(nodeGenerationId);
    const componentView = execution.claims.component;
    if (!componentView || componentView.claim !== 'component.work_item@1') componentAuthorityFailure('component WorkItem is missing from the exact component binding');
    const component = this.instanceProjection.claimsById[componentView.claimId];
    if (!component) componentAuthorityFailure('component WorkItem projection is unavailable');
    if (!component.controllerCatalogClaimId) componentAuthorityFailure('component WorkItem has no catalog lineage');
    const catalog = this.instanceProjection.claimsById[component.controllerCatalogClaimId];
    if (!catalog) componentAuthorityFailure('component catalog projection is unavailable');
    const admission = catalog.parentClaimIds.map(claimId => this.instanceProjection.claimsById[claimId]).find(claim => claim?.claim === PROOF_ADMITTED_RECEIPT_CLAIM);
    if (!admission?.nodeGenerationId) componentAuthorityFailure('admission generation is unavailable');
    const request = this.getProofAdmissionRequest(admission.nodeGenerationId);
    return assembleProofComponentInvocationAuthority(this.instanceProjection, component, request);

  }

  /** Project the exact controller-owned candidate envelope consumed by Proof. */
  getProofAdmissionRequest(nodeGenerationId: string): string {
    const execution = this.getGeneratedExecution(nodeGenerationId);
    if (execution.generation.templateNodeKey !== PROOF_ADMIT_NODE_KEY || execution.generation.checkId !== PROOF_ADMIT_NODE_KEY) {
      throw new ClaimKernelError('INVALID_PROOF_ADMISSION_PROJECTION', 'Proof admission is reserved for proof_admit');
    }
    const candidateClaim = Object.values(execution.claims).find(claim => claim.claim === PROOF_CANDIDATE_CLAIM);
    const evidence = candidateClaim?.proofAdmission;
    if (!candidateClaim || !evidence) throw new ClaimKernelError('INVALID_PROOF_ADMISSION_PROJECTION', 'Proof candidate evidence is missing');
    const wireMode = governedWireModeFromEvidence(evidence);
    if (candidateClaim.wireMode !== wireMode) throw new ClaimKernelError('INVALID_PROOF_ADMISSION_PROJECTION', 'Proof candidate wire mode is detached');
    if (candidateClaim.provenance !== 'attempt' || typeof candidateClaim.attemptId !== 'string' || !Number.isSafeInteger(candidateClaim.fence)) {
      throw new ClaimKernelError('INVALID_PROOF_ADMISSION_PROJECTION', 'Proof candidate provenance is invalid');
    }
    const proofAttempts = this.runtimeEvents.filter(event =>
      event.type === 'AttemptStarted' && 'nodeGenerationId' in event &&
      event.nodeGenerationId === execution.generation.nodeGenerationId &&
      event.checkId === PROOF_ADMIT_NODE_KEY && event.attemptId === execution.generation.attemptId &&
      event.fence === execution.generation.fence
    );
    if (proofAttempts.length !== 1) throw new ClaimKernelError('INVALID_PROOF_ADMISSION_PROJECTION', 'Proof admission attempt is ambiguous');
    const proofAttemptIndex = this.runtimeEvents.indexOf(proofAttempts[0]);
    const publications = this.runtimeEvents.filter(event =>
      event.type === 'ClaimPublished' &&
      event.claim === PROOF_CANDIDATE_CLAIM && event.claimId === candidateClaim.claimId &&
      event.attemptId === candidateClaim.attemptId && event.fence === candidateClaim.fence
    ) as GeneratedClaimPublishedEvent[];
    if (publications.length !== 1) throw new ClaimKernelError('INVALID_PROOF_ADMISSION_PROJECTION', 'Candidate publication is ambiguous');
    const publication = publications[0];
    const publicationIndex = this.runtimeEvents.indexOf(publication);
    if (publicationIndex < 0 || publicationIndex >= proofAttemptIndex || publication.producerCheckId !== candidateClaim.producerCheckId || publication.wireMode !== wireMode || publication.payloadFingerprint !== candidateClaim.payloadFingerprint || canonicalJson(publication.scope) !== canonicalJson(candidateClaim.scope) || canonicalJson(publication.parentClaimIds) !== canonicalJson(candidateClaim.parentClaimIds) || publication.attemptId !== candidateClaim.attemptId || publication.fence !== candidateClaim.fence || governedCanonicalJson(publication.payload, wireMode) !== governedCanonicalJson(candidateClaim.payload, wireMode)) {
      throw new ClaimKernelError('INVALID_PROOF_ADMISSION_PROJECTION', 'Candidate publication is detached');
    }
    const terminations = this.runtimeEvents.filter(event =>
      event.type === 'ManagedRunTerminated' &&
      event.binding.checkId === publication.checkId &&
      event.binding.nodeGenerationId === publication.nodeGenerationId &&
      event.binding.attemptId === publication.attemptId &&
      event.binding.fence === publication.fence &&
      event.controllerDecision === 'completed'
    ) as ManagedRunTerminatedEvent[];
    if (terminations.length !== 1) {
      throw new ClaimKernelError('INVALID_PROOF_ADMISSION_PROJECTION', 'Candidate managed termination is ambiguous');
    }
    const termination = terminations[0];
    const terminationIndex = this.runtimeEvents.indexOf(termination);
    if (terminationIndex < 0 || terminationIndex >= proofAttemptIndex || termination.cleanupStatus !== 'clean' || termination.failureCode !== null || termination.sessionId !== publication.sessionId || canonicalJson(termination.scope) !== canonicalJson(publication.scope)) {
      throw new ClaimKernelError('INVALID_PROOF_ADMISSION_PROJECTION', 'Candidate managed termination is not clean');
    }
    const scope = (value: readonly KeyedScopePath[number][]) => value.map(part => ({
      Kind: part.kind,
      ExpansionOwnerCheck: part.expansionOwnerCheck,
      Key: part.key,
      SubgraphInstanceID: part.subgraphInstanceId,
    }));
    const binding = {
      ManagedRunID: deriveManagedRunId({
        sessionId: publication.sessionId,
        checkId: publication.checkId,
        scope: publication.scope,
        nodeInstanceId: publication.nodeInstanceId,
        nodeGenerationId: publication.nodeGenerationId,
        attemptId: publication.attemptId,
        fence: publication.fence,
      }),
      SessionID: publication.sessionId,
      CheckID: publication.checkId,
      Scope: scope(publication.scope),
      NodeInstanceID: publication.nodeInstanceId,
      NodeGenerationID: publication.nodeGenerationId,
      AttemptID: publication.attemptId,
      Fence: publication.fence,
    };
    if (termination.binding.managedRunId !== binding.ManagedRunID || termination.binding.sessionId !== publication.sessionId || termination.binding.checkId !== publication.checkId || termination.binding.nodeInstanceId !== publication.nodeInstanceId || termination.binding.nodeGenerationId !== publication.nodeGenerationId || termination.binding.attemptId !== publication.attemptId || termination.binding.fence !== publication.fence || canonicalJson(termination.binding.scope) !== canonicalJson(publication.scope)) {
      throw new ClaimKernelError('INVALID_PROOF_ADMISSION_PROJECTION', 'Candidate termination binding is detached');
    }
    const invocation = evidence.role.invocation as Record<string, any>;
    const subject = invocation.subject as Record<string, any>;
    const invocationWire = {
      role_id: invocation.role_id,
      stance: invocation.stance,
      subject: { kind: subject.kind, id: subject.id, fingerprint: subject.fingerprint },
      ...(invocation.component_authority !== undefined ? { component_authority: invocation.component_authority } : {}),
      output_schema_id: invocation.output_schema_id,
      output_schema: invocation.output_schema,
    };
    const payloadBytes = Buffer.from(governedCanonicalJson(publication.payload, wireMode), 'utf8');
    const candidate = {
      Version: 'proof.role-result-candidate-envelope/v1',
      Invocation: invocationWire,
      InvocationDigest: evidence.role.invocationDigest,
      RoleID: invocation.role_id,
      Stance: invocation.stance,
      Subject: { kind: subject.kind, id: subject.id, fingerprint: subject.fingerprint },
      AttestationVersion: evidence.probe.attestation.version,
      ExecutionSource: 'caller',
      ProbeInvocationDigest: (evidence.probe.attestation.executionContext as Record<string, any>).invocationDigest,
      IdentityVersion: evidence.probe.resultIdentity.version,
      IdentitySource: evidence.probe.resultIdentity.source,
      ResultDigest: evidence.probe.resultIdentity.resultDigest,
      CanonicalBytes: evidence.probe.resultIdentity.canonicalBytes,
      ProbeResultBytes: payloadBytes.toString('base64'),
      VisorPayloadBytes: payloadBytes.toString('base64'),
      Publication: {
        Version: 1,
        Type: 'ClaimPublished',
        SessionID: publication.sessionId,
        CheckID: publication.checkId,
        Scope: scope(publication.scope),
        NodeInstanceID: publication.nodeInstanceId,
        NodeGenerationID: publication.nodeGenerationId,
        AttemptID: publication.attemptId,
        Fence: publication.fence,
        ClaimID: publication.claimId,
        Claim: publication.claim,
        PayloadFingerprint: publication.payloadFingerprint,
        ProducerCheckID: publication.producerCheckId,
        Payload: payloadBytes.toString('base64'),
        ParentClaimIDs: [...publication.parentClaimIds],
      },
      Binding: binding,
      Termination: {
        Version: 1,
        Type: 'ManagedRunTerminated',
        SessionID: termination.sessionId,
        Scope: scope(termination.scope),
        Binding: binding,
        CleanupStatus: termination.cleanupStatus,
        ControllerDecision: termination.controllerDecision,
        FailureCode: null,
      },
    };
    return proofCandidateAdmissionRequestJson({ version: 'proof.role-result-candidate-cli-request/v1', candidate });
  }

  deriveManagedRunBinding(attempt: GeneratedAttemptStartedEvent): ManagedRunBindingV1 {
    const generation = this.instanceProjection.generationsById[attempt.nodeGenerationId];
    const instance = generation
      ? this.instanceProjection.instancesById[generation.subgraphInstanceId]
      : undefined;
    if (
      !generation ||
      !instance ||
      generation.status !== 'running' ||
      !generation.scheduled ||
      generation.attemptId !== attempt.attemptId ||
      generation.fence !== attempt.fence ||
      generation.nodeInstanceId !== attempt.nodeInstanceId ||
      this.instanceProjection.attemptBindingsById[attempt.attemptId] !==
        generation.nodeGenerationId ||
      attempt.sessionId !== instance.sessionId ||
      attempt.checkId !== generation.checkId ||
      canonicalJson(attempt.scope) !== canonicalJson(generation.scope) ||
      attempt.nodeGenerationId !== generation.nodeGenerationId
    ) {
      throw new ClaimKernelError(
        'INVALID_MANAGED_BINDING',
        `Attempt ${attempt.attemptId} is not the current scheduled generated attempt`
      );
    }
    const authority: Omit<ManagedRunBindingV1, 'managedRunId'> = {
      sessionId: instance.sessionId,
      checkId: generation.checkId,
      scope: generation.scope,
      nodeInstanceId: generation.nodeInstanceId,
      nodeGenerationId: generation.nodeGenerationId,
      attemptId: generation.attemptId!,
      fence: generation.fence!,
    };
    return immutableCanonicalValue({
      managedRunId: deriveManagedRunId(authority),
      ...authority,
    });
  }

  private appendInstanceEventBatch(events: readonly InstanceRuntimeEvent[]): void {
    this.requireClaimPlan();
    const stored = events.map(event => immutableInstanceEvent(event));
    const projected = reduceInstanceEventBatch(this.instanceProjection, stored);
    this.runtimeEvents.push(...stored);
    this.instanceProjection = projected;
  }

  failManagedRunAcquisition(input: {
    attempt: GeneratedAttemptStartedEvent;
    binding: ManagedRunBindingV1;
    failureCode: ManagedRunAcquisitionFailureCode;
  }): void {
    const eventId = this.nextRuntimeEventId();
    this.appendInstanceEventBatch([
      {
        version: 1,
        type: 'ManagedRunAcquisitionFailed',
        eventId,
        sessionId: input.attempt.sessionId,
        scope: input.attempt.scope,
        binding: input.binding,
        failureCode: input.failureCode,
      },
      {
        ...input.attempt,
        type: 'AttemptFailed',
        eventId: eventId + 1,
        reason: input.failureCode,
      },
    ]);
  }

  recordManagedRunAcquired(binding: ManagedRunBindingV1): void {
    this.appendInstanceEvent({
      version: 1,
      type: 'ManagedRunAcquired',
      eventId: this.nextRuntimeEventId(),
      sessionId: binding.sessionId,
      scope: binding.scope,
      binding,
    });
  }

  recordManagedRunStarted(binding: ManagedRunBindingV1): void {
    this.appendInstanceEvent({
      version: 1,
      type: 'ManagedRunStarted',
      eventId: this.nextRuntimeEventId(),
      sessionId: binding.sessionId,
      scope: binding.scope,
      binding,
    });
  }

  recordManagedRunCancelRequested(binding: ManagedRunBindingV1): void {
    this.appendInstanceEvent({
      version: 1,
      type: 'ManagedRunCancelRequested',
      eventId: this.nextRuntimeEventId(),
      sessionId: binding.sessionId,
      scope: binding.scope,
      binding,
      reason: 'deadline',
    });
  }

  failManagedGeneratedAttempt(input: {
    attempt: GeneratedAttemptStartedEvent;
    binding: ManagedRunBindingV1;
    cleanupStatus: ManagedRunCleanupStatus;
    failureCode: ManagedRunFailureCode;
  }): void {
    const eventId = this.nextRuntimeEventId();
    this.appendInstanceEventBatch([
      {
        version: 1,
        type: 'ManagedRunTerminated',
        eventId,
        sessionId: input.attempt.sessionId,
        scope: input.attempt.scope,
        binding: input.binding,
        cleanupStatus: input.cleanupStatus,
        controllerDecision: 'failed',
        failureCode: input.failureCode,
      },
      {
        ...input.attempt,
        type: 'AttemptFailed',
        eventId: eventId + 1,
        reason: input.failureCode,
      },
    ]);
  }

  completeGeneratedAttempt(input: {
    attempt: GeneratedAttemptStartedEvent;
    payload: unknown;
    proofCandidateEvidence?: ProofCandidateEvidenceV1;
    wireMode?: GovernedWireMode;
  }): void {
    const staged = this.stageGeneratedCompletion(input);
    this.runtimeEvents.push(...staged.events);
    this.instanceProjection = staged.projection;
  }

  completeManagedGeneratedAttempt(input: {
    attempt: GeneratedAttemptStartedEvent;
    binding: ManagedRunBindingV1;
    payload: unknown;
    executionConfigDigest: string;
    proofCandidateEvidence?: ProofCandidateEvidenceV1;
    wireMode?: GovernedWireMode;
  }): void {
    const terminal = immutableInstanceEvent({
      version: 1,
      type: 'ManagedRunTerminated',
      eventId: this.nextRuntimeEventId(),
      sessionId: input.binding.sessionId,
      scope: input.binding.scope,
      binding: input.binding,
      cleanupStatus: 'clean',
      controllerDecision: 'completed',
      failureCode: null,
    });
    const staged = this.stageGeneratedCompletion(input, [terminal]);
    this.runtimeEvents.push(...staged.events);
    this.instanceProjection = staged.projection;
  }

  private stageGeneratedCompletion(
    input: { attempt: GeneratedAttemptStartedEvent; payload: unknown; executionConfigDigest?: string; proofCandidateEvidence?: ProofCandidateEvidenceV1; wireMode?: GovernedWireMode },
    prefix: readonly InstanceRuntimeEvent[] = []
  ): { events: readonly InstanceRuntimeEvent[]; projection: InstanceProjection } {
    const { attempt, payload } = input;
    const before = this.instanceProjection;
    const generation = before.generationsById[attempt.nodeGenerationId];
    const instance = before.instancesById[generation.subgraphInstanceId];
    const expansion = this.compiledExpansionForInstance(instance.subgraphInstanceId);
    const node = expansion.template.nodesByKey[generation.templateNodeKey];
    const candidateEmissions = node.emissions.filter(emission => emission.claim === PROOF_CANDIDATE_CLAIM);
    const compiledWireMode = compiledManagedProofWireMode(generation, node);
    if (compiledWireMode === 'proof' || candidateEmissions.length > 0) {
      const terminal = prefix.filter(event => event.type === 'ManagedRunTerminated') as readonly any[];
      if (terminal.length !== 1 || terminal[0].cleanupStatus !== 'clean' || terminal[0].controllerDecision !== 'completed' || terminal[0].failureCode !== null) {
        throw new ClaimKernelError('MANAGED_TERMINAL_REQUIRED', 'Proof publication requires a clean managed terminal');
      }
    }
    if (input.executionConfigDigest !== undefined && input.executionConfigDigest !== generation.executionConfigDigest) throw new ClaimKernelError('STALE_EXECUTION_CONFIG', 'Managed completion does not match live generation authority');
    const nestedOwner = qualifiedNestedExpansionOwner(
      expansion.template.name,
      generation.templateNodeKey
    );
    const nestedExpansion = this.requireClaimPlan().expansionPlan!.byNestedOwner[nestedOwner];
    if (candidateEmissions.length > 0) {
      if (input.executionConfigDigest !== generation.executionConfigDigest || generation.templateNodeKey !== 'inspect' || node.check.type !== 'governed-proof-inspect' || input.proofCandidateEvidence === undefined) {
        throw new ClaimKernelError('INVALID_PROOF_EVIDENCE', 'Proof candidate completion requires governed inspect authority and an evidence sidecar');
      }
      try {
        const evidence = validateProofCandidateEvidence(input.proofCandidateEvidence);
        const candidateWireMode = governedWireModeFromEvidence(evidence);
        if (input.wireMode !== undefined && input.wireMode !== candidateWireMode) throw new Error('wire mode is detached from governed invocation');
        const selector = isGovernedProofComponentSelector(node.check.invocation);
        const invocation = evidence.role.invocation as Record<string, unknown>;
        const selectorBound = selector && invocation.role_id === 'onboard' && invocation.stance === 'owner' && invocation.output_schema_id === (node.check.invocation as Record<string, unknown>).output_schema_id && invocation.output_schema === (node.check.invocation as Record<string, unknown>).output_schema && !!invocation.component_authority && invocation.subject && typeof invocation.subject === 'object' && (invocation.subject as Record<string, unknown>).kind === 'component';
        if ((!selector && (evidence.role.invocationDigest !== node.check.invocation_digest || canonicalJson(evidence.role.invocation) !== canonicalJson(node.check.invocation))) || (selector && !selectorBound)) {
          throw new Error('evidence invocation is detached from compiled inspect config');
        }
        if (selector) {
          const authority = this.getProofComponentInvocationAuthority(generation.nodeGenerationId);
          if (governedCanonicalJson(invocation.component_authority, 'proof') !== governedCanonicalJson(authority, 'proof')) {
            throw new Error('component invocation authority is detached from the exact journal lineage');
          }
          const subject = invocation.subject as Record<string, unknown>;
          if (subject.id !== authority.subject.component_id || subject.fingerprint !== authority.subject.fingerprint) {
            throw new Error('component invocation subject is detached from the exact WorkItem authority');
          }
        }
        const payloadJson = governedCanonicalJson(payload, candidateWireMode);
        if (evidence.probe.resultIdentity.resultDigest !== governedResultDigest(payload, candidateWireMode) || evidence.probe.resultIdentity.canonicalBytes !== Buffer.byteLength(payloadJson, 'utf8')) {
          throw new Error('evidence result identity is detached from candidate payload');
        }
      } catch (error) {
        if (error instanceof ClaimKernelError) throw error;
        throw new ClaimKernelError('INVALID_PROOF_EVIDENCE', `Proof candidate evidence is invalid or detached: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (input.proofCandidateEvidence !== undefined) {
      throw new ClaimKernelError('INVALID_PROOF_EVIDENCE', 'Evidence sidecars are reserved for proof candidates');
    } else if (input.wireMode !== undefined && input.wireMode !== compiledWireMode) {
      throw new ClaimKernelError('INVALID_PROOF_EVIDENCE', 'Generated claim wire mode is detached from compiled check authority');
    }
    let staged = before;
    const events: InstanceRuntimeEvent[] = [];
    const stage = (event: InstanceRuntimeEvent): void => {
      const stored = immutableInstanceEvent(event);
      staged = reduceInstanceEvent(staged, stored);
      events.push(stored);
    };
    for (const event of prefix) stage(event);
    const publications: GeneratedClaimPublishedEvent[] = [];
    const candidateWireMode = input.proofCandidateEvidence
      ? governedWireModeFromEvidence(input.proofCandidateEvidence)
      : undefined;
    for (const emission of node.emissions) {
      this.requireClaimPlan().validatorsByClaim[emission.claim](payload);
      const proofCandidateEmission = emission.claim === PROOF_CANDIDATE_CLAIM;
      const wireMode: GovernedWireMode = proofCandidateEmission ? (candidateWireMode || 'generic') : compiledWireMode;
      const immutablePayload = immutableGovernedValue(payload, wireMode);
      const payloadFingerprint = governedPayloadFingerprint(payload, wireMode);
      const parentClaimIds = [...generation.activeInputClaimIds].sort();
      const eventId =
        Math.max(this.claimProjection.lastEventId, staged.lastEventId) + publications.length + 1;
      const published: GeneratedClaimPublishedEvent = {
        version: 1, type: 'ClaimPublished', eventId,
        sessionId: attempt.sessionId, checkId: attempt.checkId, scope: attempt.scope,
        attemptId: attempt.attemptId, fence: attempt.fence,
        nodeInstanceId: attempt.nodeInstanceId, nodeGenerationId: attempt.nodeGenerationId,
        claim: emission.claim, payload: immutablePayload, payloadFingerprint,
        producerCheckId: attempt.checkId, parentClaimIds,
        wireMode,
        claimId: sha256Canonical({ claim: emission.claim, payloadFingerprint,
          producerCheckId: attempt.checkId, scope: attempt.scope, attemptId: attempt.attemptId,
          fence: attempt.fence, parentClaimIds,
          ...(emission.claim === PROOF_CANDIDATE_CLAIM
            ? { proofCandidateEvidenceFingerprint: proofCandidateEvidenceFingerprint(input.proofCandidateEvidence) }
            : {}) }),
        ...(emission.claim === PROOF_CANDIDATE_CLAIM
          ? { proofCandidateEvidence: immutableProofCandidateEvidence(input.proofCandidateEvidence), proofCandidateEvidenceFingerprint: proofCandidateEvidenceFingerprint(input.proofCandidateEvidence) }
          : {}),
      };
      publications.push(published);
    }
    const nestedCatalogPublications = nestedExpansion
      ? publications.filter(publication =>
          publication.claim === nestedExpansion.catalogClaimRef
        )
      : [];
    if (nestedExpansion && nestedCatalogPublications.length !== 1) {
      throw new ClaimKernelError(
        'INVALID_NESTED_CATALOG_AUTHORITY',
        `Nested expansion owner ${nestedOwner} requires exactly one catalog publication`
      );
    }
    for (const publication of publications) stage(publication);
    if (nestedExpansion) {
      const catalogPublication = nestedCatalogPublications[0];
      const reconciled = this.reconcileCatalog({
        sessionId: attempt.sessionId,
        expansion: nestedExpansion,
        payload: catalogPublication.payload,
        catalogClaimId: catalogPublication.claimId,
        startEventId: Math.max(this.claimProjection.lastEventId, staged.lastEventId) + 1,
        projection: staged,
        parentSubgraphInstanceId: instance.subgraphInstanceId,
        expansionOwnerNodeInstanceId: generation.nodeInstanceId,
      });
      events.push(...reconciled.events);
      staged = reconciled.projection;
    }
    for (const nodeKey of expansion.template.topology) {
      const candidate = expansion.template.nodesByKey[nodeKey];
      const nodeInstanceId = instance.nodeInstanceIdsByTemplateNode[nodeKey];
      if (staged.activeGenerationIdByNode[nodeInstanceId]) continue;
      const dependenciesCompleted = candidate.dependencyNodeKeys.every(dependencyNodeKey => {
        const dependencyNodeId = instance.nodeInstanceIdsByTemplateNode[dependencyNodeKey];
        const dependencyGenerationId = staged.activeGenerationIdByNode[dependencyNodeId];
        const isCompletingGeneration =
          dependencyGenerationId === generation.nodeGenerationId &&
          generation.nodeInstanceId === attempt.nodeInstanceId &&
          generation.status === 'running' &&
          generation.scheduled &&
          generation.attemptId === attempt.attemptId &&
          generation.fence === attempt.fence;
        return (
          dependencyGenerationId !== undefined &&
          (isCompletingGeneration ||
            staged.generationsById[dependencyGenerationId]?.status === 'completed')
        );
      });
      if (!dependenciesCompleted) continue;
      const inputIds: string[] = [];
      let ready = true;
      for (const consumption of candidate.consumptions) {
        const claims = Object.values(staged.claimsById)
          .filter(value =>
            value.active &&
            value.subgraphInstanceId === instance.subgraphInstanceId &&
            value.incarnation === instance.incarnation &&
            value.claim === consumption.claim
          )
          .sort((left, right) => left.claimId.localeCompare(right.claimId));
        if (claims.length !== 1) {
          ready = false;
          break;
        }
        inputIds.push(claims[0].claimId);
      }
      if (!ready) continue;
      inputIds.sort();
      const item = instance.activeItemClaimId
        ? staged.claimsById[instance.activeItemClaimId]
        : undefined;
      if (!item?.active) {
        throw new ClaimKernelError(
          'INACTIVE_ITEM_CLAIM',
          `Instance ${instance.subgraphInstanceId} lacks an active item claim`
        );
      }
      const nodeGenerationId = deriveNodeGenerationId({ nodeInstanceId,
        incarnation: instance.incarnation, itemFingerprint: item.payloadFingerprint,
        executionConfigDigest: candidate.executionConfigDigest, activeInputClaimIds: inputIds });
      const nestedCatalogClaimRef = this.requireClaimPlan().expansionPlan!.byNestedOwner[
        qualifiedNestedExpansionOwner(expansion.template.name, nodeKey)
      ]?.catalogClaimRef;
      stage({ version: 1, type: 'NodeGenerationActivated',
        eventId: Math.max(this.claimProjection.lastEventId, staged.lastEventId) + 1,
        sessionId: attempt.sessionId, scope: instance.scope,
        subgraphInstanceId: instance.subgraphInstanceId, nodeInstanceId, nodeGenerationId,
        templateNodeKey: nodeKey, checkId: nodeKey, incarnation: instance.incarnation,
        itemFingerprint: item.payloadFingerprint, executionConfigDigest: candidate.executionConfigDigest,
        activeInputClaimIds: inputIds,
        ...(nestedCatalogClaimRef
          ? { nestedExpansionCatalogClaimRef: nestedCatalogClaimRef }
          : {}) });
    }
    stage({ ...attempt, type: 'AttemptCompleted',
      eventId: Math.max(this.claimProjection.lastEventId, staged.lastEventId) + 1 });
    const completedProjection = reduceInstanceEventBatch(before, events);
    if (generation.templateNodeKey === PROOF_ADMIT_NODE_KEY) {
      const inspectNode = expansion.template.nodesByKey.inspect;
      if (inspectNode && inspectNode.check.type === 'governed-proof-inspect' && isGovernedProofComponentSelector(inspectNode.check.invocation)) {
        validateComponentChildAdmission(completedProjection, instance.subgraphInstanceId, true);
      }
    }
    return {
      events,
      projection: completedProjection,
    };
  }

  failGeneratedAttempt(attempt: GeneratedAttemptStartedEvent, reason: string): void {
    this.appendInstanceEvent({ ...attempt, type: 'AttemptFailed', reason,
      eventId: this.nextRuntimeEventId() });
  }

  queryReadyWork(): readonly NodeGenerationProjection[] {
    return queryReadyGenerations(this.instanceProjection);
  }

  getInstanceProjection(): InstanceProjection {
    return immutableInstanceProjection(this.instanceProjection);
  }

  getExpansionCoverageProjection(requestId: string): ExpansionCoverageProjection {
    const request = this.instanceProjection.requestsById[requestId];
    const expansion = request
      ? this.requireClaimPlan().expansionPlan?.byOwner[request.expansionOwnerCheck]
      : undefined;
    if (!expansion) {
      throw new ClaimKernelError('UNKNOWN_COVERAGE_REQUEST', `Unknown coverage request ${requestId}`);
    }
    return projectExpansionCoverage(this.claimProjection, this.instanceProjection, expansion, requestId);
  }

  getExpansionCoverageRequestIds(ownerCheck?: string): readonly string[] {
    return Object.freeze(this.instanceProjection.requestOrder.filter(requestId =>
      ownerCheck === undefined ||
      this.instanceProjection.requestsById[requestId].expansionOwnerCheck === ownerCheck
    ));
  }

  replayExpansionCoverageProjection(requestId: string): ExpansionCoverageProjection {
    const instanceProjection = this.replayInstanceProjection();
    const claimProjection = this.replayClaimProjection();
    const request = instanceProjection.requestsById[requestId];
    const expansion = request
      ? this.requireClaimPlan().expansionPlan?.byOwner[request.expansionOwnerCheck]
      : undefined;
    if (!expansion) {
      throw new ClaimKernelError('UNKNOWN_COVERAGE_REQUEST', `Unknown coverage request ${requestId}`);
    }
    return projectExpansionCoverage(claimProjection, instanceProjection, expansion, requestId);
  }

  replayInstanceProjection(): InstanceProjection {
    const projection = replayInstanceEvents(
      this.runtimeEvents.filter(event =>
        [
          'CatalogReconciliationRequested',
          'SubgraphExpanded',
          'ControllerItemClaimPublished',
          'NodeGenerationInactivated',
          'NodeGenerationActivated',
          'SubgraphTombstoned',
          'ManagedRunAcquisitionFailed',
          'ManagedRunAcquired',
          'ManagedRunStarted',
          'ManagedRunCancelRequested',
          'ManagedRunTerminated',
        ].includes(event.type) ||
        'nodeGenerationId' in event || 'requestId' in event
      ) as InstanceRuntimeEvent[]
    );
    // Validate against the freshly replayed projection itself, not merely the
    // live cache. A temporary journal keeps the assembler's existing request
    // reconstruction API while preserving this method's pure replay result.
    const replayJournal = new ExecutionJournal(this.requireClaimPlan());
    replayJournal.runtimeEvents = [...this.runtimeEvents];
    replayJournal.claimProjection = this.claimProjection;
    replayJournal.instanceProjection = projection;
    replayJournal.validateComponentAuthorityLineage();
    return projection;
  }

  startAttempt(input: {
    sessionId: string;
    checkId: string;
    scope: ScopePath;
  }): AttemptStartedEvent {
    const plan = this.requireClaimPlan();
    if (!Object.prototype.hasOwnProperty.call(plan.effectiveDependenciesByCheck, input.checkId)) {
      throw new ClaimKernelError('UNKNOWN_CHECK', `Unknown claim-mode check ${input.checkId}`);
    }
    const authoritativeInput = {
      sessionId: input.sessionId,
      checkId: input.checkId,
      scope: input.scope.map(part => ({ ...part })),
    };
    const ordinalKey = canonicalJson(authoritativeInput);
    const ordinal = (this.attemptOrdinals.get(ordinalKey) || 0) + 1;
    this.attemptOrdinals.set(ordinalKey, ordinal);
    const fence = ++this.nextFence;
    const attemptId = sha256Canonical({ ...authoritativeInput, ordinal });
    return this.appendRuntimeEvent({
      version: 1,
      type: 'AttemptStarted',
      eventId: this.nextRuntimeEventId(),
      ...authoritativeInput,
      attemptId,
      fence,
    });
  }

  scheduleCheck(input: {
    sessionId: string;
    checkId: string;
    scope: ScopePath;
    attemptId: string;
    fence: number;
  }): CheckScheduledEvent {
    const plan = this.requireClaimPlan();
    const claimIds = exactActiveClaimIds(plan, this.claimProjection, input.checkId);
    return this.appendRuntimeEvent({
      version: 1,
      type: 'CheckScheduled',
      eventId: this.nextRuntimeEventId(),
      sessionId: input.sessionId,
      checkId: input.checkId,
      scope: input.scope.map(part => ({ ...part })),
      attemptId: input.attemptId,
      fence: input.fence,
      claimIds: [...claimIds],
    });
  }

  private reconcileCatalog(input: {
    sessionId: string;
    expansion: CompiledExpansion;
    payload: unknown;
    catalogClaimId: string;
    startEventId: number;
    projection: InstanceProjection;
    parentSubgraphInstanceId: string | null;
    expansionOwnerNodeInstanceId?: string;
  }): { events: InstanceRuntimeEvent[]; projection: InstanceProjection } {
    const expansion = input.expansion;
    const nested = input.parentSubgraphInstanceId !== null;
    const parent = nested
      ? input.projection.instancesById[input.parentSubgraphInstanceId as string]
      : undefined;
    if (
      nested &&
      (!parent ||
        parent.status !== 'active' ||
        !input.expansionOwnerNodeInstanceId ||
        input.projection.nodesById[input.expansionOwnerNodeInstanceId]?.subgraphInstanceId !==
          parent.subgraphInstanceId)
    ) {
      throw new ClaimKernelError(
        'INVALID_NESTED_EXPANSION_OWNER',
        'Nested reconciliation requires one exact active parent and owner node'
      );
    }
    if (nested) {
      const catalog = input.projection.claimsById[input.catalogClaimId];
      const producer = catalog?.nodeGenerationId
        ? input.projection.generationsById[catalog.nodeGenerationId]
        : undefined;
      if (
        !catalog?.active ||
        catalog.kind !== 'generated-output' ||
        catalog.claim !== expansion.catalogClaimRef ||
        catalog.subgraphInstanceId !== parent!.subgraphInstanceId ||
        !producer ||
        producer.nodeInstanceId !== input.expansionOwnerNodeInstanceId ||
        producer.nestedExpansionCatalogClaimRef !== expansion.catalogClaimRef ||
        producer.status !== 'running' ||
        !producer.scheduled ||
        input.projection.activeGenerationIdByNode[producer.nodeInstanceId] !==
          producer.nodeGenerationId ||
        catalog.producerAttemptId !== producer.attemptId ||
        catalog.producerFence !== producer.fence
      ) {
        throw new ClaimKernelError(
          'INVALID_NESTED_CATALOG_LINEAGE',
          'Nested catalog must be the exact active output of its current fenced owner generation'
        );
      }
    }
    expansion.catalogValidator(input.payload);
    const rawItems = resolveJsonPointer(input.payload, expansion.itemsPointer);
    if (!Array.isArray(rawItems)) {
      throw new ClaimKernelError(
        'INVALID_CATALOG_ITEMS',
        'Catalog items pointer must resolve to an array'
      );
    }
    const items = new Map<string, unknown>();
    for (const item of rawItems) {
      expansion.itemValidator(item);
      const key = canonicalCatalogKey(resolveJsonPointer(item, expansion.keyPointer));
      if (items.has(key)) {
        throw new ClaimKernelError('DUPLICATE_CATALOG_KEY', `Duplicate catalog key ${key}`);
      }
      items.set(key, immutableCanonicalValue(item));
    }

    let projection = input.projection;
    const events: InstanceRuntimeEvent[] = [];
    let nextId = input.startEventId;
    const stage = (event: StagedInstanceRuntimeEvent): void => {
      const stored = immutableInstanceEvent({ ...event, eventId: nextId++ });
      projection = reduceInstanceEvent(projection, stored);
      events.push(stored);
    };

    const allByKey = new Map(
      Object.values(input.projection.instancesById)
        .filter(instance =>
          instance.expansionOwnerCheck === expansion.expansionOwnerCheck &&
          (instance.parentSubgraphInstanceId || null) === input.parentSubgraphInstanceId &&
          (!nested ||
            instance.expansionOwnerNodeInstanceId === input.expansionOwnerNodeInstanceId)
        )
        .map(instance => [instance.itemKey, instance] as const)
    );
    const active = [...allByKey.values()].filter(instance => instance.status === 'active');
    const sortedItems = [...items.entries()].sort(([left], [right]) => left.localeCompare(right));

    for (const [key] of sortedItems) {
      if (!nested && allByKey.get(key)?.status === 'tombstoned') {
        throw new ClaimKernelError(
          'TOMBSTONED_KEY_READD_UNSUPPORTED',
          `Key ${key} was tombstoned`
        );
      }
    }

    const changed = sortedItems.filter(([key, item]) => {
      const instance = allByKey.get(key);
      if (!instance?.activeItemClaimId || instance.status !== 'active') return false;
      return (
        input.projection.claimsById[instance.activeItemClaimId].payloadFingerprint !==
          deriveItemFingerprint(item) ||
        (nested && instance.catalogClaimId !== input.catalogClaimId)
      );
    });
    const revived = nested
      ? sortedItems.filter(([key]) => allByKey.get(key)?.status === 'tombstoned')
      : [];
    const added = sortedItems.filter(([key]) => !allByKey.has(key));

    const activateSources = (
      instanceId: string,
      itemFingerprint: string
    ): void => {
      const instance = projection.instancesById[instanceId];
      for (const nodeKey of expansion.template.sourceNodeKeys) {
        const node = expansion.template.nodesByKey[nodeKey];
        const nestedCatalogClaimRef = this.requireClaimPlan().expansionPlan!.byNestedOwner[
          qualifiedNestedExpansionOwner(expansion.template.name, nodeKey)
        ]?.catalogClaimRef;
        const inputIds: string[] = [];
        let ready = true;
        for (const consumption of node.consumptions) {
          const matches = Object.values(projection.claimsById)
            .filter(claim =>
              claim.active &&
              claim.subgraphInstanceId === instance.subgraphInstanceId &&
              claim.incarnation === instance.incarnation &&
              claim.claim === consumption.claim
            )
            .sort((left, right) => left.claimId.localeCompare(right.claimId));
          if (matches.length !== 1) {
            ready = false;
            break;
          }
          inputIds.push(matches[0].claimId);
        }
        if (!ready) continue;
        inputIds.sort();
        const nodeInstanceId = instance.nodeInstanceIdsByTemplateNode[nodeKey];
        const nodeGenerationId = deriveNodeGenerationId({
          nodeInstanceId,
          incarnation: instance.incarnation,
          itemFingerprint,
          executionConfigDigest: node.executionConfigDigest,
          activeInputClaimIds: inputIds,
        });
        stage({
          version: 1,
          type: 'NodeGenerationActivated',
          sessionId: input.sessionId,
          scope: instance.scope,
          subgraphInstanceId: instance.subgraphInstanceId,
          nodeInstanceId,
          nodeGenerationId,
          templateNodeKey: nodeKey,
          checkId: nodeKey,
          incarnation: instance.incarnation,
          itemFingerprint,
          executionConfigDigest: node.executionConfigDigest,
          activeInputClaimIds: inputIds,
          ...(nestedCatalogClaimRef
            ? { nestedExpansionCatalogClaimRef: nestedCatalogClaimRef }
            : {}),
        });
      }
    };

    const publishItemAndActivateSources = (
      instanceId: string,
      key: string,
      item: unknown
    ): void => {
      let instance = projection.instancesById[instanceId];
      const payloadFingerprint = deriveItemFingerprint(item);
      const incarnation = instance.incarnation + 1;
      const claimId = deriveControllerItemClaimId({
        claim: expansion.itemClaimRef,
        payloadFingerprint,
        expansionSpecDigest: expansion.expansionSpecDigest,
        catalogClaimId: input.catalogClaimId,
        subgraphInstanceId: instance.subgraphInstanceId,
        incarnation,
        scope: instance.scope,
      });
      stage({
        version: 1,
        type: 'ControllerItemClaimPublished',
        sessionId: input.sessionId,
        scope: instance.scope,
        expansionOwnerCheck: expansion.expansionOwnerCheck,
        expansionSpecDigest: expansion.expansionSpecDigest,
        catalogClaimId: input.catalogClaimId,
        itemKey: key,
        subgraphInstanceId: instance.subgraphInstanceId,
        incarnation,
        claimId,
        claim: expansion.itemClaimRef,
        payload: item,
        payloadFingerprint,
        parentClaimIds: [input.catalogClaimId],
      });
      instance = projection.instancesById[instanceId];
      activateSources(instance.subgraphInstanceId, payloadFingerprint);
    };

    const tombstoneTree = (instanceId: string, sourceCatalogClaimId: string): void => {
      const descendants = Object.values(projection.instancesById)
        .filter(candidate =>
          candidate.status === 'active' &&
          candidate.parentSubgraphInstanceId === instanceId
        )
        .sort((left, right) => left.itemKey.localeCompare(right.itemKey));
      for (const descendant of descendants) {
        tombstoneTree(descendant.subgraphInstanceId, descendant.catalogClaimId);
      }
      const instance = projection.instancesById[instanceId];
      const generations = Object.values(projection.generationsById)
        .filter(generation =>
          generation.subgraphInstanceId === instance.subgraphInstanceId &&
          generation.status !== 'inactive'
        )
        .sort((left, right) => left.nodeGenerationId.localeCompare(right.nodeGenerationId));
      stage({
        version: 1,
        type: 'SubgraphTombstoned',
        sessionId: input.sessionId,
        scope: instance.scope,
        expansionOwnerCheck: instance.expansionOwnerCheck,
        sourceCatalogClaimId,
        itemKey: instance.itemKey,
        subgraphInstanceId: instance.subgraphInstanceId,
        lastIncarnation: instance.incarnation,
        nodeGenerationIds: generations.map(value => value.nodeGenerationId).sort(),
        outputClaimIds: generations.flatMap(value => value.completedOutputClaimIds).sort(),
      });
    };
    const tombstoneDescendants = (instanceId: string): void => {
      const descendants = Object.values(projection.instancesById)
        .filter(candidate =>
          candidate.status === 'active' &&
          candidate.parentSubgraphInstanceId === instanceId
        )
        .sort((left, right) => left.itemKey.localeCompare(right.itemKey));
      for (const descendant of descendants) {
        tombstoneTree(descendant.subgraphInstanceId, descendant.catalogClaimId);
      }
    };

    for (const instance of active
      .filter(candidate => !items.has(candidate.itemKey))
      .sort((left, right) => left.itemKey.localeCompare(right.itemKey))) {
      tombstoneTree(instance.subgraphInstanceId, input.catalogClaimId);
    }

    for (const [key, item] of changed) {
      let instance = projection.instancesById[allByKey.get(key)!.subgraphInstanceId];
      tombstoneDescendants(instance.subgraphInstanceId);
      for (const nodeKey of expansion.template.reverseTopology) {
        const nodeInstanceId = instance.nodeInstanceIdsByTemplateNode[nodeKey];
        const generationId = projection.activeGenerationIdByNode[nodeInstanceId];
        if (!generationId) continue;
        const generation = projection.generationsById[generationId];
        stage({
          version: 1,
          type: 'NodeGenerationInactivated',
          sessionId: input.sessionId,
          scope: instance.scope,
          subgraphInstanceId: instance.subgraphInstanceId,
          nodeInstanceId,
          nodeGenerationId: generationId,
          incarnation: generation.incarnation,
          outputClaimIds: [...generation.completedOutputClaimIds].sort(),
          reason: 'superseded',
        });
        instance = projection.instancesById[instance.subgraphInstanceId];
      }
      publishItemAndActivateSources(instance.subgraphInstanceId, key, item);
    }

    for (const [key, item] of revived) {
      const instance = projection.instancesById[allByKey.get(key)!.subgraphInstanceId];
      publishItemAndActivateSources(instance.subgraphInstanceId, key, item);
    }

    for (const [key, item] of added) {
      const subgraphInstanceId = nested
        ? deriveSubgraphInstanceId({
            graphSemanticDigest: expansion.graphSemanticDigest,
            parentSubgraphInstanceId: parent!.subgraphInstanceId,
            expansionOwnerNodeInstanceId: input.expansionOwnerNodeInstanceId as string,
            templateDigest: expansion.templateDigest,
            itemKey: key,
          })
        : deriveSubgraphInstanceId({
            graphSemanticDigest: expansion.graphSemanticDigest,
            expansionOwnerCheck: expansion.expansionOwnerCheck,
            parentSubgraphInstanceId: null,
            templateDigest: expansion.templateDigest,
            itemKey: key,
          });
      const scope: KeyedScopePath = Object.freeze([
        ...(nested ? parent!.scope : []),
        {
          kind: 'keyed' as const,
          expansionOwnerCheck: expansion.expansionOwnerCheck,
          key,
          subgraphInstanceId,
        },
      ]) as KeyedScopePath;
      stage({
        version: 1,
        type: 'SubgraphExpanded',
        sessionId: input.sessionId,
        scope,
        expansionOwnerCheck: expansion.expansionOwnerCheck,
        graphSemanticDigest: expansion.graphSemanticDigest,
        expansionSpecDigest: expansion.expansionSpecDigest,
        templateDigest: expansion.templateDigest,
        parentSubgraphInstanceId: input.parentSubgraphInstanceId,
        ...(nested
          ? {
              expansionOwnerNodeInstanceId: input.expansionOwnerNodeInstanceId as string,
              catalogClaimRef: expansion.catalogClaimRef,
            }
          : {}),
        catalogClaimId: input.catalogClaimId,
        itemKey: key,
        subgraphInstanceId,
        nodeInstanceIdsByTemplateNode: Object.fromEntries(
          expansion.template.templateNodeKeys.map(nodeKey => [
            nodeKey,
            deriveNodeInstanceId({ subgraphInstanceId, templateNodeKey: nodeKey }),
          ])
        ),
      });
      publishItemAndActivateSources(subgraphInstanceId, key, item);
    }

    return { events, projection };
  }

  completeAttempt(input: {
    sessionId: string;
    checkId: string;
    scope: ScopePath;
    attemptId: string;
    fence: number;
    payload: unknown;
  }): {
    readonly claims: readonly CandidateClaimInput[];
    readonly completed: AttemptCompletedEvent;
  } {
    const plan = this.requireClaimPlan();
    const scheduled = this.claimProjection.scheduled.find(
      event =>
        event.sessionId === input.sessionId &&
        event.checkId === input.checkId &&
        event.attemptId === input.attemptId &&
        event.fence === input.fence &&
        canonicalJson(event.scope) === canonicalJson(input.scope)
    );
    if (!scheduled) {
      throw new ClaimKernelError(
        'ATTEMPT_NOT_SCHEDULED',
        `Attempt ${input.attemptId} was not scheduled before terminal processing`
      );
    }

    let stagedProjection = this.claimProjection;
    const stagedEvents: ClaimRuntimeEvent[] = [];
    const claimIds: string[] = [];
    for (const emission of plan.emissionsByCheck[input.checkId] || []) {
      const built = buildClaimPublishedEvent({
        eventId: Math.max(stagedProjection.lastEventId, this.instanceProjection.lastEventId, ...stagedEvents.map(event => event.eventId)) + 1,
        sessionId: input.sessionId,
        checkId: input.checkId,
        scope: input.scope,
        attemptId: input.attemptId,
        fence: input.fence,
        claim: emission.claim,
        payload: input.payload,
        parentClaimIds: scheduled.claimIds,
        projection: stagedProjection,
        plan,
      });
      const event = immutableRuntimeEvent(built);
      stagedProjection = reduceClaimEvent(stagedProjection, event, plan);
      stagedEvents.push(event);
      claimIds.push(event.claimId);
    }

    const rootExpansion = plan.expansionPlan?.byOwner[input.checkId];
    const catalogClaimId = claimIds.find(id =>
      stagedProjection.claims[id]?.claim === rootExpansion?.catalogClaimRef
    );
    const reconciled = catalogClaimId && rootExpansion
      ? this.reconcileCatalog({
          sessionId: input.sessionId,
          expansion: rootExpansion,
          payload: input.payload,
          catalogClaimId,
          startEventId: Math.max(stagedProjection.lastEventId, this.instanceProjection.lastEventId) + 1,
          projection: this.instanceProjection,
          parentSubgraphInstanceId: null,
        })
      : { events: [] as InstanceRuntimeEvent[], projection: this.instanceProjection };
    const requestId = this.instanceProjection.attemptBindingsById[input.attemptId];
    if (requestId && !catalogClaimId) {
      throw new ClaimKernelError('INVALID_REQUEST_CATALOG',
        `Catalog request ${requestId} did not publish its configured catalog claim`);
    }

    const completed = immutableRuntimeEvent({
      version: 1,
      type: 'AttemptCompleted',
      eventId: Math.max(stagedProjection.lastEventId, reconciled.projection.lastEventId) + 1,
      sessionId: input.sessionId,
      checkId: input.checkId,
      scope: input.scope.map(part => ({ ...part })),
      attemptId: input.attemptId,
      fence: input.fence,
      ...(requestId
        ? { requestId, catalogClaimId: catalogClaimId as string }
        : {}),
    });
    stagedProjection = reduceClaimEvent(stagedProjection, completed, plan);
    stagedEvents.push(completed);

    const finalInstanceProjection = requestId
      ? reduceInstanceEvent(reconciled.projection, completed as any)
      : reconciled.projection;

    this.runtimeEvents.push(...stagedEvents.slice(0, -1), ...reconciled.events, completed);
    this.claimProjection = stagedProjection;
    this.instanceProjection = finalInstanceProjection;
    return Object.freeze({
      claims: Object.freeze(claimIds.map(claimId => stagedProjection.claims[claimId])),
      completed,
    });
  }

  failAttempt(input: {
    sessionId: string;
    checkId: string;
    scope: ScopePath;
    attemptId: string;
    fence: number;
    reason: string;
  }): AttemptFailedEvent {
    const requestId = this.instanceProjection.attemptBindingsById[input.attemptId];
    const event = immutableRuntimeEvent({
      sessionId: input.sessionId,
      checkId: input.checkId,
      attemptId: input.attemptId,
      fence: input.fence,
      reason: input.reason,
      version: 1,
      type: 'AttemptFailed',
      eventId: this.nextRuntimeEventId(),
      scope: input.scope.map(part => ({ ...part })),
      ...(requestId ? { requestId } : {}),
    });
    const claim = reduceClaimEvent(this.claimProjection, event, this.requireClaimPlan());
    const instance = requestId
      ? reduceInstanceEvent(this.instanceProjection, event as any)
      : this.instanceProjection;
    this.runtimeEvents.push(event); this.claimProjection = claim; this.instanceProjection = instance;
    return event;
  }

  readRuntimeEvents(): readonly (ClaimRuntimeEvent | InstanceRuntimeEvent)[] {
    return Object.freeze(this.runtimeEvents.map(event =>
      event.type === 'ClaimPublished' && 'nodeGenerationId' in event
        ? immutableInstanceEvent(event as InstanceRuntimeEvent)
        : immutableCanonicalValue(event)
    ));
  }

  getClaimProjection(): ClaimProjection {
    return immutableCanonicalValue(this.claimProjection);
  }

  replayClaimProjection(): ClaimProjection {
    return replayClaimEvents(
      this.readRuntimeEvents().filter(event =>
        ['AttemptStarted','ClaimPublished','CheckScheduled','AttemptCompleted','AttemptFailed'].includes(event.type) &&
        !('nodeGenerationId' in event)
      ) as ClaimRuntimeEvent[],
      this.requireClaimPlan()
    );
  }

  isCheckReady(checkId: string): boolean {
    try {
      exactActiveClaimIds(this.requireClaimPlan(), this.claimProjection, checkId);
      return true;
    } catch (error) {
      if (error instanceof ClaimKernelError && error.code === 'CLAIM_NOT_READY') return false;
      throw error;
    }
  }

  readCheckClaims(checkId: string): Readonly<Record<string, CandidateClaimInput>> {
    const plan = this.requireClaimPlan();
    const claimIds = exactActiveClaimIds(plan, this.claimProjection, checkId);
    const selected: Record<string, CandidateClaimInput> = {};
    for (const [index, consumption] of (plan.consumptionsByCheck[checkId] || []).entries()) {
      const claimId = claimIds[index];
      const claim = this.claimProjection.claims[claimId];
      if (claim) selected[consumption.claim] = claim;
    }
    return Object.freeze(selected);
  }

  // Lightweight helpers for debugging/metrics
  size(): number {
    return this.entries.length;
  }
}

export class ContextView {
  constructor(
    private journal: ExecutionJournal,
    private sessionId: string,
    private snapshotId: number,
    private scope: ScopePath,
    private event?: EventTrigger
  ) {}

  /** Return the nearest result for a check in this scope (exact item → ancestor → latest). */
  get(checkId: string): (ReviewSummary & { output?: unknown; content?: string }) | undefined {
    const visible = this.journal
      .readVisible(this.sessionId, this.snapshotId, this.event)
      .filter(e => e.checkId === checkId);
    if (visible.length === 0) return undefined;

    // exact scope match: prefer the most recent commit for this scope
    const exactMatches = visible.filter(e => this.sameScope(e.scope, this.scope));
    if (exactMatches.length > 0) {
      return exactMatches[exactMatches.length - 1].result;
    }

    // nearest ancestor (shortest distance)
    let best: { entry: JournalEntry; dist: number } | undefined;
    for (const e of visible) {
      const dist = this.ancestorDistance(e.scope, this.scope);
      if (dist >= 0 && (best === undefined || dist < best.dist)) {
        best = { entry: e, dist };
      }
    }
    if (best) return best.entry.result;

    // fallback to latest committed result
    return visible[visible.length - 1]?.result;
  }

  /** Return an aggregate (raw) result – the shallowest scope for this check. */
  getRaw(checkId: string): (ReviewSummary & { output?: unknown; content?: string }) | undefined {
    const visible = this.journal
      .readVisible(this.sessionId, this.snapshotId, this.event)
      .filter(e => e.checkId === checkId);
    if (visible.length === 0) return undefined;
    let shallow = visible[0];
    for (const e of visible) {
      if (e.scope.length < shallow.scope.length) shallow = e;
    }
    return shallow.result;
  }

  /** All results for a check up to this snapshot. */
  getHistory(checkId: string): Array<ReviewSummary & { output?: unknown; content?: string }> {
    return this.journal
      .readVisible(this.sessionId, this.snapshotId, this.event)
      .filter(e => e.checkId === checkId)
      .map(e => e.result);
  }

  private sameScope(a: ScopePath, b: ScopePath): boolean {
    return canonicalJson(a) === canonicalJson(b);
  }

  // distance from ancestor to current; -1 if not ancestor
  private ancestorDistance(ancestor: ScopePath, current: ScopePath): number {
    if ([...ancestor, ...current].some(segment => (segment as any).kind === 'keyed')) {
      return this.sameScope(ancestor, current) ? 0 : -1;
    }
    if (ancestor.length > current.length) return -1;
    // Treat root scope ([]) as non-ancestor for unrelated branches
    if (ancestor.length === 0 && current.length > 0) return -1;
    for (let i = 0; i < ancestor.length; i++) {
      if (ancestor[i].check !== current[i].check || ancestor[i].index !== current[i].index)
        return -1;
    }
    return current.length - ancestor.length;
  }
}
