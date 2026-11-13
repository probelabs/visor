/**
 * Environment variable resolution utilities
 * Supports GitHub Actions-like syntax for referencing environment variables
 */
import { EnvConfig } from '../types/config';
/**
 * Resolves environment variables in configuration values
 * Supports the following syntaxes:
 * - ${{ env.VARIABLE_NAME }} (GitHub Actions style)
 * - ${VARIABLE_NAME} (shell style)
 * - $VARIABLE_NAME (simple shell style)
 * - Direct environment variable names
 */
export declare class EnvironmentResolver {
    /**
     * Resolves a single configuration value that may contain environment variable references
     */
    static resolveValue(value: string | number | boolean): string | number | boolean;
    /**
     * Resolves all environment variables in an EnvConfig object
     */
    static resolveEnvConfig(envConfig: EnvConfig): EnvConfig;
    /**
     * Applies environment configuration to the process environment
     * This allows checks to access their specific environment variables
     */
    static applyEnvConfig(envConfig: EnvConfig): void;
    /**
     * Creates a temporary environment for a specific check execution
     * Returns a cleanup function to restore the original environment
     */
    static withTemporaryEnv<T>(envConfig: EnvConfig, callback: () => T | Promise<T>): T | Promise<T>;
    /**
     * Validates that all required environment variables are available
     */
    static validateRequiredEnvVars(envConfig: EnvConfig, requiredVars: string[]): string[];
    /**
     * Resolves environment variables in HTTP headers
     * Each header value is processed through resolveValue to replace env var references
     */
    static resolveHeaders(headers: Record<string, string>): Record<string, string>;
    /**
     * Sanitizes headers for logging/telemetry by redacting sensitive values
     * Headers like Authorization, API keys, and cookies are replaced with [REDACTED]
     */
    static sanitizeHeaders(headers: Record<string, string>): Record<string, string>;
}
//# sourceMappingURL=env-resolver.d.ts.map