import { PRInfo } from '../pr-analyzer';
import { ReviewSummary } from '../reviewer';

/**
 * Configuration for a check provider
 */
export interface CheckProviderConfig {
  type: string;
  prompt?: string;
  focus?: string;
  command?: string;
  args?: string[];
  script?: string;
  interpreter?: string;
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  timeout?: number;
  metadata?: Record<string, unknown>;
  workingDirectory?: string;
  env?: Record<string, string>;
  ai?: {
    provider?: string;
    model?: string;
    apiKey?: string;
    timeout?: number;
    debug?: boolean;
  };
  [key: string]: unknown;
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
   * @returns Review summary with scores, issues, and comments
   */
  abstract execute(
    prInfo: PRInfo,
    config: CheckProviderConfig,
    dependencyResults?: Map<string, ReviewSummary>
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
}
