import { VisorConfig, CheckConfig } from '../types/config';
/**
 * Utility class for merging Visor configurations with proper override semantics
 */
export declare class ConfigMerger {
    /**
     * Merge two configurations with child overriding parent
     * @param parent - Base configuration
     * @param child - Configuration to merge on top
     * @returns Merged configuration
     */
    merge(parent: Partial<VisorConfig>, child: Partial<VisorConfig>): Partial<VisorConfig>;
    /**
     * Deep copy an object
     */
    private deepCopy;
    /**
     * Merge two objects (child overrides parent)
     */
    private mergeObjects;
    /**
     * Merge output configurations
     */
    private mergeOutputConfig;
    /**
     * Merge check configurations with special handling
     */
    private mergeChecks;
    /**
     * Merge individual check configurations
     */
    private mergeCheckConfig;
    /**
     * Check if a check is disabled (has empty 'on' array)
     */
    isCheckDisabled(check: CheckConfig): boolean;
    /**
     * Remove disabled checks from the configuration
     */
    removeDisabledChecks(config: Partial<VisorConfig>): Partial<VisorConfig>;
}
//# sourceMappingURL=config-merger.d.ts.map