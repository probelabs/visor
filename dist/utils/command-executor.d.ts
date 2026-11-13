export interface CommandExecutionOptions {
    stdin?: string;
    cwd?: string;
    env?: Record<string, string>;
    timeout?: number;
}
export interface CommandExecutionResult {
    stdout: string;
    stderr: string;
    exitCode: number;
}
/**
 * Shared utility for executing shell commands
 * Used by both CommandCheckProvider and CustomToolExecutor
 */
export declare class CommandExecutor {
    private static instance;
    private constructor();
    static getInstance(): CommandExecutor;
    /**
     * Execute a shell command with optional stdin, environment, and timeout
     */
    execute(command: string, options?: CommandExecutionOptions): Promise<CommandExecutionResult>;
    /**
     * A too-large exec command fails before a shell is spawned, so replaying the
     * exact command from an owned script cannot duplicate command side effects.
     * Also strips the env to essential vars to avoid a second E2BIG from a bloated env.
     */
    private executeE2BigFallback;
    /**
     * Strip env to essential variables needed for most child processes.
     * Used when the full env exceeds safe spawn limits.
     */
    static stripEnvToEssentials(env: NodeJS.ProcessEnv | Record<string, string | undefined>): NodeJS.ProcessEnv;
    private isE2Big;
    /**
     * Execute command with stdin input
     */
    private executeWithStdin;
    /**
     * Handle execution errors consistently
     */
    private handleExecutionError;
    /**
     * Build safe environment variables by merging process.env with custom env
     * Ensures all values are strings (no undefined)
     */
    buildEnvironment(baseEnv?: NodeJS.ProcessEnv, ...customEnvs: Array<Record<string, string> | undefined>): Record<string, string>;
    /**
     * Log command execution for debugging
     */
    logExecution(command: string, options: CommandExecutionOptions): void;
}
export declare const commandExecutor: CommandExecutor;
//# sourceMappingURL=command-executor.d.ts.map