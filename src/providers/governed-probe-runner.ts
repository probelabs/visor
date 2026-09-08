import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { isAbsolute, resolve } from 'node:path';
import { realpathSync, statSync } from 'node:fs';
import {
  ProbeAgent,
  type GovernedCodexProfile,
  type GovernedIdentifiedAnswerOptions,
  type GovernedIdentifiedAnswerResult,
  type ProbeAgentOptions,
} from '@probelabs/probe';
import { canonicalJson } from '../state-machine/graph/claim-kernel';
import { governedWireModeFromInvocation, immutableGovernedValue, governedCanonicalJson, governedResultDigest } from './proof-wire';
import type {
  GovernedProbeDispatchPreview,
  GovernedProbeRunner,
  GovernedProbeRunnerRequest,
} from './governed-proof-inspect-check-provider';

/** The runner owns the only user message sent to the governed Probe boundary. */
export const GOVERNED_PROOF_ROLE_MESSAGE = [
  'Execute the bound Proof role and return only the required JSON.',
  '',
  'For component reviews, treat the supplied dependency closure as the exclusive citation scope: do not cite files outside it, and review every owned path.',
  'For each finding, state the causal chain from input and validation through control flow to the resulting effect, with precise file and line citations.',
  'For reinspection, cite changed implementation lines and the relevant regression-test function names and line numbers.',
].join('\n');

export const GOVERNED_PROOF_REVIEWED_COMPONENT_CONTEXT_VERSION = 'visor.proof-reviewed-component-context/v1';
const GOVERNED_PROOF_REVIEWED_COMPONENT_INSTRUCTION = 'Controller instruction: independent packet findings are fallible candidates. Verify each against current Proof and source, preserve unsupported or unresolved status, and never infer approval from packet or aggregate completion.';

const ANSWER_FAILURE_STAGES = ['native_event_grammar', 'provider_engine', 'schema_result_validation', 'internal_contract', 'unknown'] as const;
const PROVIDER_ENGINE_FAILURE_BOUNDARIES = ['acquire', 'query', 'close'] as const;
const NATIVE_EVENT_FAILURE_BOUNDARIES = ['raw_item_predicate', 'live_envelope_session'] as const;
const NATIVE_EVENT_FAILURE_RAW_ITEM_PREDICATES = [
  'shape', 'type', 'id', 'duplicate', 'phase', 'content', 'passthrough', 'tool_name_or_allow', 'status', 'input',
  'call_output_pairing', 'event_limit', 'tool_event_limit', 'tool_call_limit', 'message_content_array',
  'message_content_empty', 'message_content_limit', 'message_content_kind', 'message_content_text_type',
  'message_content_text_limit', 'reasoning_summary_array', 'reasoning_summary_nonempty',
  'reasoning_encrypted_content_type', 'reasoning_encrypted_content_limit', 'tool_output_array', 'tool_output_limit',
  'tool_output_kind', 'tool_output_text_type', 'tool_output_text_limit', 'final_answer_cardinality',
] as const;
const NATIVE_EVENT_FAILURE_SUBREASONS = ['session_sequence', 'envelope_shape', 'correlation', 'attestation'] as const;
const NATIVE_EVENT_FAILURE_CORRELATION_OPERANDS = ['thread_id', 'response_id'] as const;
const NATIVE_EVENT_FAILURE_ATTESTATION_PREDICATES = [
  'event_shape', 'jsonrpc', 'params_shape', 'response_id', 'meta_shape', 'session_shape', 'session_identity',
  'model', 'model_provider', 'approval_policy', 'approvals_reviewer', 'reasoning_effort', 'rollout_path', 'cwd',
  'permission_shape', 'session_type', 'permission_type', 'network', 'filesystem_shape', 'filesystem_type', 'entries',
  'entry', 'access', 'path_shape', 'path_type', 'value_shape', 'kind', 'native_tool_evidence', 'internal_contract',
  'invocation_attestation', 'native_capability_aggregate',
] as const;
const SCHEMA_RESULT_VALIDATION_SUBREASONS = ['response_json', 'schema_definition', 'schema_mismatch', 'result_identity'] as const;
const SCHEMA_RESULT_VALIDATION_KEYWORDS = ['required', 'additionalProperties', 'type', 'pattern', 'enum', 'minItems', 'maxItems', 'multiple', 'unknown'] as const;
const GOVERNED_CANDIDATE_VERSIONS = ['probe.governed-answer-candidate/v1'] as const;
const GOVERNED_CANDIDATE_ORIGINS = ['result_content', 'raw_final', 'none'] as const;
const GOVERNED_CANDIDATE_SHAPES = ['empty', 'non_json', 'malformed_json', 'valid_json'] as const;
const GOVERNED_CANDIDATE_CAPTURE_LIMIT = 131072;
const GOVERNED_CANDIDATE_BOUNDARY_KEYS = [
  'selectedOrigin', 'selectedChunkCount', 'selectedBytes', 'resultTextItemCount', 'resultTextBytes',
  'rawFinalMessageCount', 'rawFinalPartCount', 'rawFinalBytes',
] as const;
const GOVERNED_CANDIDATE_KEYS = ['version', 'text', 'boundary'] as const;

type GovernedProbeFailureStage = typeof ANSWER_FAILURE_STAGES[number];
type GovernedProbeFailureProjection = Readonly<Record<string, GovernedProbeFailureStage | string | null>>;
export type GovernedProbeFailurePhase = 'acquire' | 'preview' | 'initialize' | 'answer';
export type GovernedCandidateOrigin = typeof GOVERNED_CANDIDATE_ORIGINS[number];
export type GovernedCandidateShape = typeof GOVERNED_CANDIDATE_SHAPES[number];

type GovernedCandidateBoundary = Readonly<{
  selectedOrigin: GovernedCandidateOrigin;
  selectedChunkCount: number;
  selectedBytes: number;
  resultTextItemCount: number;
  resultTextBytes: number;
  rawFinalMessageCount: number;
  rawFinalPartCount: number;
  rawFinalBytes: number;
}>;

type GovernedCandidateObservation = Readonly<{
  version: typeof GOVERNED_CANDIDATE_VERSIONS[number];
  text: string;
  boundary: GovernedCandidateBoundary;
}>;

export type GovernedProbePublicCandidateRecord = Readonly<{
  schema: 'governed-probe-public-candidate/v1';
  provider: 'governed-proof-inspect';
  phase: 'answer';
  check_id: string;
  scope: readonly unknown[];
  selectedOrigin: GovernedCandidateOrigin;
  candidateChunkCount: number;
  candidateBytes: number;
  candidateSha256: `sha256:${string}`;
  candidateShape: GovernedCandidateShape;
  captureTruncated: boolean;
  candidateText: string | null;
  resultTextItemCount: number;
  resultTextBytes: number;
  rawFinalMessageCount: number;
  rawFinalPartCount: number;
  rawFinalBytes: number;
}>;

function ownDataValue(value: unknown, key: string, enumerable = true): unknown {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor && (!enumerable || descriptor.enumerable) ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read a closed object without invoking getters, proxy-backed accessors, or
 * inherited values. Probe freezes the event before emitting it; the runner
 * still copies only primitive data so the observation cannot be mutated by a
 * hostile hook caller after the callback returns.
 */
function closedDataObject(value: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (!value || typeof value !== 'object') return null;
  try {
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== keys.length || ownKeys.some(key => typeof key !== 'string' || !keys.includes(key))) return null;
    const output: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !('value' in descriptor) || !descriptor.enumerable) return null;
      output[key] = descriptor.value;
    }
    return output;
  } catch {
    return null;
  }
}

function nonnegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function candidateBoundary(value: unknown, text: string, version: typeof GOVERNED_CANDIDATE_VERSIONS[number]): GovernedCandidateObservation | null {
  const boundary = closedDataObject(value, GOVERNED_CANDIDATE_BOUNDARY_KEYS);
  if (!boundary || typeof text !== 'string') return null;
  const selectedOrigin = enumValue(boundary.selectedOrigin, GOVERNED_CANDIDATE_ORIGINS);
  const countKeys = GOVERNED_CANDIDATE_BOUNDARY_KEYS.slice(1);
  if (!selectedOrigin || countKeys.some(key => !nonnegativeSafeInteger(boundary[key]))) return null;
  const selectedChunkCount = boundary.selectedChunkCount as number;
  const selectedBytes = boundary.selectedBytes as number;
  const resultTextItemCount = boundary.resultTextItemCount as number;
  const resultTextBytes = boundary.resultTextBytes as number;
  const rawFinalMessageCount = boundary.rawFinalMessageCount as number;
  const rawFinalPartCount = boundary.rawFinalPartCount as number;
  const rawFinalBytes = boundary.rawFinalBytes as number;
  const textBytes = Buffer.byteLength(text, 'utf8');

  // The selected byte count is the UTF-8 length of exactly the text supplied
  // to the JSON validator. Empty candidates cannot have selected chunks.
  if (selectedBytes !== textBytes || (textBytes === 0 ? selectedChunkCount !== 0 : selectedChunkCount === 0)) return null;
  if (selectedOrigin === 'none' && (selectedChunkCount !== 0 || selectedBytes !== 0 || text.length !== 0)) return null;

  return Object.freeze({
    version,
    text,
    boundary: Object.freeze({
      selectedOrigin,
      selectedChunkCount,
      selectedBytes,
      resultTextItemCount,
      resultTextBytes,
      rawFinalMessageCount,
      rawFinalPartCount,
      rawFinalBytes,
    }),
  });
}

/**
 * Classify candidate text without reimplementing JSON parsing. Incomplete
 * syntax is deliberately folded into malformed_json: a generic parser error
 * cannot establish that a Proof/provider output was truncated.
 */
export function governedCandidateShape(text: string): GovernedCandidateShape {
  if (text.length === 0) return enumValue('empty', GOVERNED_CANDIDATE_SHAPES)!;
  try {
    JSON.parse(text);
    return enumValue('valid_json', GOVERNED_CANDIDATE_SHAPES)!;
  } catch {
    const trimmed = text.trim();
    if (trimmed.length === 0) return enumValue('non_json', GOVERNED_CANDIDATE_SHAPES)!;
    const firstNonWhitespace = trimmed[0];
    if (firstNonWhitespace !== '{' && firstNonWhitespace !== '[') return enumValue('non_json', GOVERNED_CANDIDATE_SHAPES)!;
    // Incomplete syntax is deliberately folded into malformed_json. The
    // runner must not infer that a Proof/provider output was truncated from a
    // generic JSON parser error; only the Probe boundary can make that claim.
    return enumValue('malformed_json', GOVERNED_CANDIDATE_SHAPES)!;
  }
}

function observeGovernedCandidate(payload: unknown): GovernedCandidateObservation | null {
  const envelope = closedDataObject(payload, GOVERNED_CANDIDATE_KEYS);
  if (!envelope || typeof envelope.version !== 'string' || !GOVERNED_CANDIDATE_VERSIONS.includes(envelope.version as typeof GOVERNED_CANDIDATE_VERSIONS[number]) || typeof envelope.text !== 'string') return null;
  return candidateBoundary(envelope.boundary, envelope.text, envelope.version as typeof GOVERNED_CANDIDATE_VERSIONS[number]);
}

function enumValue<T extends readonly string[]>(value: unknown, values: T): T[number] | null {
  return typeof value === 'string' && (values as readonly string[]).includes(value) ? value as T[number] : null;
}

/**
 * Project Probe's deliberately closed GovernedAnswerFailure shape without
 * exposing arbitrary Error properties, messages, stacks, or causes.
 */
export function sanitizeGovernedAnswerFailure(error: unknown): GovernedProbeFailureProjection {
  const name = ownDataValue(error, 'name', false);
  if (name !== 'GovernedAnswerFailure') return Object.freeze({ answerFailureStage: 'unknown' });
  const stage = enumValue(ownDataValue(error, 'answerFailureStage'), ANSWER_FAILURE_STAGES) ?? 'unknown';
  const output: Record<string, GovernedProbeFailureStage | string | null> = { answerFailureStage: stage };
  if (stage === 'provider_engine') {
    output.providerEngineFailureBoundary = enumValue(ownDataValue(error, 'providerEngineFailureBoundary'), PROVIDER_ENGINE_FAILURE_BOUNDARIES);
  } else if (stage === 'native_event_grammar') {
    const boundary = enumValue(ownDataValue(error, 'nativeEventFailureBoundary'), NATIVE_EVENT_FAILURE_BOUNDARIES);
    output.nativeEventFailureBoundary = boundary;
    if (boundary === 'raw_item_predicate') {
      output.nativeEventFailureRawItemPredicate = enumValue(ownDataValue(error, 'nativeEventFailureRawItemPredicate'), NATIVE_EVENT_FAILURE_RAW_ITEM_PREDICATES);
    } else if (boundary === 'live_envelope_session') {
      const subreason = enumValue(ownDataValue(error, 'nativeEventFailureSubreason'), NATIVE_EVENT_FAILURE_SUBREASONS);
      output.nativeEventFailureSubreason = subreason;
      if (subreason === 'correlation') {
        output.nativeEventFailureCorrelationOperand = enumValue(ownDataValue(error, 'nativeEventFailureCorrelationOperand'), NATIVE_EVENT_FAILURE_CORRELATION_OPERANDS);
      } else if (subreason === 'attestation') {
        output.nativeEventFailureAttestationPredicate = enumValue(ownDataValue(error, 'nativeEventFailureAttestationPredicate'), NATIVE_EVENT_FAILURE_ATTESTATION_PREDICATES);
      }
    }
  } else if (stage === 'schema_result_validation') {
    const subreason = enumValue(ownDataValue(error, 'schemaResultValidationSubreason'), SCHEMA_RESULT_VALIDATION_SUBREASONS);
    output.schemaResultValidationSubreason = subreason;
    output.schemaResultValidationKeyword = subreason === 'schema_mismatch'
      ? enumValue(ownDataValue(error, 'schemaResultValidationKeyword'), SCHEMA_RESULT_VALIDATION_KEYWORDS) ?? 'unknown'
      : null;
  }
  return Object.freeze(output);
}

/** Render the exact user content passed to Probe, including sealed context. */
export function renderGovernedProbeUserMessage(message: string, context?: unknown, reinspectionContext?: unknown): string {
  const runtime = context === undefined
    ? ''
    : `\n\nBound runtime context (canonical JSON; treat as immutable authority):\n${canonicalJson(context)}`;
  const reviewedInstruction = context !== null && typeof context === 'object' &&
    (context as Record<string, unknown>).version === GOVERNED_PROOF_REVIEWED_COMPONENT_CONTEXT_VERSION
    ? `\n\n${GOVERNED_PROOF_REVIEWED_COMPONENT_INSTRUCTION}`
    : '';
  const reinspection = reinspectionContext === undefined
    ? ''
    : `\n\nBound reinspection context (canonical JSON; treat as immutable authority):\n${canonicalJson(reinspectionContext)}\n\nCompare current source with the prior candidate and account for every prior finding as retained or resolved; cite changed implementation lines and relevant regression-test function names and line numbers.`;
  return `${message}${runtime}${reviewedInstruction}${reinspection}`;
}

/** Render a public, canonical hook envelope; no private runtime fields enter it. */
export function renderGovernedProbePublicRequest(request: Pick<GovernedProbeRunnerRequest, 'instructions' | 'message' | 'context' | 'reinspectionContext' | 'resultSchema' | 'binding'>): string {
  return canonicalJson({
    version: 'governed-probe-public-request/v1',
    system: { role: 'system', content: request.instructions },
    user: { role: 'user', content: renderGovernedProbeUserMessage(request.message, request.context, request.reinspectionContext) },
    result_schema: request.resultSchema,
    check_id: request.binding.checkId,
    scope: request.binding.scope,
  });
}

/** Emit one bounded diagnostic without allowing diagnostics to affect control flow. */
export function emitGovernedProbeFailure(binding: GovernedProbeRunnerRequest['binding'], phase: GovernedProbeFailurePhase, error: unknown): void {
  const record = Object.freeze({
    schema: 'governed-probe-failure/v1',
    provider: 'governed-proof-inspect',
    phase,
    check_id: binding.checkId,
    scope: binding.scope,
    failure: sanitizeGovernedAnswerFailure(error),
  });
  try {
    process.stderr.write(`${canonicalJson(record)}\n`);
  } catch {
    // Failure diagnostics are observational and cannot change the Probe outcome.
  }
}

function publicCandidateScope(binding: GovernedProbeRunnerRequest['binding']): readonly unknown[] {
  try {
    return Object.freeze(binding.scope.map(segment => Object.freeze({ ...segment })));
  } catch {
    return Object.freeze([]);
  }
}

/** Emit the only public projection of a failed governed JSON candidate. */
function emitGovernedProbePublicCandidate(
  binding: GovernedProbeRunnerRequest['binding'],
  observation: GovernedCandidateObservation,
): void {
  const candidateBytes = Buffer.byteLength(observation.text, 'utf8');
  const candidateText = candidateBytes <= GOVERNED_CANDIDATE_CAPTURE_LIMIT ? observation.text : null;
  const record: GovernedProbePublicCandidateRecord = Object.freeze({
    schema: 'governed-probe-public-candidate/v1',
    provider: 'governed-proof-inspect',
    phase: 'answer',
    check_id: binding.checkId,
    scope: publicCandidateScope(binding),
    selectedOrigin: observation.boundary.selectedOrigin,
    candidateChunkCount: observation.boundary.selectedChunkCount,
    candidateBytes,
    candidateSha256: `sha256:${createHash('sha256').update(observation.text, 'utf8').digest('hex')}`,
    candidateShape: governedCandidateShape(observation.text),
    captureTruncated: candidateText === null,
    candidateText,
    resultTextItemCount: observation.boundary.resultTextItemCount,
    resultTextBytes: observation.boundary.resultTextBytes,
    rawFinalMessageCount: observation.boundary.rawFinalMessageCount,
    rawFinalPartCount: observation.boundary.rawFinalPartCount,
    rawFinalBytes: observation.boundary.rawFinalBytes,
  });
  try {
    process.stderr.write(`${canonicalJson(record)}\n`);
  } catch {
    // Candidate diagnostics are observational and cannot change the Probe outcome.
  }
}

const PROBE_TOOLS: ['search', 'extract', 'listFiles'] = [
  'search',
  'extract',
  'listFiles',
];

type ExactProbeAgentOptions = ProbeAgentOptions & {
  readonly searchDelegate: false;
  readonly enableExecutePlan: false;
  governedCodexTransport?: 'mcp-server-v1' | 'exec-jsonl-default-auth-v1';
  codexBin?: string;
  codexSha256?: string;
};

type GovernedProbeRunnerBudget = { limit: number; consumed: number };
const governedProbeRunnerBudget = new AsyncLocalStorage<GovernedProbeRunnerBudget>();

export function withGovernedProbeRunnerBudget<T>(limit: number, callback: () => T): T {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('GOVERNED_PROOF_INVALID: budget limit must be a positive safe integer');
  return governedProbeRunnerBudget.run({ limit, consumed: 0 }, callback);
}

function controllerRoot(value: string): string {
  if (!isAbsolute(value) || value.includes('\0')) {
    throw new Error('GOVERNED_PROOF_INVALID: workingDirectory must be absolute');
  }
  const resolved = resolve(value);
  try {
    if (!statSync(resolved).isDirectory()) {
      throw new Error('GOVERNED_PROOF_INVALID: workingDirectory is not a directory');
    }
    return realpathSync(resolved);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('GOVERNED_PROOF_INVALID:')) {
      throw error;
    }
    throw new Error('GOVERNED_PROOF_INVALID: workingDirectory is unavailable');
  }
}

function profileFor(root: string): GovernedCodexProfile {
  return {
    version: 'probe.governed-codex-profile/v1',
    profileId: 'luna-xhigh-readonly-v1',
    engine: 'codex',
    model: 'gpt-5.6-luna',
    reasoningEffort: 'xhigh',
    sandbox: 'read-only',
    approvalPolicy: 'never',
    cwd: root,
    probeTools: PROBE_TOOLS,
    fallback: false,
    retries: 0,
  };
}

export class GovernedProbeAgentRunner implements GovernedProbeRunner {
  private readonly agent: ProbeAgent;
  private readonly resultSchema: string;
  private readonly invocationDigest: string;
  private readonly userMessage: string;
  private readonly binding: GovernedProbeRunnerRequest['binding'];
  private failureEmitted = false;
  private initializePromise: Promise<void> | undefined;
  private cancelled = false;
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private candidateObservation: GovernedCandidateObservation | undefined;
  private candidateFailureEmitted = false;

  constructor(request: GovernedProbeRunnerRequest) {
    const root = controllerRoot(request.workingDirectory);
    this.resultSchema = request.resultSchema;
    this.invocationDigest = request.invocationDigest;
    this.binding = request.binding;
    if (typeof request.message !== 'string' || request.message.length === 0 || Buffer.byteLength(request.message, 'utf8') > 32768) {
      throw new Error('GOVERNED_PROOF_INVALID: message is invalid');
    }
    this.userMessage = renderGovernedProbeUserMessage(request.message, request.context, request.reinspectionContext);
    const governedCodexProfile = profileFor(root);
    const options: ExactProbeAgentOptions = {
      provider: 'codex',
      path: root,
      cwd: root,
      systemPrompt: request.instructions,
      allowEdit: false,
      enableDelegate: false,
      searchDelegate: false,
      enableExecutePlan: false,
      enableBash: false,
      allowSkills: false,
      allowedTools: PROBE_TOOLS,
      governedCodexProfile,
      hooks: {
        // This is the sole hook installed by the governed runner. Probe emits
        // the frozen candidate immediately before JSON validation; this sync
        // callback copies only its closed primitive observation.
        'message:assistant': (payload: unknown): void => this.captureCandidate(payload),
      },
    };
    if (request.governedCodexTransport !== undefined) {
      if (request.governedCodexTransport !== 'exec-jsonl-default-auth-v1' ||
          typeof request.codexSha256 !== 'string' ||
          !/^(?:[0-9a-f]{64}|sha256:[0-9a-f]{64})$/.test(request.codexSha256) ||
          typeof request.codexBin !== 'string' ||
          !isAbsolute(request.codexBin)) {
        throw new Error('GOVERNED_PROOF_INVALID: governed Codex executable identity is invalid');
      }
      // These options are intentionally copied only for the explicit
      // transport selector. Probe owns the launch/receipt validator; Visor
      // does not inspect or reconstruct its JSONL wire.
      options.governedCodexTransport = request.governedCodexTransport;
      options.codexBin = request.codexBin;
      options.codexSha256 = request.codexSha256;
    } else if (request.codexBin !== undefined || request.codexSha256 !== undefined) {
      throw new Error('GOVERNED_PROOF_INVALID: governed Codex executable requires an explicit transport');
    }
    this.agent = new ProbeAgent(options);
  }

  private captureCandidate(payload: unknown): void {
    if (this.candidateObservation) return;
    const observation = observeGovernedCandidate(payload);
    if (observation) this.candidateObservation = observation;
  }

  async preview(_request: GovernedProbeRunnerRequest): Promise<GovernedProbeDispatchPreview> {
    if (this.cancelled) throw new Error('GOVERNED_PROOF_INVALID: runner is cancelled');
    if (this.closed) throw new Error('GOVERNED_PROOF_INVALID: runner is closed');
    try {
      return await this.agent.previewGovernedAnswerDispatch(this.userMessage, { schema: this.resultSchema });
    } catch (error) {
      this.reportFailure('preview', error);
      throw error;
    }
  }

  async answer(_request: GovernedProbeRunnerRequest): Promise<GovernedIdentifiedAnswerResult> {
    if (this.cancelled) throw new Error('GOVERNED_PROOF_INVALID: runner is cancelled');
    if (this.closed) throw new Error('GOVERNED_PROOF_INVALID: runner is closed');
    try {
      if (!this.initializePromise) this.initializePromise = this.agent.initialize();
      await this.initializePromise;
    } catch (error) {
      this.reportFailure('initialize', error);
      throw error;
    }
    if (this.cancelled) throw new Error('GOVERNED_PROOF_INVALID: runner is cancelled');
    if (this.closed) throw new Error('GOVERNED_PROOF_INVALID: runner is closed');
    const options: GovernedIdentifiedAnswerOptions = {
      schema: this.resultSchema,
      invocationDigest: this.invocationDigest,
      resultIdentity: 'probe.governed-result-identity/v1',
    };
    this.candidateObservation = undefined;
    this.candidateFailureEmitted = false;
    let identified: GovernedIdentifiedAnswerResult;
    try {
      identified = await this.agent.answerGoverned(this.userMessage, options);
    } catch (error) {
      this.reportFailure('answer', error);
      throw error;
    }
    // Probe's generic result identity intentionally retains its historical
    // ordering. The onboarding candidate is a Proof wire, so re-project that
    // one result with Proof's UTF-8 bytewise key ordering before Visor binds
    // its candidate evidence and claim publication.
    const wireMode = governedWireModeFromInvocation(_request.invocation);
    if (wireMode === 'proof') {
      const data = immutableGovernedValue(identified.data, wireMode);
      const canonical = Buffer.from(governedCanonicalJson(data, wireMode), 'utf8');
      this.candidateObservation = undefined;
      return Object.freeze({
        ...identified,
        data,
        resultIdentity: Object.freeze({
          ...identified.resultIdentity,
          resultDigest: governedResultDigest(data, wireMode),
          canonicalBytes: canonical.length,
        }),
      });
    }
    this.candidateObservation = undefined;
    return identified;
  }

  private reportFailure(phase: Exclude<GovernedProbeFailurePhase, 'acquire'>, error: unknown): void {
    const failure = sanitizeGovernedAnswerFailure(error);
    const isSchemaResultFailure = phase === 'answer' && failure.answerFailureStage === 'schema_result_validation';
    if (isSchemaResultFailure && this.candidateObservation && !this.candidateFailureEmitted) {
      this.candidateFailureEmitted = true;
      emitGovernedProbePublicCandidate(this.binding, this.candidateObservation);
      this.candidateObservation = undefined;
    }
    if (isSchemaResultFailure) this.candidateObservation = undefined;
    if (this.failureEmitted) return;
    this.failureEmitted = true;
    emitGovernedProbeFailure(this.binding, phase, error);
  }

  cancel(_reason: 'deadline'): void {
    if (this.cancelled || this.closed) return;
    this.cancelled = true;
    this.agent.cancel();
  }

  async close(): Promise<void> {
    if (!this.closePromise) {
      this.closed = true;
      this.closePromise = this.agent.close();
    }
    await this.closePromise;
  }
}

export function createGovernedProbeRunner(request: GovernedProbeRunnerRequest): GovernedProbeRunner {
  const budget = governedProbeRunnerBudget.getStore();
  if (budget) {
    if (budget.consumed >= budget.limit) throw new Error('GOVERNED_PROOF_BUDGET_EXCEEDED');
    budget.consumed += 1;
  }
  return new GovernedProbeAgentRunner(request);
}
