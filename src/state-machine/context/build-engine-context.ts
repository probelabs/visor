import type { VisorConfig, EventTrigger } from '../../types/config';
import type { PRInfo } from '../../pr-analyzer';
import type { EngineContext, CheckMetadata } from '../../types/engine';
import { ExecutionJournal } from '../../snapshot-store';
import type { GraphJournalCheckpointV1 } from '../../snapshot-store';
import { MemoryStore } from '../../memory-store';
import { generateHumanId } from '../../utils/human-id';
import { logger } from '../../logger';
import type { VisorConfig as VCfg, CheckConfig as CfgCheck } from '../../types/config';
import { WorkspaceManager } from '../../utils/workspace-manager';
import { FairConcurrencyLimiter } from '../../utils/fair-concurrency-limiter';
import { compileClaimPlan } from '../graph/claim-plan';

/** Private bootstrap used only by the engine's one-shot Graph checkpoint continuation. */
export interface GraphCheckpointBootstrap {
  readonly kind: 'graph';
  readonly checkpoint: unknown;
  readonly expansionOwnerCheck: string;
}

/**
 * Private bootstrap for a Proof catalog refresh.  The public SDK deliberately
 * does not expose graph mutations: it supplies only the checkpoint and the
 * exact Proof output bytes, which the journal authenticates and projects.
 */
export interface ProofCurrentCatalogCheckpointBootstrap {
  readonly kind: 'proof-current-catalog';
  readonly checkpoint: unknown;
  readonly projectSubgraphInstanceId: string;
  readonly revalidationBytes: string | Uint8Array;
  readonly workItemsBytes: string | Uint8Array;
}

export type CheckpointBootstrap =
  | GraphCheckpointBootstrap
  | ProofCurrentCatalogCheckpointBootstrap;

export type BuiltGraphCheckpointContext =
  | {
      readonly kind: 'graph';
      readonly context: EngineContext;
      readonly requestId: string;
    }
  | {
      readonly kind: 'proof-current-catalog';
      readonly context: EngineContext;
      readonly authorityId: string;
      readonly mutationEventCount: number;
    };

/**
 * Apply minimal criticality defaults in-place.
 * This is a no-behavior-change scaffold: we only default missing
 * check.criticality to 'policy' so downstream code can rely on a value.
 * Future mapping (retries/loop budgets) can build on this without
 * changing existing behavior.
 */
function applyCriticalityDefaults(cfg: VCfg): void {
  const checks = cfg.checks || {};
  for (const id of Object.keys(checks)) {
    const c: CfgCheck = (checks as any)[id] as CfgCheck;
    if (!c.criticality) (c.criticality as any) = 'policy';
    // For 'info' checks, default continue_on_failure to true if unset.
    if (c.criticality === 'info' && typeof c.continue_on_failure === 'undefined')
      c.continue_on_failure = true;
  }
}

/**
 * Pure helper to build an EngineContext for a state-machine run.
 * Extracted to reduce StateMachineExecutionEngine size; behavior unchanged.
 */
export function buildEngineContextForRun(
  workingDirectory: string,
  config: VisorConfig,
  prInfo: PRInfo,
  debug?: boolean,
  maxParallelism?: number,
  failFast?: boolean,
  requestedChecks?: string[]
): EngineContext;
export function buildEngineContextForRun(
  workingDirectory: string,
  config: VisorConfig,
  prInfo: PRInfo,
  debug?: boolean,
  maxParallelism?: number,
  failFast?: boolean,
  requestedChecks?: string[],
  graphCheckpointBootstrap?: CheckpointBootstrap
): BuiltGraphCheckpointContext;
export function buildEngineContextForRun(
  workingDirectory: string,
  config: VisorConfig,
  prInfo: PRInfo,
  debug?: boolean,
  maxParallelism?: number,
  failFast?: boolean,
  requestedChecks?: string[],
  graphCheckpointBootstrap?: CheckpointBootstrap
): EngineContext | BuiltGraphCheckpointContext {
  // Deep clone provided config to avoid cross-run mutations between tests/runs
  const clonedConfig: VisorConfig = JSON.parse(JSON.stringify(config));

  // Compile exact claim bindings once. Materialize effective dependencies only
  // into the per-run clone; the caller's authored configuration remains untouched.
  const claimPlan = compileClaimPlan(clonedConfig);
  if (claimPlan.active) {
    const clonedChecks = clonedConfig.checks || clonedConfig.steps || {};
    for (const [checkId, dependencies] of Object.entries(
      claimPlan.effectiveDependenciesByCheck
    )) {
      const check = clonedChecks[checkId];
      if (check) check.depends_on = [...dependencies];
    }
    clonedConfig.checks = clonedChecks;
  }

  // Restore the graph prefix before creating any session-capturing service. The
  // restore routine owns all envelope, integrity, graph, replay, quiescence,
  // and allocator validation; the engine only reads the validated envelope
  // session after it succeeds.
  let journal: ExecutionJournal;
  let sessionId: string;
  let checkpointResult:
    | { readonly kind: 'graph'; readonly requestId: string }
    | { readonly kind: 'proof-current-catalog'; readonly authorityId: string; readonly mutationEventCount: number }
    | undefined;
  if (graphCheckpointBootstrap) {
    journal = ExecutionJournal.restoreGraphCheckpoint(
      claimPlan,
      graphCheckpointBootstrap.checkpoint
    );
    const validatedCheckpoint = graphCheckpointBootstrap.checkpoint as GraphJournalCheckpointV1;
    sessionId = validatedCheckpoint.sessionId;
    if (graphCheckpointBootstrap.kind === 'graph') {
      const requestId = journal.requestCatalogReconciliation({
        sessionId,
        ownerCheck: graphCheckpointBootstrap.expansionOwnerCheck,
      }).requestId;
      checkpointResult = { kind: 'graph', requestId };
    } else {
      // The Proof branch is intentionally a private, unpublished journal
      // transaction.  The journal performs the topology/quiescence gate and
      // validates the untrusted exact bytes before any engine context is
      // published or any provider can be launched.
      const authority = journal.recordProofCurrentCatalogAuthority({
        projectSubgraphInstanceId: graphCheckpointBootstrap.projectSubgraphInstanceId,
        revalidationBytes: graphCheckpointBootstrap.revalidationBytes,
        workItemsBytes: graphCheckpointBootstrap.workItemsBytes,
      });
      const applied = journal.applyProofCurrentCatalogAuthority({
        projectSubgraphInstanceId: graphCheckpointBootstrap.projectSubgraphInstanceId,
        authorityId: authority.authorityId,
      });
      checkpointResult = {
        kind: 'proof-current-catalog',
        authorityId: applied.authorityId,
        mutationEventCount: applied.mutationEventCount,
      };
    }
  } else {
    sessionId = generateHumanId();
    journal = new ExecutionJournal(claimPlan);
  }

  // Build check metadata
  const checks: Record<string, CheckMetadata> = {};

  // Fill in minimal defaults derived from criticality (no behavior change)
  applyCriticalityDefaults(clonedConfig);

  // If config has checks, use them
  for (const [checkId, checkConfig] of Object.entries(clonedConfig.checks || {})) {
    checks[checkId] = {
      tags: checkConfig.tags || [],
      triggers: (Array.isArray(checkConfig.on) ? checkConfig.on : [checkConfig.on]).filter(
        Boolean
      ) as EventTrigger[],
      group: checkConfig.group,
      providerType: checkConfig.type || 'ai',
      // Normalize depends_on to array (supports string | string[])
      dependencies: Array.isArray(checkConfig.depends_on)
        ? checkConfig.depends_on
        : checkConfig.depends_on
          ? [checkConfig.depends_on]
          : [],
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
        } as any;

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

  // Initialize memory only after checkpoint restore and the direct owner
  // request above. The continuation skips Init but receives this fresh store.
  const memory = MemoryStore.getInstance(clonedConfig.memory);

  // Create shared AI concurrency limiter if configured.
  // Uses a global singleton fair limiter: round-robin across sessions so
  // no single user/task can starve others.
  let sharedConcurrencyLimiter: any = undefined;
  if (clonedConfig.max_ai_concurrency) {
    const fairLimiter = FairConcurrencyLimiter.getInstance(clonedConfig.max_ai_concurrency);
    // Bind this engine run's session ID into acquire/release so the fair limiter
    // knows which user/task each call belongs to. Probe calls acquire(null) —
    // we intercept and inject our session ID.
    sharedConcurrencyLimiter = {
      async acquire(parentSessionId: any, _dbg?: boolean, queueTimeout?: number | null) {
        // Use visor session ID if probe didn't provide one
        const sid = parentSessionId || sessionId;
        // ProbeAgent calls acquire(null) without queueTimeout, which defaults
        // to 120s in FairConcurrencyLimiter — too short when AI checks take
        // 5-30+ min and slots are occupied. Override to 0 (disabled) so the
        // step/AI timeout governs cancellation instead.
        const effectiveQueueTimeout = queueTimeout ?? 0;
        return fairLimiter.acquire(sid, _dbg, effectiveQueueTimeout);
      },
      release(parentSessionId: any, _dbg?: boolean) {
        const sid = parentSessionId || sessionId;
        return fairLimiter.release(sid, _dbg);
      },
      tryAcquire(parentSessionId: any) {
        const sid = parentSessionId || sessionId;
        return fairLimiter.tryAcquire(sid);
      },
      getStats() {
        return fairLimiter.getStats();
      },
      shutdown() {
        // Don't destroy the singleton — other sessions may still use it
      },
      cleanup() {
        // Don't destroy the singleton — other sessions may still use it
      },
    };
  }

  const context: EngineContext = {
    mode: 'state-machine',
    config: clonedConfig,
    checks,
    claimPlan,
    journal,
    memory,
    workingDirectory,
    originalWorkingDirectory: workingDirectory,
    sessionId,
    event: prInfo.eventType,
    debug,
    maxParallelism,
    sharedConcurrencyLimiter,
    failFast,
    requestedChecks: requestedChecks && requestedChecks.length > 0 ? requestedChecks : undefined,
    // Store prInfo for later access (e.g., in getOutputHistorySnapshot)
    prInfo,
  };

  if (graphCheckpointBootstrap) {
    // Generic continuation retains its exact request ID. Proof continuation
    // intentionally has no request suffix; the applied authority has already
    // released only the changed generations for LevelDispatch.
    if (!checkpointResult) throw new Error('Checkpoint continuation result was not created');
    if (checkpointResult.kind === 'graph') {
      return { kind: 'graph', context, requestId: checkpointResult.requestId };
    }
    return { kind: 'proof-current-catalog', context, authorityId: checkpointResult.authorityId, mutationEventCount: checkpointResult.mutationEventCount };
  }
  return context;
}

/**
 * Initialize workspace isolation for an engine context.
 * Creates an isolated workspace with the main project worktree.
 *
 * @param context - Engine context to update with workspace
 * @returns Updated context (same object, mutated)
 */
export async function initializeWorkspace(context: EngineContext): Promise<EngineContext> {
  // Check if workspace isolation is enabled via config or env
  const workspaceConfig = (context.config as any).workspace;
  const isEnabled =
    workspaceConfig?.enabled !== false && process.env.VISOR_WORKSPACE_ENABLED !== 'false';

  if (!isEnabled) {
    logger.debug('[Workspace] Workspace isolation is disabled');
    return context;
  }

  const originalPath = context.workingDirectory || process.cwd();

  try {
    // Check if workspace should be kept (for debugging)
    const keepWorkspace = process.env.VISOR_KEEP_WORKSPACE === 'true';

    // Create workspace manager
    const workspace = WorkspaceManager.getInstance(context.sessionId, originalPath, {
      enabled: true,
      basePath:
        workspaceConfig?.base_path || process.env.VISOR_WORKSPACE_PATH || '/tmp/visor-workspaces',
      cleanupOnExit: keepWorkspace ? false : workspaceConfig?.cleanup_on_exit !== false,
      name: workspaceConfig?.name || process.env.VISOR_WORKSPACE_NAME,
      mainProjectName: workspaceConfig?.main_project_name || process.env.VISOR_WORKSPACE_PROJECT,
    });

    // Initialize workspace (creates main project worktree)
    const info = await workspace.initialize();

    // Update context with workspace info
    context.workspace = workspace;
    context.workingDirectory = info.mainProjectPath;
    context.originalWorkingDirectory = originalPath;

    // Export workspace paths for templates/commands
    try {
      process.env.VISOR_WORKSPACE_ROOT = info.workspacePath;
      process.env.VISOR_WORKSPACE_MAIN_PROJECT = info.mainProjectPath;
      process.env.VISOR_WORKSPACE_MAIN_PROJECT_NAME = info.mainProjectName;
      process.env.VISOR_ORIGINAL_WORKDIR = originalPath;

      // Prevent git from walking above the workspace base path.
      // Without this, git commands in workspace subdirectories can discover
      // a rogue .git in a parent directory (e.g. /tmp/.git) and leak
      // operations across all workspaces.
      const basePath =
        workspaceConfig?.base_path || process.env.VISOR_WORKSPACE_PATH || '/tmp/visor-workspaces';
      const existing = process.env.GIT_CEILING_DIRECTORIES;
      process.env.GIT_CEILING_DIRECTORIES = existing ? `${existing}:${basePath}` : basePath;
    } catch {}

    logger.info(`[Workspace] Initialized workspace: ${info.workspacePath}`);
    logger.debug(`[Workspace] Main project at: ${info.mainProjectPath}`);
    if (keepWorkspace) {
      logger.info(`[Workspace] Keeping workspace after execution (--keep-workspace)`);
    }

    return context;
  } catch (error) {
    // Log warning but continue without workspace isolation
    logger.warn(`[Workspace] Failed to initialize workspace: ${error}`);
    logger.debug('[Workspace] Continuing without workspace isolation');
    return context;
  }
}
