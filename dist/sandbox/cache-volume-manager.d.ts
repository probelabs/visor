/**
 * Docker named volume management for sandbox caching.
 * Creates, resolves, and evicts cache volumes based on sandbox configuration.
 */
import { SandboxCacheConfig } from './types';
export interface ResolvedVolume {
    /** Docker volume name */
    volumeName: string;
    /** Mount spec for docker run -v flag: "volumeName:containerPath" */
    mountSpec: string;
}
export declare class CacheVolumeManager {
    /**
     * Resolve cache config into Docker volume mount specs.
     *
     * Volume naming: visor-cache-<prefix>-<sandboxName>-<pathHash>
     *
     * @param sandboxName - Name of the sandbox
     * @param cacheConfig - Cache configuration from sandbox config
     * @param gitBranch - Current git branch (used as default prefix)
     * @returns Array of volume mount specs for docker run -v
     */
    resolveVolumes(sandboxName: string, cacheConfig: SandboxCacheConfig, gitBranch: string): Promise<ResolvedVolume[]>;
    /**
     * Check if a Docker volume exists
     */
    private volumeExists;
    /**
     * Create a Docker named volume
     */
    private createVolume;
    /**
     * Copy data from one volume to another using a temp container
     */
    private copyVolume;
    /**
     * Update the last-used label on a volume.
     * Docker doesn't support updating labels in-place, so we record via a temp file approach
     * by simply re-creating volumes with updated labels if they don't exist.
     * For existing volumes, we track usage time via the volume name pattern.
     */
    private touchVolume;
    /**
     * Evict expired cache volumes for a sandbox
     */
    evictExpired(sandboxName: string, ttl?: string, maxScopes?: number): Promise<void>;
}
//# sourceMappingURL=cache-volume-manager.d.ts.map