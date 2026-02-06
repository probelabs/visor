/**
 * SandboxManager — lifecycle management for Docker sandbox environments.
 * Handles lazy container startup, reuse, exec routing, and cleanup.
 */

import { resolve, dirname } from 'path';
import { SandboxConfig, SandboxInstance, SandboxExecOptions, SandboxExecResult } from './types';
import { DockerImageSandbox } from './docker-image-sandbox';
import { DockerComposeSandbox } from './docker-compose-sandbox';
import { CacheVolumeManager } from './cache-volume-manager';
import { logger } from '../logger';

export class SandboxManager {
  private sandboxDefs: Record<string, SandboxConfig>;
  private repoPath: string;
  private gitBranch: string;
  private instances: Map<string, SandboxInstance> = new Map();
  private cacheManager: CacheVolumeManager;
  private visorDistPath: string;

  constructor(sandboxDefs: Record<string, SandboxConfig>, repoPath: string, gitBranch: string) {
    this.sandboxDefs = sandboxDefs;
    this.repoPath = resolve(repoPath);
    this.gitBranch = gitBranch;
    this.cacheManager = new CacheVolumeManager();

    // Visor dist path: the directory containing this compiled JS file's parent
    // In development: <project>/dist/sandbox/sandbox-manager.js → <project>/dist
    // We mount the parent of 'dist' along with node_modules
    this.visorDistPath = resolve(dirname(__dirname));
  }

  /**
   * Resolve which sandbox a check should use.
   * Returns null if the check should run on the host.
   *
   * Resolution order:
   * 1. Check-level sandbox: (explicit override)
   * 2. Workspace-level sandbox: (default)
   * 3. null → run on host
   */
  resolveSandbox(
    checkSandbox: string | undefined,
    workspaceDefault: string | undefined
  ): string | null {
    const name = checkSandbox || workspaceDefault;
    if (!name) return null;

    if (!this.sandboxDefs[name]) {
      throw new Error(`Sandbox '${name}' is not defined in sandboxes configuration`);
    }

    return name;
  }

  /**
   * Get or lazily start a sandbox instance by name.
   */
  async getOrStart(name: string): Promise<SandboxInstance> {
    const existing = this.instances.get(name);
    if (existing) return existing;

    const config = this.sandboxDefs[name];
    if (!config) {
      throw new Error(`Sandbox '${name}' is not defined`);
    }

    let instance: SandboxInstance;

    if (config.compose) {
      // Compose mode
      const composeSandbox = new DockerComposeSandbox(name, config);
      await composeSandbox.start();
      instance = composeSandbox;
    } else {
      // Image / Dockerfile mode
      // Resolve cache volumes
      let cacheVolumeMounts: string[] = [];
      if (config.cache) {
        const volumes = await this.cacheManager.resolveVolumes(name, config.cache, this.gitBranch);
        cacheVolumeMounts = volumes.map(v => v.mountSpec);
      }

      const imageSandbox = new DockerImageSandbox(
        name,
        config,
        this.repoPath,
        this.visorDistPath,
        cacheVolumeMounts
      );
      await imageSandbox.start();
      instance = imageSandbox;
    }

    this.instances.set(name, instance);
    return instance;
  }

  /**
   * Execute a command inside a named sandbox
   */
  async exec(name: string, options: SandboxExecOptions): Promise<SandboxExecResult> {
    const instance = await this.getOrStart(name);
    return instance.exec(options);
  }

  /**
   * Stop all running sandbox instances and run cache eviction
   */
  async stopAll(): Promise<void> {
    const stopPromises = Array.from(this.instances.entries()).map(async ([name, instance]) => {
      try {
        await instance.stop();
        logger.info(`Stopped sandbox '${name}'`);
      } catch (err) {
        logger.warn(`Failed to stop sandbox '${name}': ${err}`);
      }

      // Run cache eviction
      const config = this.sandboxDefs[name];
      if (config?.cache) {
        try {
          await this.cacheManager.evictExpired(name, config.cache.ttl, config.cache.max_scopes);
        } catch {
          // Non-fatal
        }
      }
    });

    await Promise.allSettled(stopPromises);
    this.instances.clear();
  }
}
