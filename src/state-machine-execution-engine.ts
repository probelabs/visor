import type { CheckExecutionOptions, ExecutionResult } from './types/execution';
import { AnalysisResult } from './output-formatters';
import type { VisorConfig, EventTrigger } from './types/config';
import type { PRInfo } from './pr-analyzer';
import { StateMachineRunner } from './state-machine/runner';
import type { EngineContext, CheckMetadata } from './types/engine';
import { ExecutionJournal } from './snapshot-store';
import { MemoryStore } from './memory-store';
import { logger } from './logger';
import { v4 as uuidv4 } from 'uuid';
import type { DebugVisualizerServer } from './debug-visualizer/ws-server';

/**
 * State machine-based execution engine
 *
 * Production-ready state machine implementation with full observability support.
 * M4: Includes OTEL telemetry and debug visualizer event streaming.
 */
export class StateMachineExecutionEngine {
  private workingDirectory: string;
  private executionContext?: import('./providers/check-provider.interface').ExecutionContext;
  private debugServer?: DebugVisualizerServer;
  private _lastContext?: EngineContext;

  constructor(
    workingDirectory?: string,
    octokit?: import('@octokit/rest').Octokit,
    debugServer?: DebugVisualizerServer
  ) {
    this.workingDirectory = workingDirectory || process.cwd();
    this.debugServer = debugServer;
  }

  /**
   * Execute checks using the state machine engine
   *
   * Converts CheckExecutionOptions -> executeGroupedChecks() -> AnalysisResult
   */
  async executeChecks(options: CheckExecutionOptions): Promise<AnalysisResult> {
    const startTime = Date.now();
    const timestamp = new Date().toISOString();

    try {
      // Initialize memory store if configured
      if (options.config?.memory) {
        const { MemoryStore } = await import('./memory-store');
        const memoryStore = MemoryStore.getInstance(options.config.memory);
        await memoryStore.initialize();
        logger.debug('Memory store initialized');
      }

      // Analyze the repository
      const { GitRepositoryAnalyzer } = await import('./git-repository-analyzer');
      const gitAnalyzer = new GitRepositoryAnalyzer(options.workingDirectory);
      logger.info('Analyzing local git repository...');
      const repositoryInfo = await gitAnalyzer.analyzeRepository();

      if (!repositoryInfo.isGitRepository) {
        return this.createErrorResult(
          repositoryInfo,
          'Not a git repository or no changes found',
          startTime,
          timestamp,
          options.checks
        );
      }

      // Convert to PRInfo format for compatibility
      const prInfo = gitAnalyzer.toPRInfo(repositoryInfo);

      // Propagate event type if provided
      try {
        const evt = (options.webhookContext as any)?.eventType;
        if (evt) (prInfo as any).eventType = evt;
      } catch {}

      // Apply tag filtering if specified
      const filteredChecks = this.filterChecksByTags(
        options.checks,
        options.config,
        options.tagFilter || options.config?.tag_filter
      );

      if (filteredChecks.length === 0) {
        logger.warn('No checks match the tag filter criteria');
        return this.createErrorResult(
          repositoryInfo,
          'No checks match the tag filter criteria',
          startTime,
          timestamp,
          options.checks
        );
      }

      // Execute checks using state machine
      logger.info(`Executing checks: ${filteredChecks.join(', ')}`);
      const executionResult = await this.executeGroupedChecks(
        prInfo,
        filteredChecks,
        options.timeout,
        options.config,
        options.outputFormat,
        options.debug,
        options.maxParallelism,
        options.failFast,
        options.tagFilter
      );

      // Convert ExecutionResult to AnalysisResult format
      const executionTime = Date.now() - startTime;

      // Extract review summary from grouped results
      const reviewSummary = this.convertGroupedResultsToReviewSummary(
        executionResult.results,
        executionResult.statistics
      );

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

      // Expose output history snapshot
      try {
        const histSnap = this.getOutputHistorySnapshot();
        (reviewSummary as any).history = histSnap;
      } catch {}

      return {
        repositoryInfo,
        reviewSummary,
        executionTime,
        timestamp,
        checksExecuted: filteredChecks,
        executionStatistics: executionResult.statistics,
        debug: debugInfo,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error occurred';
      logger.error('Error executing checks: ' + message);

      // In strict test modes, surface errors to callers
      const strictEnv = process.env.VISOR_STRICT_ERRORS === 'true';
      if (strictEnv) {
        throw error;
      }

      const fallbackRepositoryInfo: import('./git-repository-analyzer').GitRepositoryInfo = {
        title: 'Error during analysis',
        body: `Error: ${message || 'Unknown error'}`,
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
        message || 'Unknown error occurred',
        startTime,
        timestamp,
        options.checks
      );
    }
  }

  /**
   * Get execution context (used by state machine to propagate hooks)
   */
  protected getExecutionContext():
    | import('./providers/check-provider.interface').ExecutionContext
    | undefined {
    return this.executionContext;
  }

  /**
   * Set execution context for external callers
   */
  public setExecutionContext(
    context: import('./providers/check-provider.interface').ExecutionContext | undefined
  ): void {
    this.executionContext = context;
  }

  /**
   * Reset per-run state (no-op for state machine engine)
   *
   * The state machine engine is stateless per-run by design.
   * Each execution creates a fresh journal and context.
   * This method exists only for backward compatibility with test framework.
   *
   * @deprecated This is a no-op. State machine engine doesn't maintain per-run state.
   */
  public resetPerRunState(): void {
    // No-op: State machine engine is stateless per-run
    // Each execution creates a fresh journal and context
  }

  /**
   * Execute grouped checks using the state machine engine
   *
   * M4: Production-ready with full telemetry and debug server support
   */
  async executeGroupedChecks(
    prInfo: PRInfo,
    checks: string[],
    timeout?: number,
    config?: VisorConfig,
    outputFormat?: string,
    debug?: boolean,
    maxParallelism?: number,
    failFast?: boolean,
    tagFilter?: import('./types/config').TagFilter,
    _pauseGate?: () => Promise<void>
  ): Promise<ExecutionResult> {
    if (debug) {
      logger.info('[StateMachine] Using state machine engine');
    }

    // Create minimal default config if none provided (backward compatibility)
    if (!config) {
      const { ConfigManager } = await import('./config');
      const configManager = new ConfigManager();
      config = await configManager.getDefaultConfig();
      logger.debug('[StateMachine] Using default configuration (no config provided)');
    }

    // Merge tagFilter into config if provided (test runner passes it separately)
    const configWithTagFilter = tagFilter
      ? {
          ...config,
          tag_filter: tagFilter,
        }
      : config;

    // Build engine context
    const context = this.buildEngineContext(
      configWithTagFilter,
      prInfo,
      debug,
      maxParallelism,
      failFast,
      checks // Pass the explicit checks list
    );

    // Copy execution context (hooks, etc.) from legacy engine
    context.executionContext = this.getExecutionContext();

    // Store context for later access (e.g., getOutputHistorySnapshot)
    this._lastContext = context;

    // Create and run state machine with debug server support (M4)
    const runner = new StateMachineRunner(context, this.debugServer);
    const result = await runner.run();

    if (debug) {
      logger.info('[StateMachine] Execution complete');
    }

    // Optional grouped-mode PR comment posting (used by YAML tests via execution context)
    try {
      if (
        this.executionContext?.mode?.postGroupedComments &&
        configWithTagFilter?.output?.pr_comment
      ) {
        const { PRReviewer } = await import('./reviewer');
        const reviewer = new PRReviewer(
          (this._lastContext as any)?.executionContext?.octokit as any
        );

        // Resolve owner/repo from PRInfo.eventContext
        let owner: string | undefined;
        let repo: string | undefined;
        try {
          const anyInfo = prInfo as unknown as {
            eventContext?: { repository?: { owner?: { login?: string }; name?: string } };
          };
          owner = anyInfo?.eventContext?.repository?.owner?.login || owner;
          repo = anyInfo?.eventContext?.repository?.name || repo;
        } catch {}
        owner = owner || (process.env.GITHUB_REPOSITORY || 'owner/repo').split('/')[0];
        repo = repo || (process.env.GITHUB_REPOSITORY || 'owner/repo').split('/')[1];

        if (owner && repo && (prInfo as any).number) {
          await reviewer.postReviewComment(owner, repo, (prInfo as any).number, result.results, {
            config: configWithTagFilter as any,
            triggeredBy: (prInfo as any).eventType || 'manual',
            commentId: 'visor-review',
            octokitOverride: (prInfo as any)?.eventContext?.octokit,
            commitSha: (prInfo as any)?.eventContext?.pull_request?.head?.sha,
          });
        }
      }
    } catch (err) {
      logger.debug(`[StateMachine] Skipped postGroupedComments due to error: ${err}`);
    }

    // Cleanup AI sessions after execution
    try {
      const { SessionRegistry } = await import('./session-registry');
      const sessionRegistry = SessionRegistry.getInstance();
      sessionRegistry.clearAllSessions();
    } catch (error) {
      logger.debug(`[StateMachine] Failed to cleanup sessions: ${error}`);
    }

    return result;
  }

  /**
   * Build the engine context for state machine execution
   */
  private buildEngineContext(
    config: VisorConfig,
    prInfo: PRInfo,
    debug?: boolean,
    maxParallelism?: number,
    failFast?: boolean,
    requestedChecks?: string[]
  ): EngineContext {
    // Deep clone provided config to avoid cross-run mutations between tests/runs
    const clonedConfig: VisorConfig = JSON.parse(JSON.stringify(config));

    // Build check metadata
    const checks: Record<string, CheckMetadata> = {};

    // If config has checks, use them
    for (const [checkId, checkConfig] of Object.entries(clonedConfig.checks || {})) {
      checks[checkId] = {
        tags: checkConfig.tags || [],
        triggers: (Array.isArray(checkConfig.on) ? checkConfig.on : [checkConfig.on]).filter(
          Boolean
        ) as EventTrigger[],
        group: checkConfig.group,
        providerType: checkConfig.type || 'ai',
        dependencies: checkConfig.depends_on || [],
      };
    }

    // Backward compatibility: synthesize minimal check configs for requested checks
    // that don't exist in the config (e.g., legacy test mode with empty config)
    if (requestedChecks && requestedChecks.length > 0) {
      for (const checkName of requestedChecks) {
        if (!checks[checkName] && !clonedConfig.checks?.[checkName]) {
          // Synthesize a minimal check config for this legacy check name
          logger.debug(`[StateMachine] Synthesizing minimal config for legacy check: ${checkName}`);

          // Add to config.checks so providers can find it
          if (!clonedConfig.checks) {
            clonedConfig.checks = {};
          }
          clonedConfig.checks[checkName] = {
            type: 'ai',
            prompt: `Perform ${checkName} analysis`,
          };

          // Add metadata
          checks[checkName] = {
            tags: [],
            triggers: [],
            group: 'default',
            providerType: 'ai',
            dependencies: [],
          };
        }
      }
    }

    // Initialize journal and memory
    const journal = new ExecutionJournal();
    const memory = MemoryStore.getInstance(clonedConfig.memory);

    return {
      mode: 'state-machine',
      config: clonedConfig,
      checks,
      journal,
      memory,
      workingDirectory: this.workingDirectory,
      sessionId: uuidv4(),
      event: prInfo.eventType,
      debug,
      maxParallelism,
      failFast,
      requestedChecks: requestedChecks && requestedChecks.length > 0 ? requestedChecks : undefined,
      // Store prInfo for later access (e.g., in getOutputHistorySnapshot)
      prInfo,
    };
  }

  /**
   * Get output history snapshot for test framework compatibility
   * Extracts output history from the journal
   */
  public getOutputHistorySnapshot(): Record<string, unknown[]> {
    // Get the journal from the last execution context
    const journal = (this as any)._lastContext?.journal as ExecutionJournal | undefined;
    if (!journal) {
      logger.debug('[StateMachine][DEBUG] getOutputHistorySnapshot: No journal found');
      return {};
    }

    const sessionId = (this as any)._lastContext?.sessionId as string | undefined;
    if (!sessionId) {
      logger.debug('[StateMachine][DEBUG] getOutputHistorySnapshot: No sessionId found');
      return {};
    }

    // Read all journal entries for this session
    const snapshot = journal.beginSnapshot();
    const allEntries = journal.readVisible(sessionId, snapshot, undefined);

    logger.debug(
      `[StateMachine][DEBUG] getOutputHistorySnapshot: Found ${allEntries.length} journal entries`
    );

    // Group by checkId and extract outputs
    const outputHistory: Record<string, unknown[]> = {};
    for (const entry of allEntries) {
      const checkId = entry.checkId;

      if (!outputHistory[checkId]) {
        outputHistory[checkId] = [];
      }
      // Push the output if it exists
      if (entry.result.output !== undefined) {
        outputHistory[checkId].push(entry.result.output);
      }
    }

    logger.debug(
      `[StateMachine][DEBUG] getOutputHistorySnapshot result: ${JSON.stringify(Object.keys(outputHistory))}`
    );
    for (const [checkId, outputs] of Object.entries(outputHistory)) {
      logger.debug(`[StateMachine][DEBUG]   ${checkId}: ${outputs.length} outputs`);
    }

    return outputHistory;
  }

  /**
   * Filter checks by tag filter
   */
  private filterChecksByTags(
    checks: string[],
    config: VisorConfig | undefined,
    tagFilter: import('./types/config').TagFilter | undefined
  ): string[] {
    // When no tag filter is specified, include only untagged checks by default.
    // Tagged checks are opt-in unless tag_filter is provided.
    return checks.filter(checkName => {
      const checkConfig = config?.checks?.[checkName];
      if (!checkConfig) {
        // If no config for this check, include it by default
        return true;
      }

      const checkTags = checkConfig.tags || [];

      // If no tag filter is specified, include only untagged checks.
      if (!tagFilter || (!tagFilter.include && !tagFilter.exclude)) {
        return checkTags.length === 0;
      }

      // If check has no tags and a tag filter is specified, include it (untagged checks always run)
      if (checkTags.length === 0) {
        return true;
      }

      // Check exclude tags first (if any exclude tag matches, skip the check)
      if (tagFilter.exclude && tagFilter.exclude.length > 0) {
        const hasExcludedTag = tagFilter.exclude.some(tag => checkTags.includes(tag));
        if (hasExcludedTag) return false;
      }

      // Check include tags (if specified, at least one must match)
      if (tagFilter.include && tagFilter.include.length > 0) {
        const hasIncludedTag = tagFilter.include.some(tag => checkTags.includes(tag));
        if (!hasIncludedTag) return false;
      }

      return true;
    });
  }

  /**
   * Create an error result in AnalysisResult format
   */
  private createErrorResult(
    repositoryInfo: import('./git-repository-analyzer').GitRepositoryInfo,
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
   * Convert GroupedCheckResults to ReviewSummary
   * Aggregates all check results into a single ReviewSummary
   */
  private convertGroupedResultsToReviewSummary(
    groupedResults: import('./reviewer').GroupedCheckResults,
    statistics?: import('./types/execution').ExecutionStatistics
  ): import('./reviewer').ReviewSummary {
    const allIssues: import('./reviewer').ReviewIssue[] = [];

    // Aggregate issues from all check results
    for (const checkResults of Object.values(groupedResults)) {
      for (const checkResult of checkResults) {
        if (checkResult.issues && checkResult.issues.length > 0) {
          allIssues.push(...checkResult.issues);
        }
      }
    }

    // Convert errors from execution statistics into issues
    if (statistics) {
      for (const checkStats of statistics.checks) {
        if (checkStats.errorMessage) {
          allIssues.push({
            file: 'system',
            line: 0,
            endLine: undefined,
            ruleId: 'system/error',
            message: checkStats.errorMessage,
            severity: 'error',
            category: 'logic',
            suggestion: undefined,
            replacement: undefined,
          });
        }
      }
    }

    return {
      issues: allIssues,
    };
  }

  /**
   * Evaluate failure conditions for a check result
   *
   * This method provides backward compatibility with the legacy engine by
   * delegating to the FailureConditionEvaluator.
   *
   * @param checkName - The name of the check being evaluated
   * @param reviewSummary - The review summary containing check results
   * @param config - The Visor configuration containing failure conditions
   * @param previousOutputs - Optional previous check outputs for cross-check conditions
   * @param authorAssociation - Optional GitHub author association for permission checks
   * @returns Array of failure condition evaluation results
   */
  async evaluateFailureConditions(
    checkName: string,
    reviewSummary: import('./reviewer').ReviewSummary,
    config: VisorConfig,
    previousOutputs?: Record<string, import('./reviewer').ReviewSummary>,
    authorAssociation?: string
  ): Promise<import('./types/config').FailureConditionResult[]> {
    const { FailureConditionEvaluator } = await import('./failure-condition-evaluator');
    const evaluator = new FailureConditionEvaluator();
    const { addEvent } = await import('./telemetry/trace-helpers');
    const { addFailIfTriggered } = await import('./telemetry/metrics');

    // Extract check configuration
    const checkConfig = config.checks?.[checkName];
    if (!checkConfig) {
      return [];
    }

    // Schema can be string or Record<string, unknown>, convert to string for evaluation
    const rawSchema = checkConfig.schema || 'code-review';
    const checkSchema = typeof rawSchema === 'string' ? rawSchema : 'code-review';
    const checkGroup = checkConfig.group || 'default';

    // Handle both fail_if (simple string) and failure_conditions (complex object)
    const results: import('./types/config').FailureConditionResult[] = [];

    // Evaluate global fail_if
    if (config.fail_if) {
      const failed = await evaluator.evaluateSimpleCondition(
        checkName,
        checkSchema,
        checkGroup,
        reviewSummary,
        config.fail_if,
        previousOutputs || {}
      );

      // Telemetry events + metric
      try {
        addEvent('fail_if.evaluated', {
          'visor.check.id': checkName,
          scope: 'global',
          expression: String(config.fail_if),
          result: failed ? 'triggered' : 'not_triggered',
        });
        if (failed) {
          addEvent('fail_if.triggered', {
            'visor.check.id': checkName,
            scope: 'global',
            expression: String(config.fail_if),
          });
          addFailIfTriggered(checkName, 'global');
        }
      } catch {}

      results.push({
        conditionName: 'global_fail_if',
        failed,
        expression: config.fail_if,
        message: failed ? `Global failure condition met: ${config.fail_if}` : undefined,
        severity: 'error',
        haltExecution: false,
      });
    }

    // Evaluate check-specific fail_if (overrides global if present)
    if (checkConfig.fail_if) {
      const failed = await evaluator.evaluateSimpleCondition(
        checkName,
        checkSchema,
        checkGroup,
        reviewSummary,
        checkConfig.fail_if,
        previousOutputs || {}
      );

      // Telemetry events + metric
      try {
        addEvent('fail_if.evaluated', {
          'visor.check.id': checkName,
          scope: 'check',
          expression: String(checkConfig.fail_if),
          result: failed ? 'triggered' : 'not_triggered',
        });
        if (failed) {
          addEvent('fail_if.triggered', {
            'visor.check.id': checkName,
            scope: 'check',
            expression: String(checkConfig.fail_if),
          });
          addFailIfTriggered(checkName, 'check');
        }
      } catch {}

      results.push({
        conditionName: `${checkName}_fail_if`,
        failed,
        expression: checkConfig.fail_if,
        message: failed ? `Check failure condition met: ${checkConfig.fail_if}` : undefined,
        severity: 'error',
        haltExecution: false,
      });
    }

    // Also evaluate legacy failure_conditions if present
    const globalConditions = config.failure_conditions;
    const checkConditions = checkConfig.failure_conditions;

    if (globalConditions || checkConditions) {
      const legacyResults = await evaluator.evaluateConditions(
        checkName,
        checkSchema,
        checkGroup,
        reviewSummary,
        globalConditions,
        checkConditions,
        previousOutputs,
        authorAssociation
      );
      results.push(...legacyResults);
    }

    return results;
  }

  /**
   * Get repository status
   * @returns Repository status information
   */
  async getRepositoryStatus(): Promise<{
    isGitRepository: boolean;
    branch?: string;
    hasChanges: boolean;
    filesChanged?: number;
  }> {
    try {
      const { GitRepositoryAnalyzer } = await import('./git-repository-analyzer');
      const analyzer = new GitRepositoryAnalyzer(this.workingDirectory);
      const info = await analyzer.analyzeRepository();

      return {
        isGitRepository: info.isGitRepository,
        branch: info.head, // Use head as branch name
        hasChanges: info.isGitRepository && (info.files?.length > 0 || false),
        filesChanged: info.isGitRepository ? info.files?.length || 0 : 0,
      };
    } catch {
      return {
        isGitRepository: false,
        hasChanges: false,
      };
    }
  }

  /**
   * Check if current directory is a git repository
   * @returns True if git repository, false otherwise
   */
  async isGitRepository(): Promise<boolean> {
    const status = await this.getRepositoryStatus();
    return status.isGitRepository;
  }

  /**
   * Get list of available check types
   * @returns Array of check type names
   */
  static getAvailableCheckTypes(): string[] {
    const { CheckProviderRegistry } = require('./providers/check-provider-registry');
    const registry = CheckProviderRegistry.getInstance();
    return registry.getAvailableProviders();
  }

  /**
   * Validate check types and return valid/invalid lists
   * @param checks - Array of check type names to validate
   * @returns Object with valid and invalid check types
   */
  static validateCheckTypes(checks: string[]): { valid: string[]; invalid: string[] } {
    const availableTypes = StateMachineExecutionEngine.getAvailableCheckTypes();
    const valid: string[] = [];
    const invalid: string[] = [];

    for (const check of checks) {
      if (availableTypes.includes(check)) {
        valid.push(check);
      } else {
        invalid.push(check);
      }
    }

    return { valid, invalid };
  }

  /**
   * Render check content using the appropriate template
   *
   * This method handles template rendering for check results, supporting:
   * - Plain schema: returns raw content without template processing
   * - Custom templates: from inline content or file
   * - Built-in schema templates: from output/{schema}/template.liquid
   */
  private async renderCheckContent(
    checkName: string,
    reviewSummary: import('./reviewer').ReviewSummary,
    checkConfig: any,
    _prInfo?: PRInfo
  ): Promise<string> {
    // Import the liquid template system
    const { createExtendedLiquid } = await import('./liquid-extensions');
    const fs = await import('fs/promises');
    const path = await import('path');

    // Determine template to use
    const schema = checkConfig.schema || 'plain';
    let templateContent: string;

    if (checkConfig.template) {
      // Custom template
      if (checkConfig.template.content) {
        templateContent = checkConfig.template.content;
      } else if (checkConfig.template.file) {
        // Validate template file path for security
        const templateFile = checkConfig.template.file;

        // Check for absolute paths
        if (path.isAbsolute(templateFile)) {
          throw new Error('Template path must be relative to project directory');
        }

        // Check for .. segments
        if (templateFile.includes('..')) {
          throw new Error('Template path cannot contain ".." segments');
        }

        // Check for home directory references
        if (templateFile.startsWith('~')) {
          throw new Error('Template path cannot reference home directory');
        }

        // Check for null bytes
        if (templateFile.includes('\0')) {
          throw new Error('Template path contains invalid characters');
        }

        // Check for whitespace-only paths
        if (templateFile.trim() === '') {
          throw new Error('Template path must be a non-empty string');
        }

        // Check for .liquid extension
        if (!templateFile.endsWith('.liquid')) {
          throw new Error('Template file must have .liquid extension');
        }

        // Resolve path relative to working directory
        const { GitRepositoryAnalyzer } = await import('./git-repository-analyzer');
        const gitAnalyzer = new GitRepositoryAnalyzer(this.workingDirectory);
        const repoInfo = await gitAnalyzer.analyzeRepository();
        const workingDir = repoInfo.workingDirectory;

        const resolvedPath = path.resolve(workingDir, templateFile);
        templateContent = await fs.readFile(resolvedPath, 'utf-8');
      } else {
        throw new Error('Custom template must specify either "file" or "content"');
      }
    } else if (schema === 'plain') {
      // Plain schema - return raw content directly
      return reviewSummary.issues?.[0]?.message || '';
    } else {
      // Use built-in schema template
      const sanitizedSchema = schema.replace(/[^a-zA-Z0-9-]/g, '');
      if (!sanitizedSchema) {
        throw new Error('Invalid schema name');
      }
      const templatePath = path.join(__dirname, `output/${sanitizedSchema}/template.liquid`);
      templateContent = await fs.readFile(templatePath, 'utf-8');
    }

    // Create liquid instance with extended functionality
    const liquid = createExtendedLiquid({
      trimTagLeft: false,
      trimTagRight: false,
      trimOutputLeft: false,
      trimOutputRight: false,
      greedy: false,
    });

    // Prepare template data
    const templateData = {
      issues: reviewSummary.issues || [],
      checkName: checkName,
    };

    const rendered = await liquid.parseAndRender(templateContent, templateData);
    return rendered.trim();
  }

  /**
   * Format the status column for execution statistics
   * Used by execution-statistics-formatting tests
   */
  private formatStatusColumn(stats: import('./types/execution').CheckExecutionStats): string {
    if (stats.skipped) {
      // Format skip reason
      if (stats.skipReason === 'if_condition') {
        return '⏭ if';
      } else if (stats.skipReason === 'fail_fast') {
        return '⏭ ff';
      } else if (stats.skipReason === 'dependency_failed') {
        return '⏭ dep';
      }
      return '⏭';
    }

    const totalRuns = stats.totalRuns;
    const successfulRuns = stats.successfulRuns;
    const failedRuns = stats.failedRuns;

    if (failedRuns > 0 && successfulRuns > 0) {
      // Mixed results
      return `✔/✖ ${successfulRuns}/${totalRuns}`;
    } else if (failedRuns > 0) {
      // All failed
      return totalRuns === 1 ? '✖' : `✖ ×${totalRuns}`;
    } else {
      // All successful
      return totalRuns === 1 ? '✔' : `✔ ×${totalRuns}`;
    }
  }

  /**
   * Format the details column for execution statistics
   * Used by execution-statistics-formatting tests
   */
  private formatDetailsColumn(stats: import('./types/execution').CheckExecutionStats): string {
    const parts: string[] = [];

    // Add outputs produced
    if (stats.outputsProduced !== undefined && stats.outputsProduced > 0) {
      parts.push(`→${stats.outputsProduced}`);
    }

    // Add critical issues
    if (stats.issuesBySeverity.critical > 0) {
      parts.push(`${stats.issuesBySeverity.critical}🔴`);
    }

    // Add error issues (only if no critical)
    if (stats.issuesBySeverity.error > 0 && stats.issuesBySeverity.critical === 0) {
      parts.push(`${stats.issuesBySeverity.error}❌`);
    }

    // Add warnings
    if (stats.issuesBySeverity.warning > 0) {
      parts.push(`${stats.issuesBySeverity.warning}⚠️`);
    }

    // Add info issues (only if no critical/error/warning)
    if (
      stats.issuesBySeverity.info > 0 &&
      stats.issuesBySeverity.critical === 0 &&
      stats.issuesBySeverity.error === 0 &&
      stats.issuesBySeverity.warning === 0
    ) {
      parts.push(`${stats.issuesBySeverity.info}💡`);
    }

    // Add error message if present
    if (stats.errorMessage) {
      parts.push(this.truncate(stats.errorMessage, 40));
    }

    // Add skip condition if present
    if (stats.skipCondition) {
      parts.push(this.truncate(stats.skipCondition, 40));
    }

    return parts.join(' ');
  }

  /**
   * Truncate a string to a maximum length
   * Used by formatDetailsColumn
   */
  private truncate(str: string, maxLength: number): string {
    if (str.length <= maxLength) {
      return str;
    }
    return str.substring(0, maxLength - 3) + '...';
  }
}
