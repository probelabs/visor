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
  goCompatibleProofJson,
  startProofManagedCliChild,
} from './proof-admission-cli-child';

const INTERNAL = Symbol('proof-catalog-provider');
const REVALIDATION_REQUEST_VERSION = 'proof.catalog-revalidation-request/v1';
export const STRUCTURAL_INVENTORY_VERSION = 'proof.structural-inventory/v1';
export const CATALOG_REVALIDATION_VERSION = 'proof.catalog-revalidation/v1';
export const CATALOG_REVALIDATION_RECEIPT_VERSION = 'proof.catalog-revalidation-receipt/v1';
export const COMPONENT_CATALOG_CANDIDATE_VERSION = 'proof.component-catalog-candidate/v1';
/** These are the bounds enforced by Proof's onboarding commands. */
const INVENTORY_OUTPUT_LIMIT = 8 * 1024 * 1024;
const REVALIDATION_INPUT_LIMIT = 4 * 1024 * 1024 + 9 * 1024 * 1024;
const REVALIDATION_OUTPUT_LIMIT = 8 * 1024 * 1024 + 4 * 1024 * 1024;
const CATALOG_INPUT_LIMIT = 4 * 1024 * 1024;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
type PlainRecord = Record<string, unknown>;

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
function domainDigest(domain: string, value: unknown): string {
  const bytes = Buffer.from(goCompatibleProofJson(value), 'utf8');
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  return `sha256:${createHash('sha256').update(domain).update(Buffer.from([0])).update(length).update(bytes).digest('hex')}`;
}
function plainDigest(value: unknown): string {
  return `sha256:${createHash('sha256').update(goCompatibleProofJson(value), 'utf8').digest('hex')}`;
}
function bounded(value: unknown, label: string, limit = REVALIDATION_OUTPUT_LIMIT): unknown {
  let encoded: string;
  try { encoded = canonicalJson(value); } catch { invalid(`${label} is not canonical JSON`); }
  if (Buffer.byteLength(encoded, 'utf8') > limit) invalid(`${label} exceeds ${limit} bytes`);
  return immutableCanonicalValue(value);
}
function claimPayloadLimit(claimName: string): number {
  if (claimName === PROOF_STRUCTURAL_INVENTORY_CLAIM) return INVENTORY_OUTPUT_LIMIT;
  if (claimName === PROOF_CATALOG_REVALIDATION_CLAIM) return REVALIDATION_OUTPUT_LIMIT;
  if (claimName === PROOF_CANDIDATE_CLAIM) return CATALOG_INPUT_LIMIT;
  return INVENTORY_OUTPUT_LIMIT;
}
function sortedStrings(value: unknown, label: string, allowEmpty = false): readonly string[] {
  if (!Array.isArray(value) || value.length > 4096 || (!allowEmpty && value.length === 0) ||
      value.some(item => typeof item !== 'string' || item.length === 0 || item.length > 4096)) {
    invalid(`${label} is invalid`);
  }
  const sorted = [...value].sort();
  if (new Set(value).size !== value.length || canonicalJson(value) !== canonicalJson(sorted)) {
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

function validateAuthority(value: unknown, projectID: string, label: string): PlainRecord {
  const keys = ['version', 'project_id', 'subject_fingerprint', 'code_fingerprint', 'tests_fingerprint'];
  if (!exact(value, keys) || value.version !== 'proof.project-authority/v1' || value.project_id !== projectID ||
      !fingerprint(value.subject_fingerprint) || !fingerprint(value.code_fingerprint) || !fingerprint(value.tests_fingerprint)) {
    invalid(`${label} is not a current Proof project authority`);
  }
  return value;
}

function validateInputState(value: unknown, label: string, expectedOwnerKind?: string, expectedOwnerID?: string): void {
  if (!Array.isArray(value) || value.length > 65536) invalid(`${label} is invalid`);
  let previous = '';
  const paths = new Set<string>();
  for (const [index, item] of value.entries()) {
    if (!plain(item) || !exact(item, ['owner_kind', 'owner_id', 'input_kind', 'path', 'file_hash']) ||
        typeof item.owner_kind !== 'string' || typeof item.owner_id !== 'string' || typeof item.input_kind !== 'string' ||
        typeof item.path !== 'string' || !fingerprint(item.file_hash) ||
        (expectedOwnerKind !== undefined && item.owner_kind !== expectedOwnerKind) ||
        (expectedOwnerID !== undefined && item.owner_id !== expectedOwnerID) || paths.has(item.path)) invalid(`${label}[${index}] is invalid`);
    const order = `${item.input_kind}\u0000${item.path}`;
    if (order < previous) invalid(`${label} must be sorted by input kind and path`);
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
  sortedStrings(value.sorted_module_paths, 'structural inventory sorted_module_paths', true);
  validateInputState(value.input_state, 'structural inventory input_state', 'onboarding_structural_inventory', projectID);
  return bounded(value, 'structural inventory', INVENTORY_OUTPUT_LIMIT) as PlainRecord;
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
    if (!exact(component, componentKeys) || typeof component.id !== 'string' || component.id.length === 0 ||
        typeof component.responsibility !== 'string' || component.responsibility.length === 0 || ids.has(component.id)) {
      invalid(`discovery component ${index} is not closed or is duplicated`);
    }
    ids.add(component.id);
    stringList(component.owned_paths, `discovery component ${component.id}.owned_paths`);
    stringList(component.dependency_closure, `discovery component ${component.id}.dependency_closure`);
    sortedStrings(component.entry_points, `discovery component ${component.id}.entry_points`, true);
    sortedStrings(component.state_effects, `discovery component ${component.id}.state_effects`, true);
    if (!Array.isArray(component.interfaces) || component.interfaces.length > 4096 || !component.interfaces.every(item => validMaterialized(item))) invalid(`discovery component ${component.id}.interfaces is invalid`);
    sortedStrings(component.uncertainty, `discovery component ${component.id}.uncertainty`, true);
    return component;
  });
}
function stringList(value: unknown, label: string, allowEmpty = false): readonly string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || value.length > 4096 ||
      value.some(item => typeof item !== 'string' || item.length === 0 || item.length > 4096 || /[\u0000-\u001f\u007f]/.test(item))) {
    invalid(`${label} is invalid`);
  }
  return value;
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
    if (!('id' in component) || !('responsibility' in component) || !('owned_paths' in component) || !('dependency_closure' in component) ||
        typeof component.id !== 'string' || component.id.length === 0 || typeof component.responsibility !== 'string' || component.responsibility.length === 0 ||
        ids.has(component.id)) invalid(`catalog component ${index} is invalid or duplicated`);
    ids.add(component.id);
    stringList(component.owned_paths, `catalog component ${component.id}.owned_paths`);
    stringList(component.dependency_closure, `catalog component ${component.id}.dependency_closure`);
    for (const field of ['entry_points', 'state_effects', 'uncertainty'] as const) {
      if (component[field] !== undefined) stringList(component[field], `catalog component ${component.id}.${field}`, true);
    }
    if (component.interfaces !== undefined && (!Array.isArray(component.interfaces) || component.interfaces.length > 4096 || !component.interfaces.every(item => validMaterialized(item)))) {
      invalid(`catalog component ${component.id}.interfaces is invalid`);
    }
  }
  return value;
}

function expectedCatalog(candidate: CandidateClaimInput, projectID: string): PlainRecord {
  const components = candidateComponents(candidate.payload, projectID).map(component => {
    const result: PlainRecord = {
      id: component.id,
      responsibility: component.responsibility,
      owned_paths: [...(component.owned_paths as string[])].sort(),
      dependency_closure: [...(component.dependency_closure as string[])].sort(),
    };
    for (const field of ['entry_points', 'state_effects', 'interfaces', 'uncertainty'] as const) {
      const list = component[field] as unknown[];
      if (list.length > 0) result[field] = field === 'interfaces' ? list : [...(list as string[])].sort();
    }
    return result;
  }).sort((left, right) => (left.id as string).localeCompare(right.id as string));
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
  const subject = value.proof_component_subject;
  if (!exact(subject, ['version', 'project_id', 'component_id', 'sorted_owned_paths', 'sorted_dependency_closure', 'fingerprint']) ||
      subject.version !== 'proof.component-subject/v1' || subject.project_id !== projectID || subject.component_id !== value.component_id ||
      !fingerprint(subject.fingerprint) || canonicalJson(subject.sorted_owned_paths) !== canonicalJson(value.sorted_owned_paths) ||
      canonicalJson(subject.sorted_dependency_closure) !== canonicalJson(value.sorted_dependency_closure)) invalid(`${label}.proof_component_subject is detached`);
  const mapping = value.proof_path_mapping;
  if (!exact(mapping, ['paths', 'components', 'owner', 'risk_tier', 'enforcement']) ||
      !Array.isArray(mapping.paths) || !Array.isArray(mapping.components) || mapping.components.length !== 1 || mapping.components[0] !== value.component_id ||
      mapping.owner !== 'onboard' || mapping.risk_tier !== 0 || mapping.enforcement !== 'soft' ||
      canonicalJson(mapping.paths) !== canonicalJson(value.sorted_owned_paths)) invalid(`${label}.proof_path_mapping is detached`);
  return value;
}

function validateReceipt(value: unknown, projectID: string, ids: ReadonlySet<string>, workItems: readonly PlainRecord[]): PlainRecord {
  const keys = ['version', 'decision', 'project_id', 'project_fingerprint', 'boundary_fingerprint', 'inventory_claim_id', 'catalog_claim_id', 'admission_candidate_id', 'admission_result_digest', 'admission_receipt_id', 'component_authorities', 'receipt_id'];
  if (!exact(value, keys) || value.version !== CATALOG_REVALIDATION_RECEIPT_VERSION || value.decision !== 'accepted' || value.project_id !== projectID ||
      !fingerprint(value.project_fingerprint) || !fingerprint(value.boundary_fingerprint) || !fingerprint(value.inventory_claim_id) ||
      !fingerprint(value.catalog_claim_id) || !fingerprint(value.admission_candidate_id) || !fingerprint(value.admission_result_digest) ||
      !fingerprint(value.admission_receipt_id) || !fingerprint(value.receipt_id) || !Array.isArray(value.component_authorities)) invalid('catalog revalidation receipt is invalid');
  if (value.component_authorities.length !== ids.size) invalid('catalog revalidation receipt has the wrong component count');
  const seen = new Set<string>();
  for (const [index, authority] of value.component_authorities.entries()) {
    if (!plain(authority) || !exact(authority, ['component_id', 'work_item_digest', 'subject']) || typeof authority.component_id !== 'string' || !fingerprint(authority.work_item_digest) || !plain(authority.subject) || !exact(authority.subject, ['version', 'project_id', 'component_id', 'sorted_owned_paths', 'sorted_dependency_closure', 'fingerprint']) || authority.subject.version !== 'proof.component-subject/v1' || !fingerprint(authority.subject.fingerprint) || authority.subject.component_id !== authority.component_id || authority.subject.project_id !== projectID || seen.has(authority.component_id) || !ids.has(authority.component_id)) invalid(`catalog revalidation receipt component_authorities[${index}] is invalid`);
    const item = workItems.find(candidate => candidate.component_id === authority.component_id);
    if (!item || authority.work_item_digest !== plainDigest(workItemWire(item)) || canonicalJson(authority.subject) !== canonicalJson(item.proof_component_subject)) invalid(`catalog revalidation receipt component_authorities[${index}] is detached`);
    seen.add(authority.component_id);
  }
  const sorted = [...value.component_authorities].sort((left, right) => left.component_id.localeCompare(right.component_id));
  if (canonicalJson(value.component_authorities) !== canonicalJson(sorted)) invalid('catalog revalidation receipt component authorities are not sorted');
  const unsigned: PlainRecord = {
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
    component_authorities: value.component_authorities,
    receipt_id: '',
  };
  if (value.receipt_id !== domainDigest('proof.catalog-revalidation-receipt/id/v1', unsigned)) invalid('catalog revalidation receipt ID is invalid');
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

function validateRevalidationProjection(value: unknown, inventory: PlainRecord, candidate: CandidateClaimInput, admission: CandidateClaimInput, projectID: string): unknown {
  const keys = ['version', 'inventory', 'catalog', 'work_items', 'receipt'];
  if (!exact(value, keys) || value.version !== CATALOG_REVALIDATION_VERSION) invalid('catalog revalidation projection is not closed');
  const currentInventory = validateStructuralInventory(value.inventory, projectID);
  if (canonicalJson(currentInventory) !== canonicalJson(inventory)) invalid('catalog revalidation inventory is stale');
  const components = candidateComponents(candidate.payload, projectID);
  const ids = new Set(components.map(component => component.id as string));
  const catalog = projectedCatalog(value.catalog, projectID);
  const expected = expectedCatalog(candidate, projectID);
  if (canonicalJson(catalog) !== canonicalJson(expected)) invalid('catalog revalidation catalog is detached from candidate');
  const catalogComponents = (catalog.components as PlainRecord[]);
  if (new Set(catalogComponents.map(component => component.id as string)).size !== ids.size || catalogComponents.some(component => !ids.has(component.id as string))) invalid('catalog revalidation catalog is detached from candidate');
  if (!Array.isArray(value.work_items) || value.work_items.length !== ids.size) invalid('catalog revalidation WorkItems are incomplete');
  const workItems = value.work_items.map((item, index) => validateWorkItem(item, projectID, `catalog revalidation work_items[${index}]`));
  const itemIDs = new Set(workItems.map(item => item.component_id as string));
  if (itemIDs.size !== ids.size || [...ids].some(id => !itemIDs.has(id))) invalid('catalog revalidation WorkItems are detached from candidate');
  const receipt = validateReceipt(value.receipt, projectID, ids, workItems);
  if (admission.producerCheckId !== 'proof_admit' || !plain(admission.payload) || admission.payload.Status !== 'ADMITTED' || admission.payload.ClaimID !== candidate.claimId || admission.payload.PayloadFingerprint !== candidate.payloadFingerprint) invalid('admission is not the exact admitted candidate');
  const authority = (value.inventory as PlainRecord).authority;
  if (!plain(authority) || receipt.project_fingerprint !== authority.subject_fingerprint) invalid('catalog revalidation receipt project authority is detached');
  const expectedInventoryID = domainDigest('proof.structural-inventory/claim/v1', inventoryWire(currentInventory));
  const expectedCatalogID = domainDigest('proof.component-catalog-candidate/claim/v1', candidate.payload);
  if (receipt.inventory_claim_id !== expectedInventoryID || receipt.catalog_claim_id !== expectedCatalogID || receipt.admission_candidate_id !== admission.payload.CandidateID || receipt.admission_result_digest !== admission.payload.ProbeResultDigest || receipt.admission_receipt_id !== admission.payload.receipt_id) invalid('catalog revalidation receipt lineage is detached');
  return bounded(value, 'catalog revalidation projection');
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
      outputLimit: INVENTORY_OUTPUT_LIMIT,
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
    if (!sameScope([inventory, candidate, admission]) || !plain(inventory.payload) || !plain(candidate.payload)) invalid('revalidation claims are cross-scope');
    const inventoryPayload = inventory.payload as PlainRecord;
    const candidatePayload = candidate.payload as PlainRecord;
    const projectID = typeof inventoryPayload.authority === 'object' && inventoryPayload.authority && typeof (inventoryPayload.authority as PlainRecord).project_id === 'string'
      ? (inventoryPayload.authority as PlainRecord).project_id as string : typeof candidatePayload.project_id === 'string' ? candidatePayload.project_id : '';
    if (!projectID) invalid('revalidation project id is missing');
    validateStructuralInventory(inventory.payload, projectID);
    candidateComponents(candidate.payload, projectID);
    // Proof's CLI accepts the candidate bytes and the complete admission
    // decision, while Visor's admitted_receipt claim intentionally publishes
    // only the receipt. Re-wrap that exact receipt into the CLI decision
    // envelope at this boundary; no admission fields are synthesized.
    const input = goCompatibleProofJson({
      version: REVALIDATION_REQUEST_VERSION,
      candidate: candidate.payload,
      admission: { version: 'proof.role-result-candidate-cli-decision/v1', status: 'ADMITTED', receipt: admission.payload, reject_code: null },
    });
    return startProofManagedCliChild({
      binding: request.binding,
      workingDirectory: request.workingDirectory || '',
      command: ['onboarding', 'revalidate'],
      input,
      inputLimit: REVALIDATION_INPUT_LIMIT,
      outputLimit: REVALIDATION_OUTPUT_LIMIT,
      outputCanonical: false,
      projectOutput: value => validateRevalidationProjection(value, inventory.payload as PlainRecord, candidate, admission, projectID),
    }, this.capability);
  }
}

export function createProofStructuralInventoryProviderFromCapability(capability: object): ProofStructuralInventoryCheckProvider { return new ProofStructuralInventoryCheckProvider(capability, INTERNAL); }
export function createProofCatalogRevalidationProviderFromCapability(capability: object): ProofCatalogRevalidationCheckProvider { return new ProofCatalogRevalidationCheckProvider(capability, INTERNAL); }
