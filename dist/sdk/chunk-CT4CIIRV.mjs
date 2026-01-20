import {
  init_logger,
  logger
} from "./chunk-VMPLF6FT.mjs";
import {
  __esm
} from "./chunk-WMJKH4XE.mjs";

// src/utils/command-executor.ts
import { exec } from "child_process";
import { promisify } from "util";
var CommandExecutor, commandExecutor;
var init_command_executor = __esm({
  "src/utils/command-executor.ts"() {
    init_logger();
    CommandExecutor = class _CommandExecutor {
      static instance;
      constructor() {
      }
      static getInstance() {
        if (!_CommandExecutor.instance) {
          _CommandExecutor.instance = new _CommandExecutor();
        }
        return _CommandExecutor.instance;
      }
      /**
       * Execute a shell command with optional stdin, environment, and timeout
       */
      async execute(command, options = {}) {
        const execAsync = promisify(exec);
        const timeout = options.timeout || 3e4;
        if (options.stdin) {
          return this.executeWithStdin(command, options);
        }
        try {
          const result = await execAsync(command, {
            cwd: options.cwd,
            env: options.env,
            timeout
          });
          return {
            stdout: result.stdout || "",
            stderr: result.stderr || "",
            exitCode: 0
          };
        } catch (error) {
          return this.handleExecutionError(error, timeout);
        }
      }
      /**
       * Execute command with stdin input
       */
      executeWithStdin(command, options) {
        return new Promise((resolve, reject) => {
          const childProcess = exec(
            command,
            {
              cwd: options.cwd,
              env: options.env,
              timeout: options.timeout || 3e4
            },
            (error, stdout, stderr) => {
              if (error && error.killed && (error.code === "ETIMEDOUT" || error.signal === "SIGTERM")) {
                reject(new Error(`Command timed out after ${options.timeout || 3e4}ms`));
              } else {
                resolve({
                  stdout: stdout || "",
                  stderr: stderr || "",
                  exitCode: error ? error.code || 1 : 0
                });
              }
            }
          );
          if (options.stdin && childProcess.stdin) {
            childProcess.stdin.write(options.stdin);
            childProcess.stdin.end();
          }
        });
      }
      /**
       * Handle execution errors consistently
       */
      handleExecutionError(error, timeout) {
        const execError = error;
        if (execError.killed && (execError.code === "ETIMEDOUT" || execError.signal === "SIGTERM")) {
          throw new Error(`Command timed out after ${timeout}ms`);
        }
        let exitCode = 1;
        if (execError.code) {
          exitCode = typeof execError.code === "string" ? parseInt(execError.code, 10) : execError.code;
        }
        return {
          stdout: execError.stdout || "",
          stderr: execError.stderr || "",
          exitCode
        };
      }
      /**
       * Build safe environment variables by merging process.env with custom env
       * Ensures all values are strings (no undefined)
       */
      buildEnvironment(baseEnv = process.env, ...customEnvs) {
        const result = {};
        for (const [key, value] of Object.entries(baseEnv)) {
          if (value !== void 0) {
            result[key] = value;
          }
        }
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
      logExecution(command, options) {
        const debugInfo = [
          `Executing command: ${command}`,
          options.cwd ? `cwd: ${options.cwd}` : null,
          options.stdin ? "with stdin" : null,
          options.timeout ? `timeout: ${options.timeout}ms` : null,
          options.env ? `env vars: ${Object.keys(options.env).length}` : null
        ].filter(Boolean).join(", ");
        logger.debug(debugInfo);
      }
    };
    commandExecutor = CommandExecutor.getInstance();
  }
});

export {
  CommandExecutor,
  commandExecutor,
  init_command_executor
};
//# sourceMappingURL=chunk-CT4CIIRV.mjs.map