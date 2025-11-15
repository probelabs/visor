import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../logger';
import { CheckExecutionEngine } from '../check-execution-engine';
import { VisorConfig } from '../types/config';
import { BotSessionContext } from '../types/bot';
import { AnalysisResult } from '../output-formatters';

/**
 * Workflow execution mode
 */
export enum ExecutionMode {
  /** Execute in-process (faster, recommended) */
  IN_PROCESS = 'in-process',
  /** Spawn child process (isolated, for debugging) */
  CHILD_PROCESS = 'child-process',
}

/**
 * Workflow execution request
 */
export interface WorkflowExecutionRequest {
  /** Unique ID for this execution */
  id: string;
  /** Workflow/check name to execute */
  workflowName: string;
  /** Visor configuration */
  config: VisorConfig;
  /** Bot session context */
  botContext: BotSessionContext;
  /** Execution mode (default: in-process) */
  mode?: ExecutionMode;
  /** Working directory (default: current directory) */
  workingDirectory?: string;
  /** Timeout in milliseconds (default: 5 minutes) */
  timeout?: number;
}

/**
 * Workflow execution result
 */
export interface WorkflowExecutionResult {
  /** Execution ID */
  id: string;
  /** Success flag */
  success: boolean;
  /** Execution duration in milliseconds */
  duration: number;
  /** Analysis result (if successful) */
  result?: AnalysisResult;
  /** Error message (if failed) */
  error?: string;
  /** Formatted output for Slack */
  slackOutput?: string;
  /** Bot context file path (for cleanup) */
  botContextFile?: string;
}

/**
 * Workflow executor for running Visor workflows with bot context
 * Supports both in-process and child-process execution modes
 */
export class WorkflowExecutor {
  private defaultTimeout: number;
  private defaultMode: ExecutionMode;

  /**
   * Create a new workflow executor
   * @param defaultTimeout Default timeout in milliseconds (default: 5 minutes)
   * @param defaultMode Default execution mode (default: in-process)
   */
  constructor(
    defaultTimeout: number = 5 * 60 * 1000,
    defaultMode: ExecutionMode = ExecutionMode.IN_PROCESS
  ) {
    this.defaultTimeout = defaultTimeout;
    this.defaultMode = defaultMode;

    logger.info(`Workflow executor initialized: timeout=${defaultTimeout}ms, mode=${defaultMode}`);
  }

  /**
   * Execute a workflow with bot context
   * @param request Workflow execution request
   * @returns Workflow execution result
   */
  async execute(request: WorkflowExecutionRequest): Promise<WorkflowExecutionResult> {
    const startTime = Date.now();
    const mode = request.mode ?? this.defaultMode;
    const timeout = request.timeout ?? this.defaultTimeout;
    const workingDirectory = request.workingDirectory ?? process.cwd();

    logger.info(
      `Executing workflow ${request.workflowName} (id: ${request.id}, mode: ${mode}, timeout: ${timeout}ms)`
    );

    // Create temporary bot context file
    let botContextFile: string | undefined;
    try {
      botContextFile = await this.createBotContextFile(request.id, request.botContext);
      logger.debug(`Created bot context file: ${botContextFile}`);

      // Execute based on mode
      let result: AnalysisResult;
      if (mode === ExecutionMode.IN_PROCESS) {
        result = await this.executeInProcess(
          request.workflowName,
          request.config,
          botContextFile,
          workingDirectory,
          timeout
        );
      } else {
        result = await this.executeChildProcess(
          request.workflowName,
          request.config,
          botContextFile,
          workingDirectory,
          timeout
        );
      }

      const duration = Date.now() - startTime;

      // Format output for Slack
      const slackOutput = this.formatForSlack(result);

      logger.info(
        `Workflow ${request.workflowName} completed successfully (id: ${request.id}, duration: ${duration}ms)`
      );

      return {
        id: request.id,
        success: true,
        duration,
        result,
        slackOutput,
        botContextFile,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : String(error);

      logger.error(
        `Workflow ${request.workflowName} failed (id: ${request.id}, duration: ${duration}ms): ${errorMessage}`
      );

      return {
        id: request.id,
        success: false,
        duration,
        error: errorMessage,
        slackOutput: this.formatErrorForSlack(errorMessage),
        botContextFile,
      };
    } finally {
      // Clean up bot context file
      if (botContextFile) {
        await this.cleanupBotContextFile(botContextFile);
      }
    }
  }

  /**
   * Execute workflow in-process (recommended)
   */
  private async executeInProcess(
    workflowName: string,
    config: VisorConfig,
    botContextFile: string,
    workingDirectory: string,
    timeout: number
  ): Promise<AnalysisResult> {
    logger.debug(`Executing workflow ${workflowName} in-process`);

    // Create execution engine (second param is optional Octokit, not needed for bot workflows)
    const engine = new CheckExecutionEngine(workingDirectory);

    // Load bot context from file
    const botContext = await this.loadBotContext(botContextFile);

    // Set bot context on engine
    (engine as any).executionContext = {
      botSession: botContext,
    };

    // Create timeout promise
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => {
        reject(new Error(`Workflow execution timed out after ${timeout}ms`));
      }, timeout);
    });

    // Execute checks with bot context
    const executionPromise = engine.executeChecks({
      checks: [workflowName],
      config,
    });

    // Race between execution and timeout
    const result = await Promise.race([executionPromise, timeoutPromise]);

    return result;
  }

  /**
   * Execute workflow in child process (for isolation/debugging)
   */
  private async executeChildProcess(
    workflowName: string,
    config: VisorConfig,
    botContextFile: string,
    workingDirectory: string,
    timeout: number
  ): Promise<AnalysisResult> {
    logger.debug(`Executing workflow ${workflowName} in child process`);

    const { spawn } = await import('child_process');

    // Create temporary config file
    const configFile = path.join(path.dirname(botContextFile), `visor-config-${Date.now()}.yaml`);

    try {
      // Write config to file
      const yaml = await import('js-yaml');
      fs.writeFileSync(configFile, yaml.dump(config), 'utf-8');
      logger.debug(`Created config file: ${configFile}`);

      // Spawn visor process
      const visorPath = process.argv[1]; // Path to visor binary
      const args = [
        'run',
        '--config',
        configFile,
        '--bot-context-file',
        botContextFile,
        '--check',
        workflowName,
        '--output',
        'json',
      ];

      logger.debug(`Spawning process: ${visorPath} ${args.join(' ')}`);

      return new Promise((resolve, reject) => {
        let stdout = '';
        let stderr = '';

        const child = spawn(visorPath, args, {
          cwd: workingDirectory,
          env: { ...process.env },
        });

        child.stdout?.on('data', data => {
          stdout += data.toString();
        });

        child.stderr?.on('data', data => {
          stderr += data.toString();
        });

        // Timeout handler
        const timer = setTimeout(() => {
          child.kill('SIGTERM');
          reject(new Error(`Workflow execution timed out after ${timeout}ms`));
        }, timeout);

        child.on('close', code => {
          clearTimeout(timer);

          if (code === 0) {
            try {
              // Parse JSON output
              const result = JSON.parse(stdout) as AnalysisResult;
              resolve(result);
            } catch (parseError) {
              reject(
                new Error(
                  `Failed to parse workflow output: ${parseError instanceof Error ? parseError.message : String(parseError)}`
                )
              );
            }
          } else {
            reject(
              new Error(`Workflow exited with code ${code}${stderr ? `\nStderr: ${stderr}` : ''}`)
            );
          }
        });

        child.on('error', error => {
          clearTimeout(timer);
          reject(new Error(`Failed to spawn workflow process: ${error.message}`));
        });
      });
    } finally {
      // Clean up config file
      try {
        if (fs.existsSync(configFile)) {
          fs.unlinkSync(configFile);
          logger.debug(`Cleaned up config file: ${configFile}`);
        }
      } catch (cleanupError) {
        logger.warn(
          `Failed to clean up config file ${configFile}: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
        );
      }
    }
  }

  /**
   * Create temporary bot context file
   */
  private async createBotContextFile(id: string, botContext: BotSessionContext): Promise<string> {
    const tmpDir = (await import('os')).tmpdir();
    const filePath = path.join(tmpDir, `visor-bot-context-${id}-${Date.now()}.json`);

    fs.writeFileSync(filePath, JSON.stringify(botContext, null, 2), 'utf-8');

    return filePath;
  }

  /**
   * Load bot context from file
   */
  private async loadBotContext(filePath: string): Promise<BotSessionContext> {
    const content = fs.readFileSync(filePath, 'utf-8');
    const botContext = JSON.parse(content);

    // Validate structure
    if (
      !botContext ||
      typeof botContext !== 'object' ||
      !('id' in botContext) ||
      !('transport' in botContext)
    ) {
      throw new Error('Invalid bot context file: missing id or transport');
    }

    return botContext as BotSessionContext;
  }

  /**
   * Clean up bot context file
   */
  private async cleanupBotContextFile(filePath: string): Promise<void> {
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        logger.debug(`Cleaned up bot context file: ${filePath}`);
      }
    } catch (error) {
      logger.warn(
        `Failed to clean up bot context file ${filePath}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Format analysis result for Slack posting
   */
  private formatForSlack(result: AnalysisResult): string {
    const lines: string[] = [];

    lines.push(`*Workflow Execution Complete*`);
    lines.push('');

    // Extract statistics
    const stats = (result as any).statistics;
    if (stats) {
      const totalChecks = stats.totalChecksConfigured || 0;
      const successful = stats.successfulExecutions || 0;
      const failed = stats.failedExecutions || 0;
      const skipped = stats.skippedChecks || 0;

      lines.push(`• Total Checks: ${totalChecks}`);
      if (successful > 0) {
        lines.push(`• Successful: ${successful} :white_check_mark:`);
      }
      if (failed > 0) {
        lines.push(`• Failed: ${failed} :x:`);
      }
      if (skipped > 0) {
        lines.push(`• Skipped: ${skipped}`);
      }

      if (stats.totalDuration) {
        lines.push(`• Duration: ${Math.round(stats.totalDuration / 1000)}s`);
      }

      lines.push('');
    }

    // Check results
    const results = (result as any).results;
    if (results && Object.keys(results).length > 0) {
      lines.push(`*Check Details*`);
      for (const [checkName, checkResults] of Object.entries(results)) {
        const checksArray = Array.isArray(checkResults) ? checkResults : [checkResults];
        const passed = checksArray.every((r: any) => r.passed);
        const emoji = passed ? ':white_check_mark:' : ':x:';
        lines.push(`${emoji} ${checkName}`);
      }
      lines.push('');
    }

    if (lines.length === 2) {
      // No details, just basic message
      lines.push('_No detailed results available_');
    }

    return lines.join('\n');
  }

  /**
   * Format error for Slack posting
   */
  private formatErrorForSlack(error: string): string {
    return `:x: *Workflow Execution Failed*\n\nError: ${error}\n\nPlease check the logs for more details.`;
  }
}
