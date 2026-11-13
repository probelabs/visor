/**
 * Docker image-based sandbox implementation.
 * Supports three modes: pre-built image, Dockerfile, and inline Dockerfile.
 */
import { SandboxConfig, SandboxExecOptions, SandboxExecResult, SandboxInstance } from './types';
export declare class DockerImageSandbox implements SandboxInstance {
    name: string;
    config: SandboxConfig;
    private containerId;
    private containerName;
    private repoPath;
    private visorDistPath;
    private cacheVolumeMounts;
    constructor(name: string, config: SandboxConfig, repoPath: string, visorDistPath: string, cacheVolumeMounts?: string[]);
    /**
     * Build the Docker image if needed (dockerfile or dockerfile_inline mode)
     */
    private buildImageIfNeeded;
    /**
     * Start the sandbox container
     */
    start(): Promise<void>;
    /**
     * Execute a command inside the running container
     */
    exec(options: SandboxExecOptions): Promise<SandboxExecResult>;
    /**
     * Stop and remove the container
     */
    stop(): Promise<void>;
}
//# sourceMappingURL=docker-image-sandbox.d.ts.map