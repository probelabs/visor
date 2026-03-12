/**
 * SandboxManager — lifecycle management for sandbox environments.
 * Handles lazy container/process startup, reuse, exec routing, and cleanup.
 * Supports Docker (image, compose), Bubblewrap (Linux namespaces), and Seatbelt (macOS sandbox-exec) engines.
 */

import { resolve, dirname, join } from 'path';
import { existsSync, unlinkSync } from 'fs';
import {
  SandboxConfig,
  SandboxInstance,
  SandboxExecOptions,
  SandboxExecResult,
  ProjectServiceConfig,
  ProjectEnvironment,
} from './types';
import { DockerImageSandbox } from './docker-image-sandbox';
import { DockerComposeSandbox } from './docker-compose-sandbox';
import { CacheVolumeManager } from './cache-volume-manager';
import { generateComposeFile } from './compose-generator';
import { logger } from '../logger';
import { withActiveSpan, addEvent, setSpanError } from './sandbox-telemetry';

export class SandboxManager {
  private sandboxDefs: Record<string, SandboxConfig>;
  private repoPath: string;
  private gitBranch: string;
  private instances: Map<string, SandboxInstance> = new Map();
  private projectEnvironments: Map<string, ProjectEnvironment> = new Map();
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
   * Start project-level services (redis, postgres, etc.) via docker-compose.
   * Generates a compose file, starts services, and returns endpoint info.
   */
  async startProjectServices(
    projectId: string,
    services: Record<string, ProjectServiceConfig>,
    sandboxName: string | undefined,
    sessionId: string,
    workspacePath: string
  ): Promise<ProjectEnvironment> {
    const existing = this.projectEnvironments.get(projectId);
    if (existing?.started) return existing;

    return withActiveSpan(
      'visor.sandbox.startProjectServices',
      { 'visor.project.id': projectId },
      async () => {
        const outputDir = join(workspacePath, '.visor');
        const sandboxConfig = sandboxName ? this.sandboxDefs[sandboxName] : undefined;
        const result = await generateComposeFile({
          projectId,
          sessionId,
          services,
          workspaceSandbox: sandboxConfig,
          workspacePath,
          visorDistPath: this.visorDistPath,
          outputDir,
        });

        // Start compose services
        const composeSandbox = new DockerComposeSandbox(`project-${projectId}`, {
          compose: result.filePath,
          service: result.serviceName,
        });
        await composeSandbox.start();

        // Register so exec() works through existing sandbox machinery
        this.instances.set(`project-${projectId}`, composeSandbox);

        const env: ProjectEnvironment = {
          projectId,
          composeFilePath: result.filePath,
          projectName: result.projectName,
          serviceName: result.serviceName,
          serviceEndpoints: result.serviceEndpoints,
          started: true,
        };

        this.projectEnvironments.set(projectId, env);
        addEvent('visor.sandbox.projectServices.started', {
          'visor.project.id': projectId,
          'visor.project.services': Object.keys(services).join(','),
        });
        logger.info(
          `Started project services for '${projectId}': ${Object.keys(services).join(', ')}`
        );
        return env;
      }
    );
  }

  /**
   * Stop services for a specific project
   */
  async stopProjectServices(projectId: string): Promise<void> {
    const env = this.projectEnvironments.get(projectId);
    if (!env?.started) return;

    return withActiveSpan(
      'visor.sandbox.stopProjectServices',
      { 'visor.project.id': projectId },
      async () => {
        const instanceKey = `project-${projectId}`;
        const instance = this.instances.get(instanceKey);
        if (instance) {
          try {
            await instance.stop();
            this.instances.delete(instanceKey);
          } catch (err) {
            setSpanError(err);
            logger.warn(`Failed to stop project services for '${projectId}': ${err}`);
          }
        }

        // Clean up generated compose file
        try {
          unlinkSync(env.composeFilePath);
        } catch {
          // Non-fatal
        }

        env.started = false;
        this.projectEnvironments.delete(projectId);
        addEvent('visor.sandbox.projectServices.stopped', { 'visor.project.id': projectId });
        logger.info(`Stopped project services for '${projectId}'`);
      }
    );
  }

  /**
   * Get the project environment (if started) for env var injection
   */
  getProjectEnvironment(projectId: string): ProjectEnvironment | undefined {
    return this.projectEnvironments.get(projectId);
  }

  /**
   * Generate environment variables from a ProjectEnvironment's service endpoints.
   * Produces {SERVICE_NAME}_HOST and {SERVICE_NAME}_PORT for each service.
   * E.g., redis → REDIS_HOST=redis, REDIS_PORT=6379
   */
  static generateServiceEnvVars(env: ProjectEnvironment): Record<string, string> {
    const vars: Record<string, string> = {};
    for (const [serviceName, endpoint] of Object.entries(env.serviceEndpoints)) {
      const prefix = serviceName.replace(/[^a-zA-Z0-9]/g, '_').toUpperCase();
      vars[`${prefix}_HOST`] = endpoint.host;
      vars[`${prefix}_PORT`] = String(endpoint.port);
    }
    return vars;
  }

  /**
   * Stop all running sandbox instances and run cache eviction
   */
  async stopAll(): Promise<void> {
    return withActiveSpan('visor.sandbox.stopAll', undefined, async () => {
      // Stop all project service environments first
      const projectStopPromises = Array.from(this.projectEnvironments.keys()).map(
        async projectId => {
          try {
            await this.stopProjectServices(projectId);
          } catch (err) {
            logger.warn(`Failed to stop project services for '${projectId}': ${err}`);
          }
        }
      );
      await Promise.allSettled(projectStopPromises);

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
