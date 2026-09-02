import { TextDecoder } from 'util';
import { createHash } from 'crypto';
import type { PRInfo } from '../pr-analyzer';
import type { ReviewSummary } from '../reviewer';
import { canonicalJson, immutableCanonicalValue, sha256Canonical } from '../state-machine/graph/claim-kernel';
import { CheckProvider, type CandidateClaimInput, type CheckProviderConfig, type ExecutionContext, type ManagedAgentRun, type ManagedRunStartRequest } from './check-provider.interface';
import type { ManagedRunBindingV1 } from '../state-machine/graph/instance-kernel';
import type { GovernedIdentifiedAnswerResult } from '@probelabs/probe';
import { createGovernedProbeRunner, GOVERNED_PROOF_ROLE_MESSAGE } from './governed-probe-runner';

export const GOVERNED_PROOF_INSPECT_PROVIDER_NAME = 'governed-proof-inspect';
export const GOVERNED_PROBE_UNAVAILABLE = 'GOVERNED_PROBE_UNAVAILABLE';
export const GOVERNED_PROOF_INSPECT_MESSAGE = GOVERNED_PROOF_ROLE_MESSAGE;
const GOVERNED_RESULT_IDENTITY_DOMAIN = 'probe.governed-result-identity/data/v1';
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const PROFILE = 'luna-xhigh-readonly-v1';
/** Runtime claims used by the onboarding component context contract. */
export const COMPONENT_WORK_ITEM_CLAIM = 'component.work_item@1';
export const PROOF_ROLE_AUTHORITY_CLAIM = 'proof.component_role_authority@1';
export const GOVERNED_PROOF_CONTEXT_VERSION = 'visor.proof-runtime-context/v1';
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
/** Proof's domain-separated identity digest: domain || NUL || uint64BE(len) || canonical UTF-8 bytes. */
export function governedResultDigest(value: unknown): string {
  const bytes = Buffer.from(canonicalJson(value), 'utf8');
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  return `sha256:${createHash('sha256').update(GOVERNED_RESULT_IDENTITY_DOMAIN, 'utf8').update(Buffer.from([0])).update(length).update(bytes).digest('hex')}`;
}
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
  if (!plain(value) || !exact(value, ['role_id', 'stance', 'subject', 'output_schema_id', 'output_schema'])) fail('invocation keys are not closed');
  if (!validMaterialized(value)) fail('invocation contains non-materialized data');
  if (!visible(value.role_id, 128) || (value.stance !== 'owner' && value.stance !== 'external-review') || !visible(value.output_schema_id, 128)) fail('invocation strings are invalid');
  const subject = value.subject;
  if (!plain(subject) || !exact(subject, ['kind', 'id', 'fingerprint']) || (subject.kind !== 'project' && subject.kind !== 'requirement' && subject.kind !== 'component') || !visible(subject.id, 128) || !wire(subject.fingerprint)) fail('invocation subject is invalid');
  const schema = decodeSchema(value.output_schema); const parsed = jsonObject(schema, 'output_schema'); if (!validMaterialized(parsed)) fail('output_schema contains non-materialized data');
}
export function projectGovernedProofInspectConfig(value: unknown): CheckProviderConfig {
  if (!plain(value)) fail('config is not a plain object');
  if (Reflect.ownKeys(value).some(key => typeof key !== 'string')) fail('config contains a symbol key');
  for (const key of Reflect.ownKeys(value)) if (!dataDescriptor(value, key)) fail(`config key ${String(key)} is not an enumerable data property`);
  for (const key of Object.keys(value)) { if (!(AUTHORED as readonly string[]).includes(key) && !CONTROLLER.has(key) && !GRAPH.has(key)) fail(`unknown config key ${key}`); if (GRAPH.has(key) && !validMaterialized(value[key])) fail(`graph config key ${key} is not materialized`); }
  if (value.type !== GOVERNED_PROOF_INSPECT_PROVIDER_NAME || !text(value.message, 32768) || !text(value.instructions, 131072) || !wire(value.invocation_digest) || value.profile !== PROFILE) fail('config fields are invalid');
  validateInvocation(value.invocation);
  if (!text(value.result_schema, 131072)) fail('result_schema is invalid');
  const decoded = decodeSchema((value.invocation as Record<string, unknown>).output_schema);
  if (value.result_schema !== decoded) fail('result_schema does not equal invocation output_schema');
  return immutableCanonicalValue(Object.fromEntries(AUTHORED.map(k => [k, k === 'message' ? GOVERNED_PROOF_INSPECT_MESSAGE : value[k]]))) as CheckProviderConfig;
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

/**
 * Candidate evidence remains v1 for wire compatibility; the optional context
 * fields are mandatory for the two-claim onboarding profile. Legacy one-claim
 * EXP-0208 runs intentionally continue to validate without them.
 */
export interface ProofCandidateEvidenceV1 {
  readonly version: 'visor.proof-candidate-evidence/v1';
  readonly role: { readonly invocation: Record<string, unknown>; readonly invocationDigest: string };
  readonly probe: { readonly attestation: Record<string, unknown>; readonly resultIdentity: Record<string, unknown> };
  readonly context?: GovernedProofRuntimeContextV1;
  readonly contextDigest?: string;
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
  /** Sealed runtime context; present only for the component onboarding profile. */
  readonly context?: GovernedProofRuntimeContextV1;
  readonly contextDigest?: string;
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
    ? ['claimId', 'claim', 'payload', 'payloadFingerprint', 'producerCheckId', 'scope', 'parentClaimIds', 'provenance', 'catalogClaimId', 'incarnation']
    : ['claimId', 'claim', 'payload', 'payloadFingerprint', 'producerCheckId', 'scope', 'parentClaimIds', 'provenance', 'attemptId', 'fence'];
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

function validateRuntimeContextShape(value: unknown): GovernedProofRuntimeContextV1 {
  if (!plain(value) || !exact(value, ['version', 'component', 'authority']) || value.version !== GOVERNED_PROOF_CONTEXT_VERSION) fail('runtime context header is invalid');
  if (JSON.stringify(value) !== canonicalJson(value)) fail('runtime context is noncanonical');
  const context = value as Record<string, unknown>;
  const component = validateProjectedRuntimeContextClaim(context.component, COMPONENT_WORK_ITEM_CLAIM);
  const authority = validateProjectedRuntimeContextClaim(context.authority, PROOF_ROLE_AUTHORITY_CLAIM);
  if (component.claimId === authority.claimId || canonicalJson(component.scope) !== canonicalJson(authority.scope)) fail('runtime context claims are not distinct and co-scoped');
  return immutableCanonicalValue({ version: GOVERNED_PROOF_CONTEXT_VERSION as typeof GOVERNED_PROOF_CONTEXT_VERSION, component, authority });
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

export function governedProofRuntimeContextDigest(context: GovernedProofRuntimeContextV1): string {
  validateRuntimeContextShape(context);
  return `sha256:${sha256Canonical(context)}`;
}

export function governedProofRuntimePrompt(context: GovernedProofRuntimeContextV1): string {
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
  if (contextClaims.length === 0) {
    if (evidence.context !== undefined || evidence.contextDigest !== undefined) fail('unexpected runtime context for legacy inspect');
    return;
  }
  if (contextClaims.length !== 1 || !evidence.context || evidence.contextDigest === undefined) fail('runtime context is missing');
  const context = evidence.context;
  const parent = contextClaims[0];
  if (context.component.claimId !== parent.claimId || context.component.claim !== parent.claim || context.component.payloadFingerprint !== parent.payloadFingerprint || canonicalJson(parent.scope) !== canonicalJson(context.component.scope) || canonicalJson(parent.payload) !== canonicalJson(context.component.payload)) fail('runtime context component is stale or foreign');
  const authority = projectEmbeddedAuthority(parent.payload, binding.scope);
  if (canonicalJson(authority) !== canonicalJson(context.authority)) fail('runtime context authority is stale or foreign');
  if (canonicalJson(context.component.scope) !== canonicalJson(binding.scope) || canonicalJson(context.authority.scope) !== canonicalJson(binding.scope)) fail('runtime context scope is foreign');
}

function requiresRuntimeContext(config: CheckProviderConfig): boolean {
  const consumes = config.consumes;
  if (consumes === undefined) return false;
  if (!Array.isArray(consumes)) fail('config consumes is not an array');
  const component = consumes.filter(value => plain(value) && value.claim === COMPONENT_WORK_ITEM_CLAIM && value.as === 'component');
  if (component.length === 0) {
    if (consumes.some(value => plain(value) && value.claim === PROOF_ROLE_AUTHORITY_CLAIM)) fail('runtime authority must be carried by the component WorkItem envelope');
    return false;
  }
  if (component.length !== 1 || consumes.length !== 1 || consumes.some(value => !plain(value))) fail('runtime context declarations are not the canonical WorkItem envelope');
  return true;
}

function evidenceFromResult(
  config: CheckProviderConfig,
  result: { data: unknown; runtimeAttestation: Record<string, unknown>; resultIdentity: Record<string, unknown> },
  context?: GovernedProofRuntimeContextV1,
  dispatchPreview?: GovernedProbeDispatchPreview
): ProofCandidateEvidenceV1 {
  validateRunnerResult(result);
  if (!validMaterialized(result.data)) fail('runner data is not materialized JSON');
  const dataBytes = canonicalJson(result.data); if (JSON.stringify(result.data) !== dataBytes) fail('runner data is not canonical JSON');
  const identity = result.resultIdentity; if (!plain(identity) || !exact(identity, ['version', 'source', 'resultDigest', 'canonicalBytes']) || identity.version !== 'probe.governed-result-identity/v1' || identity.source !== 'probe-host-schema-valid-json' || identity.resultDigest !== governedResultDigest(result.data) || identity.canonicalBytes !== Buffer.byteLength(dataBytes) || typeof identity.canonicalBytes !== 'number' || !Number.isSafeInteger(identity.canonicalBytes) || identity.canonicalBytes < 0) fail('result identity invalid');
  const digest = config.invocation_digest as string;
  const att = validateAttestation(result.runtimeAttestation, digest, context ? dispatchPreview : undefined);
  const invocation = config.invocation as Record<string, unknown>;
  if (context) {
    const projected = validateRuntimeContextShape(context);
    return immutableCanonicalValue({ version: 'visor.proof-candidate-evidence/v1', role: { invocation, invocationDigest: digest }, probe: { attestation: att, resultIdentity: identity }, context: projected, contextDigest: governedProofRuntimeContextDigest(projected) });
  }
  return immutableCanonicalValue({ version: 'visor.proof-candidate-evidence/v1', role: { invocation, invocationDigest: digest }, probe: { attestation: att, resultIdentity: identity } });
}
export function validateProofCandidateEvidence(value: unknown): ProofCandidateEvidenceV1 {
  if (!plain(value) || value.version !== 'visor.proof-candidate-evidence/v1') fail('evidence header is invalid');
  const hasContext = own(value, 'context') || own(value, 'contextDigest');
  const expectedKeys = hasContext ? ['version', 'role', 'probe', 'context', 'contextDigest'] : ['version', 'role', 'probe'];
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
  let canonical: string;
  try { canonical = canonicalJson(value); } catch { fail('evidence is not canonical JSON'); }
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
  };
  return immutableCanonicalValue(evidence);
}
const INTERNAL = Symbol('governed-proof-inspect-test-factory');
export function createGovernedProofInspectProviderForFocusedTest(factory: GovernedProbeRunnerFactory): GovernedProofInspectCheckProvider { return new GovernedProofInspectCheckProvider(factory, INTERNAL); }
export class GovernedProofInspectCheckProvider extends CheckProvider {
  private readonly factory: GovernedProbeRunnerFactory;
  constructor(factory?: GovernedProbeRunnerFactory, token?: typeof INTERNAL) { super(); if (factory && token !== INTERNAL) fail('runner factory is test-only'); this.factory = factory || createGovernedProbeRunner; }
  getName(): string { return GOVERNED_PROOF_INSPECT_PROVIDER_NAME; }
  getDescription(): string { return 'Sealed built-in governed Proof inspection provider'; }
  async validateConfig(config: unknown): Promise<boolean> { try { projectGovernedProofInspectConfig(config); return true; } catch { return false; } }
  async execute(_pr: PRInfo, _config: CheckProviderConfig, _deps?: Map<string, ReviewSummary>, _ctx?: ExecutionContext): Promise<ReviewSummary> { throw new Error(GOVERNED_PROBE_UNAVAILABLE); }
  getSupportedConfigKeys(): string[] { return [...AUTHORED]; }
  async isAvailable(): Promise<boolean> { return false; }
  getRequirements(): string[] { return [GOVERNED_PROBE_UNAVAILABLE]; }
  startManaged(request: ManagedRunStartRequest): ManagedAgentRun {
    const runtimeContextRequired = requiresRuntimeContext(request.checkConfig);
    const config = projectGovernedProofInspectConfig(request.checkConfig); if (!/^[0-9a-f]{64}$/.test(request.executionConfigDigest)) fail('executionConfigDigest is invalid');
    if (typeof request.workingDirectory !== 'string' || request.workingDirectory.length === 0) fail('workingDirectory is invalid');
    const binding = immutableCanonicalValue(request.binding);
    const context = runtimeContextRequired
      ? projectGovernedProofRuntimeContext(request.executionContext?.claims, binding)
      : undefined;
    const contextDigest = context ? governedProofRuntimeContextDigest(context) : undefined;
    const invocation = config.invocation as Record<string, unknown>; const frozen = immutableCanonicalValue({ message: GOVERNED_PROOF_INSPECT_MESSAGE, instructions: config.instructions, invocation, invocationDigest: config.invocation_digest, resultSchema: config.result_schema, executionConfigDigest: request.executionConfigDigest, binding, workingDirectory: request.workingDirectory, ...(context ? { context, contextDigest } : {}) }) as GovernedProbeRunnerRequest;
    const runner = this.factory(frozen); if (!runner || typeof runner !== 'object' || typeof runner.answer !== 'function' || typeof runner.cancel !== 'function' || typeof runner.close !== 'function') fail('runner boundary is invalid');
    if (runtimeContextRequired && typeof runner.preview !== 'function') fail('runner boundary lacks the required Probe preview');
    let cancelled = false, closed = false;
    const answer = Promise.resolve()
      .then(() => runtimeContextRequired ? runner.preview!(frozen) : undefined)
      .then(preview => Promise.resolve(runner.answer(frozen)).then(value => ({ value, preview })))
      .then(({ value, preview }) => {
        const validated = validateRunnerResult(value);
        const evidence = evidenceFromResult(config, validated, context, preview);
        return Object.freeze({ version: 1 as const, kind: 'succeeded-proof-candidate' as const, binding, summary: immutableCanonicalValue({ issues: [], output: validated.data }), proofCandidateEvidence: evidence });
      });
    return { binding, started: Promise.resolve({ version: 1, kind: 'started', binding }), outcome: answer, cancel: async (reason, fence) => { if (fence !== binding.fence) throw new Error('GOVERNED_PROOF_INVALID: cancellation fence is stale'); if (!cancelled) { cancelled = true; await runner.cancel(reason); } return { version: 1, kind: 'cancelled', binding, reason }; }, close: async () => { if (!closed) { closed = true; await runner.close(); } return { version: 1, kind: 'cleanup', binding, status: 'clean', activeChildren: 0, activeResources: 0 }; } };
  }
}
