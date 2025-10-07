import * as cron from 'node-cron';
import { VisorConfig, CheckConfig } from './types/config';
import { logger } from './logger';
import { CheckExecutionEngine } from './check-execution-engine';

export interface ScheduledCheck {
  checkName: string;
  schedule: string;
  checkConfig: CheckConfig;
  task?: cron.ScheduledTask;
}

/**
 * Service for managing cron-scheduled check executions
 */
export class CronScheduler {
  private scheduledChecks: Map<string, ScheduledCheck> = new Map();
  private executionEngine: CheckExecutionEngine;
  private config: VisorConfig;
  private isRunning = false;

  constructor(config: VisorConfig, executionEngine: CheckExecutionEngine) {
    this.config = config;
    this.executionEngine = executionEngine;
  }

  /**
   * Initialize scheduler and register all scheduled checks
   */
  public initialize(): void {
    logger.info('Initializing cron scheduler...');

    // Find all checks with schedule configuration
    for (const [checkName, checkConfig] of Object.entries(this.config.checks || {})) {
      if (checkConfig.schedule) {
        this.registerScheduledCheck(checkName, checkConfig);
      }
    }

    logger.info(`Registered ${this.scheduledChecks.size} scheduled checks`);
  }

  /**
   * Register a check for scheduled execution
   */
  private registerScheduledCheck(checkName: string, checkConfig: CheckConfig): void {
    const schedule = checkConfig.schedule!;

    // Validate cron expression
    if (!cron.validate(schedule)) {
      logger.error(`Invalid cron expression for check "${checkName}": ${schedule}`);
      return;
    }

    const scheduledCheck: ScheduledCheck = {
      checkName,
      schedule,
      checkConfig,
    };

    // Create the scheduled task
    const task = cron.schedule(
      schedule,
      async () => {
        await this.executeScheduledCheck(checkName, checkConfig);
      },
      {
        scheduled: false, // Don't start immediately
        timezone: process.env.TZ || 'UTC',
      }
    );

    scheduledCheck.task = task;
    this.scheduledChecks.set(checkName, scheduledCheck);

    logger.info(`Scheduled check "${checkName}" with cron: ${schedule}`);
  }

  /**
   * Execute a scheduled check
   */
  private async executeScheduledCheck(checkName: string, _checkConfig: CheckConfig): Promise<void> {
    logger.info(`Executing scheduled check: ${checkName}`);

    try {
      // Create a synthetic PR info for scheduled executions (not currently used)

      // Execute the check using the execution engine
      const result = await this.executionEngine.executeChecks({
        checks: [checkName],
        showDetails: true,
        outputFormat: 'json',
        config: this.config,
      });

      // Handle the results (could send to webhook, write to file, etc.)
      await this.handleScheduledResults(checkName, result);
    } catch (error) {
      logger.error(`Failed to execute scheduled check "${checkName}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Handle results from scheduled check execution
   */
  private async handleScheduledResults(
    checkName: string,
    result: { failureReasons?: unknown[] } | unknown
  ): Promise<void> {
    // Log the results
    logger.info(`Scheduled check "${checkName}" completed`);

    // Could extend this to:
    // - Send results to webhook
    // - Write to file
    // - Post to GitHub issue
    // - Send email notification
    // etc.

    const fr = (result as { failureReasons?: unknown[] }).failureReasons;
    if (Array.isArray(fr) && fr.length > 0) {
      logger.warn(`Check "${checkName}" has failures: ${fr.length}`);
    }
  }

  /**
   * Start the scheduler
   */
  public start(): void {
    if (this.isRunning) {
      logger.info('Scheduler is already running');
      return;
    }

    logger.info('Starting cron scheduler...');

    for (const scheduledCheck of this.scheduledChecks.values()) {
      if (scheduledCheck.task) {
        scheduledCheck.task.start();
      }
    }

    this.isRunning = true;
    logger.info(`Started ${this.scheduledChecks.size} scheduled tasks`);
  }

  /**
   * Stop the scheduler
   */
  public stop(): void {
    if (!this.isRunning) {
      logger.info('Scheduler is not running');
      return;
    }

    logger.info('Stopping cron scheduler...');

    for (const scheduledCheck of this.scheduledChecks.values()) {
      if (scheduledCheck.task) {
        scheduledCheck.task.stop();
      }
    }

    this.isRunning = false;
    logger.info('Scheduler stopped');
  }

  /**
   * Get list of scheduled checks
   */
  public getScheduledChecks(): Array<{
    name: string;
    schedule: string;
    nextRun?: Date;
  }> {
    const checks: Array<{ name: string; schedule: string; nextRun?: Date }> = [];

    for (const [name, check] of this.scheduledChecks) {
      checks.push({
        name,
        schedule: check.schedule,
        // node-cron doesn't provide next run time directly
        // Could calculate it using cron-parser if needed
      });
    }

    return checks;
  }

  /**
   * Manually trigger a scheduled check
   */
  public async triggerCheck(checkName: string): Promise<void> {
    const scheduledCheck = this.scheduledChecks.get(checkName);

    if (!scheduledCheck) {
      throw new Error(`No scheduled check found with name: ${checkName}`);
    }

    logger.info(`Manually triggering check: ${checkName}`);
    await this.executeScheduledCheck(checkName, scheduledCheck.checkConfig);
  }

  /**
   * Validate all cron expressions in config
   */
  public static validateSchedules(config: VisorConfig): {
    valid: boolean;
    errors: string[];
  } {
    const errors: string[] = [];

    for (const [checkName, checkConfig] of Object.entries(config.checks || {})) {
      if (checkConfig.schedule) {
        if (!cron.validate(checkConfig.schedule)) {
          errors.push(`Invalid cron expression for check "${checkName}": ${checkConfig.schedule}`);
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }
}

/**
 * Create and initialize a cron scheduler
 */
export function createCronScheduler(
  config: VisorConfig,
  executionEngine: CheckExecutionEngine
): CronScheduler {
  const scheduler = new CronScheduler(config, executionEngine);
  scheduler.initialize();
  return scheduler;
}
