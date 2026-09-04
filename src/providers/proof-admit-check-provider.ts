import type { PRInfo } from '../pr-analyzer';
import { CheckProvider, type CheckProviderConfig, type ExecutionContext, type ManagedAgentRun, type ManagedRunStartRequest } from './check-provider.interface';
import type { ReviewSummary } from '../reviewer';
import { canonicalJson, immutableCanonicalValue } from '../state-machine/graph/claim-kernel';
import { PROOF_ADMIT_PROVIDER_TYPE } from '../state-machine/graph/instance-plan';
import { governedCanonicalJson } from './proof-wire';
import {
  createProofAdmissionCliChildForFocusedTest,
  extractProofAdmissionCandidate,
  proofAdmissionCapabilityValid,
  PROOF_ADMISSION_UNAVAILABLE,
  startProofAdmissionCliChild,
} from './proof-admission-cli-child';

export const PROOF_ADMIT_PROVIDER_NAME = PROOF_ADMIT_PROVIDER_TYPE;
const INTERNAL = Symbol('proof-admit-focused-test');

function invalid(detail: string): never { throw new Error(`PROOF_ADMISSION_INVALID_CONFIG: ${detail}`); }

type PlainRecord = Record<string, unknown>;
type ProofAdmissionChildRequest = Readonly<{
  binding: ManagedRunStartRequest['binding'];
  workingDirectory: string;
  proofAdmissionRequest: string;
}>;

type AdmissionProtocol = Readonly<{
  checkId: 'proof_admit' | 'spec_review_admit';
  dependency: 'inspect' | 'spec_review';
  candidateClaim: 'proof.candidate@1' | 'proof.component_spec_review_candidate@1';
  candidateProducer: 'inspect' | 'spec_review';
  receiptClaim: 'proof.admitted_receipt@1' | 'proof.component_spec_review_admitted_receipt@1';
}>;

const LEGACY_PROTOCOL: AdmissionProtocol = Object.freeze({
  checkId: 'proof_admit',
  dependency: 'inspect', candidateClaim: 'proof.candidate@1', candidateProducer: 'inspect',
  receiptClaim: 'proof.admitted_receipt@1',
});
const STAGED_PROTOCOL: AdmissionProtocol = Object.freeze({
  checkId: 'spec_review_admit',
  dependency: 'spec_review', candidateClaim: 'proof.component_spec_review_candidate@1', candidateProducer: 'spec_review',
  receiptClaim: 'proof.component_spec_review_admitted_receipt@1',
});

function plain(value: unknown): value is PlainRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactOwnKeys(value: object, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length && keys.every(key => typeof key === 'string' && expected.includes(key) && (() => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !!descriptor && 'value' in descriptor && descriptor.enumerable;
  })());
}

function exactConsume(value: unknown): value is PlainRecord {
  return plain(value) && (exactOwnKeys(value, ['claim', 'as']) ||
    (exactOwnKeys(value, ['claim', 'as', 'cardinality']) && value.cardinality === 'one'));
}

function admissionProtocol(config: CheckProviderConfig): AdmissionProtocol {
  const consumes = config.consumes;
  const emits = config.emits;
  if (!Array.isArray(consumes) || consumes.length !== 1 || !exactConsume(consumes[0]) || !Array.isArray(emits) || emits.length !== 1 ||
      !plain(emits[0]) || !exactOwnKeys(emits[0], ['claim', 'from']) || emits[0].from !== 'output') {
    invalid('admission protocol bindings are not closed');
  }
  const staged = consumes[0].claim === STAGED_PROTOCOL.candidateClaim && emits[0].claim === STAGED_PROTOCOL.receiptClaim;
  const protocol = staged ? STAGED_PROTOCOL : LEGACY_PROTOCOL;
  if (consumes[0].claim !== protocol.candidateClaim || consumes[0].as !== 'candidate' || emits[0].claim !== protocol.receiptClaim) {
    invalid('admission protocol claim bindings are invalid');
  }
  return protocol;
}

function lowerScope(value: unknown): unknown {
  return Array.isArray(value) ? value.map(part => plain(part) ? {
    kind: part.Kind, expansionOwnerCheck: part.ExpansionOwnerCheck, key: part.Key, subgraphInstanceId: part.SubgraphInstanceID,
  } : null) : undefined;
}

function candidateMatchesExecutionClaim(candidate: PlainRecord, extracted: ReturnType<typeof extractProofAdmissionCandidate>, binding: ManagedRunStartRequest['binding']): boolean {
  const wire = extracted.candidate;
  const publication = wire.Publication as PlainRecord;
  const wireBinding = wire.Binding as PlainRecord;
  const termination = wire.Termination as PlainRecord;
  const terminationBinding = termination.Binding as PlainRecord;
  let payloadText: string;
  try {
    const payloadBytes = Buffer.from(String(wire.ProbeResultBytes), 'base64');
    payloadText = new TextDecoder('utf-8', { fatal: true }).decode(payloadBytes);
    JSON.parse(payloadText);
  } catch { return false; }
  const sameAdmissionScope = binding.sessionId === wireBinding.SessionID && canonicalJson(binding.scope) === canonicalJson(lowerScope(wireBinding.Scope));
  const matches = candidate.claimId === publication.ClaimID && candidate.payloadFingerprint === publication.PayloadFingerprint &&
    candidate.wireMode === extracted.wireMode && governedCanonicalJson(candidate.payload, extracted.wireMode) === payloadText && candidate.producerCheckId === publication.ProducerCheckID &&
    canonicalJson(candidate.parentClaimIds) === canonicalJson(publication.ParentClaimIDs) && canonicalJson(candidate.scope) === canonicalJson(lowerScope(publication.Scope)) &&
    candidate.attemptId === publication.AttemptID && candidate.fence === publication.Fence && sameAdmissionScope &&
    canonicalJson(publication.Scope) === canonicalJson(wireBinding.Scope) && canonicalJson(terminationBinding) === canonicalJson(wireBinding) &&
    termination.SessionID === wireBinding.SessionID && canonicalJson(termination.Scope) === canonicalJson(wireBinding.Scope);
  return matches;
}

function proofAdmissionChildRequest(request: ManagedRunStartRequest): ProofAdmissionChildRequest {
  if (!plain(request.checkConfig) || request.checkConfig.type !== PROOF_ADMIT_PROVIDER_NAME) {
    invalid('provider type is not proof-admit');
  }
  const forbiddenConfigKeys = ['command', 'exec', 'workingDirectory', 'env', 'args', 'command_args', 'interpreter', 'url', 'method', 'headers', 'stdin', 'content', 'ai_model', 'ai_provider'];
  for (const key of forbiddenConfigKeys) {
    if (Object.prototype.hasOwnProperty.call(request.checkConfig, key) && request.checkConfig[key] !== undefined) {
      invalid(`provider config contains ${key}`);
    }
  }
  const controllerAi = request.checkConfig.ai;
  if (controllerAi !== undefined && (!plain(controllerAi) || !exactOwnKeys(controllerAi, ['timeout', 'debug']) || typeof controllerAi.timeout !== 'number' || typeof controllerAi.debug !== 'boolean')) {
    invalid('provider config contains unauthorised ai options');
  }
  const protocol = admissionProtocol(request.checkConfig);
  if (request.binding.checkId !== protocol.checkId) invalid('admission binding check is invalid');

  const dependencies = request.dependencyResults as unknown;
  if (!dependencies || typeof dependencies !== 'object' || typeof Reflect.get(dependencies, 'size') !== 'number' || typeof Reflect.get(dependencies, 'keys') !== 'function') {
    invalid('dependency results are not a map');
  }
  let dependencyKeys: string[];
  try {
    dependencyKeys = Array.from((Reflect.get(dependencies, 'keys') as () => Iterable<string>).call(dependencies));
  } catch {
    invalid('dependency results cannot be inspected');
  }
  if (dependencyKeys.length !== 1 || dependencyKeys[0] !== protocol.dependency || Reflect.get(dependencies, 'size') !== 1) {
    invalid('proof admission requires exactly the inspect dependency');
  }

  const claims = request.executionContext && request.executionContext.claims;
  if (!plain(claims) || !exactOwnKeys(claims, ['candidate'])) invalid('candidate claim alias is invalid');
  const candidate = claims.candidate;
  if (!plain(candidate) || candidate.claim !== protocol.candidateClaim || candidate.producerCheckId !== protocol.candidateProducer || candidate.provenance !== 'attempt' || typeof candidate.attemptId !== 'string' || !Number.isSafeInteger(candidate.fence)) {
    invalid('candidate claim authority is invalid');
  }
  try {
    const extracted = extractProofAdmissionCandidate(request.proofAdmissionRequest);
    const invocation = extracted.candidate.Invocation as Record<string, unknown>;
    const staged = Object.prototype.hasOwnProperty.call(invocation, 'onboarding_stage');
    if (staged !== (protocol === STAGED_PROTOCOL) || extracted.candidate.Publication.CheckID !== protocol.candidateProducer || extracted.candidate.Publication.Claim !== protocol.candidateClaim || !candidateMatchesExecutionClaim(candidate, extracted, request.binding)) {
      invalid('candidate evidence protocol is detached');
    }
  } catch {
    invalid('candidate evidence is invalid');
  }
  if (typeof request.workingDirectory !== 'string' || request.workingDirectory.length === 0 || !request.workingDirectory.startsWith('/') || typeof request.proofAdmissionRequest !== 'string' || request.proofAdmissionRequest.length === 0) {
    throw new Error(PROOF_ADMISSION_UNAVAILABLE);
  }
  return Object.freeze({
    binding: immutableCanonicalValue(request.binding),
    workingDirectory: request.workingDirectory,
    proofAdmissionRequest: request.proofAdmissionRequest,
  });
}

export function createProofAdmitProviderForFocusedTest(path: string): ProofAdmitCheckProvider {
  const token = createProofAdmissionCliChildForFocusedTest(path);
  return new ProofAdmitCheckProvider(token as object, INTERNAL);
}
export function createProofAdmitProviderFromCapability(capability: object): ProofAdmitCheckProvider {
  if (!proofAdmissionCapabilityValid(capability)) invalid('capability is not the current trusted Proof executable');
  return new ProofAdmitCheckProvider(capability, INTERNAL);
}

export class ProofAdmitCheckProvider extends CheckProvider {
  private readonly executableCapability: object | undefined;

  constructor(executablePath?: string | object, token?: typeof INTERNAL) {
    super();
    if (executablePath !== undefined && token !== INTERNAL) invalid('custom executable requires internal bootstrap');
    this.executableCapability = token === INTERNAL
      ? (typeof executablePath === 'object'
        ? executablePath
        : executablePath === undefined ? undefined : createProofAdmissionCliChildForFocusedTest(executablePath))
      : undefined;
  }

  getName(): string { return PROOF_ADMIT_PROVIDER_NAME; }
  getDescription(): string { return 'Sealed built-in Proof candidate admission provider'; }

  async validateConfig(config: unknown): Promise<boolean> {
    return !!config && typeof config === 'object' && !Array.isArray(config) &&
      (config as CheckProviderConfig).type === PROOF_ADMIT_PROVIDER_NAME &&
      Object.keys(config as Record<string, unknown>).every(key => ['type', 'consumes', 'emits', 'expand'].includes(key));
  }

  async execute(_pr: PRInfo, config: CheckProviderConfig, _deps?: Map<string, ReviewSummary>, _context?: ExecutionContext): Promise<ReviewSummary> {
    if (config.type !== PROOF_ADMIT_PROVIDER_NAME) invalid(`expected type ${PROOF_ADMIT_PROVIDER_NAME}`);
    throw new Error(PROOF_ADMISSION_UNAVAILABLE);
  }

  getSupportedConfigKeys(): string[] { return ['type']; }
  async isAvailable(): Promise<boolean> { return this.executableCapability !== undefined; }
  getRequirements(): string[] { return [PROOF_ADMISSION_UNAVAILABLE]; }

  startManaged(request: ManagedRunStartRequest): ManagedAgentRun {
    const childRequest = proofAdmissionChildRequest(request);
    return startProofAdmissionCliChild(childRequest, this.executableCapability);
  }
}
