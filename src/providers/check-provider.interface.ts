import { PRInfo } from '../pr-analyzer';
import { ReviewSummary } from '../reviewer';
import { EnvConfig, HumanInputRequest } from '../types/config';

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
  args?: string[]; // Deprecated: use exec with inline args instead
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
  /** SDK hooks for human input */
  hooks?: {
    onHumanInput?: (request: HumanInputRequest) => Promise<string>;
    onPromptCaptured?: (info: { step: string; provider: string; prompt: string }) => void;
    mockForStep?: (step: string) => unknown | undefined;
  };
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
