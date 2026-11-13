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
export declare function extractProjectMeta(dependencyResults: Map<string, ReviewSummary>): ProjectMeta[];
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
export declare function executeWithSandboxRouting(checkId: string, checkConfig: CheckConfig, context: EngineContext, prInfo: PRInfo | any, dependencyResults: Map<string, ReviewSummary>, timeout: number | undefined, hostExecute: () => Promise<ReviewSummary>, projectMeta?: ProjectMeta | ProjectMeta[]): Promise<ReviewSummary>;
//# sourceMappingURL=sandbox-routing.d.ts.map