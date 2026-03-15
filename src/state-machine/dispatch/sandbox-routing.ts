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
 * Optional project metadata for service startup and env injection.
 */
export interface ProjectMeta {
  projectId: string;
  services?: Record<string, import('../../sandbox/types').ProjectServiceConfig>;
  /** Workspace path where the project was checked out */
  workspacePath?: string;
}

/**
 * Extract ProjectMeta from dependency results.
 *
 * Scans dependency outputs for project arrays (from merge-projects, checkout_projects,
 * or similar steps) that contain objects with { project_id, services, path }.
 * Returns an array of ProjectMeta for all projects that have services defined.
 *
 * This bridges the gap between workflow-level project config and engine-level
 * sandbox execution: workflows define services in project definitions, and
 * this function extracts them so executeWithSandboxRouting() can start services.
 */
export function extractProjectMeta(dependencyResults: Map<string, ReviewSummary>): ProjectMeta[] {
  const result: ProjectMeta[] = [];
  const seen = new Set<string>();

  for (const [, depResult] of dependencyResults) {
    const output = (depResult as any)?.output;
    // Look for arrays of project objects (merge-projects, checkout_projects, etc.)
    const candidates = Array.isArray(output)
      ? output
      : Array.isArray(output?.checkout_projects)
        ? output.checkout_projects
        : null;

    if (!candidates) continue;

    for (const item of candidates) {
      if (!item || typeof item !== 'object') continue;
      const projectId = item.project_id;
      if (!projectId || typeof projectId !== 'string' || seen.has(projectId)) continue;
      seen.add(projectId);

      // Only create ProjectMeta if there are services to start
      if (
        item.services &&
        typeof item.services === 'object' &&
        Object.keys(item.services).length > 0
      ) {
        result.push({
          projectId,
          services: item.services,
          workspacePath: item.path || undefined,
        });
      }
    }
  }

  return result;
}

/**
 * Execute a check either in a sandbox container or on the host.
 *
 * When the check is configured with a sandbox (check-level or workspace-level default),
 * and a SandboxManager is available on the engine context, the check is serialized
 * and executed inside the sandbox via CheckRunner.runCheck().
 *
 * If projectMeta is provided and includes services, those services are started
 * and their endpoints injected as environment variables ({SERVICE}_HOST, {SERVICE}_PORT).
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
  hostExecute: () => Promise<ReviewSummary>,
  projectMeta?: ProjectMeta | ProjectMeta[]
): Promise<ReviewSummary> {
  const sandboxManager = context.sandboxManager;
  if (!sandboxManager) {
    return hostExecute();
  }

  // Resolve which sandbox this check should use
  // Check step-level sandbox, then workflow input sandbox, then config-level default
  const sandboxName = sandboxManager.resolveSandbox(
    checkConfig.sandbox || (checkConfig as any).workflowInputs?.sandbox || undefined,
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

  // Normalize to array of ProjectMeta
  const projectMetas: ProjectMeta[] = projectMeta
    ? Array.isArray(projectMeta)
      ? projectMeta
      : [projectMeta]
    : extractProjectMeta(dependencyResults);

  // Start project services for all projects that define them, collect env vars
  // Services require Docker networking — warn if sandbox engine is not Docker
  let serviceEnvVars: Record<string, string> | undefined;
  for (const meta of projectMetas) {
    if (!meta.services || Object.keys(meta.services).length === 0) continue;
    if (sandboxConfig.engine && sandboxConfig.engine !== 'docker') {
      logger.warn(
        `[SandboxRouting] Project '${meta.projectId}' defines services (${Object.keys(meta.services).join(', ')}), ` +
          `but sandbox '${sandboxName}' uses engine '${sandboxConfig.engine}'. ` +
          `Services require Docker networking and will not be available in '${sandboxConfig.engine}' sandboxes.`
      );
      continue;
    }
    try {
      const { SandboxManager: SM } = require('../../sandbox/sandbox-manager');
      const projectEnv = await sandboxManager.startProjectServices(
        meta.projectId,
        meta.services,
        sandboxName,
        context.sessionId,
        meta.workspacePath || sandboxManager.getRepoPath()
      );
      const envVars = SM.generateServiceEnvVars(projectEnv);
      serviceEnvVars = { ...(serviceEnvVars || {}), ...envVars };
      logger.info(
        `[SandboxRouting] Started services for project '${meta.projectId}': ${Object.keys(envVars || {}).join(', ')}`
      );
    } catch (err) {
      logger.warn(
        `[SandboxRouting] Failed to start project services for '${meta.projectId}': ${err}`
      );
      // Non-fatal: continue without service env vars for this project
    }
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
    context.config.sandbox_defaults,
    serviceEnvVars
  );
}
