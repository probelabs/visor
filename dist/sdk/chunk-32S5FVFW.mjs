import {
  init_logger,
  logger
} from "./chunk-6E625R3C.mjs";
import {
  __esm
} from "./chunk-J7LXIPZS.mjs";

// src/utils/command-executor.ts
import { exec } from "child_process";
import { chmod, mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { promisify } from "util";
function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
var E2BIG_FALLBACK_TEMP_PREFIX, execAsync, CommandExecutor, commandExecutor;
var init_command_executor = __esm({
  "src/utils/command-executor.ts"() {
    init_logger();
    E2BIG_FALLBACK_TEMP_PREFIX = "visor-command-e2big-";
    execAsync = promisify(exec);
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
          if (this.isE2Big(error)) {
            return this.executeE2BigFallback(command, options, timeout);
          }
          return this.handleExecutionError(error, timeout);
        }
      }
      /**
       * A too-large exec command fails before a shell is spawned, so replaying the
       * exact command from an owned script cannot duplicate command side effects.
       */
      async executeE2BigFallback(command, options, timeout) {
        const tempDir = await mkdtemp(join(tmpdir(), E2BIG_FALLBACK_TEMP_PREFIX));
        try {
          await chmod(tempDir, 448);
          const scriptPath = join(tempDir, "command.sh");
          await writeFile(scriptPath, command, { encoding: "utf8", mode: 384 });
          await chmod(scriptPath, 384);
          try {
            const result = await execAsync(`/bin/sh ${shellQuote(scriptPath)}`, {
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
        } finally {
          await rm(tempDir, { recursive: true, force: true });
        }
      }
      isE2Big(error) {
        return Boolean(
          error && typeof error === "object" && error.code === "E2BIG"
        );
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
              } else if (error) {
                resolve(this.handleExecutionError(error, options.timeout || 3e4, { stdout, stderr }));
              } else {
                resolve({
                  stdout: stdout || "",
                  stderr: stderr || "",
                  exitCode: 0
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
      handleExecutionError(error, timeout, capturedOutput) {
        const execError = error;
        if (execError.killed && (execError.code === "ETIMEDOUT" || execError.signal === "SIGTERM")) {
          throw new Error(`Command timed out after ${timeout}ms`);
        }
        const code = execError.code;
        const codeText = typeof code === "string" ? code.trim() : "";
        const decimalCode = typeof code === "number" ? code : /^[+-]?\d+$/.test(codeText) ? Number(codeText) : void 0;
        const hasValidNumericCode = typeof decimalCode === "number" && Number.isSafeInteger(decimalCode);
        const exitCode = hasValidNumericCode ? decimalCode : 1;
        const capturedStderr = capturedOutput?.stderr ?? execError.stderr;
        const stderr = typeof capturedStderr === "string" && (capturedStderr.length > 0 || hasValidNumericCode) ? capturedStderr : `Command process failed before exit: ${codeText === "E2BIG" ? "E2BIG" : "SYSTEM_ERROR"}`;
        return {
          stdout: capturedOutput?.stdout ?? execError.stdout ?? "",
          stderr,
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
//# sourceMappingURL=chunk-32S5FVFW.mjs.map