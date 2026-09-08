/**
 * Read-only report projection for the native onboarding campaign.
 *
 * This module deliberately consumes the journal and the already validated
 * packet export.  It does not create or reinterpret Proof authority.  The
 * report is therefore useful for replaying an old campaign without implying
 * that a reviewed candidate was admitted.
 */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {canonicalGraphCheckpointJson, ExecutionJournal} from '../../../src/snapshot-store';
import type {GraphJournalCheckpointV1} from '../../../src/snapshot-store';
import {canonicalJson} from '../../../src/state-machine/graph/claim-kernel';
import {replayInstanceEvents} from '../../../src/state-machine/graph/instance-kernel';
import type {InstanceClaimProjection, InstanceProjection} from '../../../src/state-machine/graph/instance-kernel';

type Json = Record<string, unknown>;

const SHA256 = /^sha256:[0-9a-f]{64}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const INSTANCE_EVENT_TYPES = new Set([
  'CatalogReconciliationRequested',
  'SubgraphExpanded',
  'ProofCurrentCatalogAuthorityRecorded',
  'ProofCurrentCatalogAuthorityApplied',
  'ControllerItemClaimPublished',
  'NodeGenerationInactivated',
  'NodeGenerationActivated',
  'SubgraphTombstoned',
  'ManagedRunAcquisitionFailed',
  'ManagedRunAcquired',
  'ManagedRunStarted',
  'ManagedRunCancelRequested',
  'ManagedRunTerminated',
]);

export type NativeCampaignReportInput = Readonly<{
  epoch: string;
  checkpoint: unknown;
  priorCheckpoint?: unknown;
  packetRoot: string;
  postflight?: unknown;
}>;

export type NativeCampaignReportRow = Readonly<{
  id: string;
  component_id: string;
  file_path: string;
  proof_file_hash: string;
  claim_id: string;
  packet_payload_fingerprint: string;
  packet_sha256: string;
  packet_bytes: number;
  packet_path: string;
  disposition: 'retained' | 'retried' | 'current';
  candidate_status: 'fallible-historical-candidate';
}>;

export type NativeCampaignComponent = Readonly<{
  id: string;
  specification_rows: number;
  retained_rows: number;
  retried_rows: number;
  audit_gaps: readonly Readonly<{name: string; exit_code: number}>[];
  admission: 'admitted' | 'not-observed';
}>;

export type NativeCampaignReport = Readonly<{
  version: 1;
  kind: 'native-campaign-report';
  epoch: string;
  source: Readonly<{
    checkpoint_graph_semantic_digest: string;
    checkpoint_event_count: number;
    checkpoint_integrity_sha256: string;
    prior_checkpoint_event_count?: number;
    prior_prefix_validated: boolean;
    packet_manifest_status: string;
  }>;
  counts: Readonly<{
    components: number;
    specification_rows: number;
    retained_rows: number;
    retried_rows: number;
    audit_gaps: number;
    admitted_components: number;
  }>;
  components: readonly NativeCampaignComponent[];
  rows: readonly NativeCampaignReportRow[];
  reconcile: Readonly<{
    status: 'completed' | 'failed' | 'not-observed';
    failure_code?: string;
    event_id?: number;
  }>;
  postflight: Readonly<{
    checks: Readonly<Record<string, Readonly<{exit_code: number}>>>;
    failed_checks: readonly string[];
  }>;
  warnings: readonly string[];
}>;

export type NativeCampaignReportArtifacts = Readonly<{
  report: NativeCampaignReport;
  files: Readonly<Record<'json' | 'markdown' | 'dot' | 'svg' | 'png', string | undefined>>;
  warnings: readonly string[];
}>;

function isRecord(value: unknown): value is Json {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function utf8Compare(left: string, right: string): number {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));
}

function utf8Sorted(values: readonly string[]): string[] {
  return [...values].sort(utf8Compare);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function requireSha(value: unknown, label: string): string {
  const result = requireString(value, label);
  if (!SHA256.test(result)) throw new Error(`${label} must be a sha256 digest`);
  return result;
}

function scopeKeys(claim: InstanceClaimProjection, label: string): string[] {
  if (!Array.isArray(claim.scope) || claim.scope.length < 2) {
    throw new Error(`${label} has a detached scope`);
  }
  return claim.scope.map((part, index) => {
    if (!part || part.kind !== 'keyed' || typeof part.key !== 'string' || part.key.length === 0) {
      throw new Error(`${label} scope part ${index} is not keyed`);
    }
    return part.key;
  });
}

function payloadRecord(claim: InstanceClaimProjection, label: string): Json {
  if (!isRecord(claim.payload)) throw new Error(`${label} payload is not an object`);
  return claim.payload;
}

function checkpointForReport(value: unknown, label: string): GraphJournalCheckpointV1 {
  const checkpoint = ExecutionJournal.validateGraphCheckpointIntegrity(value);
  if (!Array.isArray(checkpoint.events) || checkpoint.frontier.eventCount !== checkpoint.events.length ||
      checkpoint.frontier.lastEventId !== (checkpoint.events.length === 0 ? 0 : checkpoint.events.length)) {
    throw new Error(`${label} frontier is not the exact event prefix`);
  }
  checkpoint.events.forEach((event, index) => {
    if (!isRecord(event) || event.eventId !== index + 1) {
      throw new Error(`${label} event IDs are not contiguous`);
    }
  });
  return checkpoint;
}

function instanceProjectionForReport(checkpoint: GraphJournalCheckpointV1): InstanceProjection {
  const events = checkpoint.events.filter(event =>
    (isRecord(event) && INSTANCE_EVENT_TYPES.has(String(event.type))) ||
    (isRecord(event) && ('nodeGenerationId' in event || 'requestId' in event)),
  );
  return replayInstanceEvents(events as never);
}

function validatePriorPrefix(
  checkpoint: GraphJournalCheckpointV1,
  priorInput: unknown,
): {prior: GraphJournalCheckpointV1} {
  const prior = checkpointForReport(priorInput, 'prior checkpoint');
  if (prior.sessionId !== checkpoint.sessionId || prior.graphSemanticDigest !== checkpoint.graphSemanticDigest) {
    throw new Error('prior checkpoint authority differs from final checkpoint');
  }
  if (prior.events.length > checkpoint.events.length ||
      canonicalJson(prior.events) !== canonicalJson(checkpoint.events.slice(0, prior.events.length))) {
    throw new Error('prior checkpoint is not the exact canonical final event prefix');
  }
  return {prior};
}

function safePacketPath(root: string, relative: string, requireRegularFile = true): string {
  if (!relative || path.isAbsolute(relative) || relative.includes('\\')) {
    throw new Error('packet source path must be a relative POSIX path');
  }
  const canonicalRoot = fs.realpathSync(root);
  const normalized = path.posix.normalize(relative);
  if (normalized !== relative || normalized === '.' || normalized.startsWith('../') || normalized.includes('/../')) {
    throw new Error('packet source path escapes packet root');
  }
  const resolved = path.resolve(canonicalRoot, ...relative.split('/'));
  const relativeToRoot = path.relative(canonicalRoot, resolved);
  if (relativeToRoot === '..' || relativeToRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeToRoot)) {
    throw new Error('packet source path escapes packet root');
  }
  if (!requireRegularFile) return resolved;
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('packet source must be a regular file');
  const real = fs.realpathSync(resolved);
  const realRelative = path.relative(canonicalRoot, real);
  if (realRelative === '..' || realRelative.startsWith(`..${path.sep}`) || path.isAbsolute(realRelative)) {
    throw new Error('packet source symlink escapes packet root');
  }
  return real;
}

function exactKeys(value: Json, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort(utf8Compare);
  const sortedExpected = [...expected].sort(utf8Compare);
  if (canonicalJson(actual) !== canonicalJson(sortedExpected)) throw new Error(`${label} has an unexpected closed shape`);
}

function readPacketManifest(packetRootInput: string, checkpoint: GraphJournalCheckpointV1): {root: string; manifest: Json; entries: Json[]} {
  if (!path.isAbsolute(packetRootInput)) throw new Error('packet root must be absolute');
  const root = fs.realpathSync(packetRootInput);
  if (!fs.statSync(root).isDirectory()) throw new Error('packet root must be a directory');
  const manifestPath = safePacketPath(root, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown;
  if (!isRecord(manifest) || manifest.version !== 1 || manifest.kind !== 'retained-native-review-packet-export' ||
      manifest.status !== 'validated-reference-only' || !isRecord(manifest.source) ||
      !Number.isSafeInteger(manifest.packet_count) || !Array.isArray(manifest.packets) ||
      manifest.packet_count !== manifest.packets.length) {
    throw new Error('packet manifest has an invalid closed envelope');
  }
  exactKeys(manifest, ['version', 'kind', 'status', 'source', 'packet_count', 'packets', 'interpretation'], 'packet manifest');
  const source = manifest.source;
  exactKeys(source, ['checkpoint', 'checkpoint_sha256', 'checkpoint_bytes', 'graph_semantic_digest', 'config_authority_files_sha256', 'config_authority_files', 'packet_sources'], 'packet manifest source');
  const checkpointFileBytes = Buffer.from(`${canonicalGraphCheckpointJson(checkpoint)}\n`, 'utf8');
  const checkpointFileSha256 = `sha256:${createHash('sha256').update(checkpointFileBytes).digest('hex')}`;
  if (source.graph_semantic_digest !== checkpoint.graphSemanticDigest ||
      source.checkpoint_sha256 !== checkpointFileSha256 || source.checkpoint_bytes !== checkpointFileBytes.length ||
      !Number.isSafeInteger(source.checkpoint_bytes) || !SHA256.test(String(source.config_authority_files_sha256)) ||
      !Array.isArray(source.config_authority_files) || !Array.isArray(source.packet_sources)) {
    throw new Error('packet manifest source is detached from the final checkpoint authority');
  }
  for (const [index, row] of source.config_authority_files.entries()) {
    if (!isRecord(row)) throw new Error(`packet manifest config authority row ${index} is invalid`);
    exactKeys(row, ['name', 'source', 'bytes', 'sha256'], `packet manifest config authority row ${index}`);
    if (typeof row.name !== 'string' || typeof row.source !== 'string' || !Number.isSafeInteger(row.bytes) || !SHA256.test(String(row.sha256))) {
      throw new Error(`packet manifest config authority row ${index} is invalid`);
    }
  }
  for (const [index, row] of source.packet_sources.entries()) {
    if (!isRecord(row)) throw new Error(`packet manifest packet source row ${index} is invalid`);
    exactKeys(row, ['component_id', 'item_count', 'source_root', 'source_aggregate_present', 'helper_input'], `packet manifest packet source row ${index}`);
    if (typeof row.component_id !== 'string' || !Number.isSafeInteger(row.item_count) || typeof row.source_root !== 'string' ||
        typeof row.source_aggregate_present !== 'boolean' || row.helper_input !== 'validated-packet-files-only') {
      throw new Error(`packet manifest packet source row ${index} is invalid`);
    }
  }
  if (!isRecord(manifest.interpretation) ||
      canonicalJson(manifest.interpretation) !== canonicalJson({
        old_graph_reference: true,
        imported_journal_claims: false,
        approval_or_admission_claimed: false,
        current_proof_recheck_required: true,
      })) {
    throw new Error('packet manifest interpretation is not the closed reference-only contract');
  }
  return {root, manifest, entries: manifest.packets.filter(isRecord)};
}

function manifestEntryById(entries: readonly Json[]): Map<string, Json> {
  const result = new Map<string, Json>();
  for (const entry of entries) {
    exactKeys(entry, ['claim_id', 'payload_fingerprint', 'component_id', 'id', 'file_path', 'proof_file_hash', 'source_relative_path', 'packet_bytes', 'packet_sha256'], 'packet manifest entry');
    const id = requireString(entry.id, 'packet manifest id');
    if (result.has(id)) throw new Error(`packet manifest duplicates ${id}`);
    result.set(id, entry);
  }
  return result;
}

function activeClaims(projection: InstanceProjection, claimName: string): InstanceClaimProjection[] {
  return Object.values(projection.claimsById).filter(claim => claim.active && claim.claim === claimName);
}

function deriveRows(
  projection: InstanceProjection,
  priorProjection: InstanceProjection | undefined,
  packetRoot: string,
  manifestEntries: readonly Json[],
  retryIds: readonly string[] = [],
): {rows: NativeCampaignReportRow[]; components: NativeCampaignComponent[]; admitted: string[]} {
  const requirements = activeClaims(projection, 'native.requirement.item@1');
  const packets = activeClaims(projection, 'native.review.packet@1');
  const priorPacketIds = new Set(
    priorProjection ? activeClaims(priorProjection, 'native.review.packet@1').map(claim => claim.claimId) : [],
  );
  const requirementsById = new Map<string, InstanceClaimProjection>();
  for (const claim of requirements) {
    const payload = payloadRecord(claim, 'requirement item');
    const id = requireString(payload.id, 'requirement item id');
    const component = requireString(payload.component_id, `${id} component_id`);
    const scope = scopeKeys(claim, `requirement ${id}`);
    if (scope[scope.length - 1] !== id || scope[scope.length - 2] !== component) {
      throw new Error(`requirement ${id} has a detached identity or scope`);
    }
    if (requirementsById.has(id)) throw new Error(`active requirements duplicate ${id}`);
    requirementsById.set(id, claim);
  }

  const manifestById = manifestEntryById(manifestEntries);
  const rows: NativeCampaignReportRow[] = [];
  const packetIds = new Set<string>();
  for (const packetClaim of packets) {
    const payload = payloadRecord(packetClaim, 'review packet');
    const id = requireString(payload.id, 'review packet id');
    const component = requireString(payload.component_id, `${id} component_id`);
    const filePath = requireString(payload.file_path, `${id} file_path`);
    const proofFileHash = requireSha(payload.proof_file_hash, `${id} proof_file_hash`);
    const packetScope = scopeKeys(packetClaim, `packet ${id}`);
    if (packetScope[packetScope.length - 1] !== id || packetScope[packetScope.length - 2] !== component) {
      throw new Error(`packet ${id} has a detached identity or scope`);
    }
    const requirement = requirementsById.get(id);
    if (!requirement) throw new Error(`packet ${id} has no active requirement parent`);
    const requirementPayload = payloadRecord(requirement, `requirement ${id}`);
    if (requirementPayload.component_id !== component || requirementPayload.file_path !== filePath ||
        requirementPayload.proof_file_hash !== proofFileHash || canonicalJson(requirement.scope) !== canonicalJson(packetClaim.scope)) {
      throw new Error(`packet ${id} does not match its active requirement identity`);
    }
    if (!packetClaim.parentClaimIds.includes(requirement.claimId)) {
      throw new Error(`packet ${id} is detached from its requirement claim`);
    }
    const candidateParents = packetClaim.parentClaimIds
      .map(claimId => projection.claimsById[claimId])
      .filter(claim => claim?.active && claim.claim === 'native.review.candidate@1' &&
        claim.producerCheckId === 'review-native-item' &&
        canonicalJson(claim.scope) === canonicalJson(packetClaim.scope));
    if (packetClaim.parentClaimIds.length !== 2 || candidateParents.length !== 1 ||
        canonicalJson(candidateParents[0]?.payload) !== canonicalJson(payload.candidate)) {
      throw new Error(`packet ${id} is detached from its reviewed candidate`);
    }
    if (packetClaim.producerCheckId !== 'collect-proof-evidence') {
      throw new Error(`packet ${id} was not published by collect-proof-evidence`);
    }
    if (packetIds.has(id)) throw new Error(`active packets duplicate ${id}`);
    packetIds.add(id);

    const entry = manifestById.get(id);
    if (!entry || entry.claim_id !== packetClaim.claimId || entry.component_id !== component ||
        entry.file_path !== filePath || entry.proof_file_hash !== proofFileHash ||
        typeof entry.source_relative_path !== 'string' || !SHA256.test(String(entry.packet_sha256)) ||
        !HEX64.test(String(entry.payload_fingerprint)) || !Number.isSafeInteger(entry.packet_bytes)) {
      throw new Error(`packet manifest entry for ${id} is detached from its active packet claim`);
    }
    const relative = entry.source_relative_path as string;
    const packetPath = safePacketPath(packetRoot, relative);
    const bytes = fs.readFileSync(packetPath);
    const digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (bytes.length !== entry.packet_bytes || digest !== entry.packet_sha256) {
      throw new Error(`packet file hash or byte count is invalid for ${id}`);
    }
    const packetFile = JSON.parse(bytes.toString('utf8')) as unknown;
    if (!isRecord(packetFile) || canonicalJson(packetFile) !== canonicalJson(payload)) {
      throw new Error(`packet file is not the output-owned payload for ${id}`);
    }
    if (entry.payload_fingerprint !== packetClaim.payloadFingerprint) {
      throw new Error(`packet payload fingerprint is detached for ${id}`);
    }
    rows.push({
      id,
      component_id: component,
      file_path: filePath,
      proof_file_hash: proofFileHash,
      claim_id: packetClaim.claimId,
      packet_payload_fingerprint: entry.payload_fingerprint as string,
      packet_sha256: entry.packet_sha256 as string,
      packet_bytes: entry.packet_bytes as number,
      packet_path: relative,
      disposition: priorPacketIds.has(packetClaim.claimId) ? 'retained' : priorProjection ? 'retried' : 'current',
      candidate_status: 'fallible-historical-candidate',
    });
  }
  if (priorProjection) {
    const retrySet = new Set(retryIds);
    for (const row of rows) {
      if (row.disposition === 'retried' && !retrySet.has(row.id)) {
        throw new Error(`packet ${row.id} is new but has no exact prior retry request`);
      }
    }
    if (retryIds.some(id => !rows.some(row => row.id === id && row.disposition === 'retried'))) {
      throw new Error('prior retry request is missing its retried packet');
    }
  }
  if (rows.length !== requirements.length || requirementsById.size !== packetIds.size ||
      [...requirementsById.keys()].some(id => !packetIds.has(id)) || manifestById.size !== packetIds.size) {
    throw new Error('active requirements and review packets are not an exact set');
  }

  const summaries = activeClaims(projection, 'native.component.summary@1');
  const componentMap = new Map<string, NativeCampaignComponent>();
  for (const summary of summaries) {
    const payload = payloadRecord(summary, 'component summary');
    const id = requireString(payload.component_id, 'component summary component_id');
    const scope = scopeKeys(summary, `component summary ${id}`);
    if (scope[scope.length - 1] !== id || componentMap.has(id)) throw new Error(`component summary ${id} is duplicate or detached`);
    if (!Array.isArray(payload.open_native_checks)) throw new Error(`component summary ${id} has no audit checks`);
    const gaps = payload.open_native_checks.map((value, index) => {
      if (!isRecord(value) || typeof value.name !== 'string' || !Number.isSafeInteger(value.exit_code)) {
        throw new Error(`component summary ${id} audit check ${index} is invalid`);
      }
      return {name: value.name, exit_code: value.exit_code as number};
    });
    const componentRows = rows.filter(row => row.component_id === id);
    const retained = componentRows.filter(row => row.disposition === 'retained').length;
    const retried = componentRows.filter(row => row.disposition === 'retried').length;
    componentMap.set(id, {id, specification_rows: componentRows.length, retained_rows: retained, retried_rows: retried, audit_gaps: gaps, admission: 'not-observed'});
  }
  const rowComponents = new Set(rows.map(row => row.component_id));
  if (componentMap.size !== rowComponents.size || [...rowComponents].some(id => !componentMap.has(id))) {
    throw new Error('component summaries do not cover the active specification rows');
  }

  const admitted = new Set<string>();
  for (const claim of activeClaims(projection, 'proof.admitted_receipt@1')) {
    if (claim.producerCheckId !== 'proof_admit' || claim.scope.length <= 1) continue;
    throw new Error('component admission receipt observed without the compiled plan validator');
  }
  const components = [...componentMap.values()].map(component => ({
    ...component,
    admission: admitted.has(component.id) ? 'admitted' as const : 'not-observed' as const,
  })).sort((left, right) => utf8Compare(left.id, right.id));
  rows.sort((left, right) => utf8Compare(left.component_id, right.component_id) || utf8Compare(left.id, right.id));
  return {rows, components, admitted: utf8Sorted([...admitted])};
}

function retryItemIdsInDelta(
  checkpoint: GraphJournalCheckpointV1,
  priorEventCount: number,
): string[] {
  const result: string[] = [];
  for (const event of checkpoint.events.slice(priorEventCount)) {
    if (!isRecord(event) || event.type !== 'AttemptRetryRequested' || event.checkId !== 'review-native-item' || !Array.isArray(event.scope)) continue;
    const last = event.scope[event.scope.length - 1];
    if (!isRecord(last) || last.kind !== 'keyed' || typeof last.key !== 'string' || last.key.length === 0) {
      throw new Error('retry request has a detached review item scope');
    }
    if (result.includes(last.key)) throw new Error(`retry requests duplicate ${last.key}`);
    result.push(last.key);
  }
  return utf8Sorted(result);
}

function validateRetryDelta(
  checkpoint: GraphJournalCheckpointV1,
  priorEventCount: number,
  rows: readonly NativeCampaignReportRow[],
  retryIds: readonly string[],
): void {
  if (retryIds.length === 0) return;
  const delta = checkpoint.events.slice(priorEventCount);
  for (const id of retryIds) {
    const matching = delta.filter(event => {
      if (!isRecord(event) || !Array.isArray(event.scope)) return false;
      const last = event.scope[event.scope.length - 1];
      return isRecord(last) && last.kind === 'keyed' && last.key === id;
    });
    const has = (type: string, checkId: string): boolean => matching.some(event =>
      isRecord(event) && event.type === type && event.checkId === checkId,
    );
    if (!has('AttemptStarted', 'review-native-item') || !has('ClaimPublished', 'review-native-item') ||
        !has('AttemptCompleted', 'review-native-item') || !has('ClaimPublished', 'collect-proof-evidence') ||
        !has('AttemptCompleted', 'collect-proof-evidence')) {
      throw new Error(`retry request for ${id} has no complete final candidate and packet suffix`);
    }
    if (!rows.some(row => row.id === id && row.disposition === 'retried')) {
      throw new Error(`retry request for ${id} is missing its retried packet`);
    }
  }
}

function reconcileStatus(projection: InstanceProjection, checkpoint: GraphJournalCheckpointV1): NativeCampaignReport['reconcile'] {
  const receipts = activeClaims(projection, 'proof.project_reconciliation_receipt@1')
    .filter(claim => claim.producerCheckId === 'project_reconcile' && claim.scope.length === 1);
  if (receipts.length > 1) throw new Error('active project reconciliation receipts are duplicated');
  const generations = Object.values(projection.generationsById).filter(generation =>
    generation.checkId === 'project_reconcile' && generation.scope.length === 1,
  );
  if (receipts.length === 1) {
    if (generations.length !== 1 || generations[0].status !== 'completed') throw new Error('project reconciliation receipt is detached from completion');
    return {status: 'completed'};
  }
  const failed = [...checkpoint.events].reverse().find(event =>
    isRecord(event) && event.type === 'AttemptFailed' && event.checkId === 'project_reconcile',
  );
  const failedRecord = isRecord(failed) ? failed : undefined;
  if (failedRecord && typeof failedRecord.reason === 'string') {
    const failureEvent = [...checkpoint.events].reverse().find(event =>
      isRecord(event) && event.type === 'ManagedRunAcquisitionFailed' && isRecord(event.binding) &&
      event.binding.checkId === 'project_reconcile',
    );
    const failureRecord = isRecord(failureEvent) ? failureEvent : undefined;
    return {
      status: 'failed',
      failure_code: failureRecord && typeof failureRecord.failureCode === 'string' ? failureRecord.failureCode : failedRecord.reason,
      event_id: typeof failedRecord.eventId === 'number' ? failedRecord.eventId : undefined,
    };
  }
  if (generations.some(generation => generation.status === 'failed')) return {status: 'failed'};
  return {status: 'not-observed'};
}

function postflightSummary(value: unknown): NativeCampaignReport['postflight'] {
  const checks: Record<string, {exit_code: number}> = {};
  if (isRecord(value)) {
    for (const name of ['requirements', 'validation', 'audit', 'checklist', 'status']) {
      const check = value[name];
      if (isRecord(check) && Number.isSafeInteger(check.exit_code)) checks[name] = {exit_code: check.exit_code as number};
    }
  }
  return {
    checks,
    failed_checks: Object.keys(checks).filter(name => checks[name].exit_code !== 0).sort(utf8Compare),
  };
}

export function buildNativeCampaignReport(input: NativeCampaignReportInput): NativeCampaignReport {
  const epoch = requireString(input.epoch, 'epoch');
  const checkpoint = checkpointForReport(input.checkpoint, 'final checkpoint');
  const prior = input.priorCheckpoint === undefined ? undefined : validatePriorPrefix(checkpoint, input.priorCheckpoint);
  const {root: packetRoot, manifest, entries} = readPacketManifest(input.packetRoot, checkpoint);
  const projection = instanceProjectionForReport(checkpoint);
  const priorProjection = prior ? instanceProjectionForReport(prior.prior) : undefined;
  const retryIds = prior ? retryItemIdsInDelta(checkpoint, prior.prior.events.length) : [];
  const derived = deriveRows(projection, priorProjection, packetRoot, entries, retryIds);
  validateRetryDelta(checkpoint, prior?.prior.events.length || 0, derived.rows, retryIds);
  const auditGaps = derived.components.reduce((count, component) => count + component.audit_gaps.length, 0);
  return Object.freeze({
    version: 1,
    kind: 'native-campaign-report',
    epoch,
    source: {
      checkpoint_graph_semantic_digest: checkpoint.graphSemanticDigest,
      checkpoint_event_count: checkpoint.events.length,
      checkpoint_integrity_sha256: `sha256:${checkpoint.integrity.digest}`,
      ...(prior ? {prior_checkpoint_event_count: prior.prior.events.length, prior_prefix_validated: true} : {prior_prefix_validated: false}),
      packet_manifest_status: manifest.status as string,
    },
    counts: {
      components: derived.components.length,
      specification_rows: derived.rows.length,
      retained_rows: derived.rows.filter(row => row.disposition === 'retained').length,
      retried_rows: derived.rows.filter(row => row.disposition === 'retried').length,
      audit_gaps: auditGaps,
      admitted_components: derived.admitted.length,
    },
    components: derived.components,
    rows: derived.rows,
    reconcile: reconcileStatus(projection, checkpoint),
    postflight: postflightSummary(input.postflight),
    warnings: [
      'Reviewed candidates are fallible historical evidence; packet presence does not imply admission.',
      'This report is a replay projection and does not claim a fresh Proof authorization.',
    ],
  }) as NativeCampaignReport;
}

function dotEscape(value: string): string {
  return value
    .replace(/\r\n?|\n/g, '\n')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

function markdownEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/\r\n?|\n/g, ' ');
}

export function renderNativeCampaignReport(report: NativeCampaignReport): {json: string; markdown: string; dot: string} {
  const json = `${canonicalJson(report)}\n`;
  const components = [...report.components].sort((left, right) => utf8Compare(left.id, right.id));
  const rows = [...report.rows].sort((left, right) =>
    utf8Compare(left.component_id, right.component_id) ||
    utf8Compare(left.id, right.id) ||
    utf8Compare(left.packet_path, right.packet_path),
  );
  const markdownPacketPath = (value: string): string => value.split('/').map(segment =>
    encodeURI(segment).replace(/[()[\]<>#?]/g, character => encodeURIComponent(character)),
  ).join('/');
  const countKeys: (keyof NativeCampaignReport['counts'])[] = [
    'components',
    'specification_rows',
    'retained_rows',
    'retried_rows',
    'audit_gaps',
    'admitted_components',
  ];
  const lines = [
    '# Native campaign report',
    '',
    `Epoch: \`${markdownEscape(report.epoch)}\``,
    `Reconciliation: **${report.reconcile.status}**${report.reconcile.failure_code ? ` (${markdownEscape(report.reconcile.failure_code)})` : ''}`,
    `Audit gaps: **${report.counts.audit_gaps}** · Admissions observed: **${report.counts.admitted_components}**`,
    '',
    '| count | value |',
    '|---|---:|',
    ...countKeys.map(name => `| ${markdownEscape(name)} | ${report.counts[name]} |`),
    '',
    '## Components',
    '',
    '| component | specs | retained | retried | audit gaps | admission |',
    '|---|---:|---:|---:|---:|---|',
    ...components.map(component => `| ${markdownEscape(component.id)} | ${component.specification_rows} | ${component.retained_rows} | ${component.retried_rows} | ${component.audit_gaps.length} | ${component.admission} |`),
    '',
    '## Specification rows',
    '',
    '| id | component | independent review / candidate | packet |',
    '|---|---|---|---|',
    ...rows.map(row => `| ${markdownEscape(row.id)} | ${markdownEscape(row.component_id)} | ${row.disposition} / fallible candidate | [packet](${markdownPacketPath(row.packet_path)}) |`),
    '',
    '## Interpretation',
    '',
    '- Rows are sorted by component and specification ID for readability, not execution order.',
    '- Each row pairs one independent review with its packet; the graph omits other workflow stages.',
    ...report.warnings.map(warning => `- ${markdownEscape(warning)}`),
  ];
  const indexToken = (value: number): string => value.toString(16).padStart(8, '0');
  const componentLayouts = components.map((component, componentIndex) => ({
    component,
    componentIndex,
    rows: rows.filter(row => row.component_id === component.id),
    clusterId: `cluster_component_${indexToken(componentIndex)}`,
    headerId: `component_header_${indexToken(componentIndex)}`,
    footerId: `component_footer_${indexToken(componentIndex)}`,
  }));
  const dotLines = [
    'digraph native_campaign {',
    '  graph [rankdir=TB, newrank=true, bgcolor="white", pad="0.2", nodesep="0.45", ranksep="0.32"];',
    '  node [shape=box, style="rounded,filled", fillcolor="#f7f7f7", color="#666666", fontname="Helvetica", fontsize=9, margin="0.06,0.04"];',
    '  edge [color="#b8b8b8", arrowsize=0.45];',
    `  project_root [label="${dotEscape(`Project\nreconcile: ${report.reconcile.status}${report.reconcile.failure_code ? `\n${report.reconcile.failure_code}` : ''}\n${report.counts.audit_gaps} audit gaps / ${report.counts.admitted_components} admissions observed`)}", fillcolor="#fee2e2", color="#b91c1c"];`,
    `  legend [label="${dotEscape('Legend\nblue = retained; amber = retried\nhistorical candidates, not approval\nrows sorted, not execution order\nreview/packet pairs only; not all workflow stages')}", fillcolor="#fff7dd"];`,
  ];
  const headerIds: string[] = [];
  const footerIds: string[] = [];
  const rowIdsByRank: string[][] = [];
  for (const layout of componentLayouts) {
    headerIds.push(layout.headerId);
    footerIds.push(layout.footerId);
    dotLines.push(`  subgraph ${layout.clusterId} {`);
    dotLines.push(`    label="${dotEscape(`${layout.component.id}\n${layout.component.specification_rows} independent specs / ${layout.component.audit_gaps.length} audit gaps`)}"; color="#cccccc"; style="rounded";`);
    dotLines.push(`    ${layout.headerId} [label="${dotEscape(`${layout.component.id}\nindependent review rows`)}", fillcolor="#eaf2ff", color="#2563eb"];`);
    let previousRowId: string | undefined;
    layout.rows.forEach((row, rowIndex) => {
      const rowId = `row_${indexToken(layout.componentIndex)}${indexToken(rowIndex)}`;
      const fillColor = row.disposition === 'retained' ? '#dbeafe' : row.disposition === 'retried' ? '#fef3c7' : '#f3f4f6';
      dotLines.push(`    ${rowId} [label="${dotEscape(`${row.id}\nindependent review + packet\n${row.disposition}`)}", fillcolor="${fillColor}"];`);
      if (!rowIdsByRank[rowIndex]) rowIdsByRank[rowIndex] = [];
      rowIdsByRank[rowIndex].push(rowId);
      if (previousRowId) dotLines.push(`    ${previousRowId} -> ${rowId} [style=invis, weight=100];`);
      previousRowId = rowId;
    });
    if (previousRowId) dotLines.push(`    ${layout.headerId} -> ${layout.rows.length > 0 ? `row_${indexToken(layout.componentIndex)}${indexToken(0)}` : layout.footerId} [style=invis, weight=100];`);
    dotLines.push(`    ${layout.footerId} [label="${dotEscape(`${layout.component.audit_gaps.length} audit gaps\nadmission: ${layout.component.admission}`)}", fillcolor="#fef3c7"];`);
    if (previousRowId) dotLines.push(`    ${previousRowId} -> ${layout.footerId} [style=invis, weight=100];`);
    dotLines.push('  }');
  }
  if (headerIds.length > 1) dotLines.push(`  { rank=same; ${headerIds.join('; ')}; }`);
  for (const rowIds of rowIdsByRank) if (rowIds.length > 1) dotLines.push(`  { rank=same; ${rowIds.join('; ')}; }`);
  if (footerIds.length > 1) dotLines.push(`  { rank=same; ${footerIds.join('; ')}; }`);
  for (const layout of componentLayouts) {
    dotLines.push(`  project_root -> ${layout.headerId} [color="#64748b", penwidth=1.1];`);
    dotLines.push(`  ${layout.footerId} -> reconcile_summary [color="#64748b"];`);
  }
  dotLines.push(`  reconcile_summary [label="${dotEscape(`Shared reconciliation\n${report.reconcile.status}${report.reconcile.failure_code ? `\n${report.reconcile.failure_code}` : ''}\n${report.counts.audit_gaps} audit gaps / ${report.counts.admitted_components} admissions observed`)}", fillcolor="#fee2e2", color="#b91c1c"];`);
  dotLines.push('}');
  return {json, markdown: `${lines.join('\n')}\n`, dot: `${dotLines.join('\n')}\n`};
}

/** Write portable report files and copy only the already hash-validated packets. */
export function emitNativeCampaignReport(
  outputDirectory: string,
  input: NativeCampaignReportInput,
): NativeCampaignReportArtifacts {
  if (!path.isAbsolute(outputDirectory)) throw new Error('report output directory must be absolute');
  fs.mkdirSync(outputDirectory, {recursive: true, mode: 0o700});
  const report = buildNativeCampaignReport(input);
  const rendered = renderNativeCampaignReport(report);
  const jsonPath = path.join(outputDirectory, 'native-campaign-report.json');
  const markdownPath = path.join(outputDirectory, 'native-campaign-report.md');
  const dotPath = path.join(outputDirectory, 'native-campaign-graph.dot');
  fs.writeFileSync(jsonPath, rendered.json, {encoding: 'utf8', mode: 0o600});
  fs.writeFileSync(markdownPath, rendered.markdown, {encoding: 'utf8', mode: 0o600});
  fs.writeFileSync(dotPath, rendered.dot, {encoding: 'utf8', mode: 0o600});
  const packetRoot = fs.realpathSync(input.packetRoot);
  for (const row of report.rows) {
    const source = safePacketPath(packetRoot, row.packet_path);
    const destination = safePacketPath(outputDirectory, row.packet_path, false);
    fs.mkdirSync(path.dirname(destination), {recursive: true, mode: 0o700});
    fs.copyFileSync(source, destination);
  }
  const files: Record<'json' | 'markdown' | 'dot' | 'svg' | 'png', string | undefined> = {
    json: jsonPath,
    markdown: markdownPath,
    dot: dotPath,
    svg: undefined,
    png: undefined,
  };
  const warnings: string[] = [];
  for (const format of ['svg', 'png'] as const) {
    const destination = path.join(outputDirectory, `native-campaign-graph.${format}`);
    try {
      execFileSync('dot', [`-T${format}`, dotPath, '-o', destination], {stdio: 'ignore'});
      files[format] = destination;
    } catch {
      warnings.push(`Graphviz dot could not render ${format}; JSON, Markdown, DOT, and validated packets were retained.`);
    }
  }
  if (warnings.length > 0) {
    fs.writeFileSync(path.join(outputDirectory, 'native-campaign-graph.render-warning.txt'), `${warnings.join('\n')}\n`, {encoding: 'utf8', mode: 0o600});
  }
  return Object.freeze({report, files, warnings});
}

// Kept as a small test seam: callers that already own a replay projection can
// exercise the same identity/packet checks without another journal replay.
export function deriveNativeCampaignRowsForTest(
  projection: InstanceProjection,
  packetRoot: string,
  manifestEntries: readonly Json[],
  priorProjection?: InstanceProjection,
  retryIds?: readonly string[],
): {rows: NativeCampaignReportRow[]; components: NativeCampaignComponent[]; admitted: string[]} {
  return deriveRows(projection, priorProjection, packetRoot, manifestEntries, retryIds);
}
