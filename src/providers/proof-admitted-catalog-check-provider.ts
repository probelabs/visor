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
} from '../state-machine/graph/instance-plan';
import type { CandidateClaimInput, CheckProviderConfig, ExecutionContext } from './check-provider.interface';
import { CheckProvider } from './check-provider.interface';

/**
 * The maximum amount of model/Proof material a deterministic egress node will
 * inspect.  This is deliberately smaller than the candidate wire limit: a
 * catalog is a bounded control-plane object, not an additional source dump.
 */
export const ADMITTED_CATALOG_MAX_BYTES = 131072;
export const ADMITTED_CATALOG_MIN_ITEMS = 2;
export const ADMITTED_CATALOG_MAX_ITEMS = 4;
export const CATALOG_REVALIDATION_VERSION = 'proof.catalog-revalidation/v1';

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

function exact(value: unknown, expected: readonly string[]): value is PlainRecord {
  return plain(value) && Reflect.ownKeys(value).length === expected.length &&
    Reflect.ownKeys(value).every((key) => typeof key === 'string' && expected.includes(key) && (() => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return !!descriptor && 'value' in descriptor && descriptor.enumerable;
    })());
}

function digest(value: unknown): string {
  return sha256Canonical(value);
}

function claim(value: unknown, expectedClaim: string, label: string): CandidateClaimInput {
  if (!plain(value) || value.claim !== expectedClaim || typeof value.claimId !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value.claimId) || typeof value.payloadFingerprint !== 'string' ||
      !/^[0-9a-f]{64}$/.test(value.payloadFingerprint) || !Array.isArray(value.parentClaimIds) ||
      value.parentClaimIds.some(parent => typeof parent !== 'string' || !/^[0-9a-f]{64}$/.test(parent)) ||
      !Array.isArray(value.scope)) {
    fail('INVALID_CLAIM', `${label} is not the expected authoritative claim`);
  }
  try {
    if (JSON.stringify(value.payload) !== canonicalJson(value.payload) || digest(value.payload) !== value.payloadFingerprint) fail('DETACHED_CLAIM', `${label} payload is detached`);
    if (JSON.stringify(value.scope) !== canonicalJson(value.scope) || canonicalJson([...value.parentClaimIds].sort()) !== canonicalJson(value.parentClaimIds)) fail('NONCANONICAL_CLAIM', `${label} scope or parents are not canonical`);
  } catch (error) {
    if (error instanceof ProofAdmittedCatalogError) throw error;
    fail('INVALID_CLAIM', `${label} is not canonical JSON`);
  }
  return value as CandidateClaimInput;
}

function sameScope(left: unknown, right: unknown): boolean {
  try { return canonicalJson(left) === canonicalJson(right); } catch { return false; }
}

function boundedCanonical(value: unknown, label: string): void {
  let encoded: string;
  try { encoded = canonicalJson(value); } catch { fail('NONCANONICAL_CATALOG', `${label} is not canonical JSON`); }
  if (Buffer.byteLength(encoded, 'utf8') > ADMITTED_CATALOG_MAX_BYTES) {
    fail('CATALOG_TOO_LARGE', `${label} exceeds ${ADMITTED_CATALOG_MAX_BYTES} bytes`);
  }
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    fail('INVALID_CATALOG', `${label} must be a bounded visible string`);
  }
  return value;
}

function candidateComponents(candidate: CandidateClaimInput): readonly PlainRecord[] {
  if (!plain(candidate.payload) || !Array.isArray(candidate.payload.components)) {
    fail('INVALID_DISCOVERY_CANDIDATE', 'candidate payload must contain components');
  }
  const components = candidate.payload.components;
  if (components.length < ADMITTED_CATALOG_MIN_ITEMS || components.length > ADMITTED_CATALOG_MAX_ITEMS) {
    fail('INVALID_DISCOVERY_CANDIDATE', `candidate must contain ${ADMITTED_CATALOG_MIN_ITEMS} through ${ADMITTED_CATALOG_MAX_ITEMS} components`);
  }
  const ids = new Set<string>();
  return components.map((item, index) => {
    if (!plain(item)) fail('INVALID_DISCOVERY_CANDIDATE', `candidate component ${index} is not an object`);
    const id = requireString(item.component_id, `candidate component ${index}.component_id`);
    if (ids.has(id)) fail('DUPLICATE_COMPONENT', `candidate contains duplicate component ${id}`);
    ids.add(id);
    return item;
  });
}

function validateAdmission(candidate: CandidateClaimInput, admission: CandidateClaimInput): void {
  if (admission.producerCheckId !== 'proof_admit' || admission.parentClaimIds.length !== 1 ||
      admission.parentClaimIds[0] !== candidate.claimId || !sameScope(candidate.scope, admission.scope)) {
    fail('ADMISSION_LINEAGE_MISMATCH', 'admission is not the exact Proof admission of this candidate');
  }
  if (!plain(admission.payload) || admission.payload.Status !== 'ADMITTED' ||
      admission.payload.ClaimID !== candidate.claimId ||
      admission.payload.Claim !== candidate.claim ||
      admission.payload.PayloadFingerprint !== candidate.payloadFingerprint ||
      admission.payload.ProducerCheckID !== admission.producerCheckId ||
      !Array.isArray(admission.payload.ParentClaimIDs) ||
      canonicalJson(admission.payload.ParentClaimIDs) !== canonicalJson(candidate.parentClaimIds) ||
      typeof admission.payload.receipt_id !== 'string' || admission.payload.receipt_id.length === 0) {
    fail('ADMISSION_RECEIPT_MISMATCH', 'Proof admission receipt is missing or detached from candidate');
  }
}

interface RevalidatedWorkItem extends PlainRecord {
  readonly component_id: string;
}

function revalidatedItems(
  candidate: CandidateClaimInput,
  admission: CandidateClaimInput,
  revalidation: CandidateClaimInput,
): readonly RevalidatedWorkItem[] {
  if (revalidation.producerCheckId !== 'revalidate_catalog' ||
      revalidation.parentClaimIds.length !== 3 ||
      !revalidation.parentClaimIds.includes(candidate.claimId) ||
      !revalidation.parentClaimIds.includes(admission.claimId) ||
      !sameScope(candidate.scope, revalidation.scope)) {
    fail('REVALIDATION_LINEAGE_MISMATCH', 'catalog revalidation is not bound to this candidate and admission');
  }
  const payload = revalidation.payload;
  const expectedKeys = [
    'version', 'status', 'candidate_claim_id', 'admission_receipt_claim_id',
    'candidate_payload_fingerprint', 'revision_fingerprint', 'work_items',
  ];
  if (!exact(payload, expectedKeys) || payload.version !== CATALOG_REVALIDATION_VERSION ||
      payload.status !== 'ACCEPTED' || payload.candidate_claim_id !== candidate.claimId ||
      payload.admission_receipt_claim_id !== admission.claimId ||
      payload.candidate_payload_fingerprint !== candidate.payloadFingerprint ||
      typeof payload.revision_fingerprint !== 'string' ||
      !/^[0-9a-f]{64}$/.test(payload.revision_fingerprint) ||
      !Array.isArray(payload.work_items)) {
    fail('INVALID_REVALIDATION_RECEIPT', 'catalog revalidation receipt is not the current accepted receipt');
  }
  const candidateIds = new Set(candidateComponents(candidate).map(item => item.component_id as string));
  const seen = new Set<string>();
  const items = payload.work_items.map((item, index) => {
    if (!plain(item)) fail('INVALID_WORK_ITEM', `revalidated WorkItem ${index} is not an object`);
    const id = requireString(item.component_id, `revalidated WorkItem ${index}.component_id`);
    if (!candidateIds.has(id)) fail('WORK_ITEM_SCOPE_MISMATCH', `WorkItem ${id} was not discovered by candidate`);
    if (seen.has(id)) fail('DUPLICATE_COMPONENT', `revalidation contains duplicate WorkItem ${id}`);
    seen.add(id);
    return item as RevalidatedWorkItem;
  });
  if (items.length !== candidateIds.size || seen.size !== candidateIds.size) {
    fail('INCOMPLETE_WORK_ITEM_CATALOG', 'revalidation does not materialize every discovered component');
  }
  const sorted = [...items].sort((left, right) => left.component_id.localeCompare(right.component_id));
  if (canonicalJson(items) !== canonicalJson(sorted)) {
    fail('NONCANONICAL_WORK_ITEM_ORDER', 'revalidated WorkItems must be sorted by component_id');
  }
  return sorted;
}

export interface AdmittedCatalogMaterializationInput {
  readonly input?: CandidateClaimInput;
  readonly candidate: CandidateClaimInput;
  readonly admission: CandidateClaimInput;
  readonly revalidation: CandidateClaimInput;
}

/**
 * Materialize only Proof's current, accepted component WorkItems.  The
 * function is pure and intentionally does not hash source files or infer
 * boundaries; Proof supplies the WorkItem payloads in its receipt.
 */
export function materializeAdmittedCatalog(
  input: AdmittedCatalogMaterializationInput
): Readonly<{ components: readonly RevalidatedWorkItem[] }> {
  const candidate = claim(input.candidate, PROOF_CANDIDATE_CLAIM, 'candidate');
  const admission = claim(input.admission, PROOF_ADMITTED_RECEIPT_CLAIM, 'admission');
  const revalidation = claim(input.revalidation, PROOF_CATALOG_REVALIDATION_CLAIM, 'revalidation');
  if (input.input && !sameScope(input.input.scope, candidate.scope)) {
    fail('INPUT_SCOPE_MISMATCH', 'project input and discovery claims are not co-scoped');
  }
  validateAdmission(candidate, admission);
  const items = revalidatedItems(candidate, admission, revalidation);
  const output = immutableCanonicalValue({ components: items });
  boundedCanonical(output, 'materialized catalog');
  return output;
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
    const input = values.find(value => value !== candidate && value !== admission && value !== revalidation);
    if (!candidate || !admission || !revalidation || values.length !== 4) {
      fail('MISSING_ADMISSION_INPUT', 'materializer requires exactly project, candidate, admission, and revalidation claims');
    }
    return { issues: [], output: materializeAdmittedCatalog({ input, candidate, admission, revalidation }) };
  }
}

/** Internal-only factory for focused zero-model tests. */
export function createProofAdmittedCatalogProviderForFocusedTest(): ProofAdmittedCatalogCheckProvider {
  return new ProofAdmittedCatalogCheckProvider();
}
