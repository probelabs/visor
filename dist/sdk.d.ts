import type { AnalysisResult } from './output-formatters';
import type { VisorConfig, TagFilter, HumanInputRequest } from './types/config';
import type { ExecutionContext } from './providers/check-provider.interface';
export type { VisorConfig, TagFilter, HumanInputRequest, ExecutionContext };
export interface VisorOptions {
    cwd?: string;
    debug?: boolean;
    maxParallelism?: number;
    failFast?: boolean;
    tagFilter?: TagFilter;
}
export interface RunOptions extends VisorOptions {
    config?: VisorConfig;
    configPath?: string;
    checks?: string[];
    timeoutMs?: number;
    output?: {
        format?: 'table' | 'json' | 'markdown' | 'sarif';
    };
    /** Strict mode: treat config warnings (like unknown keys) as errors (default: false) */
    strictValidation?: boolean;
    /** Execution context for providers (CLI message, hooks, etc.) */
    executionContext?: ExecutionContext;
}
/**
 * Load and validate a Visor config.
 * @param configOrPath - Config object, file path, or omit to discover defaults
 * @param options - Validation options
 * @returns Validated config with defaults applied
 */
export declare function loadConfig(configOrPath?: string | Partial<VisorConfig>, options?: {
    strict?: boolean;
}): Promise<VisorConfig>;
/** Expand check IDs by including their dependencies (shallow->deep). */
export declare function resolveChecks(checkIds: string[], config: VisorConfig | undefined): string[];
/**
 * Run Visor checks programmatically. Returns the same AnalysisResult shape used by the CLI.
 * Thin wrapper around CheckExecutionEngine.executeChecks.
 */
export declare function runChecks(opts?: RunOptions): Promise<AnalysisResult>;
