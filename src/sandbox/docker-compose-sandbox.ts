/**
 * Docker Compose-based sandbox implementation.
 * Supports multi-service environments (e.g., app + redis + postgres).
 */

import { promisify } from 'util';
import { exec as execCb } from 'child_process';
import { randomUUID } from 'crypto';
import { SandboxConfig, SandboxExecOptions, SandboxExecResult, SandboxInstance } from './types';
import { logger } from '../logger';

const execAsync = promisify(execCb);

const EXEC_MAX_BUFFER = 50 * 1024 * 1024; // 50MB

export class DockerComposeSandbox implements SandboxInstance {
  name: string;
  config: SandboxConfig;
  private projectName: string;
  private started = false;

  constructor(name: string, config: SandboxConfig) {
    this.name = name;
    this.config = config;
    this.projectName = `visor-${name}-${randomUUID().slice(0, 8)}`;
  }

  /**
   * Start the compose services
   */
  async start(): Promise<void> {
    if (!this.config.compose) {
      throw new Error(`Sandbox '${this.name}' has no compose file specified`);
    }
    if (!this.config.service) {
      throw new Error(`Sandbox '${this.name}' requires a 'service' field for compose mode`);
    }

    logger.info(`Starting compose sandbox '${this.name}' (project: ${this.projectName})`);

    await execAsync(`docker compose -f ${this.config.compose} -p ${this.projectName} up -d`, {
      maxBuffer: EXEC_MAX_BUFFER,
      timeout: 120000,
    });

    this.started = true;
  }

  /**
   * Execute a command inside the compose service
   */
  async exec(options: SandboxExecOptions): Promise<SandboxExecResult> {
    if (!this.started) {
      throw new Error(`Compose sandbox '${this.name}' is not started`);
    }

    const service = this.config.service!;
    const args: string[] = [
      'docker',
      'compose',
      '-f',
      this.config.compose!,
      '-p',
      this.projectName,
      'exec',
      '-T', // non-interactive
    ];

    // Pass environment variables
    for (const [key, value] of Object.entries(options.env)) {
      args.push('-e', `${key}=${value}`);
    }

    // Working directory override
    if (this.config.workdir) {
      args.push('-w', this.config.workdir);
    }

    args.push(service, 'sh', '-c', options.command);

    const cmd = args
      .map((a, i) => {
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
   * Stop and tear down the compose project
   */
  async stop(): Promise<void> {
    if (this.started && this.config.compose) {
      try {
        await execAsync(`docker compose -f ${this.config.compose} -p ${this.projectName} down`, {
          maxBuffer: EXEC_MAX_BUFFER,
          timeout: 60000,
        });
      } catch {
        // May already be stopped
      }
      this.started = false;
    }
  }
}
