/**
 * Generic AI Tool for scheduling and managing workflow executions
 * This tool is frontend-agnostic and can work with any context (Slack, CLI, GitHub, etc.)
 */
import { CustomToolDefinition } from '../types/config';
import { ScheduleStore, Schedule, ScheduleOutputContext } from './schedule-store';
import { isValidCronExpression, getNextRunTime } from './schedule-parser';
import { getScheduler } from './scheduler';
import { logger } from '../logger';
import type { MessageTrigger } from './store/types';

/**
 * Simple glob-style pattern matching for workflow names
 * Supports * (any characters) and ? (single character)
 */
function matchGlobPattern(pattern: string, value: string): boolean {
  // Escape regex special chars except * and ?
  const regexPattern = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${regexPattern}$`).test(value);
}

/**
 * Check if a workflow is allowed by patterns
 */
function isWorkflowAllowedByPatterns(
  workflow: string,
  allowedPatterns?: string[],
  deniedPatterns?: string[]
): { allowed: boolean; reason?: string } {
  // If denied patterns exist and workflow matches any, deny
  if (deniedPatterns && deniedPatterns.length > 0) {
    for (const pattern of deniedPatterns) {
      if (matchGlobPattern(pattern, workflow)) {
        return {
          allowed: false,
          reason: `Workflow "${workflow}" matches denied pattern "${pattern}"`,
        };
      }
    }
  }

  // If allowed patterns exist, workflow must match at least one
  if (allowedPatterns && allowedPatterns.length > 0) {
    for (const pattern of allowedPatterns) {
      if (matchGlobPattern(pattern, workflow)) {
        return { allowed: true };
      }
    }
    return {
      allowed: false,
      reason: `Workflow "${workflow}" does not match any allowed patterns: ${allowedPatterns.join(', ')}`,
    };
  }

  // No patterns defined - allow by default
  return { allowed: true };
}

/**
 * Check permissions for creating a schedule
 */
function checkSchedulePermissions(
  context: ScheduleToolContext,
  workflow: string,
  requestedScheduleType?: ScheduleType
): { allowed: boolean; reason?: string } {
  const permissions = context.permissions;
  const scheduleType = requestedScheduleType || context.scheduleType || 'personal';

  // Enforce context-based restrictions first
  // From a DM, can only create personal schedules
  // From a channel, can only create channel schedules
  // From a group DM, can only create dm/group schedules
  if (context.allowedScheduleType && scheduleType !== context.allowedScheduleType) {
    const contextNames: Record<ScheduleType, string> = {
      personal: 'a direct message (DM)',
      channel: 'a channel',
      dm: 'a group DM',
    };
    const targetNames: Record<ScheduleType, string> = {
      personal: 'personal',
      channel: 'channel',
      dm: 'group',
    };
    return {
      allowed: false,
      reason: `From ${contextNames[context.allowedScheduleType]}, you can only create ${targetNames[context.allowedScheduleType]} schedules. To create a ${targetNames[scheduleType]} schedule, please use the appropriate context.`,
    };
  }

  // No permissions configured - allow everything (backwards compatible)
  if (!permissions) {
    return { allowed: true };
  }

  // Check schedule type permission
  switch (scheduleType) {
    case 'personal':
      if (permissions.allowPersonal === false) {
        return {
          allowed: false,
          reason: 'Personal schedules are not allowed in this configuration',
        };
      }
      break;
    case 'channel':
      if (permissions.allowChannel === false) {
        return {
          allowed: false,
          reason: 'Channel schedules are not allowed in this configuration',
        };
      }
      break;
    case 'dm':
      if (permissions.allowDm === false) {
        return {
          allowed: false,
          reason: 'DM schedules are not allowed in this configuration',
        };
      }
      break;
  }

  // Check workflow patterns
  return isWorkflowAllowedByPatterns(
    workflow,
    permissions.allowedWorkflows,
    permissions.deniedWorkflows
  );
}

/**
 * Tool action types
 */
export type ScheduleAction =
  | 'create'
  | 'list'
  | 'cancel'
  | 'pause'
  | 'resume'
  | 'create_trigger'
  | 'list_triggers'
  | 'delete_trigger'
  | 'update_trigger';

/**
 * Target type for where to send the reminder/output
 */
export type TargetType = 'channel' | 'dm' | 'thread' | 'user';

/**
 * Tool input arguments - AI provides structured data, no parsing needed
 */
export interface ScheduleToolArgs {
  action: ScheduleAction;

  // For create action - AI extracts and structures all of this:
  /** What to say/do when the schedule fires */
  reminder_text?: string;
  /** Where to send: channel, dm (to self), thread, or user (DM to specific user) */
  target_type?: TargetType;
  /** The Slack channel ID (C... for channels, D... for DMs) */
  target_id?: string;
  /** For thread replies: the thread_ts to reply to */
  thread_ts?: string;
  /** Is this a recurring schedule? */
  is_recurring?: boolean;
  /** For recurring: cron expression (AI generates this, e.g., "* * * * *" for every minute) */
  cron?: string;
  /** For one-time: ISO 8601 timestamp when to run */
  run_at?: string;
  /** Original natural language expression (for display only) */
  original_expression?: string;
  /** Optional workflow to run instead of just sending reminder_text */
  workflow?: string;
  /** Optional workflow inputs */
  workflow_inputs?: Record<string, unknown>;

  // For cancel/pause/resume actions:
  schedule_id?: string;

  // For trigger actions:
  /** For create_trigger: channel IDs to monitor */
  trigger_channels?: string[];
  /** For create_trigger: Slack user IDs to filter by (only trigger for these users) */
  trigger_from?: string[];
  /** For create_trigger: allow bot messages (default: false) */
  trigger_from_bots?: boolean;
  /** For create_trigger: keyword patterns (case-insensitive OR) */
  trigger_contains?: string[];
  /** For create_trigger: regex pattern */
  trigger_match?: string;
  /** For create_trigger: thread scope (default: 'any') */
  trigger_threads?: 'root_only' | 'thread_only' | 'any';
  /** For create_trigger: human-readable description */
  trigger_description?: string;
  /** For delete_trigger / update_trigger: trigger ID */
  trigger_id?: string;
  /** For update_trigger: enable/disable */
  trigger_enabled?: boolean;
}

/**
 * Schedule type for permission checking
 */
export type ScheduleType = 'personal' | 'channel' | 'dm';

/**
 * Permissions configuration for dynamic schedules
 */
export interface SchedulePermissions {
  /** Allow personal schedules (via DM or CLI) */
  allowPersonal?: boolean;
  /** Allow channel schedules (in Slack channels) */
  allowChannel?: boolean;
  /** Allow DM schedules (to specific users) */
  allowDm?: boolean;
  /** List of allowed workflow patterns (glob-style, e.g., "report-*") */
  allowedWorkflows?: string[];
  /** List of denied workflow patterns */
  deniedWorkflows?: string[];
}

/**
 * Context passed to the tool handler
 * This is generic and works with any frontend
 */
export interface ScheduleToolContext {
  /** Generic user ID (can be Slack user, GitHub user, CLI user, etc.) */
  userId: string;
  /** User display name (optional) */
  userName?: string;
  /** Context identifier: "slack:U123", "github:user", "cli", etc. */
  contextType: string;
  /** User's timezone (IANA format) */
  timezone?: string;
  /** Available workflows in the current config */
  availableWorkflows?: string[];
  /** Schedule type being created (for permission checking) */
  scheduleType?: ScheduleType;
  /** Permissions for dynamic schedule creation */
  permissions?: SchedulePermissions;
  /**
   * Allowed schedule type based on originating context.
   * When set, only schedules of this type can be created/managed.
   * - From DM: only 'personal' allowed
   * - From channel: only 'channel' allowed
   * - From group DM: only 'dm' allowed (targeting the group)
   */
  allowedScheduleType?: ScheduleType;
}

/**
 * Tool execution result
 */
export interface ScheduleToolResult {
  success: boolean;
  message: string;
  schedule?: Schedule;
  schedules?: Schedule[];
  error?: string;
}

/**
 * Format a schedule for display
 */
function formatSchedule(schedule: Schedule): string {
  const time = schedule.isRecurring
    ? schedule.originalExpression
    : new Date(schedule.runAt!).toLocaleString();
  const status = schedule.status !== 'active' ? ` (${schedule.status})` : '';
  // For simple reminders, show the reminder text; for workflows, show the workflow name
  const displayName =
    schedule.workflow || (schedule.workflowInputs?.text as string) || 'scheduled message';
  const truncatedName =
    displayName.length > 30 ? displayName.substring(0, 27) + '...' : displayName;
  const output = schedule.outputContext?.type || 'none';

  return `\`${schedule.id.substring(0, 8)}\` - "${truncatedName}" - ${time} (→ ${output})${status}`;
}

/**
 * Format confirmation message for a new schedule
 */
function formatCreateConfirmation(schedule: Schedule): string {
  const outputDesc = schedule.outputContext?.type
    ? `${schedule.outputContext.type}${schedule.outputContext.target ? `:${schedule.outputContext.target}` : ''}`
    : 'none';

  // For simple reminders, show the reminder text; for workflows, show the workflow name
  const displayName =
    schedule.workflow || (schedule.workflowInputs?.text as string) || 'scheduled message';

  if (schedule.isRecurring) {
    const nextRun = schedule.nextRunAt
      ? new Date(schedule.nextRunAt).toLocaleString('en-US', {
          weekday: 'long',
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
        })
      : 'calculating...';

    return `**Schedule created!**

**${schedule.workflow ? 'Workflow' : 'Reminder'}**: ${displayName}
**When**: ${schedule.originalExpression}
**Output**: ${outputDesc}
**Next run**: ${nextRun}

ID: \`${schedule.id.substring(0, 8)}\``;
  } else {
    const when = new Date(schedule.runAt!).toLocaleString('en-US', {
      weekday: 'long',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });

    return `**Schedule created!**

**${schedule.workflow ? 'Workflow' : 'Reminder'}**: ${displayName}
**When**: ${when}
**Output**: ${outputDesc}

ID: \`${schedule.id.substring(0, 8)}\``;
  }
}

/**
 * Format the list of schedules
 */
function formatScheduleList(schedules: Schedule[]): string {
  if (schedules.length === 0) {
    return `You don't have any active schedules.

To create one: "remind me every Monday at 9am to check PRs" or "schedule %daily-report every Monday at 9am"`;
  }

  const lines = schedules.map((s, i) => `${i + 1}. ${formatSchedule(s)}`);

  return `**Your active schedules:**

${lines.join('\n')}

To cancel: "cancel schedule <id>"
To pause: "pause schedule <id>"`;
}

/**
 * Handle schedule tool actions
 */
export async function handleScheduleAction(
  args: ScheduleToolArgs,
  context: ScheduleToolContext
): Promise<ScheduleToolResult> {
  const store = ScheduleStore.getInstance();

  // Ensure store is initialized
  if (!store.isInitialized()) {
    await store.initialize();
  }

  switch (args.action) {
    case 'create':
      return handleCreate(args, context, store);

    case 'list':
      return handleList(context, store);

    case 'cancel':
      return handleCancel(args, context, store);

    case 'pause':
      return handlePauseResume(args, context, store, 'paused');

    case 'resume':
      return handlePauseResume(args, context, store, 'active');

    case 'create_trigger':
      return handleCreateTrigger(args, context, store);

    case 'list_triggers':
      return handleListTriggers(context, store);

    case 'delete_trigger':
      return handleDeleteTrigger(args, context, store);

    case 'update_trigger':
      return handleUpdateTrigger(args, context, store);

    default:
      return {
        success: false,
        message: `Unknown action: ${args.action}`,
        error: `Supported actions: create, list, cancel, pause, resume, create_trigger, list_triggers, delete_trigger, update_trigger`,
      };
  }
}

/**
 * Handle create action - AI provides structured data, minimal parsing needed
 */
async function handleCreate(
  args: ScheduleToolArgs,
  context: ScheduleToolContext,
  store: ScheduleStore
): Promise<ScheduleToolResult> {
  // Validate: need either reminder_text or workflow
  if (!args.reminder_text && !args.workflow) {
    return {
      success: false,
      message: 'Missing reminder content',
      error: 'Please specify either reminder_text (what to say) or workflow (what to run)',
    };
  }

  // Validate: need either cron (recurring) or run_at (one-time)
  if (!args.cron && !args.run_at) {
    return {
      success: false,
      message: 'Missing schedule timing',
      error:
        'Please specify either cron (for recurring, e.g., "* * * * *") or run_at (ISO timestamp for one-time)',
    };
  }

  // Validate cron format if provided
  if (args.cron && !isValidCronExpression(args.cron)) {
    return {
      success: false,
      message: 'Invalid cron expression',
      error: `"${args.cron}" is not a valid cron expression. Format: "minute hour day-of-month month day-of-week"`,
    };
  }

  // Validate run_at format if provided
  let runAtTimestamp: number | undefined;
  if (args.run_at) {
    const parsed = new Date(args.run_at);
    if (isNaN(parsed.getTime())) {
      return {
        success: false,
        message: 'Invalid run_at timestamp',
        error: `"${args.run_at}" is not a valid ISO 8601 timestamp`,
      };
    }
    if (parsed.getTime() <= Date.now()) {
      return {
        success: false,
        message: 'run_at must be in the future',
        error: 'Cannot schedule a reminder in the past',
      };
    }
    runAtTimestamp = parsed.getTime();
  }

  // Validate target_id is provided when target_type is specified
  if (args.target_type && !args.target_id) {
    return {
      success: false,
      message: 'Missing target_id',
      error: `target_type "${args.target_type}" requires a target_id (channel ID, user ID, or thread_ts)`,
    };
  }

  // Determine schedule type from target
  // 'channel' -> channel schedule, 'user' -> dm schedule, 'dm' or 'thread' -> personal
  let scheduleType: ScheduleType = 'personal';
  if (args.target_type === 'channel') {
    scheduleType = 'channel';
  } else if (args.target_type === 'user') {
    scheduleType = 'dm'; // Sending to a specific user is a DM schedule
  }

  // Check permissions
  const workflowName = args.workflow || 'reminder';
  const permissionCheck = checkSchedulePermissions(context, workflowName, scheduleType);
  if (!permissionCheck.allowed) {
    logger.warn(
      `[ScheduleTool] Permission denied for user ${context.userId}: ${permissionCheck.reason}`
    );
    return {
      success: false,
      message: 'Permission denied',
      error: permissionCheck.reason || 'You do not have permission to create this schedule',
    };
  }

  // Validate workflow exists if specified and we have available workflows
  if (
    args.workflow &&
    context.availableWorkflows &&
    !context.availableWorkflows.includes(args.workflow)
  ) {
    return {
      success: false,
      message: `Workflow "${args.workflow}" not found`,
      error: `Available workflows: ${context.availableWorkflows.slice(0, 5).join(', ')}${context.availableWorkflows.length > 5 ? '...' : ''}`,
    };
  }

  try {
    const timezone = context.timezone || 'UTC';
    const isRecurring = args.is_recurring === true || !!args.cron;

    // Build output context from AI-provided target info
    let outputContext: ScheduleOutputContext | undefined;
    if (args.target_type && args.target_id) {
      outputContext = {
        type: 'slack', // Currently only Slack supported
        target: args.target_id, // Channel ID (C... or D...)
        threadId: args.thread_ts, // Thread timestamp for replies
        metadata: {
          targetType: args.target_type,
          reminderText: args.reminder_text,
        },
      };
    }

    // Calculate next run time
    let nextRunAt: number | undefined;
    if (isRecurring && args.cron) {
      nextRunAt = getNextRunTime(args.cron, timezone).getTime();
    } else if (runAtTimestamp) {
      nextRunAt = runAtTimestamp;
    }

    // Create the schedule - AI has done all the parsing
    // workflow is only set when explicitly provided (e.g., from YAML cron jobs)
    // For simple reminders, workflow is undefined and scheduler posts text directly
    const schedule = await store.createAsync({
      creatorId: context.userId,
      creatorContext: context.contextType,
      creatorName: context.userName,
      timezone,
      schedule: args.cron || '',
      runAt: runAtTimestamp,
      isRecurring,
      originalExpression: args.original_expression || args.cron || args.run_at || '',
      workflow: args.workflow, // Only set if explicitly provided
      workflowInputs:
        args.workflow_inputs || (args.reminder_text ? { text: args.reminder_text } : undefined),
      outputContext,
      nextRunAt,
    });

    const displayText = args.reminder_text || args.workflow || 'scheduled task';
    logger.info(
      `[ScheduleTool] Created schedule ${schedule.id} for user ${context.userId}: "${displayText}"`
    );

    return {
      success: true,
      message: formatCreateConfirmation(schedule),
      schedule,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    logger.warn(`[ScheduleTool] Failed to create schedule: ${errorMsg}`);

    return {
      success: false,
      message: `Failed to create schedule: ${errorMsg}`,
      error: errorMsg,
    };
  }
}

/**
 * Handle list action
 * Users can only see their own schedules to protect privacy
 */
async function handleList(
  context: ScheduleToolContext,
  store: ScheduleStore
): Promise<ScheduleToolResult> {
  // Only show schedules created by this user - protects privacy of personal schedules
  const allUserSchedules = await store.getByCreatorAsync(context.userId);
  const schedules = allUserSchedules.filter(s => s.status !== 'completed');

  // If in a specific context, optionally filter to show only relevant schedules
  let filteredSchedules = schedules;
  if (context.allowedScheduleType) {
    // Map schedule output context to schedule type for filtering
    filteredSchedules = schedules.filter(s => {
      const scheduleOutputType = s.outputContext?.type;
      if (!scheduleOutputType || scheduleOutputType === 'none') {
        return context.allowedScheduleType === 'personal';
      }
      if (scheduleOutputType === 'slack') {
        const target = s.outputContext?.target || '';
        if (target.startsWith('#') || target.match(/^C[A-Z0-9]+$/)) {
          return context.allowedScheduleType === 'channel';
        }
        if (target.startsWith('@') || target.match(/^U[A-Z0-9]+$/)) {
          return context.allowedScheduleType === 'dm';
        }
      }
      return context.allowedScheduleType === 'personal';
    });
  }

  return {
    success: true,
    message: formatScheduleList(filteredSchedules),
    schedules: filteredSchedules,
  };
}

/**
 * Handle cancel action
 * Only the creator can cancel their own schedules
 */
async function handleCancel(
  args: ScheduleToolArgs,
  context: ScheduleToolContext,
  store: ScheduleStore
): Promise<ScheduleToolResult> {
  // Try to find by ID - only search in user's own schedules
  let schedule: Schedule | undefined;

  if (args.schedule_id) {
    // Only search in schedules created by this user
    const userSchedules = await store.getByCreatorAsync(context.userId);

    // Try exact match first
    schedule = userSchedules.find(s => s.id === args.schedule_id);

    // Try partial ID match (first 8 chars)
    if (!schedule) {
      schedule = userSchedules.find(s => s.id.startsWith(args.schedule_id!));
    }
  }

  if (!schedule) {
    return {
      success: false,
      message: 'Schedule not found',
      error: `Could not find schedule with ID "${args.schedule_id}" in your schedules. Use "list my schedules" to see your schedules.`,
    };
  }

  // Double-check ownership (defensive - already filtered above)
  if (schedule.creatorId !== context.userId) {
    logger.warn(
      `[ScheduleTool] Attempted cross-user schedule cancellation: ${context.userId} tried to cancel ${schedule.id} owned by ${schedule.creatorId}`
    );
    return {
      success: false,
      message: 'Not your schedule',
      error: 'You can only cancel your own schedules.',
    };
  }

  // Delete the schedule from DB
  await store.deleteAsync(schedule.id);

  // Also cancel the in-memory job (cron or timeout) so it doesn't fire
  const scheduler = getScheduler();
  if (scheduler) {
    scheduler.cancelSchedule(schedule.id);
  }

  logger.info(`[ScheduleTool] Cancelled schedule ${schedule.id} for user ${context.userId}`);

  return {
    success: true,
    message: `**Schedule cancelled!**

Was: "${schedule.workflow}" scheduled for ${schedule.originalExpression}`,
  };
}

/**
 * Handle pause/resume actions
 * Only the creator can pause/resume their own schedules
 */
async function handlePauseResume(
  args: ScheduleToolArgs,
  context: ScheduleToolContext,
  store: ScheduleStore,
  newStatus: 'active' | 'paused'
): Promise<ScheduleToolResult> {
  if (!args.schedule_id) {
    return {
      success: false,
      message: 'Missing schedule ID',
      error: 'Please specify which schedule to pause/resume.',
    };
  }

  // Only search in schedules created by this user
  const userSchedules = await store.getByCreatorAsync(context.userId);

  // Try exact match first
  let schedule = userSchedules.find(s => s.id === args.schedule_id);

  // Try partial ID match (first 8 chars)
  if (!schedule) {
    schedule = userSchedules.find(s => s.id.startsWith(args.schedule_id!));
  }

  if (!schedule) {
    return {
      success: false,
      message: 'Schedule not found',
      error: `Could not find schedule with ID "${args.schedule_id}" in your schedules.`,
    };
  }

  // Double-check ownership (defensive - already filtered above)
  if (schedule.creatorId !== context.userId) {
    logger.warn(
      `[ScheduleTool] Attempted cross-user schedule modification: ${context.userId} tried to modify ${schedule.id} owned by ${schedule.creatorId}`
    );
    return {
      success: false,
      message: 'Not your schedule',
      error: 'You can only modify your own schedules.',
    };
  }

  // Update status
  const updated = await store.updateAsync(schedule.id, { status: newStatus });

  const action = newStatus === 'paused' ? 'paused' : 'resumed';
  logger.info(`[ScheduleTool] ${action} schedule ${schedule.id} for user ${context.userId}`);

  return {
    success: true,
    message: `**Schedule ${action}!**

"${schedule.workflow}" - ${schedule.originalExpression}`,
    schedule: updated,
  };
}

// --- Message Trigger Handlers ---

/**
 * Format a message trigger for display
 */
function formatTrigger(trigger: MessageTrigger): string {
  const channels = trigger.channels?.length ? trigger.channels.join(', ') : 'all';
  const filters: string[] = [];
  if (trigger.contains?.length) filters.push(`contains: ${trigger.contains.join(', ')}`);
  if (trigger.matchPattern) filters.push(`match: /${trigger.matchPattern}/`);
  if (trigger.fromBots) filters.push('bots: yes');
  const filterStr = filters.length ? ` [${filters.join('; ')}]` : '';
  const status = trigger.enabled ? '' : ' (disabled)';
  return `\`${trigger.id.substring(0, 8)}\` - channels: ${channels} → workflow: "${trigger.workflow}"${filterStr}${status}`;
}

/**
 * Handle create_trigger action
 */
async function handleCreateTrigger(
  args: ScheduleToolArgs,
  context: ScheduleToolContext,
  store: ScheduleStore
): Promise<ScheduleToolResult> {
  // Default workflow to "default" if not specified
  const workflow = args.workflow || 'default';

  // Validate workflow exists if we have available workflows
  if (context.availableWorkflows && !context.availableWorkflows.includes(workflow)) {
    return {
      success: false,
      message: `Workflow "${workflow}" not found`,
      error: `Available workflows: ${context.availableWorkflows.slice(0, 5).join(', ')}${context.availableWorkflows.length > 5 ? '...' : ''}`,
    };
  }

  // Need at least one filter (channels, from, contains, or match)
  if (
    (!args.trigger_channels || args.trigger_channels.length === 0) &&
    (!args.trigger_from || args.trigger_from.length === 0) &&
    (!args.trigger_contains || args.trigger_contains.length === 0) &&
    !args.trigger_match
  ) {
    return {
      success: false,
      message: 'Missing trigger filters',
      error:
        'Please specify at least one filter: trigger_channels, trigger_from, trigger_contains, or trigger_match.',
    };
  }

  // Check permissions for the workflow
  const permissionCheck = checkSchedulePermissions(context, workflow);
  if (!permissionCheck.allowed) {
    return {
      success: false,
      message: 'Permission denied',
      error:
        permissionCheck.reason || 'You do not have permission to create triggers for this workflow',
    };
  }

  try {
    const trigger = await store.createTriggerAsync({
      creatorId: context.userId,
      creatorContext: context.contextType,
      creatorName: context.userName,
      description: args.trigger_description,
      channels: args.trigger_channels,
      fromUsers: args.trigger_from,
      fromBots: args.trigger_from_bots ?? false,
      contains: args.trigger_contains,
      matchPattern: args.trigger_match,
      threads: args.trigger_threads ?? 'any',
      workflow: workflow,
      inputs: args.workflow_inputs,
      status: 'active',
      enabled: true,
    });

    logger.info(
      `[ScheduleTool] Created message trigger ${trigger.id} for user ${context.userId}: workflow="${workflow}"`
    );

    return {
      success: true,
      message: `**Message trigger created!**

**Workflow**: ${trigger.workflow}
**Channels**: ${trigger.channels?.join(', ') || 'all'}
${trigger.fromUsers?.length ? `**From users**: ${trigger.fromUsers.join(', ')}\n` : ''}${trigger.contains?.length ? `**Contains**: ${trigger.contains.join(', ')}\n` : ''}${trigger.matchPattern ? `**Pattern**: /${trigger.matchPattern}/\n` : ''}${trigger.description ? `**Description**: ${trigger.description}\n` : ''}
ID: \`${trigger.id.substring(0, 8)}\``,
    };
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : 'Unknown error';
    logger.warn(`[ScheduleTool] Failed to create trigger: ${errorMsg}`);
    return {
      success: false,
      message: `Failed to create trigger: ${errorMsg}`,
      error: errorMsg,
    };
  }
}

/**
 * Handle list_triggers action
 */
async function handleListTriggers(
  context: ScheduleToolContext,
  store: ScheduleStore
): Promise<ScheduleToolResult> {
  const triggers = await store.getTriggersByCreatorAsync(context.userId);
  const active = triggers.filter(t => t.status !== 'deleted');

  if (active.length === 0) {
    return {
      success: true,
      message: `You don't have any message triggers.

To create one: "watch #channel for messages containing 'error' and run %my-workflow"`,
    };
  }

  const lines = active.map((t, i) => `${i + 1}. ${formatTrigger(t)}`);

  return {
    success: true,
    message: `**Your message triggers:**

${lines.join('\n')}

To delete: "delete trigger <id>"
To disable: "disable trigger <id>"`,
  };
}

/**
 * Handle delete_trigger action
 */
async function handleDeleteTrigger(
  args: ScheduleToolArgs,
  context: ScheduleToolContext,
  store: ScheduleStore
): Promise<ScheduleToolResult> {
  if (!args.trigger_id) {
    return {
      success: false,
      message: 'Missing trigger ID',
      error: 'Please specify which trigger to delete.',
    };
  }

  // Find trigger — check ownership
  const userTriggers = await store.getTriggersByCreatorAsync(context.userId);
  let trigger = userTriggers.find(t => t.id === args.trigger_id);
  if (!trigger) {
    trigger = userTriggers.find(t => t.id.startsWith(args.trigger_id!));
  }

  if (!trigger) {
    return {
      success: false,
      message: 'Trigger not found',
      error: `Could not find trigger with ID "${args.trigger_id}" in your triggers. Use "list my triggers" to see your triggers.`,
    };
  }

  await store.deleteTriggerAsync(trigger.id);

  logger.info(`[ScheduleTool] Deleted trigger ${trigger.id} for user ${context.userId}`);

  return {
    success: true,
    message: `**Trigger deleted!**

Was: watching for "${trigger.workflow}" ${trigger.channels?.length ? `in ${trigger.channels.join(', ')}` : ''}`,
  };
}

/**
 * Handle update_trigger action (enable/disable)
 */
async function handleUpdateTrigger(
  args: ScheduleToolArgs,
  context: ScheduleToolContext,
  store: ScheduleStore
): Promise<ScheduleToolResult> {
  if (!args.trigger_id) {
    return {
      success: false,
      message: 'Missing trigger ID',
      error: 'Please specify which trigger to update.',
    };
  }

  // Find trigger — check ownership
  const userTriggers = await store.getTriggersByCreatorAsync(context.userId);
  let trigger = userTriggers.find(t => t.id === args.trigger_id);
  if (!trigger) {
    trigger = userTriggers.find(t => t.id.startsWith(args.trigger_id!));
  }

  if (!trigger) {
    return {
      success: false,
      message: 'Trigger not found',
      error: `Could not find trigger with ID "${args.trigger_id}" in your triggers.`,
    };
  }

  const patch: Partial<MessageTrigger> = {};
  if (args.trigger_enabled !== undefined) {
    patch.enabled = args.trigger_enabled;
  }

  await store.updateTriggerAsync(trigger.id, patch);
  const action = args.trigger_enabled === false ? 'disabled' : 'enabled';

  logger.info(`[ScheduleTool] ${action} trigger ${trigger.id} for user ${context.userId}`);

  return {
    success: true,
    message: `**Trigger ${action}!**

"${trigger.workflow}" ${trigger.channels?.length ? `in ${trigger.channels.join(', ')}` : ''}`,
  };
}

/**
 * Get the schedule tool definition for registration with AI providers
 *
 * The AI is responsible for:
 * 1. Extracting the target (channel ID, user ID, thread_ts) from the conversation context
 * 2. Determining if the schedule is recurring or one-time
 * 3. Generating the cron expression OR ISO timestamp
 * 4. Extracting the reminder text or workflow name
 */
export function getScheduleToolDefinition(): CustomToolDefinition {
  return {
    name: 'schedule',
    description: `Schedule, list, and manage reminders or workflow executions.

YOU (the AI) must extract and structure all scheduling parameters. Do NOT pass natural language time expressions - convert them to cron or ISO timestamps.

CRITICAL WORKFLOW RULE (for 'create' action only):
- To schedule a WORKFLOW, the user MUST use a '%' prefix (e.g., "schedule %my-workflow daily").
- If the '%' prefix is present, extract the word following it as the 'workflow' parameter (without the '%').
- If the '%' prefix is NOT present, the request is a simple text reminder. The ENTIRE user request (excluding the schedule expression) MUST be placed in the 'reminder_text' parameter.
- DO NOT guess or infer a workflow name from a user's request without the '%' prefix.

WORKFLOW RULE FOR TRIGGERS (create_trigger action):
- Triggers ALWAYS require a workflow. The '%' prefix rule does NOT apply to triggers.
- If the user specifies a workflow name (with or without '%'), use it directly.
- If the user does NOT specify a workflow name, use "default" as the workflow name.

ACTIONS:
- create: Schedule a new reminder or workflow
- list: Show user's active schedules
- cancel: Remove a schedule by ID
- pause/resume: Temporarily disable/enable a schedule

MESSAGE-BASED TRIGGERS:
In addition to time-based schedules, this tool can create/manage message-based triggers that react to
Slack messages in specific channels. Use the create_trigger, list_triggers, delete_trigger, and update_trigger
actions for this. Message triggers fire workflows based on message content, channel, sender, and thread scope.

TRIGGER ACTIONS:
- create_trigger: Create a new message trigger (requires at least one filter; workflow defaults to "default" if not specified). Supports filtering by user IDs (trigger_from), channels, keywords, regex, and thread scope.
- list_triggers: Show user's message triggers
- delete_trigger: Remove a trigger by ID
- update_trigger: Enable/disable a trigger by ID

FOR CREATE ACTION - Extract these from user's request:
1. WHAT:
   - If user says "schedule %some-workflow ...", populate 'workflow' with "some-workflow".
   - Otherwise, populate 'reminder_text' with the user's full request text.
2. WHERE: Use the CURRENT channel from context
   - target_id: The channel ID from context (C... for channels, D... for DMs)
   - target_type: "channel" for public/private channels, "dm" for direct messages
   - ONLY use target_type="thread" with thread_ts if user is INSIDE a thread
   - When NOT in a thread, reminders post as NEW messages (not thread replies)
3. WHEN: Either cron (for recurring) OR run_at (ISO 8601 for one-time)
   - Recurring: Generate cron expression (minute hour day-of-month month day-of-week)
   - One-time: Generate ISO 8601 timestamp

CRON EXAMPLES:
- "every minute" → cron: "* * * * *"
- "every hour" → cron: "0 * * * *"
- "every day at 9am" → cron: "0 9 * * *"
- "every Monday at 9am" → cron: "0 9 * * 1"
- "weekdays at 8:30am" → cron: "30 8 * * 1-5"
- "every 5 minutes" → cron: "*/5 * * * *"

ONE-TIME EXAMPLES:
- "in 2 hours" → run_at: "<ISO timestamp 2 hours from now>"
- "tomorrow at 3pm" → run_at: "2026-02-08T15:00:00Z"

USAGE EXAMPLES:

User in DM: "remind me to check builds every day at 9am"
→ {
    "action": "create",
    "reminder_text": "check builds",
    "is_recurring": true,
    "cron": "0 9 * * *",
    "target_type": "dm",
    "target_id": "<DM channel ID from context, e.g., D09SZABNLG3>",
    "original_expression": "every day at 9am"
  }

User in #security channel: "schedule %security-scan every Monday at 10am"
→ {
    "action": "create",
    "workflow": "security-scan",
    "is_recurring": true,
    "cron": "0 10 * * 1",
    "target_type": "channel",
    "target_id": "<channel ID from context, e.g., C05ABC123>",
    "original_expression": "every Monday at 10am"
  }

User in #security channel: "run security-scan every Monday at 10am" (NO % prefix!)
→ {
    "action": "create",
    "reminder_text": "run security-scan every Monday at 10am",
    "is_recurring": true,
    "cron": "0 10 * * 1",
    "target_type": "channel",
    "target_id": "<channel ID from context, e.g., C05ABC123>",
    "original_expression": "every Monday at 10am"
  }

User in DM: "remind me in 2 hours to review the PR"
→ {
    "action": "create",
    "reminder_text": "review the PR",
    "is_recurring": false,
    "run_at": "2026-02-07T18:00:00Z",
    "target_type": "dm",
    "target_id": "<DM channel ID from context>",
    "original_expression": "in 2 hours"
  }

User inside a thread: "remind me about this tomorrow"
→ {
    "action": "create",
    "reminder_text": "Check this thread",
    "is_recurring": false,
    "run_at": "2026-02-08T09:00:00Z",
    "target_type": "thread",
    "target_id": "<channel ID>",
    "thread_ts": "<thread_ts from context>",
    "original_expression": "tomorrow"
  }

User: "list my schedules"
→ { "action": "list" }

User: "cancel schedule abc123"
→ { "action": "cancel", "schedule_id": "abc123" }

User: "watch #cicd for messages containing 'failed' and run %handle-cicd"
→ { "action": "create_trigger", "trigger_channels": ["C0CICD"], "trigger_contains": ["failed"], "workflow": "handle-cicd" }

User: "trigger on each of my messages in this channel and run %auto-reply" (user ID is U3P2L4XNE)
→ { "action": "create_trigger", "trigger_channels": ["C09V810NY6R"], "trigger_from": ["U3P2L4XNE"], "workflow": "auto-reply" }

User: "trigger on each message in this channel" (no workflow specified — use "default")
→ { "action": "create_trigger", "trigger_channels": ["C09V810NY6R"], "workflow": "default" }

User: "list my message triggers"
→ { "action": "list_triggers" }

User: "delete trigger abc123"
→ { "action": "delete_trigger", "trigger_id": "abc123" }

User: "disable trigger abc123"
→ { "action": "update_trigger", "trigger_id": "abc123", "trigger_enabled": false }`,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'create',
            'list',
            'cancel',
            'pause',
            'resume',
            'create_trigger',
            'list_triggers',
            'delete_trigger',
            'update_trigger',
          ],
          description:
            'What to do: create/list/cancel/pause/resume for time-based schedules; create_trigger/list_triggers/delete_trigger/update_trigger for message-based triggers',
        },
        // WHAT to do
        reminder_text: {
          type: 'string',
          description: 'For create: the message/reminder text to send when triggered',
        },
        workflow: {
          type: 'string',
          description:
            'For create: workflow ID to run. ONLY populate this if the user used the % prefix (e.g., "%my-workflow"). Extract the name without the % symbol. If no % prefix, use reminder_text instead. For create_trigger: workflow is REQUIRED — use the workflow name the user specified (% prefix optional), or "default" if not specified.',
        },
        workflow_inputs: {
          type: 'object',
          description: 'For create: optional inputs to pass to the workflow',
        },
        // WHERE to send
        target_type: {
          type: 'string',
          enum: ['channel', 'dm', 'thread', 'user'],
          description:
            'For create: where to send output. channel=public/private channel, dm=DM to self (current DM channel), user=DM to specific user, thread=reply in current thread',
        },
        target_id: {
          type: 'string',
          description:
            'For create: Slack channel ID. Channels start with C, DMs start with D. Always use the channel ID from the current context.',
        },
        thread_ts: {
          type: 'string',
          description:
            'For create with target_type=thread: the thread timestamp to reply to. Get this from the current thread context.',
        },
        // WHEN to run
        is_recurring: {
          type: 'boolean',
          description:
            'For create: true for recurring schedules (cron), false for one-time (run_at)',
        },
        cron: {
          type: 'string',
          description:
            'For create recurring: cron expression (minute hour day-of-month month day-of-week). Examples: "0 9 * * *" (daily 9am), "* * * * *" (every minute), "0 9 * * 1" (Mondays 9am)',
        },
        run_at: {
          type: 'string',
          description:
            'For create one-time: ISO 8601 timestamp when to run (e.g., "2026-02-07T15:00:00Z")',
        },
        original_expression: {
          type: 'string',
          description:
            'For create: the original natural language expression from user (for display only)',
        },
        // For cancel/pause/resume
        schedule_id: {
          type: 'string',
          description:
            'For cancel/pause/resume: the schedule ID to act on (first 8 chars is enough)',
        },
        // For message trigger actions
        trigger_channels: {
          type: 'array',
          items: { type: 'string' },
          description:
            'For create_trigger: Slack channel IDs to monitor (e.g., ["C0CICD"]). Supports wildcard suffix (e.g., "CENG*").',
        },
        trigger_from: {
          type: 'array',
          items: { type: 'string' },
          description:
            'For create_trigger: Slack user IDs to filter by. Only messages from these users will trigger the workflow. E.g., ["U3P2L4XNE"]. If omitted, messages from any user will trigger.',
        },
        trigger_from_bots: {
          type: 'boolean',
          description: 'For create_trigger: allow bot messages to trigger (default: false)',
        },
        trigger_contains: {
          type: 'array',
          items: { type: 'string' },
          description:
            'For create_trigger: keywords to match (case-insensitive OR). E.g., ["failed", "error"].',
        },
        trigger_match: {
          type: 'string',
          description: 'For create_trigger: regex pattern to match against message text.',
        },
        trigger_threads: {
          type: 'string',
          enum: ['root_only', 'thread_only', 'any'],
          description: 'For create_trigger: thread scope filter (default: "any").',
        },
        trigger_description: {
          type: 'string',
          description: 'For create_trigger: human-readable description of the trigger.',
        },
        trigger_id: {
          type: 'string',
          description:
            'For delete_trigger/update_trigger: the trigger ID to act on (first 8 chars is enough).',
        },
        trigger_enabled: {
          type: 'boolean',
          description: 'For update_trigger: set to false to disable, true to enable.',
        },
      },
      required: ['action'],
    },
    exec: '', // Not used - this tool has a custom handler
  };
}

/**
 * Check if this is the schedule tool and should be handled specially
 */
export function isScheduleTool(toolName: string): boolean {
  return toolName === 'schedule';
}

/**
 * Determine schedule type from context
 */
function determineScheduleType(
  contextType: string,
  outputType?: 'slack' | 'github' | 'webhook' | 'none',
  outputTarget?: string
): ScheduleType {
  // If output is to a Slack channel (starts with # or C), it's a channel schedule
  if (outputType === 'slack' && outputTarget) {
    if (outputTarget.startsWith('#') || outputTarget.match(/^C[A-Z0-9]+$/)) {
      return 'channel';
    }
    // If output is to a Slack user (starts with @ or U), it's a DM schedule
    if (outputTarget.startsWith('@') || outputTarget.match(/^U[A-Z0-9]+$/)) {
      return 'dm';
    }
  }

  // CLI and GitHub are personal schedules
  if (contextType === 'cli' || contextType.startsWith('github:')) {
    return 'personal';
  }

  // Default to personal for Slack DM context
  return 'personal';
}

/**
 * Map Slack channel type to allowed schedule type
 */
function slackChannelTypeToScheduleType(channelType: 'channel' | 'dm' | 'group'): ScheduleType {
  switch (channelType) {
    case 'channel':
      return 'channel';
    case 'group':
      return 'dm'; // Group DMs map to 'dm' schedule type
    case 'dm':
    default:
      return 'personal';
  }
}

/**
 * Build schedule tool context from various sources
 */
export function buildScheduleToolContext(
  sources: {
    slackContext?: {
      userId: string;
      userName?: string;
      timezone?: string;
      channelType?: 'channel' | 'dm' | 'group';
    };
    cliContext?: { userId?: string };
    githubContext?: { login: string };
  },
  availableWorkflows?: string[],
  permissions?: SchedulePermissions,
  outputInfo?: { outputType?: 'slack' | 'github' | 'webhook' | 'none'; outputTarget?: string }
): ScheduleToolContext {
  // Prefer Slack context, then GitHub, then CLI
  if (sources.slackContext) {
    const contextType = `slack:${sources.slackContext.userId}`;
    const scheduleType = determineScheduleType(
      contextType,
      outputInfo?.outputType,
      outputInfo?.outputTarget
    );

    // Determine allowed schedule type based on originating Slack context
    // This enforces that from a DM you can only create personal schedules, etc.
    let allowedScheduleType: ScheduleType | undefined;
    if (sources.slackContext.channelType) {
      allowedScheduleType = slackChannelTypeToScheduleType(sources.slackContext.channelType);
    }

    // Override schedule type based on Slack channel type if no explicit output
    let finalScheduleType = scheduleType;
    if (!outputInfo?.outputType && sources.slackContext.channelType) {
      finalScheduleType = slackChannelTypeToScheduleType(sources.slackContext.channelType);
    }

    return {
      userId: sources.slackContext.userId,
      userName: sources.slackContext.userName,
      contextType,
      timezone: sources.slackContext.timezone,
      availableWorkflows,
      scheduleType: finalScheduleType,
      permissions,
      allowedScheduleType,
    };
  }

  if (sources.githubContext) {
    return {
      userId: sources.githubContext.login,
      contextType: `github:${sources.githubContext.login}`,
      timezone: 'UTC', // GitHub doesn't provide timezone
      availableWorkflows,
      scheduleType: 'personal',
      permissions,
      allowedScheduleType: 'personal', // GitHub context only allows personal schedules
    };
  }

  // CLI/default context
  return {
    userId: sources.cliContext?.userId || process.env.USER || 'cli-user',
    contextType: 'cli',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
    availableWorkflows,
    scheduleType: 'personal',
    permissions,
    allowedScheduleType: 'personal', // CLI context only allows personal schedules
  };
}
