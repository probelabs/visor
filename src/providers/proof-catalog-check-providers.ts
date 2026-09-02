import { createHash } from 'crypto';
import type { PRInfo } from '../pr-analyzer';
import type { ReviewSummary } from '../reviewer';
import { canonicalJson, immutableCanonicalValue, sha256Canonical } from '../state-machine/graph/claim-kernel';
import {
  PROOF_ADMITTED_RECEIPT_CLAIM,
  PROOF_CANDIDATE_CLAIM,
  PROOF_CATALOG_REVALIDATION_CLAIM,
  PROOF_CATALOG_REVALIDATION_PROVIDER_TYPE,
  PROOF_STRUCTURAL_INVENTORY_CLAIM,
  PROOF_STRUCTURAL_INVENTORY_PROVIDER_TYPE,
} from '../state-machine/graph/instance-plan';
import type {
  CandidateClaimInput,
  CheckProviderConfig,
  ExecutionContext,
  ManagedAgentRun,
  ManagedRunStartRequest,
} from './check-provider.interface';
import { CheckProvider } from './check-provider.interface';
import {
  proofAdmissionCapabilityValid,
  PROOF_ADMISSION_UNAVAILABLE,
  PROOF_ADMISSION_WIRE_FIELD,
  goCompatibleProofJson,
  proofCanonicalJson,
  proofTopLevelJson,
  startProofManagedCliChild,
} from './proof-admission-cli-child';

const INTERNAL = Symbol('proof-catalog-provider');
const REVALIDATION_REQUEST_VERSION = 'proof.catalog-revalidation-request/v2';
export const STRUCTURAL_INVENTORY_VERSION = 'proof.structural-inventory/v1';
export const CATALOG_REVALIDATION_VERSION = 'proof.catalog-revalidation/v2';
export const CATALOG_REVALIDATION_RECEIPT_VERSION = 'proof.catalog-revalidation-receipt/v2';
export const COMPONENT_CATALOG_CANDIDATE_VERSION = 'proof.component-catalog-candidate/v1';
/** These are the bounds enforced by Proof's onboarding commands. */
export const PROOF_CATALOG_INPUT_MAX_BYTES = 4 * 1024 * 1024;
export const PROOF_INVENTORY_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;
export const PROOF_REVALIDATION_REQUEST_MAX_BYTES = PROOF_CATALOG_INPUT_MAX_BYTES + 9 * 1024 * 1024;
export const PROOF_REVALIDATION_OUTPUT_MAX_BYTES = PROOF_INVENTORY_OUTPUT_MAX_BYTES + 4 * 1024 * 1024;
export const PROOF_WORK_ITEMS_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
type PlainRecord = Record<string, unknown>;

/** Proof's sort.Strings order compares the UTF-8 bytes of Go strings. */
export function compareProofStrings(left: string, right: string): number {
  return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8'));
}

function proofSorted<T extends string>(values: readonly T[]): T[] {
  return [...values].sort(compareProofStrings);
}

function invalid(detail: string): never { throw new Error(`PROOF_CATALOG_INVALID: ${detail}`); }
function plain(value: unknown): value is PlainRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value: unknown, keys: readonly string[]): value is PlainRecord {
  return plain(value) && Reflect.ownKeys(value).length === keys.length &&
    Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key) && (() => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return !!descriptor && 'value' in descriptor && descriptor.enumerable;
    })());
}
function digest(value: unknown): string { return sha256Canonical(value); }
function fingerprint(value: unknown): value is string { return typeof value === 'string' && DIGEST.test(value); }
function domainDigestBytes(domain: string, encoded: string): string {
  const bytes = Buffer.from(encoded, 'utf8');
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  return `sha256:${createHash('sha256').update(domain).update(Buffer.from([0])).update(length).update(bytes).digest('hex')}`;
}
function domainDigest(domain: string, value: unknown): string {
  return domainDigestBytes(domain, goCompatibleProofJson(value));
}
function plainDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(goCompatibleProofJson(value), 'utf8').digest('hex')}`;
}
function bounded(value: unknown, label: string, limit = PROOF_REVALIDATION_OUTPUT_MAX_BYTES): unknown {
  let encoded: string;
  try { encoded = canonicalJson(value); } catch { invalid(`${label} is not canonical JSON`); }
  if (Buffer.byteLength(encoded, 'utf8') > limit) invalid(`${label} exceeds ${limit} bytes`);
  return immutableCanonicalValue(value);
}
function claimPayloadLimit(claimName: string): number {
  if (claimName === PROOF_STRUCTURAL_INVENTORY_CLAIM) return PROOF_INVENTORY_OUTPUT_MAX_BYTES;
  if (claimName === PROOF_CATALOG_REVALIDATION_CLAIM) return PROOF_REVALIDATION_OUTPUT_MAX_BYTES;
  if (claimName === PROOF_CANDIDATE_CLAIM) return PROOF_CATALOG_INPUT_MAX_BYTES;
  return PROOF_INVENTORY_OUTPUT_MAX_BYTES;
}
function sortedStrings(value: unknown, label: string, allowEmpty = false): readonly string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) ||
      value.some(item => typeof item !== 'string' || item.length === 0)) {
    invalid(`${label} is invalid`);
  }
  const sorted = proofSorted(value);
  if (new Set(value).size !== value.length || proofCanonicalJson(value) !== proofCanonicalJson(sorted)) {
    invalid(`${label} must be unique and sorted`);
  }
  return value;
}
function claim(value: unknown, expectedClaim: string, label: string): CandidateClaimInput {
  if (!plain(value) || value.claim !== expectedClaim || typeof value.claimId !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value.claimId) || typeof value.payloadFingerprint !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value.payloadFingerprint) || typeof value.producerCheckId !== 'string' ||
      !Array.isArray(value.scope) || !Array.isArray(value.parentClaimIds) ||
      value.parentClaimIds.some(item => typeof item !== 'string' || !/^[0-9a-f]{64}$/.test(item))) {
    invalid(`${label} claim identity is invalid`);
  }
  const payload = immutableCanonicalValue(value.payload);
  if (bounded(value.payload, `${label} payload`, claimPayloadLimit(expectedClaim)) &&
      (canonicalJson(value.payload) !== JSON.stringify(value.payload) || digest(payload) !== value.payloadFingerprint)) {
    invalid(`${label} payload is detached or noncanonical`);
  }
  if (canonicalJson(value.scope) !== JSON.stringify(value.scope) ||
      canonicalJson(value.parentClaimIds) !== canonicalJson([...value.parentClaimIds].sort())) {
    invalid(`${label} scope or parents are noncanonical`);
  }
  const base = {
    claimId: value.claimId,
    claim: value.claim,
    payload,
    payloadFingerprint: value.payloadFingerprint,
    producerCheckId: value.producerCheckId,
    scope: immutableCanonicalValue(value.scope),
    parentClaimIds: immutableCanonicalValue(value.parentClaimIds),
  };
  if (value.provenance === 'controller' && typeof value.catalogClaimId === 'string' && Number.isSafeInteger(value.incarnation)) {
    return immutableCanonicalValue({ ...base, provenance: 'controller' as const, catalogClaimId: value.catalogClaimId, incarnation: value.incarnation as number });
  }
  if ((value.provenance === undefined || value.provenance === 'attempt') && typeof value.attemptId === 'string' && Number.isSafeInteger(value.fence)) {
    return immutableCanonicalValue({ ...base, provenance: 'attempt' as const, attemptId: value.attemptId, fence: value.fence as number });
  }
  invalid(`${label} provenance is invalid`);
}
function onlyClaims(value: unknown, aliases: readonly string[]): PlainRecord {
  if (!exact(value, aliases)) invalid(`expected claim aliases ${aliases.join(', ')}`);
  return value;
}
function sameScope(values: readonly CandidateClaimInput[]): boolean {
  return values.every(value => canonicalJson(value.scope) === canonicalJson(values[0].scope));
}

const ADMISSION_DECISION_KEYS = ['version', 'status', 'receipt', 'reject_code'] as const;
const ADMISSION_RECEIPT_KEYS = ['Version', 'Status', 'CandidateID', 'ProbeResultDigest', 'ProbeCanonicalBytes', 'ClaimID', 'Claim', 'PayloadFingerprint', 'InvocationDigest', 'RoleID', 'Stance', 'Subject', 'ProducerCheckID', 'ParentClaimIDs', 'Binding', 'Termination', 'ProjectLineage', 'receipt_id'] as const;

function admissionScope(value: unknown): boolean {
  return Array.isArray(value) && value.length >= 1 && value.length <= 2 && value.every(part => plain(part) && exact(part, ['Kind', 'ExpansionOwnerCheck', 'Key', 'SubgraphInstanceID']) && part.Kind === 'keyed' && typeof part.ExpansionOwnerCheck === 'string' && part.ExpansionOwnerCheck.length > 0 && typeof part.Key === 'string' && part.Key.length > 0 && typeof part.SubgraphInstanceID === 'string' && /^[0-9a-f]{64}$/.test(part.SubgraphInstanceID));
}

function admissionBinding(value: unknown): boolean {
  return plain(value) && exact(value, ['ManagedRunID', 'SessionID', 'CheckID', 'Scope', 'NodeInstanceID', 'NodeGenerationID', 'AttemptID', 'Fence']) && typeof value.ManagedRunID === 'string' && value.ManagedRunID.length > 0 && typeof value.SessionID === 'string' && value.SessionID.length > 0 && typeof value.CheckID === 'string' && value.CheckID.length > 0 && admissionScope(value.Scope) && typeof value.NodeInstanceID === 'string' && value.NodeInstanceID.length > 0 && typeof value.NodeGenerationID === 'string' && value.NodeGenerationID.length > 0 && typeof value.AttemptID === 'string' && value.AttemptID.length > 0 && Number.isSafeInteger(value.Fence) && (value.Fence as number) > 0;
}

function admissionLineage(value: unknown): boolean {
  if (value === null) return true;
  return plain(value) && exact(value, ['version', 'fingerprint', 'object_format', 'baseline_revision']) &&
    value.version === 'proof.git-project-lineage-binding/v1' && fingerprint(value.fingerprint) &&
    (value.object_format === 'sha1' || value.object_format === 'sha256') &&
    typeof value.baseline_revision === 'string' &&
    (value.object_format === 'sha1' ? /^sha1:[0-9a-f]{40}$/.test(value.baseline_revision) : /^sha256:[0-9a-f]{64}$/.test(value.baseline_revision));
}

function proofScope(value: unknown): PlainRecord[] {
  return (value as PlainRecord[]).map(segment => ({
    Kind: segment.Kind,
    ExpansionOwnerCheck: segment.ExpansionOwnerCheck,
    Key: segment.Key,
    SubgraphInstanceID: segment.SubgraphInstanceID,
  }));
}

function proofBinding(value: unknown): PlainRecord {
  const binding = value as PlainRecord;
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

function proofTermination(value: unknown): PlainRecord {
  const termination = value as PlainRecord;
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

function admissionReceiptID(receipt: PlainRecord): string {
  const subject = receipt.Subject as PlainRecord;
  const unsigned = proofTopLevelJson({
    Version: goCompatibleProofJson(receipt.Version),
    Status: goCompatibleProofJson(receipt.Status),
    CandidateID: goCompatibleProofJson(receipt.CandidateID),
    ProbeResultDigest: goCompatibleProofJson(receipt.ProbeResultDigest),
    ProbeCanonicalBytes: goCompatibleProofJson(receipt.ProbeCanonicalBytes),
    ClaimID: goCompatibleProofJson(receipt.ClaimID),
    Claim: goCompatibleProofJson(receipt.Claim),
    PayloadFingerprint: goCompatibleProofJson(receipt.PayloadFingerprint),
    InvocationDigest: goCompatibleProofJson(receipt.InvocationDigest),
    RoleID: goCompatibleProofJson(receipt.RoleID),
    Stance: goCompatibleProofJson(receipt.Stance),
    Subject: goCompatibleProofJson({ kind: subject.kind, id: subject.id, fingerprint: subject.fingerprint }),
    ProducerCheckID: goCompatibleProofJson(receipt.ProducerCheckID),
    ParentClaimIDs: goCompatibleProofJson(receipt.ParentClaimIDs),
    Binding: goCompatibleProofJson(proofBinding(receipt.Binding)),
    Termination: goCompatibleProofJson(proofTermination(receipt.Termination)),
    ProjectLineage: goCompatibleProofJson(receipt.ProjectLineage === null ? null : (() => {
      const lineage = receipt.ProjectLineage as PlainRecord;
      return {
        version: lineage.version,
        fingerprint: lineage.fingerprint,
        object_format: lineage.object_format,
        baseline_revision: lineage.baseline_revision,
      };
    })()),
  });
  return domainDigestBytes('proof.role-result-candidate-receipt/id/v2', unsigned);
}

/**
 * Recover the exact Proof decision from the admitted claim. Claim-kernel
 * canonicalization is intentionally not used for this transport evidence:
 * Proof owns the byte representation of the admission decision.
 */
function admissionTransport(value: unknown): { receipt: PlainRecord; wire: string } {
  if (!plain(value) || typeof value[PROOF_ADMISSION_WIRE_FIELD] !== 'string') {
    invalid('admission does not carry the complete Proof decision wire');
  }
  const wire = value[PROOF_ADMISSION_WIRE_FIELD] as string;
  let decision: unknown;
  try { decision = JSON.parse(wire); } catch { invalid('admission decision wire is not JSON'); }
  const receipt = plain(decision) && plain(decision.receipt) ? decision.receipt : undefined;
  if (!exact(decision, ADMISSION_DECISION_KEYS) || decision.version !== 'proof.role-result-candidate-cli-decision/v1' ||
      decision.status !== 'ADMITTED' || decision.reject_code !== null || !receipt ||
      proofCanonicalJson(decision) !== wire ||
      !exact(receipt, ADMISSION_RECEIPT_KEYS) || receipt.Version !== 'proof.role-result-candidate-admission/v2' || receipt.Status !== 'ADMITTED' || !fingerprint(receipt.CandidateID) || !fingerprint(receipt.ProbeResultDigest) || !Number.isSafeInteger(receipt.ProbeCanonicalBytes) || (receipt.ProbeCanonicalBytes as number) <= 0 || typeof receipt.ClaimID !== 'string' || !/^[0-9a-f]{64}$/.test(receipt.ClaimID) || receipt.Claim !== PROOF_CANDIDATE_CLAIM || typeof receipt.PayloadFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(receipt.PayloadFingerprint) || !fingerprint(receipt.InvocationDigest) || receipt.RoleID !== 'onboard' || receipt.Stance !== 'owner' || !plain(receipt.Subject) || !exact(receipt.Subject, ['kind', 'id', 'fingerprint']) || receipt.Subject.kind !== 'project' || typeof receipt.Subject.id !== 'string' || receipt.Subject.id.length === 0 || !fingerprint(receipt.Subject.fingerprint) || receipt.ProducerCheckID !== 'inspect' || !Array.isArray(receipt.ParentClaimIDs) || receipt.ParentClaimIDs.some(parent => typeof parent !== 'string' || !/^[0-9a-f]{64}$/.test(parent)) || !admissionBinding(receipt.Binding) || !plain(receipt.Termination) || !exact(receipt.Termination, ['Version', 'Type', 'SessionID', 'Scope', 'Binding', 'CleanupStatus', 'ControllerDecision', 'FailureCode']) || receipt.Termination.Version !== 1 || receipt.Termination.Type !== 'ManagedRunTerminated' || receipt.Termination.SessionID !== (receipt.Binding as PlainRecord).SessionID || !admissionScope(receipt.Termination.Scope) || !admissionBinding(receipt.Termination.Binding) || canonicalJson(receipt.Termination.Binding) !== canonicalJson(receipt.Binding) || receipt.Termination.CleanupStatus !== 'clean' || receipt.Termination.ControllerDecision !== 'completed' || receipt.Termination.FailureCode !== null || !fingerprint(receipt.receipt_id) || !admissionLineage(receipt.ProjectLineage) || receipt.receipt_id !== admissionReceiptID(receipt) ||
      proofCanonicalJson(receipt) !== proofCanonicalJson(Object.fromEntries(Object.entries(value).filter(([key]) => key !== PROOF_ADMISSION_WIRE_FIELD)))) {
    invalid('admission decision wire is incomplete or detached');
  }
  return { receipt, wire };
}

function validateAuthority(value: unknown, projectID: string, label: string): PlainRecord {
  const keys = ['version', 'project_id', 'subject_fingerprint', 'code_fingerprint', 'tests_fingerprint'];
  if (!exact(value, keys) || value.version !== 'proof.project-authority/v1' || value.project_id !== projectID ||
      !fingerprint(value.subject_fingerprint) || !fingerprint(value.code_fingerprint) || !fingerprint(value.tests_fingerprint)) {
    invalid(`${label} is not a current Proof project authority`);
  }
  return value;
}

function validateInputState(value: unknown, label: string, expectedOwnerKind?: string, expectedOwnerID?: string): void {
  if (!Array.isArray(value)) invalid(`${label} is invalid`);
  let previous = '';
  const paths = new Set<string>();
  for (const [index, item] of value.entries()) {
    if (!plain(item) || !exact(item, ['owner_kind', 'owner_id', 'input_kind', 'path', 'file_hash']) ||
        typeof item.owner_kind !== 'string' || item.owner_kind.length === 0 || typeof item.owner_id !== 'string' || item.owner_id.length === 0 || typeof item.input_kind !== 'string' || item.input_kind.length === 0 ||
        typeof item.path !== 'string' || item.path.length === 0 || !fingerprint(item.file_hash) ||
        (expectedOwnerKind !== undefined && item.owner_kind !== expectedOwnerKind) ||
        (expectedOwnerID !== undefined && item.owner_id !== expectedOwnerID) || paths.has(item.path)) invalid(`${label}[${index}] is invalid`);
    if (normalizeProofPath(item.path) !== item.path) invalid(`${label}[${index}].path is not a canonical project-relative path`);
    const order = `${item.input_kind}\u0000${item.path}`;
    if (compareProofStrings(order, previous) < 0) invalid(`${label} must be sorted by input kind and path`);
    previous = order;
    paths.add(item.path);
  }
}

function validateStructuralInventory(value: unknown, projectID: string): PlainRecord {
  const keys = ['version', 'authority', 'sorted_paths', 'sorted_module_paths', 'boundary_fingerprint', 'input_state'];
  if (!exact(value, keys) || value.version !== STRUCTURAL_INVENTORY_VERSION || !fingerprint(value.boundary_fingerprint)) {
    invalid('structural inventory is not a closed Proof projection');
  }
  validateAuthority(value.authority, projectID, 'structural inventory authority');
  sortedStrings(value.sorted_paths, 'structural inventory sorted_paths', true);
  proofPathList(value.sorted_paths, 'structural inventory sorted_paths', true);
  // encoding/json emits a nil []string as null; this is the genuine Proof
  // projection for projects without a recognized module manifest.
  if (value.sorted_module_paths !== null) {
    sortedStrings(value.sorted_module_paths, 'structural inventory sorted_module_paths', true);
    proofPathList(value.sorted_module_paths, 'structural inventory sorted_module_paths', true);
  }
  validateInputState(value.input_state, 'structural inventory input_state', 'onboarding_structural_inventory', projectID);
  const inventoryPaths = value.sorted_paths as string[];
  const inputPaths = proofSorted((value.input_state as PlainRecord[]).map(row => row.path as string));
  if (!sameStringSet(inventoryPaths, inputPaths)) invalid('structural inventory input_state does not cover sorted_paths');
  return bounded(value, 'structural inventory', PROOF_INVENTORY_OUTPUT_MAX_BYTES) as PlainRecord;
}

function candidateComponents(value: unknown, projectID?: string): readonly PlainRecord[] {
  if (!plain(value)) invalid('discovery candidate is not an object');
  const keys = ['version', 'project_id', 'components'];
  // The Proof parser permits project_id to be omitted for compatibility, but
  // the cross-product graph wire is closed and always includes it.
  if (!exact(value, keys) || value.version !== COMPONENT_CATALOG_CANDIDATE_VERSION ||
      (projectID !== undefined && value.project_id !== projectID) || !Array.isArray(value.components) ||
      value.components.length < 2 || value.components.length > 4) invalid('discovery candidate is not the closed Proof catalog schema');
  const ids = new Set<string>();
  return value.components.map((component, index) => {
    const componentKeys = ['id', 'responsibility', 'owned_paths', 'dependency_closure', 'entry_points', 'state_effects', 'interfaces', 'uncertainty'];
    if (!plain(component) || !Reflect.ownKeys(component).every(key => typeof key === 'string' && componentKeys.includes(key)) ||
        !('id' in component) || !('responsibility' in component) || !('owned_paths' in component) ||
        typeof component.responsibility !== 'string' || component.responsibility.length === 0) {
      invalid(`discovery component ${index} is not closed or is duplicated`);
    }
    const id = normalizedIdentifier(component.id, `discovery component ${index}.id`);
    if (ids.has(id)) invalid(`discovery component ${index} is duplicated`);
    ids.add(id);
    proofPathList(component.owned_paths, `discovery component ${component.id}.owned_paths`);
    if (component.dependency_closure !== undefined) proofPathList(component.dependency_closure, `discovery component ${component.id}.dependency_closure`);
    if (component.entry_points !== undefined) stringList(component.entry_points, `discovery component ${component.id}.entry_points`, true);
    if (component.state_effects !== undefined) stringList(component.state_effects, `discovery component ${component.id}.state_effects`, true);
    if (component.interfaces !== undefined && (!Array.isArray(component.interfaces) || !component.interfaces.every(item => validMaterialized(item)))) invalid(`discovery component ${component.id}.interfaces is invalid`);
    if (component.uncertainty !== undefined) stringList(component.uncertainty, `discovery component ${component.id}.uncertainty`, true);
    return component;
  });
}
function stringList(value: unknown, label: string, allowEmpty = false): readonly string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) ||
      value.some(item => typeof item !== 'string' || item.length === 0)) {
    invalid(`${label} is invalid`);
  }
  return value;
}

function proofPathList(value: unknown, label: string, allowEmpty = false): readonly string[] {
  stringList(value, label, allowEmpty);
  const seen = new Set<string>();
  for (const path of value as string[]) {
    const normalized = normalizeProofPath(path);
    // Proof trims surrounding whitespace, then requires filepath.Clean to
    // leave the project-relative spelling unchanged.  Keep this boundary
    // equally strict: `a//b`, `a/./b`, and `a/../b` are not accepted input
    // spellings even though they could be normalized to a usable path.
    if (normalized === undefined || normalized !== trimProofSpace(path) || seen.has(normalized)) {
      invalid(`${label} contains a noncanonical or duplicate project-relative path`);
    }
    seen.add(normalized);
  }
  return value as readonly string[];
}

function normalizeProofPath(value: string): string | undefined {
  const trimmed = trimProofSpace(value);
  if (trimmed.length === 0 || trimmed.includes('\u0000') || trimmed.startsWith('/')) return undefined;
  const parts: string[] = [];
  for (const part of trimmed.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length === 0) return undefined;
      parts.pop();
      continue;
    }
    parts.push(part);
  }
  return parts.length === 0 ? undefined : parts.join('/');
}

/** Go strings.TrimSpace uses unicode.IsSpace (which trims U+0085 but does
 * not trim the historical BOM U+FEFF). ECMAScript String#trim differs here. */
function trimProofSpace(value: string): string {
  const chars = [...value];
  let start = 0;
  let end = chars.length;
  while (start < end && isProofSpace(chars[start])) start++;
  while (end > start && isProofSpace(chars[end - 1])) end--;
  return chars.slice(start, end).join('');
}

function isProofSpace(value: string): boolean {
  const code = value.codePointAt(0) as number;
  return code === 0x0009 || code === 0x000a || code === 0x000b || code === 0x000c || code === 0x000d ||
    code === 0x0020 || code === 0x0085 || code === 0x00a0 || code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) || code === 0x2028 || code === 0x2029 ||
    code === 0x202f || code === 0x205f || code === 0x3000;
}

function normalizedPathList(value: unknown, label: string): string[] {
  proofPathList(value, label);
  return (value as string[]).map(path => normalizeProofPath(path) as string);
}

function normalizedIdentifier(value: unknown, label: string): string {
  if (typeof value !== 'string') invalid(`${label} is invalid`);
  const normalized = trimProofSpace(value);
  if (!visibleIdentifier(normalized)) invalid(`${label} is not a visible identifier`);
  return normalized;
}

function visibleIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 128 &&
    [...value].every(char => {
      const code = char.codePointAt(0) as number;
      return code >= 0x21 && code <= 0x7e;
    });
}

function sameStringSet(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function projectedCatalog(value: unknown, projectID: string): PlainRecord {
  if (!plain(value) || !exact(value, ['version', 'project_id', 'components']) ||
      value.version !== COMPONENT_CATALOG_CANDIDATE_VERSION || value.project_id !== projectID ||
      !Array.isArray(value.components) || value.components.length < 2 || value.components.length > 4) {
    invalid('catalog revalidation catalog is invalid');
  }
  const ids = new Set<string>();
  for (const [index, component] of value.components.entries()) {
    if (!plain(component)) invalid(`catalog component ${index} is not an object`);
    const allowed = ['id', 'responsibility', 'owned_paths', 'dependency_closure', 'entry_points', 'state_effects', 'interfaces', 'uncertainty'];
    if (!Reflect.ownKeys(component).every(key => typeof key === 'string' && allowed.includes(key))) invalid(`catalog component ${index} contains an unknown field`);
    if (!('id' in component) || !('responsibility' in component) || !('owned_paths' in component) ||
        !visibleIdentifier(component.id) || typeof component.responsibility !== 'string' || component.responsibility.length === 0 ||
        ids.has(component.id)) invalid(`catalog component ${index} is invalid or duplicated`);
    ids.add(component.id);
    sortedStrings(component.owned_paths, `catalog component ${component.id}.owned_paths`);
    proofPathList(component.owned_paths, `catalog component ${component.id}.owned_paths`);
    if (component.dependency_closure !== undefined) {
      sortedStrings(component.dependency_closure, `catalog component ${component.id}.dependency_closure`);
      proofPathList(component.dependency_closure, `catalog component ${component.id}.dependency_closure`);
    }
    for (const field of ['entry_points', 'state_effects', 'uncertainty'] as const) {
      if (component[field] !== undefined) stringList(component[field], `catalog component ${component.id}.${field}`, true);
    }
    if (component.interfaces !== undefined && (!Array.isArray(component.interfaces) || !component.interfaces.every(item => validMaterialized(item)))) {
      invalid(`catalog component ${component.id}.interfaces is invalid`);
    }
  }
  return value;
}

function expectedCatalog(candidate: CandidateClaimInput, projectID: string): PlainRecord {
  const components = candidateComponents(candidate.payload, projectID).map(component => {
    const result: PlainRecord = {
      id: normalizedIdentifier(component.id, `discovery component ${String(component.id)}.id`),
      responsibility: component.responsibility,
      owned_paths: proofSorted(normalizedPathList(component.owned_paths, `discovery component ${String(component.id)}.owned_paths`)),
    };
    if (component.dependency_closure !== undefined) result.dependency_closure = proofSorted(normalizedPathList(component.dependency_closure, `discovery component ${String(component.id)}.dependency_closure`));
    for (const field of ['entry_points', 'state_effects', 'interfaces', 'uncertainty'] as const) {
      const list = component[field] as unknown[] | undefined;
      if (list !== undefined && list.length > 0) result[field] = field === 'interfaces' ? list : proofSorted(list as string[]);
    }
    return result;
  }).sort((left, right) => compareProofStrings(left.id as string, right.id as string));
  return { version: COMPONENT_CATALOG_CANDIDATE_VERSION, project_id: projectID, components };
}
function validMaterialized(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return !/[\u0000-\u001f\u007f]/.test(value);
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  try { return Array.isArray(value) ? value.every(item => validMaterialized(item, seen)) : plain(value) && Object.values(value).every(item => validMaterialized(item, seen)); }
  finally { seen.delete(value); }
}

function validateWorkItem(value: unknown, projectID: string, label: string): PlainRecord {
  const keys = ['version', 'project_id', 'component_id', 'sorted_owned_paths', 'sorted_dependency_closure', 'proof_path_mapping', 'proof_input_state', 'proof_component_subject'];
  if (!exact(value, keys) || value.version !== 'reqproof.onboarding-component-work-item/v1' || value.project_id !== projectID ||
      typeof value.component_id !== 'string' || value.component_id.length === 0 || !plain(value.proof_path_mapping) ||
      !validMaterialized(value.proof_path_mapping) || !plain(value.proof_component_subject) || !validMaterialized(value.proof_component_subject)) invalid(`${label} is not a closed Proof WorkItem`);
  sortedStrings(value.sorted_owned_paths, `${label}.sorted_owned_paths`);
  sortedStrings(value.sorted_dependency_closure, `${label}.sorted_dependency_closure`);
  validateInputState(value.proof_input_state, `${label}.proof_input_state`, 'onboarding_component', value.component_id as string);
  const closure = value.sorted_dependency_closure as string[];
  const inputPaths = proofSorted((value.proof_input_state as PlainRecord[]).map(row => row.path as string));
  if (!sameStringSet(closure, inputPaths)) invalid(`${label}.proof_input_state does not cover sorted_dependency_closure`);
  const subject = value.proof_component_subject;
  if (!exact(subject, ['version', 'project_id', 'component_id', 'sorted_owned_paths', 'sorted_dependency_closure', 'fingerprint']) ||
      subject.version !== 'proof.component-subject/v1' || subject.project_id !== projectID || subject.component_id !== value.component_id ||
      !fingerprint(subject.fingerprint) || canonicalJson(subject.sorted_owned_paths) !== canonicalJson(value.sorted_owned_paths) ||
      canonicalJson(subject.sorted_dependency_closure) !== canonicalJson(value.sorted_dependency_closure)) invalid(`${label}.proof_component_subject is detached`);
  const mapping = value.proof_path_mapping;
  if (!exact(mapping, ['paths', 'components', 'owner', 'risk_tier', 'enforcement']) ||
      !Array.isArray(mapping.paths) || !Array.isArray(mapping.components) || mapping.components.length !== 1 || mapping.components[0] !== value.component_id ||
      mapping.owner !== 'onboard' || mapping.risk_tier !== 0 || mapping.enforcement !== 'soft' ||
      canonicalJson(mapping.paths) !== canonicalJson(value.sorted_owned_paths) ||
      mapping.paths.some(path => typeof path !== 'string' || path.length === 0)) invalid(`${label}.proof_path_mapping is detached`);
  return value;
}

/** Validate the activation-safe work-items projection as a complete Proof
 * output. This is deliberately separate from the revalidation projection:
 * activation consumes only the fresh command result, never its embedded
 * revalidation.work_items member. */
export function validateProofWorkItemsProjection(
  value: unknown,
  revalidation: PlainRecord,
  inventory: PlainRecord,
  candidate: CandidateClaimInput,
  admission: CandidateClaimInput,
  projectID: string,
): PlainRecord {
  const keys = ['version', 'authority', 'catalog', 'work_items'];
  if (!exact(value, keys) || value.version !== 'proof.onboarding-work-item-projection/v1') invalid('work-items projection is not closed');
  const authority = validateAuthority(value.authority, projectID, 'work-items authority');
  const expectedAuthority = (inventory.authority as PlainRecord);
  if (!plain(expectedAuthority) || canonicalJson(authority) !== canonicalJson(expectedAuthority)) invalid('work-items authority is detached from current inventory');
  const expected = expectedCatalog(candidate, projectID);
  const catalog = projectedCatalog(value.catalog, projectID);
  if (canonicalJson(catalog) !== canonicalJson(expected)) invalid('work-items catalog is detached from candidate');
  if (!Array.isArray(value.work_items) || value.work_items.length !== (expected.components as PlainRecord[]).length) invalid('work-items projection is incomplete');
  const items = value.work_items.map((item, index) => validateWorkItem(item, projectID, `work-items[${index}]`));
  const sortedItems = [...items].sort((left, right) => compareProofStrings(left.component_id as string, right.component_id as string));
  if (canonicalJson(items) !== canonicalJson(sortedItems)) invalid('work-items projection is not sorted by component_id');
  const catalogByID = new Map((catalog.components as PlainRecord[]).map(component => [component.id as string, component]));
  const inventoryInput = new Map(((inventory.input_state as PlainRecord[]) || []).map(row => [row.path, row]));
  for (const item of items) {
    const component = catalogByID.get(item.component_id as string);
    if (!component || !sameStringSet(item.sorted_owned_paths as string[], component.owned_paths as string[]) ||
        !sameStringSet(item.sorted_dependency_closure as string[], component.dependency_closure === undefined ? item.sorted_owned_paths as string[] : component.dependency_closure as string[])) invalid(`work-items ${item.component_id as string} is detached from catalog`);
    for (const row of item.proof_input_state as PlainRecord[]) {
      const current = inventoryInput.get(row.path as string);
      if (!current || current.input_kind !== row.input_kind || current.file_hash !== row.file_hash) invalid(`work-items ${item.component_id as string} input state is stale`);
    }
  }
  const revalidationProjection = validateProofCatalogRevalidationProjection(revalidation, inventory, candidate, admission, projectID);
  const receipt = revalidationProjection.receipt as PlainRecord;
  const authorities = receipt.component_authorities as PlainRecord[];
  for (const item of items) {
    const authorityRow = authorities.find(row => row.component_id === item.component_id);
    if (!authorityRow || authorityRow.work_item_digest !== plainDigest(workItemWire(item)) || canonicalJson(authorityRow.subject) !== canonicalJson(item.proof_component_subject)) invalid(`work-items ${item.component_id as string} is not authorized by revalidation receipt`);
  }
  return bounded(value, 'work-items projection', PROOF_WORK_ITEMS_OUTPUT_MAX_BYTES) as PlainRecord;
}

function validateReceipt(value: unknown, projectID: string, boundaryFingerprint: string, ids: ReadonlySet<string>, workItems: readonly PlainRecord[]): PlainRecord {
  const keys = ['version', 'decision', 'project_id', 'project_fingerprint', 'boundary_fingerprint', 'inventory_claim_id', 'catalog_claim_id', 'admission_candidate_id', 'admission_result_digest', 'admission_receipt_id', 'component_authorities', 'project_lineage', 'receipt_id'];
  if (!exact(value, keys) || value.version !== CATALOG_REVALIDATION_RECEIPT_VERSION || value.decision !== 'accepted' || value.project_id !== projectID || value.boundary_fingerprint !== boundaryFingerprint ||
      !fingerprint(value.project_fingerprint) || !fingerprint(value.boundary_fingerprint) || !fingerprint(value.inventory_claim_id) ||
      !fingerprint(value.catalog_claim_id) || !fingerprint(value.admission_candidate_id) || !fingerprint(value.admission_result_digest) ||
      !fingerprint(value.admission_receipt_id) || !fingerprint(value.receipt_id) || !Array.isArray(value.component_authorities)) invalid('catalog revalidation receipt is invalid');
  if (value.component_authorities.length !== ids.size || !admissionLineage(value.project_lineage)) invalid('catalog revalidation receipt has the wrong component count or lineage');
  const seen = new Set<string>();
  for (const [index, authority] of value.component_authorities.entries()) {
    if (!plain(authority) || !exact(authority, ['component_id', 'work_item_digest', 'subject']) || typeof authority.component_id !== 'string' || !fingerprint(authority.work_item_digest) || !plain(authority.subject) || !exact(authority.subject, ['version', 'project_id', 'component_id', 'sorted_owned_paths', 'sorted_dependency_closure', 'fingerprint']) || authority.subject.version !== 'proof.component-subject/v1' || !fingerprint(authority.subject.fingerprint) || authority.subject.component_id !== authority.component_id || authority.subject.project_id !== projectID || seen.has(authority.component_id) || !ids.has(authority.component_id)) invalid(`catalog revalidation receipt component_authorities[${index}] is invalid`);
    const item = workItems.find(candidate => candidate.component_id === authority.component_id);
    if (!item || authority.work_item_digest !== plainDigest(workItemWire(item)) || canonicalJson(authority.subject) !== canonicalJson(item.proof_component_subject)) invalid(`catalog revalidation receipt component_authorities[${index}] is detached`);
    seen.add(authority.component_id);
  }
  const sorted = [...value.component_authorities].sort((left, right) => compareProofStrings(left.component_id, right.component_id));
  if (canonicalJson(value.component_authorities) !== canonicalJson(sorted)) invalid('catalog revalidation receipt component authorities are not sorted');
  const componentAuthoritiesWire = (value.component_authorities as PlainRecord[]).map(authority => {
    const subject = authority.subject as PlainRecord;
    return {
      component_id: authority.component_id,
      work_item_digest: authority.work_item_digest,
      subject: {
        version: subject.version,
        project_id: subject.project_id,
        component_id: subject.component_id,
        sorted_owned_paths: subject.sorted_owned_paths,
        sorted_dependency_closure: subject.sorted_dependency_closure,
        fingerprint: subject.fingerprint,
      },
    };
  });
  const unsigned = proofTopLevelJson({
    version: goCompatibleProofJson(value.version),
    decision: goCompatibleProofJson(value.decision),
    project_id: goCompatibleProofJson(value.project_id),
    project_fingerprint: goCompatibleProofJson(value.project_fingerprint),
    boundary_fingerprint: goCompatibleProofJson(value.boundary_fingerprint),
    inventory_claim_id: goCompatibleProofJson(value.inventory_claim_id),
    catalog_claim_id: goCompatibleProofJson(value.catalog_claim_id),
    admission_candidate_id: goCompatibleProofJson(value.admission_candidate_id),
    admission_result_digest: goCompatibleProofJson(value.admission_result_digest),
    admission_receipt_id: goCompatibleProofJson(value.admission_receipt_id),
    component_authorities: goCompatibleProofJson(componentAuthoritiesWire),
    project_lineage: goCompatibleProofJson(value.project_lineage === null ? null : (() => {
      const lineage = value.project_lineage as PlainRecord;
      return { version: lineage.version, fingerprint: lineage.fingerprint, object_format: lineage.object_format, baseline_revision: lineage.baseline_revision };
    })()),
  });
  if (value.receipt_id !== domainDigestBytes('proof.catalog-revalidation-receipt/id/v2', unsigned)) invalid('catalog revalidation receipt ID is invalid');
  return value;
}

function inventoryWire(value: PlainRecord): PlainRecord {
  const authority = value.authority as PlainRecord;
  return {
    version: value.version,
    authority: {
      version: authority.version,
      project_id: authority.project_id,
      subject_fingerprint: authority.subject_fingerprint,
      code_fingerprint: authority.code_fingerprint,
      tests_fingerprint: authority.tests_fingerprint,
    },
    sorted_paths: value.sorted_paths,
    sorted_module_paths: value.sorted_module_paths,
    boundary_fingerprint: value.boundary_fingerprint,
    input_state: (value.input_state as PlainRecord[]).map(row => ({
      owner_kind: row.owner_kind, owner_id: row.owner_id, input_kind: row.input_kind,
      path: row.path, file_hash: row.file_hash,
    })),
  };
}
function workItemWire(value: PlainRecord): PlainRecord {
  const mapping = value.proof_path_mapping as PlainRecord;
  const subject = value.proof_component_subject as PlainRecord;
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
    proof_input_state: (value.proof_input_state as PlainRecord[]).map(row => ({
      owner_kind: row.owner_kind, owner_id: row.owner_id, input_kind: row.input_kind,
      path: row.path, file_hash: row.file_hash,
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

export function validateProofCatalogRevalidationProjection(value: unknown, inventory: PlainRecord, candidate: CandidateClaimInput, admission: CandidateClaimInput, projectID: string, revalidationClaim?: CandidateClaimInput, inventoryClaimId?: string): PlainRecord {
  const keys = ['version', 'inventory', 'catalog', 'work_items', 'receipt'];
  if (!exact(value, keys) || value.version !== CATALOG_REVALIDATION_VERSION) invalid('catalog revalidation projection is not closed');
  const admitted = admissionTransport(admission.payload);
  if (candidate.producerCheckId !== 'inspect' ||
      (inventoryClaimId !== undefined && !candidate.parentClaimIds.includes(inventoryClaimId)) || admission.producerCheckId !== 'proof_admit' || admission.parentClaimIds.length !== 1 ||
      admission.parentClaimIds[0] !== candidate.claimId || canonicalJson(admission.scope) !== canonicalJson(candidate.scope) ||
      !Array.isArray(candidate.parentClaimIds)) invalid('admission lineage is detached');
  if (candidate.parentClaimIds.some(parent => typeof parent !== 'string')) invalid('candidate lineage is invalid');
  if (revalidationClaim !== undefined) {
    if (inventoryClaimId === undefined || revalidationClaim.producerCheckId !== 'revalidate_catalog' ||
        revalidationClaim.parentClaimIds.length !== 3 || canonicalJson(revalidationClaim.parentClaimIds) !== canonicalJson([inventoryClaimId, candidate.claimId, admission.claimId].sort()) ||
        canonicalJson(revalidationClaim.scope) !== canonicalJson(candidate.scope)) invalid('revalidation lineage is detached');
  }
  const currentInventory = validateStructuralInventory(value.inventory, projectID);
  if (canonicalJson(currentInventory) !== canonicalJson(inventory)) invalid('catalog revalidation inventory is stale');
  const admissionSubject = admitted.receipt.Subject as PlainRecord;
  if (admissionSubject.id !== projectID || (admitted.receipt.ProjectLineage === null && admissionSubject.fingerprint !== (currentInventory.authority as PlainRecord).subject_fingerprint)) {
    invalid('admission subject is not bound to the current Proof authority');
  }
  const candidateWire = proofCanonicalJson(candidate.payload);
  if (admitted.receipt.ProbeCanonicalBytes !== Buffer.byteLength(candidateWire, 'utf8') ||
      admitted.receipt.ProbeResultDigest !== domainDigestBytes('probe.governed-result-identity/data/v1', candidateWire)) {
    invalid('admission result is detached from the candidate catalog');
  }
  const components = candidateComponents(candidate.payload, projectID);
  const ids = new Set(components.map(component => component.id as string));
  const catalog = projectedCatalog(value.catalog, projectID);
  const expected = expectedCatalog(candidate, projectID);
  if (canonicalJson(catalog) !== canonicalJson(expected)) invalid('catalog revalidation catalog is detached from candidate');
  const catalogComponents = (catalog.components as PlainRecord[]);
  if (new Set(catalogComponents.map(component => component.id as string)).size !== ids.size || catalogComponents.some(component => !ids.has(component.id as string))) invalid('catalog revalidation catalog is detached from candidate');
  const inventoryPaths = value.inventory && plain(value.inventory) && Array.isArray(value.inventory.sorted_paths)
    ? value.inventory.sorted_paths as string[] : [];
  const ownedPaths = proofSorted(catalogComponents.flatMap(component => component.owned_paths as string[]));
  if (new Set(ownedPaths).size !== ownedPaths.length || !sameStringSet(ownedPaths, inventoryPaths)) invalid('catalog revalidation catalog does not cover the current inventory');
  if (!Array.isArray(value.work_items) || value.work_items.length !== ids.size) invalid('catalog revalidation WorkItems are incomplete');
  const workItems = value.work_items.map((item, index) => validateWorkItem(item, projectID, `catalog revalidation work_items[${index}]`));
  const inventoryInputByPath = new Map((currentInventory.input_state as PlainRecord[]).map(row => [row.path, row]));
  for (const item of workItems) {
    for (const row of item.proof_input_state as PlainRecord[]) {
      const inventoryRow = inventoryInputByPath.get(row.path as string);
      if (!inventoryRow || inventoryRow.input_kind !== row.input_kind || inventoryRow.file_hash !== row.file_hash) {
        invalid(`catalog revalidation WorkItem ${item.component_id as string} input state is detached from inventory`);
      }
    }
  }
  const itemIDs = new Set(workItems.map(item => item.component_id as string));
  if (itemIDs.size !== ids.size || [...ids].some(id => !itemIDs.has(id))) invalid('catalog revalidation WorkItems are detached from candidate');
  const catalogByID = new Map(catalogComponents.map(component => [component.id as string, component]));
  for (const item of workItems) {
    const component = catalogByID.get(item.component_id as string);
    if (!component || !sameStringSet(item.sorted_owned_paths as string[], component.owned_paths as string[]) ||
        (component.dependency_closure !== undefined && !sameStringSet(item.sorted_dependency_closure as string[], component.dependency_closure as string[])) ||
        (component.dependency_closure === undefined && !sameStringSet(item.sorted_dependency_closure as string[], item.sorted_owned_paths as string[]))) {
      invalid(`catalog revalidation WorkItem ${item.component_id as string} is detached from catalog paths`);
    }
  }
  const sortedItems = [...workItems].sort((left, right) => compareProofStrings(left.component_id as string, right.component_id as string));
  if (canonicalJson(workItems) !== canonicalJson(sortedItems)) invalid('catalog revalidation WorkItems are not sorted by component_id');
  const receipt = validateReceipt(value.receipt, projectID, (value.inventory as PlainRecord).boundary_fingerprint as string, ids, workItems);
  if (admission.producerCheckId !== 'proof_admit' || admitted.receipt.Status !== 'ADMITTED' || admitted.receipt.ClaimID !== candidate.claimId || admitted.receipt.PayloadFingerprint !== candidate.payloadFingerprint) invalid('admission is not the exact admitted candidate');
  const authority = (value.inventory as PlainRecord).authority;
  if (!plain(authority) || receipt.project_fingerprint !== authority.subject_fingerprint) invalid('catalog revalidation receipt project authority is detached');
  const expectedInventoryID = domainDigest('proof.structural-inventory/claim/v1', inventoryWire(currentInventory));
  const expectedCatalogID = domainDigest('proof.component-catalog-candidate/claim/v1', candidate.payload);
  if (receipt.inventory_claim_id !== expectedInventoryID || receipt.catalog_claim_id !== expectedCatalogID || receipt.admission_candidate_id !== admitted.receipt.CandidateID || receipt.admission_result_digest !== admitted.receipt.ProbeResultDigest || receipt.admission_receipt_id !== admitted.receipt.receipt_id) invalid('catalog revalidation receipt lineage is detached');
  return bounded(value, 'catalog revalidation projection') as PlainRecord;
}

abstract class ProofCatalogCliProvider extends CheckProvider {
  protected readonly capability: object | undefined;
  constructor(capability?: object, token?: typeof INTERNAL) {
    super();
    if (capability && (token !== INTERNAL || !proofAdmissionCapabilityValid(capability))) invalid('capability is invalid');
    this.capability = capability;
  }
  async execute(_pr: PRInfo, _config: CheckProviderConfig, _deps?: Map<string, ReviewSummary>, _context?: ExecutionContext): Promise<ReviewSummary> { throw new Error(PROOF_ADMISSION_UNAVAILABLE); }
  async isAvailable(): Promise<boolean> { return this.capability !== undefined; }
  getRequirements(): string[] { return [PROOF_ADMISSION_UNAVAILABLE]; }
  getSupportedConfigKeys(): string[] { return ['type', 'consumes', 'emits', 'depends_on']; }
}

export class ProofStructuralInventoryCheckProvider extends ProofCatalogCliProvider {
  getName(): string { return PROOF_STRUCTURAL_INVENTORY_PROVIDER_TYPE; }
  getDescription(): string { return 'Sealed Proof onboarding structural inventory provider'; }
  async validateConfig(config: unknown): Promise<boolean> { return plain(config) && config.type === PROOF_STRUCTURAL_INVENTORY_PROVIDER_TYPE && Object.keys(config).every(key => ['type', 'consumes', 'emits'].includes(key)); }
  startManaged(request: ManagedRunStartRequest): ManagedAgentRun {
    const claims = onlyClaims(request.executionContext.claims, ['project']);
    const project = claim(claims.project, 'project.discovery_item@1', 'project');
    if (!plain(project.payload) || typeof project.payload.project_id !== 'string') invalid('project claim is invalid');
    const projectPayload = project.payload as PlainRecord;
    return startProofManagedCliChild({
      binding: request.binding,
      workingDirectory: request.workingDirectory || '',
      command: ['onboarding', 'inventory'],
      input: '',
      inputLimit: 0,
      outputLimit: PROOF_INVENTORY_OUTPUT_MAX_BYTES,
      outputCanonical: false,
      projectOutput: value => validateStructuralInventory(value, projectPayload.project_id as string),
    }, this.capability);
  }
}

export class ProofCatalogRevalidationCheckProvider extends ProofCatalogCliProvider {
  getName(): string { return PROOF_CATALOG_REVALIDATION_PROVIDER_TYPE; }
  getDescription(): string { return 'Sealed Proof onboarding catalog revalidation provider'; }
  async validateConfig(config: unknown): Promise<boolean> { return plain(config) && config.type === PROOF_CATALOG_REVALIDATION_PROVIDER_TYPE && Object.keys(config).every(key => ['type', 'depends_on', 'consumes', 'emits'].includes(key)); }
  startManaged(request: ManagedRunStartRequest): ManagedAgentRun {
    const claims = onlyClaims(request.executionContext.claims, ['current_inventory', 'candidate', 'receipt']);
    const inventory = claim(claims.current_inventory, PROOF_STRUCTURAL_INVENTORY_CLAIM, 'current inventory');
    const candidate = claim(claims.candidate, PROOF_CANDIDATE_CLAIM, 'candidate');
    const admission = claim(claims.receipt, PROOF_ADMITTED_RECEIPT_CLAIM, 'admission');
    if (inventory.producerCheckId !== 'structural_inventory' || !sameScope([inventory, candidate, admission]) || !plain(inventory.payload) || !plain(candidate.payload)) invalid('revalidation claims are cross-scope');
    const inventoryPayload = inventory.payload as PlainRecord;
    const candidatePayload = candidate.payload as PlainRecord;
    const projectID = typeof inventoryPayload.authority === 'object' && inventoryPayload.authority && typeof (inventoryPayload.authority as PlainRecord).project_id === 'string'
      ? (inventoryPayload.authority as PlainRecord).project_id as string : typeof candidatePayload.project_id === 'string' ? candidatePayload.project_id : '';
    if (!projectID) invalid('revalidation project id is missing');
    validateStructuralInventory(inventory.payload, projectID);
    candidateComponents(candidate.payload, projectID);
    const admitted = admissionTransport(admission.payload);
    // Revalidation v2 is Proof CanonicalJSON at the complete envelope: the
    // canonical top-level order is admission, candidate, version. Preserve
    // the complete admission decision as decoded data; do not synthesize a
    // Go-struct-order receipt.
    let admissionObject: unknown;
    try { admissionObject = JSON.parse(admitted.wire); } catch { invalid('admission decision wire is not JSON'); }
    const input = proofCanonicalJson({ version: REVALIDATION_REQUEST_VERSION, candidate: candidate.payload, admission: admissionObject });
    return startProofManagedCliChild({
      binding: request.binding,
      workingDirectory: request.workingDirectory || '',
      command: ['onboarding', 'revalidate'],
      input,
      inputLimit: PROOF_REVALIDATION_REQUEST_MAX_BYTES,
      outputLimit: PROOF_REVALIDATION_OUTPUT_MAX_BYTES,
      outputCanonical: false,
      projectOutput: value => validateProofCatalogRevalidationProjection(value, inventory.payload as PlainRecord, candidate, admission, projectID, undefined, inventory.claimId),
    }, this.capability);
  }
}

export function createProofStructuralInventoryProviderFromCapability(capability: object): ProofStructuralInventoryCheckProvider { return new ProofStructuralInventoryCheckProvider(capability, INTERNAL); }
export function createProofCatalogRevalidationProviderFromCapability(capability: object): ProofCatalogRevalidationCheckProvider { return new ProofCatalogRevalidationCheckProvider(capability, INTERNAL); }
