/**
 * WavePlanning State Handler
 *
 * Responsibilities:
 * - Inspect event queue for forward runs, goto events, etc.
 * - Determine next wave's execution levels
 * - Queue topological levels for execution
 * - Transition to LevelDispatch or Completed
 *
 * M2: Adds goto/on_finish/on_fail routing with deduplication
 */

import type { EngineContext, RunState, EngineState, EngineEvent } from '../../types/engine';
import { logger } from '../../logger';
import { DependencyResolver } from '../../dependency-resolver';

export async function handleWavePlanning(
  context: EngineContext,
  state: RunState,
  transition: (newState: EngineState) => void
): Promise<void> {
  if (context.debug) {
    logger.info(`[WavePlanning] Planning wave ${state.wave}...`);
  }

  // Reset forward-run active flag at the beginning of each planning cycle.
  // It will be set to true only when we schedule a wave spawned by a forward-run request.
  try {
    (state as any).flags = (state as any).flags || {};
    (state as any).flags.forwardRunActive = false;
  } catch {}

  // Check if we have a dependency graph
  if (!context.dependencyGraph) {
    throw new Error('Dependency graph not available');
  }

  // M3: Process bubbled events from child workflows
  const bubbledEvents = (context as any)._bubbledEvents || [];
  if (bubbledEvents.length > 0) {
    if (context.debug) {
      logger.info(
        `[WavePlanning] Processing ${bubbledEvents.length} bubbled events from child workflows`
      );
    }

    // Merge bubbled events into our event queue
    for (const event of bubbledEvents) {
      state.eventQueue.push(event);
    }

    // Clear bubbled events
    (context as any)._bubbledEvents = [];
  }

  // M2: Process event queue for forward run requests
  // IMPORTANT: Only process forward run requests if the current wave's levelQueue is empty
  // This ensures we complete all scheduled checks before processing routing events
  const forwardRunRequests = state.eventQueue.filter(
    e => e.type === 'ForwardRunRequested'
  ) as Array<Extract<EngineEvent, { type: 'ForwardRunRequested' }>>;

  // Process forward-run requests.
  // - GOTO-originated requests (goto/goto_js) preempt remaining work to jump back.
  // - RUN-originated requests (run/run_js) are processed after the current wave drains,
  //   so dependents in this wave (e.g., validate-fact after extract-facts) still run first.
  if (
    forwardRunRequests.length > 0 &&
    (state.levelQueue.length === 0 ||
      forwardRunRequests.some(r => r.origin === 'goto' || r.origin === 'goto_js'))
  ) {
    if (state.levelQueue.length > 0) {
      if (context.debug) {
        logger.info(
          `[WavePlanning] Preempting ${state.levelQueue.length} remaining levels due to goto forward-run request`
        );
      }
      // Clear remaining work; the next wave will be rebuilt
      state.levelQueue = [];
    }
    if (context.debug) {
      logger.info(`[WavePlanning] Processing ${forwardRunRequests.length} forward run requests`);
    }

    // Clear processed events from queue
    state.eventQueue = state.eventQueue.filter(e => e.type !== 'ForwardRunRequested');

    // Build set of checks to execute with deduplication
    const checksToRun = new Set<string>();
    // Collect per-check scopes for map-fanout runs
    if (!state.pendingRunScopes) state.pendingRunScopes = new Map();
    const eventOverrides = new Map<string, string>();

    for (const request of forwardRunRequests) {
      const { target, gotoEvent } = request;

      // Deduplication: check if we've already requested this target in this wave
      const scopeKey =
        (request as any).scope && Array.isArray((request as any).scope)
          ? JSON.stringify((request as any).scope)
          : 'root';
      const dedupeKey = `${target}:${gotoEvent || 'default'}:${state.wave}:${scopeKey}`;
      if (state.forwardRunGuards.has(dedupeKey)) {
        if (context.debug) {
          logger.info(`[WavePlanning] Skipping duplicate forward run: ${target}`);
        }
        continue;
      }

      // Add to dedupe guard
      state.forwardRunGuards.add(dedupeKey);

      // Add target to execution set
      checksToRun.add(target);

      // Record requested scope (if any) for per-item fanout scheduling
      try {
        const scope = (request as any).scope as
          | import('../../snapshot-store').ScopePath
          | undefined;
        if (scope && scope.length > 0) {
          const arr = state.pendingRunScopes.get(target) || [];
          // Deduplicate scopes
          const key = (s: any[]) => JSON.stringify(s);
          if (!arr.some(s => key(s) === key(scope))) arr.push(scope);
          state.pendingRunScopes.set(target, arr);
        }
      } catch {}

      // Store event override if specified
      if (gotoEvent) {
        eventOverrides.set(target, gotoEvent);
      }

      // Find all transitive dependencies (parents) of target
      const dependencies = findTransitiveDependencies(target, context);
      for (const dep of dependencies) {
        checksToRun.add(dep);
      }

      // Find all transitive dependents (children) of target
      const dependents = findTransitiveDependents(target, context, gotoEvent);
      for (const dep of dependents) {
        checksToRun.add(dep);
      }
    }

    if (checksToRun.size > 0) {
      // Build subgraph for checks to run
      const subgraphChecks = Array.from(checksToRun);

      // Build dependency map for subgraph (expand OR tokens)
      const subDeps: Record<string, string[]> = {};
      for (const checkId of subgraphChecks) {
        const checkConfig = context.config.checks?.[checkId];
        if (!checkConfig) continue;

        const deps = checkConfig.depends_on || [];
        const depList = Array.isArray(deps) ? deps : [deps];

        // Expand OR tokens (e.g., "A|B") and include only dependencies present in the subgraph
        const expanded = depList.flatMap((d: string) =>
          typeof d === 'string' && d.includes('|')
            ? d
                .split('|')
                .map(s => s.trim())
                .filter(Boolean)
            : [d]
        );

        subDeps[checkId] = expanded.filter((d: string) => checksToRun.has(d));
      }

      // Build execution order for subgraph
      const subGraph = DependencyResolver.buildDependencyGraph(subDeps);

      // Check for cycles in forward-run subset
      if (subGraph.hasCycles) {
        const cycleNodes = subGraph.cycleNodes?.join(' -> ') || 'unknown';
        const errorMsg = `Cycle detected in forward-run dependency subset: ${cycleNodes}`;
        logger.error(`[WavePlanning] ${errorMsg}`);

        // Mark execution as failed by adding a failed check to stats
        // This allows tests to detect the cycle via statistics.failedExecutions
        const firstCycleCheck = subGraph.cycleNodes?.[0];
        if (firstCycleCheck) {
          const checkStats: any = {
            checkName: firstCycleCheck,
            totalRuns: 1, // Count as 1 execution attempt
            successfulRuns: 0,
            failedRuns: 1,
            skippedRuns: 0,
            skipped: false,
            totalDuration: 0,
            issuesFound: 0,
            issuesBySeverity: {
              critical: 0,
              error: 1,
              warning: 0,
              info: 0,
            },
            errorMessage: errorMsg,
          };
          state.stats.set(firstCycleCheck, checkStats);
        }

        // Transition to Completed (nothing more to execute)
        transition('Completed');
        return;
      }

      // Queue levels for execution
      state.levelQueue = [...subGraph.executionOrder];

      if (context.debug) {
        const planned = subgraphChecks.join(', ');
        logger.info(
          `[WavePlanning] Forward-run planning: checks=[${planned}] levels=${state.levelQueue.length}`
        );
      }

      if (context.debug) {
        logger.info(
          `[WavePlanning] Queued ${state.levelQueue.length} levels for ${checksToRun.size} checks (forward run)`
        );
      }

      // Increment wave counter
      state.wave++;

      // Reset wave-scoped state to allow routing retries
      (state as any).currentWaveCompletions = new Set<string>();
      (state as any).failedChecks = new Set<string>();

      // Clear forward run flag since we're processing them
      state.flags.forwardRunRequested = false;

      // Mark this wave as a forward-run wave so guards (if/assume) may consult
      // prior outputs from the journal when evaluating conditions.
      try {
        (state as any).flags.forwardRunActive = true;
      } catch {}

      // Transition to LevelDispatch
      transition('LevelDispatch');
      return;
    }
  }

  // M2: Check for WaveRetry events (from on_finish)
  const waveRetryEvents = state.eventQueue.filter(e => e.type === 'WaveRetry');
  if (
    waveRetryEvents.length > 0 &&
    state.levelQueue.length === 0 &&
    !state.eventQueue.some(e => e.type === 'ForwardRunRequested')
  ) {
    logger.info(`[WavePlanning] Processing wave retry requests (${waveRetryEvents.length} events)`);

    // Clear wave retry events
    state.eventQueue = state.eventQueue.filter(e => e.type !== 'WaveRetry');

    // Strategy: Only re-run checks that were previously skipped due to `if`
    // gating. This avoids re-running forEach parents and heavy dependency
    // trees while allowing post-aggregation checks to re-evaluate.
    const skippedIfChecks = new Set<string>();
    logger.info(`[WavePlanning] Scanning ${state.stats.size} stat entries for skipped-if checks`);
    for (const [name, stats] of state.stats.entries()) {
      logger.info(
        `[WavePlanning] Check ${name}: skipped=${(stats as any).skipped}, skipReason=${(stats as any).skipReason}`
      );
      if ((stats as any).skipped === true && (stats as any).skipReason === 'if_condition') {
        skippedIfChecks.add(name);
        logger.info(`[WavePlanning] Found skipped-if check for retry: ${name}`);
      }
    }
    logger.info(`[WavePlanning] Total skipped-if checks: ${skippedIfChecks.size}`);

    if (skippedIfChecks.size === 0) {
      // Nothing to retry; mark completed
      transition('Completed');
      return;
    }

    // Build subgraph only for the skipped-if checks; do not include forEach parents.
    const checksToRun = Array.from(skippedIfChecks).filter(
      id => !(context.config.checks?.[id] as any)?.forEach
    );
    const subDeps: Record<string, string[]> = {};
    for (const id of checksToRun) {
      // Only include dependencies that are within the same subset (often none).
      const cfg = context.config.checks?.[id];
      const deps = (cfg?.depends_on || []).filter((d: string) => checksToRun.includes(d));
      subDeps[id] = deps as string[];
    }

    const subGraph = DependencyResolver.buildDependencyGraph(subDeps);

    state.levelQueue = [...subGraph.executionOrder];

    if (context.debug) {
      logger.info(
        `[WavePlanning] Wave retry queued ${checksToRun.length} skipped-if check(s) in ${state.levelQueue.length} level(s)`
      );
    }

    // Increment wave and reset wave-scoped state
    state.wave++;

    // Reset wave-scoped state to allow retry evaluation
    (state as any).currentWaveCompletions = new Set<string>();
    (state as any).failedChecks = new Set<string>();

    transition('LevelDispatch');
    return;
  }

  // (Removed) opportunistic on_finish processing; handled in LevelDispatch and routing.

  // Initial wave: queue all execution levels
  if (state.wave === 0 && state.levelQueue.length === 0) {
    state.levelQueue = [...context.dependencyGraph.executionOrder];

    if (context.debug) {
      logger.info(
        `[WavePlanning] Queued ${state.levelQueue.length} levels for execution (initial wave)`
      );
    }

    // Increment wave to prevent re-queueing the same levels
    state.wave++;

    // Initialize current wave state
    (state as any).currentWaveCompletions = new Set<string>();
    (state as any).failedChecks = new Set<string>();
  }

  // Check if there are levels to execute
  if (state.levelQueue.length > 0) {
    // Transition to LevelDispatch
    transition('LevelDispatch');
  } else {
    // No more work - check if we have pending events
    if (state.eventQueue.length > 0) {
      if (context.debug) {
        logger.warn(
          `[WavePlanning] Event queue not empty (${state.eventQueue.length} events) but no work scheduled`
        );
      }
    }

    // All work complete
    if (context.debug) {
      logger.info('[WavePlanning] All waves complete');
    }
    transition('Completed');
  }
}

/**
 * Find all transitive dependencies (parents) of a check
 */
function findTransitiveDependencies(target: string, context: EngineContext): Set<string> {
  const dependencies = new Set<string>();
  const checks = context.config.checks || {};
  const visited = new Set<string>();

  const dfs = (checkId: string) => {
    if (visited.has(checkId)) return;
    visited.add(checkId);

    const checkConfig = checks[checkId];
    if (!checkConfig) return;

    const deps = checkConfig.depends_on || [];
    const depList = Array.isArray(deps) ? deps : [deps];

    for (const depId of depList) {
      if (typeof depId !== 'string') continue;

      // Handle OR dependencies (pipe syntax) - add all options
      if (depId.includes('|')) {
        const orOptions = depId
          .split('|')
          .map(s => s.trim())
          .filter(Boolean);
        for (const opt of orOptions) {
          if (checks[opt]) {
            // Exclude pure memory initializers from forward-run dependency subset
            const optCfg: any = checks[opt];
            if (
              String(optCfg?.type || '').toLowerCase() === 'memory' &&
              String(optCfg?.operation || '').toLowerCase() === 'set'
            ) {
              continue;
            }
            dependencies.add(opt);
            dfs(opt);
          }
        }
      } else {
        if (checks[depId]) {
          // Exclude pure memory initializers from forward-run dependency subset
          const dCfg: any = checks[depId];
          if (
            String(dCfg?.type || '').toLowerCase() === 'memory' &&
            String(dCfg?.operation || '').toLowerCase() === 'set'
          ) {
            continue;
          }
          dependencies.add(depId);
          dfs(depId);
        }
      }
    }
  };

  dfs(target);
  return dependencies;
}

/**
 * Find all transitive dependents of a check that should run for a given event
 */
function findTransitiveDependents(
  target: string,
  context: EngineContext,
  gotoEvent?: string
): Set<string> {
  const dependents = new Set<string>();
  const checks = context.config.checks || {};

  if (context.debug) {
    logger.info(
      `[WavePlanning] findTransitiveDependents called for target=${target}, gotoEvent=${gotoEvent}`
    );
  }

  // Helper to check if a check depends on another
  const dependsOn = (checkId: string, depId: string): boolean => {
    const visited = new Set<string>();

    const dfs = (current: string): boolean => {
      if (visited.has(current)) return false;
      visited.add(current);

      const checkConfig = checks[current];
      if (!checkConfig) return false;

      const deps = checkConfig.depends_on || [];
      const depList = Array.isArray(deps) ? deps : [deps];

      // Check direct dependency or OR dependency (pipe syntax)
      for (const dep of depList) {
        if (typeof dep !== 'string') continue;

        // Handle OR dependencies (pipe syntax)
        if (dep.includes('|')) {
          const orOptions = dep.split('|').map(s => s.trim());
          if (orOptions.includes(depId)) return true;
        } else {
          if (dep === depId) return true;
        }
      }

      for (const d of depList) {
        if (dfs(d)) return true;
      }

      return false;
    };

    return dfs(checkId);
  };

  // Find all checks that depend on target
  for (const checkId of Object.keys(checks)) {
    if (checkId === target) continue;

    const checkConfig = checks[checkId];
    if (!checkConfig) continue;

    // Check if this check depends on target
    const isDep = dependsOn(checkId, target);
    if (context.debug && isDep) {
      logger.info(`[WavePlanning] findTransitiveDependents: ${checkId} depends on ${target}`);
    }
    if (!isDep) continue;

    // If gotoEvent specified, filter by event triggers
    if (gotoEvent) {
      const triggers = checkConfig.on;
      if (Array.isArray(triggers) && triggers.length > 0) {
        if (!triggers.includes(gotoEvent as any)) {
          // This check doesn't run for the specified event
          if (context.debug) {
            logger.info(`[WavePlanning] Skipping ${checkId}: doesn't run for event ${gotoEvent}`);
          }
          continue;
        }
      }
    }

    // Add to dependents
    dependents.add(checkId);
    if (context.debug) {
      logger.info(`[WavePlanning] Added dependent: ${checkId}`);
    }
  }

  return dependents;
}
