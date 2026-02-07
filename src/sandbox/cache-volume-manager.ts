/**
 * Docker named volume management for sandbox caching.
 * Creates, resolves, and evicts cache volumes based on sandbox configuration.
 */

import { promisify } from 'util';
import { execFile as execFileCb } from 'child_process';
import { createHash } from 'crypto';
import { SandboxCacheConfig } from './types';
import { logger } from '../logger';

const execFileAsync = promisify(execFileCb);
const EXEC_MAX_BUFFER = 10 * 1024 * 1024;

/**
 * Compute a short hash for a container path to use in volume names
 */
function pathHash(containerPath: string): string {
  return createHash('sha256').update(containerPath).digest('hex').slice(0, 8);
}

/**
 * Parse a TTL string (e.g., "7d", "24h", "1h30m") into milliseconds
 */
function parseTtl(ttl: string): number {
  let ms = 0;
  const dayMatch = ttl.match(/(\d+)d/);
  const hourMatch = ttl.match(/(\d+)h/);
  const minMatch = ttl.match(/(\d+)m/);

  if (dayMatch) ms += parseInt(dayMatch[1], 10) * 86400000;
  if (hourMatch) ms += parseInt(hourMatch[1], 10) * 3600000;
  if (minMatch) ms += parseInt(minMatch[1], 10) * 60000;

  return ms || 604800000; // default 7 days
}

export interface ResolvedVolume {
  /** Docker volume name */
  volumeName: string;
  /** Mount spec for docker run -v flag: "volumeName:containerPath" */
  mountSpec: string;
}

export class CacheVolumeManager {
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
  async resolveVolumes(
    sandboxName: string,
    cacheConfig: SandboxCacheConfig,
    gitBranch: string
  ): Promise<ResolvedVolume[]> {
    const prefix = (cacheConfig.prefix || gitBranch).replace(/[^a-zA-Z0-9._-]/g, '-');
    const volumes: ResolvedVolume[] = [];

    for (const containerPath of cacheConfig.paths) {
      // Reject path traversal attempts (absolute-path check is in config validation)
      if (/\.\./.test(containerPath)) {
        throw new Error(`Cache path '${containerPath}' must not contain '..' path traversal`);
      }
      const hash = pathHash(containerPath);
      const volumeName = `visor-cache-${prefix}-${sandboxName}-${hash}`;

      // Check if volume exists
      const exists = await this.volumeExists(volumeName);

      if (!exists && cacheConfig.fallback_prefix) {
        // Try to copy from fallback prefix volume
        const fallbackPrefix = cacheConfig.fallback_prefix.replace(/[^a-zA-Z0-9._-]/g, '-');
        const fallbackVolume = `visor-cache-${fallbackPrefix}-${sandboxName}-${hash}`;
        const fallbackExists = await this.volumeExists(fallbackVolume);

        if (fallbackExists) {
          logger.info(`Cache miss for '${volumeName}', copying from fallback '${fallbackVolume}'`);
          await this.copyVolume(fallbackVolume, volumeName);
        } else {
          // Create empty volume
          await this.createVolume(volumeName);
        }
      } else if (!exists) {
        await this.createVolume(volumeName);
      }

      // Update last-used label
      await this.touchVolume(volumeName);

      volumes.push({
        volumeName,
        mountSpec: `${volumeName}:${containerPath}`,
      });
    }

    return volumes;
  }

  /**
   * Check if a Docker volume exists
   */
  private async volumeExists(name: string): Promise<boolean> {
    try {
      await execFileAsync('docker', ['volume', 'inspect', name], {
        maxBuffer: EXEC_MAX_BUFFER,
        timeout: 10000,
      });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Create a Docker named volume
   */
  private async createVolume(name: string): Promise<void> {
    const now = new Date().toISOString();
    await execFileAsync('docker', ['volume', 'create', '--label', `visor.last-used=${now}`, name], {
      maxBuffer: EXEC_MAX_BUFFER,
      timeout: 10000,
    });
  }

  /**
   * Copy data from one volume to another using a temp container
   */
  private async copyVolume(source: string, target: string): Promise<void> {
    await this.createVolume(target);
    try {
      await execFileAsync(
        'docker',
        [
          'run',
          '--rm',
          '-v',
          `${source}:/src:ro`,
          '-v',
          `${target}:/dst`,
          'alpine',
          'sh',
          '-c',
          'cp -a /src/. /dst/',
        ],
        { maxBuffer: EXEC_MAX_BUFFER, timeout: 60000 }
      );
    } catch (err) {
      logger.warn(`Failed to copy cache volume ${source} -> ${target}: ${err}`);
    }
  }

  /**
   * Update the last-used label on a volume.
   * Docker doesn't support updating labels in-place, so we record via a temp file approach
   * by simply re-creating volumes with updated labels if they don't exist.
   * For existing volumes, we track usage time via the volume name pattern.
   */
  private async touchVolume(_name: string): Promise<void> {
    // Docker volume labels are immutable after creation.
    // We track last-used via inspection of volume creation time
    // and access patterns. This is a no-op for simplicity;
    // eviction uses volume creation/inspection metadata instead.
  }

  /**
   * Evict expired cache volumes for a sandbox
   */
  async evictExpired(sandboxName: string, ttl?: string, maxScopes?: number): Promise<void> {
    const ttlMs = ttl ? parseTtl(ttl) : 604800000; // 7 days default
    const maxScopesLimit = maxScopes || 10;

    try {
      // List all visor cache volumes for this sandbox
      const { stdout } = await execFileAsync(
        'docker',
        ['volume', 'ls', '--filter', 'name=visor-cache-', '--format', '{{.Name}}'],
        { maxBuffer: EXEC_MAX_BUFFER, timeout: 10000 }
      );

      const allVolumes = stdout.trim().split('\n').filter(Boolean);
      const sandboxVolumes = allVolumes.filter(v => v.includes(`-${sandboxName}-`));

      if (sandboxVolumes.length === 0) return;

      // Group by prefix (scope)
      const scopeMap = new Map<string, string[]>();
      for (const vol of sandboxVolumes) {
        // visor-cache-<prefix>-<sandboxName>-<hash>
        const match = vol.match(/^visor-cache-(.+)-\w{8}$/);
        if (match) {
          const prefix = match[1].replace(`-${sandboxName}`, '');
          if (!scopeMap.has(prefix)) scopeMap.set(prefix, []);
          scopeMap.get(prefix)!.push(vol);
        }
      }

      // Check each volume's creation time for TTL expiry
      const now = Date.now();
      for (const vol of sandboxVolumes) {
        try {
          const { stdout: inspectOut } = await execFileAsync(
            'docker',
            ['volume', 'inspect', vol, '--format', '{{.CreatedAt}}'],
            { maxBuffer: EXEC_MAX_BUFFER, timeout: 10000 }
          );
          const createdAt = new Date(inspectOut.trim()).getTime();
          if (now - createdAt > ttlMs) {
            logger.info(`Evicting expired cache volume: ${vol}`);
            await execFileAsync('docker', ['volume', 'rm', vol], {
              maxBuffer: EXEC_MAX_BUFFER,
              timeout: 10000,
            });
          }
        } catch {
          // Skip volumes we can't inspect
        }
      }

      // Enforce max_scopes by removing oldest scopes
      if (scopeMap.size > maxScopesLimit) {
        const scopes = Array.from(scopeMap.keys());
        // Remove excess scopes (keep newest by alphabetical order as proxy)
        const toRemove = scopes.slice(0, scopes.length - maxScopesLimit);
        for (const scope of toRemove) {
          const vols = scopeMap.get(scope) || [];
          for (const vol of vols) {
            try {
              logger.info(`Evicting cache volume (max_scopes exceeded): ${vol}`);
              await execFileAsync('docker', ['volume', 'rm', vol], {
                maxBuffer: EXEC_MAX_BUFFER,
                timeout: 10000,
              });
            } catch {
              /* ignore */
            }
          }
        }
      }
    } catch {
      // Docker volume listing failed - skip eviction
    }
  }
}
