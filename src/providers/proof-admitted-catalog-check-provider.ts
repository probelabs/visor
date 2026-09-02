import type { PRInfo } from '../pr-analyzer';
import type { ReviewSummary } from '../reviewer';
import {
  canonicalJson,
  immutableCanonicalValue,
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
  validateGovernedProofCandidateClaim,
  validateProofCandidateAdmissionBinding,
  validateProofCatalogRevalidationProjection,
  validateProofWorkItemsProjection,
} from './proof-catalog-check-providers';
import {
  goCompatibleProofJson,
  proofAdmissionCapabilityValid,
  proofCanonicalJson,
  PROOF_ADMISSION_UNAVAILABLE,
  startProofManagedCliChild,
} from './proof-admission-cli-child';
import {
  governedCanonicalJson,
  governedPayloadFingerprint,
  immutableGovernedValue,
  type GovernedWireMode,
} from './proof-wire';

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
  const candidateAuthority = expectedClaim === PROOF_CANDIDATE_CLAIM
    ? validateGovernedProofCandidateClaim(value, label)
    : undefined;
  const source = candidateAuthority?.snapshot ?? value;
  if (!plain(source) || source.claim !== expectedClaim || typeof source.claimId !== 'string' ||
      !/^[0-9a-f]{64}$/.test(source.claimId) || typeof source.payloadFingerprint !== 'string' ||
      !/^[0-9a-f]{64}$/.test(source.payloadFingerprint) || !Array.isArray(source.parentClaimIds) ||
      source.parentClaimIds.some(parent => typeof parent !== 'string' || !/^[0-9a-f]{64}$/.test(parent)) ||
      !Array.isArray(source.scope) || typeof source.producerCheckId !== 'string') {
    fail('INVALID_CLAIM', `${label} is not the expected authoritative claim`);
  }
  if (expectedClaim !== PROOF_CANDIDATE_CLAIM && source.proofAdmission !== undefined) {
    fail('INVALID_CLAIM', `${label} proof admission evidence is reserved for governed candidates`);
  }
  const wireMode: GovernedWireMode = candidateAuthority
    ? candidateAuthority.wireMode
    : source.wireMode === undefined ? 'generic' : source.wireMode as GovernedWireMode;
  try {
    if (wireMode !== 'generic' && wireMode !== 'proof') fail('INVALID_CLAIM', `${label} wire mode is invalid`);
    const payloadFingerprint = governedPayloadFingerprint(source.payload, wireMode);
    if ((wireMode === 'generic' && canonicalJson(source.payload) !== JSON.stringify(source.payload)) || payloadFingerprint !== source.payloadFingerprint) {
      fail('DETACHED_CLAIM', `${label} payload is detached`);
    }
    if (JSON.stringify(source.scope) !== canonicalJson(source.scope) ||
        canonicalJson([...source.parentClaimIds].sort()) !== canonicalJson(source.parentClaimIds)) {
      fail('NONCANONICAL_CLAIM', `${label} scope or parents are not canonical`);
    }
  } catch (error) {
    if (error instanceof ProofAdmittedCatalogError) throw error;
    fail('INVALID_CLAIM', `${label} is not canonical JSON`);
  }
  const base = {
    claimId: source.claimId,
    claim: source.claim,
    payload: immutableGovernedValue(source.payload, wireMode),
    payloadFingerprint: source.payloadFingerprint,
    producerCheckId: source.producerCheckId,
    scope: immutableCanonicalValue(source.scope),
    parentClaimIds: immutableCanonicalValue(source.parentClaimIds),
    wireMode,
    ...(candidateAuthority ? { proofAdmission: candidateAuthority.evidence } : {}),
  };
  const project = (candidate: object): CandidateClaimInput => {
    const projected = immutableCanonicalValue(candidate) as CandidateClaimInput;
    return wireMode === 'proof'
      ? Object.freeze({ ...projected, payload: immutableGovernedValue(source.payload, wireMode) }) as CandidateClaimInput
      : projected;
  };
  if (source.provenance === 'controller' && typeof source.catalogClaimId === 'string' && Number.isSafeInteger(source.incarnation)) {
    return project({ ...base, provenance: 'controller' as const, catalogClaimId: source.catalogClaimId, incarnation: source.incarnation as number });
  }
  if ((source.provenance === undefined || source.provenance === 'attempt') && typeof source.attemptId === 'string' && Number.isSafeInteger(source.fence)) {
    return project({ ...base, provenance: 'attempt' as const, attemptId: source.attemptId, fence: source.fence as number });
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
    if (candidate.wireMode !== 'proof') throw new Error(PROOF_ADMISSION_UNAVAILABLE);
    if (inventory.producerCheckId !== 'structural_inventory' || revalidation.producerCheckId !== 'revalidate_catalog' ||
        !plain(inventory.payload) || !plain(candidate.payload) || !plain(revalidation.payload) ||
        canonicalJson(inventory.scope) !== canonicalJson(candidate.scope) || canonicalJson(candidate.scope) !== canonicalJson(admission.scope) || canonicalJson(admission.scope) !== canonicalJson(revalidation.scope)) {
      throw new Error(PROOF_ADMISSION_UNAVAILABLE);
    }
    const projectID = projectIDFromInventory(inventory);
    const admitted = validateProofCandidateAdmissionBinding(candidate, admission);
    const projection = validateProofCatalogRevalidationProjection(revalidation.payload, inventory.payload as PlainRecord, candidate, admission, projectID, revalidation, inventory.claimId);
    const receipt = projection.receipt;
    const input = `{"version":${goCompatibleProofJson('proof.onboarding-work-items-request/v1')},"candidate":${governedCanonicalJson(candidate.payload, candidate.wireMode)},"admission":${admitted.wire},"revalidation_receipt":${proofCanonicalJson(receipt)}}`;
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
        const receipt = revalidation.payload && plain(revalidation.payload) ? revalidation.payload.receipt : undefined;
        const authorities = receipt && plain(receipt) && Array.isArray(receipt.component_authorities) ? receipt.component_authorities as PlainRecord[] : [];
        return { components: (workItems.work_items as PlainRecord[]).map(item => {
          const authority = authorities.find(row => row.component_id === item.component_id);
          if (!authority) throw new Error(PROOF_ADMISSION_UNAVAILABLE);
          // The compact authority is the stable catalog item's only runtime
          // binding. Aggregate receipt/admission lineage is recovered from
          // controller journal claims at activation time.
          return { ...item, authority: { component_id: authority.component_id, work_item_digest: authority.work_item_digest, subject: authority.subject } };
        }) };
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
