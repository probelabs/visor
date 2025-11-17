import type { VisorConfig, EventTrigger } from '../../types/config';
import type { PRInfo } from '../../pr-analyzer';
import type { EngineContext, CheckMetadata } from '../../types/engine';
import { ExecutionJournal } from '../../snapshot-store';
import { MemoryStore } from '../../memory-store';
import { v4 as uuidv4 } from 'uuid';
import { logger } from '../../logger';

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

  return {
    mode: 'state-machine',
    config: clonedConfig,
    checks,
    journal,
    memory,
    workingDirectory,
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
