/**
 * Sandbox routing utility for check execution.
 *
 * Decides whether a check should run inside a Docker sandbox (via CheckRunner)
 * or directly on the host (via provider.execute()).
 */

import type { EngineContext } from '../../types/engine';
import type { CheckConfig } from '../../types/config';
import type { ReviewSummary } from '../../reviewer';
import type { PRInfo } from '../../pr-analyzer';
import { logger } from '../../logger';

/**
 * Execute a check either in a sandbox container or on the host.
 *
 * When the check is configured with a sandbox (check-level or workspace-level default),
 * and a SandboxManager is available on the engine context, the check is serialized
 * and executed inside the sandbox via CheckRunner.runCheck().
 *
 * Otherwise, falls back to the normal provider.execute() path via the provided callback.
 */
export async function executeWithSandboxRouting(
  checkId: string,
  checkConfig: CheckConfig,
  context: EngineContext,
  prInfo: PRInfo | any,
  dependencyResults: Map<string, ReviewSummary>,
  timeout: number | undefined,
  hostExecute: () => Promise<ReviewSummary>
): Promise<ReviewSummary> {
  const sandboxManager = context.sandboxManager;
  if (!sandboxManager) {
    return hostExecute();
  }

  // Resolve which sandbox this check should use
  const sandboxName = sandboxManager.resolveSandbox(
    checkConfig.sandbox,
    context.config.sandbox as string | undefined
  );

  if (!sandboxName) {
    return hostExecute();
  }

  // Get sandbox configuration
  const sandboxConfig = context.config.sandboxes?.[sandboxName];
  if (!sandboxConfig) {
    throw new Error(`Sandbox '${sandboxName}' not found in sandboxes configuration`);
  }

  // Execute in sandbox via CheckRunner
  logger.info(`[SandboxRouting] Routing check '${checkId}' to sandbox '${sandboxName}'`);
  const { CheckRunner } = require('../../sandbox/check-runner');
  return CheckRunner.runCheck(
    sandboxManager,
    sandboxName,
    sandboxConfig,
    checkConfig,
    prInfo,
    dependencyResults.size > 0 ? dependencyResults : undefined,
    timeout,
    context.config.sandbox_defaults
  );
}
