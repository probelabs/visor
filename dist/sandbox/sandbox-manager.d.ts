/**
 * SandboxManager — lifecycle management for sandbox environments.
 * Handles lazy container/process startup, reuse, exec routing, and cleanup.
 * Supports Docker (image, compose), Bubblewrap (Linux namespaces), and Seatbelt (macOS sandbox-exec) engines.
 */
import { SandboxConfig, SandboxInstance, SandboxExecOptions, SandboxExecResult, ProjectServiceConfig, ProjectEnvironment } from './types';
export declare class SandboxManager {
    private sandboxDefs;
    private repoPath;
    private gitBranch;
    private instances;
    private projectEnvironments;
    private cacheManager;
    private visorDistPath;
    /** Get the resolved repository path (used by trace file relay) */
    getRepoPath(): string;
    constructor(sandboxDefs: Record<string, SandboxConfig>, repoPath: string, gitBranch: string);
    /**
     * Resolve which sandbox a check should use.
     * Returns null if the check should run on the host.
     *
     * Resolution order:
     * 1. Check-level sandbox: (explicit override)
     * 2. Workspace-level sandbox: (default)
     * 3. null → run on host
     */
    resolveSandbox(checkSandbox: string | undefined, workspaceDefault: string | undefined): string | null;
    /**
     * Get or lazily start a sandbox instance by name.
     */
    getOrStart(name: string): Promise<SandboxInstance>;
    /**
     * Execute a command inside a named sandbox
     */
    exec(name: string, options: SandboxExecOptions): Promise<SandboxExecResult>;
    /**
     * Start project-level services (redis, postgres, etc.) via docker-compose.
     * Generates a compose file, starts services, and returns endpoint info.
     */
    startProjectServices(projectId: string, services: Record<string, ProjectServiceConfig>, sandboxName: string | undefined, sessionId: string, workspacePath: string): Promise<ProjectEnvironment>;
    /**
     * Stop services for a specific project
     */
    stopProjectServices(projectId: string): Promise<void>;
    /**
     * Get the project environment (if started) for env var injection
     */
    getProjectEnvironment(projectId: string): ProjectEnvironment | undefined;
    /**
     * Generate environment variables from a ProjectEnvironment's service endpoints.
     * Produces {SERVICE_NAME}_HOST and {SERVICE_NAME}_PORT for each service.
     * E.g., redis → REDIS_HOST=redis, REDIS_PORT=6379
     */
    static generateServiceEnvVars(env: ProjectEnvironment): Record<string, string>;
    /**
     * Stop all running sandbox instances and run cache eviction
     */
    stopAll(): Promise<void>;
}
//# sourceMappingURL=sandbox-manager.d.ts.map