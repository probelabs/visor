import { AsyncLocalStorage } from 'node:async_hooks';
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

type GovernedProbeFailureStage = typeof ANSWER_FAILURE_STAGES[number];
type GovernedProbeFailureProjection = Readonly<Record<string, GovernedProbeFailureStage | string | null>>;
export type GovernedProbeFailurePhase = 'acquire' | 'preview' | 'initialize' | 'answer';

function ownDataValue(value: unknown, key: string, enumerable = true): unknown {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor && (!enumerable || descriptor.enumerable) ? descriptor.value : undefined;
  } catch {
    return undefined;
  }
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

const PROBE_TOOLS: ['search', 'extract', 'listFiles'] = [
  'search',
  'extract',
  'listFiles',
];

type ExactProbeAgentOptions = ProbeAgentOptions & {
  readonly searchDelegate: false;
  readonly enableExecutePlan: false;
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
    };
    this.agent = new ProbeAgent(options);
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
    return identified;
  }

  private reportFailure(phase: Exclude<GovernedProbeFailurePhase, 'acquire'>, error: unknown): void {
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
