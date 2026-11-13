import { type GovernedIdentifiedAnswerResult } from '@probelabs/probe';
import type { GovernedProbeDispatchPreview, GovernedProbeRunner, GovernedProbeRunnerRequest } from './governed-proof-inspect-check-provider';
/** The runner owns the only user message sent to the governed Probe boundary. */
export declare const GOVERNED_PROOF_ROLE_MESSAGE: string;
export declare const GOVERNED_PROOF_REVIEWED_COMPONENT_CONTEXT_VERSION = "visor.proof-reviewed-component-context/v1";
declare const ANSWER_FAILURE_STAGES: readonly ["native_event_grammar", "provider_engine", "schema_result_validation", "internal_contract", "unknown"];
declare const GOVERNED_CANDIDATE_ORIGINS: readonly ["result_content", "raw_final", "none"];
declare const GOVERNED_CANDIDATE_SHAPES: readonly ["empty", "non_json", "malformed_json", "valid_json"];
declare const GOVERNED_CODEX_EXEC_FAILURE_CODES: readonly ["GOVERNED_CODEX_EXEC_ANSWER_CARDINALITY", "GOVERNED_CODEX_EXEC_CANCELLED", "GOVERNED_CODEX_EXEC_CANONICAL", "GOVERNED_CODEX_EXEC_CLEANUP", "GOVERNED_CODEX_EXEC_CONFIG", "GOVERNED_CODEX_EXEC_DUPLICATE", "GOVERNED_CODEX_EXEC_EVENT", "GOVERNED_CODEX_EXEC_EVENT_CATEGORY", "GOVERNED_CODEX_EXEC_EVENT_LIMIT", "GOVERNED_CODEX_EXEC_EVENT_ORDER", "GOVERNED_CODEX_EXEC_EXIT", "GOVERNED_CODEX_EXEC_INCOMPLETE", "GOVERNED_CODEX_EXEC_INCOMPLETE_ITEM", "GOVERNED_CODEX_EXEC_ITEM", "GOVERNED_CODEX_EXEC_ITEM_ORDER", "GOVERNED_CODEX_EXEC_ITEM_STATUS", "GOVERNED_CODEX_EXEC_JSONL", "GOVERNED_CODEX_EXEC_MCP", "GOVERNED_CODEX_EXEC_MCP_EVIDENCE", "GOVERNED_CODEX_EXEC_ONE_QUERY", "GOVERNED_CODEX_EXEC_OUTPUT_OVERFLOW", "GOVERNED_CODEX_EXEC_SETUP", "GOVERNED_CODEX_EXEC_SPAWN", "GOVERNED_CODEX_EXEC_TIMEOUT", "GOVERNED_CODEX_EXEC_TOOL_POLICY", "GOVERNED_CODEX_EXEC_USAGE", "GOVERNED_CODEX_EXEC_VERSION"];
declare const GOVERNED_CODEX_EXEC_FAILURE_DIAGNOSTIC_VERSION = "probe.governed-codex-exec-failure/v1";
declare const GOVERNED_CODEX_EXEC_STDERR_VERSION = "codex-exec-stderr/v1";
declare const GOVERNED_CODEX_EXEC_SAFE_MESSAGES: readonly ["access_token_refresh_revoked"];
declare const GOVERNED_CODEX_EXEC_EVENT_VERSION = "codex-exec-rejected-item/v1";
declare const GOVERNED_CODEX_EXEC_FAILURE_EVENT_VERSION = "codex-exec-rejected-failure/v1";
declare const GOVERNED_CODEX_EXEC_FAILURE_EVENT_TYPES: readonly ["error", "turn.failed"];
declare const GOVERNED_CODEX_EXEC_SCHEMA_PROVIDER_ERROR: Readonly<{
    type: "invalid_request_error";
    status: 400;
    code: "invalid_json_schema";
    param: "text.format.schema";
    schemaKeyword: "uniqueItems";
}>;
declare const GOVERNED_CODEX_EXEC_EVENT_PREDICATES: readonly ["item_keys", "item_id", "item_text", "item_phase", "item_summary", "item_server", "item_command", "item_aggregated_output", "item_exit_code", "item_status", "item_error", "item_started_payload", "item_changes", "tool_id"];
declare const GOVERNED_CODEX_EXEC_EVENT_TYPES: readonly ["null", "array", "object", "string", "number", "boolean"];
type GovernedProbeFailureStage = typeof ANSWER_FAILURE_STAGES[number];
type GovernedCodexExecFailureEvent = Readonly<{
    source: typeof GOVERNED_CODEX_EXEC_FAILURE_EVENT_VERSION;
    category: 'failure';
    eventType: typeof GOVERNED_CODEX_EXEC_FAILURE_EVENT_TYPES[number];
    eventFields: readonly Readonly<{
        name: string;
        type: typeof GOVERNED_CODEX_EXEC_EVENT_TYPES[number];
        size?: number;
    }>[];
    providerError?: typeof GOVERNED_CODEX_EXEC_SCHEMA_PROVIDER_ERROR;
}>;
type GovernedProbeFailureDiagnostic = Readonly<{
    version: typeof GOVERNED_CODEX_EXEC_FAILURE_DIAGNOSTIC_VERSION;
    code: typeof GOVERNED_CODEX_EXEC_FAILURE_CODES[number];
    stderr?: Readonly<{
        source: typeof GOVERNED_CODEX_EXEC_STDERR_VERSION;
        bytes: number;
        digest: `sha256:${string}`;
        safeMessage?: typeof GOVERNED_CODEX_EXEC_SAFE_MESSAGES[number];
    }>;
    event?: Readonly<{
        source: typeof GOVERNED_CODEX_EXEC_EVENT_VERSION;
        predicate: typeof GOVERNED_CODEX_EXEC_EVENT_PREDICATES[number];
        eventType: 'item.started' | 'item.completed';
        itemType: 'agent_message' | 'reasoning' | 'mcp_tool_call' | 'command_execution' | 'file_change';
        itemStatus?: 'failed' | 'declined';
        eventFields: readonly Readonly<{
            name: string;
            type: typeof GOVERNED_CODEX_EXEC_EVENT_TYPES[number];
            size?: number;
        }>[];
        itemFields: readonly Readonly<{
            name: string;
            type: typeof GOVERNED_CODEX_EXEC_EVENT_TYPES[number];
            size?: number;
        }>[];
    }> | GovernedCodexExecFailureEvent;
}>;
type GovernedProbeFailureProjection = Readonly<Record<string, GovernedProbeFailureStage | string | null | GovernedProbeFailureDiagnostic>>;
export type GovernedProbeFailurePhase = 'acquire' | 'preview' | 'initialize' | 'answer';
export type GovernedCandidateOrigin = typeof GOVERNED_CANDIDATE_ORIGINS[number];
export type GovernedCandidateShape = typeof GOVERNED_CANDIDATE_SHAPES[number];
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
/**
 * Classify candidate text without reimplementing JSON parsing. Incomplete
 * syntax is deliberately folded into malformed_json: a generic parser error
 * cannot establish that a Proof/provider output was truncated.
 */
export declare function governedCandidateShape(text: string): GovernedCandidateShape;
/**
 * Project Probe's deliberately closed GovernedAnswerFailure shape without
 * exposing arbitrary Error properties, messages, stacks, or causes.
 */
export declare function sanitizeGovernedAnswerFailure(error: unknown): GovernedProbeFailureProjection;
/** Render the exact user content passed to Probe, including sealed context. */
export declare function renderGovernedProbeUserMessage(message: string, context?: unknown, reinspectionContext?: unknown): string;
/** Render a public, canonical hook envelope; no private runtime fields enter it. */
export declare function renderGovernedProbePublicRequest(request: Pick<GovernedProbeRunnerRequest, 'instructions' | 'message' | 'context' | 'reinspectionContext' | 'resultSchema' | 'binding'>): string;
/** Emit one bounded diagnostic without allowing diagnostics to affect control flow. */
export declare function emitGovernedProbeFailure(binding: GovernedProbeRunnerRequest['binding'], phase: GovernedProbeFailurePhase, error: unknown): void;
export declare function withGovernedProbeRunnerBudget<T>(limit: number, callback: () => T): T;
export declare class GovernedProbeAgentRunner implements GovernedProbeRunner {
    private readonly agent;
    private readonly resultSchema;
    private readonly invocationDigest;
    private readonly userMessage;
    private readonly binding;
    private failureEmitted;
    private initializePromise;
    private cancelled;
    private closed;
    private closePromise;
    private candidateObservation;
    private candidateFailureEmitted;
    constructor(request: GovernedProbeRunnerRequest);
    private captureCandidate;
    preview(_request: GovernedProbeRunnerRequest): Promise<GovernedProbeDispatchPreview>;
    answer(_request: GovernedProbeRunnerRequest): Promise<GovernedIdentifiedAnswerResult>;
    private reportFailure;
    cancel(_reason: 'deadline'): void;
    close(): Promise<void>;
}
export declare function createGovernedProbeRunner(request: GovernedProbeRunnerRequest): GovernedProbeRunner;
export {};
//# sourceMappingURL=governed-probe-runner.d.ts.map