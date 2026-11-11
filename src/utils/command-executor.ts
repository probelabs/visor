import { exec } from 'child_process';
import { chmod, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';
import { logger } from '../logger';

const E2BIG_FALLBACK_TEMP_PREFIX = 'visor-command-e2big-';
const execAsync = promisify(exec);

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export interface CommandExecutionOptions {
  stdin?: string;
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
}

export interface CommandExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Shared utility for executing shell commands
 * Used by both CommandCheckProvider and CustomToolExecutor
 */
export class CommandExecutor {
  private static instance: CommandExecutor;

  private constructor() {}

  static getInstance(): CommandExecutor {
    if (!CommandExecutor.instance) {
      CommandExecutor.instance = new CommandExecutor();
    }
    return CommandExecutor.instance;
  }

  /**
   * Execute a shell command with optional stdin, environment, and timeout
   */
  async execute(
    command: string,
    options: CommandExecutionOptions = {}
  ): Promise<CommandExecutionResult> {
    const timeout = options.timeout || 30000;

    // If stdin is provided, we need to handle it differently
    if (options.stdin) {
      return this.executeWithStdin(command, options);
    }

    // For commands without stdin, use the simpler promisified version
    try {
      // Log env size to diagnose E2BIG spawn failures
      if (options.env) {
        let envSize = 0;
        let envCount = 0;
        for (const [k, v] of Object.entries(options.env)) {
          if (v !== undefined) {
            envSize += k.length + 1 + String(v).length + 1;
            envCount++;
          }
        }
        if (envSize > 100000) {
          const top5 = Object.entries(options.env)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k, String(v).length] as const)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5);
          logger.warn(
            `[CommandExecutor] Large env detected: ${envCount} vars, ${envSize} bytes. ` +
              `Top vars: ${top5.map(([k, l]) => `${k}=${l}b`).join(', ')}. ` +
              `Command: ${command.substring(0, 100)}`
          );
        }
      }
      const result = await execAsync(command, {
        cwd: options.cwd,
        env: options.env as NodeJS.ProcessEnv,
        timeout,
      });

      return {
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        exitCode: 0,
      };
    } catch (error) {
      if (this.isE2Big(error)) {
        return this.executeE2BigFallback(command, options, timeout);
      }
      return this.handleExecutionError(error, timeout);
    }
  }

  /**
   * A too-large exec command fails before a shell is spawned, so replaying the
   * exact command from an owned script cannot duplicate command side effects.
   * Also strips the env to essential vars to avoid a second E2BIG from a bloated env.
   */
  private async executeE2BigFallback(
    command: string,
    options: CommandExecutionOptions,
    timeout: number
  ): Promise<CommandExecutionResult> {
    const tempDir = await mkdtemp(join(tmpdir(), E2BIG_FALLBACK_TEMP_PREFIX));
    try {
      await chmod(tempDir, 0o700);
      const scriptPath = join(tempDir, 'command.sh');
      await writeFile(scriptPath, command, { encoding: 'utf8', mode: 0o600 });
      await chmod(scriptPath, 0o600);

      // If the original env was too large, strip it to essentials
      let fallbackEnv = options.env as NodeJS.ProcessEnv | undefined;
      if (fallbackEnv) {
        let envSize = 0;
        for (const [k, v] of Object.entries(fallbackEnv)) {
          if (v !== undefined) envSize += k.length + 1 + String(v).length + 1;
        }
        if (envSize > 1000000) {
          fallbackEnv = CommandExecutor.stripEnvToEssentials(fallbackEnv);
          const strippedSize = Object.entries(fallbackEnv).reduce(
            (s, [k, v]) => s + k.length + 1 + (v ? String(v).length : 0) + 1,
            0
          );
          logger.warn(
            `[CommandExecutor] E2BIG fallback: stripped env from ${envSize} to ${strippedSize} bytes`
          );
        }
      }

      try {
        const result = await execAsync(`/bin/sh ${shellQuote(scriptPath)}`, {
          cwd: options.cwd,
          env: fallbackEnv,
          timeout,
        });

        return {
          stdout: result.stdout || '',
          stderr: result.stderr || '',
          exitCode: 0,
        };
      } catch (error) {
        return this.handleExecutionError(error, timeout);
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  }

  /**
   * Strip env to essential variables needed for most child processes.
   * Used when the full env exceeds safe spawn limits.
   */
  static stripEnvToEssentials(
    env: NodeJS.ProcessEnv | Record<string, string | undefined>
  ): NodeJS.ProcessEnv {
    const essential = new Set([
      'PATH',
      'HOME',
      'USER',
      'SHELL',
      'LANG',
      'LC_ALL',
      'TERM',
      'TMPDIR',
      'TMP',
      'TEMP',
      'NODE_OPTIONS',
      'NODE_PATH',
      'NODE_ENV',
      'npm_config_cache',
      'HOSTNAME',
      'GIT_TERMINAL_PROMPT',
      'GIT_SSH_COMMAND',
      'GIT_CONFIG_COUNT',
      'GITHUB_TOKEN',
      'GH_TOKEN',
      'GOOGLE_API_KEY',
      'GOOGLE_API_URL',
      'OPENAI_API_KEY',
      'OPENAI_BASE_URL',
      'ANTHROPIC_API_KEY',
      'VISOR_TELEMETRY_ENABLED',
    ]);
    const result: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(env)) {
      // Keep essential vars and all GIT_CONFIG_* vars
      if (essential.has(k) || k.startsWith('GIT_CONFIG_')) {
        result[k] = v;
      }
    }
    return result as NodeJS.ProcessEnv;
  }

  private isE2Big(error: unknown): boolean {
    return Boolean(
      error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'E2BIG'
    );
  }

  /**
   * Execute command with stdin input
   */
  private executeWithStdin(
    command: string,
    options: CommandExecutionOptions
  ): Promise<CommandExecutionResult> {
    return new Promise((resolve, reject) => {
      const childProcess = exec(
        command,
        {
          cwd: options.cwd,
          env: options.env as NodeJS.ProcessEnv,
          timeout: options.timeout || 30000,
        },
        (error, stdout, stderr) => {
          // Check if the process was killed due to timeout
          if (
            error &&
            error.killed &&
            ((error as NodeJS.ErrnoException).code === 'ETIMEDOUT' || error.signal === 'SIGTERM')
          ) {
            reject(new Error(`Command timed out after ${options.timeout || 30000}ms`));
          } else if (error) {
            resolve(this.handleExecutionError(error, options.timeout || 30000, { stdout, stderr }));
          } else {
            resolve({
              stdout: stdout || '',
              stderr: stderr || '',
              exitCode: 0,
            });
          }
        }
      );

      // Write stdin and close
      if (options.stdin && childProcess.stdin) {
        childProcess.stdin.write(options.stdin);
        childProcess.stdin.end();
      }
    });
  }

  /**
   * Handle execution errors consistently
   */
  private handleExecutionError(
    error: unknown,
    timeout: number,
    capturedOutput?: { stdout?: string; stderr?: string }
  ): CommandExecutionResult {
    const execError = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      killed?: boolean;
      code?: string | number;
      signal?: string;
    };

    // Check if the process was killed due to timeout
    // Node.js sets killed: true and signal: 'SIGTERM' when timeout expires
    if (execError.killed && (execError.code === 'ETIMEDOUT' || execError.signal === 'SIGTERM')) {
      throw new Error(`Command timed out after ${timeout}ms`);
    }

    // Spawn failures use string errno codes (for example, E2BIG), while
    // exited commands use numeric codes. Never let parseInt turn an errno
    // into NaN, and never expose an arbitrary errno/message in diagnostics.
    const code = execError.code;
    const codeText = typeof code === 'string' ? code.trim() : '';
    const decimalCode =
      typeof code === 'number' ? code : /^[+-]?\d+$/.test(codeText) ? Number(codeText) : undefined;
    const hasValidNumericCode =
      typeof decimalCode === 'number' && Number.isSafeInteger(decimalCode);
    const exitCode = hasValidNumericCode ? decimalCode : 1;
    const capturedStderr = capturedOutput?.stderr ?? execError.stderr;
    const stderr =
      typeof capturedStderr === 'string' && (capturedStderr.length > 0 || hasValidNumericCode)
        ? capturedStderr
        : `Command process failed before exit: ${codeText === 'E2BIG' ? 'E2BIG' : 'SYSTEM_ERROR'}`;

    return {
      stdout: capturedOutput?.stdout ?? execError.stdout ?? '',
      stderr,
      exitCode,
    };
  }

  /**
   * Build safe environment variables by merging process.env with custom env
   * Ensures all values are strings (no undefined)
   */
  buildEnvironment(
    baseEnv: NodeJS.ProcessEnv = process.env,
    ...customEnvs: Array<Record<string, string> | undefined>
  ): Record<string, string> {
    const result: Record<string, string> = {};

    // Start with base environment, filtering out undefined values
    for (const [key, value] of Object.entries(baseEnv)) {
      if (value !== undefined) {
        result[key] = value;
      }
    }

    // Merge custom environments
    for (const customEnv of customEnvs) {
      if (customEnv) {
        Object.assign(result, customEnv);
      }
    }

    return result;
  }

  /**
   * Log command execution for debugging
   */
  logExecution(command: string, options: CommandExecutionOptions): void {
    const debugInfo = [
      `Executing command: ${command}`,
      options.cwd ? `cwd: ${options.cwd}` : null,
      options.stdin ? 'with stdin' : null,
      options.timeout ? `timeout: ${options.timeout}ms` : null,
      options.env ? `env vars: ${Object.keys(options.env).length}` : null,
    ]
      .filter(Boolean)
      .join(', ');

    logger.debug(debugInfo);
  }
}

// Export singleton instance for convenience
export const commandExecutor = CommandExecutor.getInstance();
