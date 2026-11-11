/**
 * Environment variable filtering for sandbox execution.
 * Filters host environment variables based on passthrough patterns
 * before forwarding them into sandbox containers.
 */
/** Built-in env vars forwarded into sandboxes (used when no workspace defaults are set) */
export declare const BUILTIN_PASSTHROUGH: string[];
/**
 * Filter environment variables for sandbox forwarding.
 *
 * @param checkEnv - Check-level env overrides (always included)
 * @param hostEnv - Host process.env to filter
 * @param passthroughPatterns - Glob patterns from sandbox config env_passthrough
 * @param defaultPatterns - Workspace-level defaults from sandbox_defaults.env_passthrough
 *                          (replaces BUILTIN_PASSTHROUGH when provided)
 * @returns Merged environment variables safe for the sandbox
 */
export declare function filterEnvForSandbox(checkEnv: Record<string, string | number | boolean> | undefined, hostEnv: Record<string, string | undefined>, passthroughPatterns?: string[], defaultPatterns?: string[]): Record<string, string>;
//# sourceMappingURL=env-filter.d.ts.map