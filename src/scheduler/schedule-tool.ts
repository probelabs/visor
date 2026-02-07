/**
 * Generic AI Tool for scheduling and managing workflow executions
 * This tool is frontend-agnostic and can work with any context (Slack, CLI, GitHub, etc.)
 */
import { CustomToolDefinition } from '../types/config';
import { ScheduleStore, Schedule, ScheduleOutputContext } from './schedule-store';
import { parseScheduleExpression, getNextRunTime } from './schedule-parser';
import { logger } from '../logger';

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
export type ScheduleAction = 'create' | 'list' | 'cancel' | 'pause' | 'resume';

/**
 * Tool input arguments
 */
export interface ScheduleToolArgs {
  action: ScheduleAction;
  workflow?: string; // For create: workflow/check ID to run
  expression?: string; // For create: natural language time (e.g., "every Monday at 9am")
  inputs?: Record<string, unknown>; // For create: workflow inputs
  output_type?: 'slack' | 'github' | 'webhook' | 'none'; // For create: output destination
  output_target?: string; // For create: target channel/repo/URL
  schedule_id?: string; // For cancel/pause/resume: the schedule ID to act on
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
  const workflow =
    schedule.workflow.length > 30 ? schedule.workflow.substring(0, 27) + '...' : schedule.workflow;
  const output = schedule.outputContext?.type || 'none';

  return `\`${schedule.id.substring(0, 8)}\` - "${workflow}" - ${time} (→ ${output})${status}`;
}

/**
 * Format confirmation message for a new schedule
 */
function formatCreateConfirmation(schedule: Schedule): string {
  const outputDesc = schedule.outputContext?.type
    ? `${schedule.outputContext.type}${schedule.outputContext.target ? `:${schedule.outputContext.target}` : ''}`
    : 'none';

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

**Workflow**: ${schedule.workflow}
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

**Workflow**: ${schedule.workflow}
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

To create one: "schedule daily-report every Monday at 9am"`;
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

    default:
      return {
        success: false,
        message: `Unknown action: ${args.action}`,
        error: `Supported actions: create, list, cancel, pause, resume`,
      };
  }
}

/**
 * Handle create action
 */
async function handleCreate(
  args: ScheduleToolArgs,
  context: ScheduleToolContext,
  store: ScheduleStore
): Promise<ScheduleToolResult> {
  // Validate required fields
  if (!args.expression) {
    return {
      success: false,
      message: 'Missing schedule expression',
      error:
        'Please specify when the schedule should run (e.g., "in 2 hours", "every Monday at 9am")',
    };
  }

  if (!args.workflow) {
    return {
      success: false,
      message: 'Missing workflow',
      error: 'Please specify which workflow to run',
    };
  }

  // Determine requested schedule type based on output target
  const requestedScheduleType = determineScheduleType(
    context.contextType,
    args.output_type,
    args.output_target
  );

  // Check permissions for dynamic schedule creation
  const permissionCheck = checkSchedulePermissions(context, args.workflow, requestedScheduleType);
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

  // Validate workflow exists if we have available workflows
  if (context.availableWorkflows && !context.availableWorkflows.includes(args.workflow)) {
    return {
      success: false,
      message: `Workflow "${args.workflow}" not found`,
      error: `Available workflows: ${context.availableWorkflows.slice(0, 5).join(', ')}${context.availableWorkflows.length > 5 ? '...' : ''}`,
    };
  }

  try {
    // Parse the schedule expression
    const timezone = context.timezone || 'UTC';
    const parsed = parseScheduleExpression(args.expression, timezone);

    // Build output context
    let outputContext: ScheduleOutputContext | undefined;
    if (args.output_type && args.output_type !== 'none') {
      outputContext = {
        type: args.output_type,
        target: args.output_target,
      };
    }

    // Create the schedule
    const schedule = store.create({
      creatorId: context.userId,
      creatorContext: context.contextType,
      creatorName: context.userName,
      timezone,
      schedule: parsed.cronExpression || '',
      runAt: parsed.type === 'one-time' ? parsed.runAt?.getTime() : undefined,
      isRecurring: parsed.type === 'recurring',
      originalExpression: args.expression,
      workflow: args.workflow,
      workflowInputs: args.inputs,
      outputContext,
      nextRunAt:
        parsed.type === 'recurring' && parsed.cronExpression
          ? getNextRunTime(parsed.cronExpression, timezone).getTime()
          : parsed.runAt?.getTime(),
    });

    logger.info(
      `[ScheduleTool] Created schedule ${schedule.id} for user ${context.userId}: workflow="${args.workflow}"`
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
  const schedules = store.getByCreator(context.userId).filter(s => s.status !== 'completed');

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
    const userSchedules = store.getByCreator(context.userId);

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

  // Delete the schedule
  store.delete(schedule.id);

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
  const userSchedules = store.getByCreator(context.userId);

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
  const updated = store.update(schedule.id, { status: newStatus });

  const action = newStatus === 'paused' ? 'paused' : 'resumed';
  logger.info(`[ScheduleTool] ${action} schedule ${schedule.id} for user ${context.userId}`);

  return {
    success: true,
    message: `**Schedule ${action}!**

"${schedule.workflow}" - ${schedule.originalExpression}`,
    schedule: updated,
  };
}

/**
 * Get the schedule tool definition for registration with AI providers
 */
export function getScheduleToolDefinition(): CustomToolDefinition {
  return {
    name: 'schedule',
    description: `Schedule, list, and manage workflow executions at specified times.

ACTIONS:
- create: Schedule a new workflow execution
- list: Show user's active schedules
- cancel: Remove a schedule by ID
- pause/resume: Temporarily disable/enable a schedule

EXAMPLES:
User: "run daily-report every Monday at 9am"
→ action: create, workflow: daily-report, expression: "every Monday at 9am"

User: "schedule security-scan in 2 hours and post to #security"
→ action: create, workflow: security-scan, expression: "in 2 hours", output_type: slack, output_target: #security

User: "list my schedules" or "what schedules do I have?"
→ action: list

User: "cancel schedule abc123"
→ action: cancel, schedule_id: abc123

User: "pause schedule def456"
→ action: pause, schedule_id: def456`,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['create', 'list', 'cancel', 'pause', 'resume'],
          description: 'What to do: create new, list existing, cancel/pause/resume by ID',
        },
        workflow: {
          type: 'string',
          description: 'For create: workflow/check ID to run',
        },
        expression: {
          type: 'string',
          description:
            'For create: natural language time expression (e.g., "in 2 hours", "every Monday at 9am", "tomorrow at 3pm")',
        },
        inputs: {
          type: 'object',
          description: 'For create: optional inputs to pass to the workflow',
        },
        output_type: {
          type: 'string',
          enum: ['slack', 'github', 'webhook', 'none'],
          description: 'For create: where to send results (default: none)',
        },
        output_target: {
          type: 'string',
          description: 'For create: target channel, repo, or URL for output',
        },
        schedule_id: {
          type: 'string',
          description:
            'For cancel/pause/resume: the schedule ID to act on (first 8 chars is enough)',
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
