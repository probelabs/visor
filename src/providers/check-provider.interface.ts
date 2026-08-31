import { PRInfo } from '../pr-analyzer';
import { ReviewSummary } from '../reviewer';
import { EnvConfig, HumanInputRequest } from '../types/config';
import type { ScopePath } from '../snapshot-store';
import type {
  KeyedScopePath,
  ManagedRunBindingV1,
} from '../state-machine/graph/instance-kernel';
import type { ProofCandidateEvidenceV1 } from './governed-proof-inspect-check-provider';

interface CandidateClaimInputBase {
  readonly claimId: string;
  readonly claim: string;
  readonly payload: unknown;
  readonly payloadFingerprint: string;
  readonly producerCheckId: string;
  readonly scope: Readonly<ScopePath> | KeyedScopePath;
  readonly parentClaimIds: readonly string[];
  /** Graph-owned governed evidence, present only for an admitted candidate claim. */
  readonly proofAdmission?: ProofCandidateEvidenceV1;
}

/** Exact, immutable candidate claim view granted to a consuming provider. */
export type CandidateClaimInput = CandidateClaimInputBase &
  (
    | {
        /** Root and generated claims retain their actual producer attempt authority. */
        readonly provenance?: 'attempt';
        readonly attemptId: string;
        readonly fence: number;
      }
    | {
        /** Controller item claims are derived from an expansion and have no fake attempt. */
        readonly provenance: 'controller';
        readonly catalogClaimId: string;
        readonly incarnation: number;
        readonly attemptId?: never;
        readonly fence?: never;
      }
  );

/**
 * Configuration for a check provider
 */
export interface CheckProviderConfig {
  type: string;
  prompt?: string;
  eventContext?: Record<string, unknown>;
  focus?: string;
  command?: string; // For PR comment triggers
  exec?: string; // For command execution (supports Liquid templates)
  stdin?: string; // Optional stdin input (supports Liquid templates)
  args?: string[] | Record<string, unknown>; // string[] deprecated for command args; Record for workflow inputs
  command_args?: string[]; // MCP stdio command arguments
  interpreter?: string;
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  timeout?: number;
  metadata?: Record<string, unknown>;
  workingDirectory?: string;
  env?: EnvConfig;
  ai?: import('../types/config').AIProviderConfig;
  /** AI model to use for this check - overrides global setting */
  ai_model?: string;
  /** AI provider to use for this check - overrides global setting */
  ai_provider?: 'google' | 'anthropic' | 'openai' | string;
  /** Check name for sessionID and logging purposes */
  checkName?: string;
  /** Session ID for AI session management */
  sessionId?: string;
  /** Script content for 'script' provider */
  content?: string;
  [key: string]: unknown;
}

/**
 * Execution context passed to check providers
 */
export interface ExecutionContext {
  /** Session information for AI session reuse */
  parentSessionId?: string;
  reuseSession?: boolean;
  /** CLI message value (from --message argument) */
  cliMessage?: string;
  /** Conversation context - unified access to user message across transports (CLI, Slack, etc.) */
  conversation?: import('../types/bot').ConversationContext;
  /**
   * Stage-local baseline of output history lengths per check name.
   * When present, providers should expose an `outputs_history_stage` object in
   * Liquid/JS contexts that slices the global history from this baseline.
   * This enables stage-scoped assertions in the YAML test runner without
   * relying on global execution history.
   */
  stageHistoryBase?: Record<string, number>;
  /** Workflow inputs - available when executing within a workflow */
  workflowInputs?: Record<string, unknown>;
  /** Custom arguments passed from on_init 'with' directive */
  args?: Record<string, unknown>;
  /** Exact declared candidate claims. No global/nearest output fallback is applied. */
  claims?: Readonly<Record<string, CandidateClaimInput>>;
  /** Journal-derived dynamic node identity; present only for generated C2 work. */
  nodeInstanceId?: string;
  /** Journal-derived active generation identity; present only for generated C2 work. */
  nodeGenerationId?: string;
  /** Exact immutable keyed scope for generated C2 work. */
  scope?: Readonly<ScopePath> | KeyedScopePath;
  /** SDK hooks for human input and check completion */
  hooks?: {
    onHumanInput?: (request: HumanInputRequest) => Promise<string>;
    onPromptCaptured?: (info: { step: string; provider: string; prompt: string }) => void;
    mockForStep?: (step: string) => unknown | undefined;
    /** Returns true if the mock for a step has been consumed (for loop termination) */
    isMockExhausted?: (step: string) => boolean;
    /** Called when a check completes - useful for streaming TUI updates */
    onCheckComplete?: (info: {
      checkId: string;
      result: { output?: unknown; content?: string };
      checkConfig?: { type?: string; group?: string; criticality?: string; schema?: unknown };
    }) => void;
  };
  /**
   * Optional execution mode hints. The core engine does not read environment
   * variables directly; callers (CLI, test runner) can set these flags to
   * request certain behaviors without polluting core logic with test-specific
   * branches.
   */
  mode?: {
    /** true when running under the YAML test runner */
    test?: boolean;
    /** post review comments from grouped execution paths (used by tests) */
    postGroupedComments?: boolean;
    /** reset per-run guard state before grouped execution */
    resetPerRunState?: boolean;
  };
  /**
   * Absolute timestamp (ms since epoch) by which this execution must complete.
   * Set by the engine from `Date.now() + timeout` and inherited by sub-workflows
   * so nested steps know how much time the parent has left.
   */
  deadline?: number;
  /** Optional event bus for emitting integration events (e.g., HumanInputRequested) */
  eventBus?: import('../event-bus/event-bus').EventBus;
  /** Optional webhook context (e.g., Slack Events API payload) */
  webhookContext?: { webhookData?: Map<string, unknown>; eventType?: string };
  /**
   * Callback for capturing AI responses - used by scheduler to store previousResponse
   * for recurring reminders. The text passed is the AI response before mrkdwn formatting.
   */
  responseCapture?: (text: string) => void;
}

/** Immutable controller inputs for synchronous managed-run acquisition. */
export interface ManagedRunStartRequest {
  readonly prInfo: PRInfo;
  readonly checkConfig: CheckProviderConfig;
  readonly dependencyResults: ReadonlyMap<string, ReviewSummary>;
  readonly executionContext: ExecutionContext;
  readonly binding: ManagedRunBindingV1;
  /** Immutable compiled execution authority, never authored provider data. */
  readonly executionConfigDigest: string;
}

export interface ManagedRunStartedReceiptV1 {
  readonly version: 1;
  readonly kind: 'started';
  readonly binding: ManagedRunBindingV1;
}

export interface ManagedRunSucceededOutcomeV1 {
  readonly version: 1;
  readonly kind: 'succeeded';
  readonly binding: ManagedRunBindingV1;
  readonly summary: ReviewSummary;
}

export interface ManagedProofCandidateSucceededOutcomeV1 {
  readonly version: 1;
  readonly kind: 'succeeded-proof-candidate';
  readonly binding: ManagedRunBindingV1;
  readonly summary: ReviewSummary;
  readonly proofCandidateEvidence: ProofCandidateEvidenceV1;
}

export interface ManagedRunFailedOutcomeV1 {
  readonly version: 1;
  readonly kind: 'failed';
  readonly binding: ManagedRunBindingV1;
}

export type ManagedRunOutcomeV1 =
  | ManagedRunSucceededOutcomeV1
  | ManagedProofCandidateSucceededOutcomeV1
  | ManagedRunFailedOutcomeV1;

export interface ManagedRunCancelReceiptV1 {
  readonly version: 1;
  readonly kind: 'cancelled';
  readonly binding: ManagedRunBindingV1;
  readonly reason: 'deadline';
}

export interface ManagedRunCleanupReceiptV1 {
  readonly version: 1;
  readonly kind: 'cleanup';
  readonly binding: ManagedRunBindingV1;
  readonly status: 'clean';
  readonly activeChildren: 0;
  readonly activeResources: 0;
}

/** Exact close-capable handle whose authority is snapshotted synchronously by Visor. */
export interface ManagedAgentRun {
  readonly binding: ManagedRunBindingV1;
  readonly started: Promise<ManagedRunStartedReceiptV1>;
  readonly outcome: Promise<ManagedRunOutcomeV1>;
  readonly cancel: (
    reason: 'deadline',
    fence: number
  ) => Promise<ManagedRunCancelReceiptV1>;
  readonly close: () => Promise<ManagedRunCleanupReceiptV1>;
}

/**
 * Abstract base class for all check providers
 * Implementing classes provide specific check functionality (AI, tool, script, etc.)
 */
export abstract class CheckProvider {
  /**
   * Get the unique name/type of this provider
   */
  abstract getName(): string;

  /**
   * Get a human-readable description of this provider
   */
  abstract getDescription(): string;

  /**
   * Validate provider-specific configuration
   * @param config The configuration to validate
   * @returns true if configuration is valid, false otherwise
   */
  abstract validateConfig(config: unknown): Promise<boolean>;

  /**
   * Execute the check on the given PR information
   * @param prInfo Information about the pull request
   * @param config Provider-specific configuration
   * @param dependencyResults Optional results from dependency checks that this check depends on
   * @param context Optional execution context with session info, hooks, and CLI state
   * @returns Review summary with scores, issues, and comments
   */
  abstract execute(
    prInfo: PRInfo,
    config: CheckProviderConfig,
    dependencyResults?: Map<string, ReviewSummary>,
    context?: ExecutionContext
  ): Promise<ReviewSummary>;

  /**
   * Synchronously acquire an exact close-capable managed run. Visor validates
   * and snapshots the returned handle before awaiting provider-controlled data.
   */
  startManaged?(request: ManagedRunStartRequest): ManagedAgentRun;

  /**
   * Get the list of configuration keys this provider supports
   * Used for documentation and validation
   */
  abstract getSupportedConfigKeys(): string[];

  /**
   * Check if this provider is available (e.g., has required API keys)
   * @returns true if provider can be used, false otherwise
   */
  abstract isAvailable(): Promise<boolean>;

  /**
   * Get provider requirements (e.g., environment variables needed)
   */
  abstract getRequirements(): string[];

  /**
   * Set webhook context for providers that need access to webhook data
   * This is optional and only used by http_input providers
   * @param webhookContext Map of endpoint paths to webhook data
   */
  setWebhookContext?(webhookContext: Map<string, unknown>): void;
}
