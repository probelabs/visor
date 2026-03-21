/**
 * Built-in AI tool for inspecting task progress via execution traces.
 *
 * When enabled (via skill or config), the AI can call this tool to:
 * - List active/recent tasks in the current thread
 * - Read the execution trace of a specific task to see what steps were taken
 *
 * This allows the AI to answer "what's your progress?" or "how is it going?"
 * by inspecting the live trace of running tasks.
 */

import type { CustomToolDefinition } from '../types/config';
import { logger } from '../logger';

// ---------------------------------------------------------------------------
// Tool definition
// ---------------------------------------------------------------------------

export function getTaskProgressToolDefinition(): CustomToolDefinition {
  return {
    name: 'task_progress',
    description: `Inspect the progress of tasks you are currently working on or have recently completed.

Use this tool when:
- A user asks about progress, status, or what you've been doing
- You need to check if a similar task is already running
- You want to see the execution trace (steps taken, tools called, AI decisions) of a task

ACTIONS:
- list: Show active and recent tasks in the current context (thread/channel)
- trace: Get the detailed execution trace of a specific task — shows every step, tool call, and AI decision made so far

The trace output is a structured tree showing the full execution flow including:
- Workflow steps and their durations
- AI model calls with token counts
- Tool invocations with inputs and results
- Search queries and their results
- Errors and retries`,
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'trace'],
          description:
            'Action to perform: "list" to see tasks, "trace" to see execution details of a specific task',
        },
        task_id: {
          type: 'string',
          description:
            'Task ID to inspect (required for "trace" action). Use "list" first to find task IDs.',
        },
      },
      required: ['action'],
    },
  };
}

// ---------------------------------------------------------------------------
// Detection helper
// ---------------------------------------------------------------------------

export function isTaskProgressTool(toolName: string): boolean {
  return toolName === 'task_progress';
}

// ---------------------------------------------------------------------------
// Context for executing the tool
// ---------------------------------------------------------------------------

export interface TaskProgressContext {
  /** Slack channel ID (for filtering tasks to current context) */
  channelId?: string;
  /** Slack thread timestamp (for filtering to current thread) */
  threadTs?: string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export interface TaskProgressResult {
  success: boolean;
  message?: string;
  error?: string;
}

export async function handleTaskProgressAction(
  args: { action: 'list' | 'trace'; task_id?: string },
  context: TaskProgressContext,
  taskStore: any
): Promise<TaskProgressResult> {
  try {
    switch (args.action) {
      case 'list':
        return await handleList(context, taskStore);
      case 'trace':
        if (!args.task_id) {
          return { success: false, error: 'task_id is required for the "trace" action' };
        }
        return await handleTrace(args.task_id, taskStore);
      default:
        return { success: false, error: `Unknown action: ${args.action}` };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error(`[TaskProgressTool] Error: ${msg}`);
    return { success: false, error: msg };
  }
}

// ---------------------------------------------------------------------------
// List active/recent tasks
// ---------------------------------------------------------------------------

async function handleList(
  context: TaskProgressContext,
  taskStore: any
): Promise<TaskProgressResult> {
  // Build metadata filter for current thread/channel
  const metadata: Record<string, string> = {};
  if (context.channelId) metadata.slack_channel = context.channelId;
  if (context.threadTs) metadata.slack_thread_ts = context.threadTs;

  // Get active tasks (submitted + working)
  const activeResult = taskStore.listTasksRaw?.({
    state: ['submitted', 'working'],
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    limit: 20,
  }) || { rows: [] };

  // Get recent completed tasks (last 10)
  const recentResult = taskStore.listTasksRaw?.({
    state: ['completed', 'failed'],
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    limit: 10,
  }) || { rows: [] };

  const lines: string[] = [];

  if (activeResult.rows?.length > 0) {
    lines.push('## Active Tasks');
    for (const row of activeResult.rows) {
      const trigger = row.metadata?.slack_trigger_text || (row.request_message || '').slice(0, 200);
      const elapsed = timeSince(row.created_at);
      lines.push(`- **${row.id}** [${row.state}] (${elapsed} ago)`);
      lines.push(`  Workflow: ${row.workflow_id || 'unknown'}`);
      lines.push(`  Trigger: ${trigger}`);
    }
  } else {
    lines.push('No active tasks in this context.');
  }

  if (recentResult.rows?.length > 0) {
    lines.push('');
    lines.push('## Recent Completed Tasks');
    for (const row of recentResult.rows) {
      const trigger = row.metadata?.slack_trigger_text || (row.request_message || '').slice(0, 200);
      const elapsed = timeSince(row.created_at);
      lines.push(`- **${row.id}** [${row.state}] (${elapsed} ago)`);
      lines.push(`  Workflow: ${row.workflow_id || 'unknown'}`);
      lines.push(`  Trigger: ${trigger}`);
    }
  }

  return { success: true, message: lines.join('\n') };
}

// ---------------------------------------------------------------------------
// Show trace for a specific task
// ---------------------------------------------------------------------------

async function handleTrace(taskId: string, taskStore: any): Promise<TaskProgressResult> {
  // Look up the task
  const task = taskStore.getTask?.(taskId);
  if (!task) {
    return { success: false, error: `Task not found: ${taskId}` };
  }

  const traceId = task.metadata?.trace_id;
  const traceFile = task.metadata?.trace_file;

  if (!traceId && !traceFile) {
    // No trace available — return basic status info
    const trigger = task.metadata?.slack_trigger_text || '';
    return {
      success: true,
      message: [
        `## Task ${taskId}`,
        `State: ${task.state}`,
        `Created: ${task.created_at}`,
        `Workflow: ${task.workflow_id || 'unknown'}`,
        trigger ? `Trigger: ${trigger}` : '',
        '',
        '(No execution trace available for this task)',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  }

  // Lazy-import the trace serializer to avoid circular dependencies
  const { serializeTraceForPrompt, readTraceIdFromFile } = await import('./trace-serializer');

  // Get trace ID from file if needed
  let resolvedTraceId = traceId;
  if (!resolvedTraceId && traceFile) {
    resolvedTraceId = await readTraceIdFromFile(traceFile);
  }

  // Get the task response for full output context
  const taskResponse = task.status?.message?.parts?.[0]?.text;

  // Serialize the trace — use generous char limit for AI consumption
  const traceTree = await serializeTraceForPrompt(
    traceFile || resolvedTraceId || '',
    8000, // generous limit so AI gets good context
    undefined,
    taskResponse,
    resolvedTraceId || undefined
  );

  const trigger = task.metadata?.slack_trigger_text || '';
  const elapsed = timeSince(task.created_at);

  const lines = [
    `## Task ${taskId}`,
    `State: ${task.state}`,
    `Started: ${elapsed} ago`,
    `Workflow: ${task.workflow_id || 'unknown'}`,
    trigger ? `Trigger: ${trigger}` : '',
    '',
    '## Execution Trace',
    traceTree,
  ];

  return { success: true, message: lines.filter(Boolean).join('\n') };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timeSince(isoDate: string): string {
  const ms = Date.now() - new Date(isoDate).getTime();
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h`;
  return `${Math.round(ms / 86_400_000)}d`;
}
