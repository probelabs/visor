import type { PRInfo } from '../pr-analyzer';
import { CheckProvider, type CheckProviderConfig, type ExecutionContext, type ManagedAgentRun, type ManagedRunStartRequest } from './check-provider.interface';
import type { ReviewSummary } from '../reviewer';
import { immutableCanonicalValue } from '../state-machine/graph/claim-kernel';
import { PROOF_ADMIT_PROVIDER_TYPE } from '../state-machine/graph/instance-plan';
import {
  createProofAdmissionCliChildForFocusedTest,
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

function plain(value: unknown): value is PlainRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactOwnKeys(value: object, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length && keys.every((key, index) => key === expected[index] && typeof key === 'string' && (() => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !!descriptor && 'value' in descriptor && descriptor.enumerable;
  })());
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
  if (dependencyKeys.length !== 1 || dependencyKeys[0] !== 'inspect' || Reflect.get(dependencies, 'size') !== 1) {
    invalid('proof admission requires exactly the inspect dependency');
  }

  const claims = request.executionContext && request.executionContext.claims;
  if (!plain(claims) || !exactOwnKeys(claims, ['candidate'])) invalid('candidate claim alias is invalid');
  const candidate = claims.candidate;
  if (!plain(candidate) || candidate.claim !== 'proof.candidate@1' || candidate.producerCheckId !== 'inspect' || candidate.provenance !== 'attempt' || typeof candidate.attemptId !== 'string' || !Number.isSafeInteger(candidate.fence)) {
    invalid('candidate claim authority is invalid');
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
