import type { PRInfo } from '../pr-analyzer';
import type { ReviewSummary } from '../reviewer';
import { canonicalJson, immutableCanonicalValue, sha256Canonical } from '../state-machine/graph/claim-kernel';
import {
  PROOF_ADMITTED_RECEIPT_CLAIM,
  PROOF_CANDIDATE_CLAIM,
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
  startProofManagedCliChild,
} from './proof-admission-cli-child';

const INTERNAL = Symbol('proof-catalog-provider');
const REQUEST_VERSION = 'proof.catalog-revalidation-cli-request/v1';
export const STRUCTURAL_INVENTORY_VERSION = 'proof.structural-inventory/v1';
export const CATALOG_REVALIDATION_VERSION = 'proof.catalog-revalidation/v1';
const MAX_BYTES = 131072;
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
function fingerprint(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}
function boundedCanonical(value: unknown, label: string): string {
  let encoded: string;
  try { encoded = canonicalJson(value); } catch { invalid(`${label} is not canonical JSON`); }
  if (JSON.stringify(value) !== encoded) invalid(`${label} is not canonically ordered`);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_BYTES) invalid(`${label} exceeds ${MAX_BYTES} bytes`);
  return encoded;
}
function sortedStrings(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 4096 ||
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
  if (boundedCanonical(value.payload, `${label} payload`) !== JSON.stringify(value.payload) ||
      sha256Canonical(payload) !== value.payloadFingerprint) invalid(`${label} payload is detached`);
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
  if (value.provenance === 'controller' && typeof value.catalogClaimId === 'string' &&
      Number.isSafeInteger(value.incarnation)) {
    return immutableCanonicalValue({ ...base, provenance: 'controller' as const,
      catalogClaimId: value.catalogClaimId, incarnation: value.incarnation as number });
  }
  if ((value.provenance === undefined || value.provenance === 'attempt') &&
      typeof value.attemptId === 'string' && Number.isSafeInteger(value.fence)) {
    return immutableCanonicalValue({ ...base, provenance: 'attempt' as const,
      attemptId: value.attemptId, fence: value.fence as number });
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

function validateStructuralInventoryOutput(value: unknown, project: CandidateClaimInput): unknown {
  const keys = ['version', 'project_id', 'revision_fingerprint', 'boundary_fingerprint', 'source_paths', 'package_identities'];
  if (!exact(value, keys) || value.version !== STRUCTURAL_INVENTORY_VERSION ||
      !plain(project.payload) || value.project_id !== project.payload.project_id ||
      !fingerprint(value.revision_fingerprint) || !fingerprint(value.boundary_fingerprint)) {
    invalid('structural inventory is not bound to the selected project');
  }
  sortedStrings(value.source_paths, 'source_paths');
  sortedStrings(value.package_identities, 'package_identities');
  boundedCanonical(value, 'structural inventory');
  return immutableCanonicalValue(value);
}

function validateRevalidationOutput(
  value: unknown,
  inventory: CandidateClaimInput,
  candidate: CandidateClaimInput,
  admission: CandidateClaimInput,
): unknown {
  const keys = ['version', 'status', 'structural_inventory_claim_id', 'revision_fingerprint',
    'boundary_fingerprint', 'candidate_claim_id', 'admission_receipt_claim_id',
    'candidate_payload_fingerprint', 'work_items'];
  if (!exact(value, keys) || value.version !== CATALOG_REVALIDATION_VERSION || value.status !== 'ACCEPTED' ||
      !plain(inventory.payload) || value.structural_inventory_claim_id !== inventory.claimId ||
      value.revision_fingerprint !== inventory.payload.revision_fingerprint ||
      value.boundary_fingerprint !== inventory.payload.boundary_fingerprint ||
      value.candidate_claim_id !== candidate.claimId || value.admission_receipt_claim_id !== admission.claimId ||
      value.candidate_payload_fingerprint !== candidate.payloadFingerprint || !Array.isArray(value.work_items) ||
      value.work_items.length < 2 || value.work_items.length > 4) {
    invalid('catalog revalidation is stale or detached');
  }
  boundedCanonical(value, 'catalog revalidation');
  return immutableCanonicalValue(value);
}

abstract class ProofCatalogCliProvider extends CheckProvider {
  protected readonly capability: object | undefined;
  constructor(capability?: object, token?: typeof INTERNAL) {
    super();
    if (capability && (token !== INTERNAL || !proofAdmissionCapabilityValid(capability))) invalid('capability is invalid');
    this.capability = capability;
  }
  async execute(_pr: PRInfo, _config: CheckProviderConfig, _deps?: Map<string, ReviewSummary>, _context?: ExecutionContext): Promise<ReviewSummary> {
    throw new Error(PROOF_ADMISSION_UNAVAILABLE);
  }
  async isAvailable(): Promise<boolean> { return this.capability !== undefined; }
  getRequirements(): string[] { return [PROOF_ADMISSION_UNAVAILABLE]; }
  getSupportedConfigKeys(): string[] { return ['type', 'consumes', 'emits']; }
}

export class ProofStructuralInventoryCheckProvider extends ProofCatalogCliProvider {
  getName(): string { return PROOF_STRUCTURAL_INVENTORY_PROVIDER_TYPE; }
  getDescription(): string { return 'Sealed Proof structural inventory provider'; }
  async validateConfig(config: unknown): Promise<boolean> {
    return plain(config) && config.type === PROOF_STRUCTURAL_INVENTORY_PROVIDER_TYPE &&
      Object.keys(config).every(key => ['type', 'consumes', 'emits'].includes(key));
  }
  startManaged(request: ManagedRunStartRequest): ManagedAgentRun {
    const claims = onlyClaims(request.executionContext.claims, ['project']);
    const project = claim(claims.project, 'project.discovery_item@1', 'project');
    const input = boundedCanonical(immutableCanonicalValue({ version: 'proof.structural-inventory-cli-request/v1', project }), 'structural inventory request');
    return startProofManagedCliChild({ binding: request.binding, workingDirectory: request.workingDirectory || '',
      command: 'structural-inventory', input,
      projectOutput: value => validateStructuralInventoryOutput(value, project) }, this.capability);
  }
}

export class ProofCatalogRevalidationCheckProvider extends ProofCatalogCliProvider {
  getName(): string { return PROOF_CATALOG_REVALIDATION_PROVIDER_TYPE; }
  getDescription(): string { return 'Sealed Proof current-catalog revalidation provider'; }
  async validateConfig(config: unknown): Promise<boolean> {
    return plain(config) && config.type === PROOF_CATALOG_REVALIDATION_PROVIDER_TYPE &&
      Object.keys(config).every(key => ['type', 'depends_on', 'consumes', 'emits'].includes(key));
  }
  startManaged(request: ManagedRunStartRequest): ManagedAgentRun {
    const claims = onlyClaims(request.executionContext.claims, ['current_inventory', 'candidate', 'receipt']);
    const inventory = claim(claims.current_inventory, PROOF_STRUCTURAL_INVENTORY_CLAIM, 'current inventory');
    const candidate = claim(claims.candidate, PROOF_CANDIDATE_CLAIM, 'candidate');
    const admission = claim(claims.receipt, PROOF_ADMITTED_RECEIPT_CLAIM, 'admission');
    if (!sameScope([inventory, candidate, admission])) invalid('revalidation claims are cross-scope');
    const input = boundedCanonical(immutableCanonicalValue({ version: REQUEST_VERSION, inventory, candidate, admission }), 'catalog revalidation request');
    return startProofManagedCliChild({ binding: request.binding, workingDirectory: request.workingDirectory || '',
      command: 'catalog-revalidate', input,
      projectOutput: value => validateRevalidationOutput(value, inventory, candidate, admission) }, this.capability);
  }
}

export function createProofStructuralInventoryProviderFromCapability(capability: object): ProofStructuralInventoryCheckProvider {
  return new ProofStructuralInventoryCheckProvider(capability, INTERNAL);
}
export function createProofCatalogRevalidationProviderFromCapability(capability: object): ProofCatalogRevalidationCheckProvider {
  return new ProofCatalogRevalidationCheckProvider(capability, INTERNAL);
}
