/**
 * Generates docker-compose.yml files from project service configurations.
 * Used to spin up project-level services (redis, postgres, etc.) alongside
 * workspace containers for code exploration and testing.
 */
import { ProjectServiceConfig, SandboxConfig } from './types';
export interface GenerateComposeOptions {
    /** Project identifier */
    projectId: string;
    /** Session identifier (for unique compose project naming) */
    sessionId: string;
    /** Project services to include */
    services: Record<string, ProjectServiceConfig>;
    /** The sandbox config for the workspace container (optional) */
    workspaceSandbox?: SandboxConfig;
    /** Host path to mount as /workspace */
    workspacePath: string;
    /** Visor dist path to mount as /opt/visor */
    visorDistPath: string;
    /** Directory to write the compose file to */
    outputDir: string;
}
export interface GenerateComposeResult {
    /** Absolute path to the generated docker-compose.yml */
    filePath: string;
    /** Docker Compose project name */
    projectName: string;
    /** Workspace service name to exec into */
    serviceName: string;
    /** Service endpoints for env injection */
    serviceEndpoints: Record<string, {
        host: string;
        port: number;
    }>;
}
/**
 * Generate a docker-compose.yml from project service configurations.
 *
 * Key design decisions:
 * - No host ports: services communicate via compose DNS (service name as hostname)
 * - Workspace container uses `sleep infinity` to stay alive for exec
 * - Port inference from well-known service names/images
 */
export declare function generateComposeFile(options: GenerateComposeOptions): Promise<GenerateComposeResult>;
//# sourceMappingURL=compose-generator.d.ts.map