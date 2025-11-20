import { VisorConfig, EventTrigger, EnvironmentOverrides, MergedConfig, ConfigLoadOptions } from './types/config';
import { CliOptions } from './types/cli';
/**
 * Valid event triggers for checks
 * Exported as a constant to serve as the single source of truth for event validation
 */
export declare const VALID_EVENT_TRIGGERS: readonly EventTrigger[];
/**
 * Configuration manager for Visor
 */
export declare class ConfigManager {
    private validCheckTypes;
    private validEventTriggers;
    private validOutputFormats;
    private validGroupByOptions;
    /**
     * Load configuration from a file
     */
    loadConfig(configPath: string, options?: ConfigLoadOptions): Promise<VisorConfig>;
    /**
     * Load configuration from an in-memory object (used by the test runner to
     * handle co-located config + tests without writing temp files).
     */
    loadConfigFromObject(obj: Partial<VisorConfig>, options?: ConfigLoadOptions & {
        baseDir?: string;
    }): Promise<VisorConfig>;
    /**
     * Find and load configuration from default locations
     */
    findAndLoadConfig(options?: ConfigLoadOptions): Promise<VisorConfig>;
    /**
     * Find the git repository root directory
     */
    private findGitRepositoryRoot;
    /**
     * Get default configuration
     */
    getDefaultConfig(): Promise<VisorConfig>;
    /**
     * Load bundled default configuration from the package
     */
    loadBundledDefaultConfig(): VisorConfig | null;
    /**
     * Find the root directory of the Visor package
     */
    private findPackageRoot;
    /**
     * Convert a workflow definition file to a visor config
     * When a workflow YAML is run standalone, register the workflow and use its tests as checks
     */
    private convertWorkflowToConfig;
    /**
     * Load and register workflows from configuration
     */
    private loadWorkflows;
    /**
     * Normalize 'checks' and 'steps' keys for backward compatibility
     * Ensures both keys are present and contain the same data
     */
    private normalizeStepsAndChecks;
    /**
     * Merge configuration with CLI options
     */
    mergeWithCliOptions(config: Partial<VisorConfig>, cliOptions: CliOptions): MergedConfig;
    /**
     * Load configuration with environment variable overrides
     */
    loadConfigWithEnvOverrides(): Promise<{
        config?: VisorConfig;
        environmentOverrides: EnvironmentOverrides;
    }>;
    /**
     * Validate configuration against schema
     * @param config The config to validate
     * @param strict If true, treat warnings as errors (default: false)
     */
    validateConfig(config: Partial<VisorConfig>, strict?: boolean): void;
    /**
     * Validate individual check configuration
     */
    private validateCheckConfig;
    /**
     * Validate MCP servers object shape and values (basic shape only)
     */
    private validateMcpServersObject;
    /**
     * Validate configuration using generated JSON Schema via Ajv, if available.
     * Adds to errors/warnings but does not throw directly.
     */
    private validateWithAjvSchema;
    /**
     * Validate tag filter configuration
     */
    private validateTagFilter;
    /**
     * Validate HTTP server configuration
     */
    private validateHttpServerConfig;
    /**
     * Validate output configuration
     */
    private validateOutputConfig;
    /**
     * Check if remote extends are allowed
     */
    private isRemoteExtendsAllowed;
    /**
     * Merge configuration with default values
     */
    private mergeWithDefaults;
}
