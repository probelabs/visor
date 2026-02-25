/**
 * macOS Seatbelt sandbox implementation.
 * Uses Apple's sandbox-exec with dynamically-generated SBPL profiles
 * for lightweight process isolation on macOS.
 * Requires the `sandbox-exec` binary (ships with macOS).
 */

import { promisify } from 'util';
import { execFile as execFileCb } from 'child_process';
import { resolve } from 'path';
import { realpathSync } from 'fs';
import { SandboxConfig, SandboxExecOptions, SandboxExecResult, SandboxInstance } from './types';
import { logger } from '../logger';
import { addEvent } from './sandbox-telemetry';

const execFileAsync = promisify(execFileCb);

const EXEC_MAX_BUFFER = 50 * 1024 * 1024; // 50MB

export class SeatbeltSandbox implements SandboxInstance {
  name: string;
  config: SandboxConfig;
  private repoPath: string;

  constructor(name: string, config: SandboxConfig, repoPath: string) {
    this.name = name;
    this.config = config;
    // Resolve symlinks — macOS has /var → /private/var, /tmp → /private/tmp etc.
    // sandbox-exec operates on real paths, so we must resolve before building profiles.
    this.repoPath = realpathSync(resolve(repoPath));
  }

  /**
   * Check if sandbox-exec binary is available on the system.
   */
  static async isAvailable(): Promise<boolean> {
    try {
      await execFileAsync('which', ['sandbox-exec'], { timeout: 5000 });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Execute a command inside a macOS seatbelt sandbox.
   * Each exec creates a fresh sandbox process — no persistent container.
   */
  async exec(options: SandboxExecOptions): Promise<SandboxExecResult> {
    const profile = this.buildProfile();

    // Validate env var names
    for (const key of Object.keys(options.env)) {
      if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(key)) {
        throw new Error(`Invalid environment variable name: '${key}'`);
      }
    }

    // Build args: sandbox-exec -p '<profile>' /usr/bin/env -i KEY=VAL ... /bin/sh -c '<command>'
    const args: string[] = ['-p', profile];

    // Use env -i to clear inherited environment, then set explicit vars
    args.push('/usr/bin/env', '-i');
    for (const [key, value] of Object.entries(options.env)) {
      args.push(`${key}=${value}`);
    }

    args.push('/bin/sh', '-c', options.command);

    logger.debug(
      `[SeatbeltSandbox] Executing in sandbox '${this.name}': ${options.command.slice(0, 100)}`
    );

    try {
      const { stdout, stderr } = await execFileAsync('sandbox-exec', args, {
        maxBuffer: options.maxBuffer || EXEC_MAX_BUFFER,
        timeout: options.timeoutMs || 600000,
        cwd: this.repoPath,
      });
      addEvent('visor.sandbox.seatbelt.exec', {
        'visor.sandbox.name': this.name,
        'visor.sandbox.exit_code': 0,
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (err: unknown) {
      const execErr = err as { stdout?: string; stderr?: string; code?: number };
      const exitCode = typeof execErr.code === 'number' ? execErr.code : 1;
      addEvent('visor.sandbox.seatbelt.exec', {
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
   * No-op: sandbox-exec processes are ephemeral (no persistent container to stop).
   */
  async stop(): Promise<void> {
    // Nothing to clean up — sandbox-exec processes exit when the command finishes.
  }

  /**
   * Escape a path for use inside an SBPL profile string.
   * Escapes backslashes and double quotes.
   */
  private escapePath(p: string): string {
    return p.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  }

  /**
   * Build the SBPL (Seatbelt Profile Language) profile string.
   */
  private buildProfile(): string {
    const repoPath = this.escapePath(this.repoPath);
    const lines: string[] = [];

    lines.push('(version 1)');
    lines.push('(deny default)');

    // Allow basic process execution
    lines.push('(allow process-exec)');
    lines.push('(allow process-fork)');

    // Allow read access to system paths.
    // macOS uses symlinks: /var → /private/var, /tmp → /private/tmp, /etc → /private/etc.
    // We include both the symlink paths and /private to cover resolution.
    lines.push('(allow file-read*');
    lines.push('  (literal "/")');
    lines.push('  (subpath "/usr")');
    lines.push('  (subpath "/bin")');
    lines.push('  (subpath "/sbin")');
    lines.push('  (subpath "/Library")');
    lines.push('  (subpath "/System")');
    lines.push('  (subpath "/private")');
    lines.push('  (subpath "/var")');
    lines.push('  (subpath "/etc")');
    lines.push('  (subpath "/dev")');
    lines.push('  (subpath "/tmp"))');

    // Allow write to /tmp and /dev
    lines.push('(allow file-write*');
    lines.push('  (subpath "/tmp")');
    lines.push('  (subpath "/private/tmp")');
    lines.push('  (subpath "/dev"))');

    // Allow xcrun cache writes (macOS git/Xcode tools write to /var/folders/.../T/xcrun_db-*)
    lines.push('(allow file-write* (regex #"/private/var/folders/.*/T/xcrun_db"))');

    // Workspace read access
    lines.push(`(allow file-read* (subpath "${repoPath}"))`);

    // Workspace write access (unless read_only)
    if (!this.config.read_only) {
      lines.push(`(allow file-write* (subpath "${repoPath}"))`);
    }

    // Network access (unless explicitly disabled)
    if (this.config.network !== false) {
      lines.push('(allow network*)');
    }

    // Allow sysctl, mach lookups, signal for basic process operation
    lines.push('(allow sysctl-read)');
    lines.push('(allow mach-lookup)');
    lines.push('(allow signal)');

    return lines.join('\n');
  }
}
