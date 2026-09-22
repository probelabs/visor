/**
 * Read-only progress projection for the checklist-driven onboarding slice.
 *
 * Proof remains the authority for checklist disposition and evidence.  This
 * module only combines that effective snapshot with the Visor instance
 * projection and an optional checkpoint, and deliberately does not persist or
 * infer completion from counts, filenames, or process exit status.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { ConfigManager } from '../../../src/config';
import { validateGraphCheckpointInputFile } from '../../../src/graph-checkpoint-file';
import { ExecutionJournal } from '../../../src/snapshot-store';
import { compileClaimPlan } from '../../../src/state-machine/graph/claim-plan';
import { canonicalJson, sha256Canonical } from '../../../src/state-machine/graph/claim-kernel';
import type { ClaimProjection } from '../../../src/state-machine/graph/claim-kernel';
import type { InstanceProjection } from '../../../src/state-machine/graph/instance-kernel';
import type { ExpansionPlan } from '../../../src/state-machine/graph/instance-plan';

type Json = Record<string, unknown>;

const CHECKLIST_SNAPSHOT_CLAIMS = {
  'proof.checklist.snapshot@1': undefined,
  'proof.checklist.research-snapshot@1': 'research',
  'proof.checklist.skeleton-snapshot@1': 'skeleton',
  'native.continuation.checklist_snapshot@1': 'continuation',
} as const;
type ChecklistSnapshotClaim = keyof typeof CHECKLIST_SNAPSHOT_CLAIMS;
type ChecklistSnapshotEvidenceSource =
  | ChecklistSnapshotClaim
  | 'current-proof-readback'
  | 'native.component.summary@1';

export type NativeChecklistProgressInput = Readonly<{
  proofSnapshot: unknown;
  /** Optional graph claim used to prove that the supplied snapshot is journal-linked. */
  proofSnapshotClaim?: unknown;
  /**
   * A current Proof readback selected by the projection layer.  This is not a
   * synthetic claim: the historical continuation claim remains the lineage
   * anchor and this small record only identifies that anchor and the completed
   * selected checklist generation which caused the readback to be observed.
   */
  proofSnapshotReadback?: Readonly<{
    anchorClaimId: string;
    generationId: string;
  }>;
  /** Journal-validated Milestone B fan-in evidence. */
  proofSnapshotEvidence?: Readonly<{
    source: 'native.component.summary@1';
    claimIds: readonly string[];
    componentIds: readonly string[];
  }>;
  instanceProjection?: InstanceProjection | unknown;
  checkpoint?: unknown;
  /** Persisted checkpoint creation time.  The projector never uses the clock. */
  checkpointTimestamp?: unknown;
  /** Require a journal-linked snapshot for live runner views. */
  requireProofSnapshotClaim?: boolean;
  paused?: boolean;
  resumed?: boolean;
  /** Authoritative retained catalog IDs, when a continuation is running. */
  retainedCatalogComponentIds?: readonly string[];
  /** Component IDs with newly derived work in this continuation stage. */
  affectedComponentIds?: readonly string[];
  /** The compiled expansion topology used to prove missing-node conditions. */
  expansionPlan?: ExpansionPlan | unknown;
  /** Current Proof req-list/req-show identity tuples, when a stale check is requested. */
  currentProofInputs?: unknown;
  /** Validated Proof catalog drift observed before a refused continuation resume. */
  proofCatalogDrift?: unknown;
}>;

export type NativeChecklistProgressState =
  | 'confirmed'
  | 'skipped'
  | 'not_applicable'
  | 'pending'
  | 'blocked'
  | 'stale'
  | 'failed'
  | 'unknown';

export type NativeChecklistOperationalState =
  'unknown' | 'pending' | 'running' | 'failed' | 'completed';

export type NativeChecklistProgress = Readonly<{
  version: 1;
  kind: 'native-checklist-progress';
  checklist: Readonly<{
    name: string;
    active: boolean;
    new_project: boolean;
    definition_source?: string;
    definition_path?: string;
    updated_at?: string;
    steps_total: number;
    steps_pending: number;
    /** All rows which still require attention, including stale evidence. */
    unresolved_count: number;
    counts: Readonly<
      Record<
        | 'confirmed'
        | 'skipped'
        | 'not_applicable'
        | 'pending'
        | 'blocked'
        | 'stale'
        | 'failed'
        | 'unknown',
        number
      >
    >;
    eligible_step_ids: readonly string[];
    next: unknown;
    steps: readonly NativeChecklistProgressStep[];
  }>;
  operational: Readonly<{
    project: NativeChecklistOperationalWork;
    components: NativeChecklistOperationalCollection;
    specifications: NativeChecklistOperationalCollection;
    batches: NativeChecklistOperationalCollection;
    /** Retained catalog coverage is distinct from this stage's work batches. */
    catalog_coverage: NativeChecklistCatalogCoverage;
    discovered: Readonly<{
      project: number;
      components: number;
      specifications: number;
      batches: number;
      total: number;
    }>;
    unknown_count: number;
    unexpanded_count: number;
  }>;
  evidence: Readonly<{
    proof_snapshot: Readonly<{
      schema_version: string;
      checklist: string;
      digest: string;
      source?: ChecklistSnapshotEvidenceSource;
      stage?: 'research' | 'skeleton';
      claim_id?: string;
      claim_ids?: readonly string[];
      component_ids?: readonly string[];
      anchor_claim_id?: string;
      generation_id?: string;
      updated_at?: string;
    }>;
    journal: Readonly<{
      session_id?: string;
      event_count?: number;
      last_event_id?: number;
      graph_semantic_digest?: string;
      integrity_digest?: string;
      checkpoint_timestamp?: string;
      checkpoint_present: boolean;
      provenance?: 'checkpoint' | 'live_projection';
      durable_through_event_id?: number;
    }>;
    catalog_drift?: NativeChecklistCatalogDrift;
  }>;
  paused: boolean;
  resumed: boolean;
  resumable: boolean;
  unknown: readonly string[];
}>;

export type NativeChecklistProgressStep = Readonly<{
  id: string;
  title: string;
  state: NativeChecklistProgressState;
  stored_status: string;
  effective_status: string;
  applicable: boolean;
  eligible: boolean;
  requires: readonly string[];
  unmet_requires: readonly string[];
  role?: string;
  scope?: string;
  verify_cmd?: string;
  verify_required: boolean;
  required_checks: readonly string[];
  check_results: readonly unknown[];
  verify_result?: unknown;
  evidence: Readonly<{
    required_checks_pass: boolean;
    verify_pass?: boolean;
  }>;
}>;

export type NativeChecklistOperationalWork = Readonly<{
  state: NativeChecklistOperationalState;
  known: boolean;
  check_ids: readonly string[];
}>;

export type NativeChecklistOperationalCollection = Readonly<{
  /** False means no authoritative expansion/catalog has been observed. */
  known: boolean;
  known_count: number;
  completed_count: number;
  running_count: number;
  failed_count: number;
  pending_count: number;
  unknown_count: number;
  unexpanded_count: number;
  blocked_count: number;
  stale_count: number;
  /** Receipt decisions are execution-adjacent review observations, not Proof confirmation. */
  receipt_decisions?: Readonly<{
    approved: number;
    needs_changes: number;
    unreviewed: number;
    unknown: number;
  }>;
  items: readonly Readonly<{
    id: string;
    state: NativeChecklistOperationalState;
    check_ids: readonly string[];
    component_id?: string;
    batch_id?: string;
    receipt_decision?: 'approved' | 'needs_changes' | 'unreviewed' | 'unknown';
    receipt_claim_id?: string;
    conditions?: readonly NativeChecklistOperationalCondition[];
    /** Singular compatibility view for consumers rendering one condition. */
    condition?: NativeChecklistOperationalCondition;
  }>[];
}>;

export type NativeChecklistOperationalCondition = Readonly<{
  state: 'blocked' | 'stale';
  kind: 'waiting' | 'failed_dependency' | 'changed_input';
  evidence: Readonly<Record<string, unknown>>;
}>;

export type NativeChecklistCatalogCoverage = Readonly<{
  known: boolean;
  known_count: number;
  affected_count: number;
  reused_count: number;
  unexpanded_count: number;
  items: readonly Readonly<{
    id: string;
    disposition: 'affected' | 'reused';
  }>[];
}>;

export type NativeChecklistCatalogDrift = Readonly<{
  retained_ids: readonly string[];
  current_ids: readonly string[];
  added_ids: readonly string[];
  removed_ids: readonly string[];
}>;

function isRecord(value: unknown): value is Json {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0)
    throw new Error(`${label} must be a non-empty string`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isRFC3339(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

function stringArray(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`${label} must be an array of strings`);
  }
  return [...value];
}

function normalizeCatalogDrift(value: unknown): NativeChecklistCatalogDrift | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !hasExactKeys(value, ['retained_ids', 'current_ids', 'added_ids', 'removed_ids'])) {
    throw new Error('catalog drift must contain exactly retained_ids, current_ids, added_ids, and removed_ids');
  }
  const retainedIds = stringArray(value.retained_ids, 'catalog drift retained_ids');
  const currentIds = stringArray(value.current_ids, 'catalog drift current_ids');
  const addedIds = stringArray(value.added_ids, 'catalog drift added_ids');
  const removedIds = stringArray(value.removed_ids, 'catalog drift removed_ids');
  const isSortedUnique = (ids: readonly string[]): boolean =>
    new Set(ids).size === ids.length &&
    ids.every((id, index) => index === 0 || Buffer.from(ids[index - 1]).compare(Buffer.from(id)) <= 0);
  if (![retainedIds, currentIds, addedIds, removedIds].every(isSortedUnique)) {
    throw new Error('catalog drift IDs must be sorted and unique');
  }
  const retained = new Set(retainedIds);
  const current = new Set(currentIds);
  const expectedAdded = currentIds.filter(id => !retained.has(id));
  const expectedRemoved = retainedIds.filter(id => !current.has(id));
  if (canonicalJson(addedIds) !== canonicalJson(expectedAdded) ||
      canonicalJson(removedIds) !== canonicalJson(expectedRemoved)) {
    throw new Error('catalog drift added_ids/removed_ids do not match retained_ids and current_ids');
  }
  return {
    retained_ids: retainedIds,
    current_ids: currentIds,
    added_ids: addedIds,
    removed_ids: removedIds,
  };
}

function objectArray(value: unknown, label: string): Json[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(item => !isRecord(item))) {
    throw new Error(`${label} must be an array of objects`);
  }
  return value as Json[];
}

function hasExactKeys(value: Json, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function requiredChecksPass(step: Json): boolean {
  const required = stringArray(
    step.required_checks,
    `step ${String(step.step_id)} required_checks`
  );
  if (required.length === 0) return true;
  const results = objectArray(step.check_results, `step ${String(step.step_id)} check_results`);
  // CheckStamp is a deliberately narrow Proof record: `{id,status,at}`.
  // Do not infer a pass from process exit codes or convenience aliases.  In
  // particular, a duplicate stamp is not an exact recorded pass.
  const byId = new Map<string, Json[]>();
  for (const result of results) {
    if (!hasExactKeys(result, ['id', 'status', 'at'])) continue;
    const id = optionalString(result.id);
    if (!id) continue;
    const rows = byId.get(id) ?? [];
    rows.push(result);
    byId.set(id, rows);
  }
  if (results.length !== required.length) return false;
  return required.every(check => {
    const rows = byId.get(check);
    return (
      rows?.length === 1 &&
      rows[0].status === 'pass' &&
      optionalString(rows[0].at) !== undefined &&
      isRFC3339(rows[0].at as string)
    );
  });
}

function verifyPassed(step: Json): boolean | undefined {
  if (!('verify_result' in step)) return undefined;
  const result = step.verify_result;
  if (!isRecord(result)) return false;
  // Proof's VerifyResult is valid only when both fields agree.  `passed:true`
  // with a non-zero exit (or vice versa) is stale/failed evidence.
  return (
    result.passed === true &&
    result.exit_code === 0 &&
    optionalString(result.at) !== undefined &&
    isRFC3339(result.at as string)
  );
}

/**
 * Render-only wording for required-check evidence.  A pending row with no
 * check results is not a failed check, and a subset of passing stamps is not
 * an all-pass assertion.  Keep this classification shared by CLI and HTML.
 */
function requiredCheckEvidenceLabel(step: NativeChecklistProgressStep): string {
  if (step.required_checks.length === 0) return 'none / not required';
  if (step.check_results.length === 0) return 'not evaluated';
  const required = new Set(step.required_checks);
  const recordedRequired = step.check_results.filter(
    result => isRecord(result) && typeof result.id === 'string' && required.has(result.id)
  ) as Json[];
  if (recordedRequired.some(result => result.status !== 'pass')) return 'fail';
  if (step.evidence.required_checks_pass === true) return 'pass';
  return 'incomplete';
}

function stepState(
  step: Json,
  requiredPass: boolean,
  verify: boolean | undefined
): NativeChecklistProgressState {
  const effective = optionalString(step.effective_status);
  const applicable = step.applicable !== false;
  if (!applicable || effective === 'not_applicable') return 'not_applicable';
  if (effective === 'skipped') return 'skipped';
  if (effective === 'confirmed') {
    const verifyRequired = step.stamp === 'confirm+verify';
    if (verifyRequired && verify === false) return 'failed';
    if (!requiredPass || (verifyRequired && verify !== true)) return 'stale';
    return 'confirmed';
  }
  if (effective === 'failed') return 'failed';
  if (effective === 'stale') return 'stale';
  if (effective === 'blocked') return 'blocked';
  if (effective === 'pending' || effective === 'eligible') {
    if (Array.isArray(step.unmet_requires) && step.unmet_requires.length > 0) return 'blocked';
    return 'pending';
  }
  return 'unknown';
}

function snapshotSteps(snapshot: Json): Json[] {
  if (snapshot.schema_version !== 'proof.checklist.show.v1') {
    throw new Error('proof checklist snapshot must use proof.checklist.show.v1');
  }
  return objectArray(snapshot.steps, 'proof checklist steps');
}

function validateSnapshotClaim(
  snapshot: Json,
  claimInput: unknown,
  requireLiveClaim: boolean
): { claim_id?: string; source?: ChecklistSnapshotClaim; stage?: 'research' | 'skeleton' | 'continuation' } {
  if (claimInput === undefined) return {};
  const claimName =
    isRecord(claimInput) && typeof claimInput.claim === 'string' ? claimInput.claim : undefined;
  if (
    !isRecord(claimInput) ||
    claimName === undefined ||
    !Object.prototype.hasOwnProperty.call(CHECKLIST_SNAPSHOT_CLAIMS, claimName) ||
    claimInput.active !== true
  ) {
    throw new Error(
      'proof checklist snapshot claim is not an active proof.checklist snapshot claim from the supported closed set'
    );
  }
  const payload = claimInput.payload;
  if (!isRecord(payload) || canonicalJson(payload) !== canonicalJson(snapshot)) {
    throw new Error('proof checklist snapshot claim payload does not match the supplied snapshot');
  }
  const claimId = optionalString(claimInput.claimId) ?? optionalString(claimInput.claim_id);
  if (requireLiveClaim) {
    if (!claimId || !/^[0-9a-f]{64}$/.test(claimId)) {
      throw new Error('live proof checklist snapshot claim requires a 64-hex claimId');
    }
    if (claimInput.payloadFingerprint !== sha256Canonical(snapshot)) {
      throw new Error(
        'live proof checklist snapshot claim payloadFingerprint does not match the supplied snapshot'
      );
    }
  }
  const source = claimName as ChecklistSnapshotClaim;
  const stage = CHECKLIST_SNAPSHOT_CLAIMS[source];
  return { ...(claimId ? { claim_id: claimId } : {}), source, ...(stage ? { stage } : {}) };
}

function validateCurrentReadbackEvidence(
  readback: NativeChecklistProgressInput['proofSnapshotReadback']
): {
  source: 'current-proof-readback';
  anchor_claim_id: string;
  generation_id: string;
} {
  if (!readback) throw new Error('current Proof readback evidence is missing');
  const anchorClaimId = requireClaimId(readback.anchorClaimId, 'current Proof readback anchor claim ID');
  const generationId = requiredString(readback.generationId, 'current Proof readback generation ID');
  return {
    source: 'current-proof-readback',
    anchor_claim_id: anchorClaimId,
    generation_id: generationId,
  };
}

type SelectedChecklistSnapshotClaim = Readonly<{
  claim: Json;
  stage: 'bootstrap' | 'research' | 'skeleton' | 'continuation';
}>;

function requireClaimId(value: unknown, label: string): string {
  const claimId = requiredString(value, label);
  if (!/^[0-9a-f]{64}$/.test(claimId)) throw new Error(`${label} must be a 64-hex claim ID`);
  return claimId;
}

function validateCandidateShape(candidate: Json, claimId: string, label: string): void {
  if (candidate.claimId !== claimId)
    throw new Error(`${label} claimId does not match its projection key`);
  requireClaimId(candidate.claimId, `${label} claimId`);
  if (!isRecord(candidate.payload)) throw new Error(`${label} payload must be an object`);
  if (candidate.payloadFingerprint !== sha256Canonical(candidate.payload)) {
    throw new Error(`${label} payloadFingerprint does not match its payload`);
  }
  if (!Array.isArray(candidate.scope)) throw new Error(`${label} scope must be an array`);
  if (
    !Array.isArray(candidate.parentClaimIds) ||
    candidate.parentClaimIds.some(parent => typeof parent !== 'string')
  ) {
    throw new Error(`${label} parentClaimIds must be an array of strings`);
  }
}

function validateRootBootstrapCandidate(candidate: Json, claimId: string): Json {
  validateCandidateShape(candidate, claimId, 'root checklist bootstrap claim');
  if (
    candidate.claim !== 'proof.checklist.snapshot@1' ||
    candidate.producerCheckId !== 'checklist-bootstrap' ||
    canonicalJson(candidate.scope) !== '[]' ||
    candidate.parentClaimIds.length !== 0
  ) {
    throw new Error(
      'root checklist bootstrap claim has an invalid producer, scope, or parent lineage'
    );
  }
  return { ...candidate, active: true };
}

function validateProjectScope(scope: unknown, label: string): Json[] {
  if (
    !Array.isArray(scope) ||
    scope.length !== 1 ||
    !isRecord(scope[0]) ||
    scope[0].kind !== 'keyed' ||
    typeof scope[0].key !== 'string' ||
    scope[0].key.length === 0 ||
    typeof scope[0].expansionOwnerCheck !== 'string' ||
    scope[0].expansionOwnerCheck.length === 0 ||
    typeof scope[0].subgraphInstanceId !== 'string' ||
    !/^[0-9a-f]{64}$/.test(scope[0].subgraphInstanceId) ||
    !hasExactKeys(scope[0], ['kind', 'expansionOwnerCheck', 'key', 'subgraphInstanceId'])
  ) {
    throw new Error(`${label} must use one keyed project scope`);
  }
  return scope as Json[];
}

function validateExpandedStageCandidate(
  candidate: Json,
  claimId: string,
  stage: 'research' | 'skeleton' | 'continuation',
  authorityClaimIds: ReadonlySet<string>,
): Json {
  validateCandidateShape(candidate, claimId, `expanded checklist ${stage} claim`);
  const producerCheckId = typeof candidate.producerCheckId === 'string' ? candidate.producerCheckId : '';
  const parentClaimIds = Array.isArray(candidate.parentClaimIds)
    ? candidate.parentClaimIds.filter((parent): parent is string => typeof parent === 'string')
    : [];
  if (
    candidate.claim !== (stage === 'continuation' ? 'native.continuation.checklist_snapshot@1' : `proof.checklist.${stage}-snapshot@1`) ||
    (stage === 'continuation'
      ? !['checklist-continuation-snapshot', 'checklist-traces-light', 'checklist-skeleton', 'checklist-variables'].includes(producerCheckId)
      : producerCheckId !== `checklist-${stage}`)
  ) {
    throw new Error(`expanded checklist ${stage} claim has an invalid producer or claim reference`);
  }
  validateProjectScope(candidate.scope, `expanded checklist ${stage} claim`);
  if (stage === 'continuation' &&
      (parentClaimIds.length !== 1 || !authorityClaimIds.has(parentClaimIds[0]))) {
    throw new Error('expanded checklist continuation claim must name the active catalog authority parent');
  }
  return { ...candidate, active: true };
}

function activeRootChecklistClaims(projection: unknown): SelectedChecklistSnapshotClaim[] {
  if (
    !isRecord(projection) ||
    !isRecord(projection.claims) ||
    !isRecord(projection.activeClaimIdsByRef)
  ) {
    throw new Error('root claim projection is malformed');
  }
  const selected: SelectedChecklistSnapshotClaim[] = [];
  const seenIds = new Set<string>();
  for (const [claimRef, claimIdValue] of Object.entries(projection.activeClaimIdsByRef)) {
    if (!Object.prototype.hasOwnProperty.call(CHECKLIST_SNAPSHOT_CLAIMS, claimRef)) {
      const foreignCandidate =
        typeof claimIdValue === 'string' ? projection.claims[claimIdValue] : undefined;
      if (
        isRecord(foreignCandidate) &&
        Object.prototype.hasOwnProperty.call(CHECKLIST_SNAPSHOT_CLAIMS, foreignCandidate.claim)
      ) {
        throw new Error(
          `active root checklist claim reference ${claimRef} does not match its supported claim`
        );
      }
      continue;
    }
    const claimId = requireClaimId(claimIdValue, `active root ${claimRef} claim ID`);
    if (seenIds.has(claimId)) throw new Error(`duplicate active root checklist claim ${claimId}`);
    seenIds.add(claimId);
    const candidate = projection.claims[claimId];
    if (!isRecord(candidate))
      throw new Error(`active root ${claimRef} claim is missing from claims`);
    if (candidate.claim !== claimRef)
      throw new Error(`active root ${claimRef} claim reference does not match its record`);
    if (claimRef !== 'proof.checklist.snapshot@1') {
      throw new Error(`root ${claimRef} claim is foreign to the root bootstrap stage`);
    }
    selected.push({
      claim: validateRootBootstrapCandidate(candidate, claimId),
      stage: 'bootstrap',
    });
  }
  return selected;
}

function activeExpandedChecklistClaims(projection: unknown): SelectedChecklistSnapshotClaim[] {
  if (!isRecord(projection) || !isRecord(projection.claimsById)) {
    throw new Error('expanded instance projection is malformed');
  }
  const authorityClaimIds = new Set(
    Object.entries(projection.claimsById)
      .filter(([, candidate]) => isRecord(candidate) && candidate.active === true && candidate.claim === 'native.continuation.catalog@1')
      .map(([claimId]) => claimId),
  );
  const selected: SelectedChecklistSnapshotClaim[] = [];
  const seenByStage = new Set<string>();
  for (const [claimIdKey, candidateValue] of Object.entries(projection.claimsById)) {
    if (!isRecord(candidateValue) || candidateValue.active !== true) continue;
    const claim = optionalString(candidateValue.claim);
    const stage =
      claim === 'proof.checklist.research-snapshot@1'
        ? 'research'
        : claim === 'proof.checklist.skeleton-snapshot@1'
          ? 'skeleton'
          : claim === 'native.continuation.checklist_snapshot@1'
            ? 'continuation'
          : undefined;
    if (!stage && claim === 'proof.checklist.snapshot@1') {
      throw new Error('expanded checklist bootstrap claim is foreign to the root stage');
    }
    if (!stage) continue;
    const claimId = requireClaimId(claimIdKey, `active expanded ${stage} claim ID`);
    const candidate = validateExpandedStageCandidate(candidateValue, claimId, stage, authorityClaimIds);
    if (seenByStage.has(stage))
      throw new Error(`duplicate active expanded checklist ${stage} claim`);
    seenByStage.add(stage);
    selected.push({ claim: candidate, stage });
  }
  return selected;
}

const NATIVE_CONTINUATION_STEPS = ['skeleton', 'traces-light', 'variables', 'spec-review-1'] as const;
type NativeContinuationStep = (typeof NATIVE_CONTINUATION_STEPS)[number];

function completedChecklistContinuationGeneration(
  projection: unknown,
  anchor: Json,
  anchorScope: readonly Json[],
  step: NativeContinuationStep,
): string {
  if (!isRecord(projection) || !isRecord(projection.generationsById) ||
      !isRecord(projection.activeGenerationIdByNode)) {
    throw new Error('current Proof readback requires an instance generation projection');
  }
  const activeGenerationIds = new Set(
    Object.values(projection.activeGenerationIdByNode).filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    ),
  );
  const activeGenerations = Object.entries(projection.generationsById)
    .filter(([generationId, value]) =>
      activeGenerationIds.has(generationId) && isRecord(value) &&
      optionalString(value.checkId) === `checklist-${step}`,
    )
    .map(([generationId, value]) => ({generationId, generation: value as Json}));
  if (activeGenerations.length !== 1) {
    throw new Error(`current Proof readback requires exactly one active ${step} generation`);
  }
  const selected = activeGenerations[0];
  if (selected.generation.status !== 'completed') {
    throw new Error(`current Proof readback requires a completed ${step} generation`);
  }
  validateProjectScope(selected.generation.scope, `current ${step} generation scope`);
  if (canonicalJson(selected.generation.scope) !== canonicalJson(anchorScope)) {
    throw new Error(`current ${step} generation scope does not match the continuation anchor`);
  }
  if (selected.generation.nodeGenerationId !== selected.generationId) {
    throw new Error(`current ${step} generation ID does not match its projection key`);
  }
  const anchorParents = stringArray(anchor.parentClaimIds, 'continuation anchor parentClaimIds');
  const generationInputs = stringArray(
    selected.generation.activeInputClaimIds,
    `current ${step} generation activeInputClaimIds`,
  );
  const sortIds = (ids: readonly string[]) =>
    [...ids].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  if (canonicalJson(sortIds(generationInputs)) !== canonicalJson(sortIds(anchorParents))) {
    throw new Error(`current ${step} generation inputs do not match the continuation anchor`);
  }
  return selected.generationId;
}

function validateCurrentProofReadback(
  readback: unknown,
  anchor: Json,
  instanceProjection: unknown,
): {snapshot: Json; generationId: string} {
  if (!isRecord(readback)) throw new Error('current Proof checklist readback must be an object');
  if (!isRecord(anchor.payload)) throw new Error('continuation anchor payload must be an object');
  const anchorSnapshot = anchor.payload;
  // Validate both snapshots before comparing the lineage identity fields. This
  // keeps malformed/external bytes from being treated as a current Proof view.
  snapshotSteps(anchorSnapshot);
  snapshotSteps(readback);
  for (const field of ['schema_version', 'checklist', 'active', 'new_project'] as const) {
    if (
      (field === 'schema_version' || field === 'checklist') &&
      (typeof anchorSnapshot[field] !== 'string' || typeof readback[field] !== 'string')
    ) {
      throw new Error(`current Proof checklist readback ${field} is malformed`);
    }
    if (
      (field === 'active' || field === 'new_project') &&
      (typeof anchorSnapshot[field] !== 'boolean' || typeof readback[field] !== 'boolean')
    ) {
      throw new Error(`current Proof checklist readback ${field} is malformed`);
    }
    if (canonicalJson(readback[field]) !== canonicalJson(anchorSnapshot[field])) {
      throw new Error(`current Proof checklist readback ${field} does not match the continuation anchor`);
    }
  }
  const anchorScope = validateProjectScope(anchor.scope, 'continuation anchor scope');
  const projectKey = requiredString(anchorScope[0].key, 'continuation anchor project key');
  const activeGenerationIds = new Set(
    isRecord(instanceProjection) && isRecord(instanceProjection.activeGenerationIdByNode)
      ? Object.values(instanceProjection.activeGenerationIdByNode).filter(
        (value): value is string => typeof value === 'string' && value.length > 0,
      )
      : [],
  );
  const completedSteps = NATIVE_CONTINUATION_STEPS.filter(step => {
    if (!isRecord(instanceProjection) || !isRecord(instanceProjection.generationsById)) return false;
    const matches = Object.entries(instanceProjection.generationsById).filter(([generationId, value]) =>
      activeGenerationIds.has(generationId) && isRecord(value) &&
      value.checkId === `checklist-${step}`,
    );
    return matches.length === 1 && isRecord(matches[0][1]) && matches[0][1].status === 'completed';
  });
  if (completedSteps.length !== 1) {
    const activePendingStep = NATIVE_CONTINUATION_STEPS.find(step => {
      if (!isRecord(instanceProjection) || !isRecord(instanceProjection.generationsById)) return false;
      const matches = Object.entries(instanceProjection.generationsById).filter(([generationId, value]) =>
        activeGenerationIds.has(generationId) && isRecord(value) && value.checkId === `checklist-${step}`,
      );
      return matches.length === 1 && isRecord(matches[0][1]) && matches[0][1].status !== 'completed';
    });
    if (activePendingStep) {
      throw new Error(`current Proof readback requires a completed ${activePendingStep} generation`);
    }
    throw new Error('current Proof readback requires exactly one active completed skeleton, traces-light, variables, or spec-review-1 generation');
  }
  const step = completedSteps[0];
  const rows = snapshotSteps(readback).filter(row => row.step_id === step);
  if (rows.length !== 1) {
    throw new Error(`current Proof checklist readback must contain exactly one ${step} row`);
  }
  const selected = rows[0];
  const expectedChecks = step === 'skeleton'
    ? ['l0_stakeholder_complete', 'l1_system_complete', 'l2_software_complete', 'levels_connected']
    : step === 'traces-light'
      ? ['annotation_validity', 'orphan_code_clean']
      : step === 'variables'
        ? ['variable_orphans_clean', 'variables_declared', 'variable_drift']
        : [
          'spec_lint_decomposition_adds_refinement',
          'spec_lint_formalization_quality',
          'solver_modeling_opportunity',
          'under_modeled_requirements_clean',
        ];
  const expectedRequires = step === 'skeleton'
    ? ['research']
    : step === 'traces-light'
      ? ['skeleton']
      : step === 'variables'
        ? ['traces-light']
        : ['variables'];
  const expectedScope = step === 'traces-light' ? 'package' : 'repo';
  const expectedRole = step === 'spec-review-1' ? 'spec-review' : 'onboard';
  const requiredChecks = stringArray(
    selected.required_checks,
    `current ${step} required_checks`,
  );
  const checkResults = objectArray(
    selected.check_results,
    `current ${step} check_results`,
  );
  if (
    selected.applicable !== true ||
    selected.role !== expectedRole ||
    selected.stamp !== 'confirm' ||
    selected.scope !== expectedScope ||
    canonicalJson(stringArray(selected.requires, `current ${step} requires`)) !== canonicalJson(expectedRequires) ||
    canonicalJson(requiredChecks) !== canonicalJson(expectedChecks) ||
    selected.stored_status !== 'confirmed' ||
    selected.effective_status !== 'confirmed' ||
    checkResults.length !== requiredChecks.length ||
    !requiredChecksPass(selected) ||
    (step === 'traces-light' && selected.scope_key !== projectKey) ||
    (step !== 'traces-light' && selected.scope_key !== undefined)
  ) {
    const evidenceScope = step === 'skeleton'
      ? 'repository skeleton'
      : step === 'traces-light'
        ? 'package'
        : step === 'variables'
          ? 'repository variables'
          : 'repository spec-review-1';
    throw new Error(`current Proof checklist readback lacks exact confirmed ${evidenceScope} evidence`);
  }
  const generationId = requiredString(
    completedChecklistContinuationGeneration(instanceProjection, anchor, anchorScope, step),
    `current ${step} generation ID`,
  );
  return {snapshot: readback, generationId};
}

/**
 * Select the latest lineage-consistent Proof checklist snapshot from the two
 * journal projections. Root ClaimProjection owns bootstrap; expanded
 * InstanceProjection owns research/skeleton. All renderers consume the one
 * resulting canonical projection, so they cannot disagree about stage source.
 */
export type NativeChecklistProjectionInput = Readonly<{
  claimProjection: ClaimProjection | unknown;
  instanceProjection: InstanceProjection | unknown;
  checkpoint?: unknown;
  checkpointTimestamp?: unknown;
  paused?: boolean;
  resumed?: boolean;
  retainedCatalogComponentIds?: readonly string[];
  affectedComponentIds?: readonly string[];
  /** Current Proof `checklist show` bytes, bound to the completed selected continuation run. */
  currentProofSnapshot?: unknown;
  expansionPlan?: ExpansionPlan | unknown;
  currentProofInputs?: unknown;
  proofCatalogDrift?: unknown;
}>;

const MILESTONE_B_COMPONENT_SUMMARY_CLAIM = 'native.component.summary@1';
const MILESTONE_B_COMPONENT_FAN_IN_CHECK = 'wait-for-native-items';

type MilestoneBChecklistBundle = Readonly<{
  claimId: string;
  componentId: string;
  snapshot: Json;
}>;

function activeCompletedMilestoneBChecklistBundles(
  projection: unknown,
): MilestoneBChecklistBundle[] {
  if (!isRecord(projection) || !isRecord(projection.claimsById) ||
      !isRecord(projection.generationsById) || !isRecord(projection.activeGenerationIdByNode)) {
    throw new Error('Milestone B checklist projection is malformed');
  }
  const activeGenerationIds = new Set(
    Object.values(projection.activeGenerationIdByNode).filter(
      (value): value is string => typeof value === 'string' && value.length > 0,
    ),
  );
  const bundles: MilestoneBChecklistBundle[] = [];
  for (const [claimIdKey, value] of Object.entries(projection.claimsById)) {
    if (!isRecord(value) || value.active !== true || value.claim !== MILESTONE_B_COMPONENT_SUMMARY_CLAIM) {
      continue;
    }
    const claimId = requireClaimId(value.claimId ?? claimIdKey, 'Milestone B component summary claim ID');
    validateCandidateShape(value, claimId, 'Milestone B component summary claim');
    if (value.producerCheckId !== MILESTONE_B_COMPONENT_FAN_IN_CHECK) {
      throw new Error('Milestone B component summary claim has an invalid producer');
    }
    const claimSubgraphInstanceId = requireClaimId(
      value.subgraphInstanceId,
      'Milestone B component summary subgraph instance ID',
    );
    const generationId = requiredString(value.nodeGenerationId, 'Milestone B component summary generation ID');
    if (!activeGenerationIds.has(generationId)) {
      throw new Error('Milestone B component summary claim is not bound to an active generation');
    }
    const generation = projection.generationsById[generationId];
    if (!isRecord(generation) || generation.nodeGenerationId !== generationId ||
        generation.checkId !== MILESTONE_B_COMPONENT_FAN_IN_CHECK ||
        generation.status !== 'completed') {
      throw new Error('Milestone B component summary claim is not bound to a completed fan-in generation');
    }
    if (generation.subgraphInstanceId !== claimSubgraphInstanceId) {
      throw new Error('Milestone B component summary claim subgraph instance is detached from its generation');
    }
    if (!isRecord(value.payload)) {
      throw new Error('Milestone B component summary claim payload must be an object');
    }
    const payload = value.payload;
    if (!hasExactKeys(payload, ['component', 'freshness', 'validation', 'audit', 'checklist', 'status'])) {
      throw new Error('Milestone B component summary payload has an unexpected shape');
    }
    const componentId = requiredString(payload.component, 'Milestone B component summary component');
    if (!Array.isArray(payload.freshness) || !isRecord(payload.validation) ||
        !isRecord(payload.audit) || !isRecord(payload.status) || !isRecord(payload.checklist)) {
      throw new Error(`Milestone B component summary ${componentId} is malformed`);
    }
    const checklist = payload.checklist;
    if (!hasExactKeys(checklist, ['exit_code', 'value']) || checklist.exit_code !== 0 ||
        !isRecord(checklist.value) || checklist.value.schema_version !== 'proof.checklist.show.v1') {
      throw new Error(`Milestone B component summary ${componentId} has no successful Proof checklist snapshot`);
    }
    if (!Array.isArray(value.scope) || value.scope.length !== 1 ||
        !isRecord(value.scope[0]) || value.scope[0].kind !== 'keyed' ||
        value.scope[0].key !== componentId ||
        value.scope[0].expansionOwnerCheck !== 'discover-native-components' ||
        typeof value.scope[0].subgraphInstanceId !== 'string' ||
        !/^[0-9a-f]{64}$/.test(value.scope[0].subgraphInstanceId) ||
        !hasExactKeys(value.scope[0], ['kind', 'expansionOwnerCheck', 'key', 'subgraphInstanceId'])) {
      throw new Error(`Milestone B component summary ${componentId} scope is detached from its claim`);
    }
    if (value.scope[0].subgraphInstanceId !== claimSubgraphInstanceId) {
      throw new Error(`Milestone B component summary ${componentId} scope is detached from its subgraph`);
    }
    if (canonicalJson(generation.scope) !== canonicalJson(value.scope) ||
        !isRecord(generation.scope?.[0]) ||
        generation.scope[0].subgraphInstanceId !== value.scope[0].subgraphInstanceId) {
      throw new Error(`Milestone B component summary ${componentId} generation scope is detached from its claim`);
    }
    if (checklist.value.checklist !== 'onboard_v1' ||
        typeof checklist.value.active !== 'boolean' ||
        typeof checklist.value.new_project !== 'boolean') {
      throw new Error(`Milestone B component summary ${componentId} has the wrong Proof checklist identity`);
    }
    bundles.push({claimId, componentId, snapshot: checklist.value});
  }
  if (!bundles.length) {
    throw new Error('Milestone B journal has no active completed component fan-in checklist summary');
  }
  const byComponent = new Map<string, MilestoneBChecklistBundle>();
  for (const bundle of bundles) {
    if (byComponent.has(bundle.componentId)) {
      throw new Error(`Milestone B journal has duplicate active component fan-in summary for ${bundle.componentId}`);
    }
    byComponent.set(bundle.componentId, bundle);
  }
  const first = bundles[0].snapshot;
  for (const bundle of bundles.slice(1)) {
    if (canonicalJson(bundle.snapshot) !== canonicalJson(first)) {
      throw new Error('Milestone B component fan-in checklist snapshots diverge');
    }
  }
  return [...byComponent.values()].sort((left, right) =>
    Buffer.from(left.componentId).compare(Buffer.from(right.componentId)) ||
    Buffer.from(left.claimId).compare(Buffer.from(right.claimId)),
  );
}

/**
 * Project Milestone B progress from the journaled component fan-in summaries.
 * No live Proof readback or root checklist fallback is permitted here: a
 * summary is usable only when its active claim is bound to the active,
 * completed `wait-for-native-items` generation.
 */
export type NativeMilestoneBChecklistProjectionInput = Readonly<{
  instanceProjection: InstanceProjection | unknown;
  checkpoint?: unknown;
  checkpointTimestamp?: unknown;
  paused?: boolean;
  resumed?: boolean;
  retainedCatalogComponentIds?: readonly string[];
  affectedComponentIds?: readonly string[];
  expansionPlan?: ExpansionPlan | unknown;
  currentProofInputs?: unknown;
  proofCatalogDrift?: unknown;
}>;

export function buildNativeChecklistProgressFromMilestoneBProjections(
  input: NativeMilestoneBChecklistProjectionInput,
): NativeChecklistProgress {
  const bundles = activeCompletedMilestoneBChecklistBundles(input.instanceProjection);
  const selected = bundles[0];
  return buildNativeChecklistProgress({
    proofSnapshot: selected.snapshot,
    proofSnapshotEvidence: {
      source: 'native.component.summary@1',
      claimIds: bundles.map(bundle => bundle.claimId),
      componentIds: bundles.map(bundle => bundle.componentId),
    },
    instanceProjection: input.instanceProjection,
    checkpoint: input.checkpoint,
    checkpointTimestamp: input.checkpointTimestamp,
    requireProofSnapshotClaim: true,
    paused: input.paused,
    resumed: input.resumed,
    retainedCatalogComponentIds: input.retainedCatalogComponentIds,
    affectedComponentIds: input.affectedComponentIds,
    expansionPlan: input.expansionPlan,
    currentProofInputs: input.currentProofInputs,
    proofCatalogDrift: input.proofCatalogDrift,
  });
}

export function buildNativeChecklistProgressFromProjections(
  input: NativeChecklistProjectionInput
): NativeChecklistProgress {
  const candidates = [
    ...activeRootChecklistClaims(input.claimProjection),
    ...activeExpandedChecklistClaims(input.instanceProjection),
  ];
  const bootstrap = candidates.find(candidate => candidate.stage === 'bootstrap');
  const research = candidates.find(candidate => candidate.stage === 'research');
  const skeleton = candidates.find(candidate => candidate.stage === 'skeleton');
  const continuation = candidates.find(candidate => candidate.stage === 'continuation');
  if (!bootstrap && !continuation) {
    throw new Error('active expanded checklist stage requires an active root bootstrap claim');
  }
  if (skeleton) {
    const skeletonScope = skeleton.claim.scope;
    if (!research) {
      throw new Error('active skeleton checklist claim requires an active research claim');
    }
    const researchId = research.claim.claimId;
    if (
      skeleton.claim.parentClaimIds.length !== 1 ||
      skeleton.claim.parentClaimIds[0] !== researchId ||
      canonicalJson(skeletonScope) !== canonicalJson(research.claim.scope)
    ) {
      throw new Error(
        'active skeleton checklist claim must name the active research parent at the same scope'
      );
    }
  }
  const selected = continuation ?? skeleton ?? research ?? bootstrap;
  if (!selected) throw new Error('no active supported Proof checklist snapshot claim was found');
  let proofSnapshot = selected.claim.payload;
  let proofSnapshotClaim: unknown = selected.claim;
  let proofSnapshotReadback: NativeChecklistProgressInput['proofSnapshotReadback'];
  if (input.currentProofSnapshot !== undefined) {
    if (!continuation) {
      throw new Error('current Proof checklist readback requires an active continuation anchor');
    }
    const current = validateCurrentProofReadback(
      input.currentProofSnapshot,
      continuation.claim,
      input.instanceProjection,
    );
    proofSnapshot = current.snapshot;
    proofSnapshotClaim = undefined;
    proofSnapshotReadback = {
      anchorClaimId: requireClaimId(continuation.claim.claimId, 'continuation anchor claim ID'),
      generationId: current.generationId,
    };
  }
  return buildNativeChecklistProgress({
    proofSnapshot,
    proofSnapshotClaim,
    proofSnapshotReadback,
    instanceProjection: input.instanceProjection,
    checkpoint: input.checkpoint,
    checkpointTimestamp: input.checkpointTimestamp,
    requireProofSnapshotClaim: true,
    paused: input.paused,
    resumed: input.resumed,
    retainedCatalogComponentIds: input.retainedCatalogComponentIds,
    affectedComponentIds: input.affectedComponentIds,
    expansionPlan: input.expansionPlan,
    currentProofInputs: input.currentProofInputs,
    proofCatalogDrift: input.proofCatalogDrift,
  });
}

function checkpointEvidence(
  checkpoint: unknown,
  checkpointTimestamp: unknown,
  instanceProjection?: unknown,
): NativeChecklistProgress['evidence']['journal'] {
  if (checkpoint === undefined) {
    if (checkpointTimestamp !== undefined)
      throw new Error('checkpoint timestamp requires a checkpoint');
    return { checkpoint_present: false };
  }
  if (!isRecord(checkpoint)) throw new Error('checkpoint must be an object');
  const frontier = isRecord(checkpoint.frontier) ? checkpoint.frontier : undefined;
  const eventCount = frontier?.eventCount;
  const lastEventId = frontier?.lastEventId;
  if (
    eventCount !== undefined &&
    (typeof eventCount !== 'number' || !Number.isSafeInteger(eventCount) || eventCount < 0)
  ) {
    throw new Error('checkpoint frontier.eventCount must be a non-negative integer');
  }
  if (
    lastEventId !== undefined &&
    (typeof lastEventId !== 'number' || !Number.isSafeInteger(lastEventId) || lastEventId < 0)
  ) {
    throw new Error('checkpoint frontier.lastEventId must be a non-negative integer');
  }
  if (eventCount !== undefined && lastEventId !== undefined && eventCount !== lastEventId) {
    throw new Error('checkpoint frontier eventCount and lastEventId must agree');
  }
  if (
    Array.isArray(checkpoint.events) &&
    eventCount !== undefined &&
    checkpoint.events.length !== eventCount
  ) {
    throw new Error('checkpoint frontier.eventCount must match its event prefix');
  }
  const integrity = isRecord(checkpoint.integrity) ? checkpoint.integrity : undefined;
  const graphDigest =
    optionalString(checkpoint.graphSemanticDigest) ??
    optionalString(checkpoint.graph_semantic_digest);
  const timestamp =
    checkpointTimestamp ?? checkpoint.checkpointTimestamp ?? checkpoint.checkpoint_timestamp;
  if (timestamp !== undefined && (typeof timestamp !== 'string' || !isRFC3339(timestamp))) {
    throw new Error('checkpoint timestamp must be an RFC3339 timestamp');
  }
  const projectionEventId = isRecord(instanceProjection) && typeof instanceProjection.lastEventId === 'number' && Number.isSafeInteger(instanceProjection.lastEventId)
    ? instanceProjection.lastEventId
    : undefined;
  const checkpointEventId = typeof lastEventId === 'number' ? lastEventId : undefined;
  const provenance = projectionEventId === undefined || checkpointEventId === undefined
    ? undefined
    : projectionEventId === checkpointEventId
      ? 'checkpoint' as const
      : projectionEventId > checkpointEventId
        ? 'live_projection' as const
        : undefined;
  return {
    checkpoint_present: true,
    ...(optionalString(checkpoint.sessionId) ? { session_id: checkpoint.sessionId as string } : {}),
    ...(typeof eventCount === 'number' ? { event_count: eventCount } : {}),
    ...(typeof lastEventId === 'number' ? { last_event_id: lastEventId } : {}),
    ...(graphDigest ? { graph_semantic_digest: graphDigest } : {}),
    ...(optionalString(integrity?.digest) ? { integrity_digest: integrity!.digest as string } : {}),
    ...(typeof timestamp === 'string' ? { checkpoint_timestamp: timestamp } : {}),
    ...(provenance ? { provenance } : {}),
    ...(provenance === 'live_projection' && checkpointEventId !== undefined
      ? { durable_through_event_id: checkpointEventId }
      : {}),
  };
}

function keyedScope(scope: unknown): string[] {
  if (!Array.isArray(scope)) return [];
  return scope.flatMap(part =>
    isRecord(part) && part.kind === 'keyed' && typeof part.key === 'string' && part.key.length > 0
      ? [part.key]
      : []
  );
}

function terminalExpansionOwner(value: unknown): string | undefined {
  const raw = optionalString(value);
  if (!raw) return undefined;
  try {
    const decoded = JSON.parse(raw) as unknown;
    if (Array.isArray(decoded)) {
      const terminal = decoded.at(-1);
      return typeof terminal === 'string' ? terminal : undefined;
    }
  } catch {
    // Scalar owner names are the original graph representation.
  }
  return raw;
}

type ComponentScopeContext = Readonly<{
  componentId: string;
  componentScopeKey: string;
}>;

function componentScopeContext(scope: unknown): ComponentScopeContext | undefined {
  if (!Array.isArray(scope)) return undefined;
  const parts = scope.filter(isRecord);
  if (parts.length !== scope.length) return undefined;
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index];
    if (
      terminalExpansionOwner(part.expansionOwnerCheck) === 'enumerate-native-components' &&
      typeof part.key === 'string' &&
      part.key.length > 0
    ) {
      return {
        componentId: part.key,
        componentScopeKey: canonicalJson(parts.slice(0, index + 1)),
      };
    }
  }
  return undefined;
}

type BatchScopeContext = Readonly<{
  componentId: string;
  componentScopeKey: string;
  batchId: string;
  batchScopeKey: string;
}>;

/**
 * Batch claims are only authoritative inside the compiled native component
 * expansion.  In particular, a similarly named batch in another generation
 * must not be allowed to satisfy this projection.
 */
function batchScopeContext(scope: unknown): BatchScopeContext | undefined {
  if (!Array.isArray(scope)) return undefined;
  const parts = scope.filter(isRecord);
  if (parts.length !== scope.length) return undefined;
  let componentIndex = -1;
  let batchIndex = -1;
  for (let index = parts.length - 1; index >= 0; index--) {
    const owner = parts[index].expansionOwnerCheck;
    let decoded: unknown = owner;
    if (typeof owner === 'string') {
      try { decoded = JSON.parse(owner); } catch { /* scalar owner */ }
    }
    if (Array.isArray(decoded) && canonicalJson(decoded) === canonicalJson(['native-component', 'enumerate-native-batches'])) {
      if (batchIndex !== -1) return undefined;
      batchIndex = index;
      continue;
    }
    if (terminalExpansionOwner(owner) === 'enumerate-native-components') {
      if (componentIndex !== -1) return undefined;
      componentIndex = index;
    }
  }
  if (componentIndex < 0 || batchIndex <= componentIndex) return undefined;
  const component = parts[componentIndex];
  const batch = parts[batchIndex];
  if (component.kind !== 'keyed' || typeof component.key !== 'string' || component.key.length === 0 ||
      batch.kind !== 'keyed' || typeof batch.key !== 'string' || batch.key.length === 0) return undefined;
  return {
    componentId: component.key,
    componentScopeKey: canonicalJson(parts.slice(0, componentIndex + 1)),
    batchId: batch.key,
    batchScopeKey: canonicalJson(parts.slice(0, batchIndex + 1)),
  };
}

function operationalState(statuses: readonly string[]): NativeChecklistOperationalState {
  if (statuses.length === 0) return 'unknown';
  if (statuses.includes('unknown')) return 'unknown';
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('running')) return 'running';
  if (statuses.every(status => status === 'completed')) return 'completed';
  if (statuses.some(status => status === 'ready' || status === 'pending')) return 'pending';
  return 'unknown';
}

type OperationalItem = Readonly<{
  id: string;
  status: string;
  checkId?: string;
  kind?: OperationalKind;
  componentId?: string;
  componentScopeKey?: string;
  batchScopeKey?: string;
  outputComponentId?: string;
  batchId?: string;
  receiptDecision?: 'approved' | 'needs_changes' | 'unreviewed' | 'unknown';
  receiptClaimId?: string;
  condition?: NativeChecklistOperationalCondition;
  /** A condition-only row must not override an authoritative execution row. */
  conditionOnly?: boolean;
}>;

function conditionKey(condition: NativeChecklistOperationalCondition): string {
  return canonicalJson(condition);
}

function collection(
  items: readonly OperationalItem[],
  known: boolean,
  unexpandedCount = 0,
  includeReceiptDecisions = false,
): NativeChecklistOperationalCollection {
  const grouped = new Map<string, { statuses: string[]; checks: string[]; conditions: NativeChecklistOperationalCondition[]; metadata?: OperationalItem }>();
  for (const item of items) {
    const group = grouped.get(item.id) ?? { statuses: [], checks: [], conditions: [] };
    if (!item.conditionOnly) group.statuses.push(item.status);
    if (item.checkId && !group.checks.includes(item.checkId)) group.checks.push(item.checkId);
    if (item.condition && !group.conditions.some(existing => conditionKey(existing) === conditionKey(item.condition!))) {
      group.conditions.push(item.condition);
    }
    if (!group.metadata && (item.outputComponentId || item.batchId || item.receiptDecision || item.receiptClaimId)) {
      group.metadata = item;
    }
    grouped.set(item.id, group);
  }
  const output = [...grouped.entries()]
    .sort(([a], [b]) => Buffer.from(a).compare(Buffer.from(b)))
    .map(([id, group]) => {
      const conditions = group.conditions.sort((a, b) => Buffer.from(conditionKey(a)).compare(Buffer.from(conditionKey(b))));
      const metadata = group.metadata;
      return {
        id,
        state: operationalState(group.statuses),
        check_ids: group.checks.sort((a, b) => Buffer.from(a).compare(Buffer.from(b))),
        ...(metadata?.outputComponentId ? {component_id: metadata.outputComponentId} : {}),
        ...(metadata?.batchId ? {batch_id: metadata.batchId} : {}),
        ...(metadata?.receiptDecision ? {receipt_decision: metadata.receiptDecision} : {}),
        ...(metadata?.receiptClaimId ? {receipt_claim_id: metadata.receiptClaimId} : {}),
        ...(conditions.length ? {conditions, condition: conditions[0]} : {}),
      };
    });
  const count = (state: NativeChecklistOperationalState) =>
    output.filter(item => item.state === state).length;
  const conditionCount = (state: NativeChecklistOperationalCondition['state']) =>
    output.filter(item => item.conditions?.some(condition => condition.state === state)).length;
  const receiptDecisions = includeReceiptDecisions
    ? {
      approved: output.filter(item => item.receipt_decision === 'approved').length,
      needs_changes: output.filter(item => item.receipt_decision === 'needs_changes').length,
      unreviewed: output.filter(item => item.receipt_decision === 'unreviewed').length,
      unknown: output.filter(item => item.receipt_decision === 'unknown').length,
    }
    : undefined;
  return {
    known,
    known_count: output.length,
    completed_count: count('completed'),
    running_count: count('running'),
    failed_count: count('failed'),
    pending_count: count('pending'),
    unknown_count: count('unknown'),
    unexpanded_count: unexpandedCount,
    blocked_count: conditionCount('blocked'),
    stale_count: conditionCount('stale'),
    ...(receiptDecisions ? {receipt_decisions: receiptDecisions} : {}),
    items: output,
  };
}

type OperationalProjectionResult = Readonly<{
  value: NativeChecklistProgress['operational'];
  unknown: readonly string[];
}>;

function catalogCoverage(
  retainedCatalogComponentIds: readonly string[] | undefined,
  affectedComponentIds: readonly string[] | undefined,
): NativeChecklistCatalogCoverage {
  if (retainedCatalogComponentIds === undefined) {
    return {
      known: false,
      known_count: 0,
      affected_count: 0,
      reused_count: 0,
      unexpanded_count: 1,
      items: [],
    };
  }
  const known = [...new Set(retainedCatalogComponentIds.filter(id => id.length > 0))]
    .sort((a, b) => Buffer.from(a).compare(Buffer.from(b)));
  const affected = new Set((affectedComponentIds ?? []).filter(id => known.includes(id)));
  const items = known.map(id => ({
    id,
    disposition: affected.has(id) ? 'affected' as const : 'reused' as const,
  }));
  return {
    known: true,
    known_count: known.length,
    affected_count: affected.size,
    reused_count: known.length - affected.size,
    unexpanded_count: 0,
    items,
  };
}

type OperationalKind = 'project' | 'component' | 'specification' | 'batch';

const SHA256_DIGEST = /^sha256:[0-9a-f]{64}$/;

type NativeProofInputTuple = Readonly<{
  id: string;
  componentId: string;
  filePath: string;
  proofFileHash: string;
}>;

function digest(value: unknown): value is string {
  return typeof value === 'string' && SHA256_DIGEST.test(value);
}

function tupleField(value: Json, ...keys: string[]): unknown {
  for (const key of keys) if (Object.prototype.hasOwnProperty.call(value, key)) return value[key];
  return undefined;
}

function normalizeProofTuple(value: unknown, label: string): NativeProofInputTuple {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const nested = isRecord(value.requirement) ? value.requirement : value;
  const id = tupleField(nested, 'id', 'requirement_id');
  const componentId = tupleField(nested, 'component_id', 'componentId', 'component');
  const filePath = tupleField(value, 'file_path', 'filePath') ?? tupleField(nested, 'file_path', 'filePath');
  const proofFileHash = tupleField(nested, 'proof_file_hash', 'proofFileHash', 'file_hash', 'fileHash');
  if (typeof id !== 'string' || !id || typeof componentId !== 'string' || !componentId ||
      typeof filePath !== 'string' || !filePath || !digest(proofFileHash)) {
    throw new Error(`${label} is not a complete Proof req-list/req-show tuple`);
  }
  return {id, componentId, filePath, proofFileHash};
}

function currentProofTuples(value: unknown): NativeProofInputTuple[] | undefined {
  if (value === undefined) return undefined;
  let source: unknown = value;
  if (isRecord(value)) {
    source = value.items ?? value.requirements ?? value.rows ?? value.req_list ?? value.reqList ?? value.current;
    if (source === undefined && (value.id !== undefined || value.requirement !== undefined)) source = [value];
  }
  if (!Array.isArray(source)) throw new Error('current Proof inputs must be an array of req-list/req-show tuples');
  const tuples = source.map((item, index) => normalizeProofTuple(item, `current Proof input ${index}`));
  const identities = new Set<string>();
  const ids = new Set<string>();
  for (const tuple of tuples) {
    const identity = `${tuple.id}\0${tuple.componentId}\0${tuple.filePath}`;
    if (identities.has(identity) || ids.has(tuple.id)) throw new Error(`current Proof inputs contain a duplicate tuple for ${tuple.id}`);
    identities.add(identity);
    ids.add(tuple.id);
  }
  return tuples;
}

function projectionGraphDigest(projection: unknown): string | undefined {
  return isRecord(projection) && typeof projection.graphSemanticDigest === 'string'
    ? projection.graphSemanticDigest
    : undefined;
}

function checkpointGraphDigest(checkpoint: unknown): string | undefined {
  return isRecord(checkpoint)
    ? optionalString(checkpoint.graphSemanticDigest) ?? optionalString(checkpoint.graph_semantic_digest)
    : undefined;
}

function expansionAuthority(
  plan: unknown,
  projection: unknown,
  checkpoint: unknown,
): {valid: boolean; reason?: string} {
  if (!plan) return {valid: false, reason: 'compiled expansion topology was not supplied'};
  if (!isRecord(plan) || typeof plan.graphSemanticDigest !== 'string' || !isRecord(plan.templatesByName)) {
    throw new Error('compiled expansion topology is malformed');
  }
  const expected = plan.graphSemanticDigest;
  const checkpointDigest = checkpointGraphDigest(checkpoint);
  if (checkpointDigest !== undefined && checkpointDigest !== expected) {
    return {valid: false, reason: 'checkpoint graph semantic digest does not match the compiled expansion topology'};
  }
  if (isRecord(projection)) {
    const projectionDigest = projectionGraphDigest(projection);
    if (projectionDigest !== undefined && projectionDigest !== expected) {
      return {valid: false, reason: 'instance projection graph semantic digest does not match the compiled expansion topology'};
    }
    if (isRecord(projection.instancesById)) {
      for (const instance of Object.values(projection.instancesById)) {
        if (isRecord(instance) && typeof instance.graphSemanticDigest === 'string' && instance.graphSemanticDigest !== expected) {
          return {valid: false, reason: 'active expansion instance graph semantic digest does not match the compiled expansion topology'};
        }
      }
    }
  }
  return {valid: true};
}

function templateForInstance(plan: Json, instance: Json): Json | undefined {
  const digestValue = instance.templateDigest;
  if (typeof digestValue !== 'string' || !isRecord(plan.templatesByName)) return undefined;
  return Object.values(plan.templatesByName).find(template =>
    isRecord(template) && template.templateDigest === digestValue,
  );
}

function conditionForDependency(
  target: Json,
  targetNode: Json,
  prerequisite: Json,
  targetStatus: 'waiting' | 'failed_dependency',
  source: 'dependency' | 'expansion_barrier',
): NativeChecklistOperationalCondition {
  const evidence: Json = {source, prerequisite_status: prerequisite.status};
  const optionalEvidence = [
    ['target_node_instance_id', target.nodeInstanceId],
    ['target_check_id', targetNode.templateNodeKey],
    ['prerequisite_node_instance_id', prerequisite.nodeInstanceId],
    ['prerequisite_check_id', prerequisite.templateNodeKey],
    ['prerequisite_generation_id', prerequisite.nodeGenerationId],
  ] as const;
  for (const [key, value] of optionalEvidence) if (typeof value === 'string') evidence[key] = value;
  return {
    state: 'blocked',
    kind: targetStatus,
    evidence,
  };
}

function nativeConditionEntries(
  planValue: unknown,
  projectionValue: unknown,
  checkpoint: unknown,
  currentInputsValue: unknown,
): {items: OperationalItem[]; unknown: string[]} {
  const authority = expansionAuthority(planValue, projectionValue, checkpoint);
  if (!authority.valid) return {items: [], unknown: [authority.reason || 'compiled expansion topology is unverifiable']};
  if (!isRecord(planValue) || !isRecord(projectionValue) || !isRecord(projectionValue.instancesById) ||
      !isRecord(projectionValue.nodesById) || !isRecord(projectionValue.activeGenerationIdByNode) ||
      !isRecord(projectionValue.generationsById)) {
    return {items: [], unknown: ['native operational conditions are unavailable from the instance projection']};
  }
  const currentInputs = currentProofTuples(currentInputsValue);
  const items: OperationalItem[] = [];
  const unknown: string[] = [];
  const activeGeneration = (nodeId: string): Json | undefined => {
    const generationId = projectionValue.activeGenerationIdByNode?.[nodeId];
    if (typeof generationId !== 'string') return undefined;
    const generation = projectionValue.generationsById?.[generationId];
    return isRecord(generation) && generation.status !== 'inactive' ? generation : undefined;
  };
  const nodeFor = (instance: Json, templateNodeKey: string): Json | undefined => {
    const nodeId = isRecord(instance.nodeInstanceIdsByTemplateNode) ? instance.nodeInstanceIdsByTemplateNode[templateNodeKey] : undefined;
    if (typeof nodeId !== 'string') return undefined;
    if (isRecord(projectionValue.nodesById?.[nodeId])) return projectionValue.nodesById[nodeId] as Json;
    // The instance mapping is authoritative for an expected node even when
    // its node projection has not materialized yet.  Carry only identity and
    // the exact owning scope; never invent a generation or execution state.
    return Array.isArray(instance.scope)
      ? {nodeInstanceId: nodeId, templateNodeKey, scope: instance.scope}
      : undefined;
  };
  const itemIdFor = (node: Json): string | undefined => {
    const scope = Array.isArray(node.scope) ? node.scope : [];
    const keyed = scope.filter(isRecord).filter(part => part.kind === 'keyed');
    const last = keyed[keyed.length - 1];
    return typeof last?.key === 'string' ? last.key : undefined;
  };
  const itemKindFor = (node: Json, checkId: string): OperationalKind => {
    const scope = Array.isArray(node.scope) ? node.scope.filter(isRecord) : [];
    const keyed = scope.filter(part => part.kind === 'keyed');
    const owner = keyed.length ? terminalExpansionOwner(keyed[keyed.length - 1].expansionOwnerCheck) : undefined;
    // The continuation project's fan-in target is an absent node in the
    // project instance.  Its exact compiled one-segment project scope is
    // authoritative; do not let the generic component fallback fabricate a
    // component with the project key.
    if (owner === 'project' || owner === 'native-project-dispatch' || owner === 'native-role-dispatch') return 'project';
    if (owner === 'discover-native-components' || owner === 'enumerate-native-components') return 'component';
    if (owner === 'enumerate-native-specs' || checkId === 'review-native-item' || checkId === 'collect-proof-evidence') return 'specification';
    if (owner === 'enumerate-native-batches') return 'batch';
    if (keyed.length > 3) return 'batch';
    return 'component';
  };
  const componentGenerationFor = (componentId: string): {generation: Json; node: Json} | undefined => {
    const candidates: Array<{generation: Json; node: Json; depth: number}> = [];
    for (const [nodeId, rawNode] of Object.entries(projectionValue.nodesById)) {
      if (!isRecord(rawNode)) continue;
      const scope = Array.isArray(rawNode.scope) ? rawNode.scope.filter(isRecord) : [];
      const keyed = scope.filter(part => part.kind === 'keyed');
      const componentPart = keyed.at(-1);
      const componentOwner = componentPart && terminalExpansionOwner(componentPart.expansionOwnerCheck);
      if (!componentPart || (componentOwner !== 'discover-native-components' && componentOwner !== 'enumerate-native-components') || componentPart.key !== componentId) continue;
      const generation = activeGeneration(nodeId);
      if (!generation) continue;
      candidates.push({generation, node: rawNode, depth: scope.length});
    }
    // A projection may retain a generation without a corresponding node entry;
    // its active binding and exact component-owned scope are still authoritative.
    for (const [generationId, rawGeneration] of Object.entries(projectionValue.generationsById)) {
      if (!isRecord(rawGeneration) || rawGeneration.status === 'inactive') continue;
      const nodeId = rawGeneration.nodeInstanceId;
      if (typeof nodeId !== 'string' || projectionValue.activeGenerationIdByNode[nodeId] !== generationId) continue;
      const scope = Array.isArray(rawGeneration.scope) ? rawGeneration.scope.filter(isRecord) : [];
      const keyed = scope.filter(part => part.kind === 'keyed');
      const componentPart = keyed.at(-1);
      const componentOwner = componentPart && terminalExpansionOwner(componentPart.expansionOwnerCheck);
      if (!componentPart || (componentOwner !== 'discover-native-components' && componentOwner !== 'enumerate-native-components') || componentPart.key !== componentId) continue;
      if (candidates.some(candidate => candidate.generation.nodeGenerationId === rawGeneration.nodeGenerationId)) continue;
      candidates.push({generation: rawGeneration, node: rawGeneration, depth: scope.length});
    }
    candidates.sort((left, right) => left.depth - right.depth || Buffer.from(String(left.generation.nodeGenerationId || '')).compare(Buffer.from(String(right.generation.nodeGenerationId || ''))));
    return candidates[0];
  };
  const add = (node: Json, condition: NativeChecklistOperationalCondition): void => {
    const id = itemIdFor(node);
    const checkId = optionalString(node.templateNodeKey) ?? optionalString(node.checkId);
    if (!id || !checkId) return;
    const kind = itemKindFor(node, checkId);
    const component = componentScopeContext(node.scope);
    items.push({
      id,
      status: 'pending',
      checkId,
      kind,
      ...(component ? {componentId: component.componentId, componentScopeKey: component.componentScopeKey} : {}),
      condition,
    });
  };
  const instances = Object.values(projectionValue.instancesById)
    .filter(isRecord)
    .filter(instance => instance.status === 'active')
    .sort((left, right) => Buffer.from(String(left.subgraphInstanceId || '')).compare(Buffer.from(String(right.subgraphInstanceId || ''))));
  for (const instance of instances) {
    const template = templateForInstance(planValue, instance);
    if (!template || !isRecord(template.nodesByKey) || !isRecord(instance.nodeInstanceIdsByTemplateNode)) continue;
    for (const [templateNodeKey, rawNode] of Object.entries(template.nodesByKey)) {
      if (!isRecord(rawNode) || !isRecord(rawNode.check)) continue;
      const node = nodeFor(instance, templateNodeKey);
      if (!node) continue;
      const active = activeGeneration(String(node.nodeInstanceId));
      if (active) continue; // A ready target is pending, never blocked.
      const check = rawNode.check;
      // Conditional/optional paths have no unconditional expected target and
      // therefore cannot supply blocker evidence from absence alone.
      if (['if', 'assume', 'forEach', 'for_each', 'optional'].some(key => Object.prototype.hasOwnProperty.call(check, key))) continue;
      const dependencies = Array.isArray(rawNode.dependencyNodeKeys)
        ? rawNode.dependencyNodeKeys.filter((value): value is string => typeof value === 'string')
        : [];
      const prerequisites = dependencies.map(key => nodeFor(instance, key)).filter((value): value is Json => value !== undefined);
      const failed = prerequisites.map(node => ({node, generation: activeGeneration(String(node.nodeInstanceId))})).find(value => value.generation?.status === 'failed');
      const waiting = prerequisites.map(node => ({node, generation: activeGeneration(String(node.nodeInstanceId))})).find(value => value.generation?.status === 'ready' || value.generation?.status === 'running');
      if (failed?.generation) add(node, conditionForDependency(node, node, {...failed.generation, nodeInstanceId: failed.node.nodeInstanceId, templateNodeKey: failed.node.templateNodeKey}, 'failed_dependency', 'dependency'));
      else if (waiting?.generation) add(node, conditionForDependency(node, node, {...waiting.generation, nodeInstanceId: waiting.node.nodeInstanceId, templateNodeKey: waiting.node.templateNodeKey}, 'waiting', 'dependency'));

      const wait = rawNode.waitForExpansion;
      if (wait && typeof wait === 'object' && !Array.isArray(wait) && typeof (wait as Json).owner === 'string' && typeof (wait as Json).terminal_node === 'string') {
        const childInstances = instances.filter(child => {
          if (child.parentSubgraphInstanceId !== instance.subgraphInstanceId) return false;
          if (child.expansionOwnerCheck === (wait as Json).owner) return true;
          // Nested expansion owners are serialized as their canonical path;
          // the terminal segment is the exact compiled owner named by wait.
          if (typeof child.expansionOwnerCheck !== 'string') return false;
          try {
            const ownerPath = JSON.parse(child.expansionOwnerCheck) as unknown;
            return Array.isArray(ownerPath) && ownerPath.at(-1) === (wait as Json).owner;
          } catch {
            return false;
          }
        });
        for (const child of childInstances) {
          const childNode = nodeFor(child, String((wait as Json).terminal_node));
          if (!childNode) continue;
          const childGeneration = activeGeneration(String(childNode.nodeInstanceId));
          if (childGeneration && (childGeneration.status === 'failed' || childGeneration.status === 'ready' || childGeneration.status === 'running')) {
            const pseudo = {...childGeneration, nodeInstanceId: childNode.nodeInstanceId, templateNodeKey: childNode.templateNodeKey};
            add(node, conditionForDependency(node, node, pseudo, childGeneration.status === 'failed' ? 'failed_dependency' : 'waiting', 'expansion_barrier'));
            continue;
          }
          // A child terminal node can itself be absent while its exact
          // prerequisite is ready/running/failed.  Propagate only that
          // compiled child frontier to the owning component wait node.
          const childTemplate = templateForInstance(planValue, child);
          const childRawNode = childTemplate && isRecord(childTemplate.nodesByKey)
            ? childTemplate.nodesByKey[String((wait as Json).terminal_node)]
            : undefined;
          if (!isRecord(childRawNode)) continue;
          const childDependencies = Array.isArray(childRawNode.dependencyNodeKeys)
            ? childRawNode.dependencyNodeKeys.filter((value): value is string => typeof value === 'string')
            : [];
          const childPrerequisites = childDependencies
            .map(key => nodeFor(child, key))
            .filter((value): value is Json => value !== undefined);
          const childFailed = childPrerequisites
            .map(prerequisite => ({node: prerequisite, generation: activeGeneration(String(prerequisite.nodeInstanceId))}))
            .find(value => value.generation?.status === 'failed');
          const childWaiting = childPrerequisites
            .map(prerequisite => ({node: prerequisite, generation: activeGeneration(String(prerequisite.nodeInstanceId))}))
            .find(value => value.generation?.status === 'ready' || value.generation?.status === 'running');
          const frontier = childFailed ?? childWaiting;
          if (frontier?.generation) {
            const pseudo = {
              ...frontier.generation,
              nodeInstanceId: frontier.node.nodeInstanceId,
              templateNodeKey: frontier.node.templateNodeKey,
            };
            add(node, conditionForDependency(
              node,
              node,
              pseudo,
              childFailed ? 'failed_dependency' : 'waiting',
              'expansion_barrier',
            ));
          }
        }
      }
    }
  }

  if (currentInputs) {
    const currentByIdentity = new Map(currentInputs.map(tuple => [`${tuple.id}\0${tuple.componentId}\0${tuple.filePath}`, tuple]));
    const retainedById = new Set<string>();
    for (const claim of Object.values(projectionValue.claimsById || {}).filter(isRecord)) {
      if (claim.active !== true || (claim.claim !== 'native.requirement.item@1' && claim.claim !== 'native.spec.item@1')) continue;
      if (!isRecord(claim.payload)) throw new Error('retained native Proof requirement claim is malformed');
      const retained = normalizeProofTuple(claim.payload, `retained ${claim.claim} claim`);
      if (retainedById.has(retained.id)) throw new Error(`retained native Proof requirement claims contain a duplicate for ${retained.id}`);
      retainedById.add(retained.id);
      const exact = currentByIdentity.get(`${retained.id}\0${retained.componentId}\0${retained.filePath}`);
      if (!exact) {
        if ([...currentByIdentity.keys()].some(key => key.startsWith(`${retained.id}\0`))) {
          throw new Error(`current Proof requirement identity changed for ${retained.id}`);
        }
        throw new Error(`current Proof requirement tuple is missing for ${retained.id}`);
      }
      if (exact.proofFileHash === retained.proofFileHash) continue;
      const generation = typeof claim.nodeGenerationId === 'string' ? projectionValue.generationsById?.[claim.nodeGenerationId] : undefined;
      const scope = isRecord(generation) && Array.isArray(generation.scope) ? generation.scope : claim.scope;
      const node = {
        nodeInstanceId: isRecord(generation) ? generation.nodeInstanceId : undefined,
        templateNodeKey: isRecord(generation) ? generation.templateNodeKey : claim.producerCheckId,
        scope,
      } as Json;
      const staleEvidence: Json = {
        requirement_id: retained.id,
        component_id: retained.componentId,
        file_path: retained.filePath,
        retained_sha256: retained.proofFileHash,
        current_sha256: exact.proofFileHash,
        source_claim_id: claim.claimId,
        ...(typeof node.nodeInstanceId === 'string' ? {node_instance_id: node.nodeInstanceId} : {}),
      };
      const retainedStatus = isRecord(generation) &&
        typeof generation.status === 'string' &&
        generation.status !== 'inactive'
        ? generation.status
        : undefined;
      items.push({
        id: retained.id,
        // A stale condition is orthogonal to the execution state.  Reuse the
        // retained generation state when it is available instead of turning a
        // completed or failed execution into synthetic pending work.
        status: retainedStatus ?? 'unknown',
        checkId: isRecord(generation) && typeof generation.checkId === 'string' ? generation.checkId : claim.producerCheckId,
        kind: 'specification',
        ...(retainedStatus === undefined ? {conditionOnly: true} : {}),
        condition: {
          state: 'stale',
          kind: 'changed_input',
          evidence: {...staleEvidence, scope: 'specification'},
        },
      });
      const component = componentGenerationFor(retained.componentId);
      items.push({
        id: retained.componentId,
        // Unknown is truthful when no component generation was retained; it
        // must not be turned into a fabricated pending/success state.
        status: component && typeof component.generation.status === 'string' ? component.generation.status : 'unknown',
        ...(component ? {
          checkId: typeof component.generation.checkId === 'string'
            ? component.generation.checkId
            : optionalString(component.node.templateNodeKey),
        } : {}),
        kind: 'component',
        ...(component ? {} : {conditionOnly: true}),
        condition: {
          state: 'stale',
          kind: 'changed_input',
          evidence: {
            ...staleEvidence,
            scope: 'component',
            ...(component ? {component_generation_id: component.generation.nodeGenerationId} : {}),
            ...(component && typeof component.node.nodeInstanceId === 'string'
              ? {component_node_instance_id: component.node.nodeInstanceId}
              : {}),
          },
        },
      });
    }
  }
  return {items, unknown};
}

function explicitOperationalKind(generation: Json): OperationalKind | undefined {
  const raw =
    optionalString(generation.operational_kind) ??
    optionalString(generation.operationalKind) ??
    optionalString(generation.unit_kind) ??
    optionalString(generation.unitKind);
  if (raw === 'project' || raw === 'component' || raw === 'specification' || raw === 'batch')
    return raw;
  if (raw === 'components') return 'component';
  if (raw === 'specifications' || raw === 'spec') return 'specification';
  if (raw === 'batches') return 'batch';
  return undefined;
}

type NativeReceiptDecision = 'approved' | 'needs_changes' | 'unreviewed' | 'unknown';

type NativeBatchProjection = Readonly<{
  claimId: string;
  payload: Json;
  scope: Json[];
  scopeContext: BatchScopeContext;
  operationalItems: readonly OperationalItem[];
}>;

function activeGenerationRecords(projection: Json): Json[] {
  if (!isRecord(projection.generationsById)) return [];
  const activeIds = new Set(
    isRecord(projection.activeGenerationIdByNode)
      ? Object.values(projection.activeGenerationIdByNode).filter((value): value is string => typeof value === 'string')
      : [],
  );
  return Object.entries(projection.generationsById)
    .filter(([id, value]) => activeIds.has(id) && isRecord(value) && value.status !== 'inactive')
    .map(([, value]) => value as Json);
}

function matchingScope(value: unknown, expected: string): value is Json[] {
  return Array.isArray(value) && canonicalJson(value) === expected;
}

function sortedStringIds(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length === 0)) return undefined;
  const ids = [...value] as string[];
  if (new Set(ids).size !== ids.length) return undefined;
  return ids.sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
}

function validBatchPayload(
  payload: Json,
  scopeContext: BatchScopeContext,
): {requirementIds: string[]; requirements: Json[]} | undefined {
  if (payload.id !== scopeContext.batchId || payload.component_id !== scopeContext.componentId) return undefined;
  const requirementIds = sortedStringIds(payload.requirement_ids);
  const requirements = Array.isArray(payload.requirements) && payload.requirements.every(isRecord)
    ? payload.requirements as Json[]
    : undefined;
  if (!requirementIds || !requirements || requirements.length !== requirementIds.length) return undefined;
  const seen = new Set<string>();
  for (const requirement of requirements) {
    const id = optionalString(requirement.id) ?? optionalString(requirement.requirement_id);
    const component = optionalString(requirement.component) ?? optionalString(requirement.component_id);
    if (!id || !component || component !== scopeContext.componentId || seen.has(id) || !requirementIds.includes(id)) return undefined;
    seen.add(id);
  }
  if (seen.size !== requirementIds.length) return undefined;
  return {requirementIds, requirements};
}

function receiptFindings(
  payload: Json,
  requirementIds: readonly string[],
): Map<string, Exclude<NativeReceiptDecision, 'unreviewed' | 'unknown'>> | undefined {
  if (payload.execution_status !== 'completed' || !Array.isArray(payload.errors) || payload.errors.length !== 0) return undefined;
  const opened = sortedStringIds(payload.opened_ids);
  const expected = [...requirementIds].sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  if (!opened || canonicalJson(opened) !== canonicalJson(expected) || !Array.isArray(payload.findings)) return undefined;
  const findings = new Map<string, Exclude<NativeReceiptDecision, 'unreviewed' | 'unknown'>>();
  for (const raw of payload.findings) {
    if (!isRecord(raw)) return undefined;
    const requirementId = optionalString(raw.requirement_id);
    const decision = raw.decision;
    const finding = optionalString(raw.finding);
    if (!requirementId || !requirementIds.includes(requirementId) ||
        (decision !== 'approved' && decision !== 'needs_changes') || !finding || findings.has(requirementId)) return undefined;
    findings.set(requirementId, decision);
  }
  if (findings.size !== requirementIds.length) return undefined;
  return findings;
}

function nativeBatchSpecificationItems(
  projection: Json,
  batchItems: readonly OperationalItem[],
  unknownReasons: string[],
): {items: OperationalItem[]; evidence: boolean} {
  if (!isRecord(projection.claimsById)) return {items: [], evidence: false};
  const activeClaims = Object.entries(projection.claimsById)
    .filter(([, value]) => isRecord(value) && value.active === true)
    .map(([claimId, value]) => ({claimId, claim: value as Json}));
  const activeBatchClaims: NativeBatchProjection[] = [];
  for (const {claimId, claim} of activeClaims.filter(entry => entry.claim.claim === 'native.batch.item@1')) {
    if (claim.kind !== 'controller-item') {
      unknownReasons.push(`active native.batch.item@1 claim ${claimId} is not a controller-item claim`);
      continue;
    }
    const scopeContext = batchScopeContext(claim.scope);
    if (!scopeContext || !Array.isArray(claim.scope) || !isRecord(claim.payload)) {
      unknownReasons.push(`active native.batch.item@1 claim ${claimId} has an invalid component/batch scope or payload`);
      continue;
    }
    const payloadResult = validBatchPayload(claim.payload, scopeContext);
    if (!payloadResult) {
      unknownReasons.push(`active native.batch.item@1 claim ${claimId} has inconsistent requirement IDs or objects`);
      continue;
    }
    const scope = claim.scope as Json[];
    const operationalItems = batchItems.filter(item =>
      item.id === scopeContext.batchId &&
      item.componentId === scopeContext.componentId &&
      item.batchScopeKey === scopeContext.batchScopeKey,
    );
    if (operationalItems.length === 0) {
      unknownReasons.push(`native batch ${scopeContext.batchId} has no exact operational generation link`);
      continue;
    }
    activeBatchClaims.push({claimId, payload: claim.payload, scope, scopeContext, operationalItems});
  }
  if (activeBatchClaims.length === 0) return {items: [], evidence: false};

  const occurrences = new Map<string, NativeBatchProjection[]>();
  for (const batch of activeBatchClaims) {
    const ids = sortedStringIds(batch.payload.requirement_ids) ?? [];
    for (const id of ids) occurrences.set(id, [...(occurrences.get(id) ?? []), batch]);
  }
  const activeGenerations = activeGenerationRecords(projection);
  const receiptCandidates = activeClaims.filter(entry => entry.claim.claim === 'native.batch.receipt@1');
  const invalidReceiptScopes = new Set(
    receiptCandidates
      .filter(entry => entry.claim.kind !== 'generated-output' || entry.claim.producerCheckId !== 'batch-author')
      .map(entry => batchScopeContext(entry.claim.scope)?.batchScopeKey)
      .filter((value): value is string => typeof value === 'string'),
  );
  const receipts = receiptCandidates
    .filter(entry => entry.claim.kind === 'generated-output' && entry.claim.producerCheckId === 'batch-author')
    .flatMap(({claimId, claim}) =>
      Array.isArray(claim.scope) && isRecord(claim.payload)
        ? [{claimId, payload: claim.payload, scope: claim.scope as Json[]}]
        : [],
    );
  const output: OperationalItem[] = [];
  const sortedBatches = [...activeBatchClaims].sort((left, right) => Buffer.from(left.scopeContext.batchScopeKey).compare(Buffer.from(right.scopeContext.batchScopeKey)));
  for (const batch of sortedBatches) {
    const requirementIds = sortedStringIds(batch.payload.requirement_ids) ?? [];
    const terminalGenerations = activeGenerations.filter(generation =>
      generation.checkId === 'batch-finished' && matchingScope(generation.scope, batch.scopeContext.batchScopeKey),
    );
    const batchState = operationalState(batch.operationalItems.map(item => item.status));
    const terminal = terminalGenerations.length === 1 ? terminalGenerations[0] : undefined;
    const matchingReceipts = receipts.filter(receipt =>
      receipt.payload.batch_id === batch.scopeContext.batchId &&
      matchingScope(receipt.scope, batch.scopeContext.batchScopeKey),
    );
    const receipt = matchingReceipts.length === 1 ? matchingReceipts[0] : undefined;
    const receiptClaim = receipt && isRecord(projection.claimsById)
      ? projection.claimsById[receipt.claimId]
      : undefined;
    const receiptGeneration = receipt && isRecord(receiptClaim) && receiptClaim.nodeGenerationId
      ? activeGenerations.find(generation =>
        generation.nodeGenerationId === receiptClaim.nodeGenerationId &&
        generation.checkId === 'batch-author' && generation.status === 'completed' &&
        matchingScope(generation.scope, batch.scopeContext.batchScopeKey),
      )
      : undefined;
    const terminalLineage = terminal && Array.isArray(terminal.activeInputClaimIds) &&
      terminal.activeInputClaimIds.includes(batch.claimId) &&
      !!receipt && terminal.activeInputClaimIds.includes(receipt.claimId);
    const receiptLineage = receiptGeneration && Array.isArray(receiptGeneration.activeInputClaimIds) &&
      receiptGeneration.activeInputClaimIds.includes(batch.claimId);
    const exactTerminal = terminal?.status === 'completed' && terminalLineage;
    const decisions = receipt && receiptGeneration
      ? receiptFindings(receipt.payload, requirementIds)
      : undefined;
    const receiptDecisionFor = (id: string): NativeReceiptDecision => {
      if (occurrences.get(id)?.length !== 1) return 'unknown';
      if (matchingReceipts.length > 1) return 'unknown';
      if (matchingReceipts.length === 0 && invalidReceiptScopes.has(batch.scopeContext.batchScopeKey)) return 'unknown';
      if (!receipt) return 'unreviewed';
      if (!receiptGeneration || !decisions) return 'unknown';
      return decisions.get(id) ?? 'unknown';
    };
    const completed = batchState === 'completed' && exactTerminal && !!receiptGeneration && !!receiptLineage && !!decisions;
    const state = batchState === 'completed'
      ? (completed ? 'completed' : 'unknown')
      : batchState;
    if (batchState === 'completed' && !completed) {
      unknownReasons.push(`native batch ${batch.scopeContext.batchId} lacks an exact completed terminal and receipt lineage`);
    }
    if (requirementIds.some(id => occurrences.get(id)?.length !== 1)) {
      unknownReasons.push(`native batch ${batch.scopeContext.batchId} has a requirement owned by multiple active batches`);
    }
    for (const id of requirementIds) {
      const decision = receiptDecisionFor(id);
      output.push({
        id,
        status: occurrences.get(id)?.length === 1 ? state : 'unknown',
        checkId: batch.operationalItems[0].checkId,
        outputComponentId: batch.scopeContext.componentId,
        batchId: batch.scopeContext.batchId,
        receiptDecision: decision,
        ...(receipt && matchingReceipts.length === 1 ? {receiptClaimId: receipt.claimId} : {}),
      });
    }
  }
  return {items: output, evidence: output.length > 0};
}

function operationalProjection(
  projection: unknown,
  retainedCatalogComponentIds?: readonly string[],
  affectedComponentIds?: readonly string[],
  expansionPlan?: ExpansionPlan | unknown,
  currentProofInputs?: unknown,
  checkpoint?: unknown,
): OperationalProjectionResult {
  if (!isRecord(projection) || !isRecord(projection.generationsById)) {
    const unknown = { state: 'unknown' as const, known: false, check_ids: [] };
    const empty = (unexpandedCount: number) => collection([], false, unexpandedCount);
    const conditionResult = nativeConditionEntries(expansionPlan, projection, checkpoint, currentProofInputs);
    return {
      value: {
        project: unknown,
        components: empty(1),
        specifications: empty(1),
        batches: empty(1),
        catalog_coverage: catalogCoverage(retainedCatalogComponentIds, affectedComponentIds),
        discovered: { project: 0, components: 0, specifications: 0, batches: 0, total: 0 },
        unknown_count: 1,
        unexpanded_count: 4,
      },
      unknown: [
        'operational project state is unknown',
        'components are not expanded',
        'specifications are not expanded',
        'batches are not expanded',
        ...conditionResult.unknown,
      ],
    };
  }
  const conditionResult = nativeConditionEntries(expansionPlan, projection, checkpoint, currentProofInputs);
  const generations = Object.entries(projection.generationsById)
    .sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right)))
    .map(([, generation]) => generation)
    .filter(isRecord)
    .filter(generation => generation.status !== 'inactive');
  const itemsByKind: Record<
    'component' | 'specification' | 'batch',
    OperationalItem[]
  > = {
    component: [],
    specification: [],
    batch: [],
  };
  const projectStatuses: string[] = [];
  const projectChecks: string[] = [];
  const descendantStatuses: string[] = [];
  const unknownReasons: string[] = [];
  let unknownGenerationCount = 0;
  let componentEvidence = false;
  let specificationEvidence = false;
  let batchEvidence = false;
  type ComponentBatchAggregate = {
    componentId: string;
    componentScopeKey: string;
    batchStatuses: string[];
    terminalStatuses: string[];
  };
  const componentBatchAggregates = new Map<string, ComponentBatchAggregate>();
  const authoritativeBatchIds = new Set<string>();
  const aggregateFor = (component: ComponentScopeContext): ComponentBatchAggregate => {
    const key = `${component.componentId}\0${component.componentScopeKey}`;
    const existing = componentBatchAggregates.get(key);
    if (existing) return existing;
    const created: ComponentBatchAggregate = {
      componentId: component.componentId,
      componentScopeKey: component.componentScopeKey,
      batchStatuses: [],
      terminalStatuses: [],
    };
    componentBatchAggregates.set(key, created);
    return created;
  };
  for (const generation of generations) {
    const checkId =
      optionalString(generation.checkId) ??
      optionalString(generation.check_id) ??
      optionalString(generation.templateNodeKey) ??
      'unknown';
    const status = optionalString(generation.status) ?? 'unknown';
    const keys = keyedScope(generation.scope);
    const depth = keys.length;
    const explicitKind = explicitOperationalKind(generation);
    let kind: OperationalKind | undefined = explicitKind;
    if (!kind) {
      const scopeParts = Array.isArray(generation.scope)
        ? generation.scope.filter(isRecord)
        : [];
      const owner = scopeParts.length
        ? terminalExpansionOwner(scopeParts[scopeParts.length - 1].expansionOwnerCheck)
        : undefined;
      if (owner === 'native-project-dispatch' || owner === 'native-role-dispatch') kind = 'project';
      else if (owner === 'discover-native-components' || owner === 'enumerate-native-components') kind = 'component';
      else if (owner === 'enumerate-native-specs') kind = 'specification';
      else if (owner === 'enumerate-native-batches') kind = 'batch';
      else if (depth <= 1) kind = 'project';
      else if (depth === 2) kind = 'component';
      else if (depth === 3) kind = 'specification';
      // Deeper scopes are deliberately not guessed as specifications.  A
      // runner may provide an explicit unit kind when the graph adds batches.
    }
    if (kind === 'project') {
      projectStatuses.push(status);
      projectChecks.push(checkId);
      continue;
    }
    descendantStatuses.push(status);
    if (kind === 'component' || kind === 'specification' || kind === 'batch') {
      const fallbackId = keys[keys.length - 1];
      const id =
        optionalString(generation.unit_id) ??
        optionalString(generation.unitId) ??
        optionalString(generation.work_item_id) ??
        optionalString(generation.workItemId) ??
        fallbackId;
      if (!id) {
        unknownGenerationCount++;
        unknownReasons.push(`operational ${kind} generation has no stable id`);
        continue;
      }
      const component = componentScopeContext(generation.scope);
      const batchScope = kind === 'batch' ? batchScopeContext(generation.scope) : undefined;
      const item: OperationalItem = {
        id,
        status,
        checkId,
        ...(component ? {componentId: component.componentId, componentScopeKey: component.componentScopeKey} : {}),
        ...(batchScope ? {batchScopeKey: batchScope.batchScopeKey} : {}),
      };
      itemsByKind[kind].push(item);
      if (component && kind === 'batch') {
        const aggregate = aggregateFor(component);
        aggregate.batchStatuses.push(status);
        authoritativeBatchIds.add(`${component.componentId}\0${component.componentScopeKey}\0${id}`);
      } else if (component && kind === 'component' && checkId === 'component-finished') {
        aggregateFor(component).terminalStatuses.push(status);
      }
      if (kind === 'component') componentEvidence = true;
      if (kind === 'specification') specificationEvidence = true;
      if (kind === 'batch') batchEvidence = true;
      continue;
    }
    unknownGenerationCount++;
    unknownReasons.push(`operational generation at scope depth ${depth} is unexpanded`);
  }
  // Condition-only project rows (notably the absent component-promotion
  // fan-in target) still carry an authoritative pending execution/check ID.
  // Fold them into the project work before deriving its aggregate state.
  for (const item of conditionResult.items) {
    if (item.kind !== 'project') continue;
    projectStatuses.push(item.status);
    if (item.checkId) projectChecks.push(item.checkId);
  }
  const projectState = operationalState(projectStatuses);
  const descendantState = operationalState(descendantStatuses);
  const project = {
    // A completed project/controller generation is not a workflow-success
    // claim while an authoritative component/specification/batch frontier is
    // still ready, running, or failed.
    state: projectState === 'completed' && descendantState !== 'unknown' && descendantState !== 'completed'
      ? descendantState
      : projectState,
    known: projectStatuses.length > 0,
    check_ids: [...new Set(projectChecks)].sort((a, b) => Buffer.from(a).compare(Buffer.from(b))),
  };
  // A collection is unknown until its expansion has yielded at least one
  // authoritative unit.  This prevents an empty pre-expansion list from
  // looking like completed zero work.
  const componentUnexpanded = componentEvidence ? 0 : 1;
  let specificationUnexpanded = specificationEvidence ? 0 : 1;
  const batchUnexpanded = batchEvidence ? 0 : 1;
  for (const item of conditionResult.items) {
    const kind = item.kind;
    if (kind === 'component' || kind === 'specification' || kind === 'batch') {
      itemsByKind[kind].push(item);
      if (item.componentId && item.componentScopeKey && kind === 'batch') {
        const identity = `${item.componentId}\0${item.componentScopeKey}\0${item.id}`;
        if (!authoritativeBatchIds.has(identity)) {
          const aggregate = aggregateFor({componentId: item.componentId, componentScopeKey: item.componentScopeKey});
          aggregate.batchStatuses.push(item.condition?.kind === 'failed_dependency' ? 'failed' : item.status);
        }
      } else if (
        item.componentId &&
        item.componentScopeKey &&
        kind === 'component' &&
        item.checkId === 'component-finished'
      ) {
        aggregateFor({componentId: item.componentId, componentScopeKey: item.componentScopeKey})
          .terminalStatuses.push(item.condition?.kind === 'failed_dependency' ? 'failed' : item.status);
      }
    }
  }
  // Native spec rows are materialized from active controller claims, never
  // inferred from generation depth or from a receipt alone.  This keeps the
  // real catalog denominator visible while fail-closing stale/mismatched
  // terminal evidence.
  let receiptDecisionEvidence = false;
  if (isRecord(projection)) {
    const nativeSpecs = nativeBatchSpecificationItems(
      projection,
      itemsByKind.batch,
      unknownReasons,
    );
    if (nativeSpecs.evidence) {
      itemsByKind.specification.push(...nativeSpecs.items);
      specificationEvidence = true;
      specificationUnexpanded = 0;
      receiptDecisionEvidence = true;
    }
  }
  const components = collection(itemsByKind.component, componentEvidence || conditionResult.items.some(item => item.kind === 'component'), componentUnexpanded);
  const componentStateOverrides = new Map<string, NativeChecklistOperationalState>();
  for (const aggregate of componentBatchAggregates.values()) {
    if (aggregate.batchStatuses.length === 0) continue;
    const state = aggregate.terminalStatuses.includes('failed') || aggregate.batchStatuses.includes('failed')
      ? 'failed'
      : aggregate.terminalStatuses.includes('running') || aggregate.batchStatuses.includes('running')
        ? 'running'
        : aggregate.batchStatuses.every(status => status === 'completed') && aggregate.terminalStatuses.includes('completed')
          ? 'completed'
          : 'pending';
    const prior = componentStateOverrides.get(aggregate.componentId);
    componentStateOverrides.set(
      aggregate.componentId,
      prior ? operationalState([prior, state]) : state,
    );
  }
  const overriddenComponentItems = components.items.map(item => {
    const state = componentStateOverrides.get(item.id);
    return state ? {...item, state} : item;
  });
  const componentCount = (state: NativeChecklistOperationalState) =>
    overriddenComponentItems.filter(item => item.state === state).length;
  const componentsWithBatchState = {
    ...components,
    completed_count: componentCount('completed'),
    running_count: componentCount('running'),
    failed_count: componentCount('failed'),
    pending_count: componentCount('pending'),
    unknown_count: componentCount('unknown'),
    items: overriddenComponentItems,
  };
  const specifications = collection(
    itemsByKind.specification,
    specificationEvidence || conditionResult.items.some(item => item.kind === 'specification'),
    specificationUnexpanded,
    receiptDecisionEvidence,
  );
  const batches = collection(itemsByKind.batch, batchEvidence || conditionResult.items.some(item => item.kind === 'batch'), batchUnexpanded);
  const unknownCount =
    unknownGenerationCount +
    (project.known ? 0 : 1) +
    components.unknown_count +
    specifications.unknown_count +
    batches.unknown_count;
  const unexpandedCount =
    unknownGenerationCount +
    componentUnexpanded +
    specificationUnexpanded +
    batchUnexpanded +
    (project.known ? 0 : 1);
  if (!project.known) unknownReasons.unshift('operational project state is unknown');
  if (!componentEvidence) unknownReasons.push('components are not expanded');
  if (!specificationEvidence) unknownReasons.push('specifications are not expanded');
  if (!batchEvidence) unknownReasons.push('batches are not expanded');
  return {
    value: {
      project,
      components: componentsWithBatchState,
      specifications,
      batches,
      catalog_coverage: catalogCoverage(retainedCatalogComponentIds, affectedComponentIds),
      discovered: {
        project: project.known ? 1 : 0,
        components: components.known_count,
        specifications: specifications.known_count,
        batches: batches.known_count,
        total:
          (project.known ? 1 : 0) +
          components.known_count +
          specifications.known_count +
          batches.known_count,
      },
      unknown_count: unknownCount,
      unexpanded_count: unexpandedCount,
    },
    unknown: [...new Set([...unknownReasons, ...conditionResult.unknown])],
  };
}

function hasActiveReadyGeneration(projection: unknown): boolean {
  if (!isRecord(projection) || !isRecord(projection.generationsById)) return false;
  if (!isRecord(projection.activeGenerationIdByNode)) return false;
  const generations = Object.values(projection.generationsById).filter(isRecord);
  const activeIds = new Set(
    Object.values(projection.activeGenerationIdByNode).filter(
      (id): id is string => typeof id === 'string'
    )
  );
  return generations.some(
    generation =>
      generation.status === 'ready' &&
      generation.status !== 'inactive' &&
      activeIds.has(String(generation.nodeGenerationId ?? ''))
  );
}

function escapedHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapedHtmlJson(json: string): string {
  // Keep this valid JSON in a raw-text script element. HTML entities would be
  // literal bytes there, so use JSON unicode escapes for delimiter characters.
  return json
    .replace(/&/g, '\\u0026')
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function buildNativeChecklistProgress(
  input: NativeChecklistProgressInput
): NativeChecklistProgress {
  if (!isRecord(input.proofSnapshot)) throw new Error('proof checklist snapshot must be an object');
  const snapshot = input.proofSnapshot;
  const catalogDrift = normalizeCatalogDrift(input.proofCatalogDrift);
  const steps = snapshotSteps(snapshot);
  const requireLiveClaim = input.requireProofSnapshotClaim === true;
  if (
    requireLiveClaim &&
    input.proofSnapshotClaim === undefined &&
    input.proofSnapshotReadback === undefined &&
    input.proofSnapshotEvidence === undefined
  ) {
    throw new Error('live checklist progress requires a lineage-linked proof snapshot claim');
  }
  const claimEvidence = input.proofSnapshotEvidence
    ? (() => {
      if (input.proofSnapshotEvidence!.source !== 'native.component.summary@1') {
        throw new Error('unsupported checklist snapshot evidence source');
      }
      const claimIds = stringArray(input.proofSnapshotEvidence!.claimIds, 'component summary claim IDs');
      const componentIds = stringArray(input.proofSnapshotEvidence!.componentIds, 'component summary component IDs');
      if (!claimIds.length || claimIds.length !== componentIds.length ||
          claimIds.some(claimId => !/^[0-9a-f]{64}$/.test(claimId)) ||
          new Set(claimIds).size !== claimIds.length ||
          new Set(componentIds).size !== componentIds.length) {
        throw new Error('component summary checklist evidence has invalid claim/component IDs');
      }
      return {
        source: 'native.component.summary@1' as const,
        claim_ids: claimIds,
        component_ids: componentIds,
      };
    })()
    : input.proofSnapshotReadback
      ? validateCurrentReadbackEvidence(input.proofSnapshotReadback)
      : validateSnapshotClaim(snapshot, input.proofSnapshotClaim, requireLiveClaim);
  const counts = {
    confirmed: 0,
    skipped: 0,
    not_applicable: 0,
    pending: 0,
    blocked: 0,
    stale: 0,
    failed: 0,
    unknown: 0,
  };
  const progressSteps: NativeChecklistProgressStep[] = [];
  const unknown: string[] = [];
  for (const step of steps) {
    const id = requiredString(step.step_id, 'checklist step_id');
    const title = requiredString(step.title, `checklist step ${id} title`);
    const required = stringArray(step.required_checks, `checklist step ${id} required_checks`);
    const resultValues = objectArray(step.check_results, `checklist step ${id} check_results`);
    const checkPass = requiredChecksPass(step);
    const verify = verifyPassed(step);
    const state = stepState(step, checkPass, verify);
    counts[state] += 1;
    if (state === 'unknown') unknown.push(`checklist step ${id} has an unknown effective status`);
    progressSteps.push({
      id,
      title,
      state,
      stored_status: optionalString(step.stored_status) ?? 'pending',
      effective_status: optionalString(step.effective_status) ?? 'pending',
      applicable: step.applicable !== false,
      eligible: step.eligible === true,
      requires: stringArray(step.requires, `checklist step ${id} requires`),
      unmet_requires: stringArray(step.unmet_requires, `checklist step ${id} unmet_requires`),
      ...(optionalString(step.role) ? { role: step.role as string } : {}),
      ...(optionalString(step.scope) ? { scope: step.scope as string } : {}),
      ...(optionalString(step.verify_cmd) ? { verify_cmd: step.verify_cmd as string } : {}),
      verify_required: step.stamp === 'confirm+verify',
      required_checks: required,
      check_results: resultValues,
      ...(step.verify_result === undefined ? {} : { verify_result: step.verify_result }),
      evidence: {
        required_checks_pass: checkPass,
        ...(verify === undefined ? {} : { verify_pass: verify }),
      },
    });
  }
  const snapshotDigest = sha256Canonical(snapshot);
  const journal = checkpointEvidence(input.checkpoint, input.checkpointTimestamp, input.instanceProjection);
  const paused = input.paused === true;
  const resumed = input.resumed === true;
  const resumable =
    paused &&
    journal.checkpoint_present &&
    journal.event_count !== undefined &&
    journal.last_event_id !== undefined &&
    journal.graph_semantic_digest !== undefined &&
    journal.integrity_digest !== undefined &&
    hasActiveReadyGeneration(input.instanceProjection);
  const operationalResult = operationalProjection(
    input.instanceProjection,
    input.retainedCatalogComponentIds,
    input.affectedComponentIds,
    input.expansionPlan,
    input.currentProofInputs,
    input.checkpoint,
  );
  unknown.push(...operationalResult.unknown);
  if (catalogDrift) {
    unknown.push(
      `Proof catalog changed during resume (added: ${catalogDrift.added_ids.join(',') || 'none'}; removed: ${catalogDrift.removed_ids.join(',') || 'none'})`,
    );
  }
  const checklistName = requiredString(snapshot.checklist, 'proof checklist checklist');
  const proofStepsPending =
    typeof snapshot.steps_pending === 'number' &&
    Number.isSafeInteger(snapshot.steps_pending) &&
    snapshot.steps_pending >= 0
      ? snapshot.steps_pending
      : counts.pending + counts.blocked;
  return {
    version: 1,
    kind: 'native-checklist-progress',
    checklist: {
      name: checklistName,
      active: snapshot.active === true,
      new_project: snapshot.new_project === true,
      ...(optionalString(snapshot.definition_source)
        ? { definition_source: snapshot.definition_source as string }
        : {}),
      ...(optionalString(snapshot.definition_path)
        ? { definition_path: snapshot.definition_path as string }
        : {}),
      ...(optionalString(snapshot.updated_at) ? { updated_at: snapshot.updated_at as string } : {}),
      steps_total: steps.length,
      // Preserve Proof's compatibility field.  Stale/failed evidence is
      // surfaced separately and is not silently recast as a Proof pending row.
      steps_pending: proofStepsPending,
      unresolved_count:
        counts.pending + counts.blocked + counts.stale + counts.failed + counts.unknown,
      counts,
      eligible_step_ids: stringArray(
        snapshot.eligible_step_ids,
        'proof checklist eligible_step_ids'
      ),
      next: snapshot.next ?? null,
      steps: progressSteps,
    },
    operational: operationalResult.value,
    evidence: {
      proof_snapshot: {
        schema_version: requiredString(snapshot.schema_version, 'proof snapshot schema_version'),
        checklist: checklistName,
        digest: snapshotDigest,
        ...(claimEvidence.claim_id ? { claim_id: claimEvidence.claim_id } : {}),
        ...(claimEvidence.claim_ids ? { claim_ids: claimEvidence.claim_ids } : {}),
        ...(claimEvidence.component_ids ? { component_ids: claimEvidence.component_ids } : {}),
        ...(claimEvidence.anchor_claim_id
          ? { anchor_claim_id: claimEvidence.anchor_claim_id }
          : {}),
        ...(claimEvidence.generation_id
          ? { generation_id: claimEvidence.generation_id }
          : {}),
        ...(claimEvidence.source ? { source: claimEvidence.source } : {}),
        ...(claimEvidence.stage ? { stage: claimEvidence.stage } : {}),
        ...(optionalString(snapshot.updated_at)
          ? { updated_at: snapshot.updated_at as string }
          : {}),
      },
      journal,
      ...(catalogDrift ? {catalog_drift: catalogDrift} : {}),
    },
    paused,
    resumed,
    resumable,
    unknown: [...new Set(unknown)],
  };
}

export function renderNativeChecklistProgress(progress: NativeChecklistProgress): {
  json: string;
  text: string;
  html: string;
} {
  const json = `${canonicalJson(progress)}\n`;
  const counts = progress.checklist.counts;
  const rows = progress.checklist.steps.map(step => {
    const checks = `${requiredCheckEvidenceLabel(step)}${step.required_checks.length === 0 ? '' : `:${step.required_checks.join(',')}`}`;
    const verify = step.verify_required
      ? ` verify=${step.evidence.verify_pass === true ? 'pass' : step.evidence.verify_pass === false ? 'fail' : 'missing'}`
      : '';
    const unmet = step.unmet_requires.length === 0 ? '' : ` unmet=${step.unmet_requires.join(',')}`;
    return `${step.state.padEnd(14)} ${step.id} — ${step.title} [checks=${checks}${verify}${unmet}]`;
  });
  const operationalRows = [
    [
      'selected workflow',
      progress.operational.project.state,
      progress.operational.project.known ? 'known' : 'unknown',
      progress.operational.project.check_ids.join(',') || 'none',
    ],
    ...(['components', 'specifications', 'batches'] as const).map(kind => {
      const group = progress.operational[kind];
      const receipt = kind === 'specifications' && group.receipt_decisions
        ? `,RECEIPT DECISION approved=${group.receipt_decisions.approved},needs_changes=${group.receipt_decisions.needs_changes},unreviewed=${group.receipt_decisions.unreviewed},unknown=${group.receipt_decisions.unknown}`
        : '';
      return [
        kind,
        `${group.known_count} discovered`,
        group.known ? 'expanded' : 'unexpanded',
        `completed=${group.completed_count},running=${group.running_count},failed=${group.failed_count},pending=${group.pending_count},unknown=${group.unknown_count},unexpanded=${group.unexpanded_count},blocked=${group.blocked_count},stale=${group.stale_count}${receipt}`,
      ];
    }),
  ];
  const operationalItems = (['components', 'specifications', 'batches'] as const).flatMap(kind =>
    progress.operational[kind].items.map(
      item => `${kind}.${item.id}=${item.state}${item.receipt_decision ? ` RECEIPT DECISION=${item.receipt_decision}` : ''}${item.conditions?.length ? ` condition=${item.conditions.map(condition => `${condition.state}:${condition.kind}:${canonicalJson(condition.evidence)}`).join('|')}` : ''} [${item.check_ids.join(',') || 'no-check'}]`
    )
  );
  const journal = progress.evidence.journal;
  const journalFields = [
    `present=${journal.checkpoint_present}`,
    ...(journal.session_id ? [`session_id=${journal.session_id}`] : []),
    ...(journal.event_count === undefined ? [] : [`event_count=${journal.event_count}`]),
    ...(journal.last_event_id === undefined ? [] : [`last_event_id=${journal.last_event_id}`]),
    ...(journal.checkpoint_timestamp ? [`timestamp=${journal.checkpoint_timestamp}`] : []),
    ...(journal.graph_semantic_digest ? [`graph=${journal.graph_semantic_digest}`] : []),
    ...(journal.integrity_digest ? [`integrity=${journal.integrity_digest}`] : []),
  ];
  const text =
    [
      `${progress.checklist.name} (${progress.checklist.steps_total} steps)`,
      `confirmed=${counts.confirmed} skipped=${counts.skipped} not_applicable=${counts.not_applicable} pending=${counts.pending} blocked=${counts.blocked} stale=${counts.stale} failed=${counts.failed} unknown=${counts.unknown}`,
      `proof_steps_pending=${progress.checklist.steps_pending} unresolved=${progress.checklist.unresolved_count} eligible=${progress.checklist.eligible_step_ids.join(',') || 'none'}`,
      `paused=${progress.paused} resumed=${progress.resumed} resumable=${progress.resumable}`,
      `proof_snapshot=schema:${progress.evidence.proof_snapshot.schema_version} source:${progress.evidence.proof_snapshot.source || 'unlinked'}${progress.evidence.proof_snapshot.stage ? ` stage:${progress.evidence.proof_snapshot.stage}` : ''} digest:${progress.evidence.proof_snapshot.digest}${progress.evidence.proof_snapshot.claim_id ? ` claim:${progress.evidence.proof_snapshot.claim_id}` : ''}`,
      `checkpoint ${journalFields.join(' ')}${journal.provenance ? ` provenance=${journal.provenance}` : ''}${journal.durable_through_event_id === undefined ? '' : ` durable_through=${journal.durable_through_event_id}`}`,
      `operational discovered=project:${progress.operational.discovered.project} components:${progress.operational.discovered.components} specifications:${progress.operational.discovered.specifications} batches:${progress.operational.discovered.batches} total:${progress.operational.discovered.total} unknown=${progress.operational.unknown_count} unexpanded=${progress.operational.unexpanded_count}`,
      `catalog coverage=known:${progress.operational.catalog_coverage.known_count} affected:${progress.operational.catalog_coverage.affected_count} reused:${progress.operational.catalog_coverage.reused_count} unexpanded:${progress.operational.catalog_coverage.unexpanded_count}`,
      ...operationalRows.map(row => `operational ${row[0]}: state=${row[1]} ${row[2]} ${row[3]}`),
      ...(operationalItems.length
        ? ['operational items:', ...operationalItems.map(item => `  ${item}`)]
        : []),
      ...(progress.unknown.length
        ? ['unknown:', ...progress.unknown.map(reason => `  ${reason}`)]
        : []),
      ...rows,
    ].join('\n') + '\n';
  const htmlChecklistRows = progress.checklist.steps.map(
    step =>
      `<tr><td class="state"><span class="badge state-${escapedHtml(step.state)}">${escapedHtml(step.state)}</span></td><td>${escapedHtml(step.id)}</td><td>${escapedHtml(step.title)}</td><td>${escapedHtml(`required checks: ${requiredCheckEvidenceLabel(step)}`)}${step.verify_required ? escapedHtml(`; verify: ${step.evidence.verify_pass === true ? 'pass' : step.evidence.verify_pass === false ? 'fail' : 'missing'}`) : ''}${step.unmet_requires.length ? `<br><small>blocked by ${escapedHtml(step.unmet_requires.join(', '))}</small>` : ''}</td></tr>`
  );
  const htmlOperationalRows = operationalRows.map(row => {
    const metrics =
      row[0] === 'selected workflow'
        ? `<span class="metric"><b>Checks:</b> ${escapedHtml(row[3])}</span>`
        : row[3]
            .split(',')
            .map(metric => {
              const [key, value] = metric.split('=');
              return `<span class="metric"><b>${escapedHtml(key || 'value')}:</b> ${escapedHtml(value || '')}</span>`;
            })
            .join('');
    return `<tr><th>${escapedHtml(row[0])}</th><td>${escapedHtml(row[1])}</td><td>${escapedHtml(row[2])}</td><td class="metrics">${metrics}</td></tr>`;
  });
  const htmlOperationalItems = operationalItems
    .map(item => `<li>${escapedHtml(item)}</li>`)
    .join('');
  const htmlUnknown = progress.unknown.length
    ? `<h3>Unknown / unexpanded</h3><ul>${progress.unknown.map(reason => `<li>${escapedHtml(reason)}</li>`).join('')}</ul>`
    : '';
  const html = `<section data-native-checklist-progress="v1"><style>.native-checklist-progress{font:14px system-ui,sans-serif;color:#222;max-width:100%;overflow-wrap:normal;word-break:normal}.native-checklist-progress table{border-collapse:collapse;margin:.5rem 0 1rem;table-layout:fixed;width:100%;min-width:52rem}.native-checklist-progress th:nth-child(1),.native-checklist-progress td:nth-child(1){width:8rem}.native-checklist-progress th:nth-child(2),.native-checklist-progress td:nth-child(2){width:12rem}.native-checklist-progress th:nth-child(3),.native-checklist-progress td:nth-child(3){width:14rem}.native-checklist-progress th:nth-child(4),.native-checklist-progress td:nth-child(4){overflow-wrap:anywhere;word-break:break-word}.native-checklist-progress .table-wrap{max-width:100%;overflow-x:auto}.native-checklist-progress td,.native-checklist-progress th{border:1px solid #bbb;padding:.3rem .5rem;text-align:left;vertical-align:top}.native-checklist-progress li{overflow-wrap:anywhere;word-break:break-word}.native-checklist-progress .state{font-weight:600}.native-checklist-progress .badge{display:inline-block;border:1px solid #999;border-radius:.25rem;padding:.08rem .35rem;font-weight:600;white-space:nowrap}.native-checklist-progress .state-confirmed{background:#e5f6e8}.native-checklist-progress .state-pending,.native-checklist-progress .state-blocked{background:#fff2cc}.native-checklist-progress .state-stale,.native-checklist-progress .state-failed{background:#ffe1e1}.native-checklist-progress .state-unknown{background:#eee}.native-checklist-progress .metrics{display:flex;flex-wrap:wrap;gap:.25rem .8rem}.native-checklist-progress .metric{white-space:nowrap}.native-checklist-progress small{color:#555}@media(max-width:640px){.native-checklist-progress{font-size:13px}.native-checklist-progress table{min-width:32rem}.native-checklist-progress td,.native-checklist-progress th{padding:.25rem}}</style><div class="native-checklist-progress"><h2>${escapedHtml(progress.checklist.name)}</h2><p class="status-summary"><span class="badge">confirmed=${counts.confirmed}</span> <span class="badge state-pending">pending=${counts.pending}</span> <span class="badge state-blocked">blocked=${counts.blocked}</span> <span class="badge state-stale">stale=${counts.stale}</span> <span class="badge state-failed">failed=${counts.failed}</span> <span class="badge state-unknown">unknown=${counts.unknown}</span> <span>unresolved=${progress.checklist.unresolved_count}</span></p><p><span class="badge">paused=${progress.paused}</span> <span class="badge">resumed=${progress.resumed}</span> <span class="badge">resumable=${progress.resumable}</span>; eligible=${escapedHtml(progress.checklist.eligible_step_ids.join(', ') || 'none')}</p><h3>Checklist stages</h3><div class="table-wrap"><table><thead><tr><th>State</th><th>ID</th><th>Stage</th><th>Evidence</th></tr></thead><tbody>${htmlChecklistRows.join('')}</tbody></table></div><h3>Operational work</h3><div class="table-wrap"><table><thead><tr><th>Unit</th><th>State / discovered</th><th>Coverage</th><th>Counts / checks</th></tr></thead><tbody>${htmlOperationalRows.join('')}</tbody></table></div>${htmlOperationalItems ? `<h4>Known units</h4><ul>${htmlOperationalItems}</ul>` : ''}<p>discovered: project=${progress.operational.discovered.project}, components=${progress.operational.discovered.components}, specifications=${progress.operational.discovered.specifications}, batches=${progress.operational.discovered.batches}; unknown=${progress.operational.unknown_count}; unexpanded=${progress.operational.unexpanded_count}</p><p>catalog coverage: known=${progress.operational.catalog_coverage.known_count}, affected=${progress.operational.catalog_coverage.affected_count}, reused=${progress.operational.catalog_coverage.reused_count}, unexpanded=${progress.operational.catalog_coverage.unexpanded_count}</p><h3>Evidence and checkpoint</h3><p>Proof snapshot ${escapedHtml(progress.evidence.proof_snapshot.schema_version)} source ${escapedHtml(progress.evidence.proof_snapshot.source || 'unlinked')}${progress.evidence.proof_snapshot.stage ? ` stage ${escapedHtml(progress.evidence.proof_snapshot.stage)}` : ''} digest ${escapedHtml(progress.evidence.proof_snapshot.digest)}${progress.evidence.proof_snapshot.claim_id ? ` claim ${escapedHtml(progress.evidence.proof_snapshot.claim_id)}` : ''}<br>Checkpoint ${escapedHtml(journalFields.join(' '))}${journal.provenance ? ` provenance ${escapedHtml(journal.provenance)}` : ''}${journal.durable_through_event_id === undefined ? '' : ` durable through ${journal.durable_through_event_id}`}</p>${htmlUnknown}</div><script type="application/json" id="native-checklist-progress">${escapedHtmlJson(json)}</script></section>`;
  return { json, text, html };
}

export function renderNativeChecklistProgressJson(input: NativeChecklistProgressInput): string {
  return renderNativeChecklistProgress(buildNativeChecklistProgress(input)).json;
}

/** Render the already-built canonical projection for a human CLI. */
export function renderNativeChecklistProgressText(progress: NativeChecklistProgress): string {
  return renderNativeChecklistProgress(progress).text;
}

/** Render the already-built canonical projection as a dependency-free static page. */
export function renderNativeChecklistProgressHtml(progress: NativeChecklistProgress): string {
  return renderNativeChecklistProgress(progress).html;
}

export type NativeChecklistDisplayArgs = Readonly<{
  config: string;
  checkpoint: string;
  proofBin: string;
  targetRoot: string;
  outputDir: string;
  resumed: boolean;
}>;

const DISPLAY_OUTPUT_NAMES = [
  'native-checklist-progress.json',
  'native-checklist-progress.txt',
  'native-checklist-progress.html',
] as const;

function displayPath(value: string, label: string): string {
  if (!value || !path.isAbsolute(value)) throw new Error(`${label} requires an absolute path`);
  return path.resolve(value);
}

function parseNativeChecklistDisplayArgs(argv: readonly string[]): NativeChecklistDisplayArgs {
  const args = [...argv];
  if (args[0] === 'display') args.shift();
  const values: Partial<Record<'config' | 'checkpoint' | 'proof-bin' | 'target-root' | 'output-dir', string>> = {};
  let resumed = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--resumed') {
      resumed = true;
      continue;
    }
    const key = arg?.startsWith('--') ? arg.slice(2) : '';
    if (!['config', 'checkpoint', 'proof-bin', 'target-root', 'output-dir'].includes(key)) {
      throw new Error(`unknown display argument ${arg || '<empty>'}`);
    }
    const value = args[++index];
    if (!value || value.startsWith('--')) throw new Error(`${arg} requires a value`);
    if (values[key as keyof typeof values] !== undefined) throw new Error(`${arg} was supplied more than once`);
    values[key as keyof typeof values] = value;
  }
  const config = values.config;
  const checkpoint = values.checkpoint;
  const proofBin = values['proof-bin'];
  const targetRoot = values['target-root'];
  const outputDir = values['output-dir'];
  if (!config || !checkpoint || !proofBin || !targetRoot || !outputDir) {
    throw new Error('display requires --config, --checkpoint, --proof-bin, --target-root, and --output-dir');
  }
  return {
    config: displayPath(config, '--config'),
    checkpoint: displayPath(checkpoint, '--checkpoint'),
    proofBin: displayPath(proofBin, '--proof-bin'),
    targetRoot: displayPath(targetRoot, '--target-root'),
    outputDir: displayPath(outputDir, '--output-dir'),
    resumed,
  };
}

type PrivateDisplayDirectory = Readonly<{path: string; dev: number; ino: number}>;

function privateDisplayDirectory(target: string): PrivateDisplayDirectory {
  const requested = displayPath(target, '--output-dir');
  const requestedStat = fs.lstatSync(requested);
  if (requestedStat.isSymbolicLink() || !requestedStat.isDirectory()) {
    throw new Error('display output directory must be an existing real directory');
  }
  const real = fs.realpathSync(requested);
  const stat = fs.statSync(real);
  if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700) {
    throw new Error('display output directory must be private mode 0700');
  }
  return {path: real, dev: stat.dev, ino: stat.ino};
}

function assertDisplayOutputsAbsent(outputDir: PrivateDisplayDirectory): string[] {
  const current = fs.statSync(outputDir.path);
  if (!current.isDirectory() || current.dev !== outputDir.dev || current.ino !== outputDir.ino || (current.mode & 0o777) !== 0o700) {
    throw new Error('display output directory identity changed');
  }
  const targets = DISPLAY_OUTPUT_NAMES.map(name => path.join(outputDir.path, name));
  for (const target of targets) {
    try {
      fs.lstatSync(target);
      throw new Error(`display output target must be absent: ${path.basename(target)}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return targets;
}

function writeDisplayOutputs(outputDir: PrivateDisplayDirectory, targets: readonly string[], contents: readonly string[]): void {
  const created: Array<{target: string; dev: number; ino: number}> = [];
  try {
    for (let index = 0; index < targets.length; index++) {
      const target = targets[index];
      const currentDirectory = fs.statSync(outputDir.path);
      if (!currentDirectory.isDirectory() || currentDirectory.dev !== outputDir.dev || currentDirectory.ino !== outputDir.ino || (currentDirectory.mode & 0o777) !== 0o700) {
        throw new Error('display output directory identity changed');
      }
      const fd = fs.openSync(
        target,
        fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW || 0),
        0o600,
      );
      try {
        const descriptor = fs.fstatSync(fd);
        if (!descriptor.isFile() || (descriptor.mode & 0o777) !== 0o600) throw new Error('display output identity or mode is invalid');
        created.push({target, dev: descriptor.dev, ino: descriptor.ino});
        const bytes = Buffer.from(contents[index], 'utf8');
        let offset = 0;
        while (offset < bytes.length) {
          const written = fs.writeSync(fd, bytes, offset, bytes.length - offset);
          if (!Number.isInteger(written) || written <= 0) throw new Error('display output write made no progress');
          offset += written;
        }
        fs.fsyncSync(fd);
        const after = fs.fstatSync(fd);
        if (!after.isFile() || (after.mode & 0o777) !== 0o600 || after.size !== bytes.length) throw new Error('display output identity or mode changed');
        if (after.dev !== descriptor.dev || after.ino !== descriptor.ino) throw new Error('display output identity changed');
        const pathname = fs.lstatSync(target);
        if (pathname.isSymbolicLink() || !pathname.isFile() || pathname.dev !== descriptor.dev || pathname.ino !== descriptor.ino || (pathname.mode & 0o777) !== 0o600) throw new Error('display output identity changed');
      } finally {
        fs.closeSync(fd);
      }
    }
    const directoryFd = fs.openSync(outputDir.path, fs.constants.O_RDONLY);
    try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
  } catch (error) {
    for (const entry of created.reverse()) {
      try {
        const current = fs.lstatSync(entry.target);
        if (current.dev === entry.dev && current.ino === entry.ino) fs.unlinkSync(entry.target);
      } catch {
        // Preserve the original write failure and never remove an unrelated file.
      }
    }
    throw error;
  }
}

function restoreRemoteExtendsPolicy<T>(work: () => Promise<T>): Promise<T> {
  const previous = process.env.VISOR_NO_REMOTE_EXTENDS;
  process.env.VISOR_NO_REMOTE_EXTENDS = 'true';
  return work().finally(() => {
    if (previous === undefined) delete process.env.VISOR_NO_REMOTE_EXTENDS;
    else process.env.VISOR_NO_REMOTE_EXTENDS = previous;
  });
}

function targetBindingPath(projection: InstanceProjection): string {
  const bindings = Object.values(projection.claimsById).filter(claim => claim.active && claim.claim === 'native.project.item@1');
  if (bindings.length !== 1) throw new Error('display requires exactly one active native.project.item@1 target binding');
  const payload = bindings[0].payload;
  const target = isRecord(payload) && isRecord(payload.target) ? payload.target.path : undefined;
  if (typeof target !== 'string' || target.length === 0) throw new Error('active native.project.item@1 target binding has no target.path');
  return target;
}

function assertDisplayTarget(projection: InstanceProjection, targetRoot: string): void {
  const expected = fs.realpathSync(targetBindingPath(projection));
  const actual = fs.realpathSync(targetRoot);
  if (expected !== actual) throw new Error('display target-root does not match the active native.project.item@1 target binding');
}

function readProofChecklistSnapshot(proofBin: string, targetRoot: string): Json {
  const realProofBin = fs.realpathSync(proofBin);
  const proofStat = fs.statSync(realProofBin);
  if (!proofStat.isFile() || (proofStat.mode & 0o111) === 0) throw new Error('proof-bin must be an executable regular file');
  const result = spawnSync(realProofBin, ['checklist', 'show', 'onboard_v1', '--format', 'json'], {
    cwd: targetRoot,
    env: {...process.env},
    encoding: 'utf8',
    timeout: 30000,
    maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === 'ETIMEDOUT') throw new Error('Proof checklist show timed out');
    throw new Error(`Proof checklist show failed: ${result.error.message}`);
  }
  if (result.signal) throw new Error(`Proof checklist show terminated by ${result.signal}`);
  if (result.status !== 0) throw new Error(`Proof checklist show failed with exit ${String(result.status)}`);
  const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : '';
  if (!stdout) throw new Error('Proof checklist show returned empty JSON');
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`Proof checklist show returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) throw new Error('Proof checklist show JSON must be an object');
  return parsed;
}

/**
 * Display one validated Graph-v2 checkpoint and one fresh Proof snapshot.
 * This adapter never dispatches work, resumes a session, or mutates a journal.
 */
export async function runNativeChecklistProgressDisplay(
  input: NativeChecklistDisplayArgs,
): Promise<readonly string[]> {
  const targetRoot = fs.realpathSync(input.targetRoot);
  if (!fs.statSync(targetRoot).isDirectory()) throw new Error('target-root must be an existing directory');
  const outputDir = privateDisplayDirectory(input.outputDir);
  const outputTargets = assertDisplayOutputsAbsent(outputDir);
  const checkpoint = validateGraphCheckpointInputFile(input.checkpoint);
  const config = await restoreRemoteExtendsPolicy(() => new ConfigManager().loadConfig(input.config));
  const claimPlan = compileClaimPlan(config);
  const journal = ExecutionJournal.restoreGraphCheckpoint(claimPlan, checkpoint);
  const instanceProjection = journal.getInstanceProjection();
  assertDisplayTarget(instanceProjection, targetRoot);
  const proofSnapshot = readProofChecklistSnapshot(input.proofBin, targetRoot);
  const rendered = renderNativeChecklistProgress(buildNativeChecklistProgress({
    proofSnapshot,
    instanceProjection,
    checkpoint,
    paused: journal.queryReadyWork().length > 0,
    resumed: input.resumed,
    expansionPlan: claimPlan.expansionPlan,
  }));
  const htmlDocument = '<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Proof onboarding progress</title></head><body>'
    + rendered.html
    + '</body></html>';
  writeDisplayOutputs(outputDir, outputTargets, [rendered.json, rendered.text, htmlDocument]);
  return outputTargets;
}

if (require.main === module) {
  runNativeChecklistProgressDisplay(parseNativeChecklistDisplayArgs(process.argv.slice(2)))
    .then(targets => process.stdout.write(`${targets.join('\n')}\n`))
    .catch(error => {
      process.stderr.write(`native checklist display failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
