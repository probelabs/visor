/**
 * Docker Compose-based sandbox implementation.
 * Supports multi-service environments (e.g., app + redis + postgres).
 */
import { SandboxConfig, SandboxExecOptions, SandboxExecResult, SandboxInstance } from './types';
export declare class DockerComposeSandbox implements SandboxInstance {
    name: string;
    config: SandboxConfig;
    private projectName;
    private started;
    constructor(name: string, config: SandboxConfig);
    /**
     * Start the compose services
     */
    start(): Promise<void>;
    /**
     * Execute a command inside the compose service
     */
    exec(options: SandboxExecOptions): Promise<SandboxExecResult>;
    /**
     * Stop and tear down the compose project
     */
    stop(): Promise<void>;
}
//# sourceMappingURL=docker-compose-sandbox.d.ts.map