/**
 * Bubblewrap-based sandbox implementation.
 * Uses Linux kernel namespaces for lightweight process isolation (~5-50ms overhead).
 * Requires the `bwrap` binary to be installed on the host.
 */
import { SandboxConfig, SandboxExecOptions, SandboxExecResult, SandboxInstance } from './types';
export declare class BubblewrapSandbox implements SandboxInstance {
    name: string;
    config: SandboxConfig;
    private repoPath;
    private visorDistPath;
    constructor(name: string, config: SandboxConfig, repoPath: string, visorDistPath: string);
    /**
     * Check if bwrap binary is available on the system.
     */
    static isAvailable(): Promise<boolean>;
    /**
     * Execute a command inside a bubblewrap sandbox.
     * Each exec creates a fresh namespace — no persistent container.
     */
    exec(options: SandboxExecOptions): Promise<SandboxExecResult>;
    /**
     * No-op: bubblewrap processes are ephemeral (no persistent container to stop).
     */
    stop(): Promise<void>;
    /**
     * Build the bwrap command-line arguments.
     */
    private buildArgs;
}
//# sourceMappingURL=bubblewrap-sandbox.d.ts.map