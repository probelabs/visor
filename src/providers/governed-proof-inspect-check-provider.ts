import { TextDecoder } from 'util';
import { createHash } from 'crypto';
import type { PRInfo } from '../pr-analyzer';
import type { ReviewSummary } from '../reviewer';
import { canonicalJson, immutableCanonicalValue, sha256Canonical } from '../state-machine/graph/claim-kernel';
import { CheckProvider, type CandidateClaimInput, type CheckProviderConfig, type ExecutionContext, type ManagedAgentRun, type ManagedRunStartRequest } from './check-provider.interface';
import type { ManagedRunBindingV1 } from '../state-machine/graph/instance-kernel';
import type { GovernedIdentifiedAnswerResult } from '@probelabs/probe';
import { createGovernedProbeRunner, GOVERNED_PROOF_ROLE_MESSAGE } from './governed-probe-runner';
import {
  governedCanonicalJson,
  governedResultDigest as governedWireResultDigest,
  governedWireModeFromEvidence,
  governedWireModeFromInvocation,
  immutableGovernedValue,
  governedProofCandidateEvidenceJson,
  immutableProofCandidateEvidence,
  immutableProofCanonicalValue,
} from './proof-wire';

type ProofAdmissionCliChildModule = typeof import('./proof-admission-cli-child');
let proofAdmissionCliChildModule: ProofAdmissionCliChildModule | undefined;
/**
 * Keep the child-process boundary lazy.  Besides avoiding any process work at
 * module load, this lets callers install the trusted capability before the
 * module's child_process dependency is resolved.
 */
function proofAdmissionChild(): ProofAdmissionCliChildModule {
  return proofAdmissionCliChildModule ??= require('./proof-admission-cli-child') as ProofAdmissionCliChildModule;
}

export const GOVERNED_PROOF_INSPECT_PROVIDER_NAME = 'governed-proof-inspect';
export const GOVERNED_PROBE_UNAVAILABLE = 'GOVERNED_PROBE_UNAVAILABLE';
const PROOF_ADMISSION_UNAVAILABLE = 'PROOF_ADMISSION_UNAVAILABLE';
export const GOVERNED_PROOF_INSPECT_MESSAGE = GOVERNED_PROOF_ROLE_MESSAGE;
const GOVERNED_RESULT_IDENTITY_DOMAIN = 'probe.governed-result-identity/data/v1';
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const PROFILE = 'luna-xhigh-readonly-v1';
/** Runtime claims used by the onboarding component context contract. */
export const COMPONENT_WORK_ITEM_CLAIM = 'component.work_item@1';
export const PROOF_ROLE_AUTHORITY_CLAIM = 'proof.component_role_authority@1';
export const GOVERNED_PROOF_CONTEXT_VERSION = 'visor.proof-runtime-context/v1';
export const GOVERNED_PROOF_REINSPECTION_CONTEXT_VERSION = 'visor.proof-component-reinspection-context/v1';
export const PROJECT_DISCOVERY_CLAIM = 'project.discovery_item@1';
export const PROOF_STRUCTURAL_INVENTORY_CLAIM = 'proof.structural_inventory@1';
export const GOVERNED_PROOF_PROJECT_CONTEXT_VERSION = 'visor.proof-project-discovery-context/v1';
export const GOVERNED_PROOF_CONTEXT_MAX_BYTES = 131072;
const AUTHORED = ['type', 'message', 'instructions', 'invocation', 'invocation_digest', 'result_schema', 'profile'] as const;
const CONTROLLER = new Set(['checkName', 'prompt', 'exec', 'schema', 'group', 'focus', 'transform', 'transform_js', 'env', 'forEach', 'eventContext', '__outputHistory', '__globalTools', 'checksMeta', 'workflowInputs', 'ai']);
const GRAPH = new Set(['emits', 'consumes', 'expand']);
const own = (v: object, k: string) => Object.prototype.hasOwnProperty.call(v, k);
const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
function dataDescriptor(v: object, key: PropertyKey): PropertyDescriptor | undefined {
  const descriptor = Object.getOwnPropertyDescriptor(v, key);
  return descriptor && 'value' in descriptor && descriptor.enumerable ? descriptor : undefined;
}
function exact(v: object, keys: readonly string[]): boolean {
  const ks = Reflect.ownKeys(v);
  return ks.length === keys.length && ks.every(k => typeof k === 'string' && keys.includes(k) && !!dataDescriptor(v, k));
}
function validUnicode(v: string): boolean {
  for (let index = 0; index < v.length; index++) {
    const code = v.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = v.charCodeAt(index + 1);
      if (Number.isNaN(next) || next < 0xdc00 || next > 0xdfff) return false;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}
function validMaterialized(value: unknown, seen = new Set<object>()): boolean {
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return validUnicode(value);
  if (!value || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      if (keys.some(key => typeof key !== 'string' || (key !== 'length' && !/^(0|[1-9][0-9]*)$/.test(key)))) return false;
      const length = Object.getOwnPropertyDescriptor(value, 'length');
      if (!length || !('value' in length) || length.enumerable) return false;
      for (const key of keys) {
        if (key === 'length') continue;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return false;
      }
      for (let index = 0; index < value.length; index++) if (!own(value, String(index))) return false;
      return value.every(item => validMaterialized(item, seen));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== 'string') return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable || !validMaterialized(descriptor.value, seen)) return false;
    }
    return true;
  } finally {
    seen.delete(value);
  }
}
function text(v: unknown, max: number, nonempty = true): v is string { return typeof v === 'string' && validUnicode(v) && (!nonempty || v.length > 0) && Buffer.byteLength(v, 'utf8') <= max && (() => { try { new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(v)); return true; } catch { return false; } })(); }
function visible(v: unknown, max: number, nonempty = true): v is string { return typeof v === 'string' && (!nonempty || v.length > 0) && Buffer.byteLength(v) <= max && /^[\x21-\x7e]*$/.test(v); }
function wire(v: unknown): v is string { return typeof v === 'string' && DIGEST.test(v); }
function bare(v: unknown): v is string { return typeof v === 'string' && /^[0-9a-f]{64}$/.test(v); }
function fail(detail: string): never { throw new Error(`GOVERNED_PROOF_INVALID: ${detail}`); }
export interface ProofComponentInvocationAuthorityV1 {
  readonly work_item_digest: string;
  readonly subject: Readonly<Record<string, unknown>>;
  readonly candidate: unknown;
  readonly admission: unknown;
  readonly work_item: unknown;
  readonly catalog_revalidation_receipt: unknown;
}

/** Authored component checks are selectors; all component identity and Proof
 * lineage is supplied by the controller at activation time. */
export function isGovernedProofComponentSelector(value: unknown): boolean {
  if (!plain(value) || !exact(value, ['role_id', 'stance', 'subject', 'output_schema_id', 'output_schema'])) return false;
  const subject = value.subject;
  return value.role_id === 'onboard' && value.stance === 'owner' &&
    plain(subject) && exact(subject, ['kind']) && subject.kind === 'component' &&
    visible(value.output_schema_id, 128) && typeof value.output_schema === 'string';
}
export function validateProofComponentInvocationAuthority(value: unknown): ProofComponentInvocationAuthorityV1 {
  if (!plain(value) || !exact(value, ['work_item_digest', 'subject', 'candidate', 'admission', 'work_item', 'catalog_revalidation_receipt']) || !validMaterialized(value)) fail('component authority is not closed');
  if (!wire(value.work_item_digest) || !plain(value.subject) || !exact(value.subject, ['version', 'project_id', 'component_id', 'sorted_owned_paths', 'sorted_dependency_closure', 'fingerprint']) || value.subject.version !== 'proof.component-subject/v1' || typeof value.subject.project_id !== 'string' || typeof value.subject.component_id !== 'string' || !wire(value.subject.fingerprint) || !Array.isArray(value.subject.sorted_owned_paths) || !Array.isArray(value.subject.sorted_dependency_closure)) fail('component authority subject is invalid');
  if (!plain(value.candidate) || !plain(value.admission) || !plain(value.work_item) || !plain(value.catalog_revalidation_receipt)) fail('component authority lineage is invalid');
  return cloneAndFreezeAuthority(value as unknown as ProofComponentInvocationAuthorityV1);
}
function cloneAndFreezeAuthority<T>(value: T): T {
  if (Array.isArray(value)) {
    const copy = value.map(item => cloneAndFreezeAuthority(item)) as unknown as T;
    return Object.freeze(copy);
  }
  if (value && typeof value === 'object') {
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>)) copy[key] = cloneAndFreezeAuthority((value as Record<string, unknown>)[key]);
    return Object.freeze(copy) as T;
  }
  return value;
}
/** Proof's domain-separated identity digest: domain || NUL || uint64BE(len) || canonical UTF-8 bytes. */
export function governedResultDigest(value: unknown): string {
  const bytes = Buffer.from(canonicalJson(value), 'utf8');
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  return `sha256:${createHash('sha256').update(GOVERNED_RESULT_IDENTITY_DOMAIN, 'utf8').update(Buffer.from([0])).update(length).update(bytes).digest('hex')}`;
}
export { proofCanonicalJson, proofGovernedResultDigest } from './proof-wire';
function jsonObject(value: string, label: string): Record<string, unknown> { let parsed: unknown; try { parsed = JSON.parse(value); } catch { fail(`${label} is not JSON`); } if (!plain(parsed) || !exact(parsed, Object.keys(parsed))) fail(`${label} must be a JSON object`); return parsed; }
function decodeSchema(value: unknown): string {
  if (typeof value !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) fail('output_schema is not padded base64');
  const bytes = Buffer.from(value, 'base64'); if (bytes.length < 1 || bytes.length > 131072 || bytes.toString('base64') !== value) fail('output_schema encoding is invalid');
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!validUnicode(decoded)) fail('output_schema contains malformed Unicode');
    return decoded;
  } catch { fail('output_schema is not UTF-8'); }
}
function validateInvocation(value: unknown): asserts value is Record<string, unknown> {
  const hasAuthority = plain(value) && own(value, 'component_authority');
  const keys = hasAuthority ? ['role_id', 'stance', 'subject', 'component_authority', 'output_schema_id', 'output_schema'] : ['role_id', 'stance', 'subject', 'output_schema_id', 'output_schema'];
  if (!plain(value) || !exact(value, keys)) fail('invocation keys are not closed');
  if (!validMaterialized(value)) fail('invocation contains non-materialized data');
  if (!visible(value.role_id, 128) || (value.stance !== 'owner' && value.stance !== 'external-review') || !visible(value.output_schema_id, 128)) fail('invocation strings are invalid');
  const subject = value.subject;
  // Component invocations are controller-authored selectors only.  A fully
  // resolved authored invocation must never be able to smuggle a component
  // identity (the selector branch above is the sole authoring form).
  if (!plain(subject) || !exact(subject, ['kind', 'id', 'fingerprint']) ||
      ((subject.kind !== 'project' && subject.kind !== 'requirement') && !(hasAuthority && subject.kind === 'component')) ||
      !visible(subject.id, 128) || !wire(subject.fingerprint)) fail('invocation subject is invalid');
  if (hasAuthority) validateProofComponentInvocationAuthority(value.component_authority);
  const schema = decodeSchema(value.output_schema); const parsed = jsonObject(schema, 'output_schema'); if (!validMaterialized(parsed)) fail('output_schema contains non-materialized data');
}
export function projectGovernedProofInspectConfig(value: unknown): CheckProviderConfig {
  if (!plain(value)) fail('config is not a plain object');
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string')) fail('config contains a symbol key');
  for (const key of Reflect.ownKeys(value)) if (!dataDescriptor(value, key)) fail(`config key ${String(key)} is not an enumerable data property`);
  for (const key of Object.keys(value)) { if (!(AUTHORED as readonly string[]).includes(key) && !CONTROLLER.has(key) && !GRAPH.has(key)) fail(`unknown config key ${key}`); if (GRAPH.has(key) && !validMaterialized(value[key])) fail(`graph config key ${key} is not materialized`); }
  if (value.type !== GOVERNED_PROOF_INSPECT_PROVIDER_NAME || value.profile !== PROFILE) fail('config fields are invalid');
  if (isGovernedProofComponentSelector(value.invocation)) {
    if (own(value, 'message') || own(value, 'instructions') || own(value, 'invocation_digest') || own(value, 'result_schema')) fail('component selector cannot author resolved Proof fields');
    const decoded = decodeSchema((value.invocation as Record<string, unknown>).output_schema);
    const parsed = jsonObject(decoded, 'output_schema');
    if (!validMaterialized(parsed)) fail('output_schema contains non-materialized data');
    return immutableCanonicalValue({ type: GOVERNED_PROOF_INSPECT_PROVIDER_NAME, invocation: value.invocation, profile: PROFILE }) as CheckProviderConfig;
  }
  if (!text(value.message, 32768) || !text(value.instructions, 131072) || !wire(value.invocation_digest)) fail('config fields are invalid');
  validateInvocation(value.invocation);
  if (!text(value.result_schema, 131072)) fail('result_schema is invalid');
  const decoded = decodeSchema((value.invocation as Record<string, unknown>).output_schema);
  if (value.result_schema !== decoded) fail('result_schema does not equal invocation output_schema');
  // Project-scoped checks may author their request message.  The built-in
  // onboard role remains controller-resolved below for component selectors;
  // replacing this field here would silently discard the graph's contract
  // before it can reach the governed Probe boundary.
  return immutableCanonicalValue(Object.fromEntries(AUTHORED.map(k => [k, value[k]]))) as CheckProviderConfig;
}

export interface GovernedProofRuntimeContextClaimV1 {
  readonly claimId: string;
  readonly claim: string;
  readonly payloadFingerprint: string;
  readonly scope: Readonly<ManagedRunBindingV1['scope']>;
  readonly payload: unknown;
}

/** Minimal parent-claim view needed to bind candidate evidence. */
export interface GovernedProofRuntimeParentClaimV1 {
  readonly claimId: string;
  readonly claim: string;
  readonly payloadFingerprint: string;
  readonly scope: unknown;
  readonly payload: unknown;
}

export interface GovernedProofRuntimeContextV1 {
  readonly version: typeof GOVERNED_PROOF_CONTEXT_VERSION;
  readonly component: GovernedProofRuntimeContextClaimV1;
  readonly authority: GovernedProofRuntimeContextClaimV1;
}

export interface GovernedProofComponentReinspectionContextV1 {
  readonly version: typeof GOVERNED_PROOF_REINSPECTION_CONTEXT_VERSION;
  readonly component_id: string;
  readonly changed_paths: readonly string[];
  readonly historical_work_item: { readonly claim_id: string; readonly payload_fingerprint: string };
  readonly current_work_item: { readonly claim_id: string; readonly payload_fingerprint: string };
  readonly prior_candidate: { readonly claim_id: string; readonly payload_fingerprint: string; readonly result_digest: string; readonly payload: unknown };
  readonly prior_admission: { readonly claim_id: string; readonly payload_fingerprint: string };
}

export interface GovernedProofProjectDiscoveryContextV1 {
  readonly version: typeof GOVERNED_PROOF_PROJECT_CONTEXT_VERSION;
  readonly project: GovernedProofRuntimeContextClaimV1;
  readonly current_inventory: GovernedProofRuntimeContextClaimV1;
}

export type GovernedProofRuntimeContext = GovernedProofRuntimeContextV1 | GovernedProofProjectDiscoveryContextV1;

function proofPathCompare(left: string, right: string): number { return Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8')); }
export function validateGovernedProofComponentReinspectionContext(value: unknown): GovernedProofComponentReinspectionContextV1 {
  if (!plain(value) || !exact(value, ['version', 'component_id', 'changed_paths', 'historical_work_item', 'current_work_item', 'prior_candidate', 'prior_admission']) || !validMaterialized(value) || value.version !== GOVERNED_PROOF_REINSPECTION_CONTEXT_VERSION || !visible(value.component_id, 256) || !Array.isArray(value.changed_paths)) fail('reinspection context header is invalid');
  if (Buffer.byteLength(canonicalJson(value), 'utf8') > GOVERNED_PROOF_CONTEXT_MAX_BYTES) fail('reinspection context exceeds bounded byte limit');
  const paths = value.changed_paths as string[];
  if (paths.length === 0 || paths.some(path => !visible(path, 4096)) || paths.some((path, index) => index > 0 && proofPathCompare(paths[index - 1], path) >= 0)) fail('reinspection context paths are not sorted and nonempty');
  const ref = (entry: unknown, keys: readonly string[]): Record<string, unknown> => {
    if (!plain(entry) || !exact(entry, keys) || !validMaterialized(entry)) fail('reinspection context claim reference is invalid');
    if (!bare(entry.claim_id) || !bare(entry.payload_fingerprint)) fail('reinspection context claim reference identity is invalid');
    return entry;
  };
  const historical = ref(value.historical_work_item, ['claim_id', 'payload_fingerprint']);
  const current = ref(value.current_work_item, ['claim_id', 'payload_fingerprint']);
  const candidate = ref(value.prior_candidate, ['claim_id', 'payload_fingerprint', 'result_digest', 'payload']);
  if (!wire(candidate.result_digest) || JSON.stringify(candidate.payload) !== canonicalJson(candidate.payload) || sha256Canonical(candidate.payload) !== candidate.payload_fingerprint) fail('reinspection context candidate is detached');
  const admission = ref(value.prior_admission, ['claim_id', 'payload_fingerprint']);
  if (historical.claim_id === current.claim_id || candidate.claim_id === admission.claim_id) fail('reinspection context identities are not distinct');
  return immutableCanonicalValue(value as unknown as GovernedProofComponentReinspectionContextV1);
}

export function governedProofComponentReinspectionContextDigest(value: GovernedProofComponentReinspectionContextV1): string {
  const context = validateGovernedProofComponentReinspectionContext(value);
  return `sha256:${sha256Canonical(context)}`;
}

/**
 * Candidate evidence remains v1 for wire compatibility; the optional context
 * fields are mandatory for the two-claim onboarding profile. Legacy one-claim
 * EXP-0208 runs intentionally continue to validate without them.
 */
export interface ProofCandidateEvidenceV1 {
  readonly version: 'visor.proof-candidate-evidence/v1';
  readonly role: { readonly invocation: Record<string, unknown>; readonly invocationDigest: string };
  readonly probe: { readonly attestation: Record<string, unknown>; readonly resultIdentity: Record<string, unknown> };
  readonly context?: GovernedProofRuntimeContext;
  readonly contextDigest?: string;
  readonly reinspectionContext?: GovernedProofComponentReinspectionContextV1;
  readonly reinspectionContextDigest?: string;
}
export interface GovernedProbeRunnerRequest {
  readonly message: string;
  readonly instructions: string;
  readonly invocation: Record<string, unknown>;
  readonly invocationDigest: string;
  readonly resultSchema: string;
  readonly executionConfigDigest: string;
  readonly binding: ManagedRunBindingV1;
  readonly workingDirectory: string;
  /** Sealed runtime context; present only for the canonical onboarding profiles. */
  readonly context?: GovernedProofRuntimeContext;
  readonly contextDigest?: string;
  /** Controller-derived only; caller execution context is never consulted. */
  readonly reinspectionContext?: GovernedProofComponentReinspectionContextV1;
  readonly reinspectionContextDigest?: string;
}
export interface GovernedProbeDispatchPreview {
  readonly source: 'probe-host-tools-call';
  readonly tool: 'codex';
  readonly promptDigest: string;
  readonly promptBytes: number;
}
export interface GovernedProbeRunner {
  answer(request: GovernedProbeRunnerRequest): Promise<GovernedIdentifiedAnswerResult> | GovernedIdentifiedAnswerResult;
  /** Preview must be the same Probe dispatch that answer() will attest. */
  preview?(request: GovernedProbeRunnerRequest): Promise<GovernedProbeDispatchPreview> | GovernedProbeDispatchPreview;
  cancel(reason: 'deadline'): Promise<void> | void;
  close(): Promise<void> | void;
}
type GovernedProbeRunnerFactory = (request: GovernedProbeRunnerRequest) => GovernedProbeRunner;
function validateAttestation(
  att: unknown,
  digest: string,
  expectedDispatch?: GovernedProbeDispatchPreview
): Record<string, unknown> {
  if (!validMaterialized(att)) fail('attestation contains non-materialized data');
  if (!plain(att) || !exact(att, ['version', 'profileId', 'requested', 'observed', 'executionContext', 'dispatch', 'evidence', 'usage']) || att.version !== 'probe.governed-codex-attestation/v2' || att.profileId !== PROFILE) fail('attestation header invalid');
  const requested = att.requested, observed = att.observed, ctx = att.executionContext, dispatch = att.dispatch, evidence = att.evidence, usage = att.usage;
  if (!plain(requested) || !exact(requested, ['profileDigest', 'cwdDigest', 'probeToolsDigest', 'model', 'reasoningEffort', 'sandbox', 'approvalPolicy']) || !bare(requested.profileDigest) || !bare(requested.cwdDigest) || !bare(requested.probeToolsDigest) || requested.model !== 'gpt-5.6-luna' || requested.reasoningEffort !== 'xhigh' || requested.sandbox !== 'read-only' || requested.approvalPolicy !== 'never') fail('requested attestation invalid');
  if (!plain(observed) || !exact(observed, ['source', 'model', 'modelProviderId', 'reasoningEffort', 'approvalPolicy', 'cwdDigest', 'permissionProfileDigest', 'filesystem', 'network']) || observed.source !== 'session_configured' || observed.model !== 'gpt-5.6-luna' || observed.modelProviderId !== 'openai' || observed.reasoningEffort !== 'xhigh' || observed.approvalPolicy !== 'never' || !bare(observed.cwdDigest) || !bare(observed.permissionProfileDigest) || observed.filesystem !== 'restricted-read-root' || observed.network !== 'restricted') fail('observed attestation invalid');
  if (!plain(ctx) || !exact(ctx, ['source', 'invocationDigest']) || ctx.source !== 'caller' || ctx.invocationDigest !== digest || !plain(dispatch) || !exact(dispatch, ['source', 'tool', 'promptDigest', 'promptBytes']) || dispatch.source !== 'probe-host-tools-call' || dispatch.tool !== 'codex' || !wire(dispatch.promptDigest) || typeof dispatch.promptBytes !== 'number' || !Number.isSafeInteger(dispatch.promptBytes) || dispatch.promptBytes < 0 || !plain(evidence) || !exact(evidence, ['eventCount']) || evidence.eventCount !== 1 || !plain(usage) || !exact(usage, ['status']) || usage.status !== 'unavailable') fail('attestation evidence invalid');
  if (expectedDispatch && (
    !plain(expectedDispatch) ||
    !exact(expectedDispatch, ['source', 'tool', 'promptDigest', 'promptBytes']) ||
    expectedDispatch.source !== 'probe-host-tools-call' ||
    expectedDispatch.tool !== 'codex' ||
    !wire(expectedDispatch.promptDigest) ||
    typeof expectedDispatch.promptBytes !== 'number' ||
    !Number.isSafeInteger(expectedDispatch.promptBytes) ||
    expectedDispatch.promptBytes < 0 ||
    dispatch.promptDigest !== expectedDispatch.promptDigest ||
    dispatch.promptBytes !== expectedDispatch.promptBytes
  )) fail('attestation dispatch is detached from the Probe preview');
  return immutableCanonicalValue(att);
}
function validateRunnerResult(value: unknown): { data: unknown; runtimeAttestation: Record<string, unknown>; resultIdentity: Record<string, unknown> } {
  if (!plain(value) || !exact(value, ['data', 'runtimeAttestation', 'resultIdentity']) || !validMaterialized(value) || !plain(value.runtimeAttestation) || !plain(value.resultIdentity)) fail('runner result shape is invalid');
  return value as unknown as { data: unknown; runtimeAttestation: Record<string, unknown>; resultIdentity: Record<string, unknown> };
}
function candidateClaimKeys(value: CandidateClaimInput): readonly string[] {
  return value.provenance === 'controller'
    ? ['claimId', 'claim', 'payload', 'payloadFingerprint', 'producerCheckId', 'scope', 'parentClaimIds', 'wireMode', 'provenance', 'catalogClaimId', 'incarnation']
    : ['claimId', 'claim', 'payload', 'payloadFingerprint', 'producerCheckId', 'scope', 'parentClaimIds', 'wireMode', 'provenance', 'attemptId', 'fence'];
}

function validateRuntimeContextClaim(
  value: unknown,
  expectedClaim: string,
  expectedScope?: ManagedRunBindingV1['scope']
): GovernedProofRuntimeContextClaimV1 {
  if (!plain(value) || !validMaterialized(value)) fail('runtime context claim is not materialized');
  const claim = value as unknown as CandidateClaimInput;
  if (claim.provenance !== 'controller' && claim.provenance !== 'attempt') fail('runtime context claim provenance is invalid');
  if (!exact(claim, candidateClaimKeys(claim))) fail('runtime context claim contains extra or missing fields');
  if (!bare(claim.claimId) || claim.claim !== expectedClaim || !bare(claim.payloadFingerprint) || !visible(claim.producerCheckId, 128)) fail('runtime context claim identity is invalid');
  if (!Array.isArray(claim.parentClaimIds) || claim.parentClaimIds.some(id => !bare(id)) || [...claim.parentClaimIds].sort().some((id, index) => id !== claim.parentClaimIds[index])) fail('runtime context claim parents are invalid');
  if (!Array.isArray(claim.scope) || !validMaterialized(claim.scope)) fail('runtime context claim scope is invalid');
  if (expectedScope && canonicalJson(claim.scope) !== canonicalJson(expectedScope)) fail('runtime context claim scope is foreign');
  if (!validMaterialized(claim.payload)) fail('runtime context claim payload is not materialized');
  if (JSON.stringify(claim.scope) !== canonicalJson(claim.scope)) fail('runtime context claim scope is noncanonical');
  const payloadCanonical = canonicalJson(claim.payload);
  if (JSON.stringify(claim.payload) !== payloadCanonical || sha256Canonical(claim.payload) !== claim.payloadFingerprint) fail('runtime context claim payload is noncanonical or detached');
  return immutableCanonicalValue({
    claimId: claim.claimId,
    claim: claim.claim,
    payloadFingerprint: claim.payloadFingerprint,
    scope: claim.scope as unknown as ManagedRunBindingV1['scope'],
    payload: claim.payload,
  });
}

function validateProjectedRuntimeContextClaim(
  value: unknown,
  expectedClaim: string
): GovernedProofRuntimeContextClaimV1 {
  if (!plain(value) || !exact(value, ['claimId', 'claim', 'payloadFingerprint', 'scope', 'payload']) || !validMaterialized(value)) fail('projected runtime context claim is not closed');
  const claim = value as unknown as GovernedProofRuntimeContextClaimV1;
  if (!bare(claim.claimId) || claim.claim !== expectedClaim || !bare(claim.payloadFingerprint) || !Array.isArray(claim.scope) || !validMaterialized(claim.scope) || !validMaterialized(claim.payload)) fail('projected runtime context claim identity is invalid');
  if (JSON.stringify(value) !== canonicalJson(value) || JSON.stringify(claim.scope) !== canonicalJson(claim.scope)) fail('projected runtime context claim is noncanonical');
  if (JSON.stringify(claim.payload) !== canonicalJson(claim.payload) || sha256Canonical(claim.payload) !== claim.payloadFingerprint) fail('projected runtime context payload is noncanonical or detached');
  return immutableCanonicalValue({
    claimId: claim.claimId,
    claim: claim.claim,
    payloadFingerprint: claim.payloadFingerprint,
    scope: claim.scope as unknown as ManagedRunBindingV1['scope'],
    payload: claim.payload,
  });
}

/**
 * The generated instance has one external input slot.  The component WorkItem
 * therefore carries the exact Proof component-role authority as a canonical
 * nested claim envelope.  This keeps the graph's one-input invariant while
 * preserving two independently checkable authorities at the Probe boundary.
 */
function projectEmbeddedAuthority(
  payload: unknown,
  expectedScope: ManagedRunBindingV1['scope']
): GovernedProofRuntimeContextClaimV1 {
  if (!plain(payload) || !own(payload, 'authority')) fail('runtime WorkItem authority is missing');
  const embedded = payload.authority;
  if (!plain(embedded) || !exact(embedded, ['claimId', 'claim', 'payloadFingerprint', 'payload']) || !validMaterialized(embedded)) fail('runtime WorkItem authority envelope is not closed');
  if (!bare(embedded.claimId) || embedded.claim !== PROOF_ROLE_AUTHORITY_CLAIM || !bare(embedded.payloadFingerprint) || !validMaterialized(embedded.payload) || JSON.stringify(embedded.payload) !== canonicalJson(embedded.payload) || sha256Canonical(embedded.payload) !== embedded.payloadFingerprint) fail('runtime WorkItem authority is detached');
  return immutableCanonicalValue({
    claimId: embedded.claimId,
    claim: embedded.claim,
    payloadFingerprint: embedded.payloadFingerprint,
    scope: expectedScope,
    payload: embedded.payload,
  });
}

function validateStructuralInventoryForContext(value: unknown, projectID: string): Record<string, unknown> {
  try {
    // Deliberately defer this import: the Proof catalog provider imports the
    // evidence type from this module, so a static import would create a load
    // cycle before the shared validator is initialized.
    const catalog = require('./proof-catalog-check-providers') as typeof import('./proof-catalog-check-providers');
    return catalog.validateStructuralInventory(value, projectID);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('GOVERNED_PROOF_INVALID:')) throw error;
    fail(`project discovery inventory is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validateProjectDiscoveryContextPayload(
  project: GovernedProofRuntimeContextClaimV1,
  inventory: GovernedProofRuntimeContextClaimV1,
  expectedSubject?: { projectId: string; fingerprint: string }
): void {
  const projectPayload = project.payload;
  const inventoryPayload = inventory.payload;
  if (!plain(projectPayload) || typeof projectPayload.project_id !== 'string' || projectPayload.project_id.length === 0 ||
      !plain(inventoryPayload) || !plain(inventoryPayload.authority)) fail('project discovery context payload is invalid');
  const authority = inventoryPayload.authority;
  if (authority.project_id !== projectPayload.project_id || !wire(authority.subject_fingerprint)) fail('project discovery context identity is detached');
  validateStructuralInventoryForContext(inventoryPayload, projectPayload.project_id);
  if (expectedSubject && (expectedSubject.projectId !== projectPayload.project_id || expectedSubject.fingerprint !== authority.subject_fingerprint)) fail('project discovery context subject is detached');
}

function validateRuntimeContextShape(value: unknown): GovernedProofRuntimeContext {
  if (!plain(value) || typeof value.version !== 'string' || JSON.stringify(value) !== canonicalJson(value)) fail('runtime context header is invalid');
  const context = value as Record<string, unknown>;
  if (context.version === GOVERNED_PROOF_CONTEXT_VERSION) {
    if (!exact(value, ['version', 'component', 'authority'])) fail('runtime context header is invalid');
    const component = validateProjectedRuntimeContextClaim(context.component, COMPONENT_WORK_ITEM_CLAIM);
    const authority = validateProjectedRuntimeContextClaim(context.authority, PROOF_ROLE_AUTHORITY_CLAIM);
    if (component.claimId === authority.claimId || canonicalJson(component.scope) !== canonicalJson(authority.scope)) fail('runtime context claims are not distinct and co-scoped');
    return immutableCanonicalValue({ version: GOVERNED_PROOF_CONTEXT_VERSION as typeof GOVERNED_PROOF_CONTEXT_VERSION, component, authority });
  }
  if (context.version === GOVERNED_PROOF_PROJECT_CONTEXT_VERSION) {
    if (!exact(value, ['version', 'project', 'current_inventory'])) fail('project discovery context header is invalid');
    const project = validateProjectedRuntimeContextClaim(context.project, PROJECT_DISCOVERY_CLAIM);
    const inventory = validateProjectedRuntimeContextClaim(context.current_inventory, PROOF_STRUCTURAL_INVENTORY_CLAIM);
    if (project.claimId === inventory.claimId || canonicalJson(project.scope) !== canonicalJson(inventory.scope)) fail('project discovery context claims are not distinct and co-scoped');
    validateProjectDiscoveryContextPayload(project, inventory);
    return immutableCanonicalValue({ version: GOVERNED_PROOF_PROJECT_CONTEXT_VERSION as typeof GOVERNED_PROOF_PROJECT_CONTEXT_VERSION, project, current_inventory: inventory });
  }
  fail('runtime context version is unsupported');
}

/**
 * Project the exact generated input claims into the only runtime context that
 * the governed Probe runner may receive. Graph-v2 supplies one external
 * component WorkItem claim; its canonical payload envelope carries the
 * same-scope Proof component-role authority claim.
 */
export function projectGovernedProofRuntimeContext(
  claims: unknown,
  binding: ManagedRunBindingV1
): GovernedProofRuntimeContextV1 {
  if (!plain(claims) || !exact(claims, ['component'])) fail('runtime context requires exactly the component WorkItem claim');
  const record = claims as Record<string, unknown>;
  const component = validateRuntimeContextClaim(record.component, COMPONENT_WORK_ITEM_CLAIM, binding.scope);
  const authority = projectEmbeddedAuthority(component.payload, binding.scope);
  if (component.claimId === authority.claimId) fail('runtime context claims must be distinct');
  const context = immutableCanonicalValue({ version: GOVERNED_PROOF_CONTEXT_VERSION as typeof GOVERNED_PROOF_CONTEXT_VERSION, component, authority });
  if (Buffer.byteLength(canonicalJson(context), 'utf8') > GOVERNED_PROOF_CONTEXT_MAX_BYTES) fail('runtime context exceeds bounded byte limit');
  return context;
}

/** Project the exact project and structural-inventory inputs for discovery. */
export function projectGovernedProofProjectDiscoveryContext(
  claims: unknown,
  binding: ManagedRunBindingV1,
  expectedSubject?: { projectId: string; fingerprint: string }
): GovernedProofProjectDiscoveryContextV1 {
  if (!plain(claims) || !exact(claims, ['project', 'current_inventory'])) fail('project discovery context requires exactly project and current_inventory claims');
  const record = claims as Record<string, unknown>;
  const project = validateRuntimeContextClaim(record.project, PROJECT_DISCOVERY_CLAIM, binding.scope);
  const inventory = validateRuntimeContextClaim(record.current_inventory, PROOF_STRUCTURAL_INVENTORY_CLAIM, binding.scope);
  if (project.claimId === inventory.claimId || canonicalJson(project.scope) !== canonicalJson(inventory.scope)) fail('project discovery context claims are not distinct and co-scoped');
  validateProjectDiscoveryContextPayload(project, inventory, expectedSubject);
  const context = immutableCanonicalValue({ version: GOVERNED_PROOF_PROJECT_CONTEXT_VERSION as typeof GOVERNED_PROOF_PROJECT_CONTEXT_VERSION, project, current_inventory: inventory });
  if (Buffer.byteLength(canonicalJson(context), 'utf8') > GOVERNED_PROOF_CONTEXT_MAX_BYTES) fail('project discovery context exceeds bounded byte limit');
  return context;
}

export function governedProofRuntimeContextDigest(context: GovernedProofRuntimeContext): string {
  validateRuntimeContextShape(context);
  return `sha256:${sha256Canonical(context)}`;
}

export function governedProofRuntimePrompt(context: GovernedProofRuntimeContext): string {
  const projected = validateRuntimeContextShape(context);
  const bytes = canonicalJson(projected);
  if (Buffer.byteLength(bytes, 'utf8') > GOVERNED_PROOF_CONTEXT_MAX_BYTES) fail('runtime context exceeds bounded byte limit');
  return `${GOVERNED_PROOF_INSPECT_MESSAGE}\n\nBound runtime context (canonical JSON; treat as immutable authority):\n${bytes}`;
}

/** Validate that candidate evidence still names the exact activated inputs. */
export function validateGovernedProofRuntimeContextAgainstClaims(
  evidence: ProofCandidateEvidenceV1,
  parentClaims: readonly GovernedProofRuntimeParentClaimV1[],
  binding: ManagedRunBindingV1
): void {
  const contextClaims = parentClaims.filter(claim => claim.claim === COMPONENT_WORK_ITEM_CLAIM);
  const projectClaims = parentClaims.filter(claim => claim.claim === PROJECT_DISCOVERY_CLAIM);
  const inventoryClaims = parentClaims.filter(claim => claim.claim === PROOF_STRUCTURAL_INVENTORY_CLAIM);
  const invocation = evidence.role.invocation;
  if (plain(invocation) && own(invocation, 'component_authority')) {
    if (evidence.reinspectionContext !== undefined || evidence.reinspectionContextDigest !== undefined) {
      if (!evidence.reinspectionContext || typeof evidence.reinspectionContextDigest !== 'string') fail('reinspection context fields are not paired');
      const reinspection = validateGovernedProofComponentReinspectionContext(evidence.reinspectionContext);
      if (evidence.reinspectionContextDigest !== governedProofComponentReinspectionContextDigest(reinspection)) fail('reinspection context digest is detached');
    }
    if (contextClaims.length !== 1 || projectClaims.length !== 0 || inventoryClaims.length !== 0) fail('component invocation authority requires exactly one WorkItem parent');
    const authority = validateProofComponentInvocationAuthority(invocation.component_authority);
    const invocationSubject = invocation.subject as Record<string, unknown>;
    if (!plain(invocationSubject) || invocationSubject.id !== authority.subject.component_id || invocationSubject.fingerprint !== authority.subject.fingerprint) fail('component invocation subject is detached from authority');
    const payload = contextClaims[0].payload;
    if (!plain(payload) || !plain(payload.authority) || canonicalJson(payload.authority) !== canonicalJson({
      component_id: authority.subject.component_id,
      work_item_digest: authority.work_item_digest,
      subject: authority.subject,
    })) fail('component invocation authority is detached from WorkItem');
    return;
  }
  if (projectClaims.length > 0 || inventoryClaims.length > 0) {
    if (projectClaims.length !== 1 || inventoryClaims.length !== 1 || contextClaims.length !== 0 || parentClaims.length !== 2 || !evidence.context || evidence.context.version !== GOVERNED_PROOF_PROJECT_CONTEXT_VERSION || evidence.contextDigest === undefined) fail('project discovery runtime context is missing or foreign');
    const context = validateRuntimeContextShape(evidence.context);
    if (context.version !== GOVERNED_PROOF_PROJECT_CONTEXT_VERSION) fail('project discovery runtime context is invalid');
    const project = projectClaims[0];
    const inventory = inventoryClaims[0];
    if (canonicalJson(project.scope) !== canonicalJson(binding.scope) || canonicalJson(inventory.scope) !== canonicalJson(binding.scope) ||
        canonicalJson(context.project.scope) !== canonicalJson(binding.scope) || canonicalJson(context.current_inventory.scope) !== canonicalJson(binding.scope) ||
        canonicalJson(context.project) !== canonicalJson({ claimId: project.claimId, claim: project.claim, payloadFingerprint: project.payloadFingerprint, scope: project.scope, payload: project.payload }) ||
        canonicalJson(context.current_inventory) !== canonicalJson({ claimId: inventory.claimId, claim: inventory.claim, payloadFingerprint: inventory.payloadFingerprint, scope: inventory.scope, payload: inventory.payload })) fail('project discovery runtime context is stale or foreign');
    validateProjectDiscoveryContextPayload(context.project, context.current_inventory);
    const projectPayload = project.payload;
    const authority = plain(context.current_inventory.payload) && plain(context.current_inventory.payload.authority) ? context.current_inventory.payload.authority : undefined;
    const subject = plain(invocation.subject) ? invocation.subject : undefined;
    if (!plain(projectPayload) || !plain(authority) || !subject || subject.kind !== 'project' || subject.id !== projectPayload.project_id || subject.fingerprint !== authority.subject_fingerprint) fail('project discovery invocation is detached from runtime context');
    return;
  }
  if (contextClaims.length === 0) {
    if (evidence.context !== undefined || evidence.contextDigest !== undefined) fail('unexpected runtime context for legacy inspect');
    return;
  }
  if (contextClaims.length !== 1 || !evidence.context || evidence.contextDigest === undefined) fail('runtime context is missing');
  const context = evidence.context as GovernedProofRuntimeContextV1;
  const parent = contextClaims[0];
  if (context.component.claimId !== parent.claimId || context.component.claim !== parent.claim || context.component.payloadFingerprint !== parent.payloadFingerprint || canonicalJson(parent.scope) !== canonicalJson(context.component.scope) || canonicalJson(parent.payload) !== canonicalJson(context.component.payload)) fail('runtime context component is stale or foreign');
  const authority = projectEmbeddedAuthority(parent.payload, binding.scope);
  if (canonicalJson(authority) !== canonicalJson(context.authority)) fail('runtime context authority is stale or foreign');
  if (canonicalJson(context.component.scope) !== canonicalJson(binding.scope) || canonicalJson(context.authority.scope) !== canonicalJson(binding.scope)) fail('runtime context scope is foreign');
}

type RuntimeContextKind = 'component' | 'project';
function requiresRuntimeContext(config: CheckProviderConfig): RuntimeContextKind | undefined {
  // The component selector uses the controller-owned Proof authority and C0
  // itself as the runtime binding. The legacy envelope context remains for
  // already-resolved EXP-0209 checks.
  if (isGovernedProofComponentSelector(config.invocation)) return undefined;
  const consumes = config.consumes;
  if (consumes === undefined) return undefined;
  if (!Array.isArray(consumes)) fail('config consumes is not an array');
  const component = consumes.filter(value => plain(value) && value.claim === COMPONENT_WORK_ITEM_CLAIM && value.as === 'component');
  const project = consumes.filter(value => plain(value) && value.claim === PROJECT_DISCOVERY_CLAIM && value.as === 'project');
  const inventory = consumes.filter(value => plain(value) && value.claim === PROOF_STRUCTURAL_INVENTORY_CLAIM && value.as === 'current_inventory');
  const exactProjectConsume = (value: unknown): boolean => plain(value) &&
    (exact(value, ['claim', 'as']) || (exact(value, ['claim', 'as', 'cardinality']) && value.cardinality === 'one'));
  const hasComponentContextClaim = consumes.some(value => plain(value) && value.claim === COMPONENT_WORK_ITEM_CLAIM);
  if (hasComponentContextClaim) {
    if (consumes.some(value => plain(value) && value.claim === PROOF_ROLE_AUTHORITY_CLAIM)) fail('runtime authority must be carried by the component WorkItem envelope');
    if (component.length !== 1 || consumes.length !== 1 || consumes.some(value => !plain(value))) fail('runtime context declarations are not the canonical WorkItem envelope');
    return 'component';
  }
  const hasProjectContextClaim = consumes.some(value => plain(value) && (value.claim === PROJECT_DISCOVERY_CLAIM || value.claim === PROOF_STRUCTURAL_INVENTORY_CLAIM));
  if (hasProjectContextClaim) {
    if (project.length !== 1 || inventory.length !== 1 || consumes.length !== 2 || consumes.some(value => !exactProjectConsume(value))) fail('project discovery runtime context declarations are not exact');
    return 'project';
  }
  if (consumes.some(value => plain(value) && value.claim === PROOF_ROLE_AUTHORITY_CLAIM)) fail('runtime authority must be carried by the component WorkItem envelope');
  return undefined;
}

function evidenceFromResult(
  config: CheckProviderConfig,
  result: { data: unknown; runtimeAttestation: Record<string, unknown>; resultIdentity: Record<string, unknown> },
  context?: GovernedProofRuntimeContext,
  reinspectionContext?: GovernedProofComponentReinspectionContextV1,
  dispatchPreview?: GovernedProbeDispatchPreview
): ProofCandidateEvidenceV1 {
  validateRunnerResult(result);
  if (!validMaterialized(result.data)) fail('runner data is not materialized JSON');
  const wireMode = governedWireModeFromInvocation(config.invocation);
  const dataBytes = Buffer.from(governedCanonicalJson(result.data, wireMode), 'utf8');
  if (wireMode === 'generic' && JSON.stringify(result.data) !== dataBytes.toString('utf8')) fail('runner data is not canonical JSON');
  const identity = result.resultIdentity; if (!plain(identity) || !exact(identity, ['version', 'source', 'resultDigest', 'canonicalBytes']) || identity.version !== 'probe.governed-result-identity/v1' || identity.source !== 'probe-host-schema-valid-json' || identity.resultDigest !== (wireMode === 'proof' ? governedWireResultDigest(result.data, wireMode) : governedResultDigest(result.data)) || identity.canonicalBytes !== dataBytes.length || typeof identity.canonicalBytes !== 'number' || !Number.isSafeInteger(identity.canonicalBytes) || identity.canonicalBytes < 0) fail('result identity invalid');
  const digest = config.invocation_digest as string;
  const att = validateAttestation(result.runtimeAttestation, digest, context || reinspectionContext ? dispatchPreview : undefined);
  const invocation = config.invocation as Record<string, unknown>;
  // A resolved component invocation carries Proof-owned RawMessage evidence
  // even when its component result uses the generic candidate wire. Freeze
  // that embedded authority with Proof numeric/UTF-8 fidelity; historical
  // project/requirement evidence remains graph-canonical.
  if (context) {
    const projected = validateRuntimeContextShape(context);
    return immutableProofCandidateEvidence({ version: 'visor.proof-candidate-evidence/v1', role: { invocation, invocationDigest: digest }, probe: { attestation: att, resultIdentity: identity }, context: projected, contextDigest: governedProofRuntimeContextDigest(projected), ...(reinspectionContext ? { reinspectionContext, reinspectionContextDigest: governedProofComponentReinspectionContextDigest(reinspectionContext) } : {}) });
  }
  return immutableProofCandidateEvidence({ version: 'visor.proof-candidate-evidence/v1', role: { invocation, invocationDigest: digest }, probe: { attestation: att, resultIdentity: identity }, ...(reinspectionContext ? { reinspectionContext, reinspectionContextDigest: governedProofComponentReinspectionContextDigest(reinspectionContext) } : {}) });
}
export function validateProofCandidateEvidence(value: unknown): ProofCandidateEvidenceV1 {
  if (!plain(value) || value.version !== 'visor.proof-candidate-evidence/v1') fail('evidence header is invalid');
  const hasContext = own(value, 'context') || own(value, 'contextDigest');
  const hasReinspectionContext = own(value, 'reinspectionContext') || own(value, 'reinspectionContextDigest');
  const expectedKeys = ['version', 'role', 'probe', ...(hasContext ? ['context', 'contextDigest'] : []), ...(hasReinspectionContext ? ['reinspectionContext', 'reinspectionContextDigest'] : [])];
  if (!exact(value, expectedKeys)) fail('evidence context fields are not paired');
  const role = value.role;
  if (!plain(role) || !exact(role, ['invocation', 'invocationDigest'])) fail('evidence role is invalid');
  const invocationDigest = role.invocationDigest;
  if (!wire(invocationDigest)) fail('evidence role is invalid');
  const invocation = role.invocation;
  validateInvocation(invocation);
  const probe = value.probe;
  if (!plain(probe) || !exact(probe, ['attestation', 'resultIdentity'])) fail('evidence probe is invalid');
  const attestation = validateAttestation(probe.attestation, invocationDigest);
  const identity = probe.resultIdentity;
  if (!plain(identity) || !exact(identity, ['version', 'source', 'resultDigest', 'canonicalBytes']) || identity.version !== 'probe.governed-result-identity/v1' || identity.source !== 'probe-host-schema-valid-json' || !wire(identity.resultDigest) || typeof identity.canonicalBytes !== 'number' || !Number.isSafeInteger(identity.canonicalBytes) || identity.canonicalBytes < 0) fail('evidence result identity is invalid');
  if (!validMaterialized(value)) fail('evidence contains non-materialized data');
  if (hasContext) {
    const context = validateRuntimeContextShape(value.context);
    if (value.contextDigest !== governedProofRuntimeContextDigest(context)) fail('evidence runtime context digest is detached');
  }
  let reinspectionContext: GovernedProofComponentReinspectionContextV1 | undefined;
  if (hasReinspectionContext) {
    if (!value.reinspectionContext || typeof value.reinspectionContextDigest !== 'string') fail('evidence reinspection context fields are not paired');
    reinspectionContext = validateGovernedProofComponentReinspectionContext(value.reinspectionContext);
    if (value.reinspectionContextDigest !== governedProofComponentReinspectionContextDigest(reinspectionContext)) fail('evidence reinspection context digest is detached');
  }
  let canonical: string;
  try { canonical = governedProofCandidateEvidenceJson(value); } catch { fail('evidence is not canonical JSON'); }
  if (Buffer.byteLength(canonical, 'utf8') > 262144) fail('evidence exceeds canonical byte limit');
  const evidence: ProofCandidateEvidenceV1 = {
    version: 'visor.proof-candidate-evidence/v1',
    role: {
      invocation,
      invocationDigest,
    },
    probe: {
      attestation,
      resultIdentity: identity,
    },
    ...(hasContext ? { context: validateRuntimeContextShape(value.context), contextDigest: value.contextDigest as string } : {}),
    ...(reinspectionContext ? { reinspectionContext, reinspectionContextDigest: value.reinspectionContextDigest as string } : {}),
  };
  return immutableProofCandidateEvidence(evidence);
}
const INTERNAL = Symbol('governed-proof-inspect-test-factory');
export function createGovernedProofInspectProviderForFocusedTest(factory: GovernedProbeRunnerFactory, capability?: object): GovernedProofInspectCheckProvider { return new GovernedProofInspectCheckProvider(factory, INTERNAL, capability); }
export function createGovernedProofInspectProviderFromCapability(capability: object): GovernedProofInspectCheckProvider {
  if (!proofAdmissionChild().proofAdmissionCapabilityValid(capability)) fail(PROOF_ADMISSION_UNAVAILABLE);
  return new GovernedProofInspectCheckProvider(undefined, INTERNAL, capability);
}
export class GovernedProofInspectCheckProvider extends CheckProvider {
  private readonly factory: GovernedProbeRunnerFactory;
  private readonly capability?: object;
  constructor(factory?: GovernedProbeRunnerFactory, token?: typeof INTERNAL, capability?: object) { super(); if (factory && token !== INTERNAL) fail('runner factory is test-only'); this.factory = factory || createGovernedProbeRunner; this.capability = capability; }
  getName(): string { return GOVERNED_PROOF_INSPECT_PROVIDER_NAME; }
  getDescription(): string { return 'Sealed built-in governed Proof inspection provider'; }
  async validateConfig(config: unknown): Promise<boolean> { try { projectGovernedProofInspectConfig(config); return true; } catch { return false; } }
  async execute(_pr: PRInfo, _config: CheckProviderConfig, _deps?: Map<string, ReviewSummary>, _ctx?: ExecutionContext): Promise<ReviewSummary> { throw new Error(GOVERNED_PROBE_UNAVAILABLE); }
  getSupportedConfigKeys(): string[] { return [...AUTHORED]; }
  async isAvailable(): Promise<boolean> { return false; }
  getRequirements(): string[] { return [GOVERNED_PROBE_UNAVAILABLE]; }
  startManaged(request: ManagedRunStartRequest): ManagedAgentRun {
    const runtimeContextKind = requiresRuntimeContext(request.checkConfig);
    const runtimeContextRequired = runtimeContextKind !== undefined;
    const config = projectGovernedProofInspectConfig(request.checkConfig); if (!/^[0-9a-f]{64}$/.test(request.executionConfigDigest)) fail('executionConfigDigest is invalid');
    if (typeof request.workingDirectory !== 'string' || request.workingDirectory.length === 0) fail('workingDirectory is invalid');
    const binding = immutableCanonicalValue(request.binding);
    const selector = isGovernedProofComponentSelector(request.checkConfig.invocation);
    const reinspectionContext = request.reinspectionContext === undefined
      ? undefined
      : validateGovernedProofComponentReinspectionContext(request.reinspectionContext);
    if (reinspectionContext && !selector) fail('reinspection context requires a component selector');
    let context: GovernedProofRuntimeContext | undefined;
    if (runtimeContextKind === 'project') {
      const invocation = config.invocation;
      const subject = plain(invocation) && plain(invocation.subject) ? invocation.subject : undefined;
      if (!subject || subject.kind !== 'project' || typeof subject.id !== 'string' || typeof subject.fingerprint !== 'string') fail('project discovery invocation subject is invalid');
      context = projectGovernedProofProjectDiscoveryContext(request.executionContext?.claims, binding, { projectId: subject.id, fingerprint: subject.fingerprint });
    } else if (runtimeContextKind === 'component') {
      context = projectGovernedProofRuntimeContext(request.executionContext?.claims, binding);
    }
    const contextDigest = context ? governedProofRuntimeContextDigest(context) : undefined;
    if (selector && !this.capability) fail(PROOF_ADMISSION_UNAVAILABLE);
    let cancelled = false, closed = false;
    const c0Cancellation = new AbortController();
    let runner: GovernedProbeRunner | undefined;
    let runnerRequest: GovernedProbeRunnerRequest | undefined;
    let acquisition: Promise<{ config: CheckProviderConfig; runner: GovernedProbeRunner; request: GovernedProbeRunnerRequest }> | undefined;
    const acquire = async (): Promise<{ config: CheckProviderConfig; runner: GovernedProbeRunner; request: GovernedProbeRunnerRequest }> => {
      if (cancelled || closed) throw new Error(PROOF_ADMISSION_UNAVAILABLE);
      let effective = config;
      if (selector) {
        const authority = validateProofComponentInvocationAuthority(request.executionContext.proofComponentAuthority);
        const subject = authority.subject;
        if (reinspectionContext && reinspectionContext.component_id !== subject.component_id) fail('reinspection context component is detached from authority');
        const componentClaim = request.executionContext.claims && (request.executionContext.claims as Record<string, unknown>).component;
        if (!plain(componentClaim) || !plain(componentClaim.payload) || !plain(componentClaim.payload.authority)) fail('activated WorkItem authority is missing');
        const expectedCompact = { component_id: subject.component_id, work_item_digest: authority.work_item_digest, subject };
        if (canonicalJson((componentClaim.payload as Record<string, unknown>).authority) !== canonicalJson(expectedCompact)) fail('component authority is detached from activated WorkItem');
        const authored = config.invocation as Record<string, unknown>;
        const c0Request = {
          role_id: authored.role_id,
          stance: authored.stance,
          subject: { kind: 'component', id: subject.component_id, fingerprint: subject.fingerprint },
          component_authority: authority,
          output_schema_id: authored.output_schema_id,
          output_schema: authored.output_schema,
        };
        const resolved = await proofAdmissionChild().resolveProofRoleInvocation(this.capability, c0Request, request.workingDirectory as string, c0Cancellation.signal);
        // C0 owns the process boundary.  A cancellation racing its final
        // response must be observed before any Probe runner is constructed.
        if (cancelled || closed || c0Cancellation.signal.aborted) throw new Error(PROOF_ADMISSION_UNAVAILABLE);
        const outputSchema = decodeSchema(resolved.output_schema);
        const resolvedConfig = { type: GOVERNED_PROOF_INSPECT_PROVIDER_NAME, message: GOVERNED_PROOF_INSPECT_MESSAGE, instructions: resolved.instructions, invocation: c0Request, invocation_digest: resolved.invocation_digest, result_schema: outputSchema, profile: PROFILE };
        // Component authorities retain Proof-owned RawMessage bytes (including
        // signed zero). Preserve that identity while freezing the resolved
        // selector; generic project/requirement startup remains graph-canonical.
        effective = immutableProofCanonicalValue(resolvedConfig) as CheckProviderConfig;
      }
      const invocation = effective.invocation as Record<string, unknown>;
      const runnerConfig = { message: effective.message, instructions: effective.instructions, invocation, invocationDigest: effective.invocation_digest, resultSchema: effective.result_schema, executionConfigDigest: request.executionConfigDigest, binding, workingDirectory: request.workingDirectory, ...(context ? { context, contextDigest } : {}), ...(reinspectionContext ? { reinspectionContext, reinspectionContextDigest: governedProofComponentReinspectionContextDigest(reinspectionContext) } : {}) };
      runnerRequest = selector ? immutableProofCanonicalValue(runnerConfig) as GovernedProbeRunnerRequest : immutableCanonicalValue(runnerConfig) as GovernedProbeRunnerRequest;
      runner = this.factory(runnerRequest);
      if (!runner || typeof runner !== 'object' || typeof runner.answer !== 'function' || typeof runner.cancel !== 'function' || typeof runner.close !== 'function') fail('runner boundary is invalid');
      if ((runtimeContextRequired || reinspectionContext) && typeof runner.preview !== 'function') fail('runner boundary lacks the required Probe preview');
      return { config: effective, runner, request: runnerRequest };
    };
    const answer = Promise.resolve()
      .then(() => {
        acquisition = acquire();
        return acquisition;
      })
      .then(({ config: effective, runner: acquired, request: effectiveRequest }) => Promise.resolve(runtimeContextRequired || reinspectionContext ? acquired.preview!(effectiveRequest) : undefined)
        .then(preview => Promise.resolve(acquired.answer(effectiveRequest)).then(value => ({ value, preview, effective }))))
      .then(({ value, preview, effective }) => {
        const validated = validateRunnerResult(value);
        const evidence = evidenceFromResult(effective, validated, context, reinspectionContext, preview);
        const wireMode = governedWireModeFromEvidence(evidence);
        const output = immutableGovernedValue(validated.data, wireMode);
        return Object.freeze({ version: 1 as const, kind: 'succeeded-proof-candidate' as const, binding, summary: Object.freeze({ issues: [], output }), proofCandidateEvidence: evidence, wireMode });
      });
    return { binding, started: Promise.resolve({ version: 1, kind: 'started', binding }), outcome: answer, cancel: async (reason, fence) => { if (fence !== binding.fence) throw new Error('GOVERNED_PROOF_INVALID: cancellation fence is stale'); if (!cancelled) { cancelled = true; c0Cancellation.abort(); if (acquisition) await acquisition.catch(() => undefined); if (runner) await runner.cancel(reason); } return { version: 1, kind: 'cancelled', binding, reason }; }, close: async () => { if (!closed) { closed = true; c0Cancellation.abort(); if (acquisition) await acquisition.catch(() => undefined); if (runner) await runner.close(); } return { version: 1, kind: 'cleanup', binding, status: 'clean', activeChildren: 0, activeResources: 0 }; } };
  }
}
