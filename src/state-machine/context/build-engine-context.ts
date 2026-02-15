import type { VisorConfig, EventTrigger } from '../../types/config';
import type { PRInfo } from '../../pr-analyzer';
import type { EngineContext, CheckMetadata } from '../../types/engine';
import { ExecutionJournal } from '../../snapshot-store';
import { MemoryStore } from '../../memory-store';
import { generateHumanId } from '../../utils/human-id';
import { logger } from '../../logger';
import type { VisorConfig as VCfg, CheckConfig as CfgCheck } from '../../types/config';
import { WorkspaceManager } from '../../utils/workspace-manager';

// Lazy-resolve DelegationManager from @probelabs/probe.
// The class may not be exported in older published versions, so we
// fall back gracefully to avoid breaking the build.
let _DelegationManager: (new (opts?: any) => any) | null = null;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const probe = require('@probelabs/probe');
  if (probe && typeof probe.DelegationManager === 'function') {
    _DelegationManager = probe.DelegationManager;
  }
} catch {
  // Not available — max_ai_concurrency will be silently ignored
}

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
): EngineContext {
  // Deep clone provided config to avoid cross-run mutations between tests/runs
  const clonedConfig: VisorConfig = JSON.parse(JSON.stringify(config));

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

  // Initialize journal and memory
  const journal = new ExecutionJournal();
  const memory = MemoryStore.getInstance(clonedConfig.memory);

  // Create shared AI concurrency limiter if configured
  let sharedConcurrencyLimiter: any = undefined;
  if (clonedConfig.max_ai_concurrency && _DelegationManager) {
    sharedConcurrencyLimiter = new _DelegationManager({
      maxConcurrent: clonedConfig.max_ai_concurrency,
      maxPerSession: 999, // No per-session limit needed for global AI gating
    });
    logger.debug(
      `[EngineContext] Created shared AI concurrency limiter (max: ${clonedConfig.max_ai_concurrency})`
    );
  }

  return {
    mode: 'state-machine',
    config: clonedConfig,
    checks,
    journal,
    memory,
    workingDirectory,
    originalWorkingDirectory: workingDirectory,
    sessionId: generateHumanId(),
    event: prInfo.eventType,
    debug,
    maxParallelism,
    sharedConcurrencyLimiter,
    failFast,
    requestedChecks: requestedChecks && requestedChecks.length > 0 ? requestedChecks : undefined,
    // Store prInfo for later access (e.g., in getOutputHistorySnapshot)
    prInfo,
  };
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
