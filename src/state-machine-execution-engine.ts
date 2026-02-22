import type { CheckExecutionOptions, ExecutionResult } from './types/execution';
import { AnalysisResult } from './output-formatters';
import type { VisorConfig } from './types/config';
import type { PRInfo } from './pr-analyzer';
import { StateMachineRunner } from './state-machine/runner';
import type { EngineContext } from './types/engine';
import { ExecutionJournal } from './snapshot-store';
import { logger } from './logger';
import type { DebugVisualizerServer } from './debug-visualizer/ws-server';
import { SandboxManager } from './sandbox/sandbox-manager';
import * as path from 'path';
import * as fs from 'fs';

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
  private _lastRunner?: StateMachineRunner;

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
    // Extract conversation from options if provided (TUI/CLI mode)
    const optConversation = (options as any)?.conversation;
    if (optConversation) {
      const prev: any = this.executionContext || {};
      this.executionContext = { ...prev, conversation: optConversation };
    }

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

      // If a webhook context is provided (from WebhookServer or Slack socket),
      // attach it to the http_input provider so http_input checks can read data.
      try {
        const map = (options as any)?.webhookContext?.webhookData as
          | Map<string, unknown>
          | undefined;
        if (map) {
          const { CheckProviderRegistry } = await import('./providers/check-provider-registry');
          const reg = CheckProviderRegistry.getInstance();
          const p: any = reg.getProvider('http_input');
          if (p && typeof p.setWebhookContext === 'function') p.setWebhookContext(map);
          const prev: any = this.executionContext || {};
          this.setExecutionContext({ ...prev, webhookContext: { webhookData: map } } as any);
        }
      } catch {}

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

    // Register global custom tools once per run so MCP custom transport can resolve them.
    try {
      const { CheckProviderRegistry } = await import('./providers/check-provider-registry');
      const registry = CheckProviderRegistry.getInstance();
      registry.setCustomTools(configWithTagFilter.tools || {});
    } catch (error) {
      logger.warn(
        `[StateMachine] Failed to register custom tools: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    // Build engine context
    const context = this.buildEngineContext(
      configWithTagFilter,
      prInfo,
      debug,
      maxParallelism,
      failFast,
      checks // Pass the explicit checks list
    );

    // Create SandboxManager if sandboxes are configured
    if (configWithTagFilter.sandboxes && Object.keys(configWithTagFilter.sandboxes).length > 0) {
      try {
        const { execSync } = require('child_process');
        const gitBranch = execSync('git rev-parse --abbrev-ref HEAD', { encoding: 'utf8' }).trim();
        context.sandboxManager = new SandboxManager(
          configWithTagFilter.sandboxes,
          this.workingDirectory,
          gitBranch
        );
      } catch {
        // If git branch detection fails, use 'unknown'
        context.sandboxManager = new SandboxManager(
          configWithTagFilter.sandboxes,
          this.workingDirectory,
          'unknown'
        );
      }
    }

    // Initialize workspace isolation (if enabled)
    const { initializeWorkspace } = require('./state-machine/context/build-engine-context');
    await initializeWorkspace(context);

    // Initialize policy engine (enterprise — dynamic import, no-op if unavailable)
    if (configWithTagFilter.policy?.engine && configWithTagFilter.policy.engine !== 'disabled') {
      try {
        logger.debug(
          `[PolicyEngine] Loading enterprise policy engine (engine=${configWithTagFilter.policy.engine})`
        );
        // @ts-ignore — enterprise/ may not exist in OSS builds (caught at runtime)
        const { loadEnterprisePolicyEngine } = await import('./enterprise/loader');
        context.policyEngine = await loadEnterprisePolicyEngine(configWithTagFilter.policy);
        logger.debug(
          `[PolicyEngine] Initialized: ${context.policyEngine?.constructor?.name || 'unknown'}`
        );
      } catch (err) {
        // Enterprise module not available — continue with no policy engine
        try {
          logger.warn(
            `[PolicyEngine] Enterprise policy engine init failed, using default: ${err instanceof Error ? err.message : err}`
          );
        } catch {}
      }
    }

    // Enrich policy engine with PR context once available
    if (context.policyEngine && 'setActorContext' in context.policyEngine) {
      const actor: any = {
        authorAssociation: prInfo?.authorAssociation || process.env.VISOR_AUTHOR_ASSOCIATION,
        login: prInfo?.author || process.env.GITHUB_ACTOR,
        isLocalMode: !process.env.GITHUB_ACTIONS,
      };

      // Extract Slack identity from webhookData (stashed by socket-runner)
      try {
        const webhookData = (this.executionContext as any)?.webhookContext?.webhookData;
        if (webhookData instanceof Map) {
          const { extractSlackContext } = await import('./slack/schedule-tool-handler');
          const slackCtx = extractSlackContext(webhookData);
          if (slackCtx) {
            // Read pre-fetched user info (stashed by socket-runner)
            const payload = Array.from(webhookData.values())[0] as any;
            const userInfo = payload?.slack_user_info;
            actor.slack = {
              userId: slackCtx.userId,
              channelId: slackCtx.channel,
              channelType: slackCtx.channelType,
              email: userInfo?.email,
            };
          }
        }
      } catch {}

      const pullRequest = prInfo
        ? {
            number: prInfo.number,
            labels: prInfo.labels,
            draft: (prInfo as any).draft,
            changedFiles: prInfo.files?.length,
          }
        : undefined;
      (context.policyEngine as any).setActorContext(actor, undefined, pullRequest);
    }

    // Copy execution context (hooks, etc.) from legacy engine
    context.executionContext = this.getExecutionContext();

    // Store context for later access (e.g., getOutputHistorySnapshot)
    this._lastContext = context;

    // Optionally enable event-driven frontends if configured
    let frontendsHost: any | undefined;
    if (
      Array.isArray((configWithTagFilter as any).frontends) &&
      (configWithTagFilter as any).frontends.length > 0
    ) {
      try {
        const { EventBus } = await import('./event-bus/event-bus');
        const { FrontendsHost } = await import('./frontends/host');
        const bus = new EventBus();
        (context as any).eventBus = bus;
        frontendsHost = new FrontendsHost(bus, logger);
        if (process.env.VISOR_DEBUG === 'true') {
          try {
            const fns = ((configWithTagFilter as any).frontends || []).map((f: any) => ({
              name: f?.name,
              hasConfig: !!f?.config,
              cfg: f?.config || undefined,
            }));
            logger.info(`[Frontends] Loading specs: ${JSON.stringify(fns)}`);
          } catch {}
        }
        await frontendsHost.load((configWithTagFilter as any).frontends);
        // Derive repo/pr/headSha and octokit if available
        let owner: string | undefined;
        let name: string | undefined;
        let prNum: number | undefined;
        let headSha: string | undefined;
        try {
          const anyInfo: any = prInfo as any;
          owner =
            anyInfo?.eventContext?.repository?.owner?.login ||
            process.env.GITHUB_REPOSITORY?.split('/')?.[0];
          name =
            anyInfo?.eventContext?.repository?.name ||
            process.env.GITHUB_REPOSITORY?.split('/')?.[1];
          prNum = typeof anyInfo?.number === 'number' ? anyInfo.number : undefined;
          headSha = anyInfo?.eventContext?.pull_request?.head?.sha || process.env.GITHUB_SHA;
        } catch {}
        const repoObj = owner && name ? { owner, name } : undefined;
        const octokit = (this.executionContext as any)?.octokit;
        // Fallback: if headSha is missing but we have PR info and octokit, fetch it
        if (
          !headSha &&
          repoObj &&
          prNum &&
          octokit &&
          typeof octokit.rest?.pulls?.get === 'function'
        ) {
          try {
            const { data } = await octokit.rest.pulls.get({
              owner: repoObj.owner,
              repo: repoObj.name,
              pull_number: prNum,
            });
            headSha = (data && (data as any).head && (data as any).head.sha) || headSha;
          } catch {
            // ignore; headSha remains undefined
          }
        }
        // Make the event bus available to providers via executionContext
        try {
          const prev: any = this.getExecutionContext() || {};
          this.setExecutionContext({ ...prev, eventBus: bus });
          // Also reflect it into the active engine context so downstream providers see it
          try {
            (context as any).executionContext = this.getExecutionContext();
          } catch {}
        } catch {}

        // Capture trace info while the OTel span is active (before async event handlers lose context)
        let runTraceId: string | undefined;
        try {
          const { trace: lazyTrace, context: lazyCtx } = await import('./telemetry/lazy-otel');
          const activeSpan = lazyTrace.getSpan(lazyCtx.active());
          runTraceId = activeSpan?.spanContext()?.traceId;
        } catch {}

        await frontendsHost.startAll(() => ({
          eventBus: bus,
          logger,
          // Provide the active (possibly tag-filtered) config so frontends can read groups, etc.
          config: configWithTagFilter,
          run: {
            runId: (context as any).sessionId,
            repo: repoObj,
            pr: prNum,
            headSha,
            traceId: runTraceId,
            event: (context as any).event || (prInfo as any)?.eventType,
            actor:
              (prInfo as any)?.eventContext?.sender?.login ||
              (typeof process.env.GITHUB_ACTOR === 'string' ? process.env.GITHUB_ACTOR : undefined),
          },
          octokit,
          webhookContext: (this.executionContext as any)?.webhookContext,
          // Surface any injected test doubles for Slack as well
          slack:
            (this.executionContext as any)?.slack || (this.executionContext as any)?.slackClient,
        }));

        // Phase 1: Snapshot on HumanInputRequested (experimental pause support)
        try {
          bus.on('HumanInputRequested', async (envelope: any) => {
            try {
              const ev = (envelope && envelope.payload) || envelope;
              // Determine channel/thread from event or inbound payload
              let channel: string | undefined = ev?.channel;
              let threadTs: string | undefined = ev?.threadTs;
              if (!channel || !threadTs) {
                try {
                  const anyCfg: any = configWithTagFilter || {};
                  const slackCfg: any = anyCfg.slack || {};
                  const endpoint: string = slackCfg.endpoint || '/bots/slack/support';
                  const map = (this.executionContext as any)?.webhookContext?.webhookData as
                    | Map<string, unknown>
                    | undefined;
                  const payload: any = map?.get(endpoint);
                  const e: any = payload?.event;
                  const derivedTs = String(e?.thread_ts || e?.ts || e?.event_ts || '');
                  const derivedCh = String(e?.channel || '');
                  if (derivedCh && derivedTs) {
                    channel = channel || derivedCh;
                    threadTs = threadTs || derivedTs;
                  }
                } catch {}
              }

              const checkId = String(ev?.checkId || 'unknown');
              const threadKey =
                ev?.threadKey || (channel && threadTs ? `${channel}:${threadTs}` : 'session');
              const baseDir =
                process.env.VISOR_SNAPSHOT_DIR ||
                path.resolve(process.cwd(), '.visor', 'snapshots');
              fs.mkdirSync(baseDir, { recursive: true });
              const filePath = path.join(baseDir, `${threadKey}-${checkId}.json`);
              await this.saveSnapshotToFile(filePath);
              logger.info(`[Snapshot] Saved run snapshot: ${filePath}`);
              try {
                await bus.emit({
                  type: 'SnapshotSaved',
                  checkId: ev?.checkId || 'unknown',
                  channel,
                  threadTs,
                  threadKey,
                  filePath,
                });
              } catch {}
            } catch (e) {
              logger.warn(
                `[Snapshot] Failed to save snapshot on HumanInputRequested: ${
                  e instanceof Error ? e.message : String(e)
                }`
              );
            }
          });
        } catch {}
      } catch (err) {
        logger.warn(
          `[Frontends] Failed to initialize frontends: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    // Create and run state machine with debug server support (M4)
    const runner = new StateMachineRunner(context, this.debugServer);
    this._lastRunner = runner;

    try {
      const result = await runner.run();

      // Stop frontends if started
      if (frontendsHost && typeof frontendsHost.stopAll === 'function') {
        try {
          await frontendsHost.stopAll();
        } catch {}
      }

      if (debug) {
        logger.info('[StateMachine] Execution complete');
      }

      // Post-grouped comments via legacy reviewer is removed; GitHub frontend handles comments

      // Cleanup AI sessions after execution
      try {
        const { SessionRegistry } = await import('./session-registry');
        const sessionRegistry = SessionRegistry.getInstance();
        sessionRegistry.clearAllSessions();
      } catch (error) {
        logger.debug(`[StateMachine] Failed to cleanup sessions: ${error}`);
      }

      // Cleanup policy engine if enabled
      if (context.policyEngine) {
        try {
          await context.policyEngine.shutdown();
        } catch (error) {
          logger.debug(`[StateMachine] Failed to cleanup policy engine: ${error}`);
        }
      }

      // Cleanup workspace if enabled
      if (context.workspace) {
        try {
          await context.workspace.cleanup();
        } catch (error) {
          logger.debug(`[StateMachine] Failed to cleanup workspace: ${error}`);
        }
      }

      return result;
    } finally {
      // Cleanup sandbox containers
      if (context.sandboxManager) {
        await context.sandboxManager.stopAll().catch(err => {
          logger.warn(`Failed to stop sandboxes: ${err}`);
        });
        context.sandboxManager = undefined;
      }
    }
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
    const { buildEngineContextForRun } = require('./state-machine/context/build-engine-context');
    return buildEngineContextForRun(
      this.workingDirectory,
      config,
      prInfo,
      debug,
      maxParallelism,
      failFast,
      requestedChecks
    );
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
      // Skip journal stubs for skipped checks
      try {
        if (entry && typeof entry.result === 'object' && (entry.result as any).__skipped) {
          continue;
        }
      } catch {}

      // Prefer explicit .output; fall back to the full result (issues/content)
      // so tests and templates can reference paths like issues[0].severity for
      // code-review schema steps which do not set a separate output object.
      const payload =
        entry.result.output !== undefined ? entry.result.output : (entry.result as unknown);

      // Filter out forEach aggregation metadata objects (which contain a
      // forEachItems array) to avoid double-counting per-item executions in
      // tests. The actual per-item outputs are committed as separate entries
      // and should be used for history-based assertions and routing.
      try {
        if (
          payload &&
          typeof payload === 'object' &&
          (payload as any).forEachItems &&
          Array.isArray((payload as any).forEachItems)
        ) {
          continue;
        }
      } catch {}

      if (payload !== undefined) outputHistory[checkId].push(payload);
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
   * Save a JSON snapshot of the last run's state and journal to a file (experimental).
   * Does not include secrets. Intended for debugging and future resume support.
   */
  public async saveSnapshotToFile(filePath: string): Promise<void> {
    const fs = await import('fs/promises');
    const ctx = this._lastContext;
    const runner = this._lastRunner;
    if (!ctx || !runner) {
      throw new Error('No prior execution context to snapshot');
    }
    const journal = (ctx as any).journal as ExecutionJournal;
    const snapshotId = journal.beginSnapshot();
    const entries = journal.readVisible(ctx.sessionId, snapshotId, undefined);
    const state = runner.getState();
    const serializableState = serializeRunState(state);
    const payload = {
      version: 1,
      sessionId: ctx.sessionId,
      event: ctx.event,
      wave: state.wave,
      state: serializableState,
      journal: entries,
      requestedChecks: (ctx as any).requestedChecks || [],
    } as const;
    await fs.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf8');
  }

  /**
   * Load a snapshot JSON from file and return it. Resume support can build on this.
   */
  public async loadSnapshotFromFile<T = unknown>(filePath: string): Promise<T> {
    const fs = await import('fs/promises');
    const raw = await fs.readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
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
    const { convertToReviewSummary } = require('./state-machine/execution/summary');
    return (convertToReviewSummary as any)(groupedResults as any, statistics as any) as any;
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

/** Convert RunState with Maps/Sets into a JSON-safe form */
function serializeRunState(state: import('./types/engine').RunState) {
  return {
    ...state,
    levelQueue: state.levelQueue,
    eventQueue: state.eventQueue,
    activeDispatches: Array.from(state.activeDispatches.entries()),
    completedChecks: Array.from(state.completedChecks.values()),
    stats: Array.from(state.stats.entries()),
    historyLog: state.historyLog,
    forwardRunGuards: Array.from(state.forwardRunGuards.values()),
    currentLevelChecks: Array.from(state.currentLevelChecks.values()),
    currentWaveCompletions: Array.from(
      ((state as any).currentWaveCompletions as Set<string> | undefined) || []
    ),
    // failedChecks is an internal Set added by stats/dispatch layers; keep it if present
    failedChecks: Array.from(((state as any).failedChecks as Set<string> | undefined) || []),
    pendingRunScopes: Array.from((state.pendingRunScopes || new Map()).entries()).map(([k, v]) => [
      k,
      v,
    ]),
  };
}

export type SnapshotJson = {
  version: number;
  sessionId: string;
  event?: import('./types/config').EventTrigger;
  wave?: number;
  state: any;
  journal: import('./snapshot-store').JournalEntry[];
  requestedChecks?: string[];
  meta?: Record<string, unknown>;
};

/**
 * Resume execution from a previously saved snapshot (experimental).
 * Frontends are started to mirror executeGroupedChecks behavior so integrations
 * like Slack can handle CheckCompleted/HumanInputRequested events during resume.
 */
export async function resumeFromSnapshot(
  engine: StateMachineExecutionEngine,
  snapshot: SnapshotJson,
  config: VisorConfig,
  opts?: { debug?: boolean; maxParallelism?: number; failFast?: boolean; webhookContext?: any }
): Promise<import('./types/execution').ExecutionResult> {
  // Recompute PRInfo from the current repository
  const { GitRepositoryAnalyzer } = await import('./git-repository-analyzer');
  const analyzer = new GitRepositoryAnalyzer(process.cwd());
  const repoInfo = await analyzer.analyzeRepository();
  const prInfo = analyzer.toPRInfo(repoInfo);

  const context = (engine as any).buildEngineContext(
    config,
    prInfo,
    opts?.debug,
    opts?.maxParallelism,
    opts?.failFast,
    snapshot.requestedChecks
  ) as import('./types/engine').EngineContext;

  // Initialize workspace isolation (if enabled) - same as executeGroupedChecks
  const { initializeWorkspace } = require('./state-machine/context/build-engine-context');
  await initializeWorkspace(context);

  // Propagate existing executionContext (hooks, octokit, webhookContext, slack, etc.)
  try {
    const prevExecCtx: any = (engine as any).getExecutionContext?.() || {};
    (context as any).executionContext = prevExecCtx;
  } catch {}

  // Restore journal entries
  try {
    const journal = (context as any).journal as ExecutionJournal;
    for (const e of snapshot.journal || []) {
      journal.commitEntry({
        // Re-hydrate all entries under the NEW sessionId for this resume run.
        // This ensures helpers like output history and chat_history see both
        // pre-snapshot and post-resume outputs as a single logical session.
        sessionId: (context as any).sessionId,
        scope: e.scope,
        checkId: e.checkId,
        result: e.result,
        event: e.event,
      });
    }
  } catch {}

  // Adopt webhookContext and other execution context patches if provided
  try {
    const prev: any = (engine as any).getExecutionContext?.() || {};
    (engine as any).setExecutionContext?.({ ...prev, webhookContext: opts?.webhookContext });
    // Reflect merged executionContext into active engine context
    try {
      (context as any).executionContext = (engine as any).getExecutionContext?.();
    } catch {}
  } catch {}

  // Optional frontends (Slack, GitHub, etc.) – mirror executeGroupedChecks
  let frontendsHost: any | undefined;
  if (Array.isArray((config as any).frontends) && (config as any).frontends.length > 0) {
    try {
      const { EventBus } = await import('./event-bus/event-bus');
      const { FrontendsHost } = await import('./frontends/host');
      const bus = new EventBus();
      (context as any).eventBus = bus;
      frontendsHost = new FrontendsHost(bus, logger);

      if (process.env.VISOR_DEBUG === 'true') {
        try {
          const fns = ((config as any).frontends || []).map((f: any) => ({
            name: f?.name,
            hasConfig: !!f?.config,
            cfg: f?.config || undefined,
          }));
          logger.info(`[Frontends] Loading specs: ${JSON.stringify(fns)}`);
        } catch {}
      }

      await frontendsHost.load((config as any).frontends);

      // Derive repo/pr/headSha and octokit if available
      let owner: string | undefined;
      let name: string | undefined;
      let prNum: number | undefined;
      let headSha: string | undefined;
      try {
        const anyInfo: any = prInfo as any;
        owner =
          anyInfo?.eventContext?.repository?.owner?.login ||
          process.env.GITHUB_REPOSITORY?.split('/')?.[0];
        name =
          anyInfo?.eventContext?.repository?.name || process.env.GITHUB_REPOSITORY?.split('/')?.[1];
        prNum = typeof anyInfo?.number === 'number' ? anyInfo.number : undefined;
        headSha = anyInfo?.eventContext?.pull_request?.head?.sha || process.env.GITHUB_SHA;
      } catch {}
      const repoObj = owner && name ? { owner, name } : undefined;
      const octokit = (engine as any).getExecutionContext?.()?.octokit;

      // Fallback: if headSha is missing but we have PR info and octokit, fetch it
      if (
        !headSha &&
        repoObj &&
        prNum &&
        octokit &&
        typeof octokit.rest?.pulls?.get === 'function'
      ) {
        try {
          const { data } = await octokit.rest.pulls.get({
            owner: repoObj.owner,
            repo: repoObj.name,
            pull_number: prNum,
          });
          headSha = (data && (data as any).head && (data as any).head.sha) || headSha;
        } catch {
          // ignore; headSha remains undefined
        }
      }

      // Make the event bus available to providers via executionContext
      try {
        const prevExec: any = (engine as any).getExecutionContext?.() || {};
        (engine as any).setExecutionContext?.({ ...prevExec, eventBus: bus });
        try {
          (context as any).executionContext = (engine as any).getExecutionContext?.();
        } catch {}
      } catch {}

      // Capture trace info while the OTel span is active
      let resumeTraceId: string | undefined;
      try {
        const { trace: lazyTrace, context: lazyCtx } = await import('./telemetry/lazy-otel');
        const activeSpan = lazyTrace.getSpan(lazyCtx.active());
        resumeTraceId = activeSpan?.spanContext()?.traceId;
      } catch {}

      await frontendsHost.startAll(() => ({
        eventBus: bus,
        logger,
        // Provide the active config so frontends can read groups, etc.
        config,
        run: {
          runId: (context as any).sessionId,
          repo: repoObj,
          pr: prNum,
          headSha,
          traceId: resumeTraceId,
          event: (context as any).event || (prInfo as any)?.eventType,
          actor:
            (prInfo as any)?.eventContext?.sender?.login ||
            (typeof process.env.GITHUB_ACTOR === 'string' ? process.env.GITHUB_ACTOR : undefined),
        },
        octokit,
        webhookContext: (engine as any).getExecutionContext?.()?.webhookContext,
        // Surface any injected test doubles for Slack as well
        slack:
          (engine as any).getExecutionContext?.()?.slack ||
          (engine as any).getExecutionContext?.()?.slackClient,
      }));

      // Snapshot-on-human-input support for resumed runs
      try {
        bus.on('HumanInputRequested', async (envelope: any) => {
          try {
            const ev = (envelope && envelope.payload) || envelope;
            // Determine channel/thread from event or inbound payload
            let channel: string | undefined = ev?.channel;
            let threadTs: string | undefined = ev?.threadTs;
            if (!channel || !threadTs) {
              try {
                const anyCfg: any = config || {};
                const slackCfg: any = anyCfg.slack || {};
                const endpoint: string = slackCfg.endpoint || '/bots/slack/support';
                const map = (engine as any).getExecutionContext?.()?.webhookContext?.webhookData as
                  | Map<string, unknown>
                  | undefined;
                const payload: any = map?.get(endpoint);
                const e: any = payload?.event;
                const derivedTs = String(e?.thread_ts || e?.ts || e?.event_ts || '');
                const derivedCh = String(e?.channel || '');
                if (derivedCh && derivedTs) {
                  channel = channel || derivedCh;
                  threadTs = threadTs || derivedTs;
                }
              } catch {}
            }

            const checkId = String(ev?.checkId || 'unknown');
            const threadKey =
              ev?.threadKey || (channel && threadTs ? `${channel}:${threadTs}` : 'session');
            const baseDir =
              process.env.VISOR_SNAPSHOT_DIR || path.resolve(process.cwd(), '.visor', 'snapshots');
            fs.mkdirSync(baseDir, { recursive: true });
            const filePath = path.join(baseDir, `${threadKey}-${checkId}.json`);
            await engine.saveSnapshotToFile(filePath);
            logger.info(`[Snapshot] Saved run snapshot: ${filePath}`);
            try {
              await bus.emit({
                type: 'SnapshotSaved',
                checkId: ev?.checkId || 'unknown',
                channel,
                threadTs,
                threadKey,
                filePath,
              });
            } catch {}
          } catch (e) {
            logger.warn(
              `[Snapshot] Failed to save snapshot on HumanInputRequested: ${
                e instanceof Error ? e.message : String(e)
              }`
            );
          }
        });
      } catch {}
    } catch (err) {
      logger.warn(
        `[Frontends] Failed to initialize frontends (resumeFromSnapshot): ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  // Create runner and hydrate state
  // For resume flows, we treat the snapshot's journal as prior history and
  // start a fresh run from the normal Init → PlanReady → WavePlanning cycle.
  // This avoids resuming mid-wave and accidentally re-running stale checks
  // (e.g., chat replies) before new input is incorporated.
  const runner = new (require('./state-machine/runner').StateMachineRunner)(
    context,
    (engine as any).debugServer
  );
  (engine as any)._lastContext = context;
  (engine as any)._lastRunner = runner;

  const result = await runner.run();

  // Stop frontends if started
  if (frontendsHost && typeof frontendsHost.stopAll === 'function') {
    try {
      await frontendsHost.stopAll();
    } catch {}
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
