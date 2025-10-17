import {
  PRReviewer,
  ReviewSummary,
  ReviewOptions,
  GroupedCheckResults,
  CheckResult,
  ReviewIssue,
} from './reviewer';
import { GitRepositoryAnalyzer, GitRepositoryInfo } from './git-repository-analyzer';
import { AnalysisResult } from './output-formatters';
import { PRInfo } from './pr-analyzer';
import { PRAnalyzer } from './pr-analyzer';
import { CheckProviderRegistry } from './providers/check-provider-registry';
import { CheckProviderConfig } from './providers/check-provider.interface';
import { DependencyResolver, DependencyGraph } from './dependency-resolver';
import { FailureConditionEvaluator } from './failure-condition-evaluator';
import { FailureConditionResult, CheckConfig } from './types/config';
import { GitHubCheckService, CheckRunOptions } from './github-check-service';
import { IssueFilter } from './issue-filter';
import { logger } from './logger';
import Sandbox from '@nyariv/sandboxjs';
import { VisorConfig, OnFailConfig, OnSuccessConfig, OnFinishConfig } from './types/config';
import {
  createPermissionHelpers,
  detectLocalMode,
  resolveAssociationFromEvent,
} from './utils/author-permissions';
import { MemoryStore } from './memory-store';
import { emitNdjsonSpanWithEvents, emitNdjsonFallback } from './telemetry/fallback-ndjson';
import { addEvent } from './telemetry/trace-helpers';
import { addFailIfTriggered } from './telemetry/metrics';

type ExtendedReviewSummary = ReviewSummary & {
  output?: unknown;
  content?: string;
  isForEach?: boolean;
  forEachItems?: unknown[];
  // Preserve per-item results for forEach-dependent checks so children can gate per item
  forEachItemResults?: ReviewSummary[];
  // Per-item fatal mask: true means this item is fatal/should gate descendants
  forEachFatalMask?: boolean[];
};

/**
 * Statistics for a single check execution
 */
export interface CheckExecutionStats {
  checkName: string;
  totalRuns: number; // How many times the check executed (1 or forEach iterations)
  successfulRuns: number;
  failedRuns: number;
  skipped: boolean;
  skipReason?: 'if_condition' | 'fail_fast' | 'dependency_failed';
  skipCondition?: string; // The actual if condition text
  totalDuration: number; // Total duration in milliseconds
  perIterationDuration?: number[]; // Duration for each iteration (if forEach)
  issuesFound: number;
  issuesBySeverity: {
    critical: number;
    error: number;
    warning: number;
    info: number;
  };
  outputsProduced?: number; // Number of outputs for forEach checks
  errorMessage?: string; // Error message if failed
  forEachPreview?: string[]; // Preview of forEach items processed (first few)
}

/**
 * Overall execution statistics for all checks
 */
export interface ExecutionStatistics {
  totalChecksConfigured: number;
  totalExecutions: number; // Sum of all runs including forEach iterations
  successfulExecutions: number;
  failedExecutions: number;
  skippedChecks: number;
  totalDuration: number;
  checks: CheckExecutionStats[];
}

/**
 * Result of executing checks, including both the grouped results and execution statistics
 */
export interface ExecutionResult {
  results: GroupedCheckResults;
  statistics: ExecutionStatistics;
}

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
  private routingSandbox?: Sandbox;
  private executionStats: Map<string, CheckExecutionStats> = new Map();
  // Track history of all outputs for each check (useful for loops and goto)
  private outputHistory: Map<string, unknown[]> = new Map();
  // Event override to simulate alternate event (used during routing goto)
  private routingEventOverride?: import('./types/config').EventTrigger;
  // Cached GitHub context for context elevation when running in Actions
  private actionContext?: {
    owner: string;
    repo: string;
    octokit?: import('@octokit/rest').Octokit;
  };

  constructor(workingDirectory?: string, octokit?: import('@octokit/rest').Octokit) {
    this.workingDirectory = workingDirectory || process.cwd();
    this.gitAnalyzer = new GitRepositoryAnalyzer(this.workingDirectory);
    this.providerRegistry = CheckProviderRegistry.getInstance();
    this.failureEvaluator = new FailureConditionEvaluator();

    // If authenticated octokit is provided, cache it for provider use
    if (octokit) {
      const repoEnv = process.env.GITHUB_REPOSITORY || '';
      const [owner, repo] = repoEnv.split('/') as [string, string];
      if (owner && repo) {
        this.actionContext = { owner, repo, octokit };
      }
    }

    // Create a mock Octokit instance for local analysis
    // This allows us to reuse the existing PRReviewer logic without network calls
    this.mockOctokit = this.createMockOctokit();
    this.reviewer = new PRReviewer(this.mockOctokit as unknown as import('@octokit/rest').Octokit);
  }

  /**
   * Enrich event context with authenticated octokit instance
   * @param eventContext - The event context to enrich
   * @returns Enriched event context with octokit if available
   */
  private enrichEventContext(eventContext?: Record<string, unknown>): Record<string, unknown> {
    const baseContext = eventContext || {};
    if (this.actionContext?.octokit) {
      return { ...baseContext, octokit: this.actionContext.octokit };
    }
    return baseContext;
  }

  /**
   * Lazily create a secure sandbox for routing JS (goto_js, run_js)
   */
  private getRoutingSandbox(): Sandbox {
    if (this.routingSandbox) return this.routingSandbox;
    const globals = {
      ...Sandbox.SAFE_GLOBALS,
      Math,
      JSON,
      console: { log: console.log },
    };
    const prototypeWhitelist = new Map(Sandbox.SAFE_PROTOTYPES);
    this.routingSandbox = new Sandbox({ globals, prototypeWhitelist });
    return this.routingSandbox;
  }

  private redact(str: unknown, limit = 200): string {
    try {
      const s = typeof str === 'string' ? str : JSON.stringify(str);
      return s.length > limit ? s.slice(0, limit) + '…' : s;
    } catch {
      return String(str).slice(0, limit);
    }
  }

  private async sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private deterministicJitter(baseMs: number, seedStr: string): number {
    let h = 2166136261;
    for (let i = 0; i < seedStr.length; i++) h = (h ^ seedStr.charCodeAt(i)) * 16777619;
    const frac = ((h >>> 0) % 1000) / 1000; // 0..1
    return Math.floor(baseMs * 0.15 * frac); // up to 15% jitter
  }

  private computeBackoffDelay(
    attempt: number,
    mode: 'fixed' | 'exponential',
    baseMs: number,
    seed: string
  ): number {
    const jitter = this.deterministicJitter(baseMs, seed);
    if (mode === 'exponential') {
      return baseMs * Math.pow(2, Math.max(0, attempt - 1)) + jitter;
    }
    return baseMs + jitter;
  }

  /**
   * Execute a single named check inline (used by routing logic and on_finish)
   * This is extracted from executeWithRouting to be reusable
   */
  private async executeCheckInline(
    checkId: string,
    event: import('./types/config').EventTrigger,
    context: {
      config: VisorConfig;
      dependencyGraph: DependencyGraph;
      prInfo: PRInfo;
      resultsMap: Map<string, ReviewSummary>;
      dependencyResults: Map<string, ReviewSummary>;
      sessionInfo?: { parentSessionId?: string; reuseSession?: boolean };
      debug: boolean;
      eventOverride?: import('./types/config').EventTrigger;
    }
  ): Promise<ReviewSummary> {
    const { config, prInfo, resultsMap, dependencyResults, sessionInfo, debug, eventOverride } =
      context;
    const log = (msg: string) => (config?.output?.pr_comment ? console.error : console.log)(msg);

    // Find the check configuration
    const checkConfig = config?.checks?.[checkId];
    if (!checkConfig) {
      throw new Error(`on_finish referenced unknown check '${checkId}'`);
    }

    // Helper to get all dependencies recursively from config
    const getAllDepsFromConfig = (name: string): string[] => {
      const visited = new Set<string>();
      const acc: string[] = [];
      const dfs = (n: string) => {
        if (visited.has(n)) return;
        visited.add(n);
        const cfg = config?.checks?.[n];
        const deps = cfg?.depends_on || [];
        for (const d of deps) {
          acc.push(d);
          dfs(d);
        }
      };
      dfs(name);
      return Array.from(new Set(acc));
    };

    // Ensure all dependencies of target are available; execute missing ones in topological order
    const allTargetDeps = getAllDepsFromConfig(checkId);
    if (allTargetDeps.length > 0) {
      // Build subgraph mapping for ordered execution
      const subSet = new Set<string>([...allTargetDeps]);
      const subDeps: Record<string, string[]> = {};
      for (const id of subSet) {
        const cfg = config?.checks?.[id];
        subDeps[id] = (cfg?.depends_on || []).filter(d => subSet.has(d));
      }
      const subGraph = DependencyResolver.buildDependencyGraph(subDeps);
      for (const group of subGraph.executionOrder) {
        for (const depId of group.parallel) {
          // Skip if already have results
          if (resultsMap?.has(depId) || dependencyResults.has(depId)) continue;
          // Execute dependency inline (recursively ensures its deps are also present)
          await this.executeCheckInline(depId, event, context);
        }
      }
    }

    // Get provider for this check
    const providerType = checkConfig.type || 'ai';
    const provider = this.providerRegistry.getProviderOrThrow(providerType);
    this.setProviderWebhookContext(provider);

    // Build provider configuration
    const provCfg: CheckProviderConfig = {
      type: providerType,
      prompt: checkConfig.prompt,
      exec: checkConfig.exec,
      focus: checkConfig.focus || this.mapCheckNameToFocus(checkId),
      schema: checkConfig.schema,
      group: checkConfig.group,
      checkName: checkId,
      eventContext: this.enrichEventContext(prInfo.eventContext),
      transform: checkConfig.transform,
      transform_js: checkConfig.transform_js,
      env: checkConfig.env,
      forEach: checkConfig.forEach,
      // Pass output history for loop/goto scenarios
      __outputHistory: this.outputHistory,
      // Include provider-specific keys (e.g., op/values for github)
      ...checkConfig,
      ai: {
        ...(checkConfig.ai || {}),
        timeout: checkConfig.ai?.timeout || 600000,
        debug: !!debug,
      },
    };

    // Build dependency results for this check
    const targetDeps = getAllDepsFromConfig(checkId);
    const depResults = new Map<string, ReviewSummary>();
    for (const depId of targetDeps) {
      // Prefer per-scope dependencyResults (e.g., forEach item context) over global results
      const res = dependencyResults.get(depId) || resultsMap?.get(depId);
      if (res) depResults.set(depId, res);
    }

    // Debug: log key dependent outputs for visibility
    if (debug) {
      try {
        const depPreview: Record<string, unknown> = {};
        for (const [k, v] of depResults.entries()) {
          const out = (v as any)?.output;
          if (out !== undefined) depPreview[k] = out;
        }
        log(`🔧 Debug: inline exec '${checkId}' deps output: ${JSON.stringify(depPreview)}`);
      } catch {}
    }

    if (debug) {
      const execStr = (provCfg as any).exec;
      if (execStr) log(`🔧 Debug: inline exec '${checkId}' command: ${execStr}`);
    }

    // If event override provided, clone prInfo with overridden eventType
    let prInfoForInline = prInfo;
    const prevEventOverride = this.routingEventOverride;
    if (eventOverride) {
      // Try to elevate to PR context when routing to PR events from issue threads
      const elevated = await this.elevateContextToPullRequest(
        { ...(prInfo as any), eventType: eventOverride } as PRInfo,
        eventOverride,
        log,
        debug
      );
      if (elevated) {
        prInfoForInline = elevated;
      } else {
        prInfoForInline = { ...(prInfo as any), eventType: eventOverride } as PRInfo;
      }
      this.routingEventOverride = eventOverride;
      const msg = `↪ goto_event: inline '${checkId}' with event=${eventOverride}${
        elevated ? ' (elevated to PR context)' : ''
      }`;
      if (debug) log(`🔧 Debug: ${msg}`);
      try {
        require('./logger').logger.info(msg);
      } catch {}
    }

    // Execute the check
    let result: ReviewSummary;
    try {
      result = await provider.execute(prInfoForInline, provCfg, depResults, sessionInfo);
    } catch (error) {
      // Restore previous override before rethrowing
      this.routingEventOverride = prevEventOverride;
      throw error;
    } finally {
      // Always restore previous override
      this.routingEventOverride = prevEventOverride;
    }

    // Enrich issues with metadata
    const enrichedIssues = (result.issues || []).map(issue => ({
      ...issue,
      checkName: checkId,
      ruleId: `${checkId}/${issue.ruleId}`,
      group: checkConfig.group,
      schema: typeof checkConfig.schema === 'object' ? 'custom' : checkConfig.schema,
      template: checkConfig.template,
      timestamp: Date.now(),
    }));
    let enriched = { ...result, issues: enrichedIssues } as ReviewSummary;

    // Track output history for loop/goto scenarios
    const enrichedWithOutput = enriched as ReviewSummary & { output?: unknown };
    if (enrichedWithOutput.output !== undefined) {
      this.trackOutputHistory(checkId, enrichedWithOutput.output);
    }

    // Handle forEach iteration for this check if it returned an array
    if (checkConfig.forEach && Array.isArray(enrichedWithOutput.output)) {
      const forEachItems = enrichedWithOutput.output;
      if (debug) {
        log(`🔧 Debug: forEach check '${checkId}' returned ${forEachItems.length} items`);
      }

      // Store the array output with forEach metadata
      const forEachResult = {
        ...enriched,
        forEachItems,
        forEachItemResults: forEachItems.map((item, idx) => ({
          issues: [],
          output: item,
        })),
      };
      enriched = forEachResult as ReviewSummary;

      // Find checks that depend on this forEach check
      const dependentChecks = Object.keys(config?.checks || {}).filter(name => {
        const cfg = config?.checks?.[name];
        return cfg?.depends_on?.includes(checkId);
      });

      if (debug && dependentChecks.length > 0) {
        log(
          `🔧 Debug: forEach check '${checkId}' has ${dependentChecks.length} dependents: ${dependentChecks.join(', ')}`
        );
      }

      // Execute each dependent check once per forEach item
      for (const depCheckName of dependentChecks) {
        const depCheckConfig = config?.checks?.[depCheckName];
        if (!depCheckConfig) continue;

        // Skip if dependent already executed
        if (resultsMap?.has(depCheckName)) continue;

        if (debug) {
          log(
            `🔧 Debug: Executing forEach dependent '${depCheckName}' for ${forEachItems.length} items`
          );
        }

        const depResults: ReviewSummary[] = [];

        // Execute once per forEach item
        for (let itemIndex = 0; itemIndex < forEachItems.length; itemIndex++) {
          const item = forEachItems[itemIndex];

          // Create isolated dependency results with this specific item
          const itemDependencyResults = new Map(dependencyResults);

          // Unwrap forEach parent to provide just this item
          const itemResult: ReviewSummary & { output?: unknown } = {
            issues: [],
            output: item,
          };
          itemDependencyResults.set(checkId, itemResult);

          // Execute the dependent check with this item's context
          const itemContext = {
            ...context,
            dependencyResults: itemDependencyResults,
          };

          try {
            const depResult = await this.executeCheckInline(depCheckName, event, itemContext);
            depResults.push(depResult);
          } catch (error) {
            // Store error result for this iteration
            const errorMsg = error instanceof Error ? error.message : String(error);
            const errorIssue: ReviewIssue = {
              file: '',
              line: 0,
              ruleId: `${depCheckName}/forEach/iteration_error`,
              message: `forEach iteration ${itemIndex + 1} failed: ${errorMsg}`,
              severity: 'error',
              category: 'logic',
            };
            depResults.push({
              issues: [errorIssue],
            });
          }
        }

        // Aggregate results from all iterations
        const aggregatedResult: ReviewSummary = {
          issues: depResults.flatMap(r => r.issues || []),
        };

        // Store in results map
        resultsMap?.set(depCheckName, aggregatedResult);

        if (debug) {
          log(
            `🔧 Debug: Completed forEach dependent '${depCheckName}' with ${depResults.length} iterations`
          );
        }
      }
    }

    // Store result in results map
    resultsMap?.set(checkId, enriched);

    if (debug) log(`🔧 Debug: inline executed '${checkId}', issues: ${enrichedIssues.length}`);

    return enriched;
  }

  /**
   * Handle on_finish hooks for forEach checks after ALL dependents complete
   */
  private async handleOnFinishHooks(
    config: VisorConfig,
    dependencyGraph: DependencyGraph,
    results: Map<string, ReviewSummary>,
    prInfo: PRInfo,
    debug: boolean
  ): Promise<void> {
    const log = (msg: string) => (config?.output?.pr_comment ? console.error : console.log)(msg);

    // Find all checks with forEach: true and on_finish configured
    const forEachChecksWithOnFinish: Array<{
      checkName: string;
      checkConfig: CheckConfig;
      onFinish: OnFinishConfig;
    }> = [];

    for (const [checkName, checkConfig] of Object.entries(config.checks)) {
      if (checkConfig.forEach && checkConfig.on_finish) {
        forEachChecksWithOnFinish.push({
          checkName,
          checkConfig,
          onFinish: checkConfig.on_finish,
        });
      }
    }

    if (forEachChecksWithOnFinish.length === 0) {
      return; // No on_finish hooks to process
    }

    if (debug) {
      log(`🎯 Processing on_finish hooks for ${forEachChecksWithOnFinish.length} forEach check(s)`);
    }

    // Process each forEach check's on_finish hook
    for (const { checkName, checkConfig, onFinish } of forEachChecksWithOnFinish) {
      try {
        const forEachResult = results.get(checkName) as ExtendedReviewSummary | undefined;
        if (!forEachResult) {
          if (debug) log(`⚠️ No result found for forEach check "${checkName}", skipping on_finish`);
          continue;
        }

        // Skip if the forEach check returned empty array
        const forEachItems = forEachResult.forEachItems || [];
        if (forEachItems.length === 0) {
          if (debug) log(`⏭  Skipping on_finish for "${checkName}" - forEach returned 0 items`);
          continue;
        }

        // Get all dependents of this forEach check
        const node = dependencyGraph.nodes.get(checkName);
        const dependents = node?.dependents || [];

        if (debug) {
          log(`🔍 on_finish for "${checkName}": ${dependents.length} dependent(s)`);
        }

        // Verify all dependents have completed
        const allDependentsCompleted = dependents.every(dep => results.has(dep));
        if (!allDependentsCompleted) {
          if (debug) log(`⚠️ Not all dependents of "${checkName}" completed, skipping on_finish`);
          continue;
        }

        logger.info(`▶ on_finish: processing for "${checkName}"`);

        // Build context for on_finish evaluation
        const outputsForContext: Record<string, unknown> = {};
        for (const [name, result] of results.entries()) {
          outputsForContext[name] = (result as any).output;
        }

        // Create forEach stats
        const forEachStats = {
          total: forEachItems.length,
          successful: forEachResult.forEachItemResults
            ? forEachResult.forEachItemResults.filter(
                r => r && (!r.issues || r.issues.length === 0)
              ).length
            : forEachItems.length,
          failed: forEachResult.forEachItemResults
            ? forEachResult.forEachItemResults.filter(r => r && r.issues && r.issues.length > 0)
                .length
            : 0,
          items: forEachItems,
        };

        // Get memory store for context
        const memoryStore = MemoryStore.getInstance(this.config?.memory);
        const memoryHelpers = {
          get: (key: string, ns?: string) => memoryStore.get(key, ns),
          has: (key: string, ns?: string) => memoryStore.has(key, ns),
          list: (ns?: string) => memoryStore.list(ns),
          getAll: (ns?: string) => {
            const keys = memoryStore.list(ns);
            const result: Record<string, unknown> = {};
            for (const key of keys) {
              result[key] = memoryStore.get(key, ns);
            }
            return result;
          },
          set: (key: string, value: unknown, ns?: string) => {
            const nsName = ns || memoryStore.getDefaultNamespace();
            if (!memoryStore['data'].has(nsName)) {
              memoryStore['data'].set(nsName, new Map());
            }
            memoryStore['data'].get(nsName)!.set(key, value);
          },
          increment: (key: string, amount: number, ns?: string) => {
            const current = memoryStore.get(key, ns);
            const numCurrent = typeof current === 'number' ? current : 0;
            const newValue = numCurrent + amount;
            const nsName = ns || memoryStore.getDefaultNamespace();
            if (!memoryStore['data'].has(nsName)) {
              memoryStore['data'].set(nsName, new Map());
            }
            memoryStore['data'].get(nsName)!.set(key, newValue);
            return newValue;
          },
        };

        // Build full context for on_finish evaluation
        const onFinishContext = {
          step: { id: checkName, tags: checkConfig.tags || [], group: checkConfig.group },
          attempt: 1,
          loop: 0,
          outputs: outputsForContext,
          forEach: forEachStats,
          memory: memoryHelpers,
          pr: {
            number: prInfo.number,
            title: prInfo.title,
            author: prInfo.author,
            branch: prInfo.head,
            base: prInfo.base,
          },
          files: prInfo.files,
          env: getSafeEnvironmentVariables(),
          event: { name: prInfo.eventType || 'manual' },
        };

        // Execute on_finish.run checks sequentially
        if (onFinish.run && onFinish.run.length > 0) {
          logger.info(
            `▶ on_finish.run: executing [${onFinish.run.join(', ')}] for "${checkName}"`
          );

          try {
            for (const runCheckId of onFinish.run) {
              if (debug) {
                log(`🔧 Debug: on_finish.run executing check '${runCheckId}'`);
              }

              logger.info(`  ▶ Executing on_finish check: ${runCheckId}`);

              // Build execution context for inline check
              const executionContext = {
                config,
                dependencyGraph,
                prInfo,
                resultsMap: results,
                dependencyResults: new Map(results), // Use all results as dependencies
                sessionInfo: undefined,
                debug,
                eventOverride: onFinish.goto_event,
              };

              // Execute the check inline
              await this.executeCheckInline(
                runCheckId,
                onFinish.goto_event || prInfo.eventType || 'manual',
                executionContext
              );

              logger.info(`  ✓ Completed on_finish check: ${runCheckId}`);
            }

            logger.info(`✓ on_finish.run: completed for "${checkName}"`);
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            logger.error(`✗ on_finish.run: failed for "${checkName}": ${errorMsg}`);
            if (error instanceof Error && error.stack) {
              logger.debug(`Stack trace: ${error.stack}`);
            }
            throw error;
          }
        }

        // Evaluate on_finish.goto_js for routing decision
        let gotoTarget: string | null = null;

        if (onFinish.goto_js) {
          logger.info(`▶ on_finish.goto_js: evaluating for "${checkName}"`);

          try {
            const sandbox = this.getRoutingSandbox();
            const scope = onFinishContext;

            const code = `
              const step = scope.step; const attempt = scope.attempt; const loop = scope.loop; const outputs = scope.outputs; const forEach = scope.forEach; const memory = scope.memory; const pr = scope.pr; const files = scope.files; const env = scope.env; const event = scope.event; const log = (...a)=>console.log('🔍 Debug:',...a);
              const __fn = () => {\n${onFinish.goto_js}\n};
              const __res = __fn();
              return (typeof __res === 'string' && __res) ? __res : null;
            `;

            const exec = sandbox.compile(code);
            const result = exec({ scope }).run();
            gotoTarget = typeof result === 'string' && result ? result : null;

            if (debug) {
              log(`🔧 Debug: on_finish.goto_js evaluated → ${this.redact(gotoTarget)}`);
            }

            logger.info(
              `✓ on_finish.goto_js: evaluated to '${gotoTarget || 'null'}' for "${checkName}"`
            );
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            logger.error(`✗ on_finish.goto_js: evaluation failed for "${checkName}": ${errorMsg}`);
            if (error instanceof Error && error.stack) {
              logger.debug(`Stack trace: ${error.stack}`);
            }

            // Fallback to static goto if goto_js fails
            if (onFinish.goto) {
              logger.info(`  ⚠ Falling back to static goto: '${onFinish.goto}'`);
              gotoTarget = onFinish.goto;
            }
          }
        } else if (onFinish.goto) {
          // Static goto
          gotoTarget = onFinish.goto;
          logger.info(`▶ on_finish.goto: routing to '${gotoTarget}' for "${checkName}"`);
        }

        // Execute routing if we have a target
        if (gotoTarget) {
          logger.info(`▶ on_finish: routing from "${checkName}" to "${gotoTarget}"`);

          try {
            // Build execution context for goto target
            const executionContext = {
              config,
              dependencyGraph,
              prInfo,
              resultsMap: results,
              dependencyResults: new Map(results),
              sessionInfo: undefined,
              debug,
              eventOverride: onFinish.goto_event,
            };

            // Execute the goto target inline
            await this.executeCheckInline(
              gotoTarget,
              onFinish.goto_event || prInfo.eventType || 'manual',
              executionContext
            );

            logger.info(`  ✓ Routed to: ${gotoTarget}`);
            logger.info(`  Event override: ${onFinish.goto_event || '(none)'}`);
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            logger.error(
              `✗ on_finish: routing failed for "${checkName}" → "${gotoTarget}": ${errorMsg}`
            );
            if (error instanceof Error && error.stack) {
              logger.debug(`Stack trace: ${error.stack}`);
            }
            throw error;
          }
        }

        logger.info(`✓ on_finish: completed for "${checkName}"`);
      } catch (error) {
        logger.error(`✗ on_finish: error for "${checkName}": ${error}`);
      }
    }
  }

  /**
   * Execute a check with retry/backoff and routing semantics (on_fail/on_success)
   */
  private async executeWithRouting(
    checkName: string,
    checkConfig: CheckConfig,
    provider: import('./providers/check-provider.interface').CheckProvider,
    providerConfig: CheckProviderConfig,
    prInfo: PRInfo,
    dependencyResults: Map<string, ReviewSummary>,
    sessionInfo: { parentSessionId?: string; reuseSession?: boolean } | undefined,
    config: VisorConfig | undefined,
    dependencyGraph: DependencyGraph,
    debug?: boolean,
    resultsMap?: Map<string, ReviewSummary>,
    foreachContext?: { index: number; total: number; parent: string }
  ): Promise<ReviewSummary> {
    const log = (msg: string) =>
      (this.config?.output?.pr_comment ? console.error : console.log)(msg);
    const maxLoops = config?.routing?.max_loops ?? 10;
    const defaults = config?.routing?.defaults?.on_fail || {};

    const onFail: OnFailConfig | undefined = checkConfig.on_fail
      ? { ...defaults, ...checkConfig.on_fail }
      : Object.keys(defaults).length
        ? defaults
        : undefined;
    const onSuccess: OnSuccessConfig | undefined = checkConfig.on_success;

    let attempt = 1;
    let loopCount = 0;
    const seed = `${checkName}-${prInfo.number || 'local'}`;

    const allAncestors = DependencyResolver.getAllDependencies(checkName, dependencyGraph.nodes);
    // Expose current check's structured output to routing JS (run_js/goto_js)
    // so templates can reference `output` similarly to `outputs` (deps).
    let currentRouteOutput: unknown = undefined;

    const evalRunJs = async (expr?: string, error?: unknown): Promise<string[]> => {
      if (!expr) return [];
      try {
        const sandbox = this.getRoutingSandbox();
        const eventObj = { name: prInfo.eventType || 'manual' } as const;
        const scope = {
          step: { id: checkName, tags: checkConfig.tags || [], group: checkConfig.group },
          attempt,
          loop: loopCount,
          error,
          foreach: foreachContext
            ? {
                index: foreachContext.index,
                total: foreachContext.total,
                parent: foreachContext.parent,
              }
            : null,
          outputs: Object.fromEntries((dependencyResults || new Map()).entries()),
          output: currentRouteOutput,
          pr: {
            number: prInfo.number,
            title: prInfo.title,
            author: prInfo.author,
            branch: prInfo.head,
            base: prInfo.base,
          },
          files: prInfo.files,
          env: getSafeEnvironmentVariables(),
          permissions: createPermissionHelpers(
            resolveAssociationFromEvent((prInfo as any).eventContext, prInfo.authorAssociation),
            detectLocalMode()
          ),
          event: eventObj,
        };
        const code = `
          const step = scope.step; const attempt = scope.attempt; const loop = scope.loop; const error = scope.error; const foreach = scope.foreach; const outputs = scope.outputs; const output = scope.output; const pr = scope.pr; const files = scope.files; const env = scope.env; const event = scope.event; const log = (...a)=>console.log('🔍 Debug:',...a); const hasMinPermission = scope.permissions.hasMinPermission; const isOwner = scope.permissions.isOwner; const isMember = scope.permissions.isMember; const isCollaborator = scope.permissions.isCollaborator; const isContributor = scope.permissions.isContributor; const isFirstTimer = scope.permissions.isFirstTimer;
          const __fn = () => {\n${expr}\n};
          const __res = __fn();
          return Array.isArray(__res) ? __res : (__res ? [__res] : []);
        `;
        const exec = sandbox.compile(code);
        const res = exec({ scope }).run();
        if (debug) {
          log(`🔧 Debug: run_js evaluated → [${this.redact(res)}]`);
        }
        return Array.isArray(res) ? res.filter(x => typeof x === 'string') : [];
      } catch (e) {
        if (debug) {
          log(`⚠️ Debug: run_js evaluation failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        return [];
      }
    };

    const evalGotoJs = async (expr?: string, error?: unknown): Promise<string | null> => {
      if (!expr) return null;
      try {
        const sandbox = this.getRoutingSandbox();
        const eventObj = { name: prInfo.eventType || 'manual' } as const;
        const scope = {
          step: { id: checkName, tags: checkConfig.tags || [], group: checkConfig.group },
          attempt,
          loop: loopCount,
          error,
          foreach: foreachContext
            ? {
                index: foreachContext.index,
                total: foreachContext.total,
                parent: foreachContext.parent,
              }
            : null,
          outputs: Object.fromEntries((dependencyResults || new Map()).entries()),
          output: currentRouteOutput,
          pr: {
            number: prInfo.number,
            title: prInfo.title,
            author: prInfo.author,
            branch: prInfo.head,
            base: prInfo.base,
          },
          files: prInfo.files,
          env: getSafeEnvironmentVariables(),
          permissions: createPermissionHelpers(
            resolveAssociationFromEvent((prInfo as any).eventContext, prInfo.authorAssociation),
            detectLocalMode()
          ),
          event: eventObj,
        };
        const code = `
          const step = scope.step; const attempt = scope.attempt; const loop = scope.loop; const error = scope.error; const foreach = scope.foreach; const outputs = scope.outputs; const output = scope.output; const pr = scope.pr; const files = scope.files; const env = scope.env; const event = scope.event; const log = (...a)=>console.log('🔍 Debug:',...a); const hasMinPermission = scope.permissions.hasMinPermission; const isOwner = scope.permissions.isOwner; const isMember = scope.permissions.isMember; const isCollaborator = scope.permissions.isCollaborator; const isContributor = scope.permissions.isContributor; const isFirstTimer = scope.permissions.isFirstTimer;
          const __fn = () => {\n${expr}\n};
          const __res = __fn();
          return (typeof __res === 'string' && __res) ? __res : null;
        `;
        const exec = sandbox.compile(code);
        const res = exec({ scope }).run();
        if (debug) {
          log(`🔧 Debug: goto_js evaluated → ${this.redact(res)}`);
        }
        return typeof res === 'string' && res ? res : null;
      } catch (e) {
        if (debug) {
          log(`⚠️ Debug: goto_js evaluation failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        return null;
      }
    };

    const getAllDepsFromConfig = (name: string): string[] => {
      const visited = new Set<string>();
      const acc: string[] = [];
      const dfs = (n: string) => {
        if (visited.has(n)) return;
        visited.add(n);
        const cfg = config?.checks?.[n];
        const deps = cfg?.depends_on || [];
        for (const d of deps) {
          acc.push(d);
          dfs(d);
        }
      };
      dfs(name);
      return Array.from(new Set(acc));
    };

    const executeNamedCheckInline = async (
      target: string,
      opts?: { eventOverride?: import('./types/config').EventTrigger }
    ): Promise<ReviewSummary> => {
      const targetCfg = config?.checks?.[target];
      if (!targetCfg) {
        throw new Error(`on_* referenced unknown check '${target}'`);
      }
      // Ensure all dependencies of target are available; execute missing ones in topological order
      // Use config graph (not only current dependencyGraph) so inline steps can bring their own deps
      const allTargetDeps = getAllDepsFromConfig(target);
      if (allTargetDeps.length > 0) {
        // Build subgraph mapping for ordered execution
        const subSet = new Set<string>([...allTargetDeps]);
        const subDeps: Record<string, string[]> = {};
        for (const id of subSet) {
          const cfg = config?.checks?.[id];
          subDeps[id] = (cfg?.depends_on || []).filter(d => subSet.has(d));
        }
        const subGraph = DependencyResolver.buildDependencyGraph(subDeps);
        for (const group of subGraph.executionOrder) {
          for (const depId of group.parallel) {
            // Skip if already have results
            if (resultsMap?.has(depId) || dependencyResults.has(depId)) continue;
            // Execute dependency inline (recursively ensures its deps are also present)
            await executeNamedCheckInline(depId);
          }
        }
      }
      const providerType = targetCfg.type || 'ai';
      const prov = this.providerRegistry.getProviderOrThrow(providerType);
      this.setProviderWebhookContext(prov);
      const provCfg: CheckProviderConfig = {
        type: providerType,
        prompt: targetCfg.prompt,
        exec: targetCfg.exec,
        focus: targetCfg.focus || this.mapCheckNameToFocus(target),
        schema: targetCfg.schema,
        group: targetCfg.group,
        checkName: target,
        eventContext: this.enrichEventContext(prInfo.eventContext),
        transform: targetCfg.transform,
        transform_js: targetCfg.transform_js,
        env: targetCfg.env,
        forEach: targetCfg.forEach,
        // Pass output history for loop/goto scenarios
        __outputHistory: this.outputHistory,
        // Include provider-specific keys (e.g., op/values for github)
        ...targetCfg,
        ai: {
          ...(targetCfg.ai || {}),
          timeout: providerConfig.ai?.timeout || 600000,
          debug: !!debug,
        },
      };
      // Build dependencyResults for target using already computed global results (after ensuring deps executed)
      const targetDeps = getAllDepsFromConfig(target);
      const depResults = new Map<string, ReviewSummary>();
      for (const depId of targetDeps) {
        // Prefer per-scope dependencyResults (e.g., forEach item context) over global results
        const res = dependencyResults.get(depId) || resultsMap?.get(depId);
        if (res) depResults.set(depId, res);
      }
      // Debug: log key dependent outputs for visibility
      try {
        // Try to log a small preview of dependent outputs if available
        const depPreview: Record<string, unknown> = {};
        for (const [k, v] of depResults.entries()) {
          const out = (v as any)?.output;
          if (out !== undefined) depPreview[k] = out;
        }
        if (debug) {
          log(`🔧 Debug: inline exec '${target}' deps output: ${JSON.stringify(depPreview)}`);
        }
      } catch {}

      if (debug) {
        const execStr = (provCfg as any).exec;
        if (execStr) log(`🔧 Debug: inline exec '${target}' command: ${execStr}`);
      }
      // If event override provided, clone prInfo with overridden eventType
      let prInfoForInline = prInfo;
      const prevEventOverride = this.routingEventOverride;
      if (opts?.eventOverride) {
        // Try to elevate to PR context when routing to PR events from issue threads
        const elevated = await this.elevateContextToPullRequest(
          { ...(prInfo as any), eventType: opts.eventOverride } as PRInfo,
          opts.eventOverride,
          log,
          debug
        );
        if (elevated) {
          prInfoForInline = elevated;
        } else {
          prInfoForInline = { ...(prInfo as any), eventType: opts.eventOverride } as PRInfo;
        }
        this.routingEventOverride = opts.eventOverride;
        const msg = `↪ goto_event: inline '${target}' with event=${opts.eventOverride}${
          elevated ? ' (elevated to PR context)' : ''
        }`;
        if (debug) log(`🔧 Debug: ${msg}`);
        try {
          require('./logger').logger.info(msg);
        } catch {}
      }
      let r: ReviewSummary;
      try {
        r = await prov.execute(prInfoForInline, provCfg, depResults, sessionInfo);
      } finally {
        // Restore previous override
        this.routingEventOverride = prevEventOverride;
      }
      // enrich with metadata similar to main flow
      const enrichedIssues = (r.issues || []).map(issue => ({
        ...issue,
        checkName: target,
        ruleId: `${target}/${issue.ruleId}`,
        group: targetCfg.group,
        schema: typeof targetCfg.schema === 'object' ? 'custom' : targetCfg.schema,
        template: targetCfg.template,
        timestamp: Date.now(),
      }));
      const enriched = { ...r, issues: enrichedIssues } as ReviewSummary;

      // Track output history for loop/goto scenarios
      const enrichedWithOutput = enriched as ReviewSummary & { output?: unknown };
      if (enrichedWithOutput.output !== undefined) {
        this.trackOutputHistory(target, enrichedWithOutput.output);
      }

      resultsMap?.set(target, enriched);
      if (debug) log(`🔧 Debug: inline executed '${target}', issues: ${enrichedIssues.length}`);
      return enriched;
    };

    // Begin attempts loop
    // We treat each retry/goto/run as consuming one loop budget entry
    while (true) {
      try {
        try {
          emitNdjsonFallback('visor.provider', {
            'visor.check.id': checkName,
            'visor.provider.type': providerConfig.type || 'ai',
          });
        } catch {}
        const res = await provider.execute(prInfo, providerConfig, dependencyResults, sessionInfo);
        try {
          currentRouteOutput = (res as any)?.output;
        } catch {}
        // Success path
        // Treat result issues with severity error/critical as a soft-failure eligible for on_fail routing
        const hasSoftFailure = (res.issues || []).some(
          i => i.severity === 'error' || i.severity === 'critical'
        );
        if (hasSoftFailure && onFail) {
          if (debug)
            log(
              `🔧 Debug: Soft failure detected for '${checkName}' with ${(res.issues || []).length} issue(s)`
            );
          const lastError: any = {
            message: 'soft-failure: issues present',
            code: 'soft_failure',
            issues: res.issues,
          };
          const dynamicRun = await evalRunJs(onFail.run_js, lastError);
          let runList = [...(onFail.run || []), ...dynamicRun].filter(Boolean);
          runList = Array.from(new Set(runList));
          if (debug) log(`🔧 Debug: on_fail.run (soft) list = [${runList.join(', ')}]`);
          if (runList.length > 0) {
            try {
              require('./logger').logger.info(
                `▶ on_fail.run: scheduling [${runList.join(', ')}] after '${checkName}'`
              );
            } catch {}
            loopCount++;
            if (loopCount > maxLoops) {
              throw new Error(
                `Routing loop budget exceeded (max_loops=${maxLoops}) during on_fail run`
              );
            }
            if (debug) log(`🔧 Debug: on_fail.run (soft) executing [${runList.join(', ')}]`);
            for (const stepId of runList) {
              await executeNamedCheckInline(stepId);
            }
          }
          let target = await evalGotoJs(onFail.goto_js, lastError);
          if (!target && onFail.goto) target = onFail.goto;
          if (debug) log(`🔧 Debug: on_fail.goto (soft) target = ${target}`);
          if (target) {
            try {
              require('./logger').logger.info(
                `↪ on_fail.goto: jumping to '${target}' from '${checkName}'`
              );
            } catch {}
            if (!allAncestors.includes(target)) {
              if (debug)
                log(
                  `⚠️ Debug: on_fail.goto (soft) '${target}' is not an ancestor of '${checkName}' — skipping`
                );
            } else {
              loopCount++;
              if (loopCount > maxLoops) {
                throw new Error(
                  `Routing loop budget exceeded (max_loops=${maxLoops}) during on_fail goto`
                );
              }
              await executeNamedCheckInline(target, { eventOverride: onFail.goto_event });
            }
          }

          const retryMax = onFail.retry?.max ?? 0;
          const base = onFail.retry?.backoff?.delay_ms ?? 0;
          const mode = onFail.retry?.backoff?.mode ?? 'fixed';
          if (attempt <= retryMax) {
            loopCount++;
            if (loopCount > maxLoops) {
              throw new Error(`Routing loop budget exceeded (max_loops=${maxLoops}) during retry`);
            }
            const delay = base > 0 ? this.computeBackoffDelay(attempt, mode, base, seed) : 0;
            if (debug)
              log(
                `🔁 Debug: retrying '${checkName}' (soft) attempt ${attempt + 1}/${retryMax + 1} after ${delay}ms`
              );
            if (delay > 0) await this.sleep(delay);
            attempt++;
            continue; // loop
          }
          // No retry configured: return existing result
          return res;
        }
        let needRerun = false;
        let rerunEventOverride: import('./types/config').EventTrigger | undefined;
        if (onSuccess) {
          // Compute run list
          const dynamicRun = await evalRunJs(onSuccess.run_js);
          const runList = [...(onSuccess.run || []), ...dynamicRun].filter(Boolean);
          if (runList.length > 0) {
            try {
              require('./logger').logger.info(
                `▶ on_success.run: scheduling [${Array.from(new Set(runList)).join(', ')}] after '${checkName}'`
              );
            } catch {}
            loopCount++;
            if (loopCount > maxLoops) {
              throw new Error(
                `Routing loop budget exceeded (max_loops=${maxLoops}) during on_success run`
              );
            }
            for (const stepId of Array.from(new Set(runList))) {
              await executeNamedCheckInline(stepId);
            }
          } else {
            // Provide a lightweight reason when nothing is scheduled via on_success.run
            try {
              const assoc = resolveAssociationFromEvent(
                (prInfo as any)?.eventContext,
                prInfo.authorAssociation
              );
              const perms = createPermissionHelpers(assoc, detectLocalMode());
              const allowedMember = perms.hasMinPermission('MEMBER');
              let intent: string | undefined;
              try {
                intent = (res as any)?.output?.intent;
              } catch {}
              require('./logger').logger.info(
                `⏭ on_success.run: none after '${checkName}' (event=${prInfo.eventType || 'manual'}, intent=${intent || 'n/a'}, assoc=${assoc || 'unknown'}, memberOrHigher=${allowedMember})`
              );
            } catch {}
          }
          // Optional goto
          let target = await evalGotoJs(onSuccess.goto_js);
          if (!target && onSuccess.goto) target = onSuccess.goto;
          if (target) {
            try {
              require('./logger').logger.info(
                `↪ on_success.goto: jumping to '${target}' from '${checkName}'`
              );
            } catch {}
            if (!allAncestors.includes(target)) {
              // Forward-run from target under goto_event: execute target and all dependents matching event
              const prevEventOverride2 = this.routingEventOverride;
              if (onSuccess.goto_event) {
                this.routingEventOverride = onSuccess.goto_event;
              }
              try {
                // Build forward closure (target + transitive dependents)
                const cfgChecks = (config?.checks || {}) as Record<
                  string,
                  import('./types/config').CheckConfig
                >;
                const forwardSet = new Set<string>();
                if (cfgChecks[target]) forwardSet.add(target);
                const dependsOn = (name: string, root: string): boolean => {
                  const seen = new Set<string>();
                  const dfs = (n: string): boolean => {
                    if (seen.has(n)) return false;
                    seen.add(n);
                    const deps = cfgChecks[n]?.depends_on || [];
                    if (deps.includes(root)) return true;
                    return deps.some(d => dfs(d));
                  };
                  return dfs(name);
                };
                const ev = onSuccess.goto_event || prInfo.eventType || 'issue_comment';
                for (const name of Object.keys(cfgChecks)) {
                  if (name === target) continue;
                  const onArr = cfgChecks[name]?.on as any;
                  const eventMatches = !onArr || (Array.isArray(onArr) && onArr.includes(ev));
                  if (!eventMatches) continue;
                  if (dependsOn(name, target)) forwardSet.add(name);
                }
                // Topologically order forwardSet based on depends_on within this subset
                const order: string[] = [];
                const inSet = (n: string) => forwardSet.has(n);
                const tempMarks = new Set<string>();
                const permMarks = new Set<string>();
                const stack: string[] = [];
                const visit = (n: string) => {
                  if (permMarks.has(n)) return;
                  if (tempMarks.has(n)) {
                    // Cycle detected — build a readable cycle path
                    const idx = stack.indexOf(n);
                    const cyclePath = idx >= 0 ? [...stack.slice(idx), n] : [n];
                    throw new Error(
                      `Cycle detected in forward-run dependency subset: ${cyclePath.join(' -> ')}`
                    );
                  }
                  tempMarks.add(n);
                  stack.push(n);
                  const deps = (cfgChecks[n]?.depends_on || []).filter(inSet);
                  for (const d of deps) visit(d);
                  stack.pop();
                  tempMarks.delete(n);
                  permMarks.add(n);
                  order.push(n);
                };
                for (const n of forwardSet) visit(n);
                // Execute in order with event override, updating statistics per child
                for (const stepId of order) {
                  if (!this.executionStats.has(stepId)) this.initializeCheckStats(stepId);
                  const childStart = this.recordIterationStart(stepId);
                  const childRes = await executeNamedCheckInline(stepId, {
                    eventOverride: onSuccess.goto_event,
                  });
                  const childIssues = (childRes.issues || []).map(i => ({ ...i }));
                  const childSuccess = !this.hasFatal(childIssues);
                  const childOutput: unknown = (childRes as any)?.output;
                  this.recordIterationComplete(
                    stepId,
                    childStart,
                    childSuccess,
                    childIssues,
                    childOutput
                  );
                }
                // Do NOT append forward-run child issues to the current check result.
                // Child results are recorded independently in resultsMap and statistics,
                // and aggregators will include them without double-counting under the parent.
              } finally {
                this.routingEventOverride = prevEventOverride2;
              }
            } else {
              loopCount++;
              if (loopCount > maxLoops) {
                throw new Error(
                  `Routing loop budget exceeded (max_loops=${maxLoops}) during on_success goto`
                );
              }
              await executeNamedCheckInline(target, { eventOverride: onSuccess.goto_event });
              // After jumping back to an ancestor, re-run the current check to re-validate with new state
              needRerun = true;
              rerunEventOverride = onSuccess.goto_event;
            }
          }
        }
        if (needRerun) {
          if (debug) log(`🔄 Debug: Re-running '${checkName}' after on_success.goto`);
          try {
            require('./logger').logger.info(`🔁 Re-running '${checkName}' after goto`);
          } catch {}
          // Apply same event override as goto (if any) for this re-run by setting routingEventOverride
          const prev = this.routingEventOverride;
          if (rerunEventOverride) this.routingEventOverride = rerunEventOverride;
          attempt++;
          // Loop will execute the check again with evaluateIfCondition seeing override
          // Restore after loop iteration completes for safety
          // We can't restore here; we'll restore at start of next iteration when override applied,
          // but ensure no lingering by resetting immediately after attempt increment
          this.routingEventOverride = prev;
          continue;
        }
        return res;
      } catch (err) {
        // Failure path
        if (!onFail) {
          throw err; // no routing policy
        }

        const lastError = err instanceof Error ? err : new Error(String(err));

        // Dynamic compute run/goto
        const dynamicRun = await evalRunJs(onFail.run_js, lastError);
        let runList = [...(onFail.run || []), ...dynamicRun].filter(Boolean);
        // Dedup while preserving order
        runList = Array.from(new Set(runList));

        if (runList.length > 0) {
          try {
            require('./logger').logger.info(
              `▶ on_fail.run: scheduling [${runList.join(', ')}] after '${checkName}'`
            );
          } catch {}
          loopCount++;
          if (loopCount > maxLoops) {
            throw new Error(
              `Routing loop budget exceeded (max_loops=${maxLoops}) during on_fail run`
            );
          }
          if (debug) log(`🔧 Debug: on_fail.run executing [${runList.join(', ')}]`);
          for (const stepId of runList) {
            await executeNamedCheckInline(stepId);
          }
        }

        let target = await evalGotoJs(onFail.goto_js, lastError);
        if (!target && onFail.goto) target = onFail.goto;
        if (target) {
          try {
            require('./logger').logger.info(
              `↪ on_fail.goto: jumping to '${target}' from '${checkName}'`
            );
          } catch {}
          if (!allAncestors.includes(target)) {
            if (debug)
              log(
                `⚠️ Debug: on_fail.goto '${target}' is not an ancestor of '${checkName}' — skipping`
              );
          } else {
            loopCount++;
            if (loopCount > maxLoops) {
              throw new Error(
                `Routing loop budget exceeded (max_loops=${maxLoops}) during on_fail goto`
              );
            }
            await executeNamedCheckInline(target, { eventOverride: onFail.goto_event });
          }
        }

        // Retry if allowed
        const retryMax = onFail.retry?.max ?? 0;
        const base = onFail.retry?.backoff?.delay_ms ?? 0;
        const mode = onFail.retry?.backoff?.mode ?? 'fixed';
        if (attempt <= retryMax) {
          loopCount++;
          if (loopCount > maxLoops) {
            throw new Error(`Routing loop budget exceeded (max_loops=${maxLoops}) during retry`);
          }
          const delay = base > 0 ? this.computeBackoffDelay(attempt, mode, base, seed) : 0;
          if (debug)
            log(
              `🔁 Debug: retrying '${checkName}' attempt ${attempt + 1}/${retryMax + 1} after ${delay}ms`
            );
          if (delay > 0) await this.sleep(delay);
          attempt++;
          continue; // loop
        }

        // Exhausted retry budget; rethrow
        throw lastError;
      }
    }
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
    const logFn = this.config?.output?.pr_comment ? console.error : console.log;

    return checks.filter(checkName => {
      const checkConfig = config?.checks?.[checkName];
      if (!checkConfig) {
        // If no config for this check, include it by default
        return true;
      }

      const checkTags = checkConfig.tags || [];

      // If check has tags but no tag filter is specified, exclude it
      if (checkTags.length > 0 && (!tagFilter || (!tagFilter.include && !tagFilter.exclude))) {
        logFn(`⏭️ Skipping check '${checkName}' - check has tags but no tag filter specified`);
        return false;
      }

      // If no tag filter is specified and check has no tags, include it
      if (!tagFilter || (!tagFilter.include && !tagFilter.exclude)) {
        return true;
      }

      // If check has no tags and a tag filter is specified, include it (untagged checks always run)
      if (checkTags.length === 0) {
        return true;
      }

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
      // Initialize memory store if configured
      if (options.config?.memory) {
        const memoryStore = MemoryStore.getInstance(options.config.memory);
        await memoryStore.initialize();
        logger.debug('Memory store initialized');
      }

      // Store webhook context if provided
      this.webhookContext = options.webhookContext;

      // Determine where to send log messages based on output format
      const logFn = (msg: string) => logger.info(msg);

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
        logger.warn('⚠️ No checks match the tag filter criteria');
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
        await this.completeGitHubChecksWithResults(reviewSummary, options, prInfo);
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

      // Build execution statistics
      const executionStatistics = this.buildExecutionStatistics();

      return {
        repositoryInfo,
        reviewSummary,
        executionTime,
        timestamp,
        checksExecuted: filteredChecks,
        executionStatistics,
        debug: debugInfo,
      };
    } catch (error) {
      logger.error(
        'Error executing checks: ' + (error instanceof Error ? error.message : String(error))
      );

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
          if (failFast && this.shouldFailFast(result)) {
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
    // Use debug logger for internal engine messages; important notices use logger.warn/info directly.
    const logFn = (msg: string) => logger.debug(msg);

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

    // If we have a config with individual check definitions, prefer dependency-aware execution
    // even for a single check, so provider types other than 'ai' work consistently.
    const allConfigured = config?.checks ? checks.every(name => !!config.checks[name]) : false;
    if (allConfigured) {
      if (debug) {
        logFn(
          `🔧 Debug: Using dependency-aware execution for ${checks.length} configured check(s)`
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
          eventContext: this.enrichEventContext(prInfo.eventContext),
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
        eventContext: this.enrichEventContext(prInfo.eventContext),
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
   * Execute review checks and return grouped results with statistics for new architecture
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
  ): Promise<ExecutionResult> {
    // Determine where to send log messages based on output format
    const logFn =
      outputFormat === 'json' || outputFormat === 'sarif'
        ? debug
          ? console.error
          : () => {}
        : console.log;

    // Only output debug messages if debug mode is enabled
    if (debug) {
      logger.debug(`🔧 Debug: executeGroupedChecks called with checks: ${JSON.stringify(checks)}`);
      logger.debug(
        `🔧 Debug: Config available: ${!!config}, Config has checks: ${!!config?.checks}`
      );
    }

    // Filter checks based on current event type to prevent execution of checks that shouldn't run
    const filteredChecks = this.filterChecksByEvent(checks, config, prInfo, logFn, debug);
    if (filteredChecks.length !== checks.length && debug) {
      logger.debug(
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
      logger.debug(
        `🔧 Debug: Tag filtering reduced checks from ${filteredChecks.length} to ${tagFilteredChecks.length}: ${JSON.stringify(tagFilteredChecks)}`
      );
    }

    // Use filtered checks for execution
    checks = tagFilteredChecks;

    // Capture GitHub Action context (owner/repo/octokit) if available from environment
    // This is used for context elevation when routing via goto_event
    // Only initialize if not already set by constructor (which has the authenticated octokit)
    if (!this.actionContext) {
      try {
        const repoEnv = process.env.GITHUB_REPOSITORY || '';
        const [owner, repo] = repoEnv.split('/') as [string, string];
        const token = process.env['INPUT_GITHUB-TOKEN'] || process.env['GITHUB_TOKEN'];
        if (owner && repo) {
          this.actionContext = { owner, repo };
          if (token) {
            const { Octokit } = await import('@octokit/rest');
            this.actionContext.octokit = new Octokit({ auth: token });
          }
        }
      } catch {
        // Non-fatal: context elevation will be skipped if not available
      }
    }

    // Check if we have any checks left after filtering
    if (checks.length === 0) {
      logger.warn('⚠️ No checks remain after tag filtering');
      return {
        results: {},
        statistics: this.buildExecutionStatistics(),
      };
    }

    if (!config?.checks) {
      throw new Error('Config with check definitions required for grouped execution');
    }

    // If we have a config with individual check definitions, use dependency-aware execution
    const hasDependencies = checks.some(checkName => {
      const checkConfig = config.checks[checkName];
      return checkConfig?.depends_on && checkConfig.depends_on.length > 0;
    });
    const hasRouting = checks.some(checkName => {
      const c = config.checks[checkName];
      return Boolean(c?.on_success || c?.on_fail);
    });

    if (checks.length > 1 || hasDependencies || hasRouting) {
      if (debug) {
        logger.debug(
          `🔧 Debug: Using grouped dependency-aware execution for ${checks.length} checks (has dependencies: ${hasDependencies}, has routing: ${hasRouting})`
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
        logger.debug(`🔧 Debug: Using grouped single check execution for: ${checks[0]}`);
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
      return {
        results: groupedResults,
        statistics: this.buildExecutionStatistics(),
      };
    }

    // No checks to execute
    return {
      results: {},
      statistics: this.buildExecutionStatistics(),
    };
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
      eventContext: this.enrichEventContext(prInfo.eventContext),
      ai: {
        timeout: timeout || 600000,
        debug: debug,
        ...(checkConfig.ai || {}),
      },
      ai_provider: checkConfig.ai_provider || config.ai_provider,
      ai_model: checkConfig.ai_model || config.ai_model,
      // Pass claude_code config if present
      claude_code: checkConfig.claude_code,
      // Pass output history for loop/goto scenarios
      __outputHistory: this.outputHistory,
      // Pass any provider-specific config
      ...checkConfig,
    };
    providerConfig.forEach = checkConfig.forEach;

    const result = await provider.execute(prInfo, providerConfig);

    // Validate forEach output (skip if there are already errors from transform_js or other sources)
    if (checkConfig.forEach && (!result.issues || result.issues.length === 0)) {
      const reviewSummaryWithOutput = result as ReviewSummary & { output?: unknown };
      const validation = this.validateAndNormalizeForEachOutput(
        checkName,
        reviewSummaryWithOutput.output,
        checkConfig.group
      );

      if (!validation.isValid) {
        return validation.error;
      }
    }

    // Evaluate fail_if conditions
    if (config && (config.fail_if || checkConfig.fail_if)) {
      const failureResults = await this.evaluateFailureConditions(
        checkName,
        result,
        config,
        prInfo
      );

      // Add failure condition issues to the result
      if (failureResults.length > 0) {
        const failureIssues = failureResults
          .filter(f => f.failed)
          .map(f => ({
            file: 'system',
            line: 0,
            ruleId: f.conditionName,
            message: f.message || `Failure condition met: ${f.expression}`,
            severity: (f.severity || 'error') as 'info' | 'warning' | 'error' | 'critical',
            category: 'logic' as const,
          }));

        result.issues = [...(result.issues || []), ...failureIssues];
      }
    }

    // Render the check content using the appropriate template
    const content = await this.renderCheckContent(checkName, result, checkConfig, prInfo);

    // Determine the group: if group_by is 'check', use the check name; otherwise use configured group or 'default'
    let group = checkConfig.group || 'default';
    if (config?.output?.pr_comment?.group_by === 'check' && !checkConfig.group) {
      group = checkName;
    }

    return {
      checkName,
      content,
      group,
      output: (result as any).output,
      debug: result.debug,
      issues: result.issues, // Include structured issues
    };
  }

  /**
   * Validate and normalize forEach output
   * Returns normalized array or throws validation error result
   */
  private validateAndNormalizeForEachOutput(
    checkName: string,
    output: unknown,
    checkGroup?: string
  ):
    | {
        isValid: true;
        normalizedOutput: unknown[];
      }
    | {
        isValid: false;
        error: {
          checkName: string;
          content: string;
          group: string;
          issues: Array<{
            file: string;
            line: number;
            ruleId: string;
            message: string;
            severity: 'error';
            category: 'logic';
          }>;
        };
      } {
    if (output === undefined) {
      logger.error(`✗ forEach check "${checkName}" produced undefined output`);
      return {
        isValid: false,
        error: {
          checkName,
          content: '',
          group: checkGroup || 'default',
          issues: [
            {
              file: 'system',
              line: 0,
              ruleId: 'forEach/undefined_output',
              message: `forEach check "${checkName}" produced undefined output. Verify your command outputs valid data and your transform_js returns a value.`,
              severity: 'error',
              category: 'logic',
            },
          ],
        },
      };
    }

    // Normalize output to array
    let normalizedOutput: unknown[];

    if (Array.isArray(output)) {
      normalizedOutput = output;
    } else if (output && typeof output === 'object' && Array.isArray((output as any).items)) {
      normalizedOutput = (output as any).items as unknown[];
    } else if (typeof output === 'string') {
      try {
        const parsed = JSON.parse(output);
        normalizedOutput = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        normalizedOutput = [output];
      }
    } else if (output === null) {
      normalizedOutput = [];
    } else {
      normalizedOutput = [output];
    }

    // Log the result (empty arrays are valid, just result in 0 iterations)
    logger.info(`  Found ${normalizedOutput.length} items for forEach iteration`);
    return {
      isValid: true,
      normalizedOutput,
    };
  }

  /**
   * Execute multiple checks with dependency awareness - return grouped results with statistics
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
  ): Promise<ExecutionResult> {
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

    // Build execution statistics
    const executionStatistics = this.buildExecutionStatistics();

    // Convert the flat ReviewSummary to grouped CheckResults
    const groupedResults = await this.convertReviewSummaryToGroupedResults(
      reviewSummary,
      checks,
      config,
      prInfo
    );

    return {
      results: groupedResults,
      statistics: executionStatistics,
    };
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
    const agg = reviewSummary as ReviewSummary & {
      __contents?: Record<string, string | undefined>;
      __outputs?: Record<string, unknown>;
      __executed?: string[];
    };
    const contentMap = agg.__contents;
    const outputMap = agg.__outputs;
    // Build a unified list of all checks that produced results:
    //  - originally requested checks
    //  - any checks that produced content/output during routing (e.g., forward-run after goto)
    //  - any checks that emitted issues with checkName set
    const allCheckNames: string[] = [];
    const seen = new Set<string>();
    const pushUnique = (n?: string) => {
      if (!n) return;
      if (!seen.has(n)) {
        seen.add(n);
        allCheckNames.push(n);
      }
    };
    for (const n of checks) pushUnique(n);
    if (contentMap) for (const n of Object.keys(contentMap)) pushUnique(n);
    if (outputMap) for (const n of Object.keys(outputMap)) pushUnique(n);
    for (const issue of reviewSummary.issues || []) pushUnique(issue.checkName);
    if (Array.isArray(agg.__executed)) for (const n of agg.__executed) pushUnique(n);

    // Process each discovered check individually
    for (const checkName of allCheckNames) {
      const checkConfig = config?.checks?.[checkName];
      if (!checkConfig) continue;

      // Extract issues for this check
      const checkIssues = (reviewSummary.issues || []).filter(
        issue => issue.checkName === checkName
      );

      // Create a mini ReviewSummary for this check
      const checkSummary: ReviewSummary & { output?: unknown } = {
        issues: checkIssues,
        debug: reviewSummary.debug,
      };

      if (contentMap?.[checkName]) {
        (checkSummary as any).content = contentMap[checkName];
      }
      if (outputMap && Object.prototype.hasOwnProperty.call(outputMap, checkName)) {
        checkSummary.output = outputMap[checkName];
      }

      // Render content for this check (never let template errors abort the whole run)
      let content: string = '';
      let issuesForCheck = [...checkIssues];
      try {
        content = await this.renderCheckContent(checkName, checkSummary, checkConfig, prInfo);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`❌ Failed to render content for check '${checkName}': ${msg}`);
        // Add a synthetic issue so it appears in output and GitHub Checks
        issuesForCheck = [
          ...issuesForCheck,
          {
            file: 'system',
            line: 0,
            ruleId: `${checkName}/render-error`,
            message: `Template rendering failed: ${msg}`,
            severity: 'error' as const,
            category: 'logic' as const,
          },
        ];
      }

      // Determine the group: if group_by is 'check', use the check name; otherwise use configured group or 'default'
      let group = checkConfig.group || 'default';
      if (config?.output?.pr_comment?.group_by === 'check' && !checkConfig.group) {
        group = checkName;
      }

      const checkResult: CheckResult = {
        checkName,
        content,
        group,
        output: checkSummary.output,
        debug: reviewSummary.debug,
        issues: issuesForCheck, // Include structured issues + rendering error if any
      };

      // Add to appropriate group
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
   * Evaluate `if` condition for a check
   * @param checkName Name of the check
   * @param condition The condition string to evaluate
   * @param prInfo PR information
   * @param results Current check results
   * @param debug Whether debug mode is enabled
   * @returns true if the check should run, false if it should be skipped
   */
  private async evaluateCheckCondition(
    checkName: string,
    condition: string,
    prInfo: PRInfo,
    results: Map<string, ReviewSummary>,
    debug?: boolean
  ): Promise<boolean> {
    // Determine event name for condition context, honoring any routing override
    const override = this.routingEventOverride;
    const eventName = override
      ? override.startsWith('pr_')
        ? 'pull_request'
        : override === 'issue_comment'
          ? 'issue_comment'
          : override.startsWith('issue_')
            ? 'issues'
            : 'manual'
      : 'issue_comment';

    const commenterAssoc = resolveAssociationFromEvent(
      (prInfo as any)?.eventContext,
      prInfo.authorAssociation
    );
    const shouldRun = await this.failureEvaluator.evaluateIfCondition(checkName, condition, {
      branch: prInfo.head,
      baseBranch: prInfo.base,
      filesChanged: prInfo.files.map(f => f.filename),
      event: eventName,
      environment: getSafeEnvironmentVariables(),
      previousResults: results,
      authorAssociation: commenterAssoc,
    });

    if (!shouldRun && debug) {
      logger.debug(`🔧 Debug: Skipping check '${checkName}' - if condition evaluated to false`);
    }

    return shouldRun;
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
    const directContent = (reviewSummary as ReviewSummary & { content?: string }).content;
    if (typeof directContent === 'string' && directContent.trim()) {
      return directContent.trim();
    }

    // Import the liquid template system
    const { createExtendedLiquid } = await import('./liquid-extensions');
    const fs = await import('fs/promises');
    const path = await import('path');

    const liquid = createExtendedLiquid({
      trimTagLeft: false,
      trimTagRight: false,
      trimOutputLeft: false,
      trimOutputRight: false,
      greedy: false,
    });

    // Determine template to use
    // If schema is an object (inline JSON schema), use 'plain' rendering
    // If schema is a file path (legitimate path with / and ends with .json), treat as plain (schema file reference)
    let schemaName: string;
    if (typeof checkConfig.schema === 'object') {
      schemaName = 'plain';
    } else if (
      typeof checkConfig.schema === 'string' &&
      checkConfig.schema.includes('/') &&
      checkConfig.schema.endsWith('.json') &&
      !checkConfig.schema.includes('..') // Reject paths containing .. (parent directory)
    ) {
      // Schema is a file path reference - use plain rendering
      // The schema file will be handled by the AI provider when making the request
      schemaName = 'plain';
    } else {
      schemaName = checkConfig.schema || 'plain';
    }

    let templateContent: string;
    let enrichAssistantContext = false;

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
      // Only enrich built-in issue-assistant with event/permission context
      if (sanitizedSchema === 'issue-assistant') {
        enrichAssistantContext = true;
      }
    }

    // Prepare template data
    // Filter out system-level issues (fail_if conditions, internal errors) which should not appear in output
    const filteredIssues = (reviewSummary.issues || []).filter(
      issue => !(issue.file === 'system' && issue.line === 0)
    );

    const templateData: Record<string, unknown> = {
      issues: filteredIssues,
      checkName: checkName,
      // Expose structured output for custom schemas/templates (e.g., overview)
      // This allows templates to render fields like output.text or output.tags
      output: (reviewSummary as unknown as { output?: unknown }).output,
    };

    if (enrichAssistantContext) {
      // Provide minimal event and permission context for the assistant template only
      let authorAssociation: string | undefined;
      let eventName = 'manual';
      let eventAction: string | undefined;
      try {
        const anyInfo = _prInfo as unknown as { eventContext?: any; authorAssociation?: string };
        authorAssociation = resolveAssociationFromEvent(
          anyInfo?.eventContext,
          anyInfo?.authorAssociation
        );
        eventName = anyInfo?.eventContext?.event_name || (anyInfo as any)?.eventType || 'manual';
        eventAction = anyInfo?.eventContext?.action;
      } catch {}
      templateData.authorAssociation = authorAssociation;
      templateData.event = { name: eventName, action: eventAction };
    }

    // Establish permissions context for filters so templates can call permission filters
    // without passing authorAssociation explicitly.
    const { withPermissionsContext } = (await import('./liquid-extensions')) as unknown as {
      withPermissionsContext?: (
        ctx: { authorAssociation?: string },
        fn: () => Promise<string>
      ) => Promise<string>;
    };
    // Try to derive author association from PR info (commenter preferred)
    let authorAssociationForFilters: string | undefined;
    try {
      const anyInfo = _prInfo as unknown as { eventContext?: any; authorAssociation?: string };
      authorAssociationForFilters = resolveAssociationFromEvent(
        anyInfo?.eventContext,
        anyInfo?.authorAssociation
      );
    } catch {}

    let rendered: string;
    if (typeof withPermissionsContext === 'function') {
      rendered = await withPermissionsContext(
        { authorAssociation: authorAssociationForFilters },
        async () => await liquid.parseAndRender(templateContent, templateData)
      );
      if (rendered === undefined || rendered === null) {
        // Defensive: some test environments mock the helper without implementation
        rendered = await liquid.parseAndRender(templateContent, templateData);
      }
    } else {
      rendered = await liquid.parseAndRender(templateContent, templateData);
    }
    const finalRendered = rendered.trim();
    try {
      const { emitMermaidFromMarkdown } = await import('./utils/mermaid-telemetry');
      emitMermaidFromMarkdown(checkName, finalRendered, 'content');
    } catch {}
    return finalRendered;
  }

  /**
   * Attempt to elevate an issue/issue_comment context to full PR context when routing via goto_event.
   * Returns a new PRInfo with files/diff when possible; otherwise returns null.
   */
  private async elevateContextToPullRequest(
    prInfo: PRInfo,
    targetEvent: import('./types/config').EventTrigger,
    log?: (msg: string) => void,
    debug?: boolean
  ): Promise<PRInfo | null> {
    try {
      // Only elevate for PR-style events
      if (targetEvent !== 'pr_opened' && targetEvent !== 'pr_updated') return null;

      // Only meaningful to elevate from issue contexts
      const isIssueContext = (prInfo as PRInfo & { isIssue?: boolean }).isIssue === true;
      const ctx: any = (prInfo as any).eventContext || {};
      const isPRThread = Boolean(ctx?.issue?.pull_request);
      if (!isIssueContext || !isPRThread) return null;

      // Resolve owner/repo from cached action context or environment
      let owner = this.actionContext?.owner;
      let repo = this.actionContext?.repo;
      if (!owner || !repo) {
        const repoEnv = process.env.GITHUB_REPOSITORY || '';
        [owner, repo] = repoEnv.split('/') as [string, string];
      }
      if (!owner || !repo) return null;

      // Determine PR number from event context or prInfo.number
      const prNumber = (ctx?.issue?.number as number) || prInfo.number;
      if (!prNumber) return null;

      // Build Octokit; prefer cached instance
      let octokit = this.actionContext?.octokit;
      if (!octokit) {
        const token = process.env['INPUT_GITHUB-TOKEN'] || process.env['GITHUB_TOKEN'];
        if (!token) return null;
        const { Octokit } = await import('@octokit/rest');
        octokit = new Octokit({ auth: token });
      }

      // Fetch full PR diff
      const analyzer = new PRAnalyzer(octokit);
      const elevated = await analyzer.fetchPRDiff(owner, repo, prNumber, undefined, targetEvent);
      // Preserve event context and helpful flags
      (elevated as any).eventContext = (prInfo as any).eventContext || ctx;
      (elevated as any).isPRContext = true;
      (elevated as any).includeCodeContext = true;
      if (debug)
        log?.(`🔧 Debug: Elevated context to PR #${prNumber} for goto_event=${targetEvent}`);
      return elevated;
    } catch (e) {
      if (debug) {
        const msg = e instanceof Error ? e.message : String(e);
        log?.(`⚠️ Debug: Context elevation to PR failed: ${msg}`);
      }
      return null;
    }
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
        if (checkConfig.reuse_ai_session) {
          sessionReuseChecks.add(checkName);

          // Determine the session provider check name
          if (typeof checkConfig.reuse_ai_session === 'string') {
            // Explicit check name provided
            sessionProviders.set(checkName, checkConfig.reuse_ai_session);
          } else if (checkConfig.reuse_ai_session === true) {
            // Use first dependency as fallback
            if (checkConfig.depends_on && checkConfig.depends_on.length > 0) {
              sessionProviders.set(checkName, checkConfig.depends_on[0]);
            }
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

    // Validate dependencies for the initially requested checks first
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

    // Expand requested checks with transitive dependencies present in config for execution
    const expandWithTransitives = (rootChecks: string[]): string[] => {
      if (!config?.checks) return rootChecks;
      const set = new Set<string>(rootChecks);
      const visit = (name: string) => {
        const cfg = config.checks[name];
        if (!cfg || !cfg.depends_on) return;
        for (const dep of cfg.depends_on) {
          if (!set.has(dep)) {
            set.add(dep);
            visit(dep);
          }
        }
      };
      for (const c of rootChecks) visit(c);
      return Array.from(set);
    };

    checks = expandWithTransitives(checks);

    // Rebuild dependencies map for the expanded set
    for (const checkName of checks) {
      const checkConfig = config.checks[checkName];
      dependencies[checkName] = checkConfig?.depends_on || [];
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

    // Build children-by-parent mapping for inline branch-first execution
    const childrenByParent = new Map<string, string[]>();
    for (const [child, depsArr] of Object.entries(dependencies)) {
      for (const p of depsArr || []) {
        if (!childrenByParent.has(p)) childrenByParent.set(p, []);
        childrenByParent.get(p)!.push(child);
      }
    }

    // Log execution plan
    const stats = DependencyResolver.getExecutionStats(dependencyGraph);
    if (debug) {
      log(
        `🔧 Debug: Execution plan - ${stats.totalChecks} checks in ${stats.parallelLevels} levels, max parallelism: ${stats.maxParallelism}`
      );
    }

    // Execute checks level by level
    const results = new Map<string, ReviewSummary>();
    const sessionRegistry = require('./session-registry').SessionRegistry.getInstance();
    // Note: We'll get the provider dynamically per check, not a single one for all
    const sessionIds = new Map<string, string>(); // checkName -> sessionId
    let shouldStopExecution = false;
    let completedChecksCount = 0;
    const totalChecksCount = stats.totalChecks;

    // Initialize execution statistics for all checks
    for (const checkName of checks) {
      this.initializeCheckStats(checkName);
    }

    for (
      let levelIndex = 0;
      levelIndex < dependencyGraph.executionOrder.length && !shouldStopExecution;
      levelIndex++
    ) {
      const executionGroup = dependencyGraph.executionOrder[levelIndex];

      // Check for session reuse conflicts - only force sequential execution when there are actual conflicts
      const checksInLevel = executionGroup.parallel;

      // Group checks by their session parent
      const sessionReuseGroups = new Map<string, string[]>();
      checksInLevel.forEach(checkName => {
        if (sessionReuseChecks.has(checkName)) {
          const parentCheckName = sessionProviders.get(checkName);
          if (parentCheckName) {
            if (!sessionReuseGroups.has(parentCheckName)) {
              sessionReuseGroups.set(parentCheckName, []);
            }
            sessionReuseGroups.get(parentCheckName)!.push(checkName);
          }
        }
      });

      // Only force sequential execution if multiple checks share the same session parent
      const hasConflictingSessionReuse = Array.from(sessionReuseGroups.values()).some(
        group => group.length > 1
      );

      let actualParallelism = Math.min(effectiveMaxParallelism, executionGroup.parallel.length);
      if (hasConflictingSessionReuse) {
        // Force sequential execution when there are actual session conflicts
        actualParallelism = 1;
        if (debug) {
          const conflictingGroups = Array.from(sessionReuseGroups.entries())
            .filter(([_, checks]) => checks.length > 1)
            .map(([parent, checks]) => `${parent} -> [${checks.join(', ')}]`)
            .join('; ');
          log(
            `🔄 Debug: Level ${executionGroup.level} has session conflicts (${conflictingGroups}) - forcing sequential execution (parallelism: 1)`
          );
        }
      } else if (sessionReuseGroups.size > 0 && debug) {
        log(
          `✅ Debug: Level ${executionGroup.level} has session reuse but no conflicts - allowing parallel execution`
        );
      }

      if (debug) {
        log(
          `🔧 Debug: Executing level ${executionGroup.level} with ${executionGroup.parallel.length} checks (parallelism: ${actualParallelism})`
        );
      }

      // Create task functions for checks in this level, skip those already completed inline
      const levelChecks = executionGroup.parallel.filter(name => !results.has(name));
      const levelTaskFunctions = levelChecks.map(checkName => async () => {
        // Skip if this check was already completed by item-level branch scheduler
        if (results.has(checkName)) {
          if (debug) log(`🔧 Debug: Skipping ${checkName} (already satisfied earlier)`);
          return { checkName, error: null, result: results.get(checkName)! };
        }
        const checkConfig = config.checks[checkName];
        if (!checkConfig) {
          return {
            checkName,
            error: `No configuration found for check: ${checkName}`,
            result: null,
          };
        }

        // (no early gating; rely on per-item scheduler after parents run)

        const checkStartTime = Date.now();
        completedChecksCount++;
        logger.step(`Running check: ${checkName} [${completedChecksCount}/${totalChecksCount}]`);

        try {
          if (debug) {
            log(`🔧 Debug: Starting check: ${checkName} at level ${executionGroup.level}`);
          }

          // Get the appropriate provider for this check type
          const providerType = checkConfig.type || 'ai';
          const provider = this.providerRegistry.getProviderOrThrow(providerType);
          if (debug) {
            log(`🔧 Debug: Provider for '${checkName}' is '${providerType}'`);
          }
          this.setProviderWebhookContext(provider);

          // Create provider config for this specific check
          const extendedCheckConfig = checkConfig as CheckConfig & {
            level?: string;
            message?: string;
          };

          const providerConfig: CheckProviderConfig = {
            type: providerType,
            prompt: checkConfig.prompt,
            exec: checkConfig.exec,
            focus: checkConfig.focus || this.mapCheckNameToFocus(checkName),
            schema: checkConfig.schema,
            group: checkConfig.group,
            checkName: checkName, // Add checkName for sessionID
            eventContext: this.enrichEventContext(prInfo.eventContext),
            transform: checkConfig.transform,
            transform_js: checkConfig.transform_js,
            // Important: pass through provider-level timeout from check config
            // (e.g., command/http_client providers expect seconds/ms here)
            timeout: checkConfig.timeout,
            level: extendedCheckConfig.level,
            message: extendedCheckConfig.message,
            env: checkConfig.env,
            forEach: checkConfig.forEach,
            // Pass through any provider-specific keys (e.g., op/values for github provider)
            ...checkConfig,
            ai: {
              ...(checkConfig.ai || {}),
              timeout: timeout || 600000,
              debug: debug,
            },
          };

          // Pass results from ALL transitive dependencies (not just direct ones)
          // This ensures the "outputs" variable has access to all ancestor check results
          const dependencyResults = new Map<string, ReviewSummary>();
          let isForEachDependent = false;
          let forEachItems: unknown[] = [];
          let forEachParentName: string | undefined;
          const forEachParents: string[] = []; // Track ALL forEach parents

          // Get all transitive dependencies (ancestors) for this check
          const allDependencies = DependencyResolver.getAllDependencies(
            checkName,
            dependencyGraph.nodes
          );

          // Include results from ALL dependencies (direct and transitive)
          for (const depId of allDependencies) {
            if (results.has(depId)) {
              const depResult = results.get(depId)!;
              dependencyResults.set(depId, depResult);
            }
          }

          // If any direct dependency failed or was skipped, skip this check
          const directDeps = checkConfig.depends_on || [];
          const failedDeps: string[] = [];
          for (const depId of directDeps) {
            const depRes = results.get(depId);
            if (!depRes) continue;

            // Check if dependency was skipped
            const wasSkipped = (depRes.issues || []).some(issue => {
              const id = issue.ruleId || '';
              return id.endsWith('/__skipped');
            });

            // If dependency is a forEach parent, do NOT apply global fatal gating here.
            // We'll gate per-item inside the forEach loop to avoid stopping other branches.
            const depExtended = depRes as ExtendedReviewSummary;
            const isDepForEachParent = !!depExtended.isForEach;

            // Treat these as fatal in direct dependencies (non-forEach only):
            //  - command provider execution/transform failures
            //  - forEach validation/iteration errors
            //  - fail_if conditions (global or check-specific)
            // For non-forEach parents, only provider-fatal or fail_if/global_fail_if should gate.
            let hasFatalFailure = false;
            if (!isDepForEachParent) {
              const issues = depRes.issues || [];
              hasFatalFailure = issues.some(issue => {
                const id = issue.ruleId || '';
                return (
                  id === 'command/execution_error' ||
                  id.endsWith('/command/execution_error') ||
                  id === 'command/timeout' ||
                  id.endsWith('/command/timeout') ||
                  id === 'command/transform_js_error' ||
                  id.endsWith('/command/transform_js_error') ||
                  id === 'command/transform_error' ||
                  id.endsWith('/command/transform_error') ||
                  id === 'forEach/undefined_output' ||
                  id.endsWith('/forEach/undefined_output') ||
                  id.endsWith('/forEach/iteration_error') ||
                  id.endsWith('_fail_if') ||
                  id.endsWith('/global_fail_if')
                );
              });
              // As a fallback, evaluate fail_if on the dependency result now
              if (!hasFatalFailure && config && (config.fail_if || config.checks[depId]?.fail_if)) {
                try {
                  hasFatalFailure = await this.failIfTriggered(depId, depRes, config);
                } catch {}
              }
            }

            if (debug) {
              log(
                `🔧 Debug: gating check '${checkName}' against dep '${depId}': wasSkipped=${wasSkipped} hasFatalFailure=${hasFatalFailure}`
              );
            }
            if (wasSkipped || hasFatalFailure) failedDeps.push(depId);
          }

          if (failedDeps.length > 0) {
            // Record skip and provide a concise console message
            this.recordSkip(checkName, 'dependency_failed');
            logger.info(`⏭  Skipped (dependency failed: ${failedDeps.join(', ')})`);
            return {
              checkName,
              error: null,
              result: { issues: [] },
              skipped: true,
            };
          }

          // Check direct dependencies for forEach behavior
          for (const depId of checkConfig.depends_on || []) {
            if (results.has(depId)) {
              const depResult = results.get(depId)!;

              // Check if this dependency has forEach enabled
              const depForEachResult = depResult as ExtendedReviewSummary;

              if (
                depForEachResult.isForEach ||
                Array.isArray(depForEachResult.forEachItemResults) ||
                Array.isArray(depForEachResult.forEachItems)
              ) {
                if (!isForEachDependent) {
                  // First forEach dependency found - use it as the primary
                  isForEachDependent = true;
                  forEachItems = Array.isArray(depForEachResult.forEachItems)
                    ? depForEachResult.forEachItems!
                    : new Array(
                        Array.isArray(depForEachResult.forEachItemResults)
                          ? depForEachResult.forEachItemResults!.length
                          : 0
                      ).fill(undefined);
                  forEachParentName = depId;
                }
                // Track all forEach parents for unwrapping
                forEachParents.push(depId);
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

              if (debug) {
                log(
                  `🔄 Debug: Check ${checkName} will reuse session from parent ${parentCheckName}: ${parentSessionId}`
                );
              }
            } else {
              if (debug) {
                log(
                  `⚠️ Warning: Check ${checkName} requires session reuse but parent ${parentCheckName} session not found`
                );
              }
            }
          }

          // For checks that create new sessions, generate a session ID
          let currentSessionId: string | undefined = undefined;
          if (!sessionInfo?.reuseSession) {
            const timestamp = new Date().toISOString();
            currentSessionId = `visor-${timestamp.replace(/[:.]/g, '-')}-${checkName}`;
            sessionIds.set(checkName, currentSessionId);
            if (debug) {
              log(`🆕 Debug: Check ${checkName} will create new session: ${currentSessionId}`);
            }

            // Add session ID to provider config
            providerConfig.sessionId = currentSessionId;
          }

          // Handle forEach dependent execution
          let finalResult: ReviewSummary;

          if (isForEachDependent && forEachParentName) {
            if (!Array.isArray(forEachItems)) {
              forEachItems = [];
            }
            if (!Array.isArray(forEachItems)) {
              this.recordSkip(checkName, 'dependency_failed');
              return {
                checkName,
                error: null,
                result: { issues: [] },
                skipped: true,
              };
            }
            // Record forEach preview items
            this.recordForEachPreview(checkName, forEachItems);

            // If the forEach parent returned an empty array, skip this check entirely
            if (forEachItems.length === 0) {
              if (debug) {
                log(
                  `🔄 Debug: Skipping check "${checkName}" - forEach check "${forEachParentName}" returned 0 items`
                );
              }
              logger.info(`  forEach: no items from "${forEachParentName}", skipping check...`);
              this.recordSkip(checkName, 'dependency_failed');

              // Return a special marker result so that dependent checks can detect the skip
              finalResult = {
                issues: [],
                output: [],
              } as ReviewSummary;

              // Mark this result as forEach-capable but with empty items
              (finalResult as ExtendedReviewSummary).isForEach = true;
              (finalResult as ExtendedReviewSummary).forEachItems = [];

              // Skip to the end - don't execute this check
            } else {
              // Emit explicit debug to stdout so CLI e2e can assert it
              if (debug) {
                console.log(
                  `🔄 Debug: Check "${checkName}" depends on forEach check "${forEachParentName}", executing ${forEachItems.length} times`
                );
              }

              // Log forEach processing start (non-debug)
              const __itemCount = Array.isArray(forEachItems) ? forEachItems.length : 0;
              logger.info(
                `  forEach: processing ${__itemCount} items from "${forEachParentName}"...`
              );

              const allIssues: ReviewIssue[] = [];
              const allOutputs: unknown[] = new Array(forEachItems.length);
              const aggregatedContents: string[] = [];
              const perItemResults: Array<ReviewSummary | undefined> = new Array(
                forEachItems.length
              );

              // Aggregators for inline descendant execution (branch-first mode for simple chains)
              const inlineAgg = new Map<
                string,
                {
                  issues: ReviewIssue[];
                  outputs: unknown[];
                  contents: string[];
                  perItemResults: ReviewSummary[];
                }
              >();

              // eslint-disable-next-line @typescript-eslint/no-unused-vars
              const execInlineDescendants = async (
                parentName: string,
                itemIndex: number,
                baseDeps: Map<string, ReviewSummary>
              ): Promise<void> => {
                const children = (childrenByParent.get(parentName) || []).filter(child => {
                  const deps = dependencies[child] || [];
                  // Only handle simple chains inline: exactly one dependency which is the parent
                  return deps.length === 1 && deps[0] === parentName;
                });

                for (const childName of children) {
                  const childCfg = config.checks[childName];
                  const childProviderType = childCfg.type || 'ai';
                  const childProv = this.providerRegistry.getProviderOrThrow(childProviderType);
                  this.setProviderWebhookContext(childProv);
                  const childProviderConfig: CheckProviderConfig = {
                    type: childProviderType,
                    prompt: childCfg.prompt,
                    exec: childCfg.exec,
                    focus: childCfg.focus || this.mapCheckNameToFocus(childName),
                    schema: childCfg.schema,
                    group: childCfg.group,
                    checkName: childName,
                    eventContext: this.enrichEventContext(prInfo.eventContext),
                    transform: childCfg.transform,
                    transform_js: childCfg.transform_js,
                    env: childCfg.env,
                    forEach: childCfg.forEach,
                    // Include provider-specific keys like op/values for non-AI providers
                    ...childCfg,
                    ai: {
                      ...(childCfg.ai || {}),
                      timeout: timeout || 600000,
                      debug: debug,
                    },
                  };
                  try {
                    emitNdjsonSpanWithEvents('visor.check', { 'visor.check.id': checkName }, [
                      { name: 'check.started' },
                      { name: 'check.completed' },
                    ]);
                  } catch {}

                  // Build per-item dependency results for child, including transitive ancestors
                  const childDepResults = new Map<string, ReviewSummary>();
                  const childAllDeps = DependencyResolver.getAllDependencies(
                    childName,
                    dependencyGraph.nodes
                  );
                  for (const dep of childAllDeps) {
                    const baseRes = baseDeps.get(dep);
                    if (baseRes) {
                      childDepResults.set(dep, baseRes);
                      continue;
                    }
                    const globalRes = results.get(dep) as ExtendedReviewSummary | undefined;
                    if (!globalRes) continue;
                    if (
                      globalRes &&
                      (globalRes.isForEach ||
                        Array.isArray(globalRes.forEachItemResults) ||
                        Array.isArray((globalRes as any).output))
                    ) {
                      // Prefer precise per-item result when available
                      if (
                        Array.isArray(globalRes.forEachItemResults) &&
                        globalRes.forEachItemResults[itemIndex]
                      ) {
                        childDepResults.set(dep, globalRes.forEachItemResults[itemIndex]!);
                      } else if (
                        Array.isArray((globalRes as any).output) &&
                        (globalRes as any).output[itemIndex] !== undefined
                      ) {
                        childDepResults.set(dep, {
                          issues: [],
                          output: (globalRes as any).output[itemIndex],
                        } as ReviewSummary);
                      } else {
                        childDepResults.set(dep, globalRes);
                      }
                    } else {
                      childDepResults.set(dep, globalRes);
                    }
                  }

                  // If the parent item had a fatal failure, skip this child for this branch
                  const parentItemRes = childDepResults.get(parentName);
                  if (parentItemRes) {
                    // Skip when parent explicitly signaled error in its output for this item
                    try {
                      const pout: any = (parentItemRes as any).output;
                      if (pout && typeof pout === 'object' && pout.error === true) {
                        continue;
                      }
                    } catch {}

                    const fatal = (parentItemRes.issues || []).some(issue => {
                      const id = issue.ruleId || '';
                      const sev = issue.severity || 'error';
                      return (
                        sev === 'error' ||
                        sev === 'critical' ||
                        id === 'command/execution_error' ||
                        id.endsWith('/command/execution_error') ||
                        id === 'command/timeout' ||
                        id.endsWith('/command/timeout') ||
                        id === 'command/transform_js_error' ||
                        id.endsWith('/command/transform_js_error') ||
                        id === 'command/transform_error' ||
                        id.endsWith('/command/transform_error') ||
                        id.endsWith('/forEach/iteration_error') ||
                        id === 'forEach/undefined_output' ||
                        id.endsWith('/forEach/undefined_output') ||
                        id.endsWith('_fail_if') ||
                        id.endsWith('/global_fail_if')
                      );
                    });
                    if (fatal) {
                      continue;
                    }
                  }

                  // Evaluate per-item if condition
                  if (childCfg.if) {
                    const condResults = new Map(results);
                    for (const [k, v] of childDepResults) condResults.set(k, v);
                    const shouldRunChild = await this.evaluateCheckCondition(
                      childName,
                      childCfg.if,
                      prInfo,
                      condResults,
                      debug
                    );
                    if (!shouldRunChild) {
                      continue;
                    }
                  }

                  // Execute child for this item (record stats)
                  const childIterStart = this.recordIterationStart(childName);
                  const childItemRes = await this.executeWithRouting(
                    childName,
                    childCfg,
                    childProv,
                    childProviderConfig,
                    prInfo,
                    childDepResults,
                    sessionInfo,
                    config,
                    dependencyGraph,
                    debug,
                    results,
                    { index: itemIndex, total: forEachItems.length, parent: parentName }
                  );

                  // Per-item fail_if
                  if (config && (config.fail_if || childCfg.fail_if)) {
                    const fRes = await this.evaluateFailureConditions(
                      childName,
                      childItemRes,
                      config
                    );
                    if (fRes.length > 0) {
                      const fIssues = fRes
                        .filter(f => f.failed)
                        .map(f => ({
                          file: 'system',
                          line: 0,
                          ruleId: f.conditionName,
                          message: f.message || `Failure condition met: ${f.expression}`,
                          severity: (f.severity || 'error') as
                            | 'info'
                            | 'warning'
                            | 'error'
                            | 'critical',
                          category: 'logic' as const,
                        }));
                      childItemRes.issues = [...(childItemRes.issues || []), ...fIssues];
                    }
                  }

                  if (!inlineAgg.has(childName)) {
                    inlineAgg.set(childName, {
                      issues: [],
                      outputs: new Array(forEachItems.length),
                      contents: [],
                      perItemResults: new Array(forEachItems.length),
                    });
                  }
                  const agg = inlineAgg.get(childName)!;
                  if (childItemRes.issues) agg.issues.push(...childItemRes.issues);
                  const out = (childItemRes as any).output;
                  agg.outputs[itemIndex] = out;
                  agg.perItemResults[itemIndex] = childItemRes;
                  const c = (childItemRes as any).content;
                  if (typeof c === 'string' && c.trim()) agg.contents.push(c.trim());

                  // Record iteration completion for stats
                  const childHadFatal = this.hasFatal(childItemRes.issues || []);
                  this.recordIterationComplete(
                    childName,
                    childIterStart,
                    !childHadFatal,
                    childItemRes.issues || [],
                    (childItemRes as any).output
                  );

                  // Recurse further for simple chains
                  const nextBase = new Map(baseDeps);
                  nextBase.set(childName, childItemRes);
                  await execInlineDescendants(childName, itemIndex, nextBase);
                }
              };

              // Create task functions (not executed yet) - these will be executed with controlled concurrency
              // via executeWithLimitedParallelism to respect maxParallelism setting
              const itemTasks = forEachItems.map((item, itemIndex) => async () => {
                try {
                  emitNdjsonSpanWithEvents(
                    'visor.foreach.item',
                    {
                      'visor.check.id': checkName,
                      'visor.foreach.index': itemIndex,
                      'visor.foreach.total': forEachItems.length,
                    },
                    []
                  );
                } catch {}
                // Create modified dependency results with current item
                // For forEach branching: unwrap ALL forEach parents to create isolated execution branch
                const forEachDependencyResults = new Map<string, ReviewSummary>();
                for (const [depName, depResult] of dependencyResults) {
                  if (forEachParents.includes(depName)) {
                    // This is a forEach parent - unwrap its output for this iteration
                    const depForEachResult = depResult as ReviewSummary & {
                      output?: unknown;
                      forEachItems?: unknown[];
                      forEachItemResults?: ReviewSummary[];
                    };

                    if (
                      Array.isArray(depForEachResult.forEachItemResults) &&
                      depForEachResult.forEachItemResults[itemIndex]
                    ) {
                      // Use precise per-item result (includes issues + output)
                      forEachDependencyResults.set(
                        depName,
                        depForEachResult.forEachItemResults[itemIndex]!
                      );
                      // Also provide -raw access to the full array
                      const rawResult: ReviewSummary & { output?: unknown } = {
                        issues: [],
                        output: depForEachResult.output,
                      };
                      forEachDependencyResults.set(`${depName}-raw`, rawResult);
                    } else if (
                      Array.isArray(depForEachResult.output) &&
                      (depForEachResult as any).output[itemIndex] !== undefined
                    ) {
                      // Fallback to output-only unwrapping
                      const modifiedResult: ReviewSummary & { output?: unknown } = {
                        issues: [],
                        output: (depForEachResult as any).output[itemIndex],
                      };

                      forEachDependencyResults.set(depName, modifiedResult);
                      const rawResult: ReviewSummary & { output?: unknown } = {
                        issues: [],
                        output: depForEachResult.output,
                      };
                      forEachDependencyResults.set(`${depName}-raw`, rawResult);
                    } else {
                      // Fallback: use the result as-is
                      forEachDependencyResults.set(depName, depResult);
                    }
                  } else {
                    forEachDependencyResults.set(depName, depResult);
                  }
                }

                // Per-item dependency gating for forEach parents: if a dependency failed for this item, skip this iteration
                if ((checkConfig.depends_on || []).length > 0) {
                  const directDeps = checkConfig.depends_on || [];
                  for (const depId of directDeps) {
                    if (!forEachParents.includes(depId)) continue;
                    const depItemRes = forEachDependencyResults.get(depId);
                    if (!depItemRes) continue;
                    const wasSkippedDep = (depItemRes.issues || []).some(i =>
                      (i.ruleId || '').endsWith('/__skipped')
                    );
                    let hasFatalDepFailure = (depItemRes.issues || []).some(issue => {
                      const id = issue.ruleId || '';
                      return (
                        id === 'command/execution_error' ||
                        id.endsWith('/command/execution_error') ||
                        id === 'command/timeout' ||
                        id.endsWith('/command/timeout') ||
                        id === 'command/transform_js_error' ||
                        id.endsWith('/command/transform_js_error') ||
                        id === 'command/transform_error' ||
                        id.endsWith('/command/transform_error') ||
                        id.endsWith('/forEach/iteration_error') ||
                        id === 'forEach/undefined_output' ||
                        id.endsWith('/forEach/undefined_output') ||
                        id.endsWith('_fail_if') ||
                        id.endsWith('/global_fail_if')
                      );
                    });
                    if (
                      !hasFatalDepFailure &&
                      config &&
                      (config.fail_if || config.checks[depId]?.fail_if)
                    ) {
                      try {
                        const depFailures = await this.evaluateFailureConditions(
                          depId,
                          depItemRes,
                          config
                        );
                        hasFatalDepFailure = depFailures.some(f => f.failed);
                      } catch {}
                    }
                    const depAgg = dependencyResults.get(depId) as
                      | ExtendedReviewSummary
                      | undefined;
                    const maskFatal =
                      !!depAgg?.forEachFatalMask && depAgg!.forEachFatalMask![itemIndex] === true;
                    if (wasSkippedDep || hasFatalDepFailure || maskFatal) {
                      if (debug) {
                        log(
                          `🔄 Debug: Skipping item ${itemIndex + 1}/${forEachItems.length} for check "${checkName}" due to failed dependency '${depId}'`
                        );
                      }
                      return {
                        index: itemIndex,
                        itemResult: { issues: [] } as ReviewSummary,
                        skipped: true,
                      };
                    }
                  }
                }

                // Evaluate if condition for this forEach item
                if (checkConfig.if) {
                  // Merge current results with forEach-specific dependency results for condition evaluation
                  const conditionResults = new Map(results);
                  for (const [depName, depResult] of forEachDependencyResults) {
                    conditionResults.set(depName, depResult);
                  }

                  const shouldRun = await this.evaluateCheckCondition(
                    checkName,
                    checkConfig.if,
                    prInfo,
                    conditionResults,
                    debug
                  );

                  if (!shouldRun) {
                    if (debug) {
                      log(
                        `🔄 Debug: Skipping forEach item ${itemIndex + 1} for check "${checkName}" (if condition evaluated to false)`
                      );
                    }
                    // Return empty result for skipped items
                    return {
                      index: itemIndex,
                      itemResult: { issues: [] } as ReviewSummary,
                      skipped: true,
                    };
                  }
                }

                if (debug) {
                  log(
                    `🔄 Debug: Executing check "${checkName}" for item ${itemIndex + 1}/${forEachItems.length}`
                  );
                }

                // Track iteration start
                const iterationStart = this.recordIterationStart(checkName);

                // Execute with retry/routing semantics per item
                const itemResult = await this.executeWithRouting(
                  checkName,
                  checkConfig,
                  provider,
                  providerConfig,
                  prInfo,
                  forEachDependencyResults,
                  sessionInfo,
                  config,
                  dependencyGraph,
                  debug,
                  results,
                  /*foreachContext*/ {
                    index: itemIndex,
                    total: forEachItems.length,
                    parent: forEachParentName,
                  }
                );
                // no-op

                // Evaluate fail_if per item so a single failing branch does not stop others
                if (config && (config.fail_if || checkConfig.fail_if)) {
                  const itemFailures = await this.evaluateFailureConditions(
                    checkName,
                    itemResult,
                    config
                  );
                  if (itemFailures.length > 0) {
                    const failureIssues = itemFailures
                      .filter(f => f.failed)
                      .map(f => ({
                        file: 'system',
                        line: 0,
                        ruleId: f.conditionName,
                        message: f.message || `Failure condition met: ${f.expression}`,
                        severity: (f.severity || 'error') as
                          | 'info'
                          | 'warning'
                          | 'error'
                          | 'critical',
                        category: 'logic' as const,
                      }));
                    itemResult.issues = [...(itemResult.issues || []), ...failureIssues];
                  }
                }

                // Record iteration completion
                // Check if this iteration had fatal errors
                const hadFatalError = (itemResult.issues || []).some(issue => {
                  const id = issue.ruleId || '';
                  return (
                    id === 'command/execution_error' ||
                    id.endsWith('/command/execution_error') ||
                    id === 'command/transform_js_error' ||
                    id.endsWith('/command/transform_js_error') ||
                    id === 'command/transform_error' ||
                    id.endsWith('/command/transform_error') ||
                    id === 'forEach/undefined_output' ||
                    id.endsWith('/forEach/undefined_output')
                  );
                });
                const iterationDuration = (Date.now() - iterationStart) / 1000;
                this.recordIterationComplete(
                  checkName,
                  iterationStart,
                  !hadFatalError, // Success if no fatal errors
                  itemResult.issues || [],
                  (itemResult as any).output
                );

                // Track output history for forEach iterations
                const itemOutput = (itemResult as any).output;
                if (itemOutput !== undefined) {
                  this.trackOutputHistory(checkName, itemOutput);
                }

                // General branch-first scheduling for this item: execute all descendants (from current node only) when ready
                const descendantSet = (() => {
                  const visited = new Set<string>();
                  const stack = [checkName];
                  while (stack.length) {
                    const p = stack.pop()!;
                    const kids = childrenByParent.get(p) || [];
                    for (const k of kids) {
                      if (!visited.has(k)) {
                        visited.add(k);
                        stack.push(k);
                      }
                    }
                  }
                  return visited;
                })();

                const perItemDone = new Set<string>([...forEachParents, checkName]);
                const perItemDepMap = new Map<string, ReviewSummary>();
                for (const [k, v] of forEachDependencyResults) perItemDepMap.set(k, v);
                perItemDepMap.set(checkName, itemResult);

                const isFatal = (r: ReviewSummary | undefined): boolean => {
                  if (!r) return true;
                  return this.hasFatal(r.issues || []);
                };

                while (true) {
                  let progressed = false;
                  for (const node of descendantSet) {
                    if (perItemDone.has(node)) continue;
                    const nodeCfg = config.checks[node];
                    if (!nodeCfg) continue;
                    const deps = dependencies[node] || [];

                    // Are all deps satisfied for this item?
                    let ready = true;
                    const childDepsMap = new Map<string, ReviewSummary>();
                    for (const d of deps) {
                      // Prefer per-item result if already computed in this branch
                      const perItemRes = perItemDepMap.get(d);
                      if (perItemRes) {
                        if (isFatal(perItemRes)) {
                          ready = false;
                          break;
                        }
                        childDepsMap.set(d, perItemRes);
                        continue;
                      }

                      const agg = results.get(d) as ExtendedReviewSummary | undefined;
                      // If dependency is a forEach-capable result, require per-item unwrap
                      if (agg && (agg.isForEach || Array.isArray(agg.forEachItemResults))) {
                        const r =
                          (agg.forEachItemResults && agg.forEachItemResults[itemIndex]) ||
                          undefined;
                        const maskFatal =
                          !!agg.forEachFatalMask && agg.forEachFatalMask[itemIndex] === true;
                        if (!r || maskFatal || isFatal(r)) {
                          ready = false;
                          break;
                        }
                        childDepsMap.set(d, r);
                        continue;
                      }

                      // Fallback: use global dependency result (non-forEach)
                      if (!agg || isFatal(agg)) {
                        ready = false;
                        break;
                      }
                      childDepsMap.set(d, agg);
                    }
                    if (!ready) continue;

                    // if condition per item
                    if (nodeCfg.if) {
                      const condResults = new Map(results);
                      for (const [k, v] of childDepsMap) condResults.set(k, v);
                      const shouldRun = await this.evaluateCheckCondition(
                        node,
                        nodeCfg.if,
                        prInfo,
                        condResults,
                        debug
                      );
                      if (!shouldRun) {
                        perItemDone.add(node);
                        progressed = true;
                        continue;
                      }
                    }

                    // Execute node for this item
                    const nodeProvType = nodeCfg.type || 'ai';
                    const nodeProv = this.providerRegistry.getProviderOrThrow(nodeProvType);
                    this.setProviderWebhookContext(nodeProv);
                    const nodeProviderConfig: CheckProviderConfig = {
                      type: nodeProvType,
                      prompt: nodeCfg.prompt,
                      exec: nodeCfg.exec,
                      focus: nodeCfg.focus || this.mapCheckNameToFocus(node),
                      schema: nodeCfg.schema,
                      group: nodeCfg.group,
                      checkName: node,
                      eventContext: this.enrichEventContext(prInfo.eventContext),
                      transform: nodeCfg.transform,
                      transform_js: nodeCfg.transform_js,
                      env: nodeCfg.env,
                      forEach: nodeCfg.forEach,
                      ai: { timeout: timeout || 600000, debug: debug, ...(nodeCfg.ai || {}) },
                    };

                    const iterStart = this.recordIterationStart(node);
                    // Expand dependency map for execution context to include transitive ancestors
                    const execDepMap = new Map<string, ReviewSummary>(childDepsMap);
                    const nodeAllDeps = DependencyResolver.getAllDependencies(
                      node,
                      dependencyGraph.nodes
                    );
                    for (const dep of nodeAllDeps) {
                      if (execDepMap.has(dep)) continue;
                      // Prefer per-item map first
                      const perItemRes = perItemDepMap.get(dep);
                      if (perItemRes) {
                        execDepMap.set(dep, perItemRes);
                        continue;
                      }
                      const agg = results.get(dep) as ExtendedReviewSummary | undefined;
                      if (!agg) continue;
                      if (
                        agg &&
                        (agg.isForEach ||
                          Array.isArray(agg.forEachItemResults) ||
                          Array.isArray((agg as any).output))
                      ) {
                        if (
                          Array.isArray(agg.forEachItemResults) &&
                          agg.forEachItemResults[itemIndex]
                        ) {
                          execDepMap.set(dep, agg.forEachItemResults[itemIndex]!);
                        } else if (
                          Array.isArray((agg as any).output) &&
                          (agg as any).output[itemIndex] !== undefined
                        ) {
                          execDepMap.set(dep, {
                            issues: [],
                            output: (agg as any).output[itemIndex],
                          } as ReviewSummary);
                        } else {
                          execDepMap.set(dep, agg);
                        }
                      } else {
                        execDepMap.set(dep, agg);
                      }
                    }

                    const nodeItemRes = await this.executeWithRouting(
                      node,
                      nodeCfg,
                      nodeProv,
                      nodeProviderConfig,
                      prInfo,
                      execDepMap,
                      sessionInfo,
                      config,
                      dependencyGraph,
                      debug,
                      results,
                      { index: itemIndex, total: forEachItems.length, parent: forEachParentName }
                    );

                    if (config && (config.fail_if || nodeCfg.fail_if)) {
                      const fRes = await this.evaluateFailureConditions(node, nodeItemRes, config);
                      if (fRes.length > 0) {
                        const fIssues = fRes
                          .filter(f => f.failed)
                          .map(f => ({
                            file: 'system',
                            line: 0,
                            ruleId: f.conditionName,
                            message: f.message || `Failure condition met: ${f.expression}`,
                            severity: (f.severity || 'error') as
                              | 'info'
                              | 'warning'
                              | 'error'
                              | 'critical',
                            category: 'logic' as const,
                          }));
                        nodeItemRes.issues = [...(nodeItemRes.issues || []), ...fIssues];
                      }
                    }

                    const hadFatal = isFatal(nodeItemRes);
                    this.recordIterationComplete(
                      node,
                      iterStart,
                      !hadFatal,
                      nodeItemRes.issues || [],
                      (nodeItemRes as any).output
                    );

                    // Aggregate results for this node across items
                    if (!inlineAgg.has(node))
                      inlineAgg.set(node, {
                        issues: [],
                        outputs: [],
                        contents: [],
                        perItemResults: [],
                      });
                    const agg = inlineAgg.get(node)!;
                    if (nodeItemRes.issues) agg.issues.push(...nodeItemRes.issues);
                    const nout = (nodeItemRes as any).output;
                    if (nout !== undefined) agg.outputs.push(nout);
                    agg.perItemResults.push(nodeItemRes);
                    const ncontent = (nodeItemRes as any).content;
                    if (typeof ncontent === 'string' && ncontent.trim())
                      agg.contents.push(ncontent.trim());

                    perItemDepMap.set(node, nodeItemRes);
                    perItemDone.add(node);
                    progressed = true;
                  }
                  if (!progressed) break;
                }

                // Log iteration progress
                logger.info(
                  `  ✔ ${itemIndex + 1}/${forEachItems.length} (${iterationDuration.toFixed(1)}s)`
                );

                perItemResults[itemIndex] = itemResult;
                return { index: itemIndex, itemResult };
              });

              // Determine runnable indices by intersecting masks across all direct forEach parents
              const directForEachParents = (checkConfig.depends_on || []).filter(dep => {
                const r = results.get(dep) as ExtendedReviewSummary | undefined;
                return (
                  !!r &&
                  (r.isForEach ||
                    Array.isArray(r.forEachItemResults) ||
                    Array.isArray(r.forEachItems))
                );
              });
              if (directForEachParents.length > 0) {
                logger.debug(
                  `  forEach: direct parents for "${checkName}": ${directForEachParents.join(', ')}`
                );
              }

              const isIndexFatalForParent = async (
                parent: string,
                idx: number
              ): Promise<boolean> => {
                const agg = results.get(parent) as ExtendedReviewSummary | undefined;
                if (!agg) return false; // if missing, do not gate
                if (agg.forEachFatalMask && agg.forEachFatalMask[idx] === true) return true;
                const r = (agg.forEachItemResults && agg.forEachItemResults[idx]) || undefined;
                if (!r) return false;
                // 1) Issues-based fatality (provider/transform/timeout/fail_if markers)
                const hadFatalByIssues = this.hasFatal(r.issues || []);
                if (hadFatalByIssues) return true;
                // 2) Fail_if based fatality evaluated directly on the parent per-item result
                try {
                  if (config && (config.fail_if || config.checks[parent]?.fail_if)) {
                    // If output is a string, try parsing JSON (full or tail) to honor fail_if semantics
                    let rForEval: ReviewSummary = r;
                    const rawOut = (r as any)?.output;
                    if (typeof rawOut === 'string') {
                      const parseTail = (text: string): unknown | null => {
                        try {
                          const lines = text.split('\n');
                          for (let i = lines.length - 1; i >= 0; i--) {
                            const t = lines[i].trim();
                            if (t.startsWith('{') || t.startsWith('[')) {
                              const candidate = lines.slice(i).join('\n').trim();
                              if (
                                (candidate.startsWith('{') && candidate.endsWith('}')) ||
                                (candidate.startsWith('[') && candidate.endsWith(']'))
                              ) {
                                return JSON.parse(candidate);
                              }
                            }
                          }
                        } catch {}
                        try {
                          return JSON.parse(text);
                        } catch {
                          return null;
                        }
                      };
                      const parsed = parseTail(rawOut);
                      if (parsed && typeof parsed === 'object') {
                        rForEval = { ...r, output: parsed } as ReviewSummary & { output?: unknown };
                      }
                    }
                    const failures = await this.evaluateFailureConditions(parent, rForEval, config);
                    if (failures.some(f => f.failed)) {
                      // Temporary: surface why index is gated
                    }
                    if (failures.some(f => f.failed)) return true;
                  }
                } catch {}
                return false;
              };

              const runnableIndices: number[] = [];
              for (let idx = 0; idx < forEachItems.length; idx++) {
                let ok = true;
                for (const p of directForEachParents) {
                  if (await isIndexFatalForParent(p, idx)) {
                    ok = false;
                    break;
                  }
                }
                // Only schedule indices that have a corresponding task function
                if (ok && typeof itemTasks[idx] === 'function') runnableIndices.push(idx);
              }

              // no-op
              // Early skip if no runnable items after intersecting masks across all direct forEach parents
              if (runnableIndices.length === 0) {
                this.recordSkip(checkName, 'dependency_failed');
                logger.info(`⏭  Skipped (dependency failed: no runnable items)`);
                return {
                  checkName,
                  error: null,
                  result: { issues: [] },
                  skipped: true,
                };
              }

              const forEachConcurrency = Math.max(
                1,
                Math.min(runnableIndices.length, effectiveMaxParallelism)
              );

              if (debug && forEachConcurrency > 1) {
                log(
                  `🔄 Debug: Limiting forEach concurrency for check "${checkName}" to ${forEachConcurrency}`
                );
              }

              const scheduledTasks = runnableIndices
                .map(i => itemTasks[i])
                .filter(fn => typeof fn === 'function');
              const forEachResults = await this.executeWithLimitedParallelism(
                scheduledTasks,
                forEachConcurrency,
                false
              );

              let processedCount = 0;
              for (const result of forEachResults) {
                if (result.status === 'rejected') {
                  // Instead of throwing, record the failure and continue with other iterations
                  const error = result.reason;
                  const errorMessage = error instanceof Error ? error.message : String(error);

                  // Create an error issue for this failed iteration
                  allIssues.push({
                    ruleId: `${checkName}/forEach/iteration_error`,
                    severity: 'error',
                    category: 'logic',
                    message: `forEach iteration failed: ${errorMessage}`,
                    file: '',
                    line: 0,
                  });

                  if (debug) {
                    log(
                      `🔄 Debug: forEach iteration for check "${checkName}" failed: ${errorMessage}`
                    );
                  }
                  continue;
                }

                // Skip results from skipped items (those gated by dependencies/if)
                if ((result.value as any).skipped) {
                  continue;
                }

                const { index: finishedIndex, itemResult } = result.value as any;
                processedCount++;

                if (itemResult.issues) {
                  allIssues.push(...itemResult.issues);
                }

                const resultWithOutput = itemResult as ReviewSummary & {
                  output?: unknown;
                  content?: string;
                };

                allOutputs[finishedIndex] = resultWithOutput.output;

                const itemContent = resultWithOutput.content;
                if (typeof itemContent === 'string' && itemContent.trim()) {
                  aggregatedContents.push(itemContent.trim());
                } else {
                  const outStr =
                    typeof resultWithOutput.output === 'string'
                      ? (resultWithOutput.output as string).trim()
                      : '';
                  if (outStr) aggregatedContents.push(outStr);
                }
              }

              // If no items were processed (all gated), mark this check as skipped for dependency_failed
              if (processedCount === 0) {
                this.recordSkip(checkName, 'dependency_failed');
                logger.info(`⏭  Skipped (dependency failed for all items)`);
                return {
                  checkName,
                  error: null,
                  result: { issues: [] },
                  skipped: true,
                };
              }

              const finalOutput = allOutputs.length > 0 ? allOutputs : undefined;

              finalResult = {
                issues: allIssues,
                ...(finalOutput !== undefined ? { output: finalOutput } : {}),
              } as ExtendedReviewSummary;

              // Mark this result as forEach-capable and attach per-item results for precise downstream gating
              (finalResult as ExtendedReviewSummary).isForEach = true;
              (finalResult as ExtendedReviewSummary).forEachItems = allOutputs;
              (finalResult as ExtendedReviewSummary).forEachItemResults =
                perItemResults as ReviewSummary[];
              // Compute fatal mask
              try {
                const mask: boolean[] = (finalResult as ExtendedReviewSummary).forEachItemResults
                  ? await Promise.all(
                      Array.from({ length: forEachItems.length }, async (_, idx) => {
                        const r = (finalResult as ExtendedReviewSummary).forEachItemResults![idx];
                        if (!r) return false; // no result (skipped) → not fatal for descendants
                        let hadFatal = this.hasFatal(r.issues || []);
                        try {
                          const ids = (r.issues || []).map(i => i.ruleId).join(',');
                          logger.debug(
                            `  forEach: item ${idx + 1}/${forEachItems.length} issues=${(r.issues || []).length} ids=[${ids}]`
                          );
                        } catch {}
                        if (!hadFatal && config && (config.fail_if || checkConfig.fail_if)) {
                          try {
                            const failures = await this.evaluateFailureConditions(
                              checkName,
                              r,
                              config
                            );
                            hadFatal = failures.some(f => f.failed);
                          } catch {}
                        }
                        return hadFatal;
                      })
                    )
                  : [];
                (finalResult as ExtendedReviewSummary).forEachFatalMask = mask;
                logger.debug(
                  `  forEach: mask for "${checkName}" → fatals=${mask.filter(Boolean).length}/${mask.length}`
                );
              } catch {}

              if (aggregatedContents.length > 0) {
                (finalResult as ReviewSummary & { content?: string }).content =
                  aggregatedContents.join('\n');
              }

              // Finalize inline descendant aggregations to full results, so later levels skip them
              for (const [childName, agg] of inlineAgg.entries()) {
                const childCfg = config.checks[childName];
                const childEnrichedIssues = (agg.issues || []).map(issue => ({
                  ...issue,
                  checkName: childName,
                  ruleId: `${childName}/${issue.ruleId}`,
                  group: childCfg.group,
                  schema: typeof childCfg.schema === 'object' ? 'custom' : childCfg.schema,
                  template: childCfg.template,
                  timestamp: Date.now(),
                }));
                const childFinal: ExtendedReviewSummary = {
                  issues: childEnrichedIssues,
                  ...(agg.outputs.length > 0 ? { output: agg.outputs } : {}),
                  isForEach: true,
                  forEachItems: agg.outputs,
                  forEachItemResults: agg.perItemResults,
                  ...(agg.contents.length > 0 ? { content: agg.contents.join('\n') } : {}),
                };
                // Compute fatal mask for child aggregate
                try {
                  const mask: boolean[] = Array.from(
                    { length: agg.perItemResults.length },
                    (_, idx) => {
                      const r = agg.perItemResults[idx];
                      if (!r) return false; // skipped item is not fatal for descendants
                      const hadFatal = (r.issues || []).some(issue => {
                        const id = issue.ruleId || '';
                        return (
                          issue.severity === 'error' ||
                          issue.severity === 'critical' ||
                          id === 'command/execution_error' ||
                          id.endsWith('/command/execution_error') ||
                          id === 'command/timeout' ||
                          id.endsWith('/command/timeout') ||
                          id === 'command/transform_js_error' ||
                          id.endsWith('/command/transform_js_error') ||
                          id === 'command/transform_error' ||
                          id.endsWith('/command/transform_error') ||
                          id.endsWith('/forEach/iteration_error') ||
                          id === 'forEach/undefined_output' ||
                          id.endsWith('/forEach/undefined_output') ||
                          id.endsWith('_fail_if') ||
                          id.endsWith('/global_fail_if')
                        );
                      });
                      return hadFatal;
                    }
                  );
                  childFinal.forEachFatalMask = mask;
                } catch {}
                results.set(childName, childFinal);
              }

              if (
                debug &&
                process.env.VISOR_OUTPUT_FORMAT !== 'json' &&
                process.env.VISOR_OUTPUT_FORMAT !== 'sarif'
              ) {
                console.log(
                  `🔄 Debug: Completed forEach execution for check "${checkName}", total issues: ${allIssues.length}`
                );
              }
            } // End of else block for forEachItems.length > 0
          } else {
            // Normal single execution
            // Evaluate if condition for non-forEach-dependent checks
            if (checkConfig.if) {
              const shouldRun = await this.evaluateCheckCondition(
                checkName,
                checkConfig.if,
                prInfo,
                results,
                debug
              );

              if (!shouldRun) {
                // Record skip with condition
                this.recordSkip(checkName, 'if_condition', checkConfig.if);
                logger.info(`⏭  Skipped (if: ${this.truncate(checkConfig.if, 40)})`);
                return {
                  checkName,
                  error: null,
                  result: {
                    issues: [],
                  },
                  skipped: true,
                };
              }
            }

            // Execute with retry/routing semantics
            finalResult = await this.executeWithRouting(
              checkName,
              checkConfig,
              provider,
              providerConfig,
              prInfo,
              dependencyResults,
              sessionInfo,
              config,
              dependencyGraph,
              debug,
              results
            );
            try {
              emitNdjsonSpanWithEvents('visor.check', { 'visor.check.id': checkName }, [
                { name: 'check.started' },
                { name: 'check.completed' },
              ]);
            } catch {}

            // Evaluate fail_if for normal (non-forEach) execution
            if (config && (config.fail_if || checkConfig.fail_if)) {
              const failureResults = await this.evaluateFailureConditions(
                checkName,
                finalResult,
                config
              );
              if (failureResults.length > 0) {
                const failureIssues = failureResults
                  .filter(f => f.failed)
                  .map(f => ({
                    file: 'system',
                    line: 0,
                    ruleId: f.conditionName,
                    message: f.message || `Failure condition met: ${f.expression}`,
                    severity: (f.severity || 'error') as 'info' | 'warning' | 'error' | 'critical',
                    category: 'logic' as const,
                  }));
                finalResult.issues = [...(finalResult.issues || []), ...failureIssues];
              }
            }

            // Record normal (non-forEach) execution
            // Check if this check had fatal errors
            const hadFatalError = (finalResult.issues || []).some(issue => {
              const id = issue.ruleId || '';
              return (
                id === 'command/execution_error' ||
                id.endsWith('/command/execution_error') ||
                id === 'command/timeout' ||
                id.endsWith('/command/timeout') ||
                id === 'command/transform_js_error' ||
                id.endsWith('/command/transform_js_error') ||
                id === 'command/transform_error' ||
                id.endsWith('/command/transform_error') ||
                id === 'forEach/undefined_output' ||
                id.endsWith('/forEach/undefined_output')
              );
            });
            this.recordIterationComplete(
              checkName,
              checkStartTime,
              !hadFatalError, // Success if no fatal errors
              finalResult.issues || [],
              (finalResult as any).output
            );

            if (checkConfig.forEach) {
              try {
                const finalResultWithOutput = finalResult as ExtendedReviewSummary;
                const outputPreview =
                  JSON.stringify(finalResultWithOutput.output)?.slice(0, 200) || '(empty)';
                logger.debug(`🔧 Debug: Check "${checkName}" provider returned: ${outputPreview}`);
              } catch {
                // Ignore logging errors
              }
            }

            if (debug) {
              log(
                `🔧 Debug: Completed check: ${checkName}, issues found: ${(finalResult.issues || []).length}`
              );
            }

            // Track cloned session IDs for cleanup
            if (finalResult.sessionId) {
              sessionIds.set(checkName, finalResult.sessionId);
              if (debug) {
                log(`🔧 Debug: Tracked cloned session for cleanup: ${finalResult.sessionId}`);
              }
            }
          }

          // Add checkName, group, schema, template info and timestamp to issues from config
          const enrichedIssues = (finalResult.issues || []).map(issue => ({
            ...issue,
            checkName: checkName,
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

          const checkDuration = ((Date.now() - checkStartTime) / 1000).toFixed(1);
          const issueCount = enrichedIssues.length;
          const checkStats = this.executionStats.get(checkName);

          // Enhanced completion message with forEach stats
          if (checkStats && checkStats.totalRuns > 1) {
            if (issueCount > 0) {
              logger.success(
                `Check complete: ${checkName} (${checkDuration}s) - ${checkStats.totalRuns} runs, ${issueCount} issue${issueCount === 1 ? '' : 's'}`
              );
            } else {
              logger.success(
                `Check complete: ${checkName} (${checkDuration}s) - ${checkStats.totalRuns} runs`
              );
            }
          } else if (checkStats && checkStats.outputsProduced && checkStats.outputsProduced > 0) {
            logger.success(
              `Check complete: ${checkName} (${checkDuration}s) - ${checkStats.outputsProduced} items`
            );
          } else if (issueCount > 0) {
            logger.success(
              `Check complete: ${checkName} (${checkDuration}s) - ${issueCount} issue${issueCount === 1 ? '' : 's'} found`
            );
          } else {
            logger.success(`Check complete: ${checkName} (${checkDuration}s)`);
          }

          return {
            checkName,
            error: null,
            result: enrichedResult,
          };
        } catch (error) {
          const errorMessage =
            error instanceof Error ? `${error.message}\n${error.stack || ''}` : String(error);
          const checkDuration = ((Date.now() - checkStartTime) / 1000).toFixed(1);

          // Record error in stats
          this.recordError(checkName, error instanceof Error ? error : new Error(String(error)));
          this.recordIterationComplete(checkName, checkStartTime, false, [], undefined);

          logger.error(`✖ Check failed: ${checkName} (${checkDuration}s) - ${errorMessage}`);

          if (debug) {
            log(`🔧 Debug: Error in check ${checkName}: ${errorMessage}`);
          }

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
      const levelChecksList = executionGroup.parallel.filter(name => !results.has(name));
      for (let i = 0; i < levelResults.length; i++) {
        const checkName = levelChecksList[i];
        const result = levelResults[i];
        const checkConfig = config.checks[checkName];

        if (result.status === 'fulfilled' && result.value.result && !result.value.error) {
          // For skipped checks, store a marker so dependent checks can detect the skip
          if ((result.value as any).skipped) {
            if (debug) {
              log(`🔧 Debug: Storing skip marker for skipped check "${checkName}"`);
            }
            // Store a special marker result with a skip issue so dependencies can detect it
            results.set(checkName, {
              issues: [
                {
                  ruleId: `${checkName}/__skipped`,
                  severity: 'info',
                  category: 'logic',
                  message: 'Check was skipped',
                  file: '',
                  line: 0,
                },
              ],
            });
            continue;
          }

          const reviewResult = result.value.result;

          // Handle forEach logic - process array outputs
          const reviewSummaryWithOutput = reviewResult as ExtendedReviewSummary;

          if (checkConfig?.forEach && (!reviewResult.issues || reviewResult.issues.length === 0)) {
            const validation = this.validateAndNormalizeForEachOutput(
              checkName,
              reviewSummaryWithOutput.output,
              checkConfig.group
            );

            if (!validation.isValid) {
              results.set(
                checkName,
                validation.error.issues ? { issues: validation.error.issues } : {}
              );
              continue;
            }

            const normalizedOutput = validation.normalizedOutput;

            logger.debug(
              `🔧 Debug: Raw output for forEach check ${checkName}: ${
                Array.isArray(reviewSummaryWithOutput.output)
                  ? `array(${reviewSummaryWithOutput.output.length})`
                  : typeof reviewSummaryWithOutput.output
              }`
            );

            try {
              const preview = JSON.stringify(normalizedOutput);
              logger.debug(
                `🔧 Debug: Check "${checkName}" forEach output: ${preview?.slice(0, 200) || '(empty)'}`
              );
            } catch {
              // Ignore logging errors
            }

            // Store the array for iteration by dependent checks
            reviewSummaryWithOutput.forEachItems = normalizedOutput;
            reviewSummaryWithOutput.isForEach = true;
          }

          try {
            emitNdjsonSpanWithEvents('visor.check', { 'visor.check.id': checkName }, [
              { name: 'check.started' },
              { name: 'check.completed' },
            ]);
          } catch {}

          // Track output history for loop/goto scenarios
          const reviewResultWithOutput = reviewResult as ReviewSummary & { output?: unknown };
          if (reviewResultWithOutput.output !== undefined) {
            this.trackOutputHistory(checkName, reviewResultWithOutput.output);
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
            if (debug) {
              log(`🛑 Check "${checkName}" failed and fail-fast is enabled - stopping execution`);
            }
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
              if (debug) {
                log(
                  `🛑 Check "${checkName}" found critical/high issues and fail-fast is enabled - stopping execution`
                );
              }
              shouldStopExecution = true;
              break;
            }
          }
        }
      }
    }

    if (debug) {
      if (shouldStopExecution) {
        log(
          `🛑 Execution stopped early due to fail-fast after processing ${results.size} of ${checks.length} checks`
        );
      } else {
        log(`✅ Dependency-aware execution completed successfully for all ${results.size} checks`);
      }
    }

    // Handle on_finish hooks for forEach checks after ALL dependents complete
    if (!shouldStopExecution) {
      await this.handleOnFinishHooks(config, dependencyGraph, results, prInfo, debug || false);
    }

    // Cleanup sessions BEFORE printing summary to avoid mixing debug logs with table output
    if (sessionIds.size > 0 && debug) {
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

    // Build and log final execution summary
    const executionStatistics = this.buildExecutionStatistics();

    // Show detailed summary table (only if logFn outputs to console)
    // Skip when output format is JSON/SARIF to avoid polluting structured output
    // Check if logFn is console.log (not a no-op or console.error)
    if (logFn === console.log) {
      this.logExecutionSummary(executionStatistics);
    }

    // Add warning if execution stopped early
    if (shouldStopExecution) {
      logger.info('');
      logger.warn(`⚠️  Execution stopped early due to fail-fast`);
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
          // Evaluate if condition using any routing override event (e.g., goto_event)
          const override = this.routingEventOverride;
          const eventName = override
            ? override.startsWith('pr_')
              ? 'pull_request'
              : override === 'issue_comment'
                ? 'issue_comment'
                : override.startsWith('issue_')
                  ? 'issues'
                  : 'manual'
            : 'issue_comment';
          const commenterAssoc = resolveAssociationFromEvent(
            (prInfo as any)?.eventContext,
            prInfo.authorAssociation
          );
          const shouldRun = await this.failureEvaluator.evaluateIfCondition(
            checkName,
            checkConfig.if,
            {
              branch: prInfo.head,
              baseBranch: prInfo.base,
              filesChanged: prInfo.files.map(f => f.filename),
              event: eventName, // honor routing override if present
              environment: getSafeEnvironmentVariables(),
              previousResults: new Map(), // No previous results in parallel execution
              authorAssociation: commenterAssoc,
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
          eventContext: this.enrichEventContext(prInfo.eventContext),
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
      eventContext: this.enrichEventContext(prInfo.eventContext),
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
    const contentMap: Record<string, string> = {};
    const outputsMap: Record<string, unknown> = {};

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

    // Track which checks we've aggregated already
    const processed = new Set<string>();

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

        // Mark as processed
        processed.add(checkName);

        // Issues are already prefixed and enriched with group/schema info
        // Filter out internal __skipped markers
        const nonInternalIssues = (result.issues || []).filter(
          issue => !issue.ruleId?.endsWith('/__skipped')
        );
        aggregatedIssues.push(...nonInternalIssues);

        const resultSummary = result as ExtendedReviewSummary & { output?: unknown };
        const resultContent = resultSummary.content;
        if (typeof resultContent === 'string' && resultContent.trim()) {
          contentMap[checkName] = resultContent.trim();
        }
        if (resultSummary.output !== undefined) {
          outputsMap[checkName] = resultSummary.output;
        }
      }
    }

    // Include any additional results that were produced at runtime (e.g., forward-run via goto)
    // but were not part of the original execution DAG for the selected checks.
    for (const [checkName, result] of results.entries()) {
      if (processed.has(checkName)) continue;
      if (!result) continue;

      // Issues (already enriched)
      const nonInternalIssues = (result.issues || []).filter(
        issue => !issue.ruleId?.endsWith('/__skipped')
      );
      aggregatedIssues.push(...nonInternalIssues);

      const resultSummary = result as ExtendedReviewSummary & { output?: unknown };
      const resultContent = (resultSummary as any).content;
      if (typeof resultContent === 'string' && resultContent.trim()) {
        contentMap[checkName] = resultContent.trim();
      }
      if (resultSummary.output !== undefined) {
        outputsMap[checkName] = resultSummary.output;
      }

      debugInfo.push(
        `✅ (dynamic) Check "${checkName}" included: ${(result.issues || []).length} issues found`
      );
    }

    if (debug) {
      console.error(
        `🔧 Debug: Aggregated ${aggregatedIssues.length} issues from ${results.size} dependency-aware checks`
      );
    }

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

    const summary: ReviewSummary & {
      __contents?: Record<string, string>;
      __outputs?: Record<string, unknown>;
      __executed?: string[];
    } = {
      issues: filteredIssues,
      debug: aggregatedDebug,
    };

    if (Object.keys(contentMap).length > 0) {
      summary.__contents = contentMap;
    }
    if (Object.keys(outputsMap).length > 0) {
      summary.__outputs = outputsMap;
    }

    // Preserve the list of executed checks (keys in results Map) so downstream
    // grouping/formatting can include dynamically routed children even when they
    // produced neither issues nor output content (e.g., log-only steps).
    summary.__executed = Array.from(results.keys());

    return summary;
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
          logger.debug(`🔧 Debug: Check ${checkName} failed: ${checkResult.error}`);
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
          logger.debug(
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
        logger.debug(`🔧 Debug: Check ${checkName} promise rejected: ${errorMessage}`);
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

    if (debug) {
      console.error(
        `🔧 Debug: Aggregated ${aggregatedIssues.length} issues from ${results.length} checks`
      );
    }

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
  private isFailFastCandidate(value: unknown): value is {
    error?: string;
    result?: { issues?: Array<{ severity?: string }> };
  } {
    if (typeof value !== 'object' || value === null) {
      return false;
    }

    const candidate = value as {
      error?: unknown;
      result?: unknown;
    };

    if (candidate.error !== undefined && typeof candidate.error !== 'string') {
      return false;
    }

    if (candidate.result !== undefined) {
      if (typeof candidate.result !== 'object' || candidate.result === null) {
        return false;
      }

      const issues = (candidate.result as { issues?: unknown }).issues;
      if (issues !== undefined && !Array.isArray(issues)) {
        return false;
      }
    }

    return true;
  }

  private shouldFailFast(result: unknown): boolean {
    if (!this.isFailFastCandidate(result)) {
      return false;
    }

    if (result.error) {
      return true;
    }

    // If the result has a result with critical or error issues, it should fail fast
    const issues = result.result?.issues;
    if (Array.isArray(issues)) {
      return issues.some(issue => issue?.severity === 'error' || issue?.severity === 'critical');
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
    config?: import('./types/config').VisorConfig,
    prInfo?: PRInfo
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

        try {
          addEvent('fail_if.evaluated', {
            check: checkName,
            scope: 'global',
            name: 'global_fail_if',
            expression: globalFailIf,
          });
        } catch {}
        if (failed) {
          try {
            addEvent('fail_if.triggered', {
              check: checkName,
              scope: 'global',
              name: 'global_fail_if',
              expression: globalFailIf,
              severity: 'error',
            });
          } catch {}
          try {
            addFailIfTriggered(checkName, 'global');
          } catch {}
          try {
            const { emitNdjsonSpanWithEvents } = require('./telemetry/fallback-ndjson');
            emitNdjsonSpanWithEvents(
              'visor.fail_if',
              { check: checkName, scope: 'global', name: 'global_fail_if' },
              [
                {
                  name: 'fail_if.triggered',
                  attrs: {
                    check: checkName,
                    scope: 'global',
                    name: 'global_fail_if',
                    expression: globalFailIf,
                    severity: 'error',
                  },
                },
              ]
            );
          } catch {}
          logger.warn(`⚠️  Check "${checkName}" - global fail_if condition met: ${globalFailIf}`);
          results.push({
            conditionName: 'global_fail_if',
            expression: globalFailIf,
            failed: true,
            severity: 'error',
            message: 'Global failure condition met',
            haltExecution: false,
          });
        } else {
          logger.debug(`✓ Check "${checkName}" - global fail_if condition passed`);
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

        try {
          addEvent('fail_if.evaluated', {
            check: checkName,
            scope: 'check',
            name: `${checkName}_fail_if`,
            expression: checkFailIf,
          });
        } catch {}
        try {
          const { emitNdjsonSpanWithEvents } = require('./telemetry/fallback-ndjson');
          emitNdjsonSpanWithEvents(
            'visor.fail_if',
            { check: checkName, scope: 'check', name: `${checkName}_fail_if` },
            [
              {
                name: 'fail_if.evaluated',
                attrs: {
                  check: checkName,
                  scope: 'check',
                  name: `${checkName}_fail_if`,
                  expression: checkFailIf,
                },
              },
            ]
          );
        } catch {}
        if (failed) {
          try {
            addEvent('fail_if.triggered', {
              check: checkName,
              scope: 'check',
              name: `${checkName}_fail_if`,
              expression: checkFailIf,
              severity: 'error',
            });
          } catch {}
          try {
            addEvent('fail_if.evaluated', {
              check: checkName,
              scope: 'check',
              name: `${checkName}_fail_if`,
              expression: checkFailIf,
            });
          } catch {}
          try {
            addFailIfTriggered(checkName, 'check');
          } catch {}
          try {
            const { emitNdjsonSpanWithEvents } = require('./telemetry/fallback-ndjson');
            emitNdjsonSpanWithEvents(
              'visor.fail_if',
              { check: checkName, scope: 'check', name: `${checkName}_fail_if` },
              [
                {
                  name: 'fail_if.triggered',
                  attrs: {
                    check: checkName,
                    scope: 'check',
                    name: `${checkName}_fail_if`,
                    expression: checkFailIf,
                    severity: 'error',
                  },
                },
              ]
            );
          } catch {}
          logger.warn(`⚠️  Check "${checkName}" - fail_if condition met: ${checkFailIf}`);
          results.push({
            conditionName: `${checkName}_fail_if`,
            expression: checkFailIf,
            failed: true,
            severity: 'error',
            message: `Check ${checkName} failure condition met`,
            haltExecution: false,
          });
        } else {
          logger.debug(`✓ Check "${checkName}" - fail_if condition passed`);
        }
      }

      try {
        const { emitNdjsonSpanWithEvents } = require('./telemetry/fallback-ndjson');
        const hadTriggered = results.some(r => r.failed === true);
        emitNdjsonSpanWithEvents(
          'visor.fail_if',
          {
            check: checkName,
            scope: hadTriggered
              ? checkFailIf
                ? 'check'
                : 'global'
              : checkFailIf
                ? 'check'
                : 'global',
          },
          [
            {
              name: 'fail_if.evaluated',
              attrs: { check: checkName, scope: checkFailIf ? 'check' : 'global' },
            },
          ].concat(
            hadTriggered
              ? [
                  {
                    name: 'fail_if.triggered',
                    attrs: { check: checkName, scope: checkFailIf ? 'check' : 'global' },
                  },
                ]
              : []
          )
        );
      } catch {}
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
      checkConditions,
      undefined, // previousOutputs
      prInfo?.authorAssociation
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
    options: CheckExecutionOptions,
    prInfo: import('./pr-analyzer').PRInfo
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

    // Group issues by their check name
    for (const issue of reviewSummary.issues || []) {
      if (issue.checkName && issuesByCheck.has(issue.checkName)) {
        issuesByCheck.get(issue.checkName)!.push(issue);
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

        // Detect command execution failure patterns to mark check as failed without requiring fail_if
        // We treat issues with ruleId starting with 'command/' as execution errors
        const execErrorIssue = checkIssues.find(i => i.ruleId?.startsWith('command/'));

        await this.githubCheckService.completeCheckRun(
          options.githubChecks.owner,
          options.githubChecks.repo,
          checkRun.id,
          checkName,
          failureResults,
          checkIssues,
          execErrorIssue ? execErrorIssue.message : undefined, // executionError
          prInfo.files.map((f: import('./pr-analyzer').PRFile) => f.filename), // filesChangedInCommit
          options.githubChecks.prNumber, // prNumber
          options.githubChecks.headSha // currentCommitSha
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

  /**
   * Initialize execution statistics for a check
   */
  private initializeCheckStats(checkName: string): void {
    this.executionStats.set(checkName, {
      checkName,
      totalRuns: 0,
      successfulRuns: 0,
      failedRuns: 0,
      skipped: false,
      totalDuration: 0,
      issuesFound: 0,
      issuesBySeverity: {
        critical: 0,
        error: 0,
        warning: 0,
        info: 0,
      },
      perIterationDuration: [],
    });
  }

  /**
   * Record the start of a check iteration
   * Returns the start timestamp for duration tracking
   */
  private recordIterationStart(_checkName: string): number {
    return Date.now();
  }

  /**
   * Record completion of a check iteration
   */
  private recordIterationComplete(
    checkName: string,
    startTime: number,
    success: boolean,
    issues: ReviewIssue[],
    output?: unknown
  ): void {
    const stats = this.executionStats.get(checkName);
    if (!stats) return;

    const duration = Date.now() - startTime;
    stats.totalRuns++;
    if (success) {
      stats.successfulRuns++;
    } else {
      stats.failedRuns++;
    }
    stats.totalDuration += duration;
    stats.perIterationDuration!.push(duration);

    // Count issues by severity
    for (const issue of issues) {
      stats.issuesFound++;
      if (issue.severity === 'critical') stats.issuesBySeverity.critical++;
      else if (issue.severity === 'error') stats.issuesBySeverity.error++;
      else if (issue.severity === 'warning') stats.issuesBySeverity.warning++;
      else if (issue.severity === 'info') stats.issuesBySeverity.info++;
    }

    // Track outputs produced
    if (output !== undefined) {
      stats.outputsProduced = (stats.outputsProduced || 0) + 1;
    }
  }

  /**
   * Track output in history for loop/goto scenarios
   */
  private trackOutputHistory(checkName: string, output: unknown): void {
    if (output === undefined) return;

    if (!this.outputHistory.has(checkName)) {
      this.outputHistory.set(checkName, []);
    }
    this.outputHistory.get(checkName)!.push(output);
  }

  /**
   * Record that a check was skipped
   */
  private recordSkip(
    checkName: string,
    reason: 'if_condition' | 'fail_fast' | 'dependency_failed',
    condition?: string
  ): void {
    const stats = this.executionStats.get(checkName);
    if (!stats) return;

    stats.skipped = true;
    stats.skipReason = reason;
    if (condition) {
      stats.skipCondition = condition;
    }
  }

  /**
   * Record forEach preview items
   */
  private recordForEachPreview(checkName: string, items: unknown[] | undefined): void {
    const stats = this.executionStats.get(checkName);
    if (!stats) return;
    if (!Array.isArray(items) || items.length === 0) return;

    // Store preview of first 3 items
    const preview = items.slice(0, 3).map(item => {
      let str: string;
      if (typeof item === 'string') {
        str = item;
      } else if (item === undefined || item === null) {
        str = '(empty)';
      } else {
        try {
          const j = JSON.stringify(item);
          str = typeof j === 'string' ? j : String(item);
        } catch {
          str = String(item);
        }
      }
      return str.length > 50 ? str.substring(0, 47) + '...' : str;
    });

    if (items.length > 3) {
      preview.push(`...${items.length - 3} more`);
    }

    stats.forEachPreview = preview;
  }

  /**
   * Record an error for a check
   */
  private recordError(checkName: string, error: Error | string): void {
    const stats = this.executionStats.get(checkName);
    if (!stats) return;

    stats.errorMessage = error instanceof Error ? error.message : String(error);
  }

  /**
   * Build the final execution statistics object
   */
  private buildExecutionStatistics(): ExecutionStatistics {
    const checks = Array.from(this.executionStats.values());
    const totalExecutions = checks.reduce((sum, s) => sum + s.totalRuns, 0);
    const successfulExecutions = checks.reduce((sum, s) => sum + s.successfulRuns, 0);
    const failedExecutions = checks.reduce((sum, s) => sum + s.failedRuns, 0);
    const skippedChecks = checks.filter(s => s.skipped).length;
    const totalDuration = checks.reduce((sum, s) => sum + s.totalDuration, 0);

    return {
      totalChecksConfigured: checks.length,
      totalExecutions,
      successfulExecutions,
      failedExecutions,
      skippedChecks,
      totalDuration,
      checks,
    };
  }

  // Generic fatality helpers to avoid duplication
  private isFatalRule(id: string, severity?: string): boolean {
    const sev = (severity || '').toLowerCase();
    return (
      sev === 'error' ||
      sev === 'critical' ||
      id === 'command/execution_error' ||
      id.endsWith('/command/execution_error') ||
      id === 'command/timeout' ||
      id.endsWith('/command/timeout') ||
      id === 'command/transform_js_error' ||
      id.endsWith('/command/transform_js_error') ||
      id === 'command/transform_error' ||
      id.endsWith('/command/transform_error') ||
      id.endsWith('/forEach/iteration_error') ||
      id === 'forEach/undefined_output' ||
      id.endsWith('/forEach/undefined_output') ||
      id.endsWith('_fail_if') ||
      id.endsWith('/global_fail_if')
    );
  }

  private hasFatal(issues: ReviewIssue[] | undefined): boolean {
    if (!issues || issues.length === 0) return false;
    return issues.some(i => this.isFatalRule(i.ruleId || '', i.severity));
  }

  private async failIfTriggered(
    checkName: string,
    result: ReviewSummary,
    config?: import('./types/config').VisorConfig
  ): Promise<boolean> {
    if (!config) return false;
    const failures = await this.evaluateFailureConditions(checkName, result, config);
    return failures.some(f => f.failed);
  }

  /**
   * Truncate a string to max length with ellipsis
   */
  private truncate(str: string, maxLen: number): string {
    if (str.length <= maxLen) return str;
    return str.substring(0, maxLen - 3) + '...';
  }

  /**
   * Format the Status column for execution summary table
   */
  private formatStatusColumn(stats: CheckExecutionStats): string {
    if (stats.skipped) {
      if (stats.skipReason === 'if_condition') return '⏭ if';
      if (stats.skipReason === 'fail_fast') return '⏭ ff';
      if (stats.skipReason === 'dependency_failed') return '⏭ dep';
      return '⏭';
    }

    if (stats.totalRuns === 0) return '-';

    const symbol = stats.failedRuns === 0 ? '✔' : stats.successfulRuns === 0 ? '✖' : '✔/✖';

    // Show iteration count if > 1
    if (stats.totalRuns > 1) {
      if (stats.failedRuns > 0 && stats.successfulRuns > 0) {
        // Partial success
        return `${symbol} ${stats.successfulRuns}/${stats.totalRuns}`;
      } else {
        // All success or all failed
        return `${symbol} ×${stats.totalRuns}`;
      }
    }

    return symbol;
  }

  /**
   * Format the Details column for execution summary table
   */
  private formatDetailsColumn(stats: CheckExecutionStats): string {
    const parts: string[] = [];

    // Outputs produced (forEach)
    if (stats.outputsProduced && stats.outputsProduced > 0) {
      parts.push(`→${stats.outputsProduced}`);
    }

    // Critical issues
    if (stats.issuesBySeverity.critical > 0) {
      parts.push(`${stats.issuesBySeverity.critical}🔴`);
    }

    // Warnings
    if (stats.issuesBySeverity.warning > 0) {
      parts.push(`${stats.issuesBySeverity.warning}⚠️`);
    }

    // Info (only if no critical/warnings)
    if (
      stats.issuesBySeverity.info > 0 &&
      stats.issuesBySeverity.critical === 0 &&
      stats.issuesBySeverity.warning === 0
    ) {
      parts.push(`${stats.issuesBySeverity.info}💡`);
    }

    // Error message or skip condition
    if (stats.errorMessage) {
      parts.push(this.truncate(stats.errorMessage, 20));
    } else if (stats.skipCondition) {
      parts.push(this.truncate(stats.skipCondition, 20));
    }

    return parts.join(' ');
  }

  /**
   * Log the execution summary table
   */
  private logExecutionSummary(stats: ExecutionStatistics): void {
    const totalIssues = stats.checks.reduce((sum, s) => sum + s.issuesFound, 0);
    const criticalIssues = stats.checks.reduce((sum, s) => sum + s.issuesBySeverity.critical, 0);
    const warningIssues = stats.checks.reduce((sum, s) => sum + s.issuesBySeverity.warning, 0);
    const durationSec = (stats.totalDuration / 1000).toFixed(1);

    // Summary box
    const summaryTable = new (require('cli-table3'))({
      style: {
        head: [],
        border: [],
      },
      colWidths: [41],
    });

    summaryTable.push(
      [`Execution Complete (${durationSec}s)`],
      [`Checks: ${stats.totalChecksConfigured} configured → ${stats.totalExecutions} executions`],
      [
        `Status: ${stats.successfulExecutions} ✔ │ ${stats.failedExecutions} ✖ │ ${stats.skippedChecks} ⏭`,
      ]
    );

    if (totalIssues > 0) {
      let issuesLine = `Issues: ${totalIssues} total`;
      if (criticalIssues > 0) issuesLine += ` (${criticalIssues} 🔴`;
      if (warningIssues > 0) issuesLine += `${criticalIssues > 0 ? ' ' : ' ('}${warningIssues} ⚠️)`;
      else if (criticalIssues > 0) issuesLine += ')';
      summaryTable.push([issuesLine]);
    }

    logger.info('');
    logger.info(summaryTable.toString());

    // Details table
    logger.info('');
    logger.info('Check Details:');

    const detailsTable = new (require('cli-table3'))({
      head: ['Check', 'Duration', 'Status', 'Details'],
      colWidths: [21, 10, 10, 21],
      style: {
        head: ['cyan'],
        border: ['grey'],
      },
    });

    for (const checkStats of stats.checks) {
      const duration = checkStats.skipped
        ? '-'
        : `${(checkStats.totalDuration / 1000).toFixed(1)}s`;
      const status = this.formatStatusColumn(checkStats);
      const details = this.formatDetailsColumn(checkStats);

      detailsTable.push([checkStats.checkName, duration, status, details]);
    }

    logger.info(detailsTable.toString());

    // Legend
    logger.info('');
    logger.info(
      'Legend: ✔=success │ ✖=failed │ ⏭=skipped │ ×N=iterations │ →N=outputs │ N🔴=critical │ N⚠️=warnings'
    );
  }
}
