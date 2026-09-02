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
import type { CandidateClaimInput, CheckProviderConfig, ExecutionContext, ManagedAgentRun, ManagedRunStartRequest } from './check-provider.interface';
import { CheckProvider } from './check-provider.interface';
import {
  PROOF_REVALIDATION_REQUEST_MAX_BYTES,
  PROOF_WORK_ITEMS_OUTPUT_MAX_BYTES,
  validateProofCatalogRevalidationProjection,
  validateProofWorkItemsProjection,
} from './proof-catalog-check-providers';
import {
  goCompatibleProofJson,
  immutableProofCanonicalValue,
  proofAdmissionCapabilityValid,
  proofCanonicalJson,
  proofPayloadFingerprint,
  PROOF_ADMISSION_UNAVAILABLE,
  PROOF_ADMISSION_WIRE_FIELD,
  startProofManagedCliChild,
} from './proof-admission-cli-child';

type PlainRecord = Record<string, unknown>;
const INTERNAL = Symbol('proof-admitted-catalog-provider');

class ProofAdmittedCatalogError extends Error {
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
    const payloadFingerprint = expectedClaim === PROOF_CANDIDATE_CLAIM ? proofPayloadFingerprint(value.payload) : sha256Canonical(value.payload);
    if ((expectedClaim !== PROOF_CANDIDATE_CLAIM && canonicalJson(value.payload) !== JSON.stringify(value.payload)) || payloadFingerprint !== value.payloadFingerprint) {
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
    payload: expectedClaim === PROOF_CANDIDATE_CLAIM
      ? immutableProofCanonicalValue(value.payload)
      : immutableCanonicalValue(value.payload),
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

export class ProofAdmittedCatalogCheckProvider extends CheckProvider {
  private readonly capability: object | undefined;

  constructor(capability?: object, token?: typeof INTERNAL) {
    super();
    if (capability && (token !== INTERNAL || !proofAdmissionCapabilityValid(capability))) throw new Error(PROOF_ADMISSION_UNAVAILABLE);
    this.capability = capability;
  }
  getName(): string { return PROOF_ADMITTED_CATALOG_PROVIDER_TYPE; }
  getDescription(): string { return 'Sealed deterministic egress from current Proof-admitted discovery'; }
  async validateConfig(config: unknown): Promise<boolean> {
    return plain(config) && config.type === PROOF_ADMITTED_CATALOG_PROVIDER_TYPE;
  }
  async isAvailable(): Promise<boolean> { return this.capability !== undefined; }
  getRequirements(): string[] { return [PROOF_ADMISSION_UNAVAILABLE]; }
  getSupportedConfigKeys(): string[] { return ['type', 'consumes', 'emits', 'expand']; }

  async execute(
    _prInfo: PRInfo,
    _config: CheckProviderConfig,
    _dependencyResults?: Map<string, ReviewSummary>,
    _context?: ExecutionContext,
  ): Promise<ReviewSummary> {
    throw new Error(PROOF_ADMISSION_UNAVAILABLE);
  }

  /**
   * The expansion egress is activation-safe only when Proof recomputes the
   * WorkItems immediately before Visor emits the component catalog. The
   * revalidation.work_items member is evidence, never an activation source.
   */
  startManaged(request: ManagedRunStartRequest): ManagedAgentRun {
    if (!this.capability) throw new Error(PROOF_ADMISSION_UNAVAILABLE);
    const claims = request.executionContext.claims;
    if (!plain(claims)) throw new Error(PROOF_ADMISSION_UNAVAILABLE);
    const values = claims as Record<string, unknown>;
    const inventory = claim(values.current_inventory, PROOF_STRUCTURAL_INVENTORY_CLAIM, 'current inventory');
    const candidate = claim(values.candidate, PROOF_CANDIDATE_CLAIM, 'candidate');
    const admission = claim(values.receipt, PROOF_ADMITTED_RECEIPT_CLAIM, 'admission');
    const revalidation = claim(values.current_revalidation, PROOF_CATALOG_REVALIDATION_CLAIM, 'current revalidation');
    if (inventory.producerCheckId !== 'structural_inventory' || revalidation.producerCheckId !== 'revalidate_catalog' ||
        !plain(inventory.payload) || !plain(candidate.payload) || !plain(revalidation.payload) ||
        canonicalJson(inventory.scope) !== canonicalJson(candidate.scope) || canonicalJson(candidate.scope) !== canonicalJson(admission.scope) || canonicalJson(admission.scope) !== canonicalJson(revalidation.scope)) {
      throw new Error(PROOF_ADMISSION_UNAVAILABLE);
    }
    const projectID = projectIDFromInventory(inventory);
    const admitted = admissionWire(admission.payload);
    const projection = validateProofCatalogRevalidationProjection(revalidation.payload, inventory.payload as PlainRecord, candidate, admission, projectID, revalidation, inventory.claimId);
    const receipt = projection.receipt;
    const input = `{"version":${goCompatibleProofJson('proof.onboarding-work-items-request/v1')},"candidate":${proofCanonicalJson(candidate.payload)},"admission":${admitted.wire},"revalidation_receipt":${proofCanonicalJson(receipt)}}`;
    return startProofManagedCliChild({
      binding: request.binding,
      workingDirectory: request.workingDirectory || '',
      command: ['onboarding', 'work-items'],
      input,
      inputLimit: PROOF_REVALIDATION_REQUEST_MAX_BYTES,
      outputLimit: PROOF_WORK_ITEMS_OUTPUT_MAX_BYTES,
      outputCanonical: false,
      projectOutput: value => {
        const workItems = validateProofWorkItemsProjection(value, revalidation.payload as PlainRecord, inventory.payload as PlainRecord, candidate, admission, projectID);
        return { components: (workItems.work_items as PlainRecord[]) };
      },
    }, this.capability);
  }
}

/** Internal-only factory for focused zero-model tests. */
export function createProofAdmittedCatalogProviderForFocusedTest(): ProofAdmittedCatalogCheckProvider {
  return new ProofAdmittedCatalogCheckProvider();
}

export function createProofAdmittedCatalogProviderFromCapability(capability: object): ProofAdmittedCatalogCheckProvider {
  return new ProofAdmittedCatalogCheckProvider(capability, INTERNAL);
}

function projectIDFromInventory(inventory: CandidateClaimInput): string {
  const payload = inventory.payload as PlainRecord;
  const authority = payload.authority as PlainRecord;
  if (!plain(authority) || typeof authority.project_id !== 'string' || authority.project_id.length === 0) throw new Error(PROOF_ADMISSION_UNAVAILABLE);
  return authority.project_id;
}

function admissionWire(value: unknown): { wire: string; receipt: PlainRecord } {
  if (!plain(value) || typeof value[PROOF_ADMISSION_WIRE_FIELD] !== 'string') throw new Error(PROOF_ADMISSION_UNAVAILABLE);
  const wire = value[PROOF_ADMISSION_WIRE_FIELD] as string;
  let parsed: unknown;
  try { parsed = JSON.parse(wire); } catch { throw new Error(PROOF_ADMISSION_UNAVAILABLE); }
  if (!plain(parsed) || !plain(parsed.receipt)) throw new Error(PROOF_ADMISSION_UNAVAILABLE);
  return { wire, receipt: parsed.receipt };
}
