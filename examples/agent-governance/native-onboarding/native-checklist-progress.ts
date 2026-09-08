/**
 * Read-only progress projection for the checklist-driven onboarding slice.
 *
 * Proof remains the authority for checklist disposition and evidence.  This
 * module only combines that effective snapshot with the Visor instance
 * projection and an optional checkpoint, and deliberately does not persist or
 * infer completion from counts, filenames, or process exit status.
 */
import { canonicalJson, sha256Canonical } from '../../../src/state-machine/graph/claim-kernel';
import type { InstanceProjection } from '../../../src/state-machine/graph/instance-kernel';

type Json = Record<string, unknown>;

const CHECKLIST_SNAPSHOT_CLAIMS = {
  'proof.checklist.snapshot@1': undefined,
  'proof.checklist.research-snapshot@1': 'research',
  'proof.checklist.skeleton-snapshot@1': 'skeleton',
} as const;
type ChecklistSnapshotClaim = keyof typeof CHECKLIST_SNAPSHOT_CLAIMS;

export type NativeChecklistProgressInput = Readonly<{
  proofSnapshot: unknown;
  /** Optional graph claim used to prove that the supplied snapshot is journal-linked. */
  proofSnapshotClaim?: unknown;
  instanceProjection?: InstanceProjection | unknown;
  checkpoint?: unknown;
  /** Persisted checkpoint creation time.  The projector never uses the clock. */
  checkpointTimestamp?: unknown;
  /** Require a journal-linked snapshot for live runner views. */
  requireProofSnapshotClaim?: boolean;
  paused?: boolean;
  resumed?: boolean;
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
      source?: ChecklistSnapshotClaim;
      stage?: 'research' | 'skeleton';
      claim_id?: string;
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
    }>;
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
  items: readonly Readonly<{
    id: string;
    state: NativeChecklistOperationalState;
    check_ids: readonly string[];
  }>[];
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
): { claim_id?: string; source?: ChecklistSnapshotClaim; stage?: 'research' | 'skeleton' } {
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

function checkpointEvidence(
  checkpoint: unknown,
  checkpointTimestamp: unknown
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
  return {
    checkpoint_present: true,
    ...(optionalString(checkpoint.sessionId) ? { session_id: checkpoint.sessionId as string } : {}),
    ...(typeof eventCount === 'number' ? { event_count: eventCount } : {}),
    ...(typeof lastEventId === 'number' ? { last_event_id: lastEventId } : {}),
    ...(graphDigest ? { graph_semantic_digest: graphDigest } : {}),
    ...(optionalString(integrity?.digest) ? { integrity_digest: integrity!.digest as string } : {}),
    ...(typeof timestamp === 'string' ? { checkpoint_timestamp: timestamp } : {}),
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

function operationalState(statuses: readonly string[]): NativeChecklistOperationalState {
  if (statuses.length === 0) return 'unknown';
  if (statuses.includes('unknown')) return 'unknown';
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('running')) return 'running';
  if (statuses.every(status => status === 'completed')) return 'completed';
  if (statuses.some(status => status === 'ready' || status === 'pending')) return 'pending';
  return 'unknown';
}

function collection(
  items: readonly Readonly<{ id: string; status: string; checkId: string }>[],
  known: boolean,
  unexpandedCount = 0
): NativeChecklistOperationalCollection {
  const grouped = new Map<string, { statuses: string[]; checks: string[] }>();
  for (const item of items) {
    const group = grouped.get(item.id) ?? { statuses: [], checks: [] };
    group.statuses.push(item.status);
    if (!group.checks.includes(item.checkId)) group.checks.push(item.checkId);
    grouped.set(item.id, group);
  }
  const output = [...grouped.entries()]
    .sort(([a], [b]) => Buffer.from(a).compare(Buffer.from(b)))
    .map(([id, group]) => ({
      id,
      state: operationalState(group.statuses),
      check_ids: group.checks.sort((a, b) => Buffer.from(a).compare(Buffer.from(b))),
    }));
  const count = (state: NativeChecklistOperationalState) =>
    output.filter(item => item.state === state).length;
  return {
    known,
    known_count: output.length,
    completed_count: count('completed'),
    running_count: count('running'),
    failed_count: count('failed'),
    pending_count: count('pending'),
    unknown_count: count('unknown'),
    unexpanded_count: unexpandedCount,
    items: output,
  };
}

type OperationalProjectionResult = Readonly<{
  value: NativeChecklistProgress['operational'];
  unknown: readonly string[];
}>;

type OperationalKind = 'project' | 'component' | 'specification' | 'batch';

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

function operationalProjection(projection: unknown): OperationalProjectionResult {
  if (!isRecord(projection) || !isRecord(projection.generationsById)) {
    const unknown = { state: 'unknown' as const, known: false, check_ids: [] };
    const empty = (unexpandedCount: number) => collection([], false, unexpandedCount);
    return {
      value: {
        project: unknown,
        components: empty(1),
        specifications: empty(1),
        batches: empty(1),
        discovered: { project: 0, components: 0, specifications: 0, batches: 0, total: 0 },
        unknown_count: 1,
        unexpanded_count: 4,
      },
      unknown: [
        'operational project state is unknown',
        'components are not expanded',
        'specifications are not expanded',
        'batches are not expanded',
      ],
    };
  }
  const generations = Object.entries(projection.generationsById)
    .sort(([left], [right]) => Buffer.from(left).compare(Buffer.from(right)))
    .map(([, generation]) => generation)
    .filter(isRecord)
    .filter(generation => generation.status !== 'inactive');
  const itemsByKind: Record<
    'component' | 'specification' | 'batch',
    Array<{ id: string; status: string; checkId: string }>
  > = {
    component: [],
    specification: [],
    batch: [],
  };
  const projectStatuses: string[] = [];
  const projectChecks: string[] = [];
  const unknownReasons: string[] = [];
  let unknownGenerationCount = 0;
  let componentEvidence = false;
  let specificationEvidence = false;
  let batchEvidence = false;
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
      if (depth <= 1) kind = 'project';
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
    if (kind === 'component' || kind === 'specification' || kind === 'batch') {
      const fallbackId =
        kind === 'component' ? keys[1] : kind === 'specification' ? keys[2] : keys[3];
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
      itemsByKind[kind].push({ id, status, checkId });
      if (kind === 'component') componentEvidence = true;
      if (kind === 'specification') specificationEvidence = true;
      if (kind === 'batch') batchEvidence = true;
      continue;
    }
    unknownGenerationCount++;
    unknownReasons.push(`operational generation at scope depth ${depth} is unexpanded`);
  }
  const project = {
    state: operationalState(projectStatuses),
    known: projectStatuses.length > 0,
    check_ids: [...new Set(projectChecks)].sort((a, b) => Buffer.from(a).compare(Buffer.from(b))),
  };
  // A collection is unknown until its expansion has yielded at least one
  // authoritative unit.  This prevents an empty pre-expansion list from
  // looking like completed zero work.
  const componentUnexpanded = componentEvidence ? 0 : 1;
  const specificationUnexpanded = specificationEvidence ? 0 : 1;
  const batchUnexpanded = batchEvidence ? 0 : 1;
  const components = collection(itemsByKind.component, componentEvidence, componentUnexpanded);
  const specifications = collection(
    itemsByKind.specification,
    specificationEvidence,
    specificationUnexpanded
  );
  const batches = collection(itemsByKind.batch, batchEvidence, batchUnexpanded);
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
      components,
      specifications,
      batches,
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
    unknown: [...new Set(unknownReasons)],
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
  const steps = snapshotSteps(snapshot);
  const requireLiveClaim = input.requireProofSnapshotClaim === true;
  if (requireLiveClaim && input.proofSnapshotClaim === undefined) {
    throw new Error('live checklist progress requires a lineage-linked proof snapshot claim');
  }
  const claimEvidence = validateSnapshotClaim(snapshot, input.proofSnapshotClaim, requireLiveClaim);
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
  const journal = checkpointEvidence(input.checkpoint, input.checkpointTimestamp);
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
  const operationalResult = operationalProjection(input.instanceProjection);
  unknown.push(...operationalResult.unknown);
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
        ...(claimEvidence.source ? { source: claimEvidence.source } : {}),
        ...(claimEvidence.stage ? { stage: claimEvidence.stage } : {}),
        ...(optionalString(snapshot.updated_at)
          ? { updated_at: snapshot.updated_at as string }
          : {}),
      },
      journal,
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
    const checks =
      step.required_checks.length === 0
        ? 'none'
        : `${step.evidence.required_checks_pass ? 'pass' : 'fail'}:${step.required_checks.join(',')}`;
    const verify = step.verify_required
      ? ` verify=${step.evidence.verify_pass === true ? 'pass' : step.evidence.verify_pass === false ? 'fail' : 'missing'}`
      : '';
    const unmet = step.unmet_requires.length === 0 ? '' : ` unmet=${step.unmet_requires.join(',')}`;
    return `${step.state.padEnd(14)} ${step.id} — ${step.title} [checks=${checks}${verify}${unmet}]`;
  });
  const operationalRows = [
    [
      'project',
      progress.operational.project.state,
      progress.operational.project.known ? 'known' : 'unknown',
      progress.operational.project.check_ids.join(',') || 'none',
    ],
    ...(['components', 'specifications', 'batches'] as const).map(kind => {
      const group = progress.operational[kind];
      return [
        kind,
        `${group.known_count} discovered`,
        group.known ? 'expanded' : 'unexpanded',
        `completed=${group.completed_count},running=${group.running_count},failed=${group.failed_count},pending=${group.pending_count},unknown=${group.unknown_count},unexpanded=${group.unexpanded_count}`,
      ];
    }),
  ];
  const operationalItems = (['components', 'specifications', 'batches'] as const).flatMap(kind =>
    progress.operational[kind].items.map(
      item => `${kind}.${item.id}=${item.state} [${item.check_ids.join(',') || 'no-check'}]`
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
      `checkpoint ${journalFields.join(' ')}`,
      `operational discovered=project:${progress.operational.discovered.project} components:${progress.operational.discovered.components} specifications:${progress.operational.discovered.specifications} batches:${progress.operational.discovered.batches} total:${progress.operational.discovered.total} unknown=${progress.operational.unknown_count} unexpanded=${progress.operational.unexpanded_count}`,
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
      `<tr><td class="state"><span class="badge state-${escapedHtml(step.state)}">${escapedHtml(step.state)}</span></td><td>${escapedHtml(step.id)}</td><td>${escapedHtml(step.title)}</td><td>${escapedHtml(step.required_checks.length === 0 ? 'required checks: none / not required' : step.evidence.required_checks_pass ? 'required checks: pass' : 'required checks: fail')}${step.verify_required ? escapedHtml(`; verify: ${step.evidence.verify_pass === true ? 'pass' : step.evidence.verify_pass === false ? 'fail' : 'missing'}`) : ''}${step.unmet_requires.length ? `<br><small>blocked by ${escapedHtml(step.unmet_requires.join(', '))}</small>` : ''}</td></tr>`
  );
  const htmlOperationalRows = operationalRows.map(row => {
    const metrics =
      row[0] === 'project'
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
  const html = `<section data-native-checklist-progress="v1"><style>.native-checklist-progress{font:14px system-ui,sans-serif;color:#222;max-width:100%;overflow-wrap:anywhere}.native-checklist-progress table{border-collapse:collapse;margin:.5rem 0 1rem;min-width:38rem}.native-checklist-progress .table-wrap{max-width:100%;overflow-x:auto}.native-checklist-progress td,.native-checklist-progress th{border:1px solid #bbb;padding:.3rem .5rem;text-align:left;vertical-align:top}.native-checklist-progress .state{font-weight:600}.native-checklist-progress .badge{display:inline-block;border:1px solid #999;border-radius:.25rem;padding:.08rem .35rem;font-weight:600;white-space:nowrap}.native-checklist-progress .state-confirmed{background:#e5f6e8}.native-checklist-progress .state-pending,.native-checklist-progress .state-blocked{background:#fff2cc}.native-checklist-progress .state-stale,.native-checklist-progress .state-failed{background:#ffe1e1}.native-checklist-progress .state-unknown{background:#eee}.native-checklist-progress .metrics{display:flex;flex-wrap:wrap;gap:.25rem .8rem}.native-checklist-progress .metric{white-space:nowrap}.native-checklist-progress small{color:#555}@media(max-width:640px){.native-checklist-progress{font-size:13px}.native-checklist-progress table{min-width:32rem}.native-checklist-progress td,.native-checklist-progress th{padding:.25rem}}</style><div class="native-checklist-progress"><h2>${escapedHtml(progress.checklist.name)}</h2><p class="status-summary"><span class="badge">confirmed=${counts.confirmed}</span> <span class="badge state-pending">pending=${counts.pending}</span> <span class="badge state-blocked">blocked=${counts.blocked}</span> <span class="badge state-stale">stale=${counts.stale}</span> <span class="badge state-failed">failed=${counts.failed}</span> <span class="badge state-unknown">unknown=${counts.unknown}</span> <span>unresolved=${progress.checklist.unresolved_count}</span></p><p><span class="badge">paused=${progress.paused}</span> <span class="badge">resumed=${progress.resumed}</span> <span class="badge">resumable=${progress.resumable}</span>; eligible=${escapedHtml(progress.checklist.eligible_step_ids.join(', ') || 'none')}</p><h3>Checklist stages</h3><div class="table-wrap"><table><thead><tr><th>State</th><th>ID</th><th>Stage</th><th>Evidence</th></tr></thead><tbody>${htmlChecklistRows.join('')}</tbody></table></div><h3>Operational work</h3><div class="table-wrap"><table><thead><tr><th>Unit</th><th>State / discovered</th><th>Coverage</th><th>Counts / checks</th></tr></thead><tbody>${htmlOperationalRows.join('')}</tbody></table></div>${htmlOperationalItems ? `<h4>Known units</h4><ul>${htmlOperationalItems}</ul>` : ''}<p>discovered: project=${progress.operational.discovered.project}, components=${progress.operational.discovered.components}, specifications=${progress.operational.discovered.specifications}, batches=${progress.operational.discovered.batches}; unknown=${progress.operational.unknown_count}; unexpanded=${progress.operational.unexpanded_count}</p><h3>Evidence and checkpoint</h3><p>Proof snapshot ${escapedHtml(progress.evidence.proof_snapshot.schema_version)} source ${escapedHtml(progress.evidence.proof_snapshot.source || 'unlinked')}${progress.evidence.proof_snapshot.stage ? ` stage ${escapedHtml(progress.evidence.proof_snapshot.stage)}` : ''} digest ${escapedHtml(progress.evidence.proof_snapshot.digest)}${progress.evidence.proof_snapshot.claim_id ? ` claim ${escapedHtml(progress.evidence.proof_snapshot.claim_id)}` : ''}<br>Checkpoint ${escapedHtml(journalFields.join(' '))}</p>${htmlUnknown}</div><script type="application/json" id="native-checklist-progress">${escapedHtmlJson(json)}</script></section>`;
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
