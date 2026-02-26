/**
 * Bubblewrap-based sandbox implementation.
 * Uses Linux kernel namespaces for lightweight process isolation (~5-50ms overhead).
 * Requires the `bwrap` binary to be installed on the host.
 */

import { promisify } from 'util';
import { execFile as execFileCb } from 'child_process';
import { existsSync } from 'fs';
import { resolve } from 'path';
import { SandboxConfig, SandboxExecOptions, SandboxExecResult, SandboxInstance } from './types';
import { logger } from '../logger';
import { addEvent } from './sandbox-telemetry';

const execFileAsync = promisify(execFileCb);

const EXEC_MAX_BUFFER = 50 * 1024 * 1024; // 50MB

export class BubblewrapSandbox implements SandboxInstance {
  name: string;
  config: SandboxConfig;
  private repoPath: string;
  private visorDistPath: string;

  constructor(name: string, config: SandboxConfig, repoPath: string, visorDistPath: string) {
    this.name = name;
    this.config = config;
    this.repoPath = resolve(repoPath);
    this.visorDistPath = resolve(visorDistPath);
  }

  /**
   * Check if bwrap binary is available on the system.
   */
  static async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync('which', ['bwrap'], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Execute a command inside a bubblewrap sandbox.
   * Each exec creates a fresh namespace — no persistent container.
   */
  async exec(options: SandboxExecOptions): Promise<SandboxExecResult> {
    const args = this.buildArgs(options);
    args.push('--', '/bin/sh', '-c', options.command);

    logger.debug(
      `[BubblewrapSandbox] Executing in sandbox '${this.name}': ${options.command.slice(0, 100)}`
    );

    try {
      const { stdout, stderr } = await execFileAsync('bwrap', args, {
        maxBuffer: options.maxBuffer || EXEC_MAX_BUFFER,
        timeout: options.timeoutMs || 600000,
      });
      addEvent('visor.sandbox.bwrap.exec', {
        'visor.sandbox.name': this.name,
        'visor.sandbox.exit_code': 0,
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (err: unknown) {
      const execErr = err as { stdout?: string; stderr?: string; code?: number };
      const exitCode = typeof execErr.code === 'number' ? execErr.code : 1;
      addEvent('visor.sandbox.bwrap.exec', {
        'visor.sandbox.name': this.name,
        'visor.sandbox.exit_code': exitCode,
      });
      return {
        stdout: execErr.stdout || '',
        stderr: execErr.stderr || '',
        exitCode,
      };
    }
  }

  /**
   * No-op: bubblewrap processes are ephemeral (no persistent container to stop).
   */
  async stop(): Promise<void> {
    // Nothing to clean up — bwrap processes exit when the command finishes,
    // and --die-with-parent ensures cleanup if the parent dies.
  }

  /**
   * Build the bwrap command-line arguments.
   */
  private buildArgs(options: SandboxExecOptions): string[] {
    const workdir = this.config.workdir || '/workspace';
    const args: string[] = [];

    // Read-only system directories
    args.push('--ro-bind', '/usr', '/usr');
    args.push('--ro-bind', '/bin', '/bin');

    // /lib and /lib64 may not exist on all distros (e.g., Alpine uses /usr/lib)
    if (existsSync('/lib')) {
      args.push('--ro-bind', '/lib', '/lib');
    }
    if (existsSync('/lib64')) {
      args.push('--ro-bind', '/lib64', '/lib64');
    }

    // DNS resolution and TLS certificates
    if (existsSync('/etc/resolv.conf')) {
      args.push('--ro-bind', '/etc/resolv.conf', '/etc/resolv.conf');
    }
    if (existsSync('/etc/ssl')) {
      args.push('--ro-bind', '/etc/ssl', '/etc/ssl');
    }

    // Virtual filesystems
    args.push('--dev', '/dev');
    args.push('--proc', '/proc');
    args.push('--tmpfs', '/tmp');
    args.push('--tmpfs', '/root');

    // Workspace mount — the only writable directory (unless read_only)
    if (this.config.read_only) {
      args.push('--ro-bind', this.repoPath, workdir);
    } else {
      args.push('--bind', this.repoPath, workdir);
    }

    // Visor dist mount (read-only) — required for child visor process
    const visorPath = this.config.visor_path || '/opt/visor';
    args.push('--ro-bind', this.visorDistPath, visorPath);

    // Working directory inside sandbox
    args.push('--chdir', workdir);

    // Namespace isolation
    args.push('--unshare-pid');
    args.push('--new-session');
    args.push('--die-with-parent');

    // Network isolation
    if (this.config.network === false) {
      args.push('--unshare-net');
    }

    // Clean environment — only explicitly passed vars are visible
    args.push('--clearenv');

    // Pass filtered environment variables.
    // Safe: execFile passes each arg as a separate argv entry — no shell interpretation.
    for (const [key, value] of Object.entries(options.env)) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
        throw new Error(`Invalid environment variable name: '${key}'`);
      }
      args.push('--setenv', key, value);
    }

    return args;
  }
}
