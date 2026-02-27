/**
 * CLI command handlers for the scheduler
 *
 * Commands:
 *   visor schedule start [--config path]    - Run scheduler daemon
 *   visor schedule list                     - Show active schedules
 *   visor schedule create <workflow> --at "time" [--output slack:#channel]
 *   visor schedule cancel <id>              - Cancel a schedule
 */
import { ScheduleStore, ScheduleOutputContext } from './schedule-store';
import { Scheduler, getScheduler } from './scheduler';
import { parseScheduleExpression, getNextRunTime } from './schedule-parser';
import { configureLoggerFromCli } from '../logger';
import { ConfigManager } from '../config';
import { StateMachineExecutionEngine } from '../state-machine-execution-engine';
import type { VisorConfig, SchedulerConfig as VisorSchedulerConfig } from '../types/config';

/**
 * Parse CLI arguments for schedule commands
 */
function parseArgs(argv: string[]): {
  subcommand: string;
  positional: string[];
  flags: Record<string, string | boolean>;
} {
  const subcommand = argv[0] || 'help';
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    }
  }

  return { subcommand, positional, flags };
}

/**
 * Handle the schedule subcommand
 */
export async function handleScheduleCommand(
  argv: string[],
  configManager: ConfigManager
): Promise<void> {
  const { subcommand, positional, flags } = parseArgs(argv);

  // Configure logger
  configureLoggerFromCli({
    output: 'table',
    debug: flags.debug === true || process.env.VISOR_DEBUG === 'true',
    verbose: flags.verbose === true,
    quiet: flags.quiet === true,
  });

  switch (subcommand) {
    case 'start':
      await handleStart(flags, configManager);
      break;
    case 'list':
      await handleList(flags);
      break;
    case 'create':
      await handleCreate(positional, flags);
      break;
    case 'cancel':
      await handleCancel(positional, flags);
      break;
    case 'pause':
      await handlePause(positional, flags);
      break;
    case 'resume':
      await handleResume(positional, flags);
      break;
    case 'help':
    default:
      printHelp();
      break;
  }
}

/**
 * Print help text
 */
function printHelp(): void {
  console.log(`
Visor Schedule - Manage scheduled workflow executions

USAGE:
  visor schedule <command> [options]

COMMANDS:
  start                Start the scheduler daemon
  list                 List all active schedules
  create <workflow>    Create a new schedule
  cancel <id>          Cancel a schedule
  pause <id>           Pause a schedule
  resume <id>          Resume a paused schedule
  help                 Show this help message

OPTIONS:
  --config <path>      Path to Visor configuration file
  --at "<time>"        Schedule time (e.g., "every Monday at 9am", "in 2 hours")
  --output <dest>      Output destination (e.g., "slack:#channel", "webhook:url")
  --inputs <json>      JSON string of workflow inputs

EXAMPLES:
  # Start scheduler daemon
  visor schedule start --config .visor.yaml

  # Create a recurring schedule
  visor schedule create daily-report --at "every day at 9am" --output slack:#reports

  # Create a one-time schedule
  visor schedule create security-scan --at "in 2 hours"

  # List schedules
  visor schedule list

  # Cancel a schedule
  visor schedule cancel abc12345
`);
}

/**
 * Handle 'schedule start' - run the scheduler daemon
 */
async function handleStart(
  flags: Record<string, string | boolean>,
  configManager: ConfigManager
): Promise<void> {
  console.log('Starting Visor Scheduler...');

  // Load configuration
  const configPath = typeof flags.config === 'string' ? flags.config : undefined;
  let config: VisorConfig;

  try {
    if (configPath) {
      config = await configManager.loadConfig(configPath);
    } else {
      config = await configManager.findAndLoadConfig();
    }
  } catch (error) {
    console.error(
      `Failed to load configuration: ${error instanceof Error ? error.message : error}`
    );
    process.exit(1);
  }

  // Get scheduler config from visor config
  const schedulerConfig = (config as any).scheduler as VisorSchedulerConfig | undefined;

  // Check if scheduler is enabled
  if (schedulerConfig?.enabled === false) {
    console.error('Scheduler is disabled in configuration (scheduler.enabled: false)');
    process.exit(1);
  }

  // Create scheduler with mapped limits and storage config
  const scheduler = new Scheduler(config, {
    storagePath: schedulerConfig?.storage?.path,
    limits: schedulerConfig?.limits
      ? {
          maxPerUser: schedulerConfig.limits.max_per_user,
          maxRecurringPerUser: schedulerConfig.limits.max_recurring_per_user,
          maxGlobal: schedulerConfig.limits.max_global,
        }
      : undefined,
    defaultTimezone: schedulerConfig?.default_timezone,
    storage: schedulerConfig?.storage?.driver
      ? {
          driver: schedulerConfig.storage.driver,
          connection: schedulerConfig.storage.connection,
        }
      : undefined,
    ha: schedulerConfig?.ha
      ? {
          enabled: schedulerConfig.ha.enabled ?? false,
          node_id: schedulerConfig.ha.node_id,
          lock_ttl: schedulerConfig.ha.lock_ttl,
          heartbeat_interval: schedulerConfig.ha.heartbeat_interval,
        }
      : undefined,
  });

  // Create and set execution engine
  const engine = new StateMachineExecutionEngine();
  scheduler.setEngine(engine);

  // Start scheduler
  try {
    await scheduler.start();
    console.log('Scheduler started successfully');
    console.log(`Storage: ${schedulerConfig?.storage?.path || '.visor/schedules.json'}`);
    console.log(`Timezone: ${schedulerConfig?.default_timezone || 'UTC'}`);

    // Print stats
    const stats = await scheduler.getStats();
    console.log(`Active schedules: ${stats.storeStats.active}`);
    console.log(`Recurring: ${stats.storeStats.recurring}, One-time: ${stats.storeStats.oneTime}`);

    console.log('\nPress Ctrl+C to stop\n');

    // Handle shutdown
    const shutdown = async () => {
      console.log('\nShutting down scheduler...');
      await scheduler.stop();
      console.log('Scheduler stopped');
      process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    // Keep process alive
    process.stdin.resume();
  } catch (error) {
    console.error(`Failed to start scheduler: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

/**
 * Handle 'schedule list' - list all schedules
 */
async function handleList(flags: Record<string, string | boolean>): Promise<void> {
  const store = ScheduleStore.getInstance({
    path: typeof flags.config === 'string' ? undefined : '.visor/schedules.json',
  });

  await store.initialize();

  const allSchedules = await store.getAllAsync();
  const schedules = allSchedules.filter(s => s.status !== 'completed');

  if (schedules.length === 0) {
    console.log('No active schedules found.');
    console.log('\nTo create a schedule:');
    console.log('  visor schedule create <workflow> --at "every Monday at 9am"');
    return;
  }

  console.log(`Found ${schedules.length} schedule(s):\n`);

  for (const schedule of schedules) {
    const when = schedule.isRecurring
      ? schedule.originalExpression
      : new Date(schedule.runAt!).toLocaleString();
    const status = schedule.status !== 'active' ? ` [${schedule.status.toUpperCase()}]` : '';
    const output = schedule.outputContext?.type
      ? ` → ${schedule.outputContext.type}${schedule.outputContext.target ? `:${schedule.outputContext.target}` : ''}`
      : '';

    console.log(`  ${schedule.id.substring(0, 8)}  ${schedule.workflow}`);
    console.log(`           ${when}${output}${status}`);
    if (schedule.nextRunAt) {
      console.log(`           Next: ${new Date(schedule.nextRunAt).toLocaleString()}`);
    }
    console.log();
  }
}

/**
 * Handle 'schedule create' - create a new schedule
 */
async function handleCreate(
  positional: string[],
  flags: Record<string, string | boolean>
): Promise<void> {
  const workflow = positional[0];
  const expression = flags.at as string | undefined;

  if (!workflow) {
    console.error('Error: Workflow name is required');
    console.log('Usage: visor schedule create <workflow> --at "time"');
    process.exit(1);
  }

  if (!expression) {
    console.error('Error: Schedule time is required');
    console.log('Usage: visor schedule create <workflow> --at "every Monday at 9am"');
    process.exit(1);
  }

  // Parse output destination
  let outputContext: ScheduleOutputContext | undefined;
  if (flags.output && typeof flags.output === 'string') {
    const [type, target] = flags.output.split(':');
    if (type === 'slack' || type === 'github' || type === 'webhook') {
      outputContext = { type, target };
    } else {
      console.error(`Error: Unknown output type: ${type}`);
      console.log('Supported types: slack, github, webhook');
      process.exit(1);
    }
  }

  // Parse inputs
  let inputs: Record<string, unknown> | undefined;
  if (flags.inputs && typeof flags.inputs === 'string') {
    try {
      inputs = JSON.parse(flags.inputs);
    } catch {
      console.error('Error: Invalid JSON for --inputs');
      process.exit(1);
    }
  }

  // Get timezone
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';

  try {
    // Parse the schedule expression
    const parsed = parseScheduleExpression(expression, timezone);

    // Initialize store
    const store = ScheduleStore.getInstance();
    await store.initialize();

    // Create the schedule
    const schedule = await store.createAsync({
      creatorId: process.env.USER || 'cli-user',
      creatorContext: 'cli',
      timezone,
      schedule: parsed.cronExpression || '',
      runAt: parsed.type === 'one-time' ? parsed.runAt?.getTime() : undefined,
      isRecurring: parsed.type === 'recurring',
      originalExpression: expression,
      workflow,
      workflowInputs: inputs,
      outputContext,
      nextRunAt:
        parsed.type === 'recurring' && parsed.cronExpression
          ? getNextRunTime(parsed.cronExpression, timezone).getTime()
          : parsed.runAt?.getTime(),
    });

    console.log('Schedule created successfully!');
    console.log();
    console.log(`  ID:       ${schedule.id.substring(0, 8)}`);
    console.log(`  Workflow: ${schedule.workflow}`);
    console.log(`  When:     ${schedule.originalExpression}`);
    if (schedule.nextRunAt) {
      console.log(`  Next run: ${new Date(schedule.nextRunAt).toLocaleString()}`);
    }
    if (outputContext) {
      console.log(`  Output:   ${outputContext.type}:${outputContext.target || ''}`);
    }
    console.log();
    console.log('Start the scheduler daemon to execute this schedule:');
    console.log('  visor schedule start');
  } catch (error) {
    console.error(`Failed to create schedule: ${error instanceof Error ? error.message : error}`);
    process.exit(1);
  }
}

/**
 * Get the current CLI user identifier
 */
function getCurrentCliUser(): string {
  return process.env.USER || process.env.USERNAME || 'cli-user';
}

/**
 * Verify ownership of a schedule (for CLI operations)
 * Returns true if the user owns the schedule or --force is used
 */
function verifyOwnership(
  schedule: { creatorId: string; creatorContext?: string },
  flags: Record<string, string | boolean>,
  operation: string
): boolean {
  const currentUser = getCurrentCliUser();
  const isOwner = schedule.creatorContext === 'cli' && schedule.creatorId === currentUser;
  const forceFlag = flags.force === true;

  if (!isOwner && !forceFlag) {
    console.error(`Error: You do not own this schedule.`);
    console.error(`  Owner: ${schedule.creatorId} (${schedule.creatorContext || 'unknown'})`);
    console.error(`  You:   ${currentUser} (cli)`);
    console.log();
    console.log(`Use --force to ${operation} schedules you don't own.`);
    return false;
  }

  return true;
}

/**
 * Handle 'schedule cancel' - cancel a schedule
 */
async function handleCancel(
  positional: string[],
  flags: Record<string, string | boolean>
): Promise<void> {
  const scheduleId = positional[0];

  if (!scheduleId) {
    console.error('Error: Schedule ID is required');
    console.log('Usage: visor schedule cancel <id> [--force]');
    process.exit(1);
  }

  const store = ScheduleStore.getInstance();
  await store.initialize();

  // Find schedule by ID or partial ID
  let schedule = await store.getAsync(scheduleId);
  if (!schedule) {
    const all = await store.getAllAsync();
    schedule = all.find(s => s.id.startsWith(scheduleId));
  }

  if (!schedule) {
    console.error(`Schedule not found: ${scheduleId}`);
    console.log('\nUse "visor schedule list" to see available schedules.');
    process.exit(1);
  }

  // Verify ownership
  if (!verifyOwnership(schedule, flags, 'cancel')) {
    process.exit(1);
  }

  await store.deleteAsync(schedule.id);

  // Also cancel the in-memory job (cron or timeout) so it doesn't fire
  const scheduler = getScheduler();
  if (scheduler) {
    scheduler.cancelSchedule(schedule.id);
  }

  console.log('Schedule cancelled successfully!');
  console.log();
  console.log(`  ID:       ${schedule.id.substring(0, 8)}`);
  console.log(`  Workflow: ${schedule.workflow}`);
  console.log(`  Was:      ${schedule.originalExpression}`);
}

/**
 * Handle 'schedule pause' - pause a schedule
 */
async function handlePause(
  positional: string[],
  flags: Record<string, string | boolean>
): Promise<void> {
  const scheduleId = positional[0];

  if (!scheduleId) {
    console.error('Error: Schedule ID is required');
    console.log('Usage: visor schedule pause <id> [--force]');
    process.exit(1);
  }

  const store = ScheduleStore.getInstance();
  await store.initialize();

  // Find schedule by ID or partial ID
  let schedule = await store.getAsync(scheduleId);
  if (!schedule) {
    const all = await store.getAllAsync();
    schedule = all.find(s => s.id.startsWith(scheduleId));
  }

  if (!schedule) {
    console.error(`Schedule not found: ${scheduleId}`);
    process.exit(1);
  }

  // Verify ownership
  if (!verifyOwnership(schedule, flags, 'pause')) {
    process.exit(1);
  }

  await store.updateAsync(schedule.id, { status: 'paused' });

  console.log('Schedule paused successfully!');
  console.log();
  console.log(`  ID:       ${schedule.id.substring(0, 8)}`);
  console.log(`  Workflow: ${schedule.workflow}`);
  console.log('\nUse "visor schedule resume <id>" to resume.');
}

/**
 * Handle 'schedule resume' - resume a paused schedule
 */
async function handleResume(
  positional: string[],
  flags: Record<string, string | boolean>
): Promise<void> {
  const scheduleId = positional[0];

  if (!scheduleId) {
    console.error('Error: Schedule ID is required');
    console.log('Usage: visor schedule resume <id> [--force]');
    process.exit(1);
  }

  const store = ScheduleStore.getInstance();
  await store.initialize();

  // Find schedule by ID or partial ID
  let schedule = await store.getAsync(scheduleId);
  if (!schedule) {
    const all = await store.getAllAsync();
    schedule = all.find(s => s.id.startsWith(scheduleId));
  }

  if (!schedule) {
    console.error(`Schedule not found: ${scheduleId}`);
    process.exit(1);
  }

  // Verify ownership
  if (!verifyOwnership(schedule, flags, 'resume')) {
    process.exit(1);
  }

  await store.updateAsync(schedule.id, { status: 'active' });

  console.log('Schedule resumed successfully!');
  console.log();
  console.log(`  ID:       ${schedule.id.substring(0, 8)}`);
  console.log(`  Workflow: ${schedule.workflow}`);
}
