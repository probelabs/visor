/**
 * macOS Seatbelt sandbox implementation.
 * Uses Apple's sandbox-exec with dynamically-generated SBPL profiles
 * for lightweight process isolation on macOS.
 * Requires the `sandbox-exec` binary (ships with macOS).
 */
import { SandboxConfig, SandboxExecOptions, SandboxExecResult, SandboxInstance } from './types';
export declare class SeatbeltSandbox implements SandboxInstance {
    name: string;
    config: SandboxConfig;
    private repoPath;
    private visorDistPath;
    constructor(name: string, config: SandboxConfig, repoPath: string, visorDistPath: string);
    /**
     * Check if sandbox-exec binary is available on the system.
     */
    static isAvailable(): Promise<boolean>;
    /**
     * Execute a command inside a macOS seatbelt sandbox.
     * Each exec creates a fresh sandbox process — no persistent container.
     */
    exec(options: SandboxExecOptions): Promise<SandboxExecResult>;
    /**
     * No-op: sandbox-exec processes are ephemeral (no persistent container to stop).
     */
    stop(): Promise<void>;
    /**
     * Escape a path for use inside an SBPL profile string.
     * Escapes backslashes and double quotes.
     */
    private escapePath;
    /**
     * Build the SBPL (Seatbelt Profile Language) profile string.
     */
    private buildProfile;
}
//# sourceMappingURL=seatbelt-sandbox.d.ts.map