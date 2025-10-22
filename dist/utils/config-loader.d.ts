import { VisorConfig } from '../types/config';
/**
 * Configuration source types
 */
export declare enum ConfigSourceType {
    LOCAL = "local",
    REMOTE = "remote",
    DEFAULT = "default"
}
/**
 * Options for loading configurations
 */
export interface ConfigLoaderOptions {
    /** Base directory for resolving relative paths */
    baseDir?: string;
    /** Whether to allow remote extends (default: true) */
    allowRemote?: boolean;
    /** Cache TTL in milliseconds (default: 5 minutes) */
    cacheTTL?: number;
    /** Request timeout in milliseconds (default: 30 seconds) */
    timeout?: number;
    /** Maximum recursion depth (default: 10) */
    maxDepth?: number;
    /** Allowed remote URL patterns (default: ['https://github.com/', 'https://raw.githubusercontent.com/']) */
    allowedRemotePatterns?: string[];
    /** Project root directory for path traversal protection */
    projectRoot?: string;
}
/**
 * Utility class for loading configurations from various sources
 */
export declare class ConfigLoader {
    private options;
    private cache;
    private loadedConfigs;
    constructor(options?: ConfigLoaderOptions);
    /**
     * Determine the source type from a string
     */
    private getSourceType;
    /**
     * Fetch configuration from any source
     */
    fetchConfig(source: string, currentDepth?: number): Promise<Partial<VisorConfig>>;
    /**
     * Normalize source path/URL for comparison
     */
    private normalizeSource;
    /**
     * Load configuration from local file system
     */
    private fetchLocalConfig;
    /**
     * Fetch configuration from remote URL
     */
    private fetchRemoteConfig;
    /**
     * Load bundled default configuration
     */
    private fetchDefaultConfig;
    /**
     * Process extends directive in a configuration
     */
    private processExtends;
    /**
     * Find project root directory (for security validation)
     */
    private findProjectRoot;
    /**
     * Validate remote URL against allowlist
     */
    private validateRemoteURL;
    /**
     * Validate local path against traversal attacks
     */
    private validateLocalPath;
    /**
     * Find package root directory
     */
    private findPackageRoot;
    /**
     * Clear the configuration cache
     */
    clearCache(): void;
    /**
     * Reset the loaded configs tracking (for testing)
     */
    reset(): void;
    /**
     * Normalize 'checks' and 'steps' keys for backward compatibility
     * Ensures both keys are present and contain the same data
     */
    private normalizeStepsAndChecks;
}
//# sourceMappingURL=config-loader.d.ts.map