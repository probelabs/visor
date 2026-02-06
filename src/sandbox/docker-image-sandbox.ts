/**
 * Docker image-based sandbox implementation.
 * Supports three modes: pre-built image, Dockerfile, and inline Dockerfile.
 */

import { promisify } from 'util';
import { exec as execCb } from 'child_process';
import { writeFileSync, unlinkSync, mkdtempSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { SandboxConfig, SandboxExecOptions, SandboxExecResult, SandboxInstance } from './types';
import { logger } from '../logger';

const execAsync = promisify(execCb);

const EXEC_MAX_BUFFER = 50 * 1024 * 1024; // 50MB

export class DockerImageSandbox implements SandboxInstance {
  name: string;
  config: SandboxConfig;
  private containerId: string | null = null;
  private containerName: string;
  private repoPath: string;
  private visorDistPath: string;
  private cacheVolumeMounts: string[];

  constructor(
    name: string,
    config: SandboxConfig,
    repoPath: string,
    visorDistPath: string,
    cacheVolumeMounts: string[] = []
  ) {
    this.name = name;
    this.config = config;
    this.repoPath = repoPath;
    this.visorDistPath = visorDistPath;
    this.containerName = `visor-${name}-${randomUUID().slice(0, 8)}`;
    this.cacheVolumeMounts = cacheVolumeMounts;
  }

  /**
   * Build the Docker image if needed (dockerfile or dockerfile_inline mode)
   */
  private async buildImageIfNeeded(): Promise<string> {
    if (this.config.image) {
      return this.config.image;
    }

    const imageName = `visor-sandbox-${this.name}`;

    if (this.config.dockerfile_inline) {
      // Write inline Dockerfile to temp file
      const tmpDir = mkdtempSync(join(tmpdir(), 'visor-build-'));
      const dockerfilePath = join(tmpDir, 'Dockerfile');
      writeFileSync(dockerfilePath, this.config.dockerfile_inline, 'utf8');

      try {
        logger.info(`Building sandbox image '${imageName}' from inline Dockerfile`);
        await execAsync(`docker build -t ${imageName} -f ${dockerfilePath} ${this.repoPath}`, {
          maxBuffer: EXEC_MAX_BUFFER,
          timeout: 300000,
        });
      } finally {
        try {
          unlinkSync(dockerfilePath);
        } catch {
          /* ignore */
        }
      }

      return imageName;
    }

    if (this.config.dockerfile) {
      logger.info(`Building sandbox image '${imageName}' from ${this.config.dockerfile}`);
      await execAsync(
        `docker build -t ${imageName} -f ${this.config.dockerfile} ${this.repoPath}`,
        { maxBuffer: EXEC_MAX_BUFFER, timeout: 300000 }
      );
      return imageName;
    }

    throw new Error(`Sandbox '${this.name}' has no image, dockerfile, or dockerfile_inline`);
  }

  /**
   * Start the sandbox container
   */
  async start(): Promise<void> {
    const image = await this.buildImageIfNeeded();
    const workdir = this.config.workdir || '/workspace';
    const visorPath = this.config.visor_path || '/opt/visor';
    const readOnlySuffix = this.config.read_only ? ':ro' : '';

    const args: string[] = [
      'docker',
      'run',
      '-d',
      '--name',
      this.containerName,
      '-v',
      `${this.repoPath}:${workdir}${readOnlySuffix}`,
      '-v',
      `${this.visorDistPath}:${visorPath}:ro`,
      '-w',
      workdir,
    ];

    // Network isolation
    if (this.config.network === false) {
      args.push('--network', 'none');
    }

    // Resource limits
    if (this.config.resources?.memory) {
      args.push('--memory', this.config.resources.memory);
    }
    if (this.config.resources?.cpu) {
      args.push('--cpus', String(this.config.resources.cpu));
    }

    // Cache volume mounts
    for (const mount of this.cacheVolumeMounts) {
      args.push('-v', mount);
    }

    // Image and keep-alive command
    args.push(image, 'sleep', 'infinity');

    const cmd = args.map(a => (a.includes(' ') ? `"${a}"` : a)).join(' ');
    logger.info(`Starting sandbox container '${this.containerName}'`);

    const { stdout } = await execAsync(cmd, { maxBuffer: EXEC_MAX_BUFFER, timeout: 60000 });
    this.containerId = stdout.trim();
  }

  /**
   * Execute a command inside the running container
   */
  async exec(options: SandboxExecOptions): Promise<SandboxExecResult> {
    if (!this.containerId) {
      throw new Error(`Sandbox '${this.name}' is not started`);
    }

    const args: string[] = ['docker', 'exec'];

    // Pass environment variables
    for (const [key, value] of Object.entries(options.env)) {
      args.push('-e', `${key}=${value}`);
    }

    args.push(this.containerName, 'sh', '-c', options.command);

    const cmd = args
      .map((a, i) => {
        // Quote the last argument (the shell command) and env values
        if (i === args.length - 1 || (i > 0 && args[i - 1] === '-e')) {
          return `'${a.replace(/'/g, "'\\''")}'`;
        }
        return a.includes(' ') ? `"${a}"` : a;
      })
      .join(' ');

    try {
      const { stdout, stderr } = await execAsync(cmd, {
        maxBuffer: options.maxBuffer || EXEC_MAX_BUFFER,
        timeout: options.timeoutMs || 600000,
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (err: unknown) {
      const execErr = err as { stdout?: string; stderr?: string; code?: number };
      return {
        stdout: execErr.stdout || '',
        stderr: execErr.stderr || '',
        exitCode: typeof execErr.code === 'number' ? execErr.code : 1,
      };
    }
  }

  /**
   * Stop and remove the container
   */
  async stop(): Promise<void> {
    if (this.containerName) {
      try {
        await execAsync(`docker rm -f ${this.containerName}`, {
          maxBuffer: EXEC_MAX_BUFFER,
          timeout: 30000,
        });
      } catch {
        // Container may already be stopped
      }
      this.containerId = null;
    }
  }
}
