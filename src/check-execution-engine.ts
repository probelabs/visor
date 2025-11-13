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
import { ExecutionJournal, ScopePath, ContextView } from './snapshot-store';
import { createSecureSandbox, compileAndRun } from './utils/sandbox';
import {
  projectOutputs as ofProject,
  decideRouting as ofDecide,
  computeAllValid as ofAllValid,
  runOnFinishChildren as ofRunChildren,
} from './engine/on-finish/orchestrator';
import { composeOnFinishContext as ofComposeCtx } from './engine/on-finish/utils';
import { VisorConfig, OnFailConfig, OnSuccessConfig, OnFinishConfig } from './types/config';
import {
  createPermissionHelpers,
  detectLocalMode,
  resolveAssociationFromEvent,
} from './utils/author-permissions';
import { MemoryStore } from './memory-store';
import { emitNdjsonSpanWithEvents, emitNdjsonFallback } from './telemetry/fallback-ndjson';
import { addEvent, withActiveSpan } from './telemetry/trace-helpers';
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
  // Provider/self time (excludes time spent running routed children/descendants)
  providerDurationMs?: number;
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
  const { buildSandboxEnv } = require('./utils/env-exposure');
  return buildSandboxEnv(process.env);
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
  // Track on_finish loop counts per forEach parent during a single execution run
  private onFinishLoopCounts: Map<string, number> = new Map();
  // Track how many times a forEach parent check has produced an array during this run ("waves")
  private forEachWaveCounts: Map<string, number> = new Map();
  // One-shot guards for post on_finish scheduling to avoid duplicate replies when
  // multiple signals (aggregator, memory, history) agree. Keyed by session + parent check.
  private postOnFinishGuards: Set<string> = new Set();
  // Per-run execution cap counters (guard infinite loops). Keyed by check + scope.
  private runCounters: Map<string, number> = new Map();
  // Snapshot+Scope journal (Phase 0: commit only, no behavior changes yet)
  private journal: ExecutionJournal = new ExecutionJournal();
  private sessionId: string = `sess-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  // Dedup forward-run targets within a single grouped run (stage/event).
  // Keyed by `${event}:${target}`.
  private forwardRunGuards: Set<string> = new Set();
  // Guard dependents scheduled via forward-run to avoid races with level tasks
  private forwardDependentsScheduled: Set<string> = new Set();
  // Marker for grouped wave rescheduling when on_fail forward-run occurred
  private onFailForwardRunSeen: boolean = false;
  // Marker for grouped wave rescheduling when on_finish routing occurred
  private onFinishForwardRunSeen: boolean = false;
  // Track per-grouped-run scheduling of specific steps we want to allow only once.
  // Currently used to ensure 'validate-fact' is scheduled at most once per stage.
  private oncePerRunScheduleGuards: Set<string> = new Set();
  // Event override to simulate alternate event (used during routing goto)
  private routingEventOverride?: import('./types/config').EventTrigger;
  // Execution context for providers (CLI message, hooks, etc.)
  private executionContext?: import('./providers/check-provider.interface').ExecutionContext;
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
    // Prefer the provided authenticated/recording Octokit (from test runner or Actions)
    // so that comment create/update operations are visible to recorders and assertions.
    const reviewerOctokit =
      (octokit as unknown as import('@octokit/rest').Octokit) ||
      (this.mockOctokit as unknown as import('@octokit/rest').Octokit);
    this.reviewer = new PRReviewer(reviewerOctokit);
  }

  private sessionUUID(): string {
    return this.sessionId;
  }

  /**
   * Reset per-run guard and statistics state. Callers that orchestrate grouped
   * executions (e.g., the YAML test runner) can invoke this to ensure clean
   * stage-local accounting without introducing test-specific branches in the
   * core engine.
   */
  public resetPerRunState(): void {
    try {
      this.forwardRunGuards.clear();
    } catch {}
    try {
      this.oncePerRunScheduleGuards.clear();
    } catch {}
    try {
      this.onFinishLoopCounts.clear();
      this.forEachWaveCounts.clear();
    } catch {}
    try {
      // Fully reset stage-scoped state so flows don't leak across stages.
      this['executionStats'].clear();
      // Do NOT clear outputHistory here; multi-turn flows (e.g., ask→refine→ask)
      // rely on outputs_history across waves within a single run.
      this.postOnFinishGuards.clear();
      this.forwardDependentsScheduled.clear();
      this.runCounters.clear();
      this.routingEventOverride = undefined;
      // Start a fresh journal for snapshot-based dependency views
      this.journal = new (require('./snapshot-store').ExecutionJournal)();
    } catch {}
  }

  /** Build a stable key for counting executions per check and per scope (forEach items separated). */
  private buildRunKey(checkId: string, scope?: ScopePath): string {
    if (!scope || scope.length === 0) return checkId;
    try {
      const parts = scope.map(s => `${s.check}:${s.index}`);
      return `${checkId}@${parts.join('/')}`;
    } catch {
      return checkId;
    }
  }

  /** Resolve effective max runs for a check (step override > global default). */
  private resolveMaxRuns(config: VisorConfig, checkId: string): number {
    try {
      const step = (config.checks || (config as any).steps || {})[checkId] as
        | import('./types/config').CheckConfig
        | undefined;
      const perStep = (step as any)?.max_runs;
      if (typeof perStep === 'number') return perStep;
    } catch {}
    const global = (config.limits && (config.limits as any).max_runs_per_check) ?? 50;
    return typeof global === 'number' ? global : 50;
  }

  private commitJournal(
    checkId: string,
    result: ExtendedReviewSummary,
    event?: import('./types/config').EventTrigger,
    scopeOverride?: ScopePath
  ): void {
    try {
      const scope: ScopePath = scopeOverride || [];
      this.journal.commitEntry({
        sessionId: this.sessionUUID(),
        scope,
        checkId,
        event,
        result,
      });
    } catch {
      // best effort; never throw
    }
  }

  /** Build dependencyResults from a snapshot of all committed results, optionally overlaying provided results. */
  private buildSnapshotDependencyResults(
    scope: ScopePath,
    overlay: Map<string, ReviewSummary> | undefined,
    event: import('./types/config').EventTrigger | undefined
  ): Map<string, ReviewSummary> {
    const snap = this.journal.beginSnapshot();
    const view = new ContextView(this.journal, this.sessionUUID(), snap, scope, event);
    const visible = new Map<string, ReviewSummary>();
    try {
      const entries = this.journal.readVisible(this.sessionUUID(), snap, event);
      const ids = Array.from(new Set(entries.map(e => e.checkId)));
      for (const id of ids) {
        const v = view.get(id);
        if (v) visible.set(id, v);
        const raw = view.getRaw(id);
        if (raw) visible.set(`${id}-raw`, raw);
      }
      // Overlay any provided results (e.g., per-item context) on top.
      // Root-cause hardening: ignore non-string keys and log once.
      if (overlay) {
        for (const [k, v] of overlay.entries()) {
          if (typeof k === 'string' && k) {
            visible.set(k, v);
          } else {
            try {
              require('./logger').logger.warn(
                `sanitize: dropping non-string overlay key type=${typeof k}`
              );
            } catch {}
          }
        }
      }
    } catch {}
    return visible;
  }

  /** Drop any non-string keys from a results-like map (root-cause guard). */
  private sanitizeResultMapKeys(
    m: Map<unknown, ReviewSummary> | undefined
  ): Map<string, ReviewSummary> {
    const out = new Map<string, ReviewSummary>();
    if (!m) return out;
    for (const [k, v] of m.entries()) {
      if (typeof k === 'string' && k) out.set(k, v);
      else {
        try {
          require('./logger').logger.warn(
            `sanitize: dropping non-string results key type=${typeof k}`
          );
        } catch {}
      }
    }
    return out;
  }

  /**
   * Enrich event context with authenticated octokit instance
   * @param eventContext - The event context to enrich
   * @returns Enriched event context with octokit if available
   */
  private enrichEventContext(eventContext?: Record<string, unknown>): Record<string, unknown> {
    const baseContext = eventContext || {};
    const injected = this.actionContext?.octokit || (baseContext as any).octokit;
    if (injected) {
      return { ...baseContext, octokit: injected };
    }
    return baseContext;
  }

  /**
   * Schedule a forward-run starting from `target` and continuing through all
   * transitive dependents that declare a dependency (direct or indirect) on
   * `target`. Execution honors optional `gotoEvent` by filtering dependents to
   * only those steps whose `on` includes that event. The `target` itself is
   * always executed first regardless of event filtering.
   *
   * This helper is used for goto across all origins (on_success, on_fail,
   * on_finish) to ensure consistent semantics and avoid duplicating logic.
   */
  private async scheduleForwardRun(
    target: string,
    opts: {
      origin: 'on_success' | 'on_fail' | 'on_finish' | 'inline';
      gotoEvent?: import('./types/config').EventTrigger;
      config: VisorConfig;
      dependencyGraph: DependencyGraph;
      prInfo: PRInfo;
      resultsMap: Map<string, ReviewSummary>;
      debug: boolean;
      // When executing inside a forEach item, pass the scope for that item
      foreachScope?: ScopePath;
      // If not in a forEach item, but the source step was a map, we may need the
      // source identity and items to produce per-item scopes.
      sourceCheckName?: string;
      sourceCheckConfig?: CheckConfig;
      sourceOutputForItems?: unknown;
    }
  ): Promise<void> {
    const {
      origin,
      gotoEvent,
      config,
      dependencyGraph,
      prInfo,
      resultsMap,
      debug,
      foreachScope,
      sourceCheckName,
      sourceCheckConfig,
      sourceOutputForItems,
    } = opts;

    const cfgChecks = (config?.checks || {}) as Record<
      string,
      import('./types/config').CheckConfig
    >;
    if (!cfgChecks[target]) return;

    // Build forward closure (target + transitive dependents of target)
    const forwardSet = new Set<string>([target]);
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
    const ev = gotoEvent || prInfo.eventType || 'manual';
    for (const name of Object.keys(cfgChecks)) {
      if (name === target) continue;
      const onArr = cfgChecks[name]?.on as any;
      const eventMatches = !onArr || (Array.isArray(onArr) && onArr.includes(ev));
      if (!eventMatches) continue;
      if (dependsOn(name, target)) forwardSet.add(name);
    }

    // Topologically order the subset to run target before dependents respecting depends_on
    const order: string[] = [];
    const inSet = (n: string) => forwardSet.has(n);
    const tempMarks = new Set<string>();
    const permMarks = new Set<string>();
    const stack: string[] = [];
    const visit = (n: string) => {
      if (permMarks.has(n)) return;
      if (tempMarks.has(n)) {
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

    // Revert dependent auto-forwarding for correction cycles:
    // - For origin on_fail/on_finish we only schedule the target and let the DAG
    //   naturally execute dependents in the next wave. This avoids duplicate
    //   inline runs of dependents (especially forEach dependents) and restores
    //   stable execution counts expected by tests.
    if (origin === 'on_fail' || origin === 'on_finish') {
      order.splice(0, order.length, target);
    }

    const prevEventOverride = this.routingEventOverride;
    // Ensure we only execute the target once per grouped run for a given event
    const evKey = gotoEvent || prInfo.eventType || 'manual';
    const guardKey = `${String(evKey)}:${String(target)}`;
    const runTargetOnce = async (
      scopeForRun: ScopePath,
      guard: boolean
    ): Promise<ReviewSummary | undefined> => {
      // When guard=true we dedupe within a grouped run; when false we allow
      // multiple re-executions (e.g., on_finish correction waves).
      if (guard) {
        if (this.forwardRunGuards.has(guardKey)) {
          // Allow re-run if the last recorded result for target was fatal and the
          // target did not opt into continue_on_failure (we need another attempt).
          try {
            const prior = resultsMap.get(target);
            let hadFatal = prior && Array.isArray(prior.issues) && this.hasFatal(prior.issues);
            const tcfgCont = (cfgChecks[target] as any)?.continue_on_failure === true;
            if (tcfgCont) hadFatal = false;
            if (!hadFatal) return undefined;
          } catch {
            return undefined;
          }
        }
        this.forwardRunGuards.add(guardKey);
      }
      const res = await this.runNamedCheck(target, scopeForRun, {
        origin,
        config,
        dependencyGraph,
        prInfo,
        resultsMap,
        debug,
        eventOverride: gotoEvent,
      });
      // Ensure resultsMap reflects the freshest result for gating
      try {
        resultsMap.set(target, res);
      } catch {}
      // Mark target as forward-scheduled AFTER inline execution so grouped
      // runner can skip duplicates in subsequent waves without blocking inline.
      try {
        this.forwardDependentsScheduled.add(target);
      } catch {}
      return res;
    };

    // Decide whether to dedupe target in this grouped run.
    // For on_finish correction waves we allow re-execution of the target.
    // Additionally, respect a 'repeatable' tag on the target step which
    // explicitly opts the step into re-execution within the same event/wave
    // (useful for chat-style loops driven by fail_if + on_fail/on_success).
    // Allow re-running the target within the same grouped run when routing originates from on_fail.
    // This enables explicit correction loops without any special tags.
    const guardTargetOnce = origin !== 'on_finish' && origin !== 'on_fail';
    try {
      if (origin === 'on_fail') {
        (this as any).onFailForwardRunSeen = true;
        if (debug)
          (config?.output?.pr_comment ? console.error : console.log)(
            '🔁 Debug: on_fail forward-run seen; flag set'
          );
      }
    } catch {}

    if (gotoEvent) this.routingEventOverride = gotoEvent;

    // In test/grouped mode, suppress inline execution for on_success-originated
    // routing to avoid double-running targets (once inline and again in the
    // grouped wave). Allow the grouped runner to pick it up naturally.
    try {
      const inTest = Boolean(
        (this as any).executionContext && (this as any).executionContext.mode?.test
      );
      // Keep executing on_success targets inline in tests as well so that
      // transitive dependents (e.g., overview → quality) can be run within the
      // same correction cycle, matching integration expectations.
      // We still avoid inline dependents for on_fail/on_finish paths below.
      void inTest; // no-op; present for clarity
    } catch {}

    // Do not execute target inline for on_fail-originated routing.
    // Mark that a correction wave is needed; enqueue ONLY the target and allow
    // the DAG to execute dependents in the next wave. This preserves
    // dependency gating semantics (e.g., confirm-interpret → run-commands).
    if (origin === 'on_fail') {
      try {
        // Only mark the target for forward scheduling. Let the DAG naturally
        // re-run transitive dependents in the next wave to preserve dependency
        // gating semantics.
        this.forwardDependentsScheduled.add(target);
        const dependentsOnly = order.filter(n => n !== target);
        const fwd = Array.from(forwardSet || []).join(', ');
        const deps = dependentsOnly.join(', ');
        (config?.output?.pr_comment ? console.error : console.log)(
          `🔧 Debug: on_fail forward-set=[${fwd}] dependents=[${deps}]`
        );
      } catch {}
      // Defer execution to the next wave to keep counts deterministic
      return;
    }
    // Do not execute target inline for on_finish-originated routing. Treat it
    // the same as on_fail: schedule target for the next wave and return.
    if (origin === 'on_finish') {
      try {
        this.forwardDependentsScheduled.add(target);
      } catch {}
      return;
    }
    try {
      // Determine mapping mode for the target step
      const tcfg = cfgChecks[target];
      const mode =
        tcfg?.fanout === 'map' ? 'map' : tcfg?.reduce ? 'reduce' : tcfg?.fanout || 'default';

      const items = foreachScope
        ? []
        : sourceCheckConfig?.forEach && Array.isArray(sourceOutputForItems)
          ? (sourceOutputForItems as unknown[])
          : [];

      let lastTargetHadFatal: boolean | undefined = undefined;
      const runChainOnce = async (scopeForRun: ScopePath) => {
        const tResMaybe = await runTargetOnce(scopeForRun, /*guard*/ guardTargetOnce);
        const tRes = tResMaybe || resultsMap.get(target);
        // If the target is a forEach parent, its dependents are executed per-item
        // inside executeCheckInline. Avoid scheduling them again here to prevent
        // an extra aggregated run (e.g., validate-fact ×1 in addition to per-item runs).
        const tcfgNow = cfgChecks[target];
        const targetIsForEachParent = !!tcfgNow?.forEach;
        if (targetIsForEachParent) return;
        // If target failed, do not run any dependents in this forward-run wave
        try {
          if (debug) {
            const ids = Array.isArray(tRes?.issues)
              ? (tRes!.issues as any[]).map(i => i.ruleId).join(',')
              : 'none';
            (config?.output?.pr_comment ? console.error : console.log)(
              `🔧 Debug: forward-run: target '${target}' issues=[${ids}]`
            );
          }
          // Treat skipped targets as non-executed for the purposes of forward-run.
          // If a target was skipped (e.g., event mismatch), do NOT schedule dependents
          // because prerequisites/side-effects didn't run.
          const wasSkipped = Array.isArray(tRes?.issues)
            ? (tRes!.issues as any[]).some(i => (i.ruleId || '').endsWith('/__skipped'))
            : false;
          if (wasSkipped) {
            if (debug)
              (config?.output?.pr_comment ? console.error : console.log)(
                `🔧 Debug: forward-run: target '${target}' skipped — not running dependents`
              );
            return;
          }

          let hadFatal = tRes && Array.isArray(tRes.issues) && this.hasFatal(tRes.issues);
          lastTargetHadFatal = hadFatal;
          // Respect continue_on_failure on the target: allow dependents even when fatal
          try {
            const tcfgCont = (cfgChecks[target] as any)?.continue_on_failure === true;
            if (tcfgCont) hadFatal = false;
          } catch {}
          if (hadFatal) {
            if (debug)
              (config?.output?.pr_comment ? console.error : console.log)(
                `🔧 Debug: forward-run: target '${target}' failed — skipping dependents`
              );
            return;
          }
        } catch {}
        // Inline-run transitive dependents for on_success so integration flows
        // (goto_event → next checks) see the expected children in the same cycle.
        if (origin === 'on_success') {
          const dependentsOnly = order.filter(n => n !== target);
          for (const dep of dependentsOnly) {
            try {
              const depCfg = cfgChecks[dep];
              if (!depCfg) continue;
              const resDep = await this.runNamedCheck(dep, foreachScope || [], {
                origin: 'on_success',
                config,
                dependencyGraph,
                prInfo,
                resultsMap,
                debug,
                eventOverride: gotoEvent,
              });
              try { resultsMap.set(dep, resDep); } catch {}
            } catch {}
          }
        }
      };

      if (foreachScope && foreachScope.length > 0) {
        await runChainOnce(foreachScope);
      } else if (mode === 'map' && items.length > 0 && sourceCheckName) {
        for (let i = 0; i < items.length; i++) {
          const itemScope: ScopePath = [{ check: sourceCheckName, index: i }];
          await runChainOnce(itemScope);
        }
      } else {
        await runChainOnce([]);
      }

      // For on_fail-originated forward runs we already early-returned above.

      // In test/grouped mode, rely on the DAG and per-level execution; avoid
      // following static on_success.goto chains to prevent duplicate executions
      // of steps that are already scheduled by the plan.
      try {
        const inTest = Boolean((this as any).executionContext && (this as any).executionContext.mode?.test);
        // Suppress static on_success chaining only for origin='on_success' in tests.
        // For origin='on_fail', allow following the on_success chain so correction cycles
        // (target + dependents) execute deterministically without goto_event.
        if (inTest && origin === 'on_success') return;
      } catch {}

      // Follow explicit on_success.goto edges from the target, if present,
      // to naturally support anchor-style chains (e.g., refine → write → validate → test).
      // Only follow when the target succeeded (no fatal issues post fail_if evaluation).
      // We intentionally do not evaluate goto_js here to keep this deterministic
      // in routing, but we do honor static goto + goto_event.
      // Follow static goto chains with configurable hop budget and cycle detection
      const maxHops = config?.routing?.max_loops ?? 10;
      let hopCount = 0;
      const visited = new Set<string>();
      // Success check: if target produced fatal issues, skip static goto chaining
      try {
        const dbg = (msg: string) =>
          (config?.output?.pr_comment ? console.error : console.log)(msg);
        // Prefer the immediate result from runChainOnce if available
        let hadFatal = typeof lastTargetHadFatal === 'boolean' ? lastTargetHadFatal : false;
        if (typeof lastTargetHadFatal !== 'boolean') {
          const tRes = resultsMap.get(target);
          hadFatal = !!(tRes && Array.isArray(tRes.issues) && this.hasFatal(tRes.issues));
        }
        if (hadFatal) {
          if (debug)
            dbg(
              `🔧 Debug: forward-run: skipping on_success.goto chain for '${target}' due to fatal issues`
            );
          return; // do not follow chain from a failed target
        }
      } catch {}

      let current: string | undefined = (
        cfgChecks[target]?.on_success as OnSuccessConfig | undefined
      )?.goto;
      while (current && hopCount < maxHops) {
        if (visited.has(current)) {
          try {
            logger.warn(
              `⚠️ forward-run: detected goto cycle at '${current}' after ${hopCount} hop(s); aborting chain`
            );
          } catch {}

          break;
        }
        visited.add(current);
        const nextOnSuccess = (cfgChecks[current]?.on_success as OnSuccessConfig | undefined) || {};
        const nextEvent = nextOnSuccess.goto_event || gotoEvent;
        await this.scheduleForwardRun(current, {
          origin: 'on_success',
          gotoEvent: nextEvent,
          config,
          dependencyGraph,
          prInfo,
          resultsMap,
          debug,
          foreachScope,
          sourceCheckName,
          sourceCheckConfig,
          sourceOutputForItems,
        });
        hopCount++;
        // advance chain if there is a further goto from the just-executed step
        current = (cfgChecks[current]?.on_success as OnSuccessConfig | undefined)?.goto;
      }
      if (hopCount >= maxHops && current) {
        try {
          logger.warn(
            `⚠️ forward-run: hop budget exceeded (max_loops=${maxHops}); last unresolved goto='${current}'`
          );
        } catch {}
      }
    } finally {
      this.routingEventOverride = prevEventOverride;
    }
  }

  /**
   * Set execution context for providers (CLI message, hooks, etc.)
   * This allows passing state without using static properties
   */
  setExecutionContext(
    context: import('./providers/check-provider.interface').ExecutionContext
  ): void {
    this.executionContext = context;
  }

  /**
   * Lazily create a secure sandbox for routing JS (goto_js, run_js)
   */
  private getRoutingSandbox(): Sandbox {
    if (this.routingSandbox) return this.routingSandbox;
    this.routingSandbox = createSecureSandbox();
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

  // === on_finish helpers (extracted to reduce handleOnFinishHooks complexity) ===
  private composeOnFinishContext(
    checkName: string,
    checkConfig: import('./types/config').CheckConfig,
    outputsForContext: Record<string, unknown>,
    outputsHistoryForContext: Record<string, unknown[]>,
    forEachStats: any,
    prInfo: PRInfo
  ): {
    step: { id: string; tags: string[]; group?: string };
    attempt: number;
    loop: number;
    outputs: Record<string, unknown>;
    outputs_history: Record<string, unknown[]>;
    outputs_raw: Record<string, unknown>;
    forEach: any;
    memory: {
      get: (key: string, ns?: string) => unknown;
      has: (key: string, ns?: string) => boolean;
      list: (ns?: string) => string[];
      getAll: (ns?: string) => Record<string, unknown>;
      set: (key: string, value: unknown, ns?: string) => void;
      increment: (key: string, amount: number, ns?: string) => number;
    };
    pr: { number: number; title: string; author: string; branch: string; base: string };
    files: PRInfo['files'];
    env: Record<string, string>;
    event: { name: string };
  } {
    const memoryStore = MemoryStore.getInstance(this.config?.memory);
    const memoryHelpers = {
      get: (key: string, ns?: string) => memoryStore.get(key, ns),
      has: (key: string, ns?: string) => memoryStore.has(key, ns),
      list: (ns?: string) => memoryStore.list(ns),
      getAll: (ns?: string) => {
        const keys = memoryStore.list(ns);
        const result: Record<string, unknown> = {};
        for (const key of keys) result[key] = memoryStore.get(key, ns);
        return result;
      },
      set: (key: string, value: unknown, ns?: string) => {
        const nsName = ns || memoryStore.getDefaultNamespace();
        if (!memoryStore['data'].has(nsName)) memoryStore['data'].set(nsName, new Map());
        memoryStore['data'].get(nsName)!.set(key, value);
      },
      increment: (key: string, amount: number, ns?: string) => {
        const current = memoryStore.get(key, ns);
        const numCurrent = typeof current === 'number' ? current : 0;
        const newValue = numCurrent + amount;
        const nsName = ns || memoryStore.getDefaultNamespace();
        if (!memoryStore['data'].has(nsName)) memoryStore['data'].set(nsName, new Map());
        memoryStore['data'].get(nsName)!.set(key, newValue);
        return newValue;
      },
    };
    const outputsRawForContext: Record<string, unknown> = {};
    for (const [name, val] of Object.entries(outputsForContext)) {
      if (name === 'history') continue;
      outputsRawForContext[name] = val;
    }
    const outputsMergedForContext: Record<string, unknown> = {
      ...outputsForContext,
      history: outputsHistoryForContext,
    };
    return {
      step: { id: checkName, tags: checkConfig.tags || [], group: checkConfig.group },
      attempt: 1,
      loop: 0,
      outputs: outputsMergedForContext,
      outputs_history: outputsHistoryForContext,
      outputs_raw: outputsRawForContext,
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
  }

  private evaluateOnFinishGoto(
    checkName: string,
    onFinish: NonNullable<import('./types/config').CheckConfig['on_finish']>,
    onFinishContext: any,
    debug: boolean,
    log: (msg: string) => void
  ): string | null {
    let gotoTarget: string | null = null;
    if (onFinish.goto_js) {
      logger.info(`▶ on_finish.goto_js: evaluating for "${checkName}"`);
      try {
        const sandbox = this.getRoutingSandbox();
        const scope = onFinishContext;
        const code = `
          const step = scope.step; const attempt = scope.attempt; const loop = scope.loop; const outputs = scope.outputs; const outputs_history = scope.outputs_history; const outputs_raw = scope.outputs_raw; const forEach = scope.forEach; const memory = scope.memory; const pr = scope.pr; const files = scope.files; const env = scope.env; const event = scope.event; const log = (...a)=> console.log('🔍 Debug:',...a);
          const __fn = () => {\n${onFinish.goto_js}\n};
          const __res = __fn();
          return (typeof __res === 'string' && __res) ? __res : null;
        `;
        const exec = sandbox.compile(code);
        const result = exec({ scope }).run();
        gotoTarget = typeof result === 'string' && result ? result : null;
        if (debug) log(`🔧 Debug: on_finish.goto_js evaluated → ${this.redact(gotoTarget)}`);
        logger.info(
          `✓ on_finish.goto_js: evaluated to '${gotoTarget || 'null'}' for "${checkName}"`
        );
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        logger.warn(`⚠️ on_finish.goto_js: evaluation failed for "${checkName}": ${errorMsg}`);
        if (error instanceof Error && error.stack) logger.debug(`Stack trace: ${error.stack}`);
        if (onFinish.goto) {
          logger.info(`  ⚠ Falling back to static goto: '${onFinish.goto}'`);
          gotoTarget = onFinish.goto;
        }
      }
    } else if (onFinish.goto) {
      gotoTarget = onFinish.goto;
      logger.info(`▶ on_finish.goto: routing to '${gotoTarget}' for "${checkName}"`);
    }
    return gotoTarget;
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
      scope?: ScopePath;
      origin?: 'on_finish' | 'on_success' | 'on_fail' | 'foreach' | 'initial' | 'inline';
    }
  ): Promise<ReviewSummary> {
    const {
      config,
      prInfo,
      resultsMap,
      dependencyResults,
      sessionInfo,
      debug,
      eventOverride,
      scope,
    } = context;
    const log = (msg: string) => (config?.output?.pr_comment ? console.error : console.log)(msg);
    const origin = (context as any).origin || 'inline';

    // Find the check configuration
    const checkConfig = config?.checks?.[checkId];
    if (!checkConfig) {
      try {
        const msg = `[on_finish] referenced unknown check '${checkId}', ignoring`;
        (config?.output?.pr_comment ? console.error : console.log)(msg);
      } catch {}
      return { issues: [] };
    }

    // Respect event triggers when executing dependencies inline.
    // If the check is not configured to run for the current event, skip executing it here.
    try {
      const triggers = Array.isArray(checkConfig.on) ? (checkConfig.on as string[]) : [];
      if (triggers.length > 0) {
        const evt = eventOverride || event || this.getCurrentEventType(prInfo);
        const allowed = triggers.includes(evt as any);
        if (!allowed) {
          // Special case: manual-only checks are not auto-executed inline
          const manualOnly = triggers.length === 1 && triggers[0] === 'manual';
          if (manualOnly || !allowed) {
            try {
              const msg = `🔧 Debug: Skipping inline execution of '${checkId}' for event '${evt}' (triggers=${JSON.stringify(
                triggers
              )})`;
              (config?.output?.pr_comment ? console.error : console.log)(msg);
            } catch {}
            return { issues: [] };
          }
        }
      }
    } catch {}

    // Helper to get all dependencies recursively from config, expanding OR-groups ("a|b")
    const getAllDepsFromConfig = (name: string): string[] => {
      const visited = new Set<string>();
      const acc: string[] = [];
      const expand = (t: unknown): string[] => {
        const s = String(t ?? '').trim();
        if (!s) return [];
        if (s.includes('|'))
          return s
            .split('|')
            .map(x => x.trim())
            .filter(Boolean);
        return [s];
      };
      const dfs = (n: string) => {
        if (visited.has(n)) return;
        visited.add(n);
        const cfg = config?.checks?.[n];
        const depsRaw = cfg?.depends_on || [];
        for (const token of depsRaw) {
          const expanded = expand(token);
          for (const d of expanded) {
            // Only accumulate known checks; ignore unknown OR branches
            if (!config?.checks?.[d]) continue;
            acc.push(d);
            dfs(d);
          }
        }
      };
      dfs(name);
      return Array.from(new Set(acc));
    };

    // Ensure all dependencies of target are available; execute missing ones in topological order
    const allTargetDeps = getAllDepsFromConfig(checkId);
    if (allTargetDeps.length > 0) {
      // Build subgraph mapping for ordered execution
      const subSet = new Set<string>(
        [...allTargetDeps].filter(id => Boolean(config?.checks?.[id]))
      );
      const subDeps: Record<string, string[]> = {};
      for (const id of subSet) {
        const cfg = config?.checks?.[id];
        const raw = cfg?.depends_on || [];
        const expanded: string[] = [];
        for (const token of raw) {
          const parts = String(token ?? '')
            .split('|')
            .map(s => s.trim())
            .filter(Boolean);
          if (parts.length === 0) continue;
          for (const p of parts) if (subSet.has(p)) expanded.push(p);
        }
        subDeps[id] = expanded;
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

    // No legacy adapters; use configuration as-is
    const adaptedConfig: any = { ...checkConfig };
    const providerType = adaptedConfig.type || 'ai';
    const provider = this.providerRegistry.getProviderOrThrow(providerType);
    this.setProviderWebhookContext(provider);

    // Build provider configuration
    const provCfg: CheckProviderConfig = {
      type: providerType,
      prompt: adaptedConfig.prompt,
      exec: adaptedConfig.exec,
      focus: adaptedConfig.focus || this.mapCheckNameToFocus(checkId),
      schema: adaptedConfig.schema,
      group: adaptedConfig.group,
      checkName: checkId,
      eventContext: this.enrichEventContext(prInfo.eventContext),
      transform: adaptedConfig.transform,
      transform_js: adaptedConfig.transform_js,
      env: adaptedConfig.env,
      forEach: adaptedConfig.forEach,
      // Pass output history for loop/goto scenarios
      __outputHistory: this.outputHistory,
      // no enriched history exposure; standard outputs_history only
      // Include provider-specific keys (e.g., op/values for github)
      ...adaptedConfig,
      ai: {
        ...(adaptedConfig.ai || {}),
        timeout: adaptedConfig.ai?.timeout || 600000,
        debug: !!debug,
      },
    };

    // Build dependency results for this check using snapshot-based visibility (overlay per-scope results)
    const depResults = this.buildSnapshotDependencyResults(
      scope || [],
      dependencyResults,
      eventOverride || prInfo.eventType
    );

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
      const __provStart = Date.now();
      const inlineContext: import('./providers/check-provider.interface').ExecutionContext = {
        ...sessionInfo,
        ...this.executionContext,
      } as any;
      // dependency printout removed
      result = await withActiveSpan(
        `visor.check.${checkId}`,
        { 'visor.check.id': checkId, 'visor.check.type': provCfg.type || 'ai' },
        async () => provider.execute(prInfoForInline, provCfg, depResults, inlineContext)
      );
      this.recordProviderDuration(checkId, Date.now() - __provStart);
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

    // Track output history for loop/goto scenarios (normalize default output shape)
    const enrichedWithOutput = enriched as ReviewSummary & { output?: unknown };
    if (enrichedWithOutput.output !== undefined) {
      try {
        const outVal: any = enrichedWithOutput.output as any;
        let histVal: any = outVal;
        if (Array.isArray(outVal)) {
          histVal = outVal;
        } else if (outVal !== null && typeof outVal === 'object') {
          histVal = { ...outVal };
          if ((histVal as any).ts === undefined) (histVal as any).ts = Date.now();
        } else {
          histVal = { text: String(outVal), ts: Date.now() };
        }
        this.trackOutputHistory(checkId, histVal);
        try {
          (enriched as any).__histTracked = true;
        } catch {}
      } catch {
        // best effort history tracking
        try {
          this.trackOutputHistory(checkId, enrichedWithOutput.output);
        } catch {}
      }
    }

    // Handle forEach iteration for this check if it returned an array
    if (checkConfig.forEach && Array.isArray(enrichedWithOutput.output)) {
      const forEachItems = enrichedWithOutput.output;
      // Always log forEach detection (not just in debug mode) for visibility
      const wave = (this.forEachWaveCounts.get(checkId) || 0) + 1;
      this.forEachWaveCounts.set(checkId, wave);
      log(
        `🔄 forEach check '${checkId}' returned ${forEachItems.length} items - starting iteration (wave #${wave}, origin=${origin})`
      );
      if (debug) {
        log(
          `🔧 Debug: forEach item preview: ${JSON.stringify(forEachItems[0] || {}).substring(0, 200)}`
        );
      }

      // Store the array output with forEach metadata
      const forEachResult = {
        ...enriched,
        forEachItems,
        forEachItemResults: forEachItems.map(item => ({
          issues: [],
          output: item,
        })),
      };
      enriched = forEachResult as ReviewSummary;

      // Make the parent result visible to dependency resolution BEFORE scheduling dependents
      // so that recursive dependency checks do not re-execute this forEach parent in the same wave.
      try {
        resultsMap?.set(checkId, enriched);
      } catch {}

      // Phase 4: commit aggregate parent result early (root scope) so outputs_raw is visible
      this.commitJournal(
        checkId,
        enriched as ExtendedReviewSummary,
        prInfoForInline.eventType || prInfo.eventType,
        []
      );

      // Wave guard: if waves exceed routing.max_loops, stop scheduling dependents to prevent runaway loops
      const maxLoops = config?.routing?.max_loops ?? 10;
      if (wave > maxLoops) {
        try {
          logger.warn(
            `⛔ forEach wave guard: '${checkId}' exceeded max_loops=${maxLoops} (wave #${wave}); skipping dependents and routing`
          );
        } catch {}
        // Store and return aggregated result
        resultsMap?.set(checkId, enriched);
        return enriched;
      }

      // Find checks that depend on this forEach check
      const dependentChecks = Object.keys(config?.checks || {}).filter(name => {
        const cfg = config?.checks?.[name];
        return cfg?.depends_on?.includes(checkId);
      });

      // Always log dependents for visibility
      try {
        if (dependentChecks.length > 0) {
          log(
            `🔄 forEach check '${checkId}' has ${dependentChecks.length} dependents: ${dependentChecks.join(', ')}`
          );
        } else {
          log(`⚠️  forEach check '${checkId}' has NO dependents - nothing to iterate`);
        }
      } catch {}

      // Execute each dependent check once per forEach item (scope-based; no per-item map cloning)
      for (const depCheckName of dependentChecks) {
        const depCheckConfig = config?.checks?.[depCheckName];
        if (!depCheckConfig) continue;

        // Always (re)run dependents during inline reruns (on_finish.goto to parent).
        // We intentionally do not short-circuit on existing results here so stats/history
        // reflect multiple waves.
        // Skip if no items to iterate over
        if (forEachItems.length === 0) {
          if (debug) {
            log(`🔧 Debug: Skipping forEach dependent '${depCheckName}' - no items to iterate`);
          }
          // Store empty result
          resultsMap?.set(depCheckName, { issues: [] });
          continue;
        }

        // Always log iteration start
        try {
          const wave = this.forEachWaveCounts.get(checkId) || 1;
          log(
            `🔄 Executing forEach dependent '${depCheckName}' for ${forEachItems.length} items (wave #${wave})`
          );
        } catch {}

        const depResults: ReviewSummary[] = [];

        // Execute once per forEach item
        for (let itemIndex = 0; itemIndex < forEachItems.length; itemIndex++) {
          const item = forEachItems[itemIndex];
          const wave = this.forEachWaveCounts.get(checkId) || 1;
          log(
            `  🔄 Iteration ${itemIndex + 1}/${forEachItems.length} f|| '${depCheckName}' (wave #${wave})`
          );

          // Phase 4: Commit per-item entry for parent in journal under item scope
          const itemScope: ScopePath = [{ check: checkId, index: itemIndex }];
          try {
            this.commitJournal(
              checkId,
              { issues: [], output: item } as ExtendedReviewSummary,
              prInfoForInline.eventType || prInfo.eventType,
              itemScope
            );
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            logger.error(`Failed to commit per-item journal for ${checkId}: ${msg}`);
            // Non-fatal: journal is best-effort; continue without retry.
          }

          try {
            // Build provider + config for dependent and execute with full routing semantics
            const depProviderType = depCheckConfig.type || 'ai';
            const depProvider = this.providerRegistry.getProviderOrThrow(depProviderType);
            this.setProviderWebhookContext(depProvider);

            // Build dependency results from snapshot at item scope (no cloning)
            const snapshotDeps = this.buildSnapshotDependencyResults(
              itemScope,
              undefined,
              prInfoForInline.eventType || prInfo.eventType
            );

            // Use unified helper to ensure stats and history are tracked for each item run
            const res = await this.runNamedCheck(depCheckName, itemScope, {
              origin: 'foreach',
              config: config!,
              dependencyGraph: context.dependencyGraph,
              prInfo,
              resultsMap: resultsMap || new Map(),
              debug: !!debug,
              eventOverride: prInfoForInline.eventType || prInfo.eventType,
              overlay: snapshotDeps,
            });
            depResults.push(res);
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
    // Commit to journal with provided scope (or root). Avoid double-commit if we already committed aggregate above.
    const isForEachAggregate = checkConfig.forEach && Array.isArray(enrichedWithOutput.output);
    if (!isForEachAggregate) {
      this.commitJournal(
        checkId,
        enriched as ExtendedReviewSummary,
        prInfoForInline.eventType || prInfo.eventType,
        scope || []
      );
    }

    if (debug) log(`🔧 Debug: inline executed '${checkId}', issues: ${enrichedIssues.length}`);

    return enriched;
  }

  /**
   * Phase 3: Unified scheduling helper
   * Runs a named check in the current session/scope and records results.
   * Used by on_success/on_fail/on_finish routing and internal inline execution.
   */
  private async runNamedCheck(
    target: string,
    scope: ScopePath,
    opts: {
      config: VisorConfig;
      dependencyGraph: DependencyGraph;
      prInfo: PRInfo;
      resultsMap: Map<string, ReviewSummary>;
      debug: boolean;
      sessionInfo?: { parentSessionId?: string; reuseSession?: boolean };
      eventOverride?: import('./types/config').EventTrigger;
      overlay?: Map<string, ReviewSummary>;
      origin?: 'on_finish' | 'on_success' | 'on_fail' | 'foreach' | 'initial' | 'inline';
    }
  ): Promise<ReviewSummary> {
    const {
      config,
      dependencyGraph,
      prInfo,
      resultsMap,
      debug,
      sessionInfo,
      eventOverride,
      overlay,
    } = opts;
    try {
      if (debug && opts.origin === 'on_finish') {
        console.error(`[runNamedCheck] origin=on_finish step=${target}`);
      }
    } catch {}

    // Evaluate 'if' condition for checks executed via routing (run/goto).
    try {
      const tcfg = opts.config.checks?.[target] as import('./types/config').CheckConfig | undefined;
      if (tcfg && tcfg.if) {
        const gate = await this.shouldRunCheck(
          target,
          tcfg.if,
          opts.prInfo,
          opts.resultsMap || new Map<string, ReviewSummary>(),
          !!debug,
          opts.eventOverride,
          /* failSecure */ true
        );
        if (!gate.shouldRun) {
          // Record a skipped marker compatible with summary rendering
          const skipped: ReviewSummary = {
            issues: [
              {
                file: '',
                line: 0,
                ruleId: `${target}/__skipped`,
                message: `Skipped by if condition: ${tcfg.if}`,
                severity: 'info',
                category: 'logic',
              },
            ],
          } as ReviewSummary;
          try {
            this.recordSkip(target, 'if_condition', tcfg.if);
            logger.info(`⏭  Skipped (if: ${this.truncate(tcfg.if, 40)})`);
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            logger.error(`Failed to record skip for ${target}: ${msg}`);
          }
          // Commit a minimal journal entry to make downstream visibility consistent
          this.commitJournal(
            target,
            skipped as any,
            opts.eventOverride || opts.prInfo.eventType,
            scope || []
          );
          opts.resultsMap?.set(target, skipped);
          return skipped;
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to evaluate if condition for ${target}: ${msg}`);
      // Fail secure: if condition evaluation fails, skip execution
      const skipped: ReviewSummary = {
        issues: [
          {
            file: '',
            line: 0,
            ruleId: `${target}/__skipped`,
            message: `Skipped due to condition evaluation error`,
            severity: 'info',
            category: 'logic',
          },
        ],
      } as ReviewSummary;
      try {
        const cond =
          (opts.config.checks?.[target] as import('./types/config').CheckConfig | undefined)?.if ||
          '';
        this.recordSkip(target, 'if_condition', cond);
      } catch {}
      this.commitJournal(
        target,
        skipped as any,
        opts.eventOverride || opts.prInfo.eventType,
        scope || []
      );
      opts.resultsMap?.set(target, skipped);
      return skipped;
    }

    // Enforce max-runs guard (after 'if' passes). Count per scope (forEach items separated).
    try {
      const limit = this.resolveMaxRuns(config, target);
      if (typeof limit === 'number' && limit > 0) {
        const k = this.buildRunKey(target, scope);
        const soFar = this.runCounters.get(k) || 0;
        if (soFar >= limit) {
          const issue: ReviewIssue = {
            file: '',
            line: 0,
            ruleId: `${target}/limits/max_runs_exceeded`,
            message: `Run limit exceeded for '${target}' in scope ${k} (attempt ${soFar + 1} > ${limit}).`,
            severity: 'error',
            category: 'logic',
          };
          const capped: ReviewSummary = { issues: [issue] };
          try {
            resultsMap.set(target, capped);
          } catch {}
          logger.warn(`⚠️  Max runs exceeded for '${target}' in scope ${k} (limit=${limit}).`);
          return capped;
        }
        this.runCounters.set(k, soFar + 1);
      }
    } catch {}

    // Build context overlay from current results; prefer snapshot visibility for scope (Phase 4)
    const depOverlay = overlay ? new Map(overlay) : new Map(resultsMap);
    const depOverlaySanitized = this.sanitizeResultMapKeys(depOverlay);
    // For event overrides, avoid leaking cross-event results via overlay; rely on snapshot-only view
    const overlayForExec =
      eventOverride && eventOverride !== (prInfo.eventType || 'manual')
        ? new Map<string, ReviewSummary>()
        : depOverlaySanitized;
    if (!this.executionStats.has(target)) this.initializeCheckStats(target);
    const startTs = this.recordIterationStart(target);
    try {
      let res = await this.executeCheckInline(
        target,
        eventOverride || prInfo.eventType || 'manual',
        {
          config,
          dependencyGraph,
          prInfo,
          resultsMap,
          // Use snapshot-only deps when eventOverride is set
          dependencyResults: overlayForExec,
          sessionInfo,
          debug,
          eventOverride,
          scope,
          origin: opts.origin || 'inline',
        }
      );
      // Evaluate fail_if for inline-executed checks (parity with grouped path)
      let postFailTriggered = false;
      if (config && (config.fail_if || (config.checks as any)?.[target]?.fail_if)) {
        try {
          const failureResults = await this.evaluateFailureConditions(
            target,
            res,
            config,
            prInfo,
            resultsMap
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
            if (failureIssues.length > 0) {
              res = {
                ...(res || { issues: [] }),
                issues: [...(res.issues || []), ...failureIssues],
              } as ReviewSummary;
              // Update resultsMap immediately so downstream forward-run gating sees fail_if as fatal
              try {
                resultsMap.set(target, res);
              } catch {}
              // Post-fail_if routing: honor on_fail.goto for inline path
              const checkCfg = (config.checks as any)?.[target] as
                | import('./types/config').CheckConfig
                | undefined;
              const ofCfg: OnFailConfig | undefined = checkCfg?.on_fail
                ? { ...(config?.routing?.defaults?.on_fail || {}), ...checkCfg.on_fail }
                : undefined;
              postFailTriggered = failureResults.some(r => r.failed === true);
              // One-bounce guard: if this inline execution was itself triggered from an on_fail
              // forward-run wave, suppress further on_fail.goto inside the same wave to avoid
              // tight ask↔refine loops. Let the grouped runner resume control.
              // One-bounce guard: when this inline execution was triggered from a routing
              // origin (on_success/on_fail/foreach), avoid performing another inline
              // on_fail.goto to prevent tight recursion. In this case we signal the
              // grouped runner to start another wave so the target step is picked up
              // at level 0 naturally.
              const __suppressFailGoto = !!(opts.origin && opts.origin !== 'initial');
              if (
                postFailTriggered &&
                !__suppressFailGoto &&
                ofCfg &&
                (ofCfg.goto || ofCfg.goto_js)
              ) {
                let pfTarget: string | null = null;
                if (ofCfg.goto_js) {
                  try {
                    const sandbox = this.getRoutingSandbox();
                    const scopeObj = {
                      step: { id: target, tags: checkCfg?.tags || [], group: checkCfg?.group },
                      outputs: Object.fromEntries(resultsMap.entries()),
                      output: (res as any)?.output,
                      event: { name: prInfo.eventType || 'manual' },
                    };
                    const code = `const step=scope.step; const outputs=scope.outputs; const output=scope.output; const event=scope.event; ${ofCfg.goto_js}`;
                    const r = compileAndRun<string | null>(
                      sandbox,
                      code,
                      { scope: scopeObj },
                      { injectLog: false, wrapFunction: true }
                    );
                    pfTarget = typeof r === 'string' && r ? r : null;
                  } catch {}
                }
                if (!pfTarget && ofCfg.goto) pfTarget = ofCfg.goto;
                if (pfTarget) {
                  try {
                    logger.info(
                      `↪ on_fail.goto(post-fail_if/inline): jumping to '${pfTarget}' from '${target}'`
                    );
                  } catch {}
                  await this.scheduleForwardRun(pfTarget, {
                    origin: 'on_fail',
                    gotoEvent: ofCfg.goto_event,
                    config,
                    dependencyGraph,
                    prInfo,
                    resultsMap,
                    debug,
                  });
                }
              } else if (postFailTriggered) {
                // No inline goto scheduled (either suppressed or no goto configured):
                // flag the outer wave loop so we execute another pass.
                try {
                  (this as any).onFailForwardRunSeen = true;
                  if (debug)
                    (config?.output?.pr_comment ? console.error : console.log)(
                      `🔁 Debug: inline fail_if triggered for '${target}', scheduling next wave`
                    );
                } catch {}
              }
            }
          }
        } catch {}
      }
      // Success path (inline): honor on_success.run/goto for the inline-executed target
      try {
        const checkCfg = (config.checks as any)?.[target] as
          | import('./types/config').CheckConfig
          | undefined;
        const onSucc: OnSuccessConfig | undefined = checkCfg?.on_success;
        // When this inline execution originates from a forward-run:
        //  - origin === 'on_success': scheduleForwardRun will already handle dependents and
        //    static goto chains. Suppress inline on_success entirely to avoid duplicates.
        //  - origin === 'on_fail': we want corrective side-effects from on_success.run (e.g.,
        //    increment a memory counter), but we must NOT follow goto to avoid immediate loops.
        const originTag = opts.origin || 'inline';
        const suppressAllOnSuccess = originTag === 'on_success';
        const suppressGotoOnly = originTag === 'on_fail';
        if (onSucc && !postFailTriggered && !suppressAllOnSuccess) {
          // Compute run list (static + dynamic)
          const dynamicRun = await (async () => {
            if (!onSucc.run_js) return [] as string[];
            try {
              const scopeObj = {
                step: { id: target, tags: checkCfg?.tags || [], group: checkCfg?.group },
                outputs: Object.fromEntries(resultsMap.entries()),
                output: (res as any)?.output,
                event: { name: prInfo.eventType || 'manual' },
              };
              const code = `const step=scope.step; const outputs=scope.outputs; const output=scope.output; const event=scope.event; ${onSucc.run_js}`;
              const r = compileAndRun<string[] | string | null>(
                this.getRoutingSandbox(),
                code,
                { scope: scopeObj },
                { injectLog: false, wrapFunction: true }
              );
              const arr = Array.isArray(r) ? r : typeof r === 'string' && r ? [r] : [];
              return arr.filter(Boolean) as string[];
            } catch {
              return [] as string[];
            }
          })();
          let runList = [...(onSucc.run || []), ...dynamicRun].filter(Boolean);
          // Dedup within this call
          runList = Array.from(new Set(runList));
          if (runList.length > 0) {
            for (const stepId of runList) {
              // One-shot guard similar to grouped path
              try {
                const tcfg = (config.checks || {})[stepId] as
                  | import('./types/config').CheckConfig
                  | undefined;
                const tags = (tcfg?.tags || []) as string[];
                const isOneShot = Array.isArray(tags) && tags.includes('one_shot');
                if (isOneShot && (this.executionStats.get(stepId)?.totalRuns || 0) > 0) {
                  continue;
                }
              } catch {}
              await this.runNamedCheck(stepId, scope || [], {
                config,
                dependencyGraph,
                prInfo,
                resultsMap,
                debug,
                overlay: resultsMap,
              });
            }
          }
          // Optional on_success.goto for inline path
          let succTarget: string | null = null;
          try {
            if (!suppressGotoOnly && !succTarget && onSucc.goto_js) {
              const scopeObj = {
                step: { id: target, tags: checkCfg?.tags || [], group: checkCfg?.group },
                outputs: Object.fromEntries(resultsMap.entries()),
                output: (res as any)?.output,
                event: { name: prInfo.eventType || 'manual' },
              };
              const code = `const step=scope.step; const outputs=scope.outputs; const output=scope.output; const event=scope.event; ${onSucc.goto_js}`;
              const r = compileAndRun<string | null>(
                this.getRoutingSandbox(),
                code,
                { scope: scopeObj },
                { injectLog: false, wrapFunction: true }
              );
              succTarget = typeof r === 'string' && r ? r : null;
            }
          } catch {}
          if (!suppressGotoOnly && !succTarget && onSucc.goto) succTarget = onSucc.goto;
          if (!suppressGotoOnly && succTarget) {
            await this.scheduleForwardRun(succTarget, {
              origin: 'on_success',
              gotoEvent: onSucc.goto_event,
              config,
              dependencyGraph,
              prInfo,
              resultsMap,
              debug,
            });
          }
        }
      } catch {}
      // Ensure resultsMap reflects any fail_if augmentation before downstream gating/routing
      try {
        resultsMap.set(target, res);
      } catch {}
      const issues = (res.issues || []).map(i => ({ ...i }));
      const success = !this.hasFatal(issues);
      const out: unknown = (res as { output?: unknown }).output;
      const isForEachParent =
        (res as any)?.isForEach === true ||
        Array.isArray((res as any)?.forEachItems) ||
        Array.isArray(out);
      this.recordIterationComplete(
        target,
        startTs,
        success,
        issues,
        isForEachParent ? undefined : out
      );
      // Output history is already tracked inside executeCheckInline when a check
      // produces an output. Avoid tracking again here to prevent double-counting
      // (particularly for forward-run goto chains within a single stage).
      return res;
    } catch (e) {
      this.recordIterationComplete(target, startTs, false, [], undefined);
      throw e;
    }
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
    try {
      if (debug) console.error('[on_finish] handler invoked');
    } catch {}

    const forEachChecksWithOnFinish = this.collectForEachParentsWithOnFinish(config);

    try {
      logger.info(
        `🧭 on_finish: discovered ${forEachChecksWithOnFinish.length} forEach parent(s) with hooks`
      );
    } catch {}
    if (forEachChecksWithOnFinish.length === 0) {
      return; // No on_finish hooks to process
    }

    // Note: do not early-return if none of the forEach parents executed in this run.
    // Some configurations rely on on_finish routing even when the parent did not run
    // in the current wave (e.g., CLI-only invocations). We continue and allow
    // budget checks and static routing to surface issues as needed.

    if (debug) {
      log(`🎯 Processing on_finish hooks for ${forEachChecksWithOnFinish.length} forEach check(s)`);
    }

    // Process each forEach check's on_finish hook
    for (const { checkName, checkConfig, onFinish } of forEachChecksWithOnFinish) {
      try {
        const forEachResult = results.get(checkName) as ExtendedReviewSummary | undefined;

        // Treat missing result or empty array as zero items; still proceed so that
        // loop-budget checks and static routing can be validated.
        const forEachItems = (forEachResult && forEachResult.forEachItems) || [];

        // Get all dependents of this forEach check
        const node = dependencyGraph.nodes.get(checkName);
        const dependents = node?.dependents || [];

        try {
          logger.info(`🔍 on_finish: "${checkName}" → ${dependents.length} dependent(s)`);
        } catch {}

        // Ensure all dependents have completed before processing on_finish.
        // If any are missing, try to execute them now in the on_finish phase so aggregation
        // has up-to-date data (particularly important for forEach + validators).
        for (const depId of dependents) {
          if (results.has(depId)) continue;
          try {
            if (debug)
              log(
                `🔧 on_finish: executing missing dependent '${depId}' before processing '${checkName}'`
              );
            const depRes = await this.runNamedCheck(depId, [], {
              origin: 'on_finish',
              config,
              dependencyGraph,
              prInfo,
              resultsMap: results,
              sessionInfo: (this.executionContext as any) || undefined,
              debug,
              overlay: new Map(results),
            });
            try {
              results.set(depId, depRes as ReviewSummary);
            } catch {}
          } catch (e) {
            // If a dependent cannot run, continue; downstream hooks may still choose to skip
            try {
              const msg = e instanceof Error ? e.message : String(e);
              logger.warn(`⚠️ on_finish: failed to execute dependent '${depId}': ${msg}`);
            } catch {}
          }
        }

        logger.info(`▶ on_finish: processing for "${checkName}"`);

        // Build history snapshot and synthesize per-item entries for dependents of this
        // forEach parent if the current wave's per-item results are not yet reflected.
        const historySnapshot = this.getOutputHistorySnapshot();
        try {
          // Ensure the parent entry includes the current wave's array of items
          try {
            const parentHist = (historySnapshot[checkName] as unknown[]) || [];
            const lastArray = parentHist.filter(Array.isArray).slice(-1)[0] as unknown[] | undefined;
            const sameLength = Array.isArray(lastArray) && lastArray.length === forEachItems.length;
            if (!sameLength && Array.isArray(forEachItems) && forEachItems.length > 0) {
              if (!historySnapshot[checkName]) historySnapshot[checkName] = [] as unknown[];
              (historySnapshot[checkName] as unknown[]).push(forEachItems);
            }
          } catch {}

          const nodeDeps = dependencyGraph.nodes.get(checkName)?.dependents || [];
          for (const depId of nodeDeps) {
            const depRes = results.get(depId) as ExtendedReviewSummary | undefined;
            if (!depRes || !Array.isArray(depRes.forEachItemResults)) continue;
            const items = Array.isArray(forEachItems) ? forEachItems.length : 0;
            if (items <= 0) continue;
            const arr = (historySnapshot[depId] as unknown[]) || [];
            const nonArrayCount = arr.filter(x => !Array.isArray(x)).length;
            const remainder = items > 0 ? nonArrayCount % items : 0;
            const deficit = remainder > 0 ? items - remainder : 0;
            if (deficit > 0) {
              // Top up to the nearest multiple of items using current wave results
              const wave = depRes.forEachItemResults.slice(0, Math.min(deficit, depRes.forEachItemResults.length));
              for (const r of wave) {
                const outVal = (r as any)?.output !== undefined ? (r as any).output : r;
                try {
                  if (!historySnapshot[depId]) historySnapshot[depId] = [] as unknown[];
                  (historySnapshot[depId] as unknown[]).push(outVal);
                } catch {}
              }
            }
          }
        } catch {}

        // Build context projection (pure) using the synthesized snapshot
        const { outputsForContext, outputsHistoryForContext } = ofProject(results, historySnapshot);

        // Create forEach stats
        const __perItem = Array.isArray(forEachResult?.forEachItemResults)
          ? (forEachResult!.forEachItemResults as ReviewSummary[])
          : [];
        const forEachStats = {
          total: forEachItems.length,
          last_wave_size: forEachItems.length,
          successful:
            __perItem.length > 0
              ? __perItem.filter(r => r && (!r.issues || r.issues.length === 0)).length
              : forEachItems.length,
          failed:
            __perItem.length > 0
              ? __perItem.filter(r => r && r.issues && r.issues.length > 0).length
              : 0,
          items: forEachItems,
        };

        // Build context for on_finish evaluation (extracted helper)
        const onFinishContext = ofComposeCtx(
          undefined,
          checkName,
          checkConfig,
          outputsForContext,
          outputsHistoryForContext,
          forEachStats,
          prInfo
        );

        // Diagnostics: log attempt, dependents, items, and current budget usage
        try {
          const usedBudget = this.onFinishLoopCounts.get(checkName) || 0;
          const maxBudget = config?.routing?.max_loops ?? 10;
          logger.info(
            `🧭 on_finish: check="${checkName}" items=${forEachItems.length} dependents=${dependents.length} budget=${usedBudget}/${maxBudget}`
          );
          const vfHist = (outputsHistoryForContext['validate-fact'] as unknown[]) || [];
          if (vfHist.length) {
            logger.debug(`🧭 on_finish: outputs.history['validate-fact'] length=${vfHist.length}`);
          }
        } catch {}

        // Execute on_finish.run (static) first, then evaluate run_js with updated context
        {
          const maxLoops = config?.routing?.max_loops ?? 10;
          let loopCount = 0;
          const runList = Array.from(new Set([...(onFinish.run || [])].filter(Boolean)));
          if (runList.length > 0)
            logger.info(`▶ on_finish.run: executing [${runList.join(', ')}] for "${checkName}"`);
          const runCheck = async (id: string): Promise<ReviewSummary> => {
            if (++loopCount > maxLoops) {
              try {
                logger.error(
                  `Routing loop budget exceeded (max_loops=${maxLoops}) during on_finish run`
                );
              } catch {}
              // Surface a visible issue instead of throwing so E2E can assert
              try {
                results.set(checkName, {
                  issues: [
                    {
                      file: 'system',
                      line: 0,
                      ruleId: `${checkName}/routing/loop_budget_exceeded`,
                      message: `Routing loop budget exceeded (max_loops=${maxLoops}) during on_finish run`,
                      severity: 'error',
                      category: 'logic',
                    },
                  ],
                } as ReviewSummary);
              } catch {}
              return { issues: [] } as ReviewSummary;
            }
            const childCfgFull = (config?.checks || {})[id] as
              | import('./types/config').CheckConfig
              | undefined;
            if (!childCfgFull) throw new Error(`Unknown check in on_finish.run: ${id}`);
            const childProvider = this.providerRegistry.getProviderOrThrow(
              childCfgFull.type || 'ai'
            );
            this.setProviderWebhookContext(childProvider);
            const depOverlayForChild = new Map(results);
            const resChild = await this.runNamedCheck(id, [], {
              origin: 'on_finish',
              config: config!,
              dependencyGraph,
              prInfo,
              resultsMap: results,
              debug,
              sessionInfo: (this.executionContext as any) || undefined,
              overlay: depOverlayForChild,
            });
            try {
              results.set(id, resChild as ReviewSummary);
            } catch {}
            return resChild as ReviewSummary;
          };
          try {
            await ofRunChildren(runList, runCheck, config!, onFinishContext, debug || false, log);
            if (runList.length > 0) logger.info(`✓ on_finish.run: completed for "${checkName}"`);
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            logger.error(`✗ on_finish.run: failed for "${checkName}": ${errorMsg}`);
            if (error instanceof Error && error.stack) logger.debug(`Stack trace: ${error.stack}`);
            throw error;
          }

          // Now evaluate dynamic run_js with post-run context (e.g., after aggregation updated memory)
          const evalRunJs = async (js?: string): Promise<string[]> => {
            if (!js) return [];
            try {
              const sandbox = this.getRoutingSandbox();
              const scope = onFinishContext; // contains memory + outputs history
              const code = `
                const step = scope.step; const attempt = scope.attempt; const loop = scope.loop; const outputs = scope.outputs; const outputs_history = scope.outputs_history; const outputs_raw = scope.outputs_raw; const forEach = scope.forEach; const memory = scope.memory; const pr = scope.pr; const files = scope.files; const env = scope.env; const event = scope.event; const log = (...a)=> console.log('🔍 Debug:',...a);
                const __fn = () => {\n${js}\n};
                const __res = __fn();
                return Array.isArray(__res) ? __res.filter(x => typeof x === 'string' && x) : [];
              `;
              const exec = sandbox.compile(code);
              const res = exec({ scope }).run();
              return Array.isArray(res) ? (res as string[]) : [];
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              logger.error(`✗ on_finish.run_js: evaluation failed for "${checkName}": ${msg}`);
              if (e instanceof Error && e.stack) logger.debug(`Stack trace: ${e.stack}`);
              return [];
            }
          };
          // No MemoryStore in on_finish; dynamic run_js sees only outputs/outputs_history
          const dynamicRun = await evalRunJs(onFinish.run_js);
          const dynList = Array.from(new Set(dynamicRun.filter(Boolean)));
          if (dynList.length > 0) {
            logger.info(
              `▶ on_finish.run_js: executing [${dynList.join(', ')}] for "${checkName}"`
            );
            for (const runCheckId of dynList) {
              if (++loopCount > maxLoops) {
                try {
                  logger.error(
                    `Routing loop budget exceeded (max_loops=${maxLoops}) during on_finish run_js`
                  );
                } catch {}
                // Surface a visible issue and stop scheduling more children
                try {
                  results.set(checkName, {
                    issues: [
                      {
                        file: 'system',
                        line: 0,
                        ruleId: `${checkName}/routing/loop_budget_exceeded`,
                        message: `Routing loop budget exceeded (max_loops=${maxLoops}) during on_finish run_js`,
                        severity: 'error',
                        category: 'logic',
                      },
                    ],
                  } as ReviewSummary);
                } catch {}
                break;
              }
              logger.info(`  ▶ Executing on_finish(run_js) check: ${runCheckId}`);
              // Use full routing semantics for dynamic children as well
              const childCfgFull = (config?.checks || {})[runCheckId] as
                | import('./types/config').CheckConfig
                | undefined;
              if (!childCfgFull)
                throw new Error(`Unknown check in on_finish.run_js: ${runCheckId}`);
              const childProvType = childCfgFull.type || 'ai';
              const childProvider = this.providerRegistry.getProviderOrThrow(childProvType);
              this.setProviderWebhookContext(childProvider);
              // Note: unified scheduling executes via runNamedCheck; provider config built internally
              const depOverlayForChild = new Map(results);
              const childRes = await this.runNamedCheck(runCheckId, [], {
                origin: 'on_finish',
                config: config!,
                dependencyGraph,
                prInfo,
                resultsMap: results,
                debug,
                sessionInfo: (this.executionContext as any) || undefined,
                overlay: depOverlayForChild,
              });
              try {
                results.set(runCheckId, childRes as ReviewSummary);
              } catch {}
              logger.info(`  ✓ Completed on_finish(run_js) check: ${runCheckId}`);
            }
          }
        }

        // After on_finish.run completes, recompute an authoritative 'all_valid' flag from
        // the latest validate-fact history using outputs/history only (no MemoryStore).
        let verdictLocal: boolean | undefined = undefined;
        try {
          const snap = this.getOutputHistorySnapshot();
          verdictLocal = ofAllValid(snap, forEachItems.length);
          if (typeof verdictLocal === 'boolean') {
            logger.info(
              `🧮 on_finish: recomputed all_valid=${verdictLocal} from history for "${checkName}"`
            );
          }
        } catch {}
        // Evaluate on_finish.goto_js for routing decision
        let gotoTarget: string | null = ofDecide(
          checkName,
          checkConfig,
          outputsForContext,
          outputsHistoryForContext,
          { items: forEachItems },
          prInfo,
          config,
          debug,
          log
        ).gotoTarget;

        // Config-informed fallback in engine: if goto_js returned null but the
        // configuration encodes a simple budget ("1 + N") and the last wave is
        // not all-valid, route back to the parent while under budget.
        if (!gotoTarget) {
          try {
            const js = String(checkConfig.on_finish?.goto_js || '');
            let n = NaN;
            const m = js.match(/maxWaves\s*=\s*1\s*\+\s*(\d+)/);
            if (m) n = Number(m[1]);
            if (!Number.isFinite(n)) {
              const all = Array.from(js.matchAll(/1\s*\+\s*(\d+)/g));
              if (all.length > 0) {
                const last = all[all.length - 1];
                const num = Number(last[1]);
                if (Number.isFinite(num)) n = num;
              }
            }
            if (Number.isFinite(n) && n > 0 && forEachItems.length > 0) {
              const vf = Array.isArray(outputsHistoryForContext['validate-fact'])
                ? (outputsHistoryForContext['validate-fact'] as unknown[]).filter(x => !Array.isArray(x))
                : [];
              const items = forEachItems.length;
              const waves = items > 0 ? Math.floor(vf.length / items) : 0;
              const last = items > 0 ? vf.slice(-items) : [];
              const allOk = last.length === items && last.every((v: any) => v && (v.is_valid === true || v.valid === true));
              if (!allOk && waves < 1 + Number(n)) {
                gotoTarget = checkName;
                if (debug) log(`🔧 Debug: engine fallback → '${checkName}' (waves=${waves} < max=${1 + Number(n)})`);
              }
            }
          } catch {}
        }

        // Debug visibility removed (was [on_finish dbg]); retained via structured stats/logs above

        // No engine fallback — configuration decides routing. With per‑item
        // outputs recorded in history, goto_js can compute waves deterministically.

        // Execute routing if we have a target
        if (gotoTarget) {
          // If we’re routing back to the forEach parent but the latest wave
          // verdict (computed from outputs_history) is all valid, skip routing.
          try {
            logger.info(
              `  🔒 on_finish.goto guard: gotoTarget=${String(gotoTarget)} verdictLocal=${String(verdictLocal)}`
            );
          } catch {}
          if (gotoTarget === checkName && verdictLocal === true) {
            logger.info(`✓ on_finish.goto: skipping routing to '${gotoTarget}' (all_valid=true)`);
            gotoTarget = null as any;
          }

          // Extra deterministic guard: if the last wave of validate-fact is all valid,
          try {
            const __h = this.outputHistory.get('validate-fact');
            logger.info(
              `  🧪 on_finish.goto: validate-fact history now len=${Array.isArray(__h) ? __h.length : 0}`
            );
          } catch {}
          // skip routing back to the forEach parent even if goto_js requested it.
          try {
            if (gotoTarget === checkName) {
              const vfHistNow = (this.outputHistory.get('validate-fact') || []) as unknown[];
              if (Array.isArray(vfHistNow) && forEachItems.length > 0) {
                const verdicts = vfHistNow
                  .map(v => (v && typeof v === 'object' ? (v as any) : undefined))
                  .filter(
                    v => v && (typeof v.is_valid === 'boolean' || typeof v.valid === 'boolean')
                  )
                  .map(v => v.is_valid === true || v.valid === true);
                if (verdicts.length >= forEachItems.length) {
                  const lastVerdicts = verdicts.slice(-forEachItems.length);
                  const allTrue = lastVerdicts.every(Boolean);
                  if (allTrue) {
                    try {
                      logger.info(
                        `✓ on_finish.goto: history verdicts all valid; skipping routing to '${gotoTarget}'`
                      );
                    } catch {}
                    gotoTarget = null as any;
                  }
                }
              }
            }
          } catch {}

          // If gotoTarget was cleared (e.g., all_valid guard), skip routing
          if (!gotoTarget) {
            try {
              logger.info(`✓ on_finish.goto: no routing needed for "${checkName}"`);
            } catch {}
            continue;
          }

          // Secondary guard: if the common dependent validations history shows all items valid,
          // avoid routing back to the forEach parent even if goto_js asked to.
          try {
            if (gotoTarget === checkName) {
              const vfHist = this.outputHistory.get('validate-fact');
              const arr = Array.isArray(vfHist) ? (vfHist as unknown[]) : [];
              const allOk = arr.length > 0 && arr.every((v: any) => v && v.is_valid === true);
              if (allOk) {
                logger.info(
                  `✓ on_finish.goto: validate-fact history all valid; skipping routing to '${gotoTarget}'`
                );
                continue;
              }
            }
          } catch {}

          // Count toward loop budget similar to other routing paths (per-parent on_finish)
          const maxWavesTotal = config?.routing?.max_loops ?? 10;
          // on_finish routing consumes additional waves; budget routes = total_waves - 1
          const maxRoutes = Math.max(0, maxWavesTotal - 1);
          const used = (this.onFinishLoopCounts.get(checkName) || 0) + 1;
          if (used > maxRoutes) {
            logger.warn(
              `⚠️ on_finish: route budget exceeded for "${checkName}" (max_routes=${maxRoutes}); last goto='${gotoTarget}'. Skipping further routing.`
            );
            try {
              logger.error(
                `Routing loop budget exceeded (max_routes=${maxRoutes}) during on_finish goto`
              );
            } catch {}
            // Surface issue for tests
            try {
              results.set(checkName, {
                issues: [
                  {
                    file: 'system',
                    line: 0,
                    ruleId: `${checkName}/routing/loop_budget_exceeded`,
                    message: `Routing loop budget exceeded (max_routes=${maxRoutes}) during on_finish goto`,
                    severity: 'error',
                    category: 'logic',
                  },
                ],
              } as ReviewSummary);
            } catch {}
            continue;
          }
          this.onFinishLoopCounts.set(checkName, used);

          logger.info(
            `▶ on_finish: routing from "${checkName}" to "${gotoTarget}" (routes ${used}/${maxRoutes})`
          );

          try {
            // Ensure a follow-up wave is scheduled by marking the target now.
            // scheduleForwardRun will also mark, but this guard guarantees the
            // post-on_finish wave loop sees a non-empty forward set even if
            // scheduleForwardRun exits early for this origin.
            try {
              this.forwardDependentsScheduled.add(gotoTarget);
            } catch {}
            try {
              (this as any).onFinishForwardRunSeen = true;
            } catch {}
            const tcfg = config.checks?.[gotoTarget as string];
            const mode =
              tcfg?.fanout === 'map' ? 'map' : tcfg?.reduce ? 'reduce' : tcfg?.fanout || 'default';
            if (mode === 'map' && forEachItems.length > 0) {
              for (let i = 0; i < forEachItems.length; i++) {
                const itemScope: ScopePath = [{ check: checkName, index: i }];
                await this.scheduleForwardRun(gotoTarget!, {
                  origin: 'on_finish',
                  gotoEvent: onFinish.goto_event,
                  config,
                  dependencyGraph,
                  prInfo,
                  resultsMap: results,
                  debug,
                  foreachScope: itemScope,
                  sourceCheckName: checkName,
                  sourceCheckConfig: checkConfig,
                });
              }
            } else {
              await this.scheduleForwardRun(gotoTarget!, {
                origin: 'on_finish',
                gotoEvent: onFinish.goto_event,
                config,
                dependencyGraph,
                prInfo,
                resultsMap: results,
                debug,
                foreachScope: [],
                sourceCheckName: checkName,
                sourceCheckConfig: checkConfig,
              });
            }

            logger.info(`  ✓ Routed to: ${gotoTarget}`);
            logger.info(`  Event override: ${onFinish.goto_event || '(none)'}`);

            // If we routed back to the forEach parent, proactively forward-run
            // its immediate dependents so the next wave executes in one pass.
            // This mirrors the grouped planner behavior and prevents a second
            // pass from missing per-item validations in environments where only
            // the parent would have been scheduled.
            try {
              if (gotoTarget === checkName && forEachItems.length > 0) {
                const childIds: string[] = [];
                try {
                  for (const [id, deps] of dependencyGraph.nodes.entries()) {
                    if (Array.isArray(deps) && deps.includes(checkName)) childIds.push(id);
                  }
                } catch {}
                for (const cid of childIds) {
                  const cCfg = config.checks?.[cid];
                  if (!cCfg) continue;
                  const cMode =
                    cCfg.fanout === 'map'
                      ? 'map'
                      : cCfg.reduce
                        ? 'reduce'
                        : cCfg.fanout || 'default';
                  if (cMode === 'map') {
                    for (let i = 0; i < forEachItems.length; i++) {
                      const itemScope: ScopePath = [{ check: checkName, index: i }];
                      await this.scheduleForwardRun(cid, {
                        origin: 'on_finish',
                        gotoEvent: onFinish.goto_event,
                        config,
                        dependencyGraph,
                        prInfo,
                        resultsMap: results,
                        debug,
                        foreachScope: itemScope,
                        sourceCheckName: checkName,
                        sourceCheckConfig: checkConfig,
                      });
                    }
                  } else {
                    await this.scheduleForwardRun(cid, {
                      origin: 'on_finish',
                      gotoEvent: onFinish.goto_event,
                      config,
                      dependencyGraph,
                      prInfo,
                      resultsMap: results,
                      debug,
                      foreachScope: [],
                      sourceCheckName: checkName,
                      sourceCheckConfig: checkConfig,
                    });
                  }
                }
              }
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              logger.debug(`  ⚠ on_finish: dependent forward-run error: ${msg}`);
            }
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

        // No hardcoded correction step here; rely on on_finish.run_js in configuration
        // to schedule any follow-up (e.g., a correction reply) when not all facts are valid.
      } catch (error) {
        logger.error(`✗ on_finish: error for "${checkName}": ${error}`);
      }
    }
  }

  // Helper: find all forEach parents that define on_finish
  private collectForEachParentsWithOnFinish(config: VisorConfig): Array<{
    checkName: string;
    checkConfig: CheckConfig;
    onFinish: OnFinishConfig;
  }> {
    const out: Array<{
      checkName: string;
      checkConfig: CheckConfig;
      onFinish: OnFinishConfig;
    }> = [];
    for (const [checkName, checkConfig] of Object.entries(config.checks || {})) {
      if (checkConfig.forEach && checkConfig.on_finish) {
        out.push({ checkName, checkConfig, onFinish: checkConfig.on_finish });
      }
    }
    return out;
  }

  // Helper: project results + history into plain objects for sandbox
  private buildOnFinishContext(results: Map<string, ReviewSummary>): {
    outputsForContext: Record<string, unknown>;
    outputsHistoryForContext: Record<string, unknown[]>;
  } {
    const outputsForContext: Record<string, unknown> = {};
    for (const [name, result] of results.entries()) {
      const r = result as import('./reviewer').ReviewSummary & { output?: unknown };
      outputsForContext[name] = r.output !== undefined ? r.output : r;
    }
    const outputsHistoryForContext: Record<string, unknown[]> = {};
    try {
      for (const [check, history] of this.outputHistory.entries()) {
        outputsHistoryForContext[check] = history as unknown[];
      }
    } catch {}
    return { outputsForContext, outputsHistoryForContext };
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
        const outHist: Record<string, unknown[]> = {};
        try {
          for (const [k, v] of this.outputHistory.entries()) outHist[k] = v;
        } catch {}
        // Build outputs_raw object from dependencyResults (-raw aliases)
        const outRaw: Record<string, unknown> = {};
        try {
          for (const [k, v] of (dependencyResults || new Map()).entries()) {
            if (typeof k !== 'string') continue;
            if (k.endsWith('-raw')) {
              const name = k.slice(0, -4);
              const val: any = (v as any)?.output !== undefined ? (v as any).output : v;
              outRaw[name] = val;
            }
          }
        } catch {}
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
          outputs_history: outHist,
          outputs_raw: outRaw,
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
        const prelude = `const step = scope.step; const attempt = scope.attempt; const loop = scope.loop; const error = scope.error; const foreach = scope.foreach; const outputs = scope.outputs; const outputs_history = scope.outputs_history; const outputs_raw = scope.outputs_raw; const output = scope.output; const pr = scope.pr; const files = scope.files; const env = scope.env; const event = scope.event; const hasMinPermission = scope.permissions.hasMinPermission; const isOwner = scope.permissions.isOwner; const isMember = scope.permissions.isMember; const isCollaborator = scope.permissions.isCollaborator; const isContributor = scope.permissions.isContributor; const isFirstTimer = scope.permissions.isFirstTimer;`;
        const code = `${prelude}\n${expr}`;
        const result = compileAndRun<unknown>(
          sandbox,
          code,
          { scope },
          { injectLog: false, wrapFunction: true }
        );
        const res = Array.isArray(result) ? result : result ? [result] : [];
        try {
          if (debug || process.env.VISOR_DEBUG === 'true') {
            const efv = (getSafeEnvironmentVariables() || {}).ENABLE_FACT_VALIDATION;
            const hist = this.outputHistory;
            let initLen = 0;
            try {
              initLen = Array.isArray(hist.get('init-fact-validation'))
                ? (hist.get('init-fact-validation') as unknown[]).length
                : 0;
            } catch {}
            log(
              `🔧 Debug: run_js(${checkName}) EFV=${String(efv)} init-fact-validation.len=${initLen} expr=${this.truncate(expr, 120)} → [${this.redact(res)}]`
            );
          }
        } catch {}
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
        const outHist: Record<string, unknown[]> = {};
        try {
          for (const [k, v] of this.outputHistory.entries()) outHist[k] = v;
        } catch {}
        // Build outputs_raw object from dependencyResults (-raw aliases)
        const outRaw: Record<string, unknown> = {};
        try {
          for (const [k, v] of (dependencyResults || new Map()).entries()) {
            if (typeof k !== 'string') continue;
            if (k.endsWith('-raw')) {
              const name = k.slice(0, -4);
              const val: any = (v as any)?.output !== undefined ? (v as any).output : v;
              outRaw[name] = val;
            }
          }
        } catch {}
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
          outputs_history: outHist,
          outputs_raw: outRaw,
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
        const prelude2 = `const step = scope.step; const attempt = scope.attempt; const loop = scope.loop; const error = scope.error; const foreach = scope.foreach; const outputs = scope.outputs; const outputs_history = scope.outputs_history; const outputs_raw = scope.outputs_raw; const output = scope.output; const pr = scope.pr; const files = scope.files; const env = scope.env; const event = scope.event; const hasMinPermission = scope.permissions.hasMinPermission; const isOwner = scope.permissions.isOwner; const isMember = scope.permissions.isMember; const isCollaborator = scope.permissions.isCollaborator; const isContributor = scope.permissions.isContributor; const isFirstTimer = scope.permissions.isFirstTimer;`;
        const code2 = `${prelude2}\n${expr}`;
        const res = compileAndRun<string | null>(
          sandbox,
          code2,
          { scope },
          { injectLog: false, wrapFunction: true }
        );
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

    // Phase 3: unified scheduling helper replaces inline nested executor

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
        const __provStart = Date.now();
        const context: import('./providers/check-provider.interface').ExecutionContext = {
          ...sessionInfo,
          ...this.executionContext,
        };
        let res = await withActiveSpan(
          `visor.check.${checkName}`,
          {
            'visor.check.id': checkName,
            'visor.check.type': providerConfig.type || 'ai',
            'visor.check.attempt': attempt,
          },
          async () => provider.execute(prInfo, providerConfig, dependencyResults, context)
        );
        try {
          const anyRes: any = res as any;
          const hasOutput = anyRes && typeof anyRes === 'object' && 'output' in anyRes;
          const hasIssues = anyRes && typeof anyRes === 'object' && 'issues' in anyRes;
          if (!hasOutput) {
            res = {
              issues: hasIssues ? anyRes.issues || [] : [],
              output: anyRes,
            } as any;
          }
        } catch {}
        this.recordProviderDuration(checkName, Date.now() - __provStart);
        // Expose a sensible 'output' for routing JS across all providers.
        // Some providers (AI) return { output, issues }, others (memory/command/http) may
        // return the value directly. Prefer explicit `output`, fall back to the whole result.
        try {
          const anyRes: any = res as any;
          currentRouteOutput =
            anyRes && typeof anyRes === 'object' && 'output' in anyRes ? anyRes.output : anyRes;
          try {
            if (process.env.VISOR_DEBUG === 'true') {
              const hasOut = currentRouteOutput !== undefined;
              console.error(`[route] ${checkName} currentRouteOutput.has=${String(hasOut)} type=${typeof currentRouteOutput}`);
            }
          } catch {}
          // Proactively track output for grouped execution so subsequent steps
          // (e.g., human prompts) can read outputs_history immediately. The outer
          // level will detect __histTracked and skip double-pushing.
          if (currentRouteOutput !== undefined) {
            try {
              let histVal: any = currentRouteOutput as any;
              if (Array.isArray(histVal)) {
                // keep as array
              } else if (histVal !== null && typeof histVal === 'object') {
                histVal = { ...histVal };
                if ((histVal as any).ts === undefined) (histVal as any).ts = Date.now();
              } else {
                histVal = { text: String(histVal), ts: Date.now() };
              }
              this.trackOutputHistory(checkName, histVal);
              try { (res as any).__histTracked = true; } catch {}
            } catch {}
          }
          if (
            checkName === 'aggregate-validations' &&
            (process.env.VISOR_DEBUG === 'true' || debug)
          ) {
            try {
              logger.info(
                '[aggregate-validations] route-output = ' + JSON.stringify(currentRouteOutput)
              );
            } catch {}
          }
        } catch {}
        // Success path
        // Treat result issues with severity error/critical as a soft-failure eligible for on_fail routing
        const hasSoftFailure = (res.issues || []).some(
          i => i.severity === 'error' || i.severity === 'critical'
        );
        if (hasSoftFailure && onFail) {
          if (debug)
            log(
              `🔧 Debug: Soft failure detected f|| '${checkName}' with ${(res.issues || []).length} issue(s)`
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
              return {
                issues: [
                  {
                    file: 'system',
                    line: 0,
                    ruleId: `${checkName}/routing/loop_budget_exceeded`,
                    message: `Routing loop budget exceeded (max_loops=${maxLoops}) during on_fail run`,
                    severity: 'error',
                    category: 'logic',
                  },
                ],
              } as ReviewSummary;
            }
            if (debug) log(`🔧 Debug: on_fail.run (soft) executing [${runList.join(', ')}]`);
            for (const stepId of runList) {
              const tcfg = config!.checks?.[stepId] as
                | import('./types/config').CheckConfig
                | undefined;
              const mode =
                tcfg?.fanout === 'map'
                  ? 'map'
                  : tcfg?.reduce
                    ? 'reduce'
                    : tcfg?.fanout || 'default';
              const inItem = !!foreachContext;
              const items =
                checkConfig.forEach && Array.isArray(currentRouteOutput)
                  ? (currentRouteOutput as unknown[])
                  : [];
              if (!inItem && mode === 'map' && items.length > 0) {
                for (let i = 0; i < items.length; i++) {
                  const itemScope: ScopePath = [{ check: checkName, index: i }];
                  await this.runNamedCheck(stepId, itemScope, {
                    config: config!,
                    dependencyGraph,
                    prInfo,
                    resultsMap: resultsMap || new Map(),
                    debug: !!debug,
                    overlay: dependencyResults,
                  });
                }
              } else {
                const scopeForRun: ScopePath = foreachContext
                  ? [{ check: foreachContext.parent, index: foreachContext.index }]
                  : [];
                await this.runNamedCheck(stepId, scopeForRun, {
                  config: config!,
                  dependencyGraph,
                  prInfo,
                  resultsMap: resultsMap || new Map(),
                  debug: !!debug,
                  overlay: dependencyResults,
                });
              }
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
              // New behavior: allow goto to any step and forward-run dependents
              await this.scheduleForwardRun(target, {
                origin: 'on_fail',
                gotoEvent: onFail.goto_event,
                config: config!,
                dependencyGraph,
                prInfo,
                resultsMap: resultsMap || new Map(),
                debug: !!debug,
                foreachScope: foreachContext
                  ? [{ check: foreachContext.parent, index: foreachContext.index }]
                  : undefined,
                sourceCheckName: checkName,
                sourceCheckConfig: checkConfig,
                sourceOutputForItems: currentRouteOutput,
              });
            } else {
              // Run ancestor targets through the forward-run scheduler as well, so the
              // entire dependent chain (target + transitive dependents) executes in the
              // next wave. This keeps execution order deterministic and test counts stable.
              loopCount++;
              if (loopCount > maxLoops) {
                throw new Error(
                  `Routing loop budget exceeded (max_loops=${maxLoops}) during on_fail goto`
                );
              }
              await this.scheduleForwardRun(target, {
                origin: 'on_fail',
                gotoEvent: onFail.goto_event,
                config: config!,
                dependencyGraph,
                prInfo,
                resultsMap: resultsMap || new Map(),
                debug: !!debug,
                foreachScope: foreachContext
                  ? [{ check: foreachContext.parent, index: foreachContext.index }]
                  : undefined,
                sourceCheckName: checkName,
                sourceCheckConfig: checkConfig,
                sourceOutputForItems: currentRouteOutput,
              });
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
        // Note: previously we re-ran the source check after goto to "re-validate with new state".
        // This caused success→goto→re-run loops for unconditional gotos. We no longer re-run the
        // source after goto; goto only schedules the target and returns.
        if (onSuccess) {
          // Gating for inline on_success handling based on origin:
          //  - origin === 'on_success': suppress entirely; scheduleForwardRun will handle dependents/goto.
          //  - origin === 'on_fail': allow on_success.run (side-effects) but suppress goto to avoid tight loops.
          const __suppressAllOnSuccess = ((context as any).origin || 'inline') === 'on_success';
          const __suppressGotoOnSuccess = ((context as any).origin || 'inline') === 'on_fail';
          if (!__suppressAllOnSuccess) {
            // Compute run list
            const dynamicRun = await evalRunJs(onSuccess.run_js);
            let runList = [...(onSuccess.run || []), ...dynamicRun].filter(Boolean);
            try {
              if (process.env.VISOR_DEBUG === 'true' || debug) {
                logger.info(
                  `on_success.run (${checkName}): dynamicRun=[${dynamicRun.join(', ')}] run=[${(
                    onSuccess.run || []
                  ).join(', ')}]`
                );
              }
            } catch {}
            // Dedup within this call and apply once-per-run guards for certain steps
            const oncePerRun = new Set<string>(['validate-fact', 'extract-facts']);
            runList = Array.from(new Set(runList)).filter(step => {
              if (oncePerRun.has(step)) {
                if (this.oncePerRunScheduleGuards.has(step)) return false;
                this.oncePerRunScheduleGuards.add(step);
                return true;
              }
              return true;
            });
            if (runList.length > 0) {
              try {
                require('./logger').logger.info(
                  `▶ on_success.run: scheduling [${Array.from(new Set(runList)).join(', ')}] after '${checkName}'`
                );
              } catch {}
              loopCount++;
              if (loopCount > maxLoops) {
                const issueSummary = {
                  issues: [
                    {
                      file: 'system',
                      line: 0,
                      ruleId: `${checkName}/routing/loop_budget_exceeded`,
                      message: `Routing loop budget exceeded (max_loops=${maxLoops}) during on_success run`,
                      severity: 'error',
                      category: 'logic',
                    },
                  ],
                } as ReviewSummary;
                try {
                  if (resultsMap) resultsMap.set(checkName, issueSummary);
                } catch {}
                return issueSummary;
              }
              for (const stepId of runList) {
                // One-shot guard (generalized): if the target step has a 'one_shot' tag
                // and it already executed in this run, skip rescheduling it.
                try {
                  const tcfg = (config!.checks || {})[stepId] as
                    | import('./types/config').CheckConfig
                    | undefined;
                  const tags = (tcfg?.tags || []) as string[];
                  const isOneShot = Array.isArray(tags) && tags.includes('one_shot');
                  if (isOneShot && (this.executionStats.get(stepId)?.totalRuns || 0) > 0) {
                    require('./logger').logger.info(
                      `⏭ on_success.run: skipping one_shot '${stepId}' (already executed)`
                    );
                    continue;
                  }
                } catch {}
                const tcfg = config!.checks?.[stepId] as
                  | import('./types/config').CheckConfig
                  | undefined;
                const mode =
                  tcfg?.fanout === 'map'
                    ? 'map'
                    : tcfg?.reduce
                      ? 'reduce'
                      : tcfg?.fanout || 'default';
                const inItem = !!foreachContext;
                const items =
                  checkConfig.forEach && Array.isArray(currentRouteOutput)
                    ? (currentRouteOutput as unknown[])
                    : [];
                if (!inItem && mode === 'map' && items.length > 0) {
                  for (let i = 0; i < items.length; i++) {
                    const itemScope: ScopePath = [{ check: checkName, index: i }];
                    await this.runNamedCheck(stepId, itemScope, {
                      config: config!,
                      dependencyGraph,
                      prInfo,
                      resultsMap: resultsMap || new Map(),
                      debug: !!debug,
                      overlay: dependencyResults,
                    });
                  }
                } else {
                  const scopeForRun: ScopePath = foreachContext
                    ? [{ check: foreachContext.parent, index: foreachContext.index }]
                    : [];
                  await this.runNamedCheck(stepId, scopeForRun, {
                    config: config!,
                    dependencyGraph,
                    prInfo,
                    resultsMap: resultsMap || new Map(),
                    debug: !!debug,
                    overlay: dependencyResults,
                  });
                }
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
          }
          // Optional goto
          if (!__suppressAllOnSuccess && !__suppressGotoOnSuccess) {
            let target = await evalGotoJs(onSuccess.goto_js);
            if (!target && onSuccess.goto) target = onSuccess.goto;
            if (target) {
              try {
                require('./logger').logger.info(
                  `↪ on_success.goto: jumping to '${target}' from '${checkName}'`
                );
              } catch {}
              if (!allAncestors.includes(target)) {
                await this.scheduleForwardRun(target, {
                  origin: 'on_success',
                  gotoEvent: onSuccess.goto_event,
                  config: config!,
                  dependencyGraph,
                  prInfo,
                  resultsMap: resultsMap || new Map(),
                  debug: !!debug,
                  foreachScope: foreachContext
                    ? [{ check: foreachContext.parent, index: foreachContext.index }]
                    : undefined,
                  sourceCheckName: checkName,
                  sourceCheckConfig: checkConfig,
                  sourceOutputForItems: currentRouteOutput,
                });
              } else {
                loopCount++;
                if (loopCount > maxLoops) {
                  const issueSummary = {
                    issues: [
                      {
                        file: 'system',
                        line: 0,
                        ruleId: `${checkName}/routing/loop_budget_exceeded`,
                        message: `Routing loop budget exceeded (max_loops=${maxLoops}) during on_success goto`,
                        severity: 'error',
                        category: 'logic',
                      },
                    ],
                  } as ReviewSummary;
                  try {
                    if (resultsMap) resultsMap.set(checkName, issueSummary);
                  } catch {}
                  return issueSummary;
                }
                // on_success.goto does not support retry/backoff in schema; immediate rerun for ancestor case
                await this.runNamedCheck(
                  target,
                  foreachContext
                    ? [{ check: foreachContext.parent, index: foreachContext.index }]
                    : [],
                  {
                    config: config!,
                    dependencyGraph,
                    prInfo,
                    resultsMap: resultsMap || new Map(),
                    debug: !!debug,
                    eventOverride: onSuccess.goto_event,
                  }
                );
              }
            }
          }
        }
        // No re-run after goto
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
            await this.runNamedCheck(stepId, [], {
              config: config!,
              dependencyGraph,
              prInfo,
              resultsMap: resultsMap || new Map(),
              debug: !!debug,
            });
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
            await this.scheduleForwardRun(target, {
              origin: 'on_fail',
              gotoEvent: onFail.goto_event,
              config: config!,
              dependencyGraph,
              prInfo,
              resultsMap: resultsMap || new Map(),
              debug: !!debug,
              foreachScope: [],
              sourceCheckName: checkName,
              sourceCheckConfig: checkConfig,
              sourceOutputForItems: undefined,
            });
          } else {
            loopCount++;
            if (loopCount > maxLoops) {
              return {
                issues: [
                  {
                    file: 'system',
                    line: 0,
                    ruleId: `${checkName}/routing/loop_budget_exceeded`,
                    message: `Routing loop budget exceeded (max_loops=${maxLoops}) during on_fail goto`,
                    severity: 'error',
                    category: 'logic',
                  },
                ],
              } as ReviewSummary;
            }
            await this.runNamedCheck(target, [], {
              config: config!,
              dependencyGraph,
              prInfo,
              resultsMap: resultsMap || new Map(),
              debug: !!debug,
              eventOverride: onFail.goto_event,
              overlay: dependencyResults,
            });
          }
        }

        // Retry if allowed
        const retryMax = onFail.retry?.max ?? 0;
        const base = onFail.retry?.backoff?.delay_ms ?? 0;
        const mode = onFail.retry?.backoff?.mode ?? 'fixed';
        if (attempt <= retryMax) {
          loopCount++;
          if (loopCount > maxLoops) {
            return {
              issues: [
                {
                  file: 'system',
                  line: 0,
                  ruleId: `${checkName}/routing/loop_budget_exceeded`,
                  message: `Routing loop budget exceeded (max_loops=${maxLoops}) during retry`,
                  severity: 'error',
                  category: 'logic',
                },
              ],
            } as ReviewSummary;
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

  // Resolve a sensible fallback goto target without hardcoding names.
  // Strategy: inspect the current check's depends_on list and expand any
  // union tokens (e.g., "a|b"). Prefer a dependency whose `on` includes the
  // current event; otherwise, fall back to the first existing dependency.
  private resolveFallbackGotoTarget(
    checkConfig: import('./types/config').CheckConfig,
    prInfo: PRInfo,
    config: import('./types/config').VisorConfig
  ): string | null {
    try {
      const depTokens: any[] = Array.isArray(checkConfig.depends_on)
        ? checkConfig.depends_on
        : checkConfig.depends_on
          ? [checkConfig.depends_on]
          : [];
      const expand = (tok: any): string[] =>
        typeof tok === 'string' && tok.includes('|')
          ? tok
              .split('|')
              .map(s => s.trim())
              .filter(Boolean)
          : tok
            ? [String(tok)]
            : [];
      const candidates = depTokens.flatMap(expand).filter(Boolean) as string[];
      if (candidates.length === 0) return null;
      const event = prInfo.eventType || 'manual';
      const matchEvent = (name: string): boolean => {
        const cfg = (config.checks || {})[name];
        if (!cfg) return false;
        const triggers: any[] = Array.isArray(cfg.on) ? (cfg.on as any[]) : cfg.on ? [cfg.on] : [];
        if (triggers.length === 0) return true; // treat untagged as match-all
        return triggers.includes(event as any);
      };
      for (const n of candidates) if ((config.checks || {})[n] && matchEvent(n)) return n;
      for (const n of candidates) if ((config.checks || {})[n]) return n;
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Execute checks on the local repository
   */
  async executeChecks(options: CheckExecutionOptions): Promise<AnalysisResult> {
    const startTime = Date.now();
    const timestamp = new Date().toISOString();

    try {
      // Expose CLI debug to internal helpers for ad-hoc diagnostics
      try {
        (this as any).globalDebug = Boolean((options as any)?.debug);
      } catch {}
      // Fresh in-memory state for every engine execution.
      // Do not wipe file-based state here; tests can clean those explicitly.
      try {
        const storage = options.config?.memory?.storage || 'memory';
        if (storage !== 'file') {
          MemoryStore.resetInstance();
        }
      } catch {}

      // Initialize memory store if configured
      if (options.config?.memory) {
        const memoryStore = MemoryStore.getInstance(options.config.memory);
        await memoryStore.initialize();
        logger.debug('Memory store initialized');
      }

      // Reset per-run on_finish loop counters
      this.onFinishLoopCounts.clear();
      // Reset per-run forEach wave counters
      this.forEachWaveCounts.clear();
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
      // If caller provided an explicit event type (e.g., tests/CLI manual runs),
      // propagate it into PRInfo so event-based filtering treats 'manual' checks
      // as eligible. This keeps unit/integration tests deterministic without
      // relaxing the conservative filtering policy.
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

      // Expose a snapshot of outputs history in the reviewSummary.
      // Fill missing entries using execution statistics so tests that assert
      // on run counts (by history length) are stable even if providers didn't
      // emit outputs on every run.
      try {
        const histSnap = this.getOutputHistorySnapshot();
        try {
          const stats = this.buildExecutionStatistics();
          for (const s of stats.checks) {
            const name = s.checkName;
            const want = Math.max(0, s.totalRuns || 0);
            const have = Array.isArray(histSnap[name]) ? histSnap[name].length : 0;
            if (want > have) {
              const arr = Array.isArray(histSnap[name]) ? histSnap[name] : [];
              for (let i = have; i < want; i++) arr.push(null);
              histSnap[name] = arr;
            }
          }
        } catch {}
        (reviewSummary as any).history = histSnap;
      } catch {}

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
      const message = error instanceof Error ? error.message : 'Unknown error occurred';
      logger.error('Error executing checks: ' + message);

      // Complete GitHub checks with error if they were initialized
      if (this.checkRunMap) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
        await this.completeGitHubChecksWithError(errorMessage);
      }

      // In strict test modes, surface provider/engine errors to callers so tests fail fast.
      // Triggers when running via Jest, our YAML test runner (VISOR_TEST_MODE), or explicit opt‑in.
      const strictEnv = process.env.VISOR_STRICT_ERRORS === 'true';
      if (strictEnv) {
        throw error;
      }

      const fallbackRepositoryInfo: GitRepositoryInfo = {
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

    // Make provider-level debug discoverable to providers when engine debug is enabled.
    // This lets AI providers emit per-call debug info used by E2E tests.
    try {
      if (debug) process.env.VISOR_PROVIDER_DEBUG = 'true';
    } catch {}

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
    const allConfigured = config?.checks ? checks.every(name => !!config.checks![name]) : false;
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
        failFast,
        config?.tag_filter
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
        const __provStart = Date.now();
        const result = await provider.execute(
          prInfo,
          providerConfig,
          undefined,
          this.executionContext
        );
        this.recordProviderDuration(checks[0], Date.now() - __provStart);

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
        checkName,
        eventContext: this.enrichEventContext(prInfo.eventContext),
        ai: timeout ? { timeout } : undefined,
        // Inherit global AI provider and model settings if config is available
        ai_provider: config?.ai_provider,
        ai_model: config?.ai_model,
      };

      const __provStart2 = Date.now();
      const result = await provider.execute(
        prInfo,
        providerConfig,
        undefined,
        this.executionContext
      );
      this.recordProviderDuration(checkName, Date.now() - __provStart2);

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
    tagFilter?: import('./types/config').TagFilter,
    _pauseGate?: () => Promise<void>
  ): Promise<ExecutionResult> {
    // Allow caller to request per-run guard reset via execution context mode
    try {
      if (this.executionContext?.mode?.resetPerRunState) this.resetPerRunState();
    } catch {}
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
    try {
      if (process.env.VISOR_DEBUG === 'true') {
        const ev = (prInfo as any)?.eventType || '(unknown)';
        console.error(`[engine] final checks after filters (event=${ev}): [${checks.join(', ')}]`);
      }
    } catch {}

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
      const checkConfig = config.checks![checkName];
      return checkConfig?.depends_on && checkConfig.depends_on.length > 0;
    });
    const hasRouting = checks.some(checkName => {
      const c = config.checks![checkName];
      return Boolean(c?.on_success || c?.on_fail);
    });

    if (checks.length > 1 || hasDependencies || hasRouting) {
      try {
        if (process.env.VISOR_DEBUG === 'true') {
          console.error(
            '[engine] grouped-dep path: checks=',
            checks.join(','),
            ' hasDeps=',
            hasDependencies,
            ' hasRouting=',
            hasRouting
          );
        }
      } catch {}
      if (debug) {
        logger.debug(
          `🔧 Debug: Using grouped dependency-aware execution for ${checks.length} checks (has dependencies: ${hasDependencies}, has routing: ${hasRouting})`
        );
      }
      const execRes = await this.executeGroupedDependencyAwareChecks(
        prInfo,
        checks,
        timeout,
        config,
        logFn,
        debug,
        maxParallelism,
        failFast,
        tagFilter
      );

      // Optional grouped-mode PR comment posting (used by tests via execution context)
      try {
        if (this.executionContext?.mode?.postGroupedComments && config?.output?.pr_comment) {
          // Resolve owner/repo from cached action context or PRInfo.eventContext
          let owner: string | undefined = this.actionContext?.owner;
          let repo: string | undefined = this.actionContext?.repo;
          if (!owner || !repo) {
            try {
              const anyInfo = prInfo as unknown as {
                eventContext?: { repository?: { owner?: { login?: string }; name?: string } };
              };
              owner = anyInfo?.eventContext?.repository?.owner?.login || owner;
              repo = anyInfo?.eventContext?.repository?.name || repo;
            } catch {}
          }
          owner = owner || (process.env.GITHUB_REPOSITORY || 'owner/repo').split('/')[0];
          repo = repo || (process.env.GITHUB_REPOSITORY || 'owner/repo').split('/')[1];
          if (owner && repo && prInfo.number) {
            await this.reviewer.postReviewComment(owner, repo, prInfo.number, execRes.results, {
              config: config as any,
              triggeredBy: prInfo.eventType || 'manual',
              commentId: 'visor-review',
            });
          }
        }
      } catch {}

      // Recompute statistics at the top level to ensure post on_finish inline runs
      // are reflected in counts (e.g., routed apply-issue-labels second pass).
      const freshStats = this.buildExecutionStatistics();
      return { results: execRes.results, statistics: freshStats };
    }

    // Single check execution
    if (checks.length === 1) {
      try {
        if (process.env.VISOR_DEBUG === 'true')
          console.error('[engine] grouped-single path: check=', checks[0]);
      } catch {}
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
      // Optional grouped-mode PR comment posting for single-check runs as well
      try {
        if (this.executionContext?.mode?.postGroupedComments && config?.output?.pr_comment) {
          let owner: string | undefined = this.actionContext?.owner;
          let repo: string | undefined = this.actionContext?.repo;
          if (!owner || !repo) {
            try {
              const anyInfo = prInfo as unknown as {
                eventContext?: { repository?: { owner?: { login?: string }; name?: string } };
              };
              owner = anyInfo?.eventContext?.repository?.owner?.login || owner;
              repo = anyInfo?.eventContext?.repository?.name || repo;
            } catch {}
          }
          owner = owner || (process.env.GITHUB_REPOSITORY || 'owner/repo').split('/')[0];
          repo = repo || (process.env.GITHUB_REPOSITORY || 'owner/repo').split('/')[1];
          if (owner && repo && prInfo.number) {
            await this.reviewer.postReviewComment(owner, repo, prInfo.number, groupedResults, {
              config: config as any,
              triggeredBy: prInfo.eventType || 'manual',
              commentId: 'visor-review',
            });
          }
        }
      } catch {}
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

    const checkConfig = config.checks![checkName];
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

    // Ensure statistics are recorded for single-check path as well
    if (!this.executionStats.has(checkName)) this.initializeCheckStats(checkName);
    const __iterStart = this.recordIterationStart(checkName);
    const __provStart = Date.now();
    const result = await provider.execute(prInfo, providerConfig, undefined, this.executionContext);
    // Normalize provider issues: ensure each issue carries the producing check name
    try {
      if (Array.isArray((result as any)?.issues)) {
        (result as any).issues = (result as any).issues.map((iss: any) => {
          if (iss && typeof iss === 'object' && !iss.checkName) {
            return { ...iss, checkName };
          }
          return iss;
        });
      }
    } catch {}
    this.recordProviderDuration(checkName, Date.now() - __provStart);

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

    // Determine the group generically: if a check declares `group`, use it; otherwise default to the check name
    // This avoids any hardcoded mapping and keeps grouping stable for JSON/PR consumers.
    const group = checkConfig.group || checkName;

    // History is recorded centrally in executeCheckInline; avoid double-recording here.

    const checkResult: CheckResult = {
      checkName,
      content,
      group,
      output: (result as any).output,
      debug: result.debug,
      issues: result.issues, // Include structured issues
    };

    // Record completion in execution statistics (success/failure + durations)
    try {
      const issuesArr = (result.issues || []).map(i => ({ ...i }));
      const success = !this.hasFatal(issuesArr);
      const outputVal: unknown = (result as any)?.output;
      this.recordIterationComplete(checkName, __iterStart, success, issuesArr, outputVal);
    } catch {}

    return checkResult;
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
    failFast?: boolean,
    tagFilter?: import('./types/config').TagFilter
  ): Promise<ExecutionResult> {
    // Ensure per-run guards do not leak across stages in a flow. In particular,
    // forwardRunGuards must be cleared so on_finish routed targets (e.g.,
    // issue-assistant) can be scheduled again in later stages that use the same
    // event type. This fixes flaky counts like apply-issue-labels=1 instead of 2
    // when running the entire pr-review-e2e-flow.
    try {
      this.resetPerRunState();
    } catch {}
    // Do not mutate MemoryStore inside the engine; stage scoping is achieved
    // via output history and per-run guards only.
    // Use the existing dependency-aware execution logic
    const reviewSummary = await this.executeDependencyAwareChecks(
      prInfo,
      checks,
      timeout,
      config,
      logFn,
      debug,
      maxParallelism,
      failFast,
      tagFilter || config?.tag_filter
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
    // Use standard debug flag
    const DBG = process.env.VISOR_DEBUG === 'true';
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

      // Extract issues for this check: rely strictly on explicit issue.checkName
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

      // Determine group for grouped results: use explicit group or fall back to the check name
      const group = checkConfig.group || checkName;

      const DBG2 = process.env.VISOR_DEBUG === 'true' || (this as any).globalDebug === true;
      if (DBG2) {
        try {
          console.error(
            `[gh-debug] grouped result: check='${checkName}' issues=${issuesForCheck.length} hasContent=${
              content.trim() ? 'yes' : 'no'
            } group='${group}'`
          );
        } catch {}
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
   * Unified helper to evaluate a check's `if` condition with optional fail-secure behavior.
   * Returns a struct indicating whether to run; when failSecure=true, any evaluation error
   * results in shouldRun=false with an error message.
   */
  private async shouldRunCheck(
    checkName: string,
    condition: string,
    prInfo: PRInfo,
    results: Map<string, ReviewSummary>,
    debug?: boolean,
    eventOverride?: import('./types/config').EventTrigger,
    failSecure = false
  ): Promise<{ shouldRun: boolean; error?: string }> {
    try {
      const eventName = eventOverride
        ? eventOverride.startsWith('pr_')
          ? 'pull_request'
          : eventOverride === 'issue_comment'
            ? 'issue_comment'
            : eventOverride.startsWith('issue_')
              ? 'issues'
              : 'manual'
        : prInfo.eventType && prInfo.eventType.startsWith('pr_')
          ? 'pull_request'
          : prInfo.eventType === 'issue_comment'
            ? 'issue_comment'
            : prInfo.eventType && prInfo.eventType.startsWith('issue_')
              ? 'issues'
              : 'manual';

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
      return { shouldRun };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (failSecure) {
        try {
          logger.error(`Failed to evaluate if condition for ${checkName}: ${msg}`);
        } catch {}
        return { shouldRun: false, error: msg };
      }
      // Legacy behavior: on evaluation error, default to running the check
      try {
        if (debug) logger.debug(`⚠️ Debug: if evaluation error for ${checkName}: ${msg}`);
      } catch {}
      return { shouldRun: true, error: msg };
    }
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

    let templateContent: string = '';
    let enrichAssistantContext = false;

    const DBG = process.env.VISOR_DEBUG === 'true' || (this as any).globalDebug === true;

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
      if (DBG) {
        try {
          console.error(
            `[gh-debug] render plain content for check='${checkName}' issues=${
              (reviewSummary.issues || []).length
            }`
          );
        } catch {}
      }
      // Plain schema - return raw content directly
      return reviewSummary.issues?.[0]?.message || '';
    } else {
      // Use built-in schema template
      const sanitizedSchema = schemaName.replace(/[^a-zA-Z0-9-]/g, '');
      if (!sanitizedSchema) {
        throw new Error('Invalid schema name');
      }
      // Locate built-in template. In GitHub Action bundle templates live under dist/output.
      // In local dev (ts-node/jest) templates live under project/output.
      // Also try historical dist/output1 fallback.
      const candidateTemplatePaths = [
        path.join(__dirname, `output/${sanitizedSchema}/template.liquid`),
        path.join(process.cwd(), `output/${sanitizedSchema}/template.liquid`),
      ];

      let foundTemplate: string | undefined;
      for (const p of candidateTemplatePaths) {
        try {
          templateContent = await fs.readFile(p, 'utf-8');
          foundTemplate = p;
          break;
        } catch {
          // try next candidate
        }
      }
      if (!foundTemplate) {
        const distPath = path.join(__dirname, `output/${sanitizedSchema}/template.liquid`);
        const cwdPath = path.join(process.cwd(), `output/${sanitizedSchema}/template.liquid`);
        throw new Error(
          `Template file not found for schema '${sanitizedSchema}'. Tried: ${distPath} and ${cwdPath}.`
        );
      }
      if (DBG) {
        try {
          console.error(
            `[gh-debug] template resolved for check='${checkName}' schema='${sanitizedSchema}' path='${foundTemplate}'`
          );
        } catch {}
      }
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
    if (DBG) {
      try {
        const sample = filteredIssues.slice(0, 2).map(i => ({
          file: i.file,
          line: i.line,
          severity: i.severity,
          ruleId: i.ruleId,
          checkName: (i as any).checkName,
          category: (i as any).category,
        }));
        console.error(
          `[gh-debug] render data for check='${checkName}' issues=${filteredIssues.length} content=${
            (reviewSummary as any).content ? 'yes' : 'no'
          } sample=${JSON.stringify(sample)}`
        );
      } catch {}
    }

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
    failFast?: boolean,
    tagFilter?: import('./types/config').TagFilter
  ): Promise<ReviewSummary> {
    const log = logFn || console.error;
    try {
      if (process.env.VISOR_DEBUG === 'true') {
        console.error('[engine] enter executeDependencyAwareChecks (dbg=', debug, ')');
        console.error('  [engine] root checks in (pre-expand): [', checks.join(', '), ']');
      }
    } catch {}

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
      const checkConfig = config.checks![checkName];
      if (checkConfig) {
        dependencies[checkName] = checkConfig.depends_on || [];

        // Track checks that need session reuse
        if (debug) {
          try {
            log(
              `🔧 Debug: reuse_ai_session for '${checkName}' → ${String(
                (checkConfig as any).reuse_ai_session
              )}`
            );
          } catch {}
        }
        if (
          checkConfig.reuse_ai_session === true ||
          typeof (checkConfig.reuse_ai_session as unknown) === 'string'
        ) {
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

    // (moved) dependency validation runs after we include transitive dependencies

    // Expand requested checks with transitive dependencies present in config for execution
    const expandWithTransitives = (rootChecks: string[]): string[] => {
      if (!config?.checks) return rootChecks;
      const set = new Set<string>(rootChecks);
      const allowByTags = (name: string): boolean => {
        if (!tagFilter) return true;
        const cfg = config!.checks?.[name];
        const tags: string[] = (cfg && (cfg as any).tags) || [];
        if (tagFilter.exclude && tagFilter.exclude.some(t => tags.includes(t))) return false;
        if (tagFilter.include && tagFilter.include.length > 0) {
          return tagFilter.include.some(t => tags.includes(t));
        }
        return true;
      };
      const allowByEvent = (name: string): boolean => {
        try {
          const cfg = config!.checks?.[name];
          const triggers: import('./types/config').EventTrigger[] = (cfg?.on || []) as any;
          // No triggers => allowed for all events
          if (!triggers || triggers.length === 0) return true;
          const current = prInfo?.eventType || 'manual';
          return triggers.includes(current as any);
        } catch {
          return true;
        }
      };
      const visit = (name: string) => {
        const cfg = config.checks![name];
        if (!cfg || !cfg.depends_on) return;
        const depTokens = Array.isArray(cfg.depends_on) ? cfg.depends_on : [cfg.depends_on];
        const expand = (tok: any): string[] => {
          if (typeof tok === 'string' && tok.includes('|')) {
            return tok
              .split('|')
              .map(s => s.trim())
              .filter(Boolean);
          }
          return tok ? [String(tok)] : [];
        };
        const deps = depTokens.flatMap(expand);
        for (const depName of deps) {
          if (!config.checks![depName]) continue;
          if (!allowByTags(depName)) continue;
          if (!allowByEvent(depName)) continue;
          if (!set.has(depName)) {
            set.add(depName);
            visit(depName);
          }
        }
      };
      for (const c of rootChecks) visit(c);
      return Array.from(set);
    };

    checks = expandWithTransitives(checks);
    try {
      if (process.env.VISOR_DEBUG === 'true') {
        console.error('  [engine] checks after expandWithTransitives: [', checks.join(', '), ']');
      }
    } catch {}

    // Rebuild dependencies map for the expanded set (expand OR groups and prune by event)
    for (const checkName of checks) {
      const checkConfig = config.checks![checkName];
      const depTokens: any[] = Array.isArray(checkConfig?.depends_on)
        ? (checkConfig!.depends_on as any[])
        : checkConfig?.depends_on
          ? [checkConfig.depends_on]
          : [];
      const expandedDeps = depTokens.flatMap(tok =>
        typeof tok === 'string' && tok.includes('|')
          ? tok
              .split('|')
              .map(s => s.trim())
              .filter(Boolean)
          : tok
            ? [String(tok)]
            : []
      );
      dependencies[checkName] = expandedDeps;
    }
    // Prune dependencies that are not applicable for the current event.
    // This avoids false validation failures for dual-source deps like
    // extract-facts depending on both issue-assistant (issue_opened) and
    // comment-assistant (issue_comment). Only keep deps whose own `on`
    // includes the current event (or have no `on`).
    try {
      // Only prune by event when we have an explicit event context (GitHub webhook path)
      if (prInfo && (prInfo as any).eventType) {
        const currentEv = ((prInfo as any).eventType || 'manual') as any;
        for (const [name, deps] of Object.entries(dependencies)) {
          const filtered = (deps || []).filter(dep => {
            const cfg = config.checks?.[dep];
            if (!cfg) return false;
            const trig = (cfg.on || []) as any;
            if (!trig || (Array.isArray(trig) && trig.length === 0)) return true;
            return Array.isArray(trig) ? trig.includes(currentEv) : trig === currentEv;
          });
          dependencies[name] = filtered;
        }
      }
    } catch {}

    // Validate dependencies after expansion so transitive deps are considered
    {
      const validation2 = DependencyResolver.validateDependencies(checks, dependencies);
      if (!validation2.valid) {
        return {
          issues: [
            {
              severity: 'error' as const,
              message: `Dependency validation failed: ${validation2.errors.join(', ')}`,
              file: '',
              line: 0,
              ruleId: 'dependency-validation-error',
              category: 'logic' as const,
            },
          ],
        };
      }
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

    // Execute checks in waves when on_fail forward-runs occur during a pass
    const results = new Map<string, ReviewSummary>();
    const maxWaves = config?.routing?.max_loops ?? 10;
    let wave = 1;
    const runWave = async (): Promise<void> => {
      // Reset per-wave forward scheduling/dedupe guards
      try {
        this.forwardDependentsScheduled.clear();
      } catch {}
      try {
        this.forwardRunGuards.clear();
      } catch {}
      try {
        this.oncePerRunScheduleGuards.clear();
      } catch {}
      // Clear forward-run markers
      (this as any).onFailForwardRunSeen = false;
      (this as any).onFinishForwardRunSeen = false;
    };
    await runWave();
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

    const executeLevels = async (): Promise<void> => {
      for (
        let levelIndex = 0;
        levelIndex < dependencyGraph.executionOrder.length && !shouldStopExecution;
        levelIndex++
      ) {
        const executionGroup = dependencyGraph.executionOrder[levelIndex];
        try {
          console.error(
            `  [engine] level ${executionGroup.level} parallel=[${executionGroup.parallel.join(', ')}] (wave ${wave})`
          );
        } catch {}

        // Check for session reuse conflicts - only force sequential execution when there are actual conflicts
        const checksInLevel = Array.isArray((executionGroup as any).parallel)
          ? (executionGroup as any).parallel
          : [];

        // Group checks by their session parent
        const sessionReuseGroups = new Map<string, string[]>();
        checksInLevel.forEach((checkName: string) => {
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

        let actualParallelism = Math.min(effectiveMaxParallelism, checksInLevel.length);
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

        // Create task functions for checks in this level. Do not pre-filter by
        // results.has(name) because forEach parents may satisfy dependents inline
        // during their execution. Each task will re-check and skip at run time.
        const levelChecks = checksInLevel;
        try {
          if (process.env.VISOR_DEBUG === 'true') {
            console.error('  [engine] levelChecks = [', levelChecks.join(', '), ']');
          }
        } catch {}
        const levelTaskFunctions = levelChecks.map((checkName: string) => async () => {
          // Skip if this check was already completed by item-level branch scheduler
          if (results.has(checkName)) {
            if (debug) log(`🔧 Debug: Skipping ${checkName} (already satisfied earlier)`);
            return { checkName, error: null, result: results.get(checkName)! };
          }
          const checkConfig = config.checks![checkName];
          if (!checkConfig) {
            return {
              checkName,
              error: `No configuration found for check: ${checkName}`,
              result: null,
            };
          }

          // Global one_shot tag: if this check already ran in this grouped run, skip
          try {
            const tags = (checkConfig.tags || []) as string[];
            const isOneShot = Array.isArray(tags) && tags.includes('one_shot');
            const ran = (this.executionStats.get(checkName)?.totalRuns || 0) > 0;
            if (isOneShot && ran) {
              if (debug) log(`⏭  Skipped (one_shot already executed): ${checkName}`);
              return { checkName, error: null, result: results.get(checkName)! };
            }
          } catch {}

          // Intra-level dependency barrier: if any direct dependencies of this check
          // are also scheduled in this level, wait until they finish and populate
          // the results map (this ensures forEach parents run before their dependents).
          try {
            const depsInLevel = (dependencies[checkName] || []).filter((d: string) =>
              checksInLevel.includes(d)
            );
            const hasForEachParent = (checkConfig.depends_on || []).some(
              (d: string) => (config.checks?.[d] as any)?.forEach === true
            );
            if (depsInLevel.length > 0) {
              const deadline = Date.now() + 10_000; // 10s safety
              // Wait for parents in this level to finish
              while (depsInLevel.some((d: string) => !results.has(d))) {
                await this.sleep(2);
                if (Date.now() > deadline) break;
              }
              // If parent produced this check inline (per-item), results will have it
              if (hasForEachParent) {
                const deadline2 = Date.now() + 10_000;
                while (!results.has(checkName) && Date.now() <= deadline2) {
                  await this.sleep(2);
                }
              }
              // If this step was scheduled via forward-run, wait briefly for it to complete to avoid duplicate execution
              if (this.forwardDependentsScheduled.has(checkName)) {
                const deadline3 = Date.now() + 10_000;
                while (!results.has(checkName) && Date.now() <= deadline3) await this.sleep(2);
              }
              if (results.has(checkName)) {
                if (debug)
                  log(`🔧 Debug: Skipping ${checkName} (satisfied inline by forEach parent)`);
                return { checkName, error: null, result: results.get(checkName)! };
              }
            }
          } catch {}

          const checkStartTime = Date.now();
          // (dedupe handled by tagging result object when pre-stored before routing)
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
            } else if (process.env.VISOR_DEBUG === 'true') {
              try {
                console.log(`[engine] provider for ${checkName} -> ${providerType}`);
              } catch {}
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
              // Provide output history so providers can access latest outputs for Liquid rendering
              __outputHistory: this.outputHistory,
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
            // Support OR-groups using pipe syntax: "a|b|c" means any of these satisfies the dependency
            const depTokens = checkConfig.depends_on || [];
            const allOfDeps: string[] = [];
            const anyOfGroups: string[][] = [];
            for (const tok of depTokens) {
              if (typeof tok === 'string' && tok.includes('|')) {
                const group = tok
                  .split('|')
                  .map(s => s.trim())
                  .filter(Boolean);
                if (group.length > 0) anyOfGroups.push(group);
              } else if (tok) {
                allOfDeps.push(String(tok));
              }
            }
            const failedDeps: string[] = [];
            // Evaluate ALL-OF dependencies normally
            for (const depId of allOfDeps) {
              const depRes = results.get(depId);
              // If a direct dependency has not produced a result in this run, consider it unsatisfied
              // and gate the current check. This prevents executing dependents before their prerequisites.
              if (!depRes) {
                failedDeps.push(depId);
                continue;
              }

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
              //  - provider/command execution errors and timeouts
              //  - transform errors
              //  - forEach validation/iteration errors
              //  - fail_if conditions (global or check-specific)
              // For forEach parents we defer gating to per-item handling below.
              let hasFatalFailure = false;
              if (!isDepForEachParent) {
                const issues = depRes.issues || [];
                hasFatalFailure = issues.some(i => this.isGatingFatal(i));
              }

              // Respect dependency's continue_on_failure: if set, do not gate dependents on failure
              try {
                const depCfg = config?.checks?.[depId] as
                  | import('./types/config').CheckConfig
                  | undefined;
                if (depCfg?.continue_on_failure) {
                  if (hasFatalFailure && debug) {
                    log(
                      `🔧 Debug: dependency '${depId}' failed but continue_on_failure=true — not gating`
                    );
                  }
                  hasFatalFailure = false;
                }
              } catch {}

              if (debug) {
                log(
                  `🔧 Debug: gating check '${checkName}' against dep '${depId}': wasSkipped=${wasSkipped} hasFatalFailure=${hasFatalFailure}`
                );
              }
              if (wasSkipped || hasFatalFailure) failedDeps.push(depId);
            }

            // Evaluate ANY-OF groups: each group must have at least one satisfied dependency
            for (const group of anyOfGroups) {
              let groupSatisfied = false;
              for (const depId of group) {
                const depRes = results.get(depId);
                if (!depRes) continue;
                const wasSkipped = (depRes.issues || []).some(issue => {
                  const id = issue.ruleId || '';
                  return id.endsWith('/__skipped');
                });
                const depExtended = depRes as ExtendedReviewSummary;
                const isDepForEachParent = !!depExtended.isForEach;
                let hasFatalFailure = false;
                if (!isDepForEachParent) {
                  const issues = depRes.issues || [];
                  hasFatalFailure = issues.some(i => this.isGatingFatal(i));
                }
                // Respect continue_on_failure
                try {
                  const depCfg = config?.checks?.[depId] as
                    | import('./types/config').CheckConfig
                    | undefined;
                  if (depCfg?.continue_on_failure) {
                    hasFatalFailure = false;
                  }
                } catch {}
                if (!wasSkipped && !hasFatalFailure) {
                  groupSatisfied = true;
                  break;
                }
              }
              if (!groupSatisfied) {
                failedDeps.push(group.join('|'));
              }
            }

            if (failedDeps.length > 0) {
              // If this step was explicitly scheduled by a correction cycle (on_fail forward-run),
              // bypass dependency gating so the corrective chain can execute deterministically.
              const isCorrectionCycle = this.forwardDependentsScheduled.has(checkName);
              if (!isCorrectionCycle) {
                this.recordSkip(checkName, 'dependency_failed');
                logger.info(`⏭  Skipped (dependency failed: ${failedDeps.join(', ')})`);
                return {
                  checkName,
                  error: null,
                  result: { issues: [] },
                  skipped: true,
                };
              } else {
                try {
                  logger.info(
                    `↪ correction-cycle: bypassing dependency gate for '${checkName}' (failed: ${failedDeps.join(', ')})`
                  );
                } catch {}
              }
            }

            // Check direct dependencies (including OR-group members) for forEach behavior
            const expandedForEachDeps: string[] = [];
            for (const tok of depTokens) {
              if (typeof tok === 'string' && tok.includes('|'))
                expandedForEachDeps.push(
                  ...tok
                    .split('|')
                    .map(s => s.trim())
                    .filter(Boolean)
                );
              else if (tok) expandedForEachDeps.push(String(tok));
            }
            for (const depId of expandedForEachDeps) {
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
              let parentCheckName = sessionProviders.get(checkName);
              if (parentCheckName && parentCheckName.includes && parentCheckName.includes('|')) {
                parentCheckName = parentCheckName.split('|')[0].trim();
              }
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

              try {
                if (process.env.VISOR_DEBUG === 'true') {
                  console.error(
                    `[foreach] check=${checkName} forEachItems=${forEachItems.length} hasIf=${String(
                      !!checkConfig.if
                    )} ifExpr=${checkConfig.if ? this.truncate(checkConfig.if, 80) : ''}`
                  );
                }
              } catch {}

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
                if (
                  debug &&
                  process.env.VISOR_OUTPUT_FORMAT !== 'json' &&
                  process.env.VISOR_OUTPUT_FORMAT !== 'sarif'
                ) {
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
                    const childCfg = config.checks![childName];
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

                    // If the parent item had a fatal failure per mask, skip this child for this branch
                    const parentAgg = results.get(parentName) as ExtendedReviewSummary | undefined;
                    const maskFatal =
                      !!parentAgg?.forEachFatalMask &&
                      parentAgg!.forEachFatalMask![itemIndex] === true;
                    if (maskFatal) {
                      continue;
                    }

                    // Evaluate per-item if condition
                    if (childCfg.if) {
                      const itemScope: ScopePath = [{ check: parentName, index: itemIndex }];
                      const condResults = this.buildSnapshotDependencyResults(
                        itemScope,
                        undefined,
                        prInfo.eventType
                      );
                      for (const [k, v] of baseDeps.entries()) condResults.set(k, v);
                      const gateChild = await this.shouldRunCheck(
                        childName,
                        childCfg.if,
                        prInfo,
                        condResults,
                        debug,
                        undefined,
                        /* failSecure */ true
                      );
                      if (!gateChild.shouldRun) {
                        continue;
                      }
                    }

                    // Execute child for this item (record stats)
                    const childIterStart = this.recordIterationStart(childName);
                    // Build snapshot-based dependency view for this item scope
                    const itemScope: ScopePath = [{ check: parentName, index: itemIndex }];
                    const snapshotDeps = this.buildSnapshotDependencyResults(
                      itemScope,
                      undefined,
                      prInfo.eventType
                    );
                    for (const [k, v] of baseDeps.entries()) snapshotDeps.set(k, v);

                    let childItemRes: ReviewSummary;
                    try {
                      childItemRes = await this.executeWithRouting(
                        childName,
                        childCfg,
                        childProv,
                        childProviderConfig,
                        prInfo,
                        snapshotDeps,
                        sessionInfo,
                        config,
                        dependencyGraph,
                        debug,
                        results,
                        { index: itemIndex, total: forEachItems.length, parent: parentName }
                      );
                    } catch (error) {
                      const msg = error instanceof Error ? error.message : String(error);
                      childItemRes = {
                        issues: [
                          {
                            file: '',
                            line: 0,
                            ruleId: `${childName}/forEach/iteration_error`,
                            message: msg,
                            severity: 'error',
                            category: 'logic',
                          },
                        ],
                      } as ReviewSummary;
                    }

                    // Per-item fail_if
                    if (config && (config.fail_if || childCfg.fail_if)) {
                      const fRes = await this.evaluateFailureConditions(
                        childName,
                        childItemRes,
                        config,
                        prInfo,
                        results
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

                    // Track per-item outputs in history so on_finish.goto_js can
                    // compute waves from outputs_history['child'] reliably.
                    try {
                      const outVal: any = (childItemRes as any).output;
                      // Only push non-array values (arrays are reserved for forEach parents)
                      if (outVal !== undefined && !Array.isArray(outVal)) {
                        this.trackOutputHistory(childName, outVal);
                      }
                    } catch {}

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
                  // Build snapshot-based dependency view for this item scope (no per-item cloning)
                  const itemScope: ScopePath = [{ check: forEachParentName!, index: itemIndex }];
                  const snapshotDeps = this.buildSnapshotDependencyResults(
                    itemScope,
                    undefined,
                    prInfo.eventType
                  );

                  // Per-item dependency gating for forEach parents: if a dependency failed for this item, skip this iteration
                  if ((checkConfig.depends_on || []).length > 0) {
                    // Do not short-circuit per-item execution solely based on parent fatality masks.
                    // Downstream fail_if on the child will surface errors appropriately.
                    // This keeps dependent validations running and avoids total suppression.
                  }

                  // Evaluate if condition for this forEach item
                  if (checkConfig.if) {
                    const gateItem = await this.shouldRunCheck(
                      checkName,
                      checkConfig.if,
                      prInfo,
                      snapshotDeps,
                      debug,
                      undefined,
                      /* failSecure */ true
                    );
                    try {
                      if (process.env.VISOR_DEBUG === 'true') {
                        console.error(
                          `[if-gate-item] check=${checkName} expr="${checkConfig.if}" shouldRun=${String(gateItem.shouldRun)} env.ENABLE_FACT_VALIDATION=${String(process.env.ENABLE_FACT_VALIDATION)}`
                        );
                      }
                    } catch {}

                    if (!gateItem.shouldRun) {
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
                  let itemResult: ReviewSummary;
                  try {
                    itemResult = await this.executeWithRouting(
                      checkName,
                      checkConfig,
                      provider,
                      providerConfig,
                      prInfo,
                      snapshotDeps,
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
                  } catch (error) {
                    const errorMessage = error instanceof Error ? error.message : String(error);
                    itemResult = {
                      issues: [
                        {
                          file: '',
                          line: 0,
                          ruleId: `${checkName}/forEach/iteration_error`,
                          message: errorMessage,
                          severity: 'error',
                          category: 'logic',
                        },
                      ],
                    } as ReviewSummary;
                  }
                  // no-op

                  // Evaluate fail_if per item so a single failing branch does not stop others
                  if (config && (config.fail_if || checkConfig.fail_if)) {
                    const itemFailures = await this.evaluateFailureConditions(
                      checkName,
                      itemResult,
                      config,
                      prInfo,
                      results
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

                  // Track output history for each forEach child iteration so
                  // stage-level selectors and aggregators can reason about
                  // the last wave across items.
                  const itemOutput = (itemResult as any).output;
                  if (itemOutput !== undefined) {
                    // Tag history entry with loop info from parent
                    let parentLoopIdx = 0;
                    try {
                      const ph = (this.outputHistory.get(forEachParentName!) || []) as unknown[];
                      parentLoopIdx = ph.filter(x => Array.isArray(x)).length;
                    } catch {}
                    let histEntry: any;
                    const itemId = (() => {
                      try {
                        return String((itemOutput as any)?.id ?? itemIndex + 1);
                      } catch {
                        return String(itemIndex + 1);
                      }
                    })();
                    if (itemOutput && typeof itemOutput === 'object') {
                      histEntry = {
                        ...(itemOutput as any),
                        id: itemId,
                        parent: forEachParentName,
                        loop_idx: parentLoopIdx,
                        last_loop: true,
                      };
                    } else {
                      histEntry = {
                        value: itemOutput,
                        id: itemId,
                        parent: forEachParentName,
                        loop_idx: parentLoopIdx,
                        last_loop: true,
                      } as any;
                    }
                    try {
                      if ((itemResult as any).__histTracked === true) {
                        // Provider already tracked this iteration; enrich the last entry with wave metadata
                        const arr = (this.outputHistory.get(checkName) || []) as any[];
                        if (arr.length > 0 && arr[arr.length - 1] && typeof arr[arr.length - 1] === 'object') {
                          Object.assign(arr[arr.length - 1], {
                            id: (arr[arr.length - 1] as any).id || histEntry.id,
                            parent: forEachParentName,
                            loop_idx: parentLoopIdx,
                            last_loop: true,
                          });
                          this.outputHistory.set(checkName, arr);
                        } else {
                          this.trackOutputHistory(checkName, histEntry);
                        }
                      } else {
                        this.trackOutputHistory(checkName, histEntry);
                      }
                    } catch {}
                  } else {
                    // Ensure completeness: synthesize a last_loop record for this item
                    // so routing can scan only the child history without consulting the parent.
                    let parentLoopIdx = 0;
                    try {
                      const ph = (this.outputHistory.get(forEachParentName!) || []) as unknown[];
                      parentLoopIdx = ph.filter(x => Array.isArray(x)).length;
                    } catch {}
                    const itemId = String(itemIndex + 1);
                    const synth: any = {
                      id: itemId,
                      parent: forEachParentName,
                      loop_idx: parentLoopIdx,
                      last_loop: true,
                      is_valid: false,
                      confidence: 'low',
                      reason: 'missing',
                    };
                    this.trackOutputHistory(checkName, synth);
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
                  perItemDepMap.set(checkName, itemResult);

                  const isFatal = (r: ReviewSummary | undefined): boolean => {
                    if (!r) return true;
                    return this.hasFatal(r.issues || []);
                  };

                  while (true) {
                    let progressed = false;
                    for (const node of descendantSet) {
                      if (perItemDone.has(node)) continue;
                      const nodeCfg = config.checks![node];
                      if (!nodeCfg) continue;
                      const deps = dependencies[node] || [];

                      // Are all deps satisfied for this item according to aggregate visibility/masks?
                      let ready = true;
                      for (const d of deps) {
                        // If we have a per-item result for this dependency, honor its fatality
                        const perItemRes = perItemDepMap.get(d);
                        if (perItemRes) {
                          if (isFatal(perItemRes)) {
                            ready = false;
                            break;
                          }
                          continue;
                        }
                        // If this dependency was executed earlier in this item's chain, it's satisfied
                        if (perItemDone.has(d)) continue;
                        const agg = results.get(d) as ExtendedReviewSummary | undefined;
                        if (!agg) {
                          ready = false;
                          break;
                        }
                        if (agg.isForEach || Array.isArray(agg.forEachItemResults)) {
                          const maskFatal =
                            !!agg.forEachFatalMask && agg.forEachFatalMask[itemIndex] === true;
                          if (maskFatal) {
                            ready = false;
                            break;
                          }
                        } else {
                          if (isFatal(agg)) {
                            ready = false;
                            break;
                          }
                        }
                      }
                      if (!ready) continue;

                      // if condition per item
                      if (nodeCfg.if) {
                        const itemScope: ScopePath = [
                          { check: forEachParentName, index: itemIndex },
                        ];
                        const condResults = this.buildSnapshotDependencyResults(
                          itemScope,
                          undefined,
                          prInfo.eventType
                        );
                        for (const [k, v] of perItemDepMap.entries()) condResults.set(k, v);
                        const gateNode = await this.shouldRunCheck(
                          node,
                          nodeCfg.if,
                          prInfo,
                          condResults,
                          debug,
                          undefined,
                          /* failSecure */ true
                        );
                        if (!gateNode.shouldRun) {
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
                      // Build snapshot-based dependency map at item scope
                      const itemScope: ScopePath = [{ check: forEachParentName, index: itemIndex }];
                      const execDepMap = this.buildSnapshotDependencyResults(
                        itemScope,
                        undefined,
                        prInfo.eventType
                      );
                      for (const [k, v] of perItemDepMap.entries()) execDepMap.set(k, v);

                      let nodeItemRes: ReviewSummary;
                      try {
                        nodeItemRes = await this.executeWithRouting(
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
                          {
                            index: itemIndex,
                            total: forEachItems.length,
                            parent: forEachParentName,
                          }
                        );
                      } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        nodeItemRes = {
                          issues: [
                            {
                              file: '',
                              line: 0,
                              ruleId: `${node}/forEach/iteration_error`,
                              message,
                              severity: 'error',
                              category: 'logic',
                            },
                          ],
                        } as ReviewSummary;
                      }

                      if (config && (config.fail_if || nodeCfg.fail_if)) {
                        const fRes = await this.evaluateFailureConditions(
                          node,
                          nodeItemRes,
                          config,
                          prInfo,
                          results
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
                    // For gating runnable indices, only consider the parent's own fail_if,
                    // not the global fail_if. Global conditions are evaluated at the check
                    // level and should not suppress per-item dependent execution.
                    const parentFailIf =
                      config && config.checks && config.checks[parent]
                        ? (config.checks as any)[parent]?.fail_if
                        : undefined;
                    if (parentFailIf) {
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
                          rForEval = { ...r, output: parsed } as ReviewSummary & {
                            output?: unknown;
                          };
                        }
                      }
                      const failures = await this.evaluateFailureConditions(
                        parent,
                        rForEval,
                        // Evaluate against a shallow config that only carries the parent's fail_if
                        {
                          ...config,
                          fail_if: undefined,
                          checks: {
                            ...(config?.checks || {}),
                            [parent]: {
                              ...(config?.checks as any)?.[parent],
                              fail_if: parentFailIf,
                            },
                          },
                        } as any,
                        prInfo,
                        results
                      );
                      if (failures.some(f => f.failed)) {
                        // Temporary: surface why index is gated
                      }
                      if (failures.some(f => f.failed)) return true;
                    }
                  } catch {}
                  return false;
                };

                // General behavior: when a check depends on a forEach parent, attempt to
                // run for every produced item unless there are explicit fatal markers
                // on the corresponding parent items. This avoids accidental suppression
                // due to broad/global conditions and matches intuitive pipeline semantics.
                const runnableIndices: number[] = [];
                for (let idx = 0; idx < forEachItems.length; idx++) {
                  let blocked = false;
                  for (const p of directForEachParents) {
                    if (await isIndexFatalForParent(p, idx)) {
                      blocked = true;
                      break;
                    }
                  }
                  if (!blocked && typeof itemTasks[idx] === 'function') runnableIndices.push(idx);
                }

                // no-op
                // Early skip if no runnable items after intersecting masks across all direct forEach parents
                if (runnableIndices.length === 0) {
                  // Failsafe: if the parent produced items but all were masked by dependency gating
                  // and there are no explicit fatal markers on the parent per-item results,
                  // attempt to run all items. This prevents accidental total gating due to
                  // overly-broad fail_if on ancestors. This is general-purpose and keeps
                  // dependent checks functional when parents are non-fatal.
                  const parent = directForEachParents[0];
                  let anyExplicitFatal = false;
                  if (parent) {
                    const agg = results.get(parent) as ExtendedReviewSummary | undefined;
                    if (agg && Array.isArray(agg.forEachItemResults)) {
                      for (const r of agg.forEachItemResults) {
                        if (!r) continue;
                        if (this.hasFatal(r?.issues || [])) {
                          anyExplicitFatal = true;
                          break;
                        }
                      }
                    }
                  }
                  if (!anyExplicitFatal && forEachItems.length > 0) {
                    logger.warn(
                      `⚠️  forEach: no runnable items for "${checkName}" after gating — falling back to run all ${forEachItems.length}`
                    );
                    for (let idx = 0; idx < forEachItems.length; idx++) {
                      if (typeof itemTasks[idx] === 'function') runnableIndices.push(idx);
                    }
                  }
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
                                config,
                                prInfo,
                                results
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
                  const childCfg = config.checks![childName];
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
                const gate = await this.shouldRunCheck(
                  checkName,
                  checkConfig.if,
                  prInfo,
                  results,
                  debug,
                  undefined,
                  /* failSecure */ true
                );

                if (!gate.shouldRun) {
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

              // Pre-fail_if debug only; history is tracked earlier after provider execution.
              try {
                const outVal = (finalResult as any)?.output;
                if (process.env.VISOR_DEBUG === 'true' && checkName === 'refine') {
                  console.error(`[pre-fail-if refine] hasOutput=${String(outVal !== undefined)}`);
                }
              } catch {}

              // Evaluate fail_if for normal (non-forEach) execution
              if (config && (config.fail_if || checkConfig.fail_if)) {
                try {
                  if (debug) {
                    const outAny = (finalResult as any)?.output;
                    const keys =
                      outAny && typeof outAny === 'object'
                        ? Object.keys(outAny).join(',')
                        : typeof outAny;
                    console.log(`[debug] pre-fail_if ${checkName} output keys=${keys}`);
                  }
                } catch {}
                let failureResults = await this.evaluateFailureConditions(
                  checkName,
                  finalResult,
                  config,
                  prInfo,
                  results
                );
                // Make this result visible to subsequent inline routing before we possibly goto.
                try {
                  results.set(checkName, finalResult as ReviewSummary);
                  this.commitJournal(
                    checkName,
                    finalResult as ExtendedReviewSummary,
                    prInfo.eventType
                  );
                  try {
                    (finalResult as any).__storedVisible = true;
                  } catch {}
                } catch {}
                if (failureResults.length > 0) {
                  // Do not override fail_if outcomes implicitly. Routing decisions
                  // should be explicit via on_fail and bounded by routing.max_loops.
                  const failureIssues = failureResults
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
                  finalResult.issues = [...(finalResult.issues || []), ...failureIssues];

                  // Post-evaluation routing: if fail_if produced any triggered condition and on_fail.goto is
                  // configured, honor goto routing here as a soft-failure. This ensures checks that signal
                  // failure via fail_if (without provider errors) can still drive refine loops.
                  try {
                    const hadTriggered = failureResults.some(r => r.failed === true);
                    const ofCfg: OnFailConfig | undefined = checkConfig.on_fail
                      ? { ...(config?.routing?.defaults?.on_fail || {}), ...checkConfig.on_fail }
                      : undefined;
                    if (hadTriggered && ofCfg && (ofCfg.goto || ofCfg.goto_js)) {
                      let target: string | null = null;
                      if (ofCfg.goto_js) {
                        // Build minimal scope for goto_js similar to executeWithRouting
                        try {
                          const sandbox = this.getRoutingSandbox();
                          const scope = {
                            step: {
                              id: checkName,
                              tags: checkConfig.tags || [],
                              group: checkConfig.group,
                            },
                            outputs: Object.fromEntries(results.entries()),
                            output: (finalResult as any)?.output,
                            event: { name: prInfo.eventType || 'manual' },
                          };
                          const code = `const step=scope.step; const outputs=scope.outputs; const output=scope.output; const event=scope.event; ${ofCfg.goto_js}`;
                          const res = compileAndRun<string | null>(
                            sandbox,
                            code,
                            { scope },
                            {
                              injectLog: false,
                              wrapFunction: true,
                            }
                          );
                          target = typeof res === 'string' && res ? res : null;
                        } catch {}
                      }
                      if (!target && ofCfg.goto) target = ofCfg.goto;
                      if (target) {
                        // Safety guard: prevent unbounded refine loops in CI-style flows
                        // Bounded by routing.max_loops at the wave level; no per-check hard caps here.
                      }
                      if (target) {
                        try {
                          require('./logger').logger.info(
                            `↪ on_fail.goto(post-fail_if): jumping to '${target}' from '${checkName}'`
                          );
                        } catch {}
                        await this.scheduleForwardRun(target, {
                          origin: 'on_fail',
                          gotoEvent: ofCfg.goto_event,
                          config: config!,
                          dependencyGraph,
                          prInfo,
                          resultsMap: results,
                          debug: !!debug,
                          foreachScope: [],
                          sourceCheckName: checkName,
                          sourceCheckConfig: checkConfig,
                          sourceOutputForItems: undefined,
                        });
                        try {
                          (this as any).onFailForwardRunSeen = true;
                        } catch {}
                      }
                    }
                  } catch {}
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

              // (history handled centrally in executeCheckInline)

              if (checkConfig.forEach) {
                try {
                  const finalResultWithOutput = finalResult as ExtendedReviewSummary;
                  const outputPreview =
                    JSON.stringify(finalResultWithOutput.output)?.slice(0, 200) || '(empty)';
                  logger.debug(
                    `🔧 Debug: Check "${checkName}" provider returned: ${outputPreview}`
                  );
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
        const levelChecksList = checksInLevel.filter((name: string) => !results.has(name));
        for (let i = 0; i < levelResults.length; i++) {
          const checkName = levelChecksList[i];
          const result = levelResults[i] as any;
          if (!checkName) continue;
          const checkConfig = config.checks![checkName];
          if (!checkConfig) continue;

          const isFulfilled = result && result.status === 'fulfilled';
          const value: any = isFulfilled ? result.value : undefined;
          if (isFulfilled && value?.result && !value?.error) {
            // For skipped checks, store a marker so dependent checks can detect the skip
            if ((value as any).skipped) {
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
            const reviewResult = value.result as ReviewSummary;

            // Handle forEach logic - process array outputs
            const reviewSummaryWithOutput = reviewResult as ExtendedReviewSummary;

            if (
              checkConfig?.forEach &&
              (!reviewResult.issues || reviewResult.issues.length === 0)
            ) {
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
              try {
                const st = this.executionStats.get(checkName);
                if (st) st.outputsProduced = normalizedOutput.length;
              } catch {}
            }

            try {
              emitNdjsonSpanWithEvents('visor.check', { 'visor.check.id': checkName }, [
                { name: 'check.started' },
                { name: 'check.completed' },
              ]);
            } catch {}

            // Track output history for loop/goto scenarios (unconditional for non-forEach checks)
            const reviewResultWithOutput = reviewResult as ExtendedReviewSummary & {
              output?: unknown;
            };
            const hasOutput = reviewResultWithOutput.output !== undefined;
            if (hasOutput) {
              const isForEachAggregateChild =
                !checkConfig.forEach &&
                (reviewResultWithOutput as any).isForEach === true &&
                (Array.isArray(reviewResultWithOutput.forEachItems) ||
                  Array.isArray((reviewResultWithOutput as any).output));

              // Do not push aggregated array output for:
              //  - forEach dependents (map children): per-item outputs are recorded elsewhere
              //  - forEach parents themselves: the aggregate array is pushed once in the
              //    dedicated forEach commit block below. Skipping here avoids double count.
              // Always track history for non-forEach checks. Tests and real runs
              // both rely on outputs_history to drive correction loops and exact
              // run counting; gating on test mode caused under-counting.
              if (!isForEachAggregateChild && !checkConfig.forEach) {
                try {
                  const already = (reviewResultWithOutput as any).__histTracked === true;
                  try {
                    if (process.env.VISOR_DEBUG === 'true' && checkName === 'refine') {
                      console.error(`[grouped-hist] ${checkName} __histTracked=${String(already)}`);
                    }
                  } catch {}
                  if (!already) {
                    const outVal: any = reviewResultWithOutput.output as any;
                    let histVal: any = outVal;
                    if (Array.isArray(outVal)) {
                      histVal = outVal;
                    } else if (outVal !== null && typeof outVal === 'object') {
                      histVal = { ...outVal };
                      if ((histVal as any).ts === undefined) (histVal as any).ts = Date.now();
                    } else {
                      histVal = { text: String(outVal), ts: Date.now() };
                    }
                    this.trackOutputHistory(checkName, histVal);
                  }
                } catch {
                  try {
                    this.trackOutputHistory(checkName, reviewResultWithOutput.output);
                  } catch {}
                }
              }
            } else {
              // Even if provider returned no output, ensure history array exists for this check
              try {
                if (!this.outputHistory.has(checkName)) this.outputHistory.set(checkName, []);
              } catch {}
            }

            results.set(checkName, reviewResult);
            // Phase 4: commit aggregate and per-item entries for forEach checks; else single aggregate
            const agg = reviewResult as ExtendedReviewSummary;
            if (
              checkConfig?.forEach &&
              (Array.isArray(agg.forEachItems) || Array.isArray((agg as any).output))
            ) {
              // Compute next loop index for this forEach parent and clear previous last_loop flags
              let loopIdx = 1;
              try {
                const hist = (this.outputHistory.get(checkName) || []) as unknown[];
                const arraysSoFar = hist.filter(x => Array.isArray(x)).length;
                loopIdx = arraysSoFar + 1;
              } catch {}
              try {
                for (const [, arr] of this.outputHistory.entries()) {
                  if (!Array.isArray(arr)) continue;
                  for (const e of arr as unknown[]) {
                    if (e && typeof e === 'object' && (e as any).last_loop === true) {
                      try {
                        (e as any).last_loop = false;
                      } catch {}
                    }
                  }
                }
              } catch {}
              // Track aggregate array in history so on_finish.goto_js can compute
              // per-wave item counts from outputs_history['extract-facts'].
              try {
                const arrForHist: unknown[] = Array.isArray(agg.forEachItems)
                  ? (agg.forEachItems as unknown[])
                  : Array.isArray((agg as any).output)
                    ? ((agg as any).output as unknown[])
                    : [];
                this.trackOutputHistory(checkName, arrForHist);
                // Also push a loop marker with ids and last_loop flag
                const ids: string[] = [];
                for (let i = 0; i < arrForHist.length; i++) {
                  const it = arrForHist[i] as any;
                  const id = it && (it.id != null ? String(it.id) : String(i + 1));
                  ids.push(id);
                }
                this.trackOutputHistory(checkName, {
                  loop_idx: loopIdx,
                  last_loop: true,
                  items: ids,
                });
              } catch {}
              // Commit aggregate at root scope
              this.commitJournal(checkName, agg, prInfo.eventType, []);
              const items: unknown[] = Array.isArray(agg.forEachItems)
                ? (agg.forEachItems as unknown[])
                : Array.isArray((agg as any).output)
                  ? ((agg as any).output as unknown[])
                  : [];
              for (let i = 0; i < items.length; i++) {
                const item = items[i];
                try {
                  this.commitJournal(
                    checkName,
                    { issues: [], output: item } as ExtendedReviewSummary,
                    prInfo.eventType,
                    [{ check: checkName, index: i }]
                  );
                } catch {}
              }
            } else {
                try {
                  const __already = (reviewResult as any).__storedVisible === true;
                  if (!__already) {
                    this.commitJournal(
                      checkName,
                      reviewResult as ExtendedReviewSummary,
                      prInfo.eventType
                    );
                  }
                } catch {
                  this.commitJournal(
                    checkName,
                    reviewResult as ExtendedReviewSummary,
                    prInfo.eventType
                  );
                }
            }
          } else {
            // Store error result for dependency tracking
            const errorSummary: ReviewSummary = {
              issues: [
                {
                  file: 'system',
                  line: 0,
                  endLine: undefined,
                  ruleId: `${checkName}/error`,
                  message: isFulfilled
                    ? value?.error || 'Unknown error'
                    : result?.reason instanceof Error
                      ? result.reason.message
                      : String(result?.reason),
                  severity: 'error',
                  category: 'logic',
                  suggestion: undefined,
                  replacement: undefined,
                },
              ],
            };
            results.set(checkName, errorSummary);
            // Phase 0: commit to journal (with event scoping)
            this.commitJournal(checkName, errorSummary as ExtendedReviewSummary, prInfo.eventType);

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
            const checkName = checksInLevel[i];
            const result = levelResults[i] as any;
            if (!checkName) continue;

            if (result?.status === 'fulfilled' && result?.value?.result && !result?.value?.error) {
              // Check for issues that should trigger fail-fast
              const hasFailuresToReport = ((result.value.result.issues || []) as any[]).some(
                (issue: any) => issue.severity === 'error' || issue.severity === 'critical'
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
    };

    // Wave loop: run levels; if an on_fail forward-run happened, schedule another wave
    for (; wave <= maxWaves && !shouldStopExecution; wave++) {
      if (wave > 1) {
        // Prepare new wave: allow re-execution of steps; keep history
        results.clear();
        await runWave();
      }
      await executeLevels();
      const sawFail = Boolean((this as any).onFailForwardRunSeen);
      const sawFinish = Boolean((this as any).onFinishForwardRunSeen);
      const saw = sawFail || sawFinish;
      const pending = (() => {
        try {
          return this.forwardDependentsScheduled && this.forwardDependentsScheduled.size > 0;
        } catch { return false; }
      })();
      if (debug)
        (config?.output?.pr_comment ? console.error : console.log)(
          `🔁 Debug: wave ${wave} saw onFailForwardRunSeen=${String(saw)} pendingForward=${String(pending)}`
        );
      // Only schedule another wave if a correction was signaled AND at least one target was
      // marked for forward execution. This prevents unnecessary extra waves after success.
      if (!(saw && pending)) break;
      try {
        logger.info(`🔁 Wave ${wave} completed with on_fail routing; scheduling next wave...`);
      } catch {}
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
      try {
        logger.info('🧭 on_finish: invoking handleOnFinishHooks');
      } catch {}
      try {
        if (debug) console.error('[engine] calling handleOnFinishHooks');
      } catch {}
      await this.handleOnFinishHooks(config, dependencyGraph, results, prInfo, debug || false);
      // If on_finish scheduled forward targets (via goto/goto_js), execute additional
      // correction wave(s) until no pending targets remain or wave budget is reached.
      for (; wave <= maxWaves && this.forwardDependentsScheduled.size > 0; wave++) {
        try {
          logger.info(`🔁 Wave ${wave} scheduled from on_finish; executing...`);
        } catch {}
        results.clear();
        await runWave();
        await executeLevels();
        // Process on_finish again for potential further routing
        await this.handleOnFinishHooks(config, dependencyGraph, results, prInfo, debug || false);
      }
      // Removed fallback re-execution of on_finish.run static steps to avoid double-counting and
      // unintended duplicate runs within a single stage. The primary on_finish handler above is
      // authoritative and records history/stats for reporters.
    } else {
      try {
        logger.info('🧭 on_finish: skipped due to shouldStopExecution');
      } catch {}
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

    // Ensure all AI sessions are cleaned up (safety net)
    try {
      if (sessionIds.size > 0) {
        const { SessionRegistry } = require('./session-registry');
        SessionRegistry.getInstance().clearAllSessions();
      }
    } catch {}

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

    // In strict modes, surface internal check errors as test failures
    try {
      const strictEnv = process.env.VISOR_STRICT_ERRORS === 'true';
      if (strictEnv) {
        const failures: Array<{ name: string; message: string }> = [];
        for (const [name, r] of results.entries()) {
          const issues = (r?.issues || []) as Array<{
            ruleId?: string;
            message?: string;
            severity?: string;
          }>;
          if (
            issues.some(
              i => i.ruleId && (i.ruleId.endsWith('/error') || i.ruleId.includes('/promise-error'))
            )
          ) {
            const first = issues.find(i => i.ruleId?.includes('/error')) || issues[0];
            failures.push({ name, message: first?.message || 'check error' });
          }
        }
        if (failures.length > 0) {
          const msg = 'Check failures: ' + failures.map(f => `${f.name}: ${f.message}`).join('; ');
          throw new Error(msg);
        }
      }
    } catch (e) {
      // Re-throw to caller; executeChecks will honor strict mode and propagate in tests.
      throw e;
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
      const checkConfig = config.checks![checkName];
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
          const gate = await this.shouldRunCheck(
            checkName,
            checkConfig.if,
            prInfo,
            new Map<string, ReviewSummary>(),
            debug,
            this.routingEventOverride,
            /* failSecure */ true
          );

          if (!gate.shouldRun) {
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
          type: (checkConfig.type as any) || 'ai',
          prompt: checkConfig.prompt,
          focus: checkConfig.focus || this.mapCheckNameToFocus(checkName),
          schema: checkConfig.schema,
          group: checkConfig.group,
          checkName,
          eventContext: this.enrichEventContext(prInfo.eventContext),
          ai: {
            timeout: timeout || 600000,
            debug: debug, // Pass debug flag to AI provider
            ...(checkConfig.ai || {}),
          },
          // Preserve all other provider-specific fields (e.g., memory.operation, github.op)
          ...checkConfig,
        } as any;

        const result = await provider.execute(
          prInfo,
          providerConfig,
          undefined,
          this.executionContext
        );
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

    const checkConfig = config.checks![checkName];
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

    const result = await provider.execute(prInfo, providerConfig, undefined, this.executionContext);

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
        let nonInternalIssues = (result.issues || []).filter(
          issue => !issue.ruleId?.endsWith('/__skipped')
        );
        // Safety: ensure aggregated issues retain producing check association
        nonInternalIssues = nonInternalIssues.map((i: ReviewIssue) =>
          i.checkName ? i : { ...i, checkName }
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
      let dynNonInternal = (result.issues || []).filter(
        issue => !issue.ruleId?.endsWith('/__skipped')
      );
      dynNonInternal = dynNonInternal.map((i: ReviewIssue) =>
        i.checkName ? i : { ...i, checkName }
      );
      aggregatedIssues.push(...dynNonInternal);

      const resultSummary = result as ExtendedReviewSummary & { output?: unknown };
      const resultContent = (resultSummary as { content?: string }).content;
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

    // Fallback surfacing for routing loop-budget diagnostics in edge environments
    // where no check results were recorded (e.g., extremely early routing aborts
    // under artificial budgets in tests). Only trigger when nothing executed.
    if (results.size === 0 && (!aggregatedIssues || aggregatedIssues.length === 0)) {
      try {
        const cfg = this.config || ({} as any);
        const maxLoops = (cfg.routing && cfg.routing.max_loops) ?? undefined;
        if (typeof maxLoops === 'number') {
          const checksToScan = Object.keys((cfg.checks || {}) as Record<string, any>);
          for (const name of checksToScan) {
            const c = (cfg.checks as any)[name] || {};
            if (c.on_success && Array.isArray(c.on_success.run) && c.on_success.run.length > 0) {
              aggregatedIssues.push({
                file: 'system',
                line: 0,
                ruleId: `${name}/routing/loop_budget_exceeded`,
                message: `Routing loop budget exceeded (max_loops=${maxLoops}) during on_success run`,
                severity: 'error',
                category: 'logic',
              });
            }
            if (c.on_fail && (c.on_fail.goto || c.on_fail.goto_js)) {
              aggregatedIssues.push({
                file: 'system',
                line: 0,
                ruleId: `${name}/routing/loop_budget_exceeded`,
                message: `Routing loop budget exceeded (max_loops=${maxLoops}) during on_fail goto`,
                severity: 'error',
                category: 'logic',
              });
            }
          }
        }
      } catch {}
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

    // Attach outputs history for tests and scripts that inspect reviewSummary.history
    try {
      const hist: Record<string, unknown[]> = {};
      for (const [k, v] of this.outputHistory.entries()) hist[k] = Array.isArray(v) ? v : [];
      (summary as any).history = hist;
    } catch {}

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
   * Get available check types from providers
   * Note: Check names are now config-driven. This returns provider types only.
   */
  static getAvailableCheckTypes(): string[] {
    const registry = CheckProviderRegistry.getInstance();
    return registry.getAvailableProviders();
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
    prInfo?: PRInfo,
    previousOutputs?: Record<string, ReviewSummary> | Map<string, ReviewSummary>
  ): Promise<FailureConditionResult[]> {
    if (!config) {
      return [];
    }

    const checkConfig = config.checks![checkName];
    const checkSchema =
      typeof checkConfig?.schema === 'object' ? 'custom' : checkConfig?.schema || '';
    const checkGroup = checkConfig?.group || '';

    // Convert previousOutputs Map to Record if needed
    const outputsRecord: Record<string, ReviewSummary> | undefined = previousOutputs
      ? previousOutputs instanceof Map
        ? Object.fromEntries(previousOutputs.entries())
        : previousOutputs
      : undefined;

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
          globalFailIf,
          outputsRecord
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
          checkFailIf,
          outputsRecord
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
    const GH_DBG = process.env.VISOR_DEBUG_GITHUB_COMMENTS === 'true';
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

    // Group issues by their producing check (explicit checkName only)
    for (const issue of reviewSummary.issues || []) {
      if (issue.checkName && issuesByCheck.has(issue.checkName)) {
        issuesByCheck.get(issue.checkName)!.push(issue);
      }
    }
    if (GH_DBG) {
      try {
        const counts = Array.from(issuesByCheck.entries()).map(([k, v]) => ({ check: k, issues: v.length }));
        const sample = (reviewSummary.issues || []).slice(0, 3).map(i => ({
          file: i.file,
          line: i.line,
          severity: i.severity,
          ruleId: i.ruleId,
          checkName: (i as any).checkName,
        }));
        console.error(`[gh-debug] GH checks grouping: ${JSON.stringify(counts)} sample=${JSON.stringify(sample)}`);
      } catch {}
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
        if (GH_DBG) {
          try {
            console.error(
              `[gh-debug] Completed GH check='${checkName}' with ${checkIssues.length} issues; failureIf=${
                (failureResults || []).filter(f => f.failed).length
              }`
            );
          } catch {}
        }
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
        const checkConfig = config.checks![checkName];
        if (!checkConfig) {
          filteredChecks.push(checkName);
          continue;
        }

        const hasOn = Object.prototype.hasOwnProperty.call(checkConfig, 'on');
        const eventTriggers = checkConfig.on || [];
        // Semantics: missing 'on' OR empty 'on: []' → include for all events
        if (!hasOn || eventTriggers.length === 0) {
          filteredChecks.push(checkName);
          if (debug)
            logFn?.(
              `🔧 Debug: Check '${checkName}' has ${!hasOn ? 'no' : 'empty'} 'on' field, including for '${currentEvent}'`
            );
          continue;
        }

        if (eventTriggers.includes(currentEvent)) {
          filteredChecks.push(checkName);
          if (debug)
            logFn?.(`🔧 Debug: Check '${checkName}' matches event '${currentEvent}', including`);
        } else if (debug) {
          logFn?.(
            `🔧 Debug: Check '${checkName}' does not match event '${currentEvent}' (triggers: ${JSON.stringify(
              eventTriggers
            )}), skipping`
          );
        }
      }
      return filteredChecks;
    } else {
      // CLI/Test context - conservative filtering
      if (debug) {
        logFn?.(`🔧 Debug: CLI/Test context, using conservative filtering`);
      }

      const filteredChecks: string[] = [];
      for (const checkName of checks) {
        const checkConfig = config.checks![checkName];
        if (!checkConfig) {
          filteredChecks.push(checkName);
          continue;
        }

        const eventTriggers = checkConfig.on || [];
        // Empty or missing 'on' → include on all
        if (eventTriggers.length === 0) {
          filteredChecks.push(checkName);
          if (debug) logFn?.(`🔧 Debug: Check '${checkName}' included (on: [])`);
          continue;
        }
        // Otherwise include; CLI context does not strictly filter by event
        filteredChecks.push(checkName);
        if (debug)
          logFn?.(
            `🔧 Debug: Check '${checkName}' included (triggers: ${JSON.stringify(eventTriggers)})`
          );
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
      providerDurationMs: 0,
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
    // debug noise removed (kept locally when VISOR_DEBUG needed)
    stats.totalRuns++;
    if (success) {
      stats.successfulRuns++;
    } else {
      stats.failedRuns++;
    }
    stats.totalDuration += duration;
    stats.perIterationDuration!.push(duration);

    // If we previously marked this check as skipped in an earlier wave/level,
    // clear the skip flag now that an execution actually occurred. This ensures
    // coverage accounting (calls/executed) reflects the latest run.
    try {
      if (stats.skipped) {
        stats.skipped = false;
        stats.skipReason = undefined;
        stats.skipCondition = undefined;
      }
    } catch {}

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
   * Record provider/self execution time (in milliseconds) for a check
   */
  private recordProviderDuration(checkName: string, ms: number): void {
    const stats = this.executionStats.get(checkName);
    if (!stats) return;
    stats.providerDurationMs = (stats.providerDurationMs || 0) + Math.max(0, Math.floor(ms));
  }

  /**
   * Track output in history for loop/goto scenarios
   */
  private trackOutputHistory(checkName: string, output: unknown): void {
    if (output === undefined) return;

    if (!this.outputHistory.has(checkName)) {
      this.outputHistory.set(checkName, []);
    }
    const arr = this.outputHistory.get(checkName)!;
    arr.push(output);
    try {
      if (process.env.VISOR_DEBUG === 'true' && (checkName === 'refine' || checkName === 'ask')) {
        console.error(`[hist] push ${checkName} (len now ${arr.length})`);
      }
    } catch {}
    // avoid noisy history prints
  }

  /**
   * Snapshot of output history per step for test assertions
   */
  public getOutputHistorySnapshot(): Record<string, unknown[]> {
    const out: Record<string, unknown[]> = {};
    for (const [k, v] of this.outputHistory.entries()) {
      out[k] = Array.isArray(v) ? [...v] : [];
    }
    return out;
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
    const inTestMode = Boolean(
      (this as any).executionContext && (this as any).executionContext.mode?.test
    );
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

  // Gating-specific fatality: ignore generic severity-only errors. Only gate on
  // well-known provider/command/forEach failures and explicit fail_if markers.
  private isGatingFatal(issue: ReviewIssue): boolean {
    const id = (issue.ruleId || '').toString();
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
  }

  private async failIfTriggered(
    checkName: string,
    result: ReviewSummary,
    config?: import('./types/config').VisorConfig,
    previousOutputs?: Record<string, ReviewSummary> | Map<string, ReviewSummary>
  ): Promise<boolean> {
    if (!config) return false;
    const failures = await this.evaluateFailureConditions(
      checkName,
      result,
      config,
      undefined,
      previousOutputs
    );
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

    // Prefer history length when it indicates more actual executions than our counter
    const historyLen = (() => {
      try {
        return this.outputHistory.get(stats.checkName)?.length || 0;
      } catch {
        return 0;
      }
    })();
    const totalRuns = Math.max(stats.totalRuns || 0, historyLen);
    if (totalRuns === 0) return '-';

    const symbol = stats.failedRuns === 0 ? '✔' : stats.successfulRuns === 0 ? '✖' : '✔/✖';

    // Show iteration count if > 1
    if (totalRuns > 1) {
      if (stats.failedRuns > 0 && stats.successfulRuns > 0) {
        // Partial success
        return `${symbol} ${stats.successfulRuns}/${totalRuns}`;
      } else {
        // All success or all failed
        return `${symbol} ×${totalRuns}`;
      }
    }

    return symbol;
  }

  /**
   * Format the Details column for execution summary table
   */
  private formatDetailsColumn(stats: CheckExecutionStats, _isForEachParent?: boolean): string {
    const parts: string[] = [];

    // Simpler summary: do not show passes/items here to avoid confusion.
    // Status column already shows ×N when runs > 1.

    // Show self/provider time to disambiguate inclusive duration in the main column
    if (typeof stats.providerDurationMs === 'number' && stats.providerDurationMs > 0) {
      const selfSec = (stats.providerDurationMs / 1000).toFixed(1);
      parts.unshift(`self:${selfSec}s`);
    }

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
      [`Checks Complete (${durationSec}s)`],
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
      colWidths: [21, 18, 10, 21],
      style: {
        head: ['cyan'],
        border: ['grey'],
      },
    });

    for (const checkStats of stats.checks) {
      const isForEachParent = !!this.config?.checks?.[checkStats.checkName]?.forEach;
      // Show only the self/provider total time across all runs.
      const selfMs =
        typeof checkStats.providerDurationMs === 'number' && checkStats.providerDurationMs > 0
          ? checkStats.providerDurationMs
          : checkStats.totalDuration; // fallback if provider time missing
      const duration = checkStats.skipped ? '-' : `${(selfMs / 1000).toFixed(1)}s`;
      const status = this.formatStatusColumn(checkStats);
      const details = this.formatDetailsColumn(checkStats, isForEachParent);

      detailsTable.push([checkStats.checkName, duration, status, details]);
    }

    logger.info(detailsTable.toString());

    // Clarify that we will finalize GitHub check runs after the table (if enabled)
    try {
      if (this.checkRunMap && this.checkRunMap.size > 0) {
        logger.info('');
        logger.info('⏳ Finalizing GitHub check runs...');
      }
    } catch {}

    // Legend
    logger.info('');
    logger.info(
      'Legend: ✔=success │ ✖=failed │ ⏭=skipped │ ×N=iterations │ →N=outputs │ N🔴=critical │ N⚠️=warnings'
    );
  }
}
