import type { PRInfo } from '../pr-analyzer';
import type { ReviewSummary } from '../reviewer';
import {
  canonicalJson,
  immutableCanonicalValue,
  sha256Canonical,
} from '../state-machine/graph/claim-kernel';
import {
  PROOF_ADMITTED_CATALOG_PROVIDER_TYPE,
  PROOF_ADMITTED_RECEIPT_CLAIM,
  PROOF_CATALOG_REVALIDATION_CLAIM,
  PROOF_CANDIDATE_CLAIM,
  PROOF_STRUCTURAL_INVENTORY_CLAIM,
} from '../state-machine/graph/instance-plan';
import type { CandidateClaimInput, CheckProviderConfig, ExecutionContext } from './check-provider.interface';
import { CheckProvider } from './check-provider.interface';
import { validateProofCatalogRevalidationProjection } from './proof-catalog-check-providers';

type PlainRecord = Record<string, unknown>;

export class ProofAdmittedCatalogError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ProofAdmittedCatalogError';
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new ProofAdmittedCatalogError(code, message);
}

function plain(value: unknown): value is PlainRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function claim(value: unknown, expectedClaim: string, label: string): CandidateClaimInput {
  if (!plain(value) || value.claim !== expectedClaim || typeof value.claimId !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value.claimId) || typeof value.payloadFingerprint !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value.payloadFingerprint) || !Array.isArray(value.parentClaimIds) ||
      value.parentClaimIds.some(parent => typeof parent !== 'string' || !/^[0-9a-f]{64}$/.test(parent)) ||
      !Array.isArray(value.scope) || typeof value.producerCheckId !== 'string') {
    fail('INVALID_CLAIM', `${label} is not the expected authoritative claim`);
  }
  try {
    if (canonicalJson(value.payload) !== JSON.stringify(value.payload) || sha256Canonical(value.payload) !== value.payloadFingerprint) {
      fail('DETACHED_CLAIM', `${label} payload is detached`);
    }
    if (JSON.stringify(value.scope) !== canonicalJson(value.scope) ||
        canonicalJson([...value.parentClaimIds].sort()) !== canonicalJson(value.parentClaimIds)) {
      fail('NONCANONICAL_CLAIM', `${label} scope or parents are not canonical`);
    }
  } catch (error) {
    if (error instanceof ProofAdmittedCatalogError) throw error;
    fail('INVALID_CLAIM', `${label} is not canonical JSON`);
  }
  const base = {
    claimId: value.claimId,
    claim: value.claim,
    payload: immutableCanonicalValue(value.payload),
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
  fail('INVALID_CLAIM', `${label} provenance is invalid`);
}

function projectID(inventory: CandidateClaimInput): string {
  if (!plain(inventory.payload) || !plain(inventory.payload.authority) || typeof inventory.payload.authority.project_id !== 'string' || inventory.payload.authority.project_id.length === 0) {
    fail('INVALID_REVALIDATION_RECEIPT', 'current inventory has no Proof project authority');
  }
  return inventory.payload.authority.project_id;
}

export interface AdmittedCatalogMaterializationInput {
  readonly inventory: CandidateClaimInput;
  readonly candidate: CandidateClaimInput;
  readonly admission: CandidateClaimInput;
  readonly revalidation: CandidateClaimInput;
}

/**
 * Materialize only Proof's current, accepted component WorkItems. The shared
 * validator is also used by the managed revalidation provider, so graph
 * activation and deterministic egress cannot disagree about the wire.
 */
export function materializeAdmittedCatalog(
  input: AdmittedCatalogMaterializationInput,
): Readonly<{ components: readonly PlainRecord[] }> {
  const inventory = claim(input.inventory, PROOF_STRUCTURAL_INVENTORY_CLAIM, 'current inventory');
  const candidate = claim(input.candidate, PROOF_CANDIDATE_CLAIM, 'candidate');
  const admission = claim(input.admission, PROOF_ADMITTED_RECEIPT_CLAIM, 'admission');
  const revalidation = claim(input.revalidation, PROOF_CATALOG_REVALIDATION_CLAIM, 'revalidation');
  if (inventory.producerCheckId !== 'structural_inventory') {
    fail('INVALID_CLAIM', 'current inventory is not produced by structural_inventory');
  }
  try {
    const projection = validateProofCatalogRevalidationProjection(
      revalidation.payload,
      inventory.payload as PlainRecord,
      candidate,
      admission,
      projectID(inventory),
      revalidation,
      inventory.claimId,
    );
    if (!plain(projection) || !Array.isArray(projection.work_items)) {
      fail('INVALID_REVALIDATION_RECEIPT', 'Proof projection has no WorkItems');
    }
    return immutableCanonicalValue({ components: projection.work_items as readonly PlainRecord[] });
  } catch (error) {
    if (error instanceof ProofAdmittedCatalogError) throw error;
    fail('INVALID_REVALIDATION_RECEIPT', error instanceof Error ? error.message : String(error));
  }
}

export class ProofAdmittedCatalogCheckProvider extends CheckProvider {
  getName(): string { return PROOF_ADMITTED_CATALOG_PROVIDER_TYPE; }
  getDescription(): string { return 'Sealed deterministic egress from current Proof-admitted discovery'; }
  async validateConfig(config: unknown): Promise<boolean> {
    return plain(config) && config.type === PROOF_ADMITTED_CATALOG_PROVIDER_TYPE;
  }
  async isAvailable(): Promise<boolean> { return true; }
  getRequirements(): string[] { return ['No model or transport; requires exact Proof candidate, admission, and revalidation claims']; }
  getSupportedConfigKeys(): string[] { return ['type', 'consumes', 'emits', 'expand']; }

  async execute(
    _prInfo: PRInfo,
    _config: CheckProviderConfig,
    _dependencyResults?: Map<string, ReviewSummary>,
    context?: ExecutionContext,
  ): Promise<ReviewSummary> {
    const claims = context?.claims;
    if (!claims || !plain(claims)) fail('INVALID_RUNTIME_CONTEXT', 'materializer requires projected claims');
    const values = Object.values(claims);
    const candidate = values.find(value => value.claim === PROOF_CANDIDATE_CLAIM);
    const admission = values.find(value => value.claim === PROOF_ADMITTED_RECEIPT_CLAIM);
    const revalidation = values.find(value => value.claim === PROOF_CATALOG_REVALIDATION_CLAIM);
    const inventory = values.find(value => value.claim === PROOF_STRUCTURAL_INVENTORY_CLAIM);
    if (!inventory || !candidate || !admission || !revalidation || values.length !== 4) {
      fail('MISSING_ADMISSION_INPUT', 'materializer requires exactly inventory, candidate, admission, and revalidation claims');
    }
    return { issues: [], output: materializeAdmittedCatalog({ inventory, candidate, admission, revalidation }) };
  }
}

/** Internal-only factory for focused zero-model tests. */
export function createProofAdmittedCatalogProviderForFocusedTest(): ProofAdmittedCatalogCheckProvider {
  return new ProofAdmittedCatalogCheckProvider();
}
