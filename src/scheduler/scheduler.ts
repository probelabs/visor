/**
 * Generic scheduler for executing scheduled workflows
 * Uses node-cron for recurring schedules and setTimeout for one-time schedules
 *
 * This scheduler is frontend-agnostic. When a schedule fires, it runs a visor workflow.
 * Output handling (Slack, GitHub, webhooks) is delegated to output adapters.
 */
import cron from 'node-cron';
import { ScheduleStore, Schedule, ScheduleLimits, ScheduleStoreConfig } from './schedule-store';
import { getNextRunTime } from './schedule-parser';
import { logger } from '../logger';
import type { VisorConfig, StaticCronJob } from '../types/config';
import { StateMachineExecutionEngine } from '../state-machine-execution-engine';
import { getPromptStateManager } from '../slack/prompt-state';

/**
 * Output adapter interface for sending schedule results to different destinations
 */
export interface ScheduleOutputAdapter {
  /** Adapter type identifier */
  type: 'slack' | 'github' | 'webhook' | 'none';

  /**
   * Send schedule execution result to the destination
   * @param schedule The schedule that was executed
   * @param result The execution result (success/failure + output)
   */
  sendResult(schedule: Schedule, result: ScheduleExecutionResult): Promise<void>;
}

/**
 * Result of schedule execution
 */
export interface ScheduleExecutionResult {
  success: boolean;
  output?: unknown;
  error?: string;
  executionTimeMs: number;
}

/**
 * Configuration for the scheduler
 */
export interface SchedulerConfig {
  /** Enable/disable the scheduler (default: true) */
  enabled?: boolean;
  /** Path to the schedules storage file */
  storagePath?: string;
  /** Check interval for due schedules in ms (default: 60000 - 1 minute) */
  checkIntervalMs?: number;
  /** Limits for schedules */
  limits?: ScheduleLimits;
  /** Default timezone for schedules (default: UTC) */
  defaultTimezone?: string;
}

/**
 * Generic scheduler that manages schedule execution
 */
export class Scheduler {
  private store: ScheduleStore;
  private visorConfig: VisorConfig;
  private checkIntervalMs: number;
  private defaultTimezone: string;
  private checkInterval: NodeJS.Timeout | null = null;
  private cronJobs: Map<string, cron.ScheduledTask> = new Map();
  private oneTimeTimeouts: Map<string, NodeJS.Timeout> = new Map();
  private running = false;
  private engine?: StateMachineExecutionEngine;
  private outputAdapters: Map<string, ScheduleOutputAdapter> = new Map();
  private executionContext: Record<string, unknown> = {};

  constructor(visorConfig: VisorConfig, config?: SchedulerConfig) {
    this.visorConfig = visorConfig;
    this.checkIntervalMs = config?.checkIntervalMs ?? 60000;
    this.defaultTimezone = config?.defaultTimezone ?? 'UTC';

    // Initialize store
    const storeConfig: ScheduleStoreConfig = {
      path: config?.storagePath,
    };
    this.store = ScheduleStore.getInstance(storeConfig, config?.limits);
  }

  /**
   * Set the execution engine (called after construction to avoid circular deps)
   */
  setEngine(engine: StateMachineExecutionEngine): void {
    this.engine = engine;
  }

  /**
   * Set the execution context (e.g., Slack client) for workflow executions
   */
  setExecutionContext(context: Record<string, unknown>): void {
    this.executionContext = { ...this.executionContext, ...context };
  }

  /**
   * Register an output adapter for a specific type
   */
  registerOutputAdapter(adapter: ScheduleOutputAdapter): void {
    this.outputAdapters.set(adapter.type, adapter);
    logger.debug(`[Scheduler] Registered output adapter: ${adapter.type}`);
  }

  /**
   * Get the schedule store instance
   */
  getStore(): ScheduleStore {
    return this.store;
  }

  /**
   * Start the scheduler
   */
  async start(): Promise<void> {
    if (this.running) {
      logger.warn('[Scheduler] Already running');
      return;
    }

    // Initialize store
    await this.store.initialize();

    // Load static cron jobs from config (always executed, no permissions check)
    await this.loadStaticCronJobs();

    // Restore dynamic schedules from storage
    await this.restoreSchedules();

    // Start periodic check for due schedules
    this.checkInterval = setInterval(() => {
      this.checkDueSchedules().catch(error => {
        logger.error(
          `[Scheduler] Error checking due schedules: ${
            error instanceof Error ? error.message : 'Unknown error'
          }`
        );
      });
    }, this.checkIntervalMs);

    this.running = true;
    logger.info('[Scheduler] Started');
  }

  /**
   * Load and schedule static cron jobs from visor config
   * These are defined in scheduler.cron section and always run regardless of permissions
   */
  private async loadStaticCronJobs(): Promise<void> {
    const schedulerCfg = this.visorConfig.scheduler;
    if (!schedulerCfg?.cron) {
      return;
    }

    const cronJobs = schedulerCfg.cron as Record<string, StaticCronJob>;
    let loadedCount = 0;

    for (const [jobId, job] of Object.entries(cronJobs) as [string, StaticCronJob][]) {
      if (job.enabled === false) {
        logger.debug(`[Scheduler] Static cron job '${jobId}' is disabled, skipping`);
        continue;
      }

      try {
        await this.scheduleStaticCronJob(jobId, job);
        loadedCount++;
      } catch (error) {
        logger.error(
          `[Scheduler] Failed to load static cron job '${jobId}': ${
            error instanceof Error ? error.message : 'Unknown error'
          }`
        );
      }
    }

    if (loadedCount > 0) {
      logger.info(`[Scheduler] Loaded ${loadedCount} static cron job(s) from config`);
    }
  }

  /**
   * Schedule a static cron job from config
   */
  private async scheduleStaticCronJob(jobId: string, job: StaticCronJob): Promise<void> {
    // Validate cron expression
    if (!cron.validate(job.schedule)) {
      throw new Error(`Invalid cron expression: ${job.schedule}`);
    }

    // Check if workflow exists
    const allChecks = Object.keys(this.visorConfig.checks || {});
    if (!allChecks.includes(job.workflow)) {
      throw new Error(`Workflow "${job.workflow}" not found in configuration`);
    }

    // Use a special ID prefix to distinguish static jobs from dynamic ones
    const internalId = `__static_cron__:${jobId}`;

    // Create cron job
    const cronJob = cron.schedule(
      job.schedule,
      async () => {
        logger.info(`[Scheduler] Executing static cron job '${jobId}': workflow="${job.workflow}"`);
        await this.executeStaticCronJob(jobId, job);
      },
      {
        scheduled: true,
        timezone: job.timezone || this.defaultTimezone,
      }
    );

    this.cronJobs.set(internalId, cronJob);

    // Compute next run time for logging
    try {
      const nextRun = getNextRunTime(job.schedule, job.timezone || this.defaultTimezone);
      const description = job.description ? ` (${job.description})` : '';
      logger.debug(
        `[Scheduler] Scheduled static cron job '${jobId}'${description}: ${job.schedule} → ${job.workflow}, next run: ${nextRun.toISOString()}`
      );
    } catch {
      // Best effort logging
    }
  }

  /**
   * Execute a static cron job
   */
  private async executeStaticCronJob(jobId: string, job: StaticCronJob): Promise<void> {
    const startTime = Date.now();
    let result: ScheduleExecutionResult;

    // Build a synthetic schedule object for output adapters
    const syntheticSchedule: Schedule = {
      id: `__static_cron__:${jobId}`,
      creatorId: 'system',
      creatorContext: 'config',
      timezone: job.timezone || this.defaultTimezone,
      schedule: job.schedule,
      isRecurring: true,
      originalExpression: job.schedule,
      workflow: job.workflow,
      workflowInputs: job.inputs,
      outputContext: job.output
        ? {
            type: job.output.type,
            target: job.output.target,
            threadId: job.output.thread_id,
          }
        : undefined,
      status: 'active',
      createdAt: 0,
      runCount: 0,
      failureCount: 0,
    };

    try {
      // Execute the workflow
      const output = await this.executeWorkflow(syntheticSchedule);

      result = {
        success: true,
        output,
        executionTimeMs: Date.now() - startTime,
      };

      logger.info(
        `[Scheduler] Static cron job '${jobId}' completed in ${result.executionTimeMs}ms`
      );
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';

      result = {
        success: false,
        error: errorMsg,
        executionTimeMs: Date.now() - startTime,
      };

      logger.error(`[Scheduler] Static cron job '${jobId}' failed: ${errorMsg}`);
    }

    // Send result to output adapter if configured
    await this.sendResult(syntheticSchedule, result);
  }

  /**
   * Stop the scheduler
   */
  async stop(): Promise<void> {
    if (!this.running) {
      return;
    }

    // Stop the check interval
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }

    // Stop all cron jobs
    for (const [id, job] of this.cronJobs.entries()) {
      job.stop();
      logger.debug(`[Scheduler] Stopped cron job for schedule ${id}`);
    }
    this.cronJobs.clear();

    // Clear all one-time timeouts
    for (const [id, timeout] of this.oneTimeTimeouts.entries()) {
      clearTimeout(timeout);
      logger.debug(`[Scheduler] Cleared timeout for schedule ${id}`);
    }
    this.oneTimeTimeouts.clear();

    // Flush store to ensure all changes are persisted
    await this.store.flush();

    this.running = false;
    logger.info('[Scheduler] Stopped');
  }

  /**
   * Restore schedules from persistent storage
   */
  private async restoreSchedules(): Promise<void> {
    const activeSchedules = this.store.getActiveSchedules();
    logger.info(`[Scheduler] Restoring ${activeSchedules.length} active schedules`);

    for (const schedule of activeSchedules) {
      try {
        await this.scheduleExecution(schedule);
      } catch (error) {
        logger.error(
          `[Scheduler] Failed to restore schedule ${schedule.id}: ${
            error instanceof Error ? error.message : 'Unknown error'
          }`
        );
      }
    }
  }

  /**
   * Schedule a workflow for execution
   */
  private async scheduleExecution(schedule: Schedule): Promise<void> {
    if (schedule.isRecurring) {
      await this.scheduleRecurring(schedule);
    } else {
      await this.scheduleOneTime(schedule);
    }
  }

  /**
   * Schedule a recurring workflow using cron
   */
  private async scheduleRecurring(schedule: Schedule): Promise<void> {
    // Stop existing job if any
    const existingJob = this.cronJobs.get(schedule.id);
    if (existingJob) {
      existingJob.stop();
    }

    // Validate cron expression
    if (!cron.validate(schedule.schedule)) {
      logger.error(
        `[Scheduler] Invalid cron expression for schedule ${schedule.id}: ${schedule.schedule}`
      );
      this.store.update(schedule.id, { status: 'failed', lastError: 'Invalid cron expression' });
      return;
    }

    // Create cron job
    const job = cron.schedule(
      schedule.schedule,
      async () => {
        await this.executeSchedule(schedule);
      },
      {
        scheduled: true,
        timezone: schedule.timezone || this.defaultTimezone,
      }
    );

    this.cronJobs.set(schedule.id, job);

    // Update next run time
    try {
      const nextRun = getNextRunTime(schedule.schedule, schedule.timezone);
      this.store.update(schedule.id, { nextRunAt: nextRun.getTime() });
    } catch (error) {
      logger.warn(
        `[Scheduler] Could not compute next run time for ${schedule.id}: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }

    logger.debug(`[Scheduler] Scheduled recurring execution ${schedule.id}: ${schedule.schedule}`);
  }

  /**
   * Schedule a one-time workflow using setTimeout
   */
  private async scheduleOneTime(schedule: Schedule): Promise<void> {
    // Clear existing timeout if any
    const existingTimeout = this.oneTimeTimeouts.get(schedule.id);
    if (existingTimeout) {
      clearTimeout(existingTimeout);
    }

    if (!schedule.runAt) {
      logger.error(`[Scheduler] One-time schedule ${schedule.id} has no runAt time`);
      return;
    }

    const delayMs = schedule.runAt - Date.now();

    // If already past due, execute immediately
    if (delayMs <= 0) {
      await this.executeSchedule(schedule);
      return;
    }

    // Schedule for future execution
    const timeout = setTimeout(async () => {
      this.oneTimeTimeouts.delete(schedule.id);
      await this.executeSchedule(schedule);
    }, delayMs);

    this.oneTimeTimeouts.set(schedule.id, timeout);

    logger.debug(
      `[Scheduler] Scheduled one-time execution ${schedule.id} for ${new Date(schedule.runAt).toISOString()}`
    );
  }

  /**
   * Check for and execute due schedules
   */
  private async checkDueSchedules(): Promise<void> {
    const dueSchedules = this.store.getDueSchedules();

    for (const schedule of dueSchedules) {
      // Skip if already scheduled
      if (this.cronJobs.has(schedule.id) || this.oneTimeTimeouts.has(schedule.id)) {
        continue;
      }

      await this.executeSchedule(schedule);
    }
  }

  /**
   * Execute a scheduled workflow
   */
  private async executeSchedule(schedule: Schedule): Promise<void> {
    const description = schedule.workflow || 'reminder';
    logger.info(`[Scheduler] Executing schedule ${schedule.id}: ${description}`);

    const startTime = Date.now();
    let result: ScheduleExecutionResult;

    try {
      // Execute the workflow
      const output = await this.executeWorkflow(schedule);

      result = {
        success: true,
        output,
        executionTimeMs: Date.now() - startTime,
      };

      // Update schedule state
      const now = Date.now();
      this.store.update(schedule.id, {
        lastRunAt: now,
        runCount: schedule.runCount + 1,
        failureCount: 0, // Reset on success
        lastError: undefined,
      });

      // For one-time schedules, mark as completed
      if (!schedule.isRecurring) {
        this.store.update(schedule.id, { status: 'completed' });
        this.store.delete(schedule.id); // Clean up
        logger.info(`[Scheduler] One-time schedule ${schedule.id} completed and removed`);
      } else {
        // Update next run time for recurring schedules
        try {
          const nextRun = getNextRunTime(schedule.schedule, schedule.timezone);
          this.store.update(schedule.id, { nextRunAt: nextRun.getTime() });
        } catch {
          // Best effort
        }
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';

      result = {
        success: false,
        error: errorMsg,
        executionTimeMs: Date.now() - startTime,
      };

      await this.handleScheduleFailure(schedule, error);
    }

    // Send result to output adapter if configured
    await this.sendResult(schedule, result);
  }

  /**
   * Execute the workflow for a schedule
   */
  private async executeWorkflow(schedule: Schedule): Promise<unknown> {
    // Handle simple reminders (no workflow set) - run through default chat workflow
    if (!schedule.workflow) {
      return this.executeSimpleReminder(schedule);
    }

    if (!this.engine) {
      logger.warn('[Scheduler] No execution engine set, skipping workflow execution');
      return { message: 'No execution engine configured' };
    }

    // Check if the workflow exists
    const allChecks = Object.keys(this.visorConfig.checks || {});
    if (!allChecks.includes(schedule.workflow)) {
      throw new Error(`Workflow "${schedule.workflow}" not found in configuration`);
    }

    // Build synthetic webhook context for the schedule
    const syntheticPayload = {
      event: {
        type: 'schedule_triggered',
        schedule_id: schedule.id,
        workflow: schedule.workflow,
        creator_id: schedule.creatorId,
        creator_context: schedule.creatorContext,
        timestamp: Date.now(),
      },
      schedule: {
        id: schedule.id,
        workflow: schedule.workflow,
        workflowInputs: schedule.workflowInputs,
        isRecurring: schedule.isRecurring,
        outputContext: schedule.outputContext,
      },
    };

    // Create webhook context map
    const webhookData = new Map<string, unknown>();
    const endpoint = '/scheduler/trigger';
    webhookData.set(endpoint, syntheticPayload);

    // Clone config for this run
    const cfgForRun: VisorConfig = JSON.parse(JSON.stringify(this.visorConfig));

    // Create a new engine instance for this schedule
    const runEngine = new StateMachineExecutionEngine();

    // Execute the workflow
    await runEngine.executeChecks({
      checks: [schedule.workflow],
      showDetails: true,
      outputFormat: 'json',
      config: cfgForRun,
      webhookContext: { webhookData, eventType: 'schedule' },
      debug: process.env.VISOR_DEBUG === 'true',
      inputs: schedule.workflowInputs,
    } as any);

    return { message: 'Workflow completed', workflow: schedule.workflow };
  }

  /**
   * Execute a simple reminder by running it through the visor pipeline
   * This treats the reminder text as if the user sent it as a Slack message
   */
  private async executeSimpleReminder(schedule: Schedule): Promise<unknown> {
    const reminderText = schedule.workflowInputs?.text as string;
    if (!reminderText) {
      return { message: 'Reminder!', type: 'simple_reminder' };
    }

    // Get all checks from config - same pattern as socket-runner.ts
    const allChecks = Object.keys(this.visorConfig.checks || {});
    if (allChecks.length === 0) {
      logger.warn('[Scheduler] No checks configured, returning reminder text directly');
      return { message: reminderText, type: 'simple_reminder' };
    }

    logger.info(`[Scheduler] Running reminder through visor pipeline (${allChecks.length} checks)`);

    // Fetch thread history if this is a thread-based reminder
    const channel = schedule.outputContext?.target || '';
    const threadId = schedule.outputContext?.threadId;
    let threadMessages: Array<{ user: string; text: string }> = [];

    if (threadId && channel && this.executionContext.slackClient) {
      try {
        const slackClient = this.executionContext.slackClient as {
          fetchThreadReplies: (
            channel: string,
            thread_ts: string,
            limit?: number
          ) => Promise<Array<{ ts: string; user?: string; text?: string }>>;
        };
        const replies = await slackClient.fetchThreadReplies(channel, threadId, 40);
        threadMessages = replies
          .filter(m => m.text)
          .map(m => ({
            user: m.user || 'unknown',
            text: m.text || '',
          }));
        logger.debug(
          `[Scheduler] Fetched ${threadMessages.length} thread messages for reminder ${schedule.id}`
        );
      } catch (error) {
        logger.warn(
          `[Scheduler] Failed to fetch thread history: ${
            error instanceof Error ? error.message : error
          }`
        );
      }
    }

    // Build context message that includes previous response if available
    let contextualReminderText = reminderText;
    if (schedule.isRecurring && schedule.previousResponse) {
      contextualReminderText = `${reminderText}

---
**Previous Response (for context):**
${schedule.previousResponse}
---

Please provide an updated response based on the reminder above. You may reference or build upon the previous response if relevant.`;
    }

    // Build synthetic Slack event - same structure as real Slack messages
    const syntheticPayload = {
      event: {
        type: 'message',
        subtype: 'scheduled_reminder',
        text: contextualReminderText,
        user: schedule.creatorId,
        channel: channel,
        ts: String(Date.now() / 1000),
        thread_ts: threadId, // Include thread_ts if this is a thread reply
      },
      slack_conversation: {
        current: {
          user: schedule.creatorName || schedule.creatorId,
          text: contextualReminderText,
        },
        // Include thread history if available, otherwise just the reminder
        messages:
          threadMessages.length > 0
            ? [
                ...threadMessages,
                { user: schedule.creatorName || schedule.creatorId, text: contextualReminderText },
              ]
            : [{ user: schedule.creatorName || schedule.creatorId, text: contextualReminderText }],
      },
      // Include schedule context for any checks that need it
      schedule: {
        id: schedule.id,
        isReminder: true,
        creatorId: schedule.creatorId,
        creatorContext: schedule.creatorContext,
        previousResponse: schedule.previousResponse,
      },
    };

    // Create webhook context map - use the endpoint from Slack config (same as socket-runner)
    const webhookData = new Map<string, unknown>();
    const slackEndpoint = (this.visorConfig as any).slack?.endpoint || '/bots/slack/support';
    webhookData.set(slackEndpoint, syntheticPayload);

    // Seed the first message in PromptStateManager so human-input checks can consume it
    // This is the same pattern socket-runner.ts uses for real Slack messages
    const threadTs = syntheticPayload.event.ts;
    if (channel && threadTs) {
      const mgr = getPromptStateManager();
      mgr.setFirstMessage(channel, threadTs, reminderText);
    }

    // Clone config for this run and ensure Slack frontend is present
    const cfgForRun: VisorConfig = JSON.parse(JSON.stringify(this.visorConfig));
    const fronts = Array.isArray(cfgForRun.frontends) ? cfgForRun.frontends : [];
    if (!fronts.some((f: any) => f && f.name === 'slack')) {
      fronts.push({ name: 'slack' });
    }
    cfgForRun.frontends = fronts;

    // Create a new engine instance
    const runEngine = new StateMachineExecutionEngine();

    // Set up response capture for recurring reminders
    let capturedResponse: string | undefined;
    const responseCapture = (text: string) => {
      capturedResponse = text;
      logger.debug(
        `[Scheduler] Captured AI response for schedule ${schedule.id} (${text.length} chars)`
      );
    };

    // Set execution context with reminder text and Slack client
    // This provides input for human-input checks and allows Slack frontend to post
    runEngine.setExecutionContext({
      ...this.executionContext,
      cliMessage: reminderText,
      responseCapture, // Callback for capturing AI responses
    });

    try {
      // Execute ALL checks - let the visor engine route based on config
      // This is the same pattern socket-runner.ts uses for Slack messages
      await runEngine.executeChecks({
        checks: allChecks,
        showDetails: true,
        outputFormat: 'json',
        config: cfgForRun,
        webhookContext: { webhookData, eventType: 'schedule' },
        debug: process.env.VISOR_DEBUG === 'true',
      } as any);

      // The visor pipeline handles output via frontends (Slack, etc.)
      // We return success - the actual response was posted by the pipeline

      // Save captured response for recurring reminders (previousResponse feature)
      if (schedule.isRecurring && capturedResponse) {
        this.store.update(schedule.id, { previousResponse: capturedResponse });
        logger.info(
          `[Scheduler] Saved previousResponse for recurring schedule ${schedule.id} (${capturedResponse.length} chars)`
        );
      }

      return {
        message: 'Reminder processed through pipeline',
        type: 'pipeline_executed',
        reminderText,
        capturedResponse,
      };
    } catch (error) {
      logger.error(
        `[Scheduler] Failed to run reminder through pipeline: ${error instanceof Error ? error.message : error}`
      );
      // Fallback to just returning the reminder text for posting
      return { message: reminderText, type: 'simple_reminder' };
    }
  }

  /**
   * Handle schedule execution failure
   */
  private async handleScheduleFailure(schedule: Schedule, error: unknown): Promise<void> {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    logger.error(`[Scheduler] Schedule ${schedule.id} failed: ${errorMsg}`);

    const newFailureCount = schedule.failureCount + 1;

    // Update failure count
    this.store.update(schedule.id, {
      failureCount: newFailureCount,
      lastError: errorMsg,
    });

    // Auto-pause after 3 consecutive failures
    if (newFailureCount >= 3) {
      this.store.update(schedule.id, { status: 'failed' });

      // Stop the cron job
      const job = this.cronJobs.get(schedule.id);
      if (job) {
        job.stop();
        this.cronJobs.delete(schedule.id);
      }

      logger.warn(`[Scheduler] Schedule ${schedule.id} paused after 3 consecutive failures`);
    }
  }

  /**
   * Send execution result to the appropriate output adapter
   */
  private async sendResult(schedule: Schedule, result: ScheduleExecutionResult): Promise<void> {
    const outputType = schedule.outputContext?.type || 'none';

    // Get the appropriate adapter
    const adapter = this.outputAdapters.get(outputType);
    if (!adapter) {
      if (outputType !== 'none') {
        logger.warn(`[Scheduler] No output adapter registered for type: ${outputType}`);
      }
      return;
    }

    try {
      await adapter.sendResult(schedule, result);
    } catch (error) {
      logger.error(
        `[Scheduler] Failed to send result via ${outputType} adapter: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }
  }

  /**
   * Check if scheduler is running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get scheduler stats
   */
  getStats(): {
    running: boolean;
    activeCronJobs: number;
    pendingOneTimeSchedules: number;
    storeStats: ReturnType<ScheduleStore['getStats']>;
  } {
    return {
      running: this.running,
      activeCronJobs: this.cronJobs.size,
      pendingOneTimeSchedules: this.oneTimeTimeouts.size,
      storeStats: this.store.getStats(),
    };
  }
}

// Singleton instance
let schedulerInstance: Scheduler | undefined;

/**
 * Get the singleton scheduler instance
 */
export function getScheduler(
  visorConfig?: VisorConfig,
  config?: SchedulerConfig
): Scheduler | undefined {
  if (!schedulerInstance && visorConfig) {
    schedulerInstance = new Scheduler(visorConfig, config);
  }
  return schedulerInstance;
}

/**
 * Reset the scheduler instance (for testing)
 */
export function resetScheduler(): void {
  if (schedulerInstance) {
    schedulerInstance.stop().catch(() => {});
  }
  schedulerInstance = undefined;
}
