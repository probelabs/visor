import { PRInfo } from '../pr-analyzer';
import { CheckProvider, CheckProviderConfig, ExecutionContext, CandidateClaimInput } from './check-provider.interface';
import { ReviewSummary } from '../reviewer';
import { immutableCanonicalValue, sha256Canonical } from '../state-machine/graph/claim-kernel';
import {
  PROOF_ADMIT_PROVIDER_TYPE,
  PROOF_CANDIDATE_CLAIM,
} from '../state-machine/graph/instance-plan';

export const PROOF_ADMIT_PROVIDER_NAME = PROOF_ADMIT_PROVIDER_TYPE;
type AdmissionCandidate = Readonly<{ claimId: string; claim: typeof PROOF_CANDIDATE_CLAIM; payload: unknown; payloadFingerprint: string; producerCheckId: string; attemptId: string; fence: number; scope: unknown; parentClaimIds: readonly string[] }>;
type AdmissionRequest = Readonly<{ version: 1; candidate: AdmissionCandidate }>;
type AdmissionReceipt = Readonly<{ version: 1; kind: 'admitted'; candidateClaimId: string; candidateClaim: typeof PROOF_CANDIDATE_CLAIM; candidateFingerprint: string; candidateAttemptId: string; candidateFence: number; scope: unknown; parentClaimIds: readonly string[] }>;
type AdmissionDecision =
  | Readonly<{ kind: 'accepted'; receipt: AdmissionReceipt }>
  | Readonly<{ kind: 'rejected'; reason: string }>;
type AdmissionSink = Readonly<{ decide(request: AdmissionRequest): AdmissionDecision }>;

function fail(code: string, detail: string): never { throw new Error(`${code}: ${detail}`); }
function deeplyFrozen(value: unknown, seen = new Set<object>()): boolean {
  if (!value || typeof value !== 'object') return true;
  if (seen.has(value)) return true;
  seen.add(value);
  return Object.isFrozen(value) && Object.values(value as Record<string, unknown>).every(child => deeplyFrozen(child, seen));
}

function detachCandidate(value: unknown): AdmissionCandidate {
  const candidate = value as CandidateClaimInput;
  if (!value || typeof value !== 'object' || Array.isArray(value) || candidate.provenance !== 'attempt' || candidate.claim !== PROOF_CANDIDATE_CLAIM || typeof candidate.claimId !== 'string' || typeof candidate.payloadFingerprint !== 'string' || typeof candidate.producerCheckId !== 'string' || typeof candidate.attemptId !== 'string' || !Number.isSafeInteger(candidate.fence) || !Array.isArray(candidate.scope) || !Array.isArray(candidate.parentClaimIds)) fail('PROOF_ADMISSION_INVALID_CANDIDATE', 'candidate lacks exact attempt provenance');
  const detached = immutableCanonicalValue({
    claimId: candidate.claimId, claim: PROOF_CANDIDATE_CLAIM as typeof PROOF_CANDIDATE_CLAIM, payload: candidate.payload,
    payloadFingerprint: candidate.payloadFingerprint, producerCheckId: candidate.producerCheckId,
    attemptId: candidate.attemptId, fence: candidate.fence, scope: candidate.scope,
    parentClaimIds: candidate.parentClaimIds,
  });
  if (sha256Canonical(detached.payload) !== detached.payloadFingerprint) fail('PROOF_ADMISSION_INVALID_CANDIDATE', 'candidate fingerprint does not match payload');
  return detached;
}

function detachReceipt(value: unknown, candidate: AdmissionCandidate): AdmissionReceipt {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('PROOF_ADMISSION_INVALID_RECEIPT', 'sink returned a non-object receipt');
  const receipt = value as Record<string, unknown>;
  if (!deeplyFrozen(value) || receipt.version !== 1 || receipt.kind !== 'admitted' || receipt.candidateClaimId !== candidate.claimId || receipt.candidateClaim !== PROOF_CANDIDATE_CLAIM || receipt.candidateFingerprint !== candidate.payloadFingerprint || receipt.candidateAttemptId !== candidate.attemptId || receipt.candidateFence !== candidate.fence || sha256Canonical(receipt.scope) !== sha256Canonical(candidate.scope) || !Array.isArray(receipt.parentClaimIds) || sha256Canonical(receipt.parentClaimIds) !== sha256Canonical(candidate.parentClaimIds)) fail('PROOF_ADMISSION_INVALID_RECEIPT', 'sink receipt is mutable, has wrong parents, or is not bound to candidate');
  return immutableCanonicalValue({ version: 1, kind: 'admitted' as const, candidateClaimId: candidate.claimId, candidateClaim: PROOF_CANDIDATE_CLAIM as typeof PROOF_CANDIDATE_CLAIM, candidateFingerprint: candidate.payloadFingerprint, candidateAttemptId: candidate.attemptId, candidateFence: candidate.fence, scope: receipt.scope, parentClaimIds: receipt.parentClaimIds });
}

const proofAdmissionSink = Object.freeze({
  decide(request: AdmissionRequest): AdmissionDecision {
    const scope = request.candidate.scope as readonly unknown[];
    const first = scope[0] as Record<string, unknown> | undefined;
    if (first?.key !== 'A') return { kind: 'rejected', reason: 'deterministic fixture rejection' };
    return { kind: 'accepted', receipt: immutableCanonicalValue({ version: 1, kind: 'admitted' as const, candidateClaimId: request.candidate.claimId, candidateClaim: PROOF_CANDIDATE_CLAIM as typeof PROOF_CANDIDATE_CLAIM, candidateFingerprint: request.candidate.payloadFingerprint, candidateAttemptId: request.candidate.attemptId, candidateFence: request.candidate.fence, scope: request.candidate.scope, parentClaimIds: request.candidate.parentClaimIds }) };
  },
});

const INTERNAL_PROOF_ADMISSION_BOOTSTRAP = Symbol('proof-admission-internal-bootstrap');
export function createProofAdmitProviderForFocusedTest(sink: AdmissionSink): ProofAdmitCheckProvider { return new ProofAdmitCheckProvider(sink, INTERNAL_PROOF_ADMISSION_BOOTSTRAP); }

export class ProofAdmitCheckProvider extends CheckProvider {
  private readonly sink: AdmissionSink;
  constructor(sink: AdmissionSink = proofAdmissionSink, token?: typeof INTERNAL_PROOF_ADMISSION_BOOTSTRAP) {
    super();
    if (sink !== proofAdmissionSink && token !== INTERNAL_PROOF_ADMISSION_BOOTSTRAP) fail('PROOF_ADMISSION_INVALID_BOOTSTRAP', 'custom sink requires internal bootstrap');
    this.sink = sink;
  }
  getName(): string { return PROOF_ADMIT_PROVIDER_NAME; }
  getDescription(): string { return 'Sealed built-in proof candidate admission provider'; }
  async validateConfig(config: unknown): Promise<boolean> {
    return !!config && typeof config === 'object' && (config as CheckProviderConfig).type === PROOF_ADMIT_PROVIDER_NAME;
  }
  async execute(_pr: PRInfo, config: CheckProviderConfig, _deps?: Map<string, ReviewSummary>, context?: ExecutionContext): Promise<ReviewSummary> {
    if (config.type !== PROOF_ADMIT_PROVIDER_NAME) fail('PROOF_ADMISSION_INVALID_CONFIG', `expected type ${PROOF_ADMIT_PROVIDER_NAME}`);
    const claims = Object.values(context?.claims || {});
    if (claims.length !== 1 || claims[0].claim !== PROOF_CANDIDATE_CLAIM) {
      fail('PROOF_ADMISSION_INVALID_CANDIDATE', 'exactly one proof candidate claim is required');
    }
    const candidate = detachCandidate(claims[0]);
    const decision = this.sink.decide(immutableCanonicalValue({ version: 1, candidate }));
    if (decision.kind === 'rejected') throw new Error('PROOF_ADMISSION_REJECTED');
    return { issues: [], output: detachReceipt(decision.receipt, candidate) };
  }
  getSupportedConfigKeys(): string[] { return ['type']; }
  async isAvailable(): Promise<boolean> { return true; }
  getRequirements(): string[] { return ['No external dependencies required']; }
}
