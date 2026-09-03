import type { PRInfo } from '../pr-analyzer';
import type { ReviewSummary } from '../reviewer';
import {
  CheckProvider,
  type CheckProviderConfig,
  type ExecutionContext,
  type ManagedAgentRun,
  type ManagedRunStartRequest,
} from './check-provider.interface';
import {
  createProofAdmissionCliChildForFocusedTest,
  proofAdmissionCapabilityValid,
  PROOF_ADMISSION_UNAVAILABLE,
  startProofManagedCliChild,
} from './proof-admission-cli-child';

/** The registry name is deliberately local to this sealed provider boundary. */
export const PROOF_PROJECT_RECONCILE_PROVIDER_TYPE = 'proof-project-reconcile';
export const PROOF_PROJECT_RECONCILE_PROVIDER_NAME = PROOF_PROJECT_RECONCILE_PROVIDER_TYPE;
export const PROOF_PROJECT_RECONCILIATION_REQUEST_VERSION = 'proof.project-reconciliation-request/v1';
export const PROOF_PROJECT_RECONCILIATION_RECEIPT_VERSION = 'proof.project-reconciliation-receipt/v1';
export const PROOF_PROJECT_RECONCILIATION_INPUT_MAX_BYTES = 32 * 1024 * 1024;
export const PROOF_PROJECT_RECONCILIATION_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;

const INTERNAL = Symbol('proof-project-reconcile-provider');
type Plain = Record<string, unknown>;

const REQUEST_KEYS = [
  'version',
  'discovery_candidate',
  'discovery_admission',
  'catalog_revalidation',
  'outcomes',
] as const;
const RECEIPT_KEYS = [
  'version',
  'project_authority',
  'catalog_revalidation_receipt',
  'component_admissions',
  'covered_work_item_digests',
  'receipt_id',
] as const;

function invalid(detail: string): never {
  throw new Error(`PROOF_RECONCILIATION_INVALID: ${detail}`);
}

function unavailable(): never {
  throw new Error(PROOF_ADMISSION_UNAVAILABLE);
}

function plain(value: unknown): value is Plain {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/** Check a parsed JSON object's closed, enumerable data-property envelope. */
function exactKeys(value: unknown, keys: readonly string[]): value is Plain {
  if (!plain(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  return ownKeys.length === keys.length && ownKeys.every(key => {
    if (typeof key !== 'string' || !keys.includes(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !!descriptor && 'value' in descriptor && descriptor.enumerable;
  });
}

/** JavaScript strings can contain lone UTF-16 surrogates, which are not UTF-8. */
function validUtf8(value: string): boolean {
  return Buffer.from(value, 'utf8').toString('utf8') === value;
}

function digestSyntax(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

function parseRequest(input: string): void {
  if (input.length === 0 || !validUtf8(input)) invalid('request is not valid UTF-8 JSON');
  if (Buffer.byteLength(input, 'utf8') > PROOF_PROJECT_RECONCILIATION_INPUT_MAX_BYTES) {
    unavailable();
  }

  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    invalid('request is not one JSON value');
  }

  if (!exactKeys(value, REQUEST_KEYS) ||
      value.version !== PROOF_PROJECT_RECONCILIATION_REQUEST_VERSION ||
      !plain(value.discovery_candidate) ||
      !plain(value.discovery_admission) ||
      !plain(value.catalog_revalidation) ||
      !Array.isArray(value.outcomes)) {
    invalid('request envelope is invalid');
  }
}

function projectOutput(value: unknown): Plain {
  if (!exactKeys(value, RECEIPT_KEYS) ||
      value.version !== PROOF_PROJECT_RECONCILIATION_RECEIPT_VERSION ||
      !plain(value.project_authority) ||
      !plain(value.catalog_revalidation_receipt) ||
      !Array.isArray(value.component_admissions) ||
      !Array.isArray(value.covered_work_item_digests) ||
      !digestSyntax(value.receipt_id)) {
    invalid('receipt envelope is invalid');
  }
  return value;
}

export class ProofProjectReconcileCheckProvider extends CheckProvider {
  private readonly capability: object | undefined;

  constructor(capability?: object, token?: typeof INTERNAL) {
    super();
    if (capability && (token !== INTERNAL || !proofAdmissionCapabilityValid(capability))) unavailable();
    this.capability = capability;
  }

  getName(): string {
    return PROOF_PROJECT_RECONCILE_PROVIDER_TYPE;
  }

  getDescription(): string {
    return 'Sealed Proof whole-project reconciliation provider';
  }

  async validateConfig(config: unknown): Promise<boolean> {
    return plain(config) &&
      config.type === PROOF_PROJECT_RECONCILE_PROVIDER_TYPE &&
      Object.keys(config).every(key => ['type', 'depends_on', 'consumes', 'emits', 'wait_for_expansion'].includes(key));
  }

  async execute(
    _pr: PRInfo,
    _config: CheckProviderConfig,
    _deps?: Map<string, ReviewSummary>,
    _context?: ExecutionContext,
  ): Promise<ReviewSummary> {
    unavailable();
  }

  getSupportedConfigKeys(): string[] {
    return ['type', 'depends_on', 'consumes', 'emits', 'wait_for_expansion'];
  }

  async isAvailable(): Promise<boolean> {
    return this.capability !== undefined;
  }

  getRequirements(): string[] {
    return [PROOF_ADMISSION_UNAVAILABLE];
  }

  startManaged(request: ManagedRunStartRequest): ManagedAgentRun {
    if (!this.capability ||
        !proofAdmissionCapabilityValid(this.capability) ||
        request.checkConfig.type !== PROOF_PROJECT_RECONCILE_PROVIDER_TYPE ||
        typeof request.workingDirectory !== 'string' ||
        request.workingDirectory.length === 0 ||
        !request.workingDirectory.startsWith('/') ||
        typeof request.proofProjectReconciliationRequest !== 'string' ||
        request.proofProjectReconciliationRequest.length === 0 ||
        request.proofAdmissionRequest !== undefined) {
      unavailable();
    }

    const claims = request.executionContext?.claims;
    if (claims !== undefined && (!plain(claims) || Object.keys(claims).length !== 0)) {
      unavailable();
    }

    const input = request.proofProjectReconciliationRequest;
    parseRequest(input);

    return startProofManagedCliChild({
      binding: request.binding,
      workingDirectory: request.workingDirectory,
      command: ['onboarding', 'reconcile'],
      input,
      inputLimit: PROOF_PROJECT_RECONCILIATION_INPUT_MAX_BYTES,
      outputLimit: PROOF_PROJECT_RECONCILIATION_OUTPUT_MAX_BYTES,
      outputCanonical: false,
      projectOutput,
    }, this.capability);
  }
}

export function createProofProjectReconcileProviderFromCapability(capability: object): ProofProjectReconcileCheckProvider {
  if (!proofAdmissionCapabilityValid(capability)) unavailable();
  return new ProofProjectReconcileCheckProvider(capability, INTERNAL);
}

export function createProofProjectReconcileProviderForFocusedTest(path: string): ProofProjectReconcileCheckProvider {
  return new ProofProjectReconcileCheckProvider(createProofAdmissionCliChildForFocusedTest(path), INTERNAL);
}
