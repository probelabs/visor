/**
 * SandboxManager — lifecycle management for sandbox environments.
 * Handles lazy container/process startup, reuse, exec routing, and cleanup.
 * Supports Docker (image, compose), Bubblewrap (Linux namespaces), and Seatbelt (macOS sandbox-exec) engines.
 */

import { resolve, dirname, join } from 'path';
import { existsSync } from 'fs';
import { SandboxConfig, SandboxInstance, SandboxExecOptions, SandboxExecResult } from './types';
import { DockerImageSandbox } from './docker-image-sandbox';
import { DockerComposeSandbox } from './docker-compose-sandbox';
import { CacheVolumeManager } from './cache-volume-manager';
import { logger } from '../logger';
import { withActiveSpan, addEvent } from './sandbox-telemetry';

export class SandboxManager {
  private sandboxDefs: Record<string, SandboxConfig>;
  private repoPath: string;
  private gitBranch: string;
  private instances: Map<string, SandboxInstance> = new Map();
  private cacheManager: CacheVolumeManager;
  private visorDistPath: string;

  /** Get the resolved repository path (used by trace file relay) */
  getRepoPath(): string {
    return this.repoPath;
  }

  constructor(sandboxDefs: Record<string, SandboxConfig>, repoPath: string, gitBranch: string) {
    this.sandboxDefs = sandboxDefs;
    this.repoPath = resolve(repoPath);
    this.gitBranch = gitBranch;
    this.cacheManager = new CacheVolumeManager();

    // Visor dist path: the directory containing index.js (the ncc bundle)
    // ncc bundle: __dirname = <project>/dist (index.js is here)
    // unbundled:  __dirname = <project>/dist/sandbox → parent has index.js
    this.visorDistPath = existsSync(join(__dirname, 'index.js'))
      ? __dirname
      : resolve(dirname(__dirname));
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

    const mode = config.compose ? 'compose' : 'image';

    // Bubblewrap engine: ephemeral per-exec, no persistent container
    if (config.engine === 'bubblewrap') {
      const { BubblewrapSandbox } = require('./bubblewrap-sandbox');
      const instance = new BubblewrapSandbox(name, config, this.repoPath, this.visorDistPath);
      this.instances.set(name, instance);
      return instance;
    }

    // Seatbelt engine: macOS sandbox-exec, ephemeral per-exec
    if (config.engine === 'seatbelt') {
      const { SeatbeltSandbox } = require('./seatbelt-sandbox');
      const instance = new SeatbeltSandbox(name, config, this.repoPath, this.visorDistPath);
      this.instances.set(name, instance);
      return instance;
    }

    return withActiveSpan(
      'visor.sandbox.start',
      {
        'visor.sandbox.name': name,
        'visor.sandbox.mode': mode,
      },
      async () => {
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
            const volumes = await this.cacheManager.resolveVolumes(
              name,
              config.cache,
              this.gitBranch
            );
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
    );
  }

  /**
   * Execute a command inside a named sandbox
   */
  async exec(name: string, options: SandboxExecOptions): Promise<SandboxExecResult> {
    const instance = await this.getOrStart(name);
    return withActiveSpan(
      'visor.sandbox.exec',
      {
        'visor.sandbox.name': name,
      },
      async (span: any) => {
        const result = await instance.exec(options);
        try {
          span.setAttribute('visor.sandbox.exit_code', result.exitCode);
        } catch {}
        return result;
      }
    );
  }

  /**
   * Stop all running sandbox instances and run cache eviction
   */
  async stopAll(): Promise<void> {
    return withActiveSpan('visor.sandbox.stopAll', undefined, async () => {
      const stopPromises = Array.from(this.instances.entries()).map(async ([name, instance]) => {
        try {
          await instance.stop();
          addEvent('visor.sandbox.stopped', { 'visor.sandbox.name': name });
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
    });
  }
}
