import { TextDecoder } from 'util';
import { createHash } from 'crypto';
import type { PRInfo } from '../pr-analyzer';
import type { ReviewSummary } from '../reviewer';
import { canonicalJson, immutableCanonicalValue } from '../state-machine/graph/claim-kernel';
import { CheckProvider, type CheckProviderConfig, type ExecutionContext, type ManagedAgentRun, type ManagedRunStartRequest } from './check-provider.interface';
import type { ManagedRunBindingV1 } from '../state-machine/graph/instance-kernel';

export const GOVERNED_PROOF_INSPECT_PROVIDER_NAME = 'governed-proof-inspect';
export const GOVERNED_PROBE_UNAVAILABLE = 'GOVERNED_PROBE_UNAVAILABLE';
const GOVERNED_RESULT_IDENTITY_DOMAIN = 'probe.governed-result-identity/data/v1';
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const PROFILE = 'luna-xhigh-readonly-v1';
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
  if (!plain(subject) || !exact(subject, ['kind', 'id', 'fingerprint']) || (subject.kind !== 'project' && subject.kind !== 'requirement') || !visible(subject.id, 128) || !wire(subject.fingerprint)) fail('invocation subject is invalid');
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
  return immutableCanonicalValue(Object.fromEntries(AUTHORED.map(k => [k, value[k]]))) as CheckProviderConfig;
}

export interface ProofCandidateEvidenceV1 { readonly version: 'visor.proof-candidate-evidence/v1'; readonly role: { readonly invocation: Record<string, unknown>; readonly invocationDigest: string }; readonly probe: { readonly attestation: Record<string, unknown>; readonly resultIdentity: Record<string, unknown> }; }
export interface GovernedProbeRunnerRequest { readonly message: string; readonly instructions: string; readonly invocation: Record<string, unknown>; readonly invocationDigest: string; readonly resultSchema: string; readonly executionConfigDigest: string; readonly binding: ManagedRunBindingV1; }
export interface GovernedProbeRunner { answer(request: GovernedProbeRunnerRequest): Promise<{ data: unknown; runtimeAttestation: Record<string, unknown>; resultIdentity: Record<string, unknown> }> | { data: unknown; runtimeAttestation: Record<string, unknown>; resultIdentity: Record<string, unknown> }; cancel(reason: 'deadline'): Promise<void> | void; close(): Promise<void> | void; }
type GovernedProbeRunnerFactory = (request: GovernedProbeRunnerRequest) => GovernedProbeRunner;
function validateAttestation(att: unknown, digest: string): Record<string, unknown> {
  if (!validMaterialized(att)) fail('attestation contains non-materialized data');
  if (!plain(att) || !exact(att, ['version', 'profileId', 'requested', 'observed', 'executionContext', 'dispatch', 'evidence', 'usage']) || att.version !== 'probe.governed-codex-attestation/v2' || att.profileId !== PROFILE) fail('attestation header invalid');
  const requested = att.requested, observed = att.observed, ctx = att.executionContext, dispatch = att.dispatch, evidence = att.evidence, usage = att.usage;
  if (!plain(requested) || !exact(requested, ['profileDigest', 'cwdDigest', 'probeToolsDigest', 'model', 'reasoningEffort', 'sandbox', 'approvalPolicy']) || !wire(requested.profileDigest) || !wire(requested.cwdDigest) || !wire(requested.probeToolsDigest) || requested.model !== 'gpt-5.6-luna' || requested.reasoningEffort !== 'xhigh' || requested.sandbox !== 'read-only' || requested.approvalPolicy !== 'never') fail('requested attestation invalid');
  if (!plain(observed) || !exact(observed, ['source', 'model', 'modelProviderId', 'reasoningEffort', 'approvalPolicy', 'cwdDigest', 'permissionProfileDigest', 'filesystem', 'network']) || observed.source !== 'session_configured' || observed.model !== 'gpt-5.6-luna' || observed.modelProviderId !== 'openai' || observed.reasoningEffort !== 'xhigh' || observed.approvalPolicy !== 'never' || !wire(observed.cwdDigest) || !wire(observed.permissionProfileDigest) || observed.filesystem !== 'restricted-read-root' || observed.network !== 'restricted') fail('observed attestation invalid');
  if (!plain(ctx) || !exact(ctx, ['source', 'invocationDigest']) || ctx.source !== 'caller' || ctx.invocationDigest !== digest || !plain(dispatch) || !exact(dispatch, ['source', 'tool', 'promptDigest', 'promptBytes']) || dispatch.source !== 'probe-host-tools-call' || dispatch.tool !== 'codex' || !wire(dispatch.promptDigest) || typeof dispatch.promptBytes !== 'number' || !Number.isSafeInteger(dispatch.promptBytes) || dispatch.promptBytes < 0 || !plain(evidence) || !exact(evidence, ['eventCount']) || evidence.eventCount !== 1 || !plain(usage) || !exact(usage, ['status']) || usage.status !== 'unavailable') fail('attestation evidence invalid');
  return immutableCanonicalValue(att);
}
function validateRunnerResult(value: unknown): { data: unknown; runtimeAttestation: Record<string, unknown>; resultIdentity: Record<string, unknown> } {
  if (!plain(value) || !exact(value, ['data', 'runtimeAttestation', 'resultIdentity']) || !validMaterialized(value) || !plain(value.runtimeAttestation) || !plain(value.resultIdentity)) fail('runner result shape is invalid');
  return value as unknown as { data: unknown; runtimeAttestation: Record<string, unknown>; resultIdentity: Record<string, unknown> };
}
function evidenceFromResult(config: CheckProviderConfig, result: { data: unknown; runtimeAttestation: Record<string, unknown>; resultIdentity: Record<string, unknown> }): ProofCandidateEvidenceV1 {
  validateRunnerResult(result);
  if (!validMaterialized(result.data)) fail('runner data is not materialized JSON');
  const dataBytes = canonicalJson(result.data); if (JSON.stringify(result.data) !== dataBytes) fail('runner data is not canonical JSON');
  const identity = result.resultIdentity; if (!plain(identity) || !exact(identity, ['version', 'source', 'resultDigest', 'canonicalBytes']) || identity.version !== 'probe.governed-result-identity/v1' || identity.source !== 'probe-host-schema-valid-json' || identity.resultDigest !== governedResultDigest(result.data) || identity.canonicalBytes !== Buffer.byteLength(dataBytes) || typeof identity.canonicalBytes !== 'number' || !Number.isSafeInteger(identity.canonicalBytes) || identity.canonicalBytes < 0) fail('result identity invalid');
  const digest = config.invocation_digest as string; const att = validateAttestation(result.runtimeAttestation, digest); const invocation = config.invocation as Record<string, unknown>;
  return immutableCanonicalValue({ version: 'visor.proof-candidate-evidence/v1', role: { invocation, invocationDigest: digest }, probe: { attestation: att, resultIdentity: identity } });
}
export function validateProofCandidateEvidence(value: unknown): ProofCandidateEvidenceV1 {
  if (!plain(value) || !exact(value, ['version', 'role', 'probe']) || value.version !== 'visor.proof-candidate-evidence/v1') fail('evidence header is invalid');
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
  };
  return immutableCanonicalValue(evidence);
}
const INTERNAL = Symbol('governed-proof-inspect-test-factory');
export function createGovernedProofInspectProviderForFocusedTest(factory: GovernedProbeRunnerFactory): GovernedProofInspectCheckProvider { return new GovernedProofInspectCheckProvider(factory, INTERNAL); }
export class GovernedProofInspectCheckProvider extends CheckProvider {
  private readonly factory?: GovernedProbeRunnerFactory;
  constructor(factory?: GovernedProbeRunnerFactory, token?: typeof INTERNAL) { super(); if (factory && token !== INTERNAL) fail('runner factory is test-only'); this.factory = factory; }
  getName(): string { return GOVERNED_PROOF_INSPECT_PROVIDER_NAME; }
  getDescription(): string { return 'Sealed built-in governed Proof inspection provider'; }
  async validateConfig(config: unknown): Promise<boolean> { try { projectGovernedProofInspectConfig(config); return true; } catch { return false; } }
  async execute(_pr: PRInfo, _config: CheckProviderConfig, _deps?: Map<string, ReviewSummary>, _ctx?: ExecutionContext): Promise<ReviewSummary> { throw new Error(GOVERNED_PROBE_UNAVAILABLE); }
  getSupportedConfigKeys(): string[] { return [...AUTHORED]; }
  async isAvailable(): Promise<boolean> { return false; }
  getRequirements(): string[] { return [GOVERNED_PROBE_UNAVAILABLE]; }
  startManaged(request: ManagedRunStartRequest): ManagedAgentRun {
    const config = projectGovernedProofInspectConfig(request.checkConfig); if (!/^[0-9a-f]{64}$/.test(request.executionConfigDigest)) fail('executionConfigDigest is invalid'); if (!this.factory) throw new Error(GOVERNED_PROBE_UNAVAILABLE);
    const binding = immutableCanonicalValue(request.binding);
    const invocation = config.invocation as Record<string, unknown>; const frozen = immutableCanonicalValue({ message: config.message, instructions: config.instructions, invocation, invocationDigest: config.invocation_digest, resultSchema: config.result_schema, executionConfigDigest: request.executionConfigDigest, binding }) as GovernedProbeRunnerRequest;
    const runner = this.factory(frozen); if (!runner || typeof runner !== 'object' || typeof runner.answer !== 'function' || typeof runner.cancel !== 'function' || typeof runner.close !== 'function') fail('runner boundary is invalid');
    let cancelled = false, closed = false; const answer = Promise.resolve().then(() => runner.answer(frozen)).then(value => { const evidence = evidenceFromResult(config, validateRunnerResult(value)); return Object.freeze({ version: 1 as const, kind: 'succeeded-proof-candidate' as const, binding, summary: immutableCanonicalValue({ issues: [], output: value.data }), proofCandidateEvidence: evidence }); });
    return { binding, started: Promise.resolve({ version: 1, kind: 'started', binding }), outcome: answer, cancel: async (reason, fence) => { if (fence !== binding.fence) throw new Error('GOVERNED_PROOF_INVALID: cancellation fence is stale'); if (!cancelled) { cancelled = true; await runner.cancel(reason); } return { version: 1, kind: 'cancelled', binding, reason }; }, close: async () => { if (!closed) { closed = true; await runner.close(); } return { version: 1, kind: 'cleanup', binding, status: 'clean', activeChildren: 0, activeResources: 0 }; } };
  }
}
