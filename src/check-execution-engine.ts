import { PRReviewer, ReviewSummary, ReviewOptions } from './reviewer';
import { GitRepositoryAnalyzer, GitRepositoryInfo } from './git-repository-analyzer';
import { AnalysisResult } from './output-formatters';
import { PRInfo } from './pr-analyzer';
import { CheckProviderRegistry } from './providers/check-provider-registry';
import { CheckProviderConfig } from './providers/check-provider.interface';

export interface MockOctokit {
  rest: {
    pulls: {
      get: () => Promise<{ data: Record<string, unknown> }>;
      listFiles: () => Promise<{ data: Record<string, unknown>[] }>;
    };
    issues: {
      listComments: () => Promise<{ data: Record<string, unknown>[] }>;
      createComment: () => Promise<{ data: Record<string, unknown> }>;
    };
  };
  request: () => Promise<{ data: Record<string, unknown> }>;
  graphql: () => Promise<Record<string, unknown>>;
  log: {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  hook: {
    before: (...args: unknown[]) => void;
    after: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    wrap: (...args: unknown[]) => void;
  };
  auth: () => Promise<{ token: string }>;
}

export interface CheckExecutionOptions {
  checks: string[];
  workingDirectory?: string;
  showDetails?: boolean;
  timeout?: number;
  outputFormat?: string;
  config?: import('./types/config').VisorConfig;
  debug?: boolean; // Enable debug mode to collect AI execution details
}

export class CheckExecutionEngine {
  private gitAnalyzer: GitRepositoryAnalyzer;
  private mockOctokit: MockOctokit;
  private reviewer: PRReviewer;
  private providerRegistry: CheckProviderRegistry;

  constructor(workingDirectory?: string) {
    this.gitAnalyzer = new GitRepositoryAnalyzer(workingDirectory);
    this.providerRegistry = CheckProviderRegistry.getInstance();

    // Create a mock Octokit instance for local analysis
    // This allows us to reuse the existing PRReviewer logic without network calls
    this.mockOctokit = this.createMockOctokit();
    this.reviewer = new PRReviewer(this.mockOctokit as unknown as import('@octokit/rest').Octokit);
  }

  /**
   * Execute checks on the local repository
   */
  async executeChecks(options: CheckExecutionOptions): Promise<AnalysisResult> {
    const startTime = Date.now();
    const timestamp = new Date().toISOString();

    try {
      // Determine where to send log messages based on output format
      const logFn =
        options.outputFormat === 'json' || options.outputFormat === 'sarif'
          ? console.error
          : console.log;

      // Analyze the repository
      logFn('🔍 Analyzing local git repository...');
      const repositoryInfo = await this.gitAnalyzer.analyzeRepository();

      if (!repositoryInfo.isGitRepository) {
        return this.createErrorResult(
          repositoryInfo,
          'Not a git repository or no changes found',
          startTime,
          timestamp,
          options.checks
        );
      }

      // Convert to PRInfo format for compatibility with existing reviewer
      const prInfo = this.gitAnalyzer.toPRInfo(repositoryInfo);

      // Execute checks using the existing PRReviewer
      logFn(`🤖 Executing checks: ${options.checks.join(', ')}`);
      const reviewSummary = await this.executeReviewChecks(
        prInfo,
        options.checks,
        options.timeout,
        options.config,
        options.outputFormat,
        options.debug
      );

      const executionTime = Date.now() - startTime;

      // Collect debug information when debug mode is enabled
      let debugInfo: import('./output-formatters').DebugInfo | undefined;
      if (options.debug && reviewSummary.debug) {
        debugInfo = {
          provider: reviewSummary.debug.provider,
          model: reviewSummary.debug.model,
          processingTime: reviewSummary.debug.processingTime,
          parallelExecution: options.checks.length > 1,
          checksExecuted: options.checks,
          totalApiCalls: reviewSummary.debug.totalApiCalls || options.checks.length,
          apiCallDetails: reviewSummary.debug.apiCallDetails,
        };
      }

      return {
        repositoryInfo,
        reviewSummary,
        executionTime,
        timestamp,
        checksExecuted: options.checks,
        debug: debugInfo,
      };
    } catch (error) {
      console.error('Error executing checks:', error);

      const fallbackRepositoryInfo: GitRepositoryInfo = {
        title: 'Error during analysis',
        body: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        author: 'system',
        base: 'main',
        head: 'HEAD',
        files: [],
        totalAdditions: 0,
        totalDeletions: 0,
        isGitRepository: false,
        workingDirectory: options.workingDirectory || process.cwd(),
      };

      return this.createErrorResult(
        fallbackRepositoryInfo,
        error instanceof Error ? error.message : 'Unknown error occurred',
        startTime,
        timestamp,
        options.checks
      );
    }
  }

  /**
   * Execute review checks using parallel execution for multiple AI checks
   */
  private async executeReviewChecks(
    prInfo: PRInfo,
    checks: string[],
    timeout?: number,
    config?: import('./types/config').VisorConfig,
    outputFormat?: string,
    debug?: boolean
  ): Promise<ReviewSummary> {
    // Determine where to send log messages based on output format
    const logFn = outputFormat === 'json' || outputFormat === 'sarif' ? console.error : console.log;

    logFn(`🔧 Debug: executeReviewChecks called with checks: ${JSON.stringify(checks)}`);
    logFn(`🔧 Debug: Config available: ${!!config}, Config has checks: ${!!config?.checks}`);

    // If we have a config with individual check definitions, use parallel execution
    if (config?.checks && checks.length > 1) {
      logFn(`🔧 Debug: Using parallel execution for ${checks.length} checks`);
      return await this.executeParallelChecks(prInfo, checks, timeout, config, logFn, debug);
    }

    // Single check execution (existing logic)
    if (checks.length === 1) {
      logFn(`🔧 Debug: Using single check execution for: ${checks[0]}`);

      // If we have a config definition for this check, use it
      if (config?.checks?.[checks[0]]) {
        return await this.executeSingleConfiguredCheck(prInfo, checks[0], timeout, config, logFn);
      }

      // Try provider system for single checks
      if (this.providerRegistry.hasProvider(checks[0])) {
        const provider = this.providerRegistry.getProviderOrThrow(checks[0]);
        const providerConfig: CheckProviderConfig = {
          type: checks[0],
          prompt: 'all',
          ai: timeout ? { timeout } : undefined,
        };
        return await provider.execute(prInfo, providerConfig);
      }
    }

    // Check if 'ai' provider is available for focus-based checks (legacy support)
    if (this.providerRegistry.hasProvider('ai')) {
      logFn(`🔧 Debug: Using AI provider with focus mapping`);
      const provider = this.providerRegistry.getProviderOrThrow('ai');

      let focus = 'all';
      if (checks.length === 1) {
        if (checks[0] === 'security' || checks[0] === 'performance' || checks[0] === 'style') {
          focus = checks[0];
        }
      } else {
        // For multiple checks, combine them into 'all' focus
        focus = 'all';
      }

      const providerConfig: CheckProviderConfig = {
        type: 'ai',
        prompt: focus,
        focus: focus,
        ai: timeout ? { timeout } : undefined,
      };

      return await provider.execute(prInfo, providerConfig);
    }

    // Fallback to existing PRReviewer for backward compatibility
    logFn(`🔧 Debug: Using legacy PRReviewer fallback`);
    const focusMap: Record<string, ReviewOptions['focus']> = {
      security: 'security',
      performance: 'performance',
      style: 'style',
      all: 'all',
      architecture: 'all',
    };

    let focus: ReviewOptions['focus'] = 'all';
    if (checks.length === 1 && focusMap[checks[0]]) {
      focus = focusMap[checks[0]];
    }

    return await this.reviewer.reviewPR('local', 'repository', 0, prInfo, {
      focus,
      format: 'table',
    });
  }

  /**
   * Execute multiple checks in parallel using Promise.allSettled
   */
  private async executeParallelChecks(
    prInfo: PRInfo,
    checks: string[],
    timeout?: number,
    config?: import('./types/config').VisorConfig,
    logFn?: (message: string) => void,
    debug?: boolean
  ): Promise<ReviewSummary> {
    const log = logFn || console.error;
    log(`🔧 Debug: Starting parallel execution of ${checks.length} checks`);

    if (!config?.checks) {
      throw new Error('Config with check definitions required for parallel execution');
    }

    const provider = this.providerRegistry.getProviderOrThrow('ai');

    // Create individual check tasks
    const checkTasks = checks.map(async checkName => {
      const checkConfig = config.checks[checkName];
      if (!checkConfig) {
        log(`🔧 Debug: No config found for check: ${checkName}`);
        return {
          checkName,
          error: `No configuration found for check: ${checkName}`,
          result: null,
        };
      }

      try {
        console.error(
          `🔧 Debug: Starting check: ${checkName} with prompt type: ${typeof checkConfig.prompt}`
        );

        // Create provider config for this specific check
        console.error(`🔧 Debug: CheckExecutionEngine debug param = ${debug}`);
        const providerConfig: CheckProviderConfig = {
          type: 'ai',
          prompt: checkConfig.prompt,
          focus: this.mapCheckNameToFocus(checkName),
          ai: {
            timeout: timeout || 600000,
            debug: debug, // Pass debug flag to AI provider
            ...(checkConfig.ai || {}),
          },
        };

        const result = await provider.execute(prInfo, providerConfig);
        console.error(
          `🔧 Debug: Completed check: ${checkName}, issues found: ${result.issues.length}`
        );

        return {
          checkName,
          error: null,
          result,
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log(`🔧 Debug: Error in check ${checkName}: ${errorMessage}`);

        return {
          checkName,
          error: errorMessage,
          result: null,
        };
      }
    });

    // Execute all checks in parallel using Promise.allSettled
    log(`🔧 Debug: Executing ${checkTasks.length} checks in parallel`);
    const results = await Promise.allSettled(checkTasks);

    // Aggregate results from all checks
    return this.aggregateParallelResults(results, checks, debug);
  }

  /**
   * Execute a single configured check
   */
  private async executeSingleConfiguredCheck(
    prInfo: PRInfo,
    checkName: string,
    timeout?: number,
    config?: import('./types/config').VisorConfig,
    _logFn?: (message: string) => void
  ): Promise<ReviewSummary> {
    if (!config?.checks?.[checkName]) {
      throw new Error(`No configuration found for check: ${checkName}`);
    }

    const checkConfig = config.checks[checkName];
    const provider = this.providerRegistry.getProviderOrThrow('ai');

    const providerConfig: CheckProviderConfig = {
      type: 'ai',
      prompt: checkConfig.prompt,
      focus: this.mapCheckNameToFocus(checkName),
      ai: {
        timeout: timeout || 600000,
        ...(checkConfig.ai || {}),
      },
    };

    return await provider.execute(prInfo, providerConfig);
  }

  /**
   * Map check name to focus for AI provider
   */
  private mapCheckNameToFocus(checkName: string): string {
    const focusMap: Record<string, string> = {
      security: 'security',
      performance: 'performance',
      style: 'style',
      architecture: 'all', // architecture maps to 'all' focus
    };

    return focusMap[checkName] || 'all';
  }

  /**
   * Aggregate results from parallel check execution
   */
  private aggregateParallelResults(
    results: PromiseSettledResult<{
      checkName: string;
      error: string | null;
      result: ReviewSummary | null;
    }>[],
    checkNames: string[],
    debug?: boolean
  ): ReviewSummary {
    const aggregatedIssues: ReviewSummary['issues'] = [];
    const aggregatedSuggestions: string[] = [];
    const debugInfo: string[] = [];

    let successfulChecks = 0;
    let failedChecks = 0;

    results.forEach((result, index) => {
      const checkName = checkNames[index];

      if (result.status === 'fulfilled') {
        const checkResult = result.value;

        if (checkResult.error) {
          failedChecks++;
          const log = console.error;
          log(`🔧 Debug: Check ${checkName} failed: ${checkResult.error}`);
          debugInfo.push(`❌ Check "${checkName}" failed: ${checkResult.error}`);

          // Add error as an issue
          aggregatedIssues.push({
            file: 'system',
            line: 0,
            endLine: undefined,
            ruleId: `${checkName}/error`,
            message: `Check "${checkName}" failed: ${checkResult.error}`,
            severity: 'error',
            category: 'logic',
            suggestion: undefined,
            replacement: undefined,
          });
        } else if (checkResult.result) {
          successfulChecks++;
          console.error(
            `🔧 Debug: Check ${checkName} succeeded with ${checkResult.result.issues.length} issues`
          );
          debugInfo.push(
            `✅ Check "${checkName}" completed: ${checkResult.result.issues.length} issues found`
          );

          // Prefix issues with check name for identification
          const prefixedIssues = checkResult.result.issues.map(issue => ({
            ...issue,
            ruleId: `${checkName}/${issue.ruleId}`,
          }));

          aggregatedIssues.push(...prefixedIssues);

          // Add suggestions with check name prefix
          const prefixedSuggestions = checkResult.result.suggestions.map(
            suggestion => `[${checkName}] ${suggestion}`
          );
          aggregatedSuggestions.push(...prefixedSuggestions);
        }
      } else {
        failedChecks++;
        const errorMessage =
          result.reason instanceof Error ? result.reason.message : String(result.reason);
        const log = console.error;
        log(`🔧 Debug: Check ${checkName} promise rejected: ${errorMessage}`);
        debugInfo.push(`❌ Check "${checkName}" promise rejected: ${errorMessage}`);

        aggregatedIssues.push({
          file: 'system',
          line: 0,
          endLine: undefined,
          ruleId: `${checkName}/promise-error`,
          message: `Check "${checkName}" execution failed: ${errorMessage}`,
          severity: 'error',
          category: 'logic',
          suggestion: undefined,
          replacement: undefined,
        });
      }
    });

    // Add summary information
    debugInfo.unshift(
      `🔍 Parallel execution completed: ${successfulChecks} successful, ${failedChecks} failed`
    );
    aggregatedSuggestions.unshift(...debugInfo);

    console.error(
      `🔧 Debug: Aggregated ${aggregatedIssues.length} issues from ${results.length} checks`
    );

    // Collect debug information when debug mode is enabled
    let aggregatedDebug: import('./ai-review-service').AIDebugInfo | undefined;
    if (debug) {
      // Find the first successful result with debug information to use as template
      const debugResults = results
        .map((result, index) => ({
          result,
          checkName: checkNames[index],
        }))
        .filter(({ result }) => result.status === 'fulfilled' && result.value?.result?.debug);

      if (debugResults.length > 0) {
        const firstResult = debugResults[0].result;
        if (firstResult.status === 'fulfilled') {
          const firstDebug = firstResult.value!.result!.debug!;
          const totalProcessingTime = debugResults.reduce((sum, { result }) => {
            if (result.status === 'fulfilled') {
              return sum + (result.value!.result!.debug!.processingTime || 0);
            }
            return sum;
          }, 0);

          aggregatedDebug = {
            // Use first result as template for provider/model info
            provider: firstDebug.provider,
            model: firstDebug.model,
            apiKeySource: firstDebug.apiKeySource,
            // Aggregate processing time from all checks
            processingTime: totalProcessingTime,
            // Combine prompts with check names
            prompt: debugResults
              .map(({ checkName, result }) => {
                if (result.status === 'fulfilled') {
                  return `[${checkName}] ${result.value!.result!.debug!.prompt.substring(0, 200)}...`;
                }
                return `[${checkName}] Error: Promise was rejected`;
              })
              .join('\n\n'),
            // Combine responses
            rawResponse: debugResults
              .map(({ checkName, result }) => {
                if (result.status === 'fulfilled') {
                  return `[${checkName}] ${result.value!.result!.debug!.rawResponse.substring(0, 500)}...`;
                }
                return `[${checkName}] Error: Promise was rejected`;
              })
              .join('\n\n'),
            promptLength: debugResults.reduce((sum, { result }) => {
              if (result.status === 'fulfilled') {
                return sum + (result.value!.result!.debug!.promptLength || 0);
              }
              return sum;
            }, 0),
            responseLength: debugResults.reduce((sum, { result }) => {
              if (result.status === 'fulfilled') {
                return sum + (result.value!.result!.debug!.responseLength || 0);
              }
              return sum;
            }, 0),
            jsonParseSuccess: debugResults.every(({ result }) => {
              if (result.status === 'fulfilled') {
                return result.value!.result!.debug!.jsonParseSuccess;
              }
              return false;
            }),
            errors: debugResults.flatMap(({ result, checkName }) => {
              if (result.status === 'fulfilled') {
                return (result.value!.result!.debug!.errors || []).map(
                  (error: string) => `[${checkName}] ${error}`
                );
              }
              return [`[${checkName}] Promise was rejected`];
            }),
            timestamp: new Date().toISOString(),
            // Add additional debug information for parallel execution
            totalApiCalls: debugResults.length,
            apiCallDetails: debugResults.map(({ checkName, result }) => {
              if (result.status === 'fulfilled') {
                return {
                  checkName,
                  provider: result.value!.result!.debug!.provider,
                  model: result.value!.result!.debug!.model,
                  processingTime: result.value!.result!.debug!.processingTime,
                  success: result.value!.result!.debug!.jsonParseSuccess,
                };
              }
              return {
                checkName,
                provider: 'unknown',
                model: 'unknown',
                processingTime: 0,
                success: false,
              };
            }),
          };
        }
      }
    }

    return {
      issues: aggregatedIssues,
      suggestions: aggregatedSuggestions,
      debug: aggregatedDebug,
    };
  }

  /**
   * Get available check types
   */
  static getAvailableCheckTypes(): string[] {
    const registry = CheckProviderRegistry.getInstance();
    const providerTypes = registry.getAvailableProviders();
    // Add standard focus-based checks
    const standardTypes = ['security', 'performance', 'style', 'architecture', 'all'];
    // Combine provider types with standard types (remove duplicates)
    return [...new Set([...providerTypes, ...standardTypes])];
  }

  /**
   * Validate check types
   */
  static validateCheckTypes(checks: string[]): { valid: string[]; invalid: string[] } {
    const availableChecks = CheckExecutionEngine.getAvailableCheckTypes();
    const valid: string[] = [];
    const invalid: string[] = [];

    for (const check of checks) {
      if (availableChecks.includes(check)) {
        valid.push(check);
      } else {
        invalid.push(check);
      }
    }

    return { valid, invalid };
  }

  /**
   * List available providers with their status
   */
  async listProviders(): Promise<
    Array<{
      name: string;
      description: string;
      available: boolean;
      requirements: string[];
    }>
  > {
    return await this.providerRegistry.listProviders();
  }

  /**
   * Create a mock Octokit instance for local analysis
   */
  private createMockOctokit(): MockOctokit {
    // Create simple mock functions that return promises
    const mockGet = async () => ({
      data: {
        number: 0,
        title: 'Local Analysis',
        body: 'Local repository analysis',
        user: { login: 'local-user' },
        base: { ref: 'main' },
        head: { ref: 'HEAD' },
      },
    });

    const mockListFiles = async () => ({
      data: [],
    });

    const mockListComments = async () => ({
      data: [],
    });

    const mockCreateComment = async () => ({
      data: { id: 1 },
    });

    return {
      rest: {
        pulls: {
          get: mockGet,
          listFiles: mockListFiles,
        },
        issues: {
          listComments: mockListComments,
          createComment: mockCreateComment,
        },
      },
      request: async () => ({ data: {} }),
      graphql: async () => ({}),
      log: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      hook: {
        before: () => {},
        after: () => {},
        error: () => {},
        wrap: () => {},
      },
      auth: async () => ({ token: 'mock-token' }),
    };
  }

  /**
   * Create an error result
   */
  private createErrorResult(
    repositoryInfo: GitRepositoryInfo,
    errorMessage: string,
    startTime: number,
    timestamp: string,
    checksExecuted: string[]
  ): AnalysisResult {
    const executionTime = Date.now() - startTime;

    return {
      repositoryInfo,
      reviewSummary: {
        issues: [
          {
            file: 'system',
            line: 0,
            endLine: undefined,
            ruleId: 'system/error',
            message: errorMessage,
            severity: 'error',
            category: 'logic',
            suggestion: undefined,
            replacement: undefined,
          },
        ],
        suggestions: [`Error: ${errorMessage}`],
      },
      executionTime,
      timestamp,
      checksExecuted,
    };
  }

  /**
   * Check if the working directory is a valid git repository
   */
  async isGitRepository(): Promise<boolean> {
    try {
      const repositoryInfo = await this.gitAnalyzer.analyzeRepository();
      return repositoryInfo.isGitRepository;
    } catch {
      return false;
    }
  }

  /**
   * Get repository status summary
   */
  async getRepositoryStatus(): Promise<{
    isGitRepository: boolean;
    hasChanges: boolean;
    branch: string;
    filesChanged: number;
  }> {
    try {
      const repositoryInfo = await this.gitAnalyzer.analyzeRepository();
      return {
        isGitRepository: repositoryInfo.isGitRepository,
        hasChanges: repositoryInfo.files.length > 0,
        branch: repositoryInfo.head,
        filesChanged: repositoryInfo.files.length,
      };
    } catch {
      return {
        isGitRepository: false,
        hasChanges: false,
        branch: 'unknown',
        filesChanged: 0,
      };
    }
  }
}
