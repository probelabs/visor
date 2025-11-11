import { exec } from 'child_process';
import { promisify } from 'util';
import { logger } from '../logger';

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
    const execAsync = promisify(exec);
    const timeout = options.timeout || 30000;

    // If stdin is provided, we need to handle it differently
    if (options.stdin) {
      return this.executeWithStdin(command, options);
    }

    // For commands without stdin, use the simpler promisified version
    try {
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
      return this.handleExecutionError(error, timeout);
    }
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
          if (error && error.killed && (error as NodeJS.ErrnoException).code === 'ETIMEDOUT') {
            reject(new Error(`Command timed out after ${options.timeout || 30000}ms`));
          } else {
            resolve({
              stdout: stdout || '',
              stderr: stderr || '',
              exitCode: error ? error.code || 1 : 0,
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
  private handleExecutionError(error: unknown, timeout: number): CommandExecutionResult {
    const execError = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      killed?: boolean;
      code?: string | number;
    };

    if (execError.killed && execError.code === 'ETIMEDOUT') {
      throw new Error(`Command timed out after ${timeout}ms`);
    }

    // Extract exit code - it might be a string or number
    let exitCode = 1;
    if (execError.code) {
      exitCode = typeof execError.code === 'string' ? parseInt(execError.code, 10) : execError.code;
    }

    return {
      stdout: execError.stdout || '',
      stderr: execError.stderr || '',
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
