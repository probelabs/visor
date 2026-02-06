/**
 * PlanReady State Handler
 *
 * Responsibilities:
 * - Build dependency graph using DependencyResolver
 * - Validate graph (check for cycles)
 * - Compute check metadata (tags, sessions, triggers)
 * - Transition to WavePlanning
 */

import type { EngineContext, RunState, EngineState } from '../../types/engine';
import { DependencyResolver } from '../../dependency-resolver';
import { logger } from '../../logger';

export async function handlePlanReady(
  context: EngineContext,
  state: RunState,
  transition: (newState: EngineState) => void
): Promise<void> {
  if (context.debug) {
    logger.info('[PlanReady] Building dependency graph...');
    if (context.requestedChecks) {
      logger.info(`[PlanReady] Requested checks: ${context.requestedChecks.join(', ')}`);
    }
    if (context.config.tag_filter) {
      logger.info(
        `[PlanReady] Tag filter: include=${JSON.stringify(context.config.tag_filter.include)}, exclude=${JSON.stringify(context.config.tag_filter.exclude)}`
      );
    } else {
      logger.info('[PlanReady] No tag filter specified - will include only untagged checks');
    }
  }

  // Filter checks based on requested checks list, event triggers, and tags BEFORE building dependency graph
  //
  // Filtering order (matches legacy engine):
  // 1. Explicit check list (requestedChecks) - if provided, expand with transitive dependencies first
  // 2. Event filtering: Only include checks where:
  //    - checkConfig.on is undefined (runs on any event), OR
  //    - checkConfig.on includes context.event
  // 3. Tag filtering (matches legacy engine behavior):
  //    - When no tag filter is specified, include only untagged checks by default
  //    - Tagged checks are opt-in unless tag_filter is provided
  //    - If exclude tags specified, exclude checks with any matching tag
  //    - If include tags specified, include checks with at least one matching tag OR untagged checks
  const eventTrigger = context.event;
  const tagFilter = context.config.tag_filter;

  // Expand requested checks with transitive dependencies (matches legacy engine)
  const expandWithTransitives = (rootChecks: string[]): Set<string> | null => {
    const expanded = new Set<string>(rootChecks);

    const allowByTags = (checkId: string): boolean => {
      if (!tagFilter) return true;
      const cfg = context.config.checks?.[checkId];
      const tags: string[] = cfg?.tags || [];
      if (tagFilter.exclude && tagFilter.exclude.some(t => tags.includes(t))) return false;
      if (tagFilter.include && tagFilter.include.length > 0) {
        return tagFilter.include.some(t => tags.includes(t));
      }
      return true;
    };

    const allowByEvent = (checkId: string): boolean => {
      const cfg = context.config.checks?.[checkId];
      const triggers = cfg?.on || [];
      if (!triggers || triggers.length === 0) return true;
      const current = eventTrigger || 'manual';
      return triggers.includes(current as any);
    };

    const visit = (checkId: string): string | null => {
      const cfg = context.config.checks?.[checkId];
      if (!cfg || !cfg.depends_on) return null;

      const depTokens = Array.isArray(cfg.depends_on) ? cfg.depends_on : [cfg.depends_on];
      const expandDep = (tok: string): string[] => {
        if (tok.includes('|')) {
          return tok
            .split('|')
            .map(s => s.trim())
            .filter(Boolean);
        }
        return [tok];
      };

      const deps = depTokens.flatMap(expandDep);
      for (const depId of deps) {
        // Check if dependency exists - if not, return error
        if (!context.config.checks?.[depId]) {
          return `Check "${checkId}" depends on "${depId}" but "${depId}" is not defined`;
        }
        if (!allowByTags(depId)) continue;
        if (!allowByEvent(depId)) continue;
        if (!expanded.has(depId)) {
          expanded.add(depId);
          const err = visit(depId);
          if (err) return err;
        }
      }
      return null;
    };

    for (const checkId of rootChecks) {
      const err = visit(checkId);
      if (err) {
        // Record validation error
        const validationIssue: any = {
          file: 'system',
          line: 0,
          message: err,
          category: 'logic',
          severity: 'error',
          ruleId: 'system/error',
        };

        context.journal.commitEntry({
          sessionId: context.sessionId,
          scope: [],
          checkId: 'system',
          result: {
            issues: [validationIssue],
            output: undefined,
          },
        });

        return null; // Signal error by returning null
      }
    }

    return expanded;
  };

  const requestedChecksSet = context.requestedChecks
    ? expandWithTransitives(context.requestedChecks)
    : undefined;

  // Check if dependency validation failed during expansion
  if (context.requestedChecks && requestedChecksSet === null) {
    logger.error(`[PlanReady] Dependency validation failed during expansion`);
    // Transition to Completed since error was already recorded
    state.currentState = 'Completed';
    return;
  }

  if (context.debug && requestedChecksSet && context.requestedChecks) {
    const added = Array.from(requestedChecksSet).filter(c => !context.requestedChecks!.includes(c));
    if (added.length > 0) {
      logger.info(
        `[PlanReady] Expanded requested checks with transitive dependencies: ${added.join(', ')}`
      );
    }
  }

  const filteredChecks: Record<string, import('../../types/config').CheckConfig> = {};

  // Identify checks that are only meant to run via routing (on_* .run targets).
  // These should not be part of the initial graph unless explicitly requested.
  const routingRunTargets = new Set<string>();
  for (const [, cfg] of Object.entries(context.config.checks || {})) {
    const onFinish = (cfg as any).on_finish || {};
    const onSuccess = (cfg as any).on_success || {};
    const onFail = (cfg as any).on_fail || {};
    const collect = (arr?: string[]) => {
      if (Array.isArray(arr)) {
        for (const t of arr) if (typeof t === 'string' && t) routingRunTargets.add(t);
      }
    };
    collect(onFinish.run);
    collect(onSuccess.run);
    collect(onFail.run);
  }

  for (const [checkId, checkConfig] of Object.entries(context.config.checks || {})) {
    // 1. Filter by explicit check list (if provided, now includes transitive dependencies)
    if (requestedChecksSet && !requestedChecksSet.has(checkId)) {
      if (context.debug) {
        logger.info(
          `[PlanReady] Skipping check '${checkId}': not in expanded requested checks list`
        );
      }
      continue;
    }
    // 1b. Exclude checks that are intended to be started by routing (run targets)
    // unless they were explicitly requested. This avoids running aggregators/routers
    // at wave 0; they will be scheduled by ForwardRunRequested from on_* handlers.
    if (!requestedChecksSet && routingRunTargets.has(checkId)) {
      if (context.debug) {
        logger.info(
          `[PlanReady] Skipping check '${checkId}': routing-run target (will be scheduled by on_*.run)`
        );
      }
      continue;
    }
    // Check if event trigger matches (same logic as event-mapper.ts shouldRunCheck)
    // If 'on' is not specified, the check can run on any event
    if (checkConfig.on && eventTrigger && !checkConfig.on.includes(eventTrigger)) {
      if (context.debug) {
        logger.info(
          `[PlanReady] Skipping check '${checkId}': on=${JSON.stringify(checkConfig.on)}, event=${eventTrigger}`
        );
      }
      continue;
    }

    // Tag filtering (matches legacy CheckExecutionEngine.filterChecksByTags logic)
    const checkTags = checkConfig.tags || [];
    const isTagged = checkTags.length > 0;

    if (tagFilter) {
      // Check exclude tags first (if any exclude tag matches, skip the check)
      if (tagFilter.exclude && tagFilter.exclude.length > 0) {
        const hasExcludedTag = tagFilter.exclude.some(tag => checkTags.includes(tag));
        if (hasExcludedTag) {
          if (context.debug) {
            logger.info(`[PlanReady] Skipping check '${checkId}': excluded by tag filter`);
          }
          continue;
        }
      }

      // Check include tags (if specified, at least one must match OR check is untagged)
      if (tagFilter.include && tagFilter.include.length > 0) {
        const hasIncludedTag = tagFilter.include.some(tag => checkTags.includes(tag));
        if (!hasIncludedTag && isTagged) {
          if (context.debug) {
            logger.info(`[PlanReady] Skipping check '${checkId}': not included by tag filter`);
          }
          continue;
        }
      }
    } else {
      // No tag filter specified: include only untagged checks by default
      // Tagged checks are opt-in unless tag_filter is provided
      if (isTagged) {
        if (context.debug) {
          logger.info(
            `[PlanReady] Skipping check '${checkId}': tagged but no tag filter specified`
          );
        }
        continue;
      }
    }

    filteredChecks[checkId] = checkConfig;
  }

  if (context.debug) {
    const totalChecks = Object.keys(context.config.checks || {}).length;
    const filteredCount = Object.keys(filteredChecks).length;
    logger.info(
      `[PlanReady] Filtered ${totalChecks} checks to ${filteredCount} based on event=${eventTrigger}`
    );
  }

  // Forward-closure across dependents is useful when running “all” checks with no explicit roots,
  // but it must NOT run when the caller provided an explicit requested list (tests that expect
  // only a subset would be surprised). Only apply this when no requestedChecks are set.
  if (!context.requestedChecks || context.requestedChecks.length === 0) {
    const dependentsMap = new Map<string, string[]>();
    for (const [cid, cfg] of Object.entries(context.config.checks || {})) {
      const deps = (cfg.depends_on || []) as string[];
      const depList = Array.isArray(deps) ? deps : [deps];
      for (const raw of depList) {
        if (typeof raw !== 'string') continue;
        const tokens = raw.includes('|')
          ? raw
              .split('|')
              .map(s => s.trim())
              .filter(Boolean)
          : [raw];
        for (const dep of tokens) {
          if (!dependentsMap.has(dep)) dependentsMap.set(dep, []);
          dependentsMap.get(dep)!.push(cid);
        }
      }
    }

    const queue: string[] = Object.keys(filteredChecks);
    const seenForward = new Set(queue);
    while (queue.length > 0) {
      const cur = queue.shift()!;
      const kids = dependentsMap.get(cur) || [];
      for (const child of kids) {
        if (seenForward.has(child)) continue;
        // Only add child if it passes event/tag filtering (reuse policy)
        const cfg = context.config.checks?.[child];
        if (!cfg) continue;
        if (cfg.on && eventTrigger && !cfg.on.includes(eventTrigger)) continue;
        const tags = cfg.tags || [];
        const isTagged = tags.length > 0;
        if (!tagFilter && isTagged) continue;
        if (tagFilter) {
          if (tagFilter.exclude && tagFilter.exclude.length > 0) {
            const hasExcluded = tagFilter.exclude.some(t => tags.includes(t));
            if (hasExcluded) continue;
          }
          if (tagFilter.include && tagFilter.include.length > 0) {
            const hasIncluded = tagFilter.include.some(t => tags.includes(t));
            if (!hasIncluded && isTagged) continue;
          }
        }
        filteredChecks[child] = cfg;
        seenForward.add(child);
        queue.push(child);
        if (context.debug)
          logger.info(`[PlanReady] Added dependent '${child}' via forward-closure from '${cur}'`);
      }
    }
  }

  // Helper to check if dependencies are satisfied
  // For OR dependencies (pipe syntax), at least one must be in filteredChecks
  const areDependenciesSatisfied = (dependencies: string[]): boolean => {
    for (const dep of dependencies) {
      // Check for OR dependency (pipe syntax)
      if (dep.includes('|')) {
        const orOptions = dep
          .split('|')
          .map(s => s.trim())
          .filter(Boolean);
        // At least one option must exist in filtered checks
        const hasAtLeastOne = orOptions.some(opt => filteredChecks[opt] !== undefined);
        if (!hasAtLeastOne) {
          return false;
        }
      } else {
        // Regular dependency - must exist in filtered checks
        if (filteredChecks[dep] === undefined) {
          return false;
        }
      }
    }
    return true;
  };

  // Second pass: Remove checks whose dependencies are not satisfied
  // Note: When tag filtering is active, we allow soft dependencies - checks can run
  // even if some dependencies are filtered out by tags. They just won't have those outputs.
  const finalChecks: Record<string, import('../../types/config').CheckConfig> = {};
  for (const [checkId, checkConfig] of Object.entries(filteredChecks)) {
    const depRaw = (checkConfig as any).depends_on as unknown;
    const dependencies: string[] = Array.isArray(depRaw)
      ? (depRaw as string[])
      : typeof depRaw === 'string'
        ? [depRaw]
        : [];

    // Only enforce dependency satisfaction when NO tag filter is active
    // When tag filtering is active, allow checks to run with partial dependencies (soft dependencies)
    if (dependencies.length > 0 && !tagFilter && !areDependenciesSatisfied(dependencies)) {
      if (context.debug) {
        logger.info(
          `[PlanReady] Skipping check '${checkId}': unsatisfied dependencies ${JSON.stringify(dependencies)}`
        );
      }
      continue;
    }
    finalChecks[checkId] = checkConfig;
  }

  if (context.debug && Object.keys(finalChecks).length !== Object.keys(filteredChecks).length) {
    logger.info(
      `[PlanReady] Removed ${Object.keys(filteredChecks).length - Object.keys(finalChecks).length} checks due to unsatisfied dependencies`
    );
  }

  // Extract dependencies from final filtered check configurations
  const checkDependencies: Record<string, string[]> = {};

  for (const [checkId, checkConfig] of Object.entries(finalChecks)) {
    // Expand OR groups (pipe syntax) for dependency resolution
    // For OR groups, only include options that exist in finalChecks
    // e.g., "issue-assistant|comment-assistant" becomes ["comment-assistant"] if issue-assistant was filtered out
    // For regular dependencies, also filter to only include checks that exist (soft dependencies when tag filtering)
    const depsRaw2 = (checkConfig as any).depends_on as unknown;
    const depList: string[] = Array.isArray(depsRaw2)
      ? (depsRaw2 as string[])
      : typeof depsRaw2 === 'string'
        ? [depsRaw2]
        : [];
    const dependencies = depList.flatMap((d: string) => {
      if (typeof d === 'string' && d.includes('|')) {
        // OR dependency - filter to only include available checks
        const orOptions = d
          .split('|')
          .map(s => s.trim())
          .filter(Boolean)
          .filter(opt => finalChecks[opt] !== undefined); // Only include if check exists
        return orOptions;
      } else {
        // Regular dependency - when tag filtering is active, filter to only available checks (soft dependencies)
        // When no tag filtering, include all dependencies (validation happens in graph builder)
        if (tagFilter && finalChecks[d] === undefined) {
          if (context.debug) {
            logger.info(
              `[PlanReady] Soft dependency '${d}' of check '${checkId}' filtered out by tags - check will run without it`
            );
          }
          return []; // Filter out unavailable dependency
        }
        return [d];
      }
    });
    checkDependencies[checkId] = dependencies;
  }

  // Build dependency graph
  let graph;
  try {
    graph = DependencyResolver.buildDependencyGraph(checkDependencies);
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    logger.error(`[PlanReady] Dependency validation failed: ${errorMsg}`);

    // Record validation error as an issue
    const validationIssue: any = {
      file: 'system',
      line: 0,
      message: errorMsg,
      category: 'logic',
      severity: 'error',
      ruleId: 'system/error',
    };

    // Record in journal as a system check
    context.journal.commitEntry({
      sessionId: context.sessionId,
      scope: [],
      checkId: 'system',
      result: {
        issues: [validationIssue],
        output: undefined,
      },
    });

    // Transition to Completed
    state.currentState = 'Completed';
    return;
  }

  // Validate graph - check for cycles
  if (graph.hasCycles) {
    const cycleNodes = graph.cycleNodes?.join(' -> ') || 'unknown';
    const errorMsg = `Dependency cycle detected: ${cycleNodes}`;
    logger.error(`[PlanReady] ${errorMsg}`);

    // Record cycle error as an issue
    const cycleIssue: any = {
      file: 'system',
      line: 0,
      message: errorMsg,
      category: 'logic',
      severity: 'error',
      ruleId: 'system/error',
    };

    // Record in journal as a system check
    context.journal.commitEntry({
      sessionId: context.sessionId,
      scope: [],
      checkId: 'system',
      result: {
        issues: [cycleIssue],
        output: undefined,
      },
    });

    // Transition to Completed
    state.currentState = 'Completed';
    return;
  }

  if (context.debug) {
    logger.info(
      `[PlanReady] Graph built with ${graph.nodes.size} checks, ${graph.executionOrder.length} levels`
    );
  }

  // Store graph in context (mutate for now, can refactor later)
  (context as any).dependencyGraph = graph;

  // Initialize wave 0
  state.wave = 0;

  // Transition to WavePlanning
  transition('WavePlanning');
}
