import { VisorConfig, EnvironmentOverrides, MergedConfig, ConfigLoadOptions } from './types/config';
import { CliOptions } from './types/cli';
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
     * Find and load configuration from default locations
     */
    findAndLoadConfig(): Promise<VisorConfig>;
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
     */
    private validateConfig;
    /**
     * Validate individual check configuration
     */
    private validateCheckConfig;
    /**
     * Validate output configuration
     */
    private validateOutputConfig;
    /**
     * Merge configuration with default values
     */
    private mergeWithDefaults;
}
//# sourceMappingURL=config.d.ts.map