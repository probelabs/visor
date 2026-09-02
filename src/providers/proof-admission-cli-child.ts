import { spawn, type ChildProcess } from 'child_process';
import { createHash } from 'crypto';
import { readFileSync, realpathSync, statSync } from 'fs';
import { TextDecoder } from 'util';
import type {
  ManagedAgentRun,
  ManagedRunOutcomeV1,
} from './check-provider.interface';
import { canonicalJson } from '../state-machine/graph/claim-kernel';
import type { ManagedRunBindingV1 } from '../state-machine/graph/instance-kernel';
import {
  governedWireModeFromInvocation,
  governedCanonicalJson,
  proofCanonicalJson,
  proofTopLevelJson,
  type GovernedWireMode,
} from './proof-wire';
export { immutableProofCanonicalValue, proofCanonicalJson, proofGovernedResultDigest, proofPayloadFingerprint, proofTopLevelJson } from './proof-wire';

export const PROOF_ADMISSION_UNAVAILABLE = 'PROOF_ADMISSION_UNAVAILABLE';
export const PROOF_ADMISSION_CLEANUP_FAILED = 'PROOF_ADMISSION_CLEANUP_FAILED';
/** The exact decision wire retained beside the complete admitted receipt. */
export const PROOF_ADMISSION_WIRE_FIELD = '__proof_admission_wire';
/** Proof roles constants: request max includes bytes before execution; output max includes LF. */
export const PROOF_C0_REQUEST_MAX_BYTES = 1463640;
export const PROOF_C0_RESPONSE_MAX_BYTES = 8388608;
export const PROOF_ADMISSION_REQUEST_MAX_BYTES = 2162688;
export const PROOF_ADMISSION_OUTPUT_MAX_BYTES = 2097152;
const REQUEST_LIMIT = PROOF_ADMISSION_REQUEST_MAX_BYTES;
const STDOUT_LIMIT = PROOF_ADMISSION_OUTPUT_MAX_BYTES;
const STDERR_LIMIT = 65536;
// The Proof child may invoke Git for project lineage. Keep this environment
// deliberately small and identical for C0 and every managed onboarding call.
const PROOF_CHILD_ENV = Object.freeze({ PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', GOPROXY: 'off', GOSUMDB: 'off', GOTOOLCHAIN: 'local' });
const COMMAND_TIMEOUT_MS = process.env.NODE_ENV === 'test' && Number(process.env.VISOR_PROOF_C0_TIMEOUT_MS) > 0 ? Number(process.env.VISOR_PROOF_C0_TIMEOUT_MS) : 120000;
const DECISION_VERSION = 'proof.role-result-candidate-cli-decision/v1';
const RECEIPT_VERSION_V1 = 'proof.role-result-candidate-admission/v1';
const RECEIPT_VERSION_V2 = 'proof.role-result-candidate-admission/v2';
const CANDIDATE_ID_DOMAIN = 'proof.role-result-candidate-envelope/id/v1';
const RECEIPT_ID_DOMAIN_V1 = 'proof.role-result-candidate-receipt/id/v1';
const RECEIPT_ID_DOMAIN_V2 = 'proof.role-result-candidate-receipt/id/v2';
const C0_KEYS = ['version', 'role_id', 'role_source', 'stance', 'subject', 'authority', 'output_schema_id', 'output_schema', 'output_schema_digest', 'instructions', 'role_text_digest', 'invocation_digest'] as const;
const C0_REQUEST_KEYS = ['role_id', 'stance', 'subject', 'output_schema_id', 'output_schema'] as const;
const C0_COMPONENT_REQUEST_KEYS = ['role_id', 'stance', 'subject', 'component_authority', 'output_schema_id', 'output_schema'] as const;
const RECEIPT_COMMON_KEYS = ['Version', 'Status', 'CandidateID', 'ProbeResultDigest', 'ProbeCanonicalBytes', 'ClaimID', 'Claim', 'PayloadFingerprint', 'InvocationDigest', 'RoleID', 'Stance', 'Subject', 'ProducerCheckID', 'ParentClaimIDs', 'Binding', 'Termination', 'receipt_id'] as const;
const RECEIPT_V2_KEYS = [...RECEIPT_COMMON_KEYS.slice(0, 16), 'ProjectLineage', 'receipt_id'] as const;
type ExecutableStat = Readonly<{
  realpath: string; dev: number; ino: number; mode: number; uid: number; gid: number; size: number;
  mtimeMs: number; ctimeMs: number; digest: string;
}>;
type ExecutableCapability = object;
type ProofAdmissionCliChildRequest = Readonly<{
  binding: ManagedRunBindingV1;
  workingDirectory: string;
  proofAdmissionRequest: string;
}>;
const executableCapabilities = new WeakMap<object, ExecutableStat>();

function fail(detail: string): never { throw new Error(`PROOF_ADMISSION_INVALID: ${detail}`); }
function plain(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return plain(value) && Reflect.ownKeys(value).length === keys.length &&
    Reflect.ownKeys(value).every((key, index) => typeof key === 'string' && key === keys[index]);
}
/** Closed object check for Proof's canonical decision wire. CanonicalJSON
 * sorts object keys, while the Go candidate request and receipt ID retain
 * struct order at their own boundaries. */
function exactUnordered(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return plain(value) && Reflect.ownKeys(value).length === keys.length &&
    Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key));
}
function json(value: unknown): string {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) fail('value is not JSON');
  return encoded.replace(/[<>&\u2028\u2029]/g, char => {
    const code = char.charCodeAt(0).toString(16).padStart(4, '0');
    return `\\u${code}`;
  });
}
function proofStructJson(fields: Readonly<Record<string, string>>): string {
  return `{${Object.entries(fields).map(([key, value]) => `${json(key)}:${value}`).join(',')}}`;
}

/**
 * The Proof role request is decoded into Go structs before its canonical-byte
 * check.  Most requests already have Go's struct order from authored config,
 * but journal projections intentionally use lexical graph JSON ordering. Keep
 * raw candidate/admission/work-item bytes untouched while rebuilding the
 * typed component-authority members in the order encoding/json emits them.
 */
function goComponentSubject(value: Record<string, unknown>): Record<string, unknown> {
  return {
    version: value.version,
    project_id: value.project_id,
    component_id: value.component_id,
    sorted_owned_paths: value.sorted_owned_paths,
    sorted_dependency_closure: value.sorted_dependency_closure,
    fingerprint: value.fingerprint,
  };
}

function goComponentReceipt(value: Record<string, unknown>): Record<string, unknown> {
  const authorities = Array.isArray(value.component_authorities)
    ? value.component_authorities.map(raw => {
      const authority = raw as Record<string, unknown>;
      return {
        component_id: authority.component_id,
        work_item_digest: authority.work_item_digest,
        subject: goComponentSubject(authority.subject as Record<string, unknown>),
      };
    })
    : value.component_authorities;
  if (value.version !== 'proof.catalog-revalidation-receipt/v2') {
    return {
      version: value.version,
      decision: value.decision,
      project_id: value.project_id,
      project_fingerprint: value.project_fingerprint,
      boundary_fingerprint: value.boundary_fingerprint,
      inventory_claim_id: value.inventory_claim_id,
      catalog_claim_id: value.catalog_claim_id,
      admission_candidate_id: value.admission_candidate_id,
      admission_result_digest: value.admission_result_digest,
      admission_receipt_id: value.admission_receipt_id,
      component_authorities: authorities,
      receipt_id: value.receipt_id,
    };
  }
  const lineage = value.project_lineage && typeof value.project_lineage === 'object'
    ? (() => {
      const raw = value.project_lineage as Record<string, unknown>;
      return {
        version: raw.version,
        fingerprint: raw.fingerprint,
        object_format: raw.object_format,
        baseline_revision: raw.baseline_revision,
      };
    })()
    : null;
  // CatalogRevalidationReceipt.MarshalJSON uses a map for v2, so Go sorts
  // these outer keys lexically after encoding the typed nested values above.
  return {
    admission_candidate_id: value.admission_candidate_id,
    admission_receipt_id: value.admission_receipt_id,
    admission_result_digest: value.admission_result_digest,
    boundary_fingerprint: value.boundary_fingerprint,
    catalog_claim_id: value.catalog_claim_id,
    component_authorities: authorities,
    decision: value.decision,
    inventory_claim_id: value.inventory_claim_id,
    project_fingerprint: value.project_fingerprint,
    project_id: value.project_id,
    project_lineage: lineage,
    receipt_id: value.receipt_id,
    version: value.version,
  };
}

function goComponentAuthority(value: Record<string, unknown>): Record<string, unknown> {
  return {
    work_item_digest: value.work_item_digest,
    subject: goComponentSubject(value.subject as Record<string, unknown>),
    candidate: value.candidate,
    admission: value.admission,
    work_item: value.work_item,
    catalog_revalidation_receipt: goComponentReceipt(value.catalog_revalidation_receipt as Record<string, unknown>),
  };
}

function componentRoleInvocationJson(value: Record<string, unknown>): string {
  const subject = value.subject as Record<string, unknown>;
  const authority = value.component_authority as Record<string, unknown>;
  return json({
    role_id: value.role_id,
    stance: value.stance,
    subject: { kind: subject.kind, id: subject.id, fingerprint: subject.fingerprint },
    component_authority: goComponentAuthority(authority),
    output_schema_id: value.output_schema_id,
    output_schema: value.output_schema,
  });
}

function validUnicode(value: unknown): boolean {
  if (typeof value === 'string') {
    for (let i = 0; i < value.length; i++) {
      const code = value.charCodeAt(i);
      if (code >= 0xd800 && code <= 0xdbff) { const next = value.charCodeAt(i + 1); if (next < 0xdc00 || next > 0xdfff) return false; i++; }
      else if (code >= 0xdc00 && code <= 0xdfff) return false;
    }
    return true;
  }
  if (Array.isArray(value)) return value.every(validUnicode);
  if (plain(value)) return Object.values(value).every(validUnicode);
  return value === null || typeof value === 'boolean' || typeof value === 'number';
}
function digest(domain: string, bytes: Buffer): string {
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  return `sha256:${createHash('sha256').update(domain).update(Buffer.from([0])).update(length).update(bytes).digest('hex')}`;
}
function parseRequest(request: string): { raw: Buffer; candidate: Record<string, unknown>; candidateRaw: Buffer; wireMode: GovernedWireMode } {
  const raw = Buffer.from(request, 'utf8');
  if (raw.length > REQUEST_LIMIT) fail('request exceeds bounded wire limit');
  try { new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { fail('request UTF-8 is invalid'); }
  let outer: unknown;
  try { outer = JSON.parse(request); } catch { fail('request is not JSON'); }
  if (!exact(outer, ['version', 'candidate']) || outer.version !== 'proof.role-result-candidate-cli-request/v1') fail('request envelope is invalid');
  if (typeof outer.candidate !== 'object' || outer.candidate === null) fail('candidate is not an object');
  const candidate = outer.candidate as Record<string, unknown>;
  const candidateKeys = ['Version', 'Invocation', 'InvocationDigest', 'RoleID', 'Stance', 'Subject', 'AttestationVersion', 'ExecutionSource', 'ProbeInvocationDigest', 'IdentityVersion', 'IdentitySource', 'ResultDigest', 'CanonicalBytes', 'ProbeResultBytes', 'VisorPayloadBytes', 'Publication', 'Binding', 'Termination'];
  if (!exact(candidate, candidateKeys) || !validUnicode(candidate)) fail('candidate wire keys or Unicode are invalid');
  const wireMode = governedWireModeFromInvocation(candidate.Invocation);
  validateCandidateShape(candidate, wireMode);
  const marker = request.indexOf('"candidate":');
  const start = marker + '"candidate":'.length;
  const encoded = json(candidate);
  if (marker < 0 || request.slice(start, start + encoded.length) !== encoded || request.slice(start + encoded.length) !== '}') fail('candidate wire is not canonical');
  return { raw, candidate, candidateRaw: Buffer.from(encoded, 'utf8'), wireMode };
}
function b64(value: unknown): Buffer {
  if (typeof value !== 'string' || value.length === 0 || Buffer.from(value, 'base64').toString('base64') !== value) fail('wire bytes are invalid');
  return Buffer.from(value, 'base64');
}
function validateCandidateShape(candidate: Record<string, unknown>, wireMode: GovernedWireMode): void {
  const invocation = candidate.Invocation as Record<string, unknown>;
  const invocationKeys = Object.prototype.hasOwnProperty.call(invocation, 'component_authority')
    ? ['role_id', 'stance', 'subject', 'component_authority', 'output_schema_id', 'output_schema']
    : ['role_id', 'stance', 'subject', 'output_schema_id', 'output_schema'];
  if (!exact(invocation, invocationKeys) || !exact(invocation.subject, ['kind', 'id', 'fingerprint']) || !exact(candidate.Subject, ['kind', 'id', 'fingerprint']) || !equalCanonicalJson(invocation.subject, candidate.Subject)) fail('invocation wire shape is invalid');
  const scope = (value: unknown): void => {
    if (!Array.isArray(value) || value.length < 1 || value.length > 2 || value.some(part => !exact(part, ['Kind', 'ExpansionOwnerCheck', 'Key', 'SubgraphInstanceID']))) fail('scope wire shape is invalid');
  };
  const publication = candidate.Publication as Record<string, unknown>;
  if (!exact(publication, ['Version', 'Type', 'SessionID', 'CheckID', 'Scope', 'NodeInstanceID', 'NodeGenerationID', 'AttemptID', 'Fence', 'ClaimID', 'Claim', 'PayloadFingerprint', 'ProducerCheckID', 'Payload', 'ParentClaimIDs'])) fail('publication wire shape is invalid');
  scope(publication.Scope);
  const binding = candidate.Binding as Record<string, unknown>;
  if (!exact(binding, ['ManagedRunID', 'SessionID', 'CheckID', 'Scope', 'NodeInstanceID', 'NodeGenerationID', 'AttemptID', 'Fence'])) fail('binding wire shape is invalid');
  scope(binding.Scope);
  const termination = candidate.Termination as Record<string, unknown>;
  if (!exact(termination, ['Version', 'Type', 'SessionID', 'Scope', 'Binding', 'CleanupStatus', 'ControllerDecision', 'FailureCode']) || termination.FailureCode !== null) fail('termination wire shape is invalid');
  scope(termination.Scope);
  const terminationBinding = termination.Binding as Record<string, unknown>;
  if (!exact(terminationBinding, ['ManagedRunID', 'SessionID', 'CheckID', 'Scope', 'NodeInstanceID', 'NodeGenerationID', 'AttemptID', 'Fence'])) fail('termination binding wire shape is invalid');
  scope(terminationBinding.Scope);
  const probe = b64(candidate.ProbeResultBytes);
  if (candidate.CanonicalBytes !== probe.length || candidate.ProbeResultBytes !== candidate.VisorPayloadBytes || candidate.ProbeResultBytes !== publication.Payload) fail('candidate bytes are not bound');
  try {
    const payloadText = new TextDecoder('utf-8', { fatal: true }).decode(probe);
    const payload = JSON.parse(payloadText);
    if (!validUnicode(payload) || governedCanonicalJson(payload, wireMode) !== payloadText) fail('candidate payload is not canonical');
  } catch { fail('candidate payload is not valid UTF-8 JSON'); }
}
function equalJson(left: unknown, right: unknown): boolean { return json(left) === json(right); }
function equalCanonicalJson(left: unknown, right: unknown): boolean { return canonicalJson(left) === canonicalJson(right); }
function freeze(value: unknown): unknown {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function proofScope(value: unknown): unknown {
  const scope = value as Record<string, unknown>[];
  return scope.map(segment => ({
    Kind: segment.Kind,
    ExpansionOwnerCheck: segment.ExpansionOwnerCheck,
    Key: segment.Key,
    SubgraphInstanceID: segment.SubgraphInstanceID,
  }));
}
function proofBinding(value: unknown): Record<string, unknown> {
  const binding = value as Record<string, unknown>;
  return {
    ManagedRunID: binding.ManagedRunID,
    SessionID: binding.SessionID,
    CheckID: binding.CheckID,
    Scope: proofScope(binding.Scope),
    NodeInstanceID: binding.NodeInstanceID,
    NodeGenerationID: binding.NodeGenerationID,
    AttemptID: binding.AttemptID,
    Fence: binding.Fence,
  };
}
function proofTermination(value: unknown): Record<string, unknown> {
  const termination = value as Record<string, unknown>;
  return {
    Version: termination.Version,
    Type: termination.Type,
    SessionID: termination.SessionID,
    Scope: proofScope(termination.Scope),
    Binding: proofBinding(termination.Binding),
    CleanupStatus: termination.CleanupStatus,
    ControllerDecision: termination.ControllerDecision,
    FailureCode: termination.FailureCode,
  };
}

/**
 * Reconstruct the historical v1 admission decision wire emitted by Proof's
 * Go structs.  The decision itself is a struct (rather than CanonicalJSON),
 * and its receipt contains nested typed structs whose field order is part of
 * the compatibility contract.  This is used only as an exact byte
 * compatibility check; the original accepted bytes are retained by the
 * caller.
 */
function proofV1DecisionJson(value: Record<string, unknown>): string {
  const receipt = value.receipt;
  const receiptJson = receipt === null ? 'null' : (() => {
    if (!plain(receipt)) return '';
    const typed = receipt as Record<string, unknown>;
    const subject = typed.Subject;
    if (!plain(subject) || !plain(typed.Binding) || !plain(typed.Termination)) return '';
    return proofStructJson({
      Version: json(typed.Version),
      Status: json(typed.Status),
      CandidateID: json(typed.CandidateID),
      ProbeResultDigest: json(typed.ProbeResultDigest),
      ProbeCanonicalBytes: json(typed.ProbeCanonicalBytes),
      ClaimID: json(typed.ClaimID),
      Claim: json(typed.Claim),
      PayloadFingerprint: json(typed.PayloadFingerprint),
      InvocationDigest: json(typed.InvocationDigest),
      RoleID: json(typed.RoleID),
      Stance: json(typed.Stance),
      Subject: json({ kind: (subject as Record<string, unknown>).kind, id: (subject as Record<string, unknown>).id, fingerprint: (subject as Record<string, unknown>).fingerprint }),
      ProducerCheckID: json(typed.ProducerCheckID),
      ParentClaimIDs: json(typed.ParentClaimIDs),
      Binding: json(proofBinding(typed.Binding)),
      Termination: json(proofTermination(typed.Termination)),
      receipt_id: json(typed.receipt_id),
    });
  })();
  if (receipt !== null && receiptJson === '') return '';
  return proofStructJson({
    version: json(value.version),
    status: json(value.status),
    receipt: receiptJson,
    reject_code: json(value.reject_code),
  });
}

function acceptedAdmissionDecisionWire(value: unknown, decoded: string): boolean {
  if (!plain(value)) return false;
  const decision = value as Record<string, unknown>;
  // v2 is the current graph-canonical wire only. A v1 receipt may be either
  // that wire or the exact historical Go struct encoding above.
  const receipt = decision.receipt;
  const version = decision.status === 'ADMITTED' && plain(receipt) ? (receipt as Record<string, unknown>).Version : RECEIPT_VERSION_V1;
  if (version === RECEIPT_VERSION_V2) return proofCanonicalJson(value) === decoded;
  if (version !== RECEIPT_VERSION_V1) return false;
  return proofCanonicalJson(value) === decoded || proofV1DecisionJson(decision) === decoded;
}

function validateReceipt(decision: unknown, candidate: Record<string, unknown>, rawCandidate: Buffer, wireMode: GovernedWireMode): void {
  if (!exactUnordered(decision, ['version', 'status', 'receipt', 'reject_code']) || decision.version !== DECISION_VERSION) fail('decision envelope is invalid');
  const publication = candidate.Publication as Record<string, unknown>;
  const binding = candidate.Binding;
  const termination = candidate.Termination;
  if (decision.status === 'REJECTED') {
    if (decision.receipt !== null || decision.reject_code !== 'CANDIDATE_INVALID') fail('rejection decision is invalid');
    return;
  }
  if (decision.status !== 'ADMITTED' || decision.reject_code !== null || !plain(decision.receipt)) fail('admission decision is invalid');
  const receipt = decision.receipt as Record<string, unknown>;
  const expectedVersion = (candidate.Subject as Record<string, unknown>).kind === 'project' ? RECEIPT_VERSION_V2 : RECEIPT_VERSION_V1;
  const receiptKeys = expectedVersion === RECEIPT_VERSION_V2 ? RECEIPT_V2_KEYS : RECEIPT_COMMON_KEYS;
  if (!exactUnordered(receipt, receiptKeys) || receipt.Version !== expectedVersion) fail('admission version or fields are invalid');
  if (wireMode === 'proof' && expectedVersion !== RECEIPT_VERSION_V2) fail('Proof candidate requires project admission');
  if (wireMode === 'generic' && expectedVersion === RECEIPT_VERSION_V2 && (candidate.Subject as Record<string, unknown>).kind !== 'project') fail('generic project admission is inconsistent');
  const lineage = receipt.ProjectLineage;
  if (expectedVersion === RECEIPT_VERSION_V2 && lineage !== null && (!plain(lineage) || !exactUnordered(lineage, ['version', 'fingerprint', 'object_format', 'baseline_revision']) || lineage.version !== 'proof.git-project-lineage-binding/v1' || typeof lineage.fingerprint !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(lineage.fingerprint) || (lineage.object_format !== 'sha1' && lineage.object_format !== 'sha256') || (lineage.object_format === 'sha1' ? !/^sha1:[0-9a-f]{40}$/.test(String(lineage.baseline_revision)) : !/^sha256:[0-9a-f]{64}$/.test(String(lineage.baseline_revision))))) fail('admission project lineage is invalid');
  if (receipt.Status !== 'ADMITTED' || receipt.CandidateID !== digest(CANDIDATE_ID_DOMAIN, rawCandidate) || receipt.ProbeResultDigest !== candidate.ResultDigest || receipt.ProbeCanonicalBytes !== candidate.CanonicalBytes || receipt.ClaimID !== publication.ClaimID || receipt.Claim !== publication.Claim || receipt.PayloadFingerprint !== publication.PayloadFingerprint || receipt.InvocationDigest !== candidate.InvocationDigest || receipt.RoleID !== candidate.RoleID || receipt.Stance !== candidate.Stance || !exactUnordered(receipt.Subject, ['kind', 'id', 'fingerprint']) || !equalCanonicalJson(receipt.Subject, candidate.Subject) || receipt.ProducerCheckID !== publication.ProducerCheckID || !equalCanonicalJson(receipt.ParentClaimIDs, publication.ParentClaimIDs) || !equalCanonicalJson(receipt.Binding, binding) || !exactUnordered(receipt.Binding, ['ManagedRunID', 'SessionID', 'CheckID', 'Scope', 'NodeInstanceID', 'NodeGenerationID', 'AttemptID', 'Fence']) || !equalCanonicalJson(receipt.Termination, termination) || !exactUnordered(receipt.Termination, ['Version', 'Type', 'SessionID', 'Scope', 'Binding', 'CleanupStatus', 'ControllerDecision', 'FailureCode']) || typeof receipt.receipt_id !== 'string') fail('admission receipt identity is invalid');
  // ReceiptID is a Proof domain digest over the Go struct's json.Marshal
  // field order. The surrounding CLI decision is canonical-key JSON, so
  // iterating the parsed receipt's keys here would silently hash a different
  // byte sequence.
  const subject = receipt.Subject as Record<string, unknown>;
  const unsignedFields: Record<string, string> = {
    Version: json(receipt.Version),
    Status: json(receipt.Status),
    CandidateID: json(receipt.CandidateID),
    ProbeResultDigest: json(receipt.ProbeResultDigest),
    ProbeCanonicalBytes: json(receipt.ProbeCanonicalBytes),
    ClaimID: json(receipt.ClaimID),
    Claim: json(receipt.Claim),
    PayloadFingerprint: json(receipt.PayloadFingerprint),
    InvocationDigest: json(receipt.InvocationDigest),
    RoleID: json(receipt.RoleID),
    Stance: json(receipt.Stance),
    Subject: json({ kind: subject.kind, id: subject.id, fingerprint: subject.fingerprint }),
    ProducerCheckID: json(receipt.ProducerCheckID),
    ParentClaimIDs: json(receipt.ParentClaimIDs),
    Binding: json(proofBinding(receipt.Binding)),
    Termination: json(proofTermination(receipt.Termination)),
  };
  if (expectedVersion === RECEIPT_VERSION_V2) {
    // ProjectLineage is a Go struct nested in the receipt preimage. The
    // decision wire itself is CanonicalJSON, so its parsed map order must not
    // leak into this nested encoding.
    unsignedFields.ProjectLineage = json(lineage === null ? null : (() => {
      const projectLineage = lineage as Record<string, unknown>;
      return {
        version: projectLineage.version,
        fingerprint: projectLineage.fingerprint,
        object_format: projectLineage.object_format,
        baseline_revision: projectLineage.baseline_revision,
      };
    })());
  }
  const unsigned = expectedVersion === RECEIPT_VERSION_V2
    ? proofTopLevelJson(unsignedFields)
    : proofStructJson(unsignedFields);
  const receiptDomain = expectedVersion === RECEIPT_VERSION_V2 ? RECEIPT_ID_DOMAIN_V2 : RECEIPT_ID_DOMAIN_V1;
  if (receipt.receipt_id !== digest(receiptDomain, Buffer.from(unsigned, 'utf8'))) fail('admission receipt ID is invalid');
}

function executableStat(path: string): ExecutableStat | undefined {
  try {
    if (!path.startsWith('/')) return undefined;
    const realpath = realpathSync(path);
    const stat = statSync(realpath);
    if (!stat.isFile() || (stat.mode & 0o111) === 0) return undefined;
    const bytes = readFileSync(realpath);
    return Object.freeze({ realpath, dev: stat.dev, ino: stat.ino, mode: stat.mode, uid: stat.uid, gid: stat.gid, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, digest: createHash('sha256').update(bytes).digest('hex') });
  } catch { return undefined; }
}
function sameExecutable(left: ExecutableStat, right: ExecutableStat | undefined): boolean {
  return !!right && left.realpath === right.realpath && left.dev === right.dev && left.ino === right.ino && left.mode === right.mode && left.uid === right.uid && left.gid === right.gid && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs && left.digest === right.digest;
}
function executableCapability(path: string): ExecutableCapability | undefined {
  const identity = executableStat(path);
  if (!identity) return undefined;
  const capability = Object.freeze({});
  executableCapabilities.set(capability, identity);
  return capability;
}
function capabilityIdentity(value: unknown): ExecutableStat | undefined {
  return value && typeof value === 'object' ? executableCapabilities.get(value) : undefined;
}
export function proofAdmissionCapabilityValid(value: unknown): value is object {
  const identity = capabilityIdentity(value);
  return !!identity && sameExecutable(identity, executableStat(identity.realpath));
}
function groupAbsent(pid: number): boolean {
  try { process.kill(-pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH'; }
}
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try { process.kill(-pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
}

type ProofCommandResult = Readonly<{ status: number | null; signal: NodeJS.Signals | null; stdout: Buffer; stderr: Buffer }>;
type ProofCommandHandle = Readonly<{ result: Promise<ProofCommandResult>; cancel: () => void }>;

function runBoundedProofCommand(
  executable: ExecutableStat,
  args: readonly string[],
  input: string,
  workingDirectory: string,
  stdoutLimit: number,
): ProofCommandHandle {
  let cancelCommand: () => void = () => undefined;
  const result = new Promise<ProofCommandResult>((resolve, reject) => {
    let child: ChildProcess | undefined, pid: number | undefined, status: number | null = null, signal: NodeJS.Signals | null = null, stdout: Buffer = Buffer.alloc(0), stderr: Buffer = Buffer.alloc(0), stdoutEnded = false, stderrEnded = false, closeSeen = false, settled = false, terminationRequested = false, termSent = false, killSent = false, inputWritten = false, timedOut = false;
    let deadlineTimer: ReturnType<typeof setTimeout> | undefined, killTimer: ReturnType<typeof setTimeout> | undefined, reapTimer: ReturnType<typeof setTimeout> | undefined, reapDeadline = 0;

    const clearTimers = () => { if (deadlineTimer) clearTimeout(deadlineTimer); if (killTimer) clearTimeout(killTimer); if (reapTimer) clearTimeout(reapTimer); deadlineTimer = undefined; killTimer = undefined; reapTimer = undefined; };
    const closeStreams = () => { if (typeof child?.stdin?.destroy === 'function') child.stdin.destroy(); if (typeof child?.stdout?.destroy === 'function') child.stdout.destroy(); if (typeof child?.stderr?.destroy === 'function') child.stderr.destroy(); stdoutEnded = true; stderrEnded = true; };
    const clearListeners = () => { for (const value of [child, child?.stdin, child?.stdout, child?.stderr]) if (value && typeof (value as any).removeAllListeners === 'function') (value as any).removeAllListeners(); };
    const rejectUnavailable = (cleanupFailed = false) => {
      if (settled) return;
      settled = true;
      clearTimers();
      closeStreams();
      clearListeners();
      reject(new Error(cleanupFailed ? PROOF_ADMISSION_CLEANUP_FAILED : PROOF_ADMISSION_UNAVAILABLE));
    };
    const proveGroupGone = (): boolean => !pid || groupAbsent(pid);
    const reapOrReject = () => {
      if (settled || !pid) return;
      if (proveGroupGone() && closeSeen && stdoutEnded && stderrEnded) { settle(); return; }
      if (!reapDeadline) reapDeadline = Date.now() + 2000;
      if (!reapTimer) reapTimer = setTimeout(() => { reapTimer = undefined; if (proveGroupGone() && closeSeen && stdoutEnded && stderrEnded) settle(); else if (Date.now() >= reapDeadline) rejectUnavailable(true); else reapOrReject(); }, 10);
    };
    const settle = () => {
      if (settled || !closeSeen || !stdoutEnded || !stderrEnded || !pid) return;
      if (!proveGroupGone()) return reapOrReject();
      settled = true;
      clearTimers();
      closeStreams();
      if (timedOut || !inputWritten) {
        reject(new Error(PROOF_ADMISSION_UNAVAILABLE));
        return;
      }
      resolve(Object.freeze({ status, signal, stdout, stderr }));
    };
    const forceStop = () => {
      terminationRequested = true;
      timedOut = true;
      closeStreams();
      if (!pid) {
        rejectUnavailable();
        return;
      }
      if (!proveGroupGone() && !termSent) {
        termSent = true;
        try { signalGroup(pid, 'SIGTERM'); } catch { rejectUnavailable(true); return; }
      }
      if (!killTimer) {
        killTimer = setTimeout(() => {
          killTimer = undefined;
          if (pid && !proveGroupGone() && !killSent) {
            killSent = true;
            try { signalGroup(pid, 'SIGKILL'); } catch { rejectUnavailable(true); }
          }
          reapOrReject();
        }, 250);
      }
      reapOrReject();
    };
    cancelCommand = forceStop;
    const append = (current: Buffer, chunk: Buffer, limit: number): { value: Buffer; overflow: boolean } => {
      const remaining = limit - current.length;
      if (remaining <= 0) return { value: current, overflow: chunk.length > 0 };
      return { value: Buffer.concat([current, chunk.subarray(0, remaining)]), overflow: chunk.length > remaining };
    };

    try {
      child = spawn(executable.realpath, [...args], {
        cwd: workingDirectory,
        env: PROOF_CHILD_ENV,
        shell: false,
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      pid = child.pid;
      child.stdout?.on('data', (chunk: Buffer) => {
        const appended = append(stdout, chunk, stdoutLimit);
        stdout = appended.value;
        if (appended.overflow) forceStop();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        const appended = append(stderr, chunk, STDERR_LIMIT);
        stderr = appended.value;
        if (appended.overflow) forceStop();
      });
      child.stdout?.on('end', () => { stdoutEnded = true; settle(); });
      child.stderr?.on('end', () => { stderrEnded = true; settle(); });
      child.once('spawn', () => {
        pid = child?.pid;
        if (!pid || terminationRequested || !sameExecutable(executable, executableStat(executable.realpath))) {
          forceStop();
          return;
        }
        child?.stdin?.once('error', forceStop);
        child?.stdin?.end(input, 'utf8', () => {
          inputWritten = true;
          settle();
        });
      });
      child.once('error', forceStop);
      child.once('exit', (code, exitedSignal) => {
        status = code;
        signal = exitedSignal;
        settle();
      });
      child.once('close', () => {
        closeSeen = true;
        if (!pid) rejectUnavailable();
        else if (!proveGroupGone()) forceStop();
        else settle();
      });
      deadlineTimer = setTimeout(forceStop, COMMAND_TIMEOUT_MS);
    } catch {
      rejectUnavailable();
    }
  });
  return Object.freeze({ result, cancel: () => cancelCommand() });
}

export function goCompatibleProofJson(value: unknown): string { return json(value); }
export function proofExecutableAvailable(path: string | undefined): boolean {
  return process.platform !== 'win32' && typeof path === 'string' && executableStat(path) !== undefined;
}
export function createProofAdmissionCapability(path: string): object {
  const capability = executableCapability(path);
  if (!capability) fail(PROOF_ADMISSION_UNAVAILABLE);
  return capability;
}
export function createProofAdmissionCliChildForFocusedTest(path: string): object {
  return createProofAdmissionCapability(path);
}

/** Resolve authored role authority with the same opaque executable capability used by admission. */
export async function resolveProofRoleInvocation(
  capability: unknown,
  request: Readonly<Record<string, unknown>>,
  workingDirectory: string,
  signal?: AbortSignal
): Promise<Readonly<Record<string, unknown>>> {
  const executable = capabilityIdentity(capability);
  const component = plain(request) && Object.prototype.hasOwnProperty.call(request, 'component_authority');
  const requestKeys = component ? C0_COMPONENT_REQUEST_KEYS : C0_REQUEST_KEYS;
  if (process.platform === 'win32' || !executable || !workingDirectory.startsWith('/') || !exact(request, requestKeys)) throw new Error(PROOF_ADMISSION_UNAVAILABLE);
  if (!sameExecutable(executable, executableStat(executable.realpath))) throw new Error(PROOF_ADMISSION_UNAVAILABLE);
  const input = component ? componentRoleInvocationJson(request as Record<string, unknown>) : json(request);
  if (Buffer.byteLength(input, 'utf8') > PROOF_C0_REQUEST_MAX_BYTES || !validUnicode(request)) throw new Error(PROOF_ADMISSION_UNAVAILABLE);
  let normalizedInput: Record<string, unknown> | undefined;
  if (component) {
    try {
      normalizedInput = JSON.parse(input) as Record<string, unknown>;
    } catch {
      throw new Error(PROOF_ADMISSION_UNAVAILABLE);
    }
  }
  if (signal?.aborted) throw new Error(PROOF_ADMISSION_UNAVAILABLE);
  const command = runBoundedProofCommand(executable, ['resolve-role-invocation'], input, workingDirectory, PROOF_C0_RESPONSE_MAX_BYTES);
  const cancel = () => command.cancel();
  signal?.addEventListener('abort', cancel, { once: true });
  let result: ProofCommandResult;
  try { result = await command.result; } finally { signal?.removeEventListener('abort', cancel); }
  if (!sameExecutable(executable, executableStat(executable.realpath)) || result.status !== 0 || result.signal || result.stderr.length !== 0 || result.stdout.length === 0 || result.stdout[result.stdout.length - 1] !== 10) throw new Error(PROOF_ADMISSION_UNAVAILABLE);
  let stdout: string;
  try { stdout = new TextDecoder('utf-8', { fatal: true }).decode(result.stdout); } catch { throw new Error(PROOF_ADMISSION_UNAVAILABLE); }
  const output = stdout.slice(0, -1);
  if (output.includes('\n') || output.includes('\r')) throw new Error(PROOF_ADMISSION_UNAVAILABLE);
  let value: Record<string, unknown>;
  try { value = JSON.parse(output) as Record<string, unknown>; } catch { throw new Error(PROOF_ADMISSION_UNAVAILABLE); }
  const responseKeys = component ? ['version', 'role_id', 'role_source', 'stance', 'subject', 'component_authority', 'authority', 'output_schema_id', 'output_schema', 'output_schema_digest', 'instructions', 'role_text_digest', 'invocation_digest'] : C0_KEYS;
  if (
    !exact(value, responseKeys) || json(value) !== output || value.version !== 'proof.role-invocation/v1' ||
    value.role_id !== request.role_id || value.stance !== request.stance || !equalJson(value.subject, request.subject) ||
    (component && (!normalizedInput || proofCanonicalJson(value.component_authority) !== proofCanonicalJson(normalizedInput.component_authority))) ||
    value.output_schema_id !== request.output_schema_id || value.output_schema !== request.output_schema ||
    typeof value.instructions !== 'string' || value.instructions.length === 0
  ) throw new Error(PROOF_ADMISSION_UNAVAILABLE);
  return Object.freeze(value);
}

type ProofManagedCommand =
  | readonly ['admit-candidate']
  | readonly ['onboarding', 'inventory']
  | readonly ['onboarding', 'revalidate']
  | readonly ['onboarding', 'work-items'];

interface ProofManagedCliRequest {
  readonly binding: ManagedRunBindingV1;
  readonly workingDirectory: string;
  readonly command: ProofManagedCommand;
  readonly input: string;
  readonly inputLimit: number;
  readonly outputLimit: number;
  /** Proof onboarding projections are emitted by its human-readable CLI as
   * indented JSON. Candidate admission remains byte-canonical. */
  readonly outputCanonical: boolean;
  readonly projectOutput: (value: unknown, raw: string) => unknown;
}

function validProofManagedCommand(value: unknown): value is ProofManagedCommand {
  return Array.isArray(value) && (
    (value.length === 1 && value[0] === 'admit-candidate') ||
    (value.length === 2 && value[0] === 'onboarding' &&
      (value[1] === 'inventory' || value[1] === 'revalidate' || value[1] === 'work-items'))
  );
}

/** Shared bounded, cancellable Proof process boundary for governed graph providers. */
export function startProofManagedCliChild(request: ProofManagedCliRequest, executablePath: unknown): ManagedAgentRun {
  if (process.platform === 'win32' || !request.workingDirectory ||
      !validProofManagedCommand(request.command) || typeof request.input !== 'string' ||
      !Number.isSafeInteger(request.inputLimit) || request.inputLimit < 0 ||
      !Number.isSafeInteger(request.outputLimit) || request.outputLimit < 2 ||
      typeof request.outputCanonical !== 'boolean') {
    throw new Error(PROOF_ADMISSION_UNAVAILABLE);
  }
  if (Buffer.byteLength(request.input, 'utf8') > request.inputLimit) throw new Error(PROOF_ADMISSION_UNAVAILABLE);
  const binding = request.binding;
  const executable = capabilityIdentity(executablePath);
  if (!executable) throw new Error(PROOF_ADMISSION_UNAVAILABLE);
  let child: ChildProcess | undefined;
  let pid: number | undefined;
  let exitCode: number | null | undefined;
  let signal: NodeJS.Signals | null | undefined;
  let stdout = Buffer.alloc(0), stderr = Buffer.alloc(0);
  let stdoutEnd = false, stderrEnd = false, closeSeen = false, writeDone = false;
  let cleaned = false;
  let failed: string | undefined;
  let output: unknown;
  let accepted = false;
  let terminationRequested = false;
  let termSent = false, killSent = false, timer: ReturnType<typeof setTimeout> | undefined, reapTimer: ReturnType<typeof setTimeout> | undefined;
  let cleanupFailed = false;
  let reapDeadline = 0;
  let resolveStarted!: (value: { version: 1; kind: 'started'; binding: ManagedRunBindingV1 }) => void;
  let rejectStarted!: (reason: unknown) => void;
  const started = new Promise<any>((resolve, reject) => { resolveStarted = resolve; rejectStarted = reject; });
  let resolveOutcome!: (value: ManagedRunOutcomeV1) => void;
  let rejectCleanup!: (reason: unknown) => void;
  let resolveCleanup!: (value: { version: 1; kind: 'cleanup'; binding: ManagedRunBindingV1; status: 'clean'; activeChildren: 0; activeResources: 0 }) => void;
  const outcome = new Promise<ManagedRunOutcomeV1>(resolve => { resolveOutcome = resolve; });
  const cleanup = new Promise<any>((resolve, reject) => { resolveCleanup = resolve; rejectCleanup = reject; });
  const failOnce = (reason: string) => { if (!failed) failed = reason; };
  const closeStreams = () => {
    for (const stream of [child?.stdin, child?.stdout, child?.stderr]) {
      if (stream && typeof (stream as any).destroy === 'function') (stream as any).destroy();
    }
    stdoutEnd = true; stderrEnd = true;
  };
  const settleBeforePid = () => {
    if (cleaned) return;
    cleaned = true;
    if (timer) { clearTimeout(timer); timer = undefined; }
    if (reapTimer) { clearTimeout(reapTimer); reapTimer = undefined; }
    closeStreams();
    child?.removeAllListeners(); child?.stdin?.removeAllListeners(); child?.stdout?.removeAllListeners(); child?.stderr?.removeAllListeners();
    resolveOutcome(Object.freeze({ version: 1, kind: 'failed', binding }));
    resolveCleanup(Object.freeze({ version: 1, kind: 'cleanup', binding, status: 'clean', activeChildren: 0, activeResources: 0 }));
  };
  const reapOrSettle = () => {
    if (cleaned || !pid) return;
    if (groupAbsent(pid)) { settle(); return; }
    if (!reapDeadline) reapDeadline = Date.now() + 2000;
    if (!reapTimer) reapTimer = setTimeout(() => {
      reapTimer = undefined;
      if (pid && groupAbsent(pid)) settle();
      else if (Date.now() >= reapDeadline) {
        cleanupFailed = true;
        failOnce('process group reap timed out');
        cleaned = true;
        if (timer) { clearTimeout(timer); timer = undefined; }
        closeStreams();
        child?.removeAllListeners(); child?.stdin?.removeAllListeners(); child?.stdout?.removeAllListeners(); child?.stderr?.removeAllListeners();
        resolveOutcome(Object.freeze({ version: 1, kind: 'failed', binding }));
        rejectCleanup(new Error(PROOF_ADMISSION_CLEANUP_FAILED));
      } else reapOrSettle();
    }, 10);
  };
  const killIfNeeded = () => {
    if (!pid || groupAbsent(pid)) return;
    closeStreams();
    if (!termSent) {
      termSent = true;
      try { signalGroup(pid, 'SIGTERM'); } catch { cleanupFailed = true; failOnce('termination failed'); }
    }
    if (!timer) timer = setTimeout(() => {
      timer = undefined;
      if (pid && !groupAbsent(pid) && !killSent) {
        killSent = true;
        try { signalGroup(pid, 'SIGKILL'); } catch { cleanupFailed = true; failOnce('termination failed'); }
      }
      reapOrSettle();
    }, 250);
    reapOrSettle();
  };
  const settle = () => {
    if (!closeSeen || !stdoutEnd || !stderrEnd || !pid || !groupAbsent(pid)) return;
    if (cleaned) return;
    cleaned = true;
    if (timer) { clearTimeout(timer); timer = undefined; }
    if (reapTimer) { clearTimeout(reapTimer); reapTimer = undefined; }
    child?.removeAllListeners(); child?.stdin?.removeAllListeners(); child?.stdout?.removeAllListeners(); child?.stderr?.removeAllListeners();
    if (cleanupFailed) {
      resolveOutcome(Object.freeze({ version: 1, kind: 'failed', binding }));
      rejectCleanup(new Error(PROOF_ADMISSION_CLEANUP_FAILED));
      return;
    }
    if (!failed && accepted && writeDone && exitCode === 0 && signal === null && stderr.length === 0 && output !== undefined) {
      resolveOutcome(Object.freeze({ version: 1, kind: 'succeeded', binding, summary: Object.freeze({ issues: [], output }) }));
    } else {
      resolveOutcome(Object.freeze({ version: 1, kind: 'failed', binding }));
    }
    resolveCleanup(Object.freeze({ version: 1, kind: 'cleanup', binding, status: 'clean', activeChildren: 0, activeResources: 0 }));
  };
  const inspectStdout = () => {
    if (failed || stdout.length > request.outputLimit || stdout.length < 2 || stdout[stdout.length - 1] !== 10) return;
    const raw = stdout.subarray(0, stdout.length - 1);
    // Candidate admission remains a one-line canonical JSON decision. The
    // onboarding commands use Proof's human-readable JSON projection, which
    // is intentionally indented and therefore contains embedded newlines.
    if (request.outputCanonical && raw.includes(10)) { failOnce('decision framing invalid'); return; }
    let decoded: string;
    try { decoded = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { failOnce('decision UTF-8 invalid'); return; }
    try {
      const parsedOutput = JSON.parse(decoded);
      if (request.outputCanonical && !acceptedAdmissionDecisionWire(parsedOutput, decoded)) failOnce('decision is not canonical');
      else {
        output = freeze(request.projectOutput(parsedOutput, decoded));
        accepted = true;
      }
    } catch { failOnce('decision protocol invalid'); }
  };
  const attach = (proc: ChildProcess) => {
    proc.stdout?.on('data', (chunk: Buffer) => { const remaining = request.outputLimit - stdout.length; const append = Math.min(chunk.length, remaining); if (append > 0) stdout = Buffer.concat([stdout, chunk.subarray(0, append)]); if (chunk.length > remaining) { failOnce('stdout limit exceeded'); killIfNeeded(); } });
    proc.stderr?.on('data', (chunk: Buffer) => { const remaining = STDERR_LIMIT - stderr.length; const append = Math.min(chunk.length, remaining); if (append > 0) stderr = Buffer.concat([stderr, chunk.subarray(0, append)]); if (chunk.length > remaining) { failOnce('stderr limit exceeded'); killIfNeeded(); } });
    proc.stdout?.on('end', () => { stdoutEnd = true; inspectStdout(); settle(); });
    proc.stderr?.on('end', () => { stderrEnd = true; settle(); });
    proc.on('error', () => {
      failOnce('child process failed');
      rejectStarted(new Error(PROOF_ADMISSION_UNAVAILABLE));
      closeSeen = true; stdoutEnd = true; stderrEnd = true;
      if (!pid) settleBeforePid(); else { killIfNeeded(); settle(); }
    });
    proc.on('exit', (code, exitedSignal) => {
      exitCode = code; signal = exitedSignal;
      settle();
    });
    proc.on('close', () => {
      closeSeen = true;
      if (pid && !groupAbsent(pid)) { failOnce('detached process group survived parent'); killIfNeeded(); }
      settle();
    });
  };
  if (!sameExecutable(executable, executableStat(executable.realpath))) throw new Error(PROOF_ADMISSION_UNAVAILABLE);
  try {
    child = spawn(executable.realpath, [...request.command], { cwd: request.workingDirectory, env: PROOF_CHILD_ENV, shell: false, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    attach(child);
    child.once('spawn', () => {
      pid = child?.pid;
      if (!pid) { failOnce('child process did not expose a pid'); rejectStarted(new Error(PROOF_ADMISSION_UNAVAILABLE)); settleBeforePid(); return; }
      resolveStarted(Object.freeze({ version: 1 as const, kind: 'started' as const, binding }));
      if (terminationRequested) { killIfNeeded(); return; }
      if (!sameExecutable(executable, executableStat(executable.realpath))) { failOnce('executable changed before write'); killIfNeeded(); return; }
      if (request.input.length === 0) {
        // `onboarding inventory` is a no-stdin command. Destroy the pipe
        // without writing: a fast Proof process may otherwise emit EPIPE
        // after it has already produced the valid inventory projection.
        writeDone = true;
        child?.stdin?.destroy();
        settle();
      } else {
        child?.stdin?.once('error', () => { failOnce('request write failed'); killIfNeeded(); });
        child?.stdin?.end(request.input, 'utf8', () => { writeDone = true; settle(); });
      }
    });
  } catch {
    failOnce('child acquisition failed'); rejectStarted(new Error(PROOF_ADMISSION_UNAVAILABLE));
    if (pid) { killIfNeeded(); } else { closeSeen = true; stdoutEnd = true; stderrEnd = true; settleBeforePid(); }
  }
  const terminate = async () => { if (!cleaned) { terminationRequested = true; if (pid) killIfNeeded(); } await cleanup; return { version: 1 as const, kind: 'cancelled' as const, binding, reason: 'deadline' as const }; };
  return Object.freeze({
    binding,
    started,
    outcome,
    cancel: async (reason: 'deadline', fence: number) => { if (fence !== binding.fence) throw new Error('stale cancellation fence'); return terminate(); },
    close: async () => { if (!cleaned) { terminationRequested = true; if (pid) killIfNeeded(); } return cleanup; },
  });
}

export function startProofAdmissionCliChild(request: ProofAdmissionCliChildRequest, executablePath: unknown): ManagedAgentRun {
  const parsed = parseRequest(request.proofAdmissionRequest);
  return startProofManagedCliChild({
    binding: request.binding,
    workingDirectory: request.workingDirectory,
    command: ['admit-candidate'],
    input: request.proofAdmissionRequest,
    inputLimit: REQUEST_LIMIT,
    outputLimit: STDOUT_LIMIT,
    outputCanonical: true,
    projectOutput: (value, raw) => {
      validateReceipt(value, parsed.candidate, parsed.candidateRaw, parsed.wireMode);
      const decision = value as Record<string, unknown>;
      if (decision.status !== 'ADMITTED' || !plain(decision.receipt)) fail('candidate was not admitted');
      // Claim payloads are recursively canonicalized by Visor. Preserve the
      // full receipt as fields for graph consumers and retain the exact Proof
      // decision wire so revalidation can pass it back without synthesizing
      // or reordering the admission envelope.
      return { ...decision.receipt, [PROOF_ADMISSION_WIRE_FIELD]: raw };
    },
  }, executablePath);
}
