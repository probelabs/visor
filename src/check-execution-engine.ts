import {
  PRReviewer,
  ReviewSummary,
  ReviewOptions,
  GroupedCheckResults,
  CheckResult,
} from './reviewer';
import { GitRepositoryAnalyzer, GitRepositoryInfo } from './git-repository-analyzer';
import { AnalysisResult } from './output-formatters';
import { PRInfo } from './pr-analyzer';
import { CheckProviderRegistry } from './providers/check-provider-registry';
import { CheckProviderConfig } from './providers/check-provider.interface';
import { DependencyResolver, DependencyGraph } from './dependency-resolver';
import { FailureConditionEvaluator } from './failure-condition-evaluator';
import { FailureConditionResult, CheckConfig } from './types/config';
import { GitHubCheckService, CheckRunOptions } from './github-check-service';
import { IssueFilter } from './issue-filter';

/**
 * Filter environment variables to only include safe ones for sandbox evaluation
 */
function getSafeEnvironmentVariables(): Record<string, string> {
  const safeEnvVars = [
    'CI',
    'GITHUB_EVENT_NAME',
    'GITHUB_REPOSITORY',
    'GITHUB_REF',
    'GITHUB_SHA',
    'GITHUB_HEAD_REF',
    'GITHUB_BASE_REF',
    'GITHUB_ACTOR',
    'GITHUB_WORKFLOW',
    'GITHUB_RUN_ID',
    'GITHUB_RUN_NUMBER',
    'NODE_ENV',
  ];

  const safeEnv: Record<string, string> = {};

  for (const key of safeEnvVars) {
    if (process.env[key]) {
      safeEnv[key] = process.env[key];
    }
  }

  return safeEnv;
}

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
  maxParallelism?: number; // Maximum number of checks to run in parallel (default: 3)
  failFast?: boolean; // Stop execution when any check fails (default: false)
  outputFormat?: string;
  config?: import('./types/config').VisorConfig;
  debug?: boolean; // Enable debug mode to collect AI execution details
  // Tag filter for selective check execution
  tagFilter?: import('./types/config').TagFilter;
  // Webhook context for passing webhook data to http_input providers
  webhookContext?: {
    webhookData: Map<string, unknown>;
  };
  // GitHub Check integration options
  githubChecks?: {
    enabled: boolean;
    octokit?: import('@octokit/rest').Octokit;
    owner?: string;
    repo?: string;
    headSha?: string;
    prNumber?: number;
  };
}

export class CheckExecutionEngine {
  private gitAnalyzer: GitRepositoryAnalyzer;
  private mockOctokit: MockOctokit;
  private reviewer: PRReviewer;
  private providerRegistry: CheckProviderRegistry;
  private failureEvaluator: FailureConditionEvaluator;
  private githubCheckService?: GitHubCheckService;
  private checkRunMap?: Map<string, { id: number; url: string }>;
  private githubContext?: { owner: string; repo: string };
  private workingDirectory: string;
  private config?: import('./types/config').VisorConfig;
  private webhookContext?: { webhookData: Map<string, unknown> };

  constructor(workingDirectory?: string) {
    this.workingDirectory = workingDirectory || process.cwd();
    this.gitAnalyzer = new GitRepositoryAnalyzer(this.workingDirectory);
    this.providerRegistry = CheckProviderRegistry.getInstance();
    this.failureEvaluator = new FailureConditionEvaluator();

    // Create a mock Octokit instance for local analysis
    // This allows us to reuse the existing PRReviewer logic without network calls
    this.mockOctokit = this.createMockOctokit();
    this.reviewer = new PRReviewer(this.mockOctokit as unknown as import('@octokit/rest').Octokit);
  }

  /**
   * Set webhook context on a provider if it supports it
   */
  private setProviderWebhookContext(
    provider: import('./providers/check-provider.interface').CheckProvider
  ): void {
    if (this.webhookContext && provider.setWebhookContext) {
      provider.setWebhookContext(this.webhookContext.webhookData);
    }
  }

  /**
   * Filter checks based on tag filter configuration
   */
  private filterChecksByTags(
    checks: string[],
    config: import('./types/config').VisorConfig | undefined,
    tagFilter: import('./types/config').TagFilter | undefined
  ): string[] {
    if (!tagFilter || (!tagFilter.include && !tagFilter.exclude)) {
      return checks;
    }

    const logFn = this.config?.output?.pr_comment ? console.error : console.log;

    return checks.filter(checkName => {
      const checkConfig = config?.checks?.[checkName];
      if (!checkConfig) {
        // If no config for this check, include it by default
        return true;
      }

      const checkTags = checkConfig.tags || [];

      // Check exclude tags first (if any exclude tag matches, skip the check)
      if (tagFilter.exclude && tagFilter.exclude.length > 0) {
        const hasExcludedTag = tagFilter.exclude.some(tag => checkTags.includes(tag));
        if (hasExcludedTag) {
          logFn(`⏭️ Skipping check '${checkName}' - has excluded tag`);
          return false;
        }
      }

      // Check include tags (if specified, at least one must match)
      if (tagFilter.include && tagFilter.include.length > 0) {
        const hasIncludedTag = tagFilter.include.some(tag => checkTags.includes(tag));
        if (!hasIncludedTag) {
          logFn(`⏭️ Skipping check '${checkName}' - does not have required tags`);
          return false;
        }
      }

      return true;
    });
  }

  /**
   * Execute checks on the local repository
   */
  async executeChecks(options: CheckExecutionOptions): Promise<AnalysisResult> {
    const startTime = Date.now();
    const timestamp = new Date().toISOString();

    try {
      // Store webhook context if provided
      this.webhookContext = options.webhookContext;

      // Determine where to send log messages based on output format
      const logFn =
        options.outputFormat === 'json' || options.outputFormat === 'sarif'
          ? console.error
          : console.log;

      // Initialize GitHub checks if enabled
      if (options.githubChecks?.enabled && options.githubChecks.octokit) {
        await this.initializeGitHubChecks(options, logFn);
      }

      // Analyze the repository
      logFn('🔍 Analyzing local git repository...');
      const repositoryInfo = await this.gitAnalyzer.analyzeRepository();

      if (!repositoryInfo.isGitRepository) {
        // Complete GitHub checks with error if they were initialized
        if (this.checkRunMap) {
          await this.completeGitHubChecksWithError('Not a git repository or no changes found');
        }

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

      // Apply tag filtering if specified
      const filteredChecks = this.filterChecksByTags(
        options.checks,
        options.config,
        options.tagFilter || options.config?.tag_filter
      );

      if (filteredChecks.length === 0) {
        logFn('⚠️ No checks match the tag filter criteria');
        // Complete GitHub checks with no checks message if they were initialized
        if (this.checkRunMap) {
          await this.completeGitHubChecksWithError('No checks match the tag filter criteria');
        }
        return this.createErrorResult(
          repositoryInfo,
          'No checks match the tag filter criteria',
          startTime,
          timestamp,
          options.checks
        );
      }

      // Update GitHub checks to in-progress status
      if (this.checkRunMap) {
        await this.updateGitHubChecksInProgress(options);
      }

      // Execute checks using the existing PRReviewer
      logFn(`🤖 Executing checks: ${filteredChecks.join(', ')}`);
      const reviewSummary = await this.executeReviewChecks(
        prInfo,
        filteredChecks,
        options.timeout,
        options.config,
        options.outputFormat,
        options.debug,
        options.maxParallelism,
        options.failFast
      );

      // Complete GitHub checks with results
      if (this.checkRunMap) {
        await this.completeGitHubChecksWithResults(reviewSummary, options);
      }

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
        checksExecuted: filteredChecks,
        debug: debugInfo,
      };
    } catch (error) {
      console.error('Error executing checks:', error);

      // Complete GitHub checks with error if they were initialized
      if (this.checkRunMap) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
        await this.completeGitHubChecksWithError(errorMessage);
      }

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
   * Execute tasks with controlled parallelism using a pool pattern
   */
  private async executeWithLimitedParallelism<T>(
    tasks: (() => Promise<T>)[],
    maxParallelism: number,
    failFast?: boolean
  ): Promise<PromiseSettledResult<T>[]> {
    if (maxParallelism <= 0) {
      throw new Error('Max parallelism must be greater than 0');
    }

    if (tasks.length === 0) {
      return [];
    }

    const results: PromiseSettledResult<T>[] = new Array(tasks.length);
    let currentIndex = 0;
    let shouldStop = false;

    // Worker function that processes tasks
    const worker = async (): Promise<void> => {
      while (currentIndex < tasks.length && !shouldStop) {
        const taskIndex = currentIndex++;
        if (taskIndex >= tasks.length) break;

        try {
          const result = await tasks[taskIndex]();
          results[taskIndex] = { status: 'fulfilled', value: result };

          // Check if we should stop due to fail-fast
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          if (failFast && this.shouldFailFast(result as any)) {
            shouldStop = true;
            break;
          }
        } catch (error) {
          results[taskIndex] = { status: 'rejected', reason: error };

          // If fail-fast is enabled and we have an error, stop execution
          if (failFast) {
            shouldStop = true;
            break;
          }
        }
      }
    };

    // Create workers up to the parallelism limit
    const workers: Promise<void>[] = [];
    const workerCount = Math.min(maxParallelism, tasks.length);

    for (let i = 0; i < workerCount; i++) {
      workers.push(worker());
    }

    // Wait for all workers to complete
    await Promise.all(workers);

    return results;
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
    debug?: boolean,
    maxParallelism?: number,
    failFast?: boolean
  ): Promise<ReviewSummary> {
    // Store config for use in filtering
    this.config = config;

    // Determine where to send log messages based on output format
    const logFn = outputFormat === 'json' || outputFormat === 'sarif' ? console.error : console.log;

    // Only output debug messages if debug mode is enabled
    if (debug) {
      logFn(`🔧 Debug: executeReviewChecks called with checks: ${JSON.stringify(checks)}`);
      logFn(`🔧 Debug: Config available: ${!!config}, Config has checks: ${!!config?.checks}`);
    }

    // Filter checks based on current event type to prevent execution of checks that shouldn't run
    const filteredChecks = this.filterChecksByEvent(checks, config, prInfo, logFn, debug);
    if (filteredChecks.length !== checks.length && debug) {
      logFn(
        `🔧 Debug: Event filtering reduced checks from ${checks.length} to ${filteredChecks.length}: ${JSON.stringify(filteredChecks)}`
      );
    }

    // Use filtered checks for execution
    checks = filteredChecks;

    // If we have a config with individual check definitions, use dependency-aware execution
    // Check if any of the checks have dependencies or if there are multiple checks
    const hasDependencies =
      config?.checks &&
      checks.some(checkName => {
        const checkConfig = config.checks[checkName];
        return checkConfig?.depends_on && checkConfig.depends_on.length > 0;
      });

    if (config?.checks && (checks.length > 1 || hasDependencies)) {
      if (debug) {
        logFn(
          `🔧 Debug: Using dependency-aware execution for ${checks.length} checks (has dependencies: ${hasDependencies})`
        );
      }
      return await this.executeDependencyAwareChecks(
        prInfo,
        checks,
        timeout,
        config,
        logFn,
        debug,
        maxParallelism,
        failFast
      );
    }

    // Single check execution (existing logic)
    if (checks.length === 1) {
      if (debug) {
        logFn(`🔧 Debug: Using single check execution for: ${checks[0]}`);
      }

      // If we have a config definition for this check, use it
      if (config?.checks?.[checks[0]]) {
        return await this.executeSingleConfiguredCheck(prInfo, checks[0], timeout, config, logFn);
      }

      // Try provider system for single checks
      if (this.providerRegistry.hasProvider(checks[0])) {
        const provider = this.providerRegistry.getProviderOrThrow(checks[0]);
        this.setProviderWebhookContext(provider);
        const providerConfig: CheckProviderConfig = {
          type: checks[0],
          prompt: 'all',
          eventContext: prInfo.eventContext, // Pass event context for templates
          ai: timeout ? { timeout } : undefined,
        };
        const result = await provider.execute(prInfo, providerConfig);

        // Prefix issues with check name for consistent grouping
        const prefixedIssues = (result.issues || []).map(issue => ({
          ...issue,
          ruleId: `${checks[0]}/${issue.ruleId}`,
        }));

        return {
          ...result,
          issues: prefixedIssues,
        };
      }
    }

    // Check if 'ai' provider is available for focus-based checks (legacy support)
    if (this.providerRegistry.hasProvider('ai')) {
      if (debug) {
        logFn(`🔧 Debug: Using AI provider with focus mapping`);
      }
      const provider = this.providerRegistry.getProviderOrThrow('ai');
      this.setProviderWebhookContext(provider);

      let focus = 'all';
      let checkName = 'all';
      if (checks.length === 1) {
        checkName = checks[0];
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
        eventContext: prInfo.eventContext, // Pass event context for templates
        ai: timeout ? { timeout } : undefined,
        // Inherit global AI provider and model settings if config is available
        ai_provider: config?.ai_provider,
        ai_model: config?.ai_model,
      };

      const result = await provider.execute(prInfo, providerConfig);

      // Prefix issues with check name for consistent grouping
      const prefixedIssues = (result.issues || []).map(issue => ({
        ...issue,
        ruleId: `${checkName}/${issue.ruleId}`,
      }));

      return {
        ...result,
        issues: prefixedIssues,
      };
    }

    // Fallback to existing PRReviewer for backward compatibility
    if (debug) {
      logFn(`🔧 Debug: Using legacy PRReviewer fallback`);
    }
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
   * Execute review checks and return grouped results for new architecture
   */
  public async executeGroupedChecks(
    prInfo: PRInfo,
    checks: string[],
    timeout?: number,
    config?: import('./types/config').VisorConfig,
    outputFormat?: string,
    debug?: boolean,
    maxParallelism?: number,
    failFast?: boolean,
    tagFilter?: import('./types/config').TagFilter
  ): Promise<GroupedCheckResults> {
    // Determine where to send log messages based on output format
    const logFn = outputFormat === 'json' || outputFormat === 'sarif' ? console.error : console.log;

    // Only output debug messages if debug mode is enabled
    if (debug) {
      logFn(`🔧 Debug: executeGroupedChecks called with checks: ${JSON.stringify(checks)}`);
      logFn(`🔧 Debug: Config available: ${!!config}, Config has checks: ${!!config?.checks}`);
    }

    // Filter checks based on current event type to prevent execution of checks that shouldn't run
    const filteredChecks = this.filterChecksByEvent(checks, config, prInfo, logFn, debug);
    if (filteredChecks.length !== checks.length && debug) {
      logFn(
        `🔧 Debug: Event filtering reduced checks from ${checks.length} to ${filteredChecks.length}: ${JSON.stringify(filteredChecks)}`
      );
    }

    // Apply tag filtering if specified
    const tagFilteredChecks = this.filterChecksByTags(
      filteredChecks,
      config,
      tagFilter || config?.tag_filter
    );

    if (tagFilteredChecks.length !== filteredChecks.length && debug) {
      logFn(
        `🔧 Debug: Tag filtering reduced checks from ${filteredChecks.length} to ${tagFilteredChecks.length}: ${JSON.stringify(tagFilteredChecks)}`
      );
    }

    // Use filtered checks for execution
    checks = tagFilteredChecks;

    // Check if we have any checks left after filtering
    if (checks.length === 0) {
      logFn('⚠️ No checks remain after tag filtering');
      return {};
    }

    if (!config?.checks) {
      throw new Error('Config with check definitions required for grouped execution');
    }

    // If we have a config with individual check definitions, use dependency-aware execution
    const hasDependencies = checks.some(checkName => {
      const checkConfig = config.checks[checkName];
      return checkConfig?.depends_on && checkConfig.depends_on.length > 0;
    });

    if (checks.length > 1 || hasDependencies) {
      if (debug) {
        logFn(
          `🔧 Debug: Using grouped dependency-aware execution for ${checks.length} checks (has dependencies: ${hasDependencies})`
        );
      }
      return await this.executeGroupedDependencyAwareChecks(
        prInfo,
        checks,
        timeout,
        config,
        logFn,
        debug,
        maxParallelism,
        failFast
      );
    }

    // Single check execution
    if (checks.length === 1) {
      if (debug) {
        logFn(`🔧 Debug: Using grouped single check execution for: ${checks[0]}`);
      }
      const checkResult = await this.executeSingleGroupedCheck(
        prInfo,
        checks[0],
        timeout,
        config,
        logFn,
        debug
      );

      const groupedResults: GroupedCheckResults = {};
      groupedResults[checkResult.group] = [checkResult];
      return groupedResults;
    }

    // No checks to execute
    return {};
  }

  /**
   * Execute single check and return grouped result
   */
  private async executeSingleGroupedCheck(
    prInfo: PRInfo,
    checkName: string,
    timeout?: number,
    config?: import('./types/config').VisorConfig,
    logFn?: (message: string) => void,
    debug?: boolean
  ): Promise<CheckResult> {
    if (!config?.checks?.[checkName]) {
      throw new Error(`No configuration found for check: ${checkName}`);
    }

    const checkConfig = config.checks[checkName];
    const providerType = checkConfig.type || 'ai';
    const provider = this.providerRegistry.getProviderOrThrow(providerType);
    this.setProviderWebhookContext(provider);

    const providerConfig: CheckProviderConfig = {
      type: providerType,
      prompt: checkConfig.prompt,
      focus: checkConfig.focus || this.mapCheckNameToFocus(checkName),
      schema: checkConfig.schema,
      group: checkConfig.group,
      eventContext: prInfo.eventContext, // Pass event context for templates
      ai: {
        timeout: timeout || 600000,
        debug: debug,
        ...(checkConfig.ai || {}),
      },
      ai_provider: checkConfig.ai_provider || config.ai_provider,
      ai_model: checkConfig.ai_model || config.ai_model,
      // Pass claude_code config if present
      claude_code: checkConfig.claude_code,
      // Pass any provider-specific config
      ...checkConfig,
    };

    const result = await provider.execute(prInfo, providerConfig);

    // Render the check content using the appropriate template
    const content = await this.renderCheckContent(checkName, result, checkConfig, prInfo);

    return {
      checkName,
      content,
      group: checkConfig.group || 'default',
      debug: result.debug,
      issues: result.issues, // Include structured issues
    };
  }

  /**
   * Execute multiple checks with dependency awareness - return grouped results
   */
  private async executeGroupedDependencyAwareChecks(
    prInfo: PRInfo,
    checks: string[],
    timeout?: number,
    config?: import('./types/config').VisorConfig,
    logFn?: (message: string) => void,
    debug?: boolean,
    maxParallelism?: number,
    failFast?: boolean
  ): Promise<GroupedCheckResults> {
    // Use the existing dependency-aware execution logic
    const reviewSummary = await this.executeDependencyAwareChecks(
      prInfo,
      checks,
      timeout,
      config,
      logFn,
      debug,
      maxParallelism,
      failFast
    );

    // Convert the flat ReviewSummary to grouped CheckResults
    return await this.convertReviewSummaryToGroupedResults(reviewSummary, checks, config, prInfo);
  }

  /**
   * Convert ReviewSummary to GroupedCheckResults
   */
  private async convertReviewSummaryToGroupedResults(
    reviewSummary: ReviewSummary,
    checks: string[],
    config?: import('./types/config').VisorConfig,
    prInfo?: PRInfo
  ): Promise<GroupedCheckResults> {
    const groupedResults: GroupedCheckResults = {};

    // Process each check individually
    for (const checkName of checks) {
      const checkConfig = config?.checks?.[checkName];
      if (!checkConfig) continue;

      // Extract issues for this check
      const checkIssues = (reviewSummary.issues || []).filter(issue =>
        issue.ruleId?.startsWith(`${checkName}/`)
      );

      // Create a mini ReviewSummary for this check
      const checkSummary: ReviewSummary = {
        issues: checkIssues,
        debug: reviewSummary.debug,
      };

      // Render content for this check
      const content = await this.renderCheckContent(checkName, checkSummary, checkConfig, prInfo);

      const checkResult: CheckResult = {
        checkName,
        content,
        group: checkConfig.group || 'default',
        debug: reviewSummary.debug,
        issues: checkIssues, // Include structured issues
      };

      // Add to appropriate group
      const group = checkResult.group;
      if (!groupedResults[group]) {
        groupedResults[group] = [];
      }
      groupedResults[group].push(checkResult);
    }

    return groupedResults;
  }

  /**
   * Validates that a file path is safe and within the project directory
   * Prevents path traversal attacks by:
   * - Blocking absolute paths
   * - Blocking paths with ".." segments
   * - Ensuring resolved path is within project directory
   * - Blocking special characters and null bytes
   * - Enforcing .liquid file extension
   */
  private async validateTemplatePath(templatePath: string): Promise<string> {
    const path = await import('path');

    // Validate input
    if (!templatePath || typeof templatePath !== 'string' || templatePath.trim() === '') {
      throw new Error('Template path must be a non-empty string');
    }

    // Block null bytes and other dangerous characters
    if (templatePath.includes('\0') || templatePath.includes('\x00')) {
      throw new Error('Template path contains invalid characters');
    }

    // Enforce .liquid file extension
    if (!templatePath.endsWith('.liquid')) {
      throw new Error('Template file must have .liquid extension');
    }

    // Block absolute paths
    if (path.isAbsolute(templatePath)) {
      throw new Error('Template path must be relative to project directory');
    }

    // Block paths with ".." segments
    if (templatePath.includes('..')) {
      throw new Error('Template path cannot contain ".." segments');
    }

    // Block paths starting with ~ (home directory)
    if (templatePath.startsWith('~')) {
      throw new Error('Template path cannot reference home directory');
    }

    // Get the project root directory from git analyzer
    const repositoryInfo = await this.gitAnalyzer.analyzeRepository();
    const projectRoot = repositoryInfo.workingDirectory;

    // Validate project root
    if (!projectRoot || typeof projectRoot !== 'string') {
      throw new Error('Unable to determine project root directory');
    }

    // Resolve the template path relative to project root
    const resolvedPath = path.resolve(projectRoot, templatePath);
    const resolvedProjectRoot = path.resolve(projectRoot);

    // Validate resolved paths
    if (
      !resolvedPath ||
      !resolvedProjectRoot ||
      resolvedPath === '' ||
      resolvedProjectRoot === ''
    ) {
      throw new Error(
        `Unable to resolve template path: projectRoot="${projectRoot}", templatePath="${templatePath}", resolvedPath="${resolvedPath}", resolvedProjectRoot="${resolvedProjectRoot}"`
      );
    }

    // Ensure the resolved path is still within the project directory
    if (
      !resolvedPath.startsWith(resolvedProjectRoot + path.sep) &&
      resolvedPath !== resolvedProjectRoot
    ) {
      throw new Error('Template path escapes project directory');
    }

    return resolvedPath;
  }

  /**
   * Render check content using the appropriate template
   */
  private async renderCheckContent(
    checkName: string,
    reviewSummary: ReviewSummary,
    checkConfig: CheckConfig,
    _prInfo?: PRInfo
  ): Promise<string> {
    // Import the liquid template system
    const { Liquid } = await import('liquidjs');
    const fs = await import('fs/promises');
    const path = await import('path');

    const liquid = new Liquid({
      trimTagLeft: false,
      trimTagRight: false,
      trimOutputLeft: false,
      trimOutputRight: false,
      greedy: false,
    });

    // Determine template to use
    // If schema is an object (inline JSON schema), use 'plain' rendering
    const schemaName =
      typeof checkConfig.schema === 'object' ? 'plain' : checkConfig.schema || 'plain';
    let templateContent: string;

    if (checkConfig.template) {
      // Custom template
      if (checkConfig.template.content) {
        templateContent = checkConfig.template.content;
      } else if (checkConfig.template.file) {
        // Validate the template file path to prevent path traversal attacks
        const validatedPath = await this.validateTemplatePath(checkConfig.template.file);
        templateContent = await fs.readFile(validatedPath, 'utf-8');
      } else {
        throw new Error('Custom template must specify either "file" or "content"');
      }
    } else if (schemaName === 'plain') {
      // Plain schema - return raw content directly
      return reviewSummary.issues?.[0]?.message || '';
    } else {
      // Use built-in schema template
      const sanitizedSchema = schemaName.replace(/[^a-zA-Z0-9-]/g, '');
      if (!sanitizedSchema) {
        throw new Error('Invalid schema name');
      }
      const templatePath = path.join(__dirname, `../output/${sanitizedSchema}/template.liquid`);
      templateContent = await fs.readFile(templatePath, 'utf-8');
    }

    // Prepare template data
    const templateData = {
      issues: reviewSummary.issues || [],
      checkName: checkName,
    };

    const rendered = await liquid.parseAndRender(templateContent, templateData);
    return rendered.trim();
  }

  /**
   * Execute multiple checks with dependency awareness - intelligently parallel and sequential
   */
  private async executeDependencyAwareChecks(
    prInfo: PRInfo,
    checks: string[],
    timeout?: number,
    config?: import('./types/config').VisorConfig,
    logFn?: (message: string) => void,
    debug?: boolean,
    maxParallelism?: number,
    failFast?: boolean
  ): Promise<ReviewSummary> {
    const log = logFn || console.error;

    if (debug) {
      log(`🔧 Debug: Starting dependency-aware execution of ${checks.length} checks`);
    }

    if (!config?.checks) {
      throw new Error('Config with check definitions required for dependency-aware execution');
    }

    // Determine effective max parallelism (CLI > config > default)
    const effectiveMaxParallelism = maxParallelism ?? config.max_parallelism ?? 3;
    // Determine effective fail-fast setting (CLI > config > default)
    const effectiveFailFast = failFast ?? config.fail_fast ?? false;

    if (debug) {
      log(`🔧 Debug: Using max parallelism: ${effectiveMaxParallelism}`);
      log(`🔧 Debug: Using fail-fast: ${effectiveFailFast}`);
    }

    // Build dependency graph and check for session reuse requirements
    const dependencies: Record<string, string[]> = {};
    const sessionReuseChecks = new Set<string>();
    const sessionProviders = new Map<string, string>(); // checkName -> parent session provider

    for (const checkName of checks) {
      const checkConfig = config.checks[checkName];
      if (checkConfig) {
        dependencies[checkName] = checkConfig.depends_on || [];

        // Track checks that need session reuse
        if (checkConfig.reuse_ai_session === true) {
          sessionReuseChecks.add(checkName);

          // Find the parent check that will provide the session
          // For now, use the first dependency as the session provider
          if (checkConfig.depends_on && checkConfig.depends_on.length > 0) {
            sessionProviders.set(checkName, checkConfig.depends_on[0]);
          }
        }
      } else {
        dependencies[checkName] = [];
      }
    }

    if (sessionReuseChecks.size > 0 && debug) {
      log(
        `🔄 Debug: Found ${sessionReuseChecks.size} checks requiring session reuse: ${Array.from(sessionReuseChecks).join(', ')}`
      );
    }

    // Validate dependencies
    const validation = DependencyResolver.validateDependencies(checks, dependencies);
    if (!validation.valid) {
      return {
        issues: [
          {
            severity: 'error' as const,
            message: `Dependency validation failed: ${validation.errors.join(', ')}`,
            file: '',
            line: 0,
            ruleId: 'dependency-validation-error',
            category: 'logic' as const,
          },
        ],
      };
    }

    // Build dependency graph
    const dependencyGraph = DependencyResolver.buildDependencyGraph(dependencies);

    if (dependencyGraph.hasCycles) {
      return {
        issues: [
          {
            severity: 'error' as const,
            message: `Circular dependencies detected: ${dependencyGraph.cycleNodes?.join(' -> ')}`,
            file: '',
            line: 0,
            ruleId: 'circular-dependency-error',
            category: 'logic' as const,
          },
        ],
      };
    }

    // Log execution plan
    const stats = DependencyResolver.getExecutionStats(dependencyGraph);
    log(
      `🔧 Debug: Execution plan - ${stats.totalChecks} checks in ${stats.parallelLevels} levels, max parallelism: ${stats.maxParallelism}`
    );

    // Execute checks level by level
    const results = new Map<string, ReviewSummary>();
    const sessionRegistry = require('./session-registry').SessionRegistry.getInstance();
    // Note: We'll get the provider dynamically per check, not a single one for all
    const sessionIds = new Map<string, string>(); // checkName -> sessionId
    let shouldStopExecution = false;

    for (
      let levelIndex = 0;
      levelIndex < dependencyGraph.executionOrder.length && !shouldStopExecution;
      levelIndex++
    ) {
      const executionGroup = dependencyGraph.executionOrder[levelIndex];

      // Check if any checks in this level require session reuse - if so, force sequential execution
      const checksInLevel = executionGroup.parallel;
      const hasSessionReuseInLevel = checksInLevel.some(checkName =>
        sessionReuseChecks.has(checkName)
      );

      let actualParallelism = Math.min(effectiveMaxParallelism, executionGroup.parallel.length);
      if (hasSessionReuseInLevel) {
        // Force sequential execution when session reuse is involved
        actualParallelism = 1;
        log(
          `🔄 Debug: Level ${executionGroup.level} contains session reuse checks - forcing sequential execution (parallelism: 1)`
        );
      }

      log(
        `🔧 Debug: Executing level ${executionGroup.level} with ${executionGroup.parallel.length} checks (parallelism: ${actualParallelism})`
      );

      // Create task functions for checks in this level
      const levelTaskFunctions = executionGroup.parallel.map(checkName => async () => {
        const checkConfig = config.checks[checkName];
        if (!checkConfig) {
          return {
            checkName,
            error: `No configuration found for check: ${checkName}`,
            result: null,
          };
        }

        try {
          log(`🔧 Debug: Starting check: ${checkName} at level ${executionGroup.level}`);

          // Evaluate if condition to determine whether to run this check
          if (checkConfig.if) {
            const shouldRun = await this.failureEvaluator.evaluateIfCondition(
              checkName,
              checkConfig.if,
              {
                branch: prInfo.head,
                baseBranch: prInfo.base,
                filesChanged: prInfo.files.map(f => f.filename),
                event: 'issue_comment', // Command triggered from comment
                environment: getSafeEnvironmentVariables(),
                previousResults: results,
              }
            );

            if (!shouldRun) {
              log(`🔧 Debug: Skipping check '${checkName}' - if condition evaluated to false`);
              return {
                checkName,
                error: null,
                result: {
                  issues: [],
                },
              };
            }
          }

          // Get the appropriate provider for this check type
          const providerType = checkConfig.type || 'ai';
          const provider = this.providerRegistry.getProviderOrThrow(providerType);
          this.setProviderWebhookContext(provider);

          // Create provider config for this specific check
          const providerConfig: CheckProviderConfig = {
            type: providerType,
            prompt: checkConfig.prompt,
            exec: checkConfig.exec,
            focus: checkConfig.focus || this.mapCheckNameToFocus(checkName),
            schema: checkConfig.schema,
            group: checkConfig.group,
            checkName: checkName, // Add checkName for sessionID
            eventContext: prInfo.eventContext, // Pass event context for templates
            transform: checkConfig.transform,
            level: (checkConfig as any).level,
            message: (checkConfig as any).message,
            env: checkConfig.env,
            ai: {
              timeout: timeout || 600000,
              debug: debug,
              ...(checkConfig.ai || {}),
            },
          };

          // Pass results from dependencies if needed
          const dependencyResults = new Map<string, ReviewSummary>();
          let isForEachDependent = false;
          let forEachItems: any[] = [];
          let forEachParentName: string | undefined;

          for (const depId of checkConfig.depends_on || []) {
            if (results.has(depId)) {
              const depResult = results.get(depId)!;
              dependencyResults.set(depId, depResult);

              // Check if this dependency has forEach enabled
              if ((depResult as any).isForEach && (depResult as any).forEachItems) {
                isForEachDependent = true;
                forEachItems = (depResult as any).forEachItems;
                forEachParentName = depId;
              }
            }
          }

          // Determine if we should use session reuse
          let sessionInfo: { parentSessionId?: string; reuseSession?: boolean } | undefined =
            undefined;
          if (sessionReuseChecks.has(checkName)) {
            const parentCheckName = sessionProviders.get(checkName);
            if (parentCheckName && sessionIds.has(parentCheckName)) {
              const parentSessionId = sessionIds.get(parentCheckName)!;

              sessionInfo = {
                parentSessionId: parentSessionId,
                reuseSession: true,
              };

              log(
                `🔄 Debug: Check ${checkName} will reuse session from parent ${parentCheckName}: ${parentSessionId}`
              );
            } else {
              log(
                `⚠️ Warning: Check ${checkName} requires session reuse but parent ${parentCheckName} session not found`
              );
            }
          }

          // For checks that create new sessions, generate a session ID
          let currentSessionId: string | undefined = undefined;
          if (!sessionInfo?.reuseSession) {
            const timestamp = new Date().toISOString();
            currentSessionId = `visor-${timestamp.replace(/[:.]/g, '-')}-${checkName}`;
            sessionIds.set(checkName, currentSessionId);
            log(`🆕 Debug: Check ${checkName} will create new session: ${currentSessionId}`);

            // Add session ID to provider config
            providerConfig.sessionId = currentSessionId;
          }

          // Handle forEach dependent execution
          let finalResult: ReviewSummary;

          if (isForEachDependent && forEachParentName) {
            log(
              `🔄 Debug: Check "${checkName}" depends on forEach check "${forEachParentName}", executing ${forEachItems.length} times`
            );

            const allIssues: any[] = [];
            const allOutputs: any[] = [];

            // Execute check for each item in the forEach array
            for (let itemIndex = 0; itemIndex < forEachItems.length; itemIndex++) {
              const item = forEachItems[itemIndex];

              // Create modified dependency results with current item
              const forEachDependencyResults = new Map<string, ReviewSummary>();
              for (const [depName, depResult] of dependencyResults) {
                if (depName === forEachParentName) {
                  // Replace the entire forEach parent result with just the current item
                  // This ensures that outputs.fetch-tickets contains the individual item
                  const modifiedResult = item as any;
                  forEachDependencyResults.set(depName, modifiedResult);
                } else {
                  forEachDependencyResults.set(depName, depResult);
                }
              }

              log(
                `🔄 Debug: Executing check "${checkName}" for item ${itemIndex + 1}/${forEachItems.length}`
              );

              const itemResult = await provider.execute(
                prInfo,
                providerConfig,
                forEachDependencyResults,
                sessionInfo
              );

              // Collect issues from each iteration
              if (itemResult.issues) {
                allIssues.push(...itemResult.issues);
              }

              // Collect outputs from each iteration
              if ((itemResult as any).output) {
                allOutputs.push((itemResult as any).output);
              }
            }

            finalResult = {
              issues: allIssues,
              output: allOutputs.length > 0 ? allOutputs : undefined,
            } as any;

            log(
              `🔄 Debug: Completed forEach execution for check "${checkName}", total issues: ${allIssues.length}`
            );
          } else {
            // Normal single execution
            finalResult = await provider.execute(
              prInfo,
              providerConfig,
              dependencyResults,
              sessionInfo
            );
            log(
              `🔧 Debug: Completed check: ${checkName}, issues found: ${(finalResult.issues || []).length}`
            );
          }

          // Add group, schema, template info and timestamp to issues from config
          const enrichedIssues = (finalResult.issues || []).map(issue => ({
            ...issue,
            ruleId: `${checkName}/${issue.ruleId}`,
            group: checkConfig.group,
            schema: typeof checkConfig.schema === 'object' ? 'custom' : checkConfig.schema,
            template: checkConfig.template,
            timestamp: Date.now(),
          }));

          const enrichedResult = {
            ...finalResult,
            issues: enrichedIssues,
          };

          return {
            checkName,
            error: null,
            result: enrichedResult,
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

      // Execute checks in this level with controlled parallelism
      const levelResults = await this.executeWithLimitedParallelism(
        levelTaskFunctions,
        actualParallelism,
        effectiveFailFast
      );

      // Process results and store them for next level
      for (let i = 0; i < levelResults.length; i++) {
        const checkName = executionGroup.parallel[i];
        const result = levelResults[i];
        const checkConfig = config.checks[checkName];

        if (result.status === 'fulfilled' && result.value.result && !result.value.error) {
          const reviewResult = result.value.result;

          // Handle forEach logic - process array outputs
          if (checkConfig?.forEach && (reviewResult as any).output) {
            let outputArray = (reviewResult as any).output;

            // Ensure output is an array
            if (!Array.isArray(outputArray)) {
              // Try to parse as JSON if it's a string
              if (typeof outputArray === 'string') {
                try {
                  const parsed = JSON.parse(outputArray);
                  outputArray = Array.isArray(parsed) ? parsed : [parsed];
                } catch {
                  outputArray = [outputArray];
                }
              } else {
                outputArray = [outputArray];
              }
            }

            log(
              `🔄 Debug: Check "${checkName}" has forEach enabled, processing ${outputArray.length} items`
            );

            // Store the array for iteration by dependent checks
            (reviewResult as any).forEachItems = outputArray;
            (reviewResult as any).isForEach = true;
          }

          results.set(checkName, reviewResult);
        } else {
          // Store error result for dependency tracking
          const errorSummary: ReviewSummary = {
            issues: [
              {
                file: 'system',
                line: 0,
                endLine: undefined,
                ruleId: `${checkName}/error`,
                message:
                  result.status === 'fulfilled'
                    ? result.value.error || 'Unknown error'
                    : result.reason instanceof Error
                      ? result.reason.message
                      : String(result.reason),
                severity: 'error',
                category: 'logic',
                suggestion: undefined,
                replacement: undefined,
              },
            ],
          };
          results.set(checkName, errorSummary);

          // Check if we should stop execution due to fail-fast
          if (effectiveFailFast) {
            log(`🛑 Check "${checkName}" failed and fail-fast is enabled - stopping execution`);
            shouldStopExecution = true;
            break;
          }
        }
      }

      // If fail-fast is enabled, check if any successful checks have failure conditions
      if (effectiveFailFast && !shouldStopExecution) {
        for (let i = 0; i < levelResults.length; i++) {
          const checkName = executionGroup.parallel[i];
          const result = levelResults[i];

          if (result.status === 'fulfilled' && result.value.result && !result.value.error) {
            // Check for issues that should trigger fail-fast
            const hasFailuresToReport = (result.value.result.issues || []).some(
              issue => issue.severity === 'error' || issue.severity === 'critical'
            );

            if (hasFailuresToReport) {
              log(
                `🛑 Check "${checkName}" found critical/high issues and fail-fast is enabled - stopping execution`
              );
              shouldStopExecution = true;
              break;
            }
          }
        }
      }
    }

    // Log final execution status
    if (shouldStopExecution) {
      log(
        `🛑 Execution stopped early due to fail-fast after processing ${results.size} of ${checks.length} checks`
      );
    } else {
      log(`✅ Dependency-aware execution completed successfully for all ${results.size} checks`);
    }

    // Cleanup sessions after execution
    if (sessionIds.size > 0) {
      log(`🧹 Cleaning up ${sessionIds.size} AI sessions...`);
      for (const [checkName, sessionId] of sessionIds) {
        try {
          sessionRegistry.unregisterSession(sessionId);
          log(`🗑️ Cleaned up session for check ${checkName}: ${sessionId}`);
        } catch (error) {
          log(`⚠️ Failed to cleanup session for check ${checkName}: ${error}`);
        }
      }
    }

    // Aggregate all results
    return this.aggregateDependencyAwareResults(
      results,
      dependencyGraph,
      debug,
      shouldStopExecution
    );
  }

  /**
   * Execute multiple checks in parallel using controlled parallelism (legacy method)
   */
  private async executeParallelChecks(
    prInfo: PRInfo,
    checks: string[],
    timeout?: number,
    config?: import('./types/config').VisorConfig,
    logFn?: (message: string) => void,
    debug?: boolean,
    maxParallelism?: number,
    failFast?: boolean
  ): Promise<ReviewSummary> {
    const log = logFn || console.error;
    log(`🔧 Debug: Starting parallel execution of ${checks.length} checks`);

    if (!config?.checks) {
      throw new Error('Config with check definitions required for parallel execution');
    }

    // Determine effective max parallelism (CLI > config > default)
    const effectiveMaxParallelism = maxParallelism ?? config.max_parallelism ?? 3;
    // Determine effective fail-fast setting (CLI > config > default)
    const effectiveFailFast = failFast ?? config.fail_fast ?? false;
    log(`🔧 Debug: Using max parallelism: ${effectiveMaxParallelism}`);
    log(`🔧 Debug: Using fail-fast: ${effectiveFailFast}`);

    const provider = this.providerRegistry.getProviderOrThrow('ai');
    this.setProviderWebhookContext(provider);

    // Create individual check task functions
    const checkTaskFunctions = checks.map(checkName => async () => {
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

        // Evaluate if condition to determine whether to run this check
        if (checkConfig.if) {
          const shouldRun = await this.failureEvaluator.evaluateIfCondition(
            checkName,
            checkConfig.if,
            {
              branch: prInfo.head,
              baseBranch: prInfo.base,
              filesChanged: prInfo.files.map(f => f.filename),
              event: 'issue_comment', // Command triggered from comment
              environment: getSafeEnvironmentVariables(),
              previousResults: new Map(), // No previous results in parallel execution
            }
          );

          if (!shouldRun) {
            console.error(
              `🔧 Debug: Skipping check '${checkName}' - if condition evaluated to false`
            );
            return {
              checkName,
              error: null,
              result: {
                issues: [],
              },
            };
          }
        }

        // Create provider config for this specific check
        const providerConfig: CheckProviderConfig = {
          type: 'ai',
          prompt: checkConfig.prompt,
          focus: checkConfig.focus || this.mapCheckNameToFocus(checkName),
          schema: checkConfig.schema,
          group: checkConfig.group,
          eventContext: prInfo.eventContext, // Pass event context for templates
          ai: {
            timeout: timeout || 600000,
            debug: debug, // Pass debug flag to AI provider
            ...(checkConfig.ai || {}),
          },
        };

        const result = await provider.execute(prInfo, providerConfig);
        console.error(
          `🔧 Debug: Completed check: ${checkName}, issues found: ${(result.issues || []).length}`
        );

        // Add group, schema info and timestamp to issues from config
        const enrichedIssues = (result.issues || []).map(issue => ({
          ...issue,
          ruleId: `${checkName}/${issue.ruleId}`,
          group: checkConfig.group,
          schema: typeof checkConfig.schema === 'object' ? 'custom' : checkConfig.schema,
          template: checkConfig.template,
          timestamp: Date.now(),
        }));

        const enrichedResult = {
          ...result,
          issues: enrichedIssues,
        };

        return {
          checkName,
          error: null,
          result: enrichedResult,
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

    // Execute all checks with controlled parallelism
    log(
      `🔧 Debug: Executing ${checkTaskFunctions.length} checks with max parallelism: ${effectiveMaxParallelism}`
    );
    const results = await this.executeWithLimitedParallelism(
      checkTaskFunctions,
      effectiveMaxParallelism,
      effectiveFailFast
    );

    // Check if execution was stopped early
    const completedChecks = results.filter(
      r => r.status === 'fulfilled' || r.status === 'rejected'
    ).length;
    const stoppedEarly = completedChecks < checks.length;

    if (stoppedEarly && effectiveFailFast) {
      log(
        `🛑 Parallel execution stopped early due to fail-fast after processing ${completedChecks} of ${checks.length} checks`
      );
    } else {
      log(`✅ Parallel execution completed for all ${completedChecks} checks`);
    }

    // Aggregate results from all checks
    return this.aggregateParallelResults(results, checks, debug, stoppedEarly);
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
    this.setProviderWebhookContext(provider);

    const providerConfig: CheckProviderConfig = {
      type: 'ai',
      prompt: checkConfig.prompt,
      focus: checkConfig.focus || this.mapCheckNameToFocus(checkName),
      schema: checkConfig.schema,
      group: checkConfig.group,
      eventContext: prInfo.eventContext, // Pass event context for templates
      ai: {
        timeout: timeout || 600000,
        ...(checkConfig.ai || {}),
      },
      // Inherit global AI provider and model settings
      ai_provider: checkConfig.ai_provider || config.ai_provider,
      ai_model: checkConfig.ai_model || config.ai_model,
    };

    const result = await provider.execute(prInfo, providerConfig);

    // Prefix issues with check name and add group/schema info and timestamp from config
    const prefixedIssues = (result.issues || []).map(issue => ({
      ...issue,
      ruleId: `${checkName}/${issue.ruleId}`,
      group: checkConfig.group,
      schema: typeof checkConfig.schema === 'object' ? 'custom' : checkConfig.schema,
      timestamp: Date.now(),
    }));

    return {
      ...result,
      issues: prefixedIssues,
    };
  }

  /**
   * Map check name to focus for AI provider
   * This is a fallback when focus is not explicitly configured
   */
  private mapCheckNameToFocus(checkName: string): string {
    const focusMap: Record<string, string> = {
      security: 'security',
      performance: 'performance',
      style: 'style',
      architecture: 'architecture',
    };

    return focusMap[checkName] || 'all';
  }

  /**
   * Aggregate results from dependency-aware check execution
   */
  private aggregateDependencyAwareResults(
    results: Map<string, ReviewSummary>,
    dependencyGraph: DependencyGraph,
    debug?: boolean,
    stoppedEarly?: boolean
  ): ReviewSummary {
    const aggregatedIssues: ReviewSummary['issues'] = [];
    const debugInfo: string[] = [];

    // Add execution plan info
    const stats = DependencyResolver.getExecutionStats(dependencyGraph);
    const executionInfo = [
      stoppedEarly
        ? `🛑 Dependency-aware execution stopped early (fail-fast):`
        : `🔍 Dependency-aware execution completed:`,
      `  - ${results.size} of ${stats.totalChecks} checks processed`,
      `  - Execution levels: ${stats.parallelLevels}`,
      `  - Maximum parallelism: ${stats.maxParallelism}`,
      `  - Average parallelism: ${stats.averageParallelism.toFixed(1)}`,
      `  - Checks with dependencies: ${stats.checksWithDependencies}`,
      stoppedEarly ? `  - Stopped early due to fail-fast behavior` : ``,
    ].filter(Boolean);

    debugInfo.push(...executionInfo);

    // Process results in dependency order for better output organization
    for (const executionGroup of dependencyGraph.executionOrder) {
      for (const checkName of executionGroup.parallel) {
        const result = results.get(checkName);

        if (!result) {
          debugInfo.push(`❌ Check "${checkName}" had no result`);
          continue;
        }

        // Check if this was a successful result
        const hasErrors = (result.issues || []).some(
          issue => issue.ruleId?.includes('/error') || issue.ruleId?.includes('/promise-error')
        );

        if (hasErrors) {
          debugInfo.push(`❌ Check "${checkName}" failed with errors`);
        } else {
          debugInfo.push(
            `✅ Check "${checkName}" completed: ${(result.issues || []).length} issues found (level ${executionGroup.level})`
          );
        }

        // Issues are already prefixed and enriched with group/schema info
        aggregatedIssues.push(...(result.issues || []));
      }
    }

    console.error(
      `🔧 Debug: Aggregated ${aggregatedIssues.length} issues from ${results.size} dependency-aware checks`
    );

    // Apply issue suppression filtering
    const suppressionEnabled = this.config?.output?.suppressionEnabled !== false;
    const issueFilter = new IssueFilter(suppressionEnabled);
    const filteredIssues = issueFilter.filterIssues(aggregatedIssues, this.workingDirectory);

    // Collect debug information when debug mode is enabled
    let aggregatedDebug: import('./ai-review-service').AIDebugInfo | undefined;
    if (debug) {
      const debugResults = Array.from(results.entries()).filter(([_, result]) => result.debug);

      if (debugResults.length > 0) {
        const [, firstResult] = debugResults[0];
        const firstDebug = firstResult.debug!;

        const totalProcessingTime = debugResults.reduce((sum, [_, result]) => {
          return sum + (result.debug!.processingTime || 0);
        }, 0);

        aggregatedDebug = {
          provider: firstDebug.provider,
          model: firstDebug.model,
          apiKeySource: firstDebug.apiKeySource,
          processingTime: totalProcessingTime,
          prompt: debugResults
            .map(([checkName, result]) => `[${checkName}]\n${result.debug!.prompt}`)
            .join('\n\n'),
          rawResponse: debugResults
            .map(([checkName, result]) => `[${checkName}]\n${result.debug!.rawResponse}`)
            .join('\n\n'),
          promptLength: debugResults.reduce(
            (sum, [_, result]) => sum + (result.debug!.promptLength || 0),
            0
          ),
          responseLength: debugResults.reduce(
            (sum, [_, result]) => sum + (result.debug!.responseLength || 0),
            0
          ),
          jsonParseSuccess: debugResults.every(([_, result]) => result.debug!.jsonParseSuccess),
          errors: debugResults.flatMap(([checkName, result]) =>
            (result.debug!.errors || []).map((error: string) => `[${checkName}] ${error}`)
          ),
          timestamp: new Date().toISOString(),
          totalApiCalls: debugResults.length,
          apiCallDetails: debugResults.map(([checkName, result]) => ({
            checkName,
            provider: result.debug!.provider,
            model: result.debug!.model,
            processingTime: result.debug!.processingTime,
            success: result.debug!.jsonParseSuccess,
          })),
        };
      }
    }

    return {
      issues: filteredIssues,
      debug: aggregatedDebug,
    };
  }

  /**
   * Aggregate results from parallel check execution (legacy method)
   */
  private aggregateParallelResults(
    results: PromiseSettledResult<{
      checkName: string;
      error: string | null;
      result: ReviewSummary | null;
    }>[],
    checkNames: string[],
    debug?: boolean,
    _stoppedEarly?: boolean
  ): ReviewSummary {
    const aggregatedIssues: ReviewSummary['issues'] = [];
    const debugInfo: string[] = [];

    results.forEach((result, index) => {
      const checkName = checkNames[index];

      if (result.status === 'fulfilled') {
        const checkResult = result.value;

        if (checkResult.error) {
          const log = console.error;
          log(`🔧 Debug: Check ${checkName} failed: ${checkResult.error}`);
          debugInfo.push(`❌ Check "${checkName}" failed: ${checkResult.error}`);

          // Check if this is a critical error
          const isCriticalError =
            checkResult.error.includes('API rate limit') ||
            checkResult.error.includes('403') ||
            checkResult.error.includes('401') ||
            checkResult.error.includes('authentication') ||
            checkResult.error.includes('API key');

          // Add error as an issue with appropriate severity
          aggregatedIssues.push({
            file: 'system',
            line: 0,
            endLine: undefined,
            ruleId: `${checkName}/error`,
            message: `Check "${checkName}" failed: ${checkResult.error}`,
            severity: isCriticalError ? 'critical' : 'error',
            category: 'logic',
            suggestion: isCriticalError
              ? 'Please check your API credentials and rate limits'
              : undefined,
            replacement: undefined,
          });
        } else if (checkResult.result) {
          console.error(
            `🔧 Debug: Check ${checkName} succeeded with ${(checkResult.result.issues || []).length} issues`
          );
          debugInfo.push(
            `✅ Check "${checkName}" completed: ${(checkResult.result.issues || []).length} issues found`
          );

          // Issues are already prefixed and enriched with group/schema info
          aggregatedIssues.push(...(checkResult.result.issues || []));
        }
      } else {
        const errorMessage =
          result.reason instanceof Error ? result.reason.message : String(result.reason);
        const log = console.error;
        log(`🔧 Debug: Check ${checkName} promise rejected: ${errorMessage}`);
        debugInfo.push(`❌ Check "${checkName}" promise rejected: ${errorMessage}`);

        // Check if this is a critical error
        const isCriticalError =
          errorMessage.includes('API rate limit') ||
          errorMessage.includes('403') ||
          errorMessage.includes('401') ||
          errorMessage.includes('authentication') ||
          errorMessage.includes('API key');

        aggregatedIssues.push({
          file: 'system',
          line: 0,
          endLine: undefined,
          ruleId: `${checkName}/promise-error`,
          message: `Check "${checkName}" execution failed: ${errorMessage}`,
          severity: isCriticalError ? 'critical' : 'error',
          category: 'logic',
          suggestion: isCriticalError
            ? 'Please check your API credentials and rate limits'
            : undefined,
          replacement: undefined,
        });
      }
    });

    console.error(
      `🔧 Debug: Aggregated ${aggregatedIssues.length} issues from ${results.length} checks`
    );

    // Apply issue suppression filtering
    const suppressionEnabled = this.config?.output?.suppressionEnabled !== false;
    const issueFilter = new IssueFilter(suppressionEnabled);
    const filteredIssues = issueFilter.filterIssues(aggregatedIssues, this.workingDirectory);

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
                  return `[${checkName}]\n${result.value!.result!.debug!.prompt}`;
                }
                return `[${checkName}] Error: Promise was rejected`;
              })
              .join('\n\n'),
            // Combine responses
            rawResponse: debugResults
              .map(({ checkName, result }) => {
                if (result.status === 'fulfilled') {
                  return `[${checkName}]\n${result.value!.result!.debug!.rawResponse}`;
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
      issues: filteredIssues,
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
      },
      executionTime,
      timestamp,
      checksExecuted,
    };
  }

  /**
   * Check if a task result should trigger fail-fast behavior
   */
  private shouldFailFast(result: {
    error?: string;
    result?: { issues?: Array<{ severity: string }> };
  }): boolean {
    // If the result has an error property, it's a failed check
    if (result?.error) {
      return true;
    }

    // If the result has a result with critical or error issues, it should fail fast
    if (result?.result?.issues) {
      return (result.result.issues || []).some(
        (issue: { severity: string }) => issue.severity === 'error' || issue.severity === 'critical'
      );
    }

    return false;
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
   * Evaluate failure conditions for a check result
   */
  async evaluateFailureConditions(
    checkName: string,
    reviewSummary: ReviewSummary,
    config?: import('./types/config').VisorConfig
  ): Promise<FailureConditionResult[]> {
    if (!config) {
      return [];
    }

    const checkConfig = config.checks[checkName];
    const checkSchema =
      typeof checkConfig?.schema === 'object' ? 'custom' : checkConfig?.schema || '';
    const checkGroup = checkConfig?.group || '';

    // Handle new simple fail_if syntax
    const globalFailIf = config.fail_if;
    const checkFailIf = checkConfig?.fail_if;

    // If using new fail_if syntax
    if (globalFailIf || checkFailIf) {
      const results: FailureConditionResult[] = [];

      // Evaluate global fail_if
      if (globalFailIf) {
        const failed = await this.failureEvaluator.evaluateSimpleCondition(
          checkName,
          checkSchema,
          checkGroup,
          reviewSummary,
          globalFailIf
        );

        if (failed) {
          results.push({
            conditionName: 'global_fail_if',
            expression: globalFailIf,
            failed: true,
            severity: 'error',
            message: 'Global failure condition met',
            haltExecution: false,
          });
        }
      }

      // Evaluate check-specific fail_if (overrides global if present)
      if (checkFailIf) {
        const failed = await this.failureEvaluator.evaluateSimpleCondition(
          checkName,
          checkSchema,
          checkGroup,
          reviewSummary,
          checkFailIf
        );

        if (failed) {
          results.push({
            conditionName: `${checkName}_fail_if`,
            expression: checkFailIf,
            failed: true,
            severity: 'error',
            message: `Check ${checkName} failure condition met`,
            haltExecution: false,
          });
        }
      }

      return results;
    }

    // Fall back to old failure_conditions syntax
    const globalConditions = config.failure_conditions;
    const checkConditions = checkConfig?.failure_conditions;

    return await this.failureEvaluator.evaluateConditions(
      checkName,
      checkSchema,
      checkGroup,
      reviewSummary,
      globalConditions,
      checkConditions
    );
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

  /**
   * Initialize GitHub check runs for each configured check
   */
  private async initializeGitHubChecks(
    options: CheckExecutionOptions,
    logFn: (message: string) => void
  ): Promise<void> {
    if (
      !options.githubChecks?.octokit ||
      !options.githubChecks.owner ||
      !options.githubChecks.repo ||
      !options.githubChecks.headSha
    ) {
      logFn('⚠️ GitHub checks enabled but missing required parameters');
      return;
    }

    try {
      this.githubCheckService = new GitHubCheckService(options.githubChecks.octokit);
      this.checkRunMap = new Map();
      this.githubContext = {
        owner: options.githubChecks.owner,
        repo: options.githubChecks.repo,
      };

      logFn(`🔍 Creating GitHub check runs for ${options.checks.length} checks...`);

      for (const checkName of options.checks) {
        try {
          const checkRunOptions: CheckRunOptions = {
            owner: options.githubChecks.owner,
            repo: options.githubChecks.repo,
            head_sha: options.githubChecks.headSha,
            name: `Visor: ${checkName}`,
            external_id: `visor-${checkName}-${options.githubChecks.headSha.substring(0, 7)}`,
          };

          const checkRun = await this.githubCheckService.createCheckRun(checkRunOptions, {
            title: `${checkName} Analysis`,
            summary: `Running ${checkName} check using AI-powered analysis...`,
          });

          this.checkRunMap.set(checkName, checkRun);
          logFn(`✅ Created check run for ${checkName}: ${checkRun.url}`);
        } catch (error) {
          logFn(`❌ Failed to create check run for ${checkName}: ${error}`);
        }
      }
    } catch (error) {
      // Check if this is a permissions error
      if (
        error instanceof Error &&
        (error.message.includes('403') || error.message.includes('checks:write'))
      ) {
        logFn(
          '⚠️ GitHub checks API not available - insufficient permissions. Check runs will be skipped.'
        );
        logFn('💡 To enable check runs, ensure your GitHub token has "checks:write" permission.');
        this.githubCheckService = undefined;
        this.checkRunMap = undefined;
      } else {
        logFn(`❌ Failed to initialize GitHub check runs: ${error}`);
        this.githubCheckService = undefined;
        this.checkRunMap = undefined;
      }
    }
  }

  /**
   * Update GitHub check runs to in-progress status
   */
  private async updateGitHubChecksInProgress(options: CheckExecutionOptions): Promise<void> {
    if (
      !this.githubCheckService ||
      !this.checkRunMap ||
      !options.githubChecks?.owner ||
      !options.githubChecks.repo
    ) {
      return;
    }

    for (const [checkName, checkRun] of this.checkRunMap) {
      try {
        await this.githubCheckService.updateCheckRunInProgress(
          options.githubChecks.owner,
          options.githubChecks.repo,
          checkRun.id,
          {
            title: `Analyzing with ${checkName}...`,
            summary: `AI-powered analysis is in progress for ${checkName} check.`,
          }
        );
        console.log(`🔄 Updated ${checkName} check to in-progress status`);
      } catch (error) {
        console.error(`❌ Failed to update ${checkName} check to in-progress: ${error}`);
      }
    }
  }

  /**
   * Complete GitHub check runs with results
   */
  private async completeGitHubChecksWithResults(
    reviewSummary: ReviewSummary,
    options: CheckExecutionOptions
  ): Promise<void> {
    if (
      !this.githubCheckService ||
      !this.checkRunMap ||
      !options.githubChecks?.owner ||
      !options.githubChecks.repo
    ) {
      return;
    }

    // Group issues by check name
    const issuesByCheck = new Map<string, import('./reviewer').ReviewIssue[]>();

    // Initialize empty arrays for all checks
    for (const checkName of this.checkRunMap.keys()) {
      issuesByCheck.set(checkName, []);
    }

    // Group issues by their check name (extracted from ruleId prefix)
    for (const issue of reviewSummary.issues || []) {
      if (issue.ruleId && issue.ruleId.includes('/')) {
        const checkName = issue.ruleId.split('/')[0];
        if (issuesByCheck.has(checkName)) {
          issuesByCheck.get(checkName)!.push(issue);
        }
      }
    }

    console.log(`🏁 Completing ${this.checkRunMap.size} GitHub check runs...`);

    for (const [checkName, checkRun] of this.checkRunMap) {
      try {
        const checkIssues = issuesByCheck.get(checkName) || [];

        // Evaluate failure conditions for this specific check
        const failureResults = await this.evaluateFailureConditions(
          checkName,
          { issues: checkIssues },
          options.config
        );

        await this.githubCheckService.completeCheckRun(
          options.githubChecks.owner,
          options.githubChecks.repo,
          checkRun.id,
          checkName,
          failureResults,
          checkIssues
        );

        console.log(`✅ Completed ${checkName} check with ${checkIssues.length} issues`);
      } catch (error) {
        console.error(`❌ Failed to complete ${checkName} check: ${error}`);

        // Try to mark the check as failed due to execution error
        try {
          await this.githubCheckService.completeCheckRun(
            options.githubChecks.owner,
            options.githubChecks.repo,
            checkRun.id,
            checkName,
            [],
            [],
            error instanceof Error ? error.message : 'Unknown error occurred'
          );
        } catch (finalError) {
          console.error(`❌ Failed to mark ${checkName} check as failed: ${finalError}`);
        }
      }
    }
  }

  /**
   * Complete GitHub check runs with error status
   */
  private async completeGitHubChecksWithError(errorMessage: string): Promise<void> {
    if (!this.githubCheckService || !this.checkRunMap || !this.githubContext) {
      return;
    }

    console.log(`❌ Completing ${this.checkRunMap.size} GitHub check runs with error...`);

    for (const [checkName, checkRun] of this.checkRunMap) {
      try {
        await this.githubCheckService.completeCheckRun(
          this.githubContext.owner,
          this.githubContext.repo,
          checkRun.id,
          checkName,
          [],
          [],
          errorMessage
        );
        console.log(`❌ Completed ${checkName} check with error: ${errorMessage}`);
      } catch (error) {
        console.error(`❌ Failed to complete ${checkName} check with error: ${error}`);
      }
    }
  }

  /**
   * Filter checks based on their event triggers to prevent execution of checks
   * that shouldn't run for the current event type
   */
  private filterChecksByEvent(
    checks: string[],
    config?: import('./types/config').VisorConfig,
    prInfo?: PRInfo,
    logFn?: (message: string) => void,
    debug?: boolean
  ): string[] {
    if (!config?.checks) {
      // No config available, return all checks (fallback behavior)
      return checks;
    }

    // If we have event context from GitHub (prInfo with eventType), apply strict filtering
    // Otherwise (CLI, tests), use conservative filtering
    const prInfoWithEvent = prInfo as PRInfo & {
      eventType?: import('./types/config').EventTrigger;
    };
    const hasEventContext =
      prInfoWithEvent && 'eventType' in prInfoWithEvent && prInfoWithEvent.eventType;

    if (hasEventContext) {
      // GitHub Action context - apply strict event filtering
      const currentEvent = prInfoWithEvent.eventType!;
      if (debug) {
        logFn?.(`🔧 Debug: GitHub Action context, current event: ${currentEvent}`);
      }

      const filteredChecks: string[] = [];
      for (const checkName of checks) {
        const checkConfig = config.checks[checkName];
        if (!checkConfig) {
          filteredChecks.push(checkName);
          continue;
        }

        const eventTriggers = checkConfig.on || [];
        if (eventTriggers.length === 0) {
          // No triggers specified, include it
          filteredChecks.push(checkName);
          if (debug) {
            logFn?.(`🔧 Debug: Check '${checkName}' has no event triggers, including`);
          }
        } else if (eventTriggers.includes(currentEvent)) {
          // Check matches current event
          filteredChecks.push(checkName);
          if (debug) {
            logFn?.(`🔧 Debug: Check '${checkName}' matches event '${currentEvent}', including`);
          }
        } else {
          // Check doesn't match current event
          if (debug) {
            logFn?.(
              `🔧 Debug: Check '${checkName}' does not match event '${currentEvent}' (triggers: ${JSON.stringify(eventTriggers)}), skipping`
            );
          }
        }
      }
      return filteredChecks;
    } else {
      // CLI/Test context - conservative filtering (only exclude manual-only checks)
      if (debug) {
        logFn?.(`🔧 Debug: CLI/Test context, using conservative filtering`);
      }

      const filteredChecks: string[] = [];
      for (const checkName of checks) {
        const checkConfig = config.checks[checkName];
        if (!checkConfig) {
          filteredChecks.push(checkName);
          continue;
        }

        const eventTriggers = checkConfig.on || [];

        // Only exclude checks that are explicitly manual-only
        if (eventTriggers.length === 1 && eventTriggers[0] === 'manual') {
          if (debug) {
            logFn?.(`🔧 Debug: Check '${checkName}' is manual-only, skipping`);
          }
        } else {
          filteredChecks.push(checkName);
          if (debug) {
            logFn?.(
              `🔧 Debug: Check '${checkName}' included (triggers: ${JSON.stringify(eventTriggers)})`
            );
          }
        }
      }
      return filteredChecks;
    }
  }

  /**
   * Determine the current event type from PR info
   */
  private getCurrentEventType(prInfo?: PRInfo): import('./types/config').EventTrigger {
    if (!prInfo) {
      return 'pr_opened'; // Default fallback
    }

    // For now, assume all PR-related operations are 'pr_updated' since we don't have
    // direct access to the original GitHub event here. This is a simplification.
    // In the future, we could pass the actual event type through the call chain.

    // The key insight is that issue-assistant should only run on issue_opened/issue_comment
    // events, which don't generate PRInfo objects in the first place.
    return 'pr_updated';
  }
}
