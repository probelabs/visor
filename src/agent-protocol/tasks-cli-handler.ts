/**
 * CLI command handlers for A2A task monitoring
 *
 * Commands:
 *   visor tasks                            - List all tasks (alias for list)
 *   visor tasks list [--state X] [--agent] - List tasks with filters
 *   visor tasks stats                      - Queue summary stats
 *   visor tasks cancel <task-id>           - Cancel a task
 *   visor tasks help                       - Show usage
 */
import CliTable3 from 'cli-table3';
import { configureLoggerFromCli } from '../logger';
import { getInstanceId } from '../utils/instance-id';
import { SqliteTaskStore, type ListTasksFilter, type TaskQueueRow } from './task-store';
import type { TaskState } from './types';
import { isValidTaskState, isTerminalState } from './state-transitions';

// ---------------------------------------------------------------------------
// Arg parser (same pattern as config/cli-handler.ts)
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]): {
  subcommand: string;
  positional: string[];
  flags: Record<string, string | boolean>;
} {
  const subcommand = argv[0] || 'list';
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

// ---------------------------------------------------------------------------
// DB wrapper
// ---------------------------------------------------------------------------

async function withTaskStore<T>(fn: (store: SqliteTaskStore) => Promise<T>): Promise<T> {
  const store = new SqliteTaskStore();
  await store.initialize();
  try {
    return await fn(store);
  } finally {
    await store.shutdown();
  }
}

// ---------------------------------------------------------------------------
// Duration formatting
// ---------------------------------------------------------------------------

function formatDuration(startISO: string, endISO?: string): string {
  const start = new Date(startISO).getTime();
  const end = endISO ? new Date(endISO).getTime() : Date.now();
  const ms = Math.max(0, end - start);

  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) return `${mins}m ${remSecs}s`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hours < 24) return `${hours}h ${remMins}m`;
  const days = Math.floor(hours / 24);
  const remHours = hours % 24;
  return `${days}d ${remHours}h`;
}

function formatTimeAgo(isoDate: string): string {
  const ms = Math.max(0, Date.now() - new Date(isoDate).getTime());
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

// ---------------------------------------------------------------------------
// Filter builder
// ---------------------------------------------------------------------------

function buildFilter(flags: Record<string, string | boolean>): ListTasksFilter {
  const filter: ListTasksFilter = {};
  if (typeof flags.state === 'string' && isValidTaskState(flags.state)) {
    filter.state = [flags.state as TaskState];
  } else if (!flags.all) {
    // Default: show only active tasks (not completed history)
    filter.state = ['submitted', 'working', 'input_required', 'auth_required'];
  }
  if (typeof flags.agent === 'string') {
    filter.workflowId = flags.agent;
  }
  if (typeof flags.search === 'string') {
    filter.search = flags.search;
  }
  if (typeof flags.instance === 'string') {
    filter.claimedBy = flags.instance;
  }
  if (typeof flags.limit === 'string') {
    const n = parseInt(flags.limit, 10);
    if (!isNaN(n) && n > 0) filter.limit = n;
  }
  filter.limit = filter.limit ?? 20;
  if (typeof flags.page === 'string') {
    const p = parseInt(flags.page, 10);
    if (!isNaN(p) && p > 0) filter.offset = (p - 1) * (filter.limit ?? 20);
  }
  return filter;
}

// ---------------------------------------------------------------------------
// Table formatting
// ---------------------------------------------------------------------------

function formatMeta(meta: Record<string, unknown>): string {
  const parts: string[] = [];
  if (meta.slack_user) parts.push(`user:${meta.slack_user}`);
  if (meta.slack_channel) parts.push(`ch:${meta.slack_channel}`);
  if (meta.trace_id) parts.push(`trace:${String(meta.trace_id).slice(0, 8)}`);
  if (meta.schedule_id) parts.push(`sched:${meta.schedule_id}`);
  return parts.join(' ') || '-';
}

function stateColor(state: string): string {
  switch (state) {
    case 'working':
      return '\x1b[33m' + state + '\x1b[0m'; // yellow
    case 'completed':
      return '\x1b[32m' + state + '\x1b[0m'; // green
    case 'failed':
      return '\x1b[31m' + state + '\x1b[0m'; // red
    case 'canceled':
    case 'rejected':
      return '\x1b[90m' + state + '\x1b[0m'; // grey
    case 'submitted':
      return '\x1b[36m' + state + '\x1b[0m'; // cyan
    case 'input_required':
    case 'auth_required':
      return '\x1b[35m' + state + '\x1b[0m'; // magenta
    default:
      return state;
  }
}

function formatTable(rows: TaskQueueRow[], total: number, filter?: ListTasksFilter): string {
  if (rows.length === 0) return 'No tasks found.';

  // Adapt Input column truncation to terminal width
  // Fixed columns take ~100 chars; rest goes to Input
  const termWidth = process.stdout.columns || 120;
  const fixedColsWidth = 105; // ID+Source+State+Workflow+Created+Duration+Instance+Meta + borders
  const inputMaxLen = Math.max(20, Math.min(80, termWidth - fixedColsWidth));

  const table = new CliTable3({
    head: ['ID', 'Source', 'State', 'Workflow', 'Created', 'Duration', 'Instance', 'Meta', 'Input'],
    style: {
      head: ['cyan', 'bold'],
      border: ['grey'],
    },
    wordWrap: false,
  });

  for (const r of rows) {
    const duration = isTerminalState(r.state as TaskState)
      ? formatDuration(r.created_at, r.updated_at)
      : formatDuration(r.claimed_at || r.created_at);

    const input =
      r.request_message.length > inputMaxLen
        ? r.request_message.slice(0, inputMaxLen - 3) + '...'
        : r.request_message || '-';

    table.push([
      r.id.slice(0, 8),
      r.source || '-',
      stateColor(r.state),
      r.workflow_id || '-',
      formatTimeAgo(r.created_at),
      duration,
      r.claimed_by || '-',
      formatMeta(r.metadata),
      input,
    ]);
  }

  let output = table.toString();
  // Pagination info
  const limit = filter?.limit ?? 20;
  const offset = filter?.offset ?? 0;
  const page = Math.floor(offset / limit) + 1;
  const totalPages = Math.ceil(total / limit);
  if (total > rows.length) {
    output += `\n(${total} total, page ${page}/${totalPages}, --page N to navigate)`;
  }
  return output;
}

function formatMarkdown(rows: TaskQueueRow[], total: number): string {
  if (rows.length === 0) return 'No tasks found.';

  const header = [
    'ID',
    'Source',
    'State',
    'Workflow',
    'Created',
    'Duration',
    'Instance',
    'Meta',
    'Input',
  ];
  const data = rows.map(r => {
    const duration = isTerminalState(r.state as TaskState)
      ? formatDuration(r.created_at, r.updated_at)
      : formatDuration(r.claimed_at || r.created_at);

    const instance = r.claimed_by || '-';
    const workflow = r.workflow_id || '-';
    const source = r.source || '-';
    const meta = formatMeta(r.metadata);
    const input =
      r.request_message.length > 60
        ? r.request_message.slice(0, 57) + '...'
        : r.request_message || '-';

    return [
      r.id.slice(0, 8),
      source,
      r.state,
      workflow,
      formatTimeAgo(r.created_at),
      duration,
      instance,
      meta,
      input,
    ];
  });

  const lines = [
    '| ' + header.join(' | ') + ' |',
    '| ' + header.map(() => '---').join(' | ') + ' |',
    ...data.map(row => '| ' + row.join(' | ') + ' |'),
  ];
  if (total > rows.length) lines.push(`\n(${total} total, showing ${rows.length})`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Subcommand: list
// ---------------------------------------------------------------------------

async function handleList(flags: Record<string, string | boolean>): Promise<void> {
  const filter = buildFilter(flags);
  const output = typeof flags.output === 'string' ? flags.output : 'table';

  const instanceId = getInstanceId();

  const render = async () => {
    await withTaskStore(async store => {
      const { rows, total } = store.listTasksRaw(filter);

      const activeOnly = !flags.all && !flags.state;
      if (output === 'json') {
        console.log(
          JSON.stringify(
            { instance_id: instanceId, active_only: activeOnly, tasks: rows, total },
            null,
            2
          )
        );
      } else if (output === 'markdown') {
        console.log(
          `Instance: ${instanceId}${activeOnly ? ' (active tasks only, use --all for history)' : ''}\n`
        );
        console.log(formatMarkdown(rows, total));
      } else {
        console.log(
          `Instance: ${instanceId}${activeOnly ? ' (active tasks only, use --all for history)' : ''}\n`
        );
        console.log(formatTable(rows, total, filter));
      }
    });
  };

  if (flags.watch) {
    const watchRender = async () => {
      process.stdout.write('\x1Bc'); // clear terminal
      console.log(`visor tasks list (instance: ${instanceId}, watching, Ctrl+C to exit)\n`);
      try {
        await render();
      } catch (err) {
        console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    await watchRender();
    const interval = setInterval(() => watchRender(), 2000);
    await new Promise<void>(resolve => {
      process.on('SIGINT', () => {
        clearInterval(interval);
        resolve();
      });
    });
  } else {
    await render();
  }
}

// ---------------------------------------------------------------------------
// Subcommand: stats
// ---------------------------------------------------------------------------

async function handleStats(flags: Record<string, string | boolean>): Promise<void> {
  const output = typeof flags.output === 'string' ? flags.output : 'table';

  await withTaskStore(async store => {
    const allStates: TaskState[] = [
      'submitted',
      'working',
      'input_required',
      'auth_required',
      'completed',
      'failed',
      'canceled',
      'rejected',
    ];

    const stateCounts: Record<string, number> = {};
    for (const state of allStates) {
      const { total } = store.listTasksRaw({ state: [state], limit: 0 });
      stateCounts[state] = total;
    }

    // Per-agent breakdown for active tasks
    const { rows: activeRows } = store.listTasksRaw({
      state: ['submitted', 'working', 'input_required', 'auth_required'],
      limit: 200,
    });
    const agentCounts: Record<string, number> = {};
    const workerSet = new Set<string>();
    for (const r of activeRows) {
      const agent = r.workflow_id || '(unrouted)';
      agentCounts[agent] = (agentCounts[agent] || 0) + 1;
      if (r.claimed_by) workerSet.add(r.claimed_by);
    }

    if (output === 'json') {
      console.log(
        JSON.stringify(
          {
            state_counts: stateCounts,
            active_by_agent: agentCounts,
            active_workers: workerSet.size,
          },
          null,
          2
        )
      );
      return;
    }

    const stateTable = new CliTable3({
      head: ['State', 'Count'],
      style: { head: ['cyan', 'bold'], border: ['grey'] },
    });
    for (const [state, count] of Object.entries(stateCounts)) {
      if (count > 0) stateTable.push([stateColor(state), String(count)]);
    }
    console.log('Task State Summary');
    console.log(stateTable.toString());

    if (Object.keys(agentCounts).length > 0) {
      const agentTable = new CliTable3({
        head: ['Workflow', 'Active Tasks'],
        style: { head: ['cyan', 'bold'], border: ['grey'] },
      });
      for (const [agent, count] of Object.entries(agentCounts)) {
        agentTable.push([agent, String(count)]);
      }
      console.log('\nActive Tasks by Workflow');
      console.log(agentTable.toString());
    }

    console.log(`\nActive instances: ${workerSet.size}`);
  });
}

// ---------------------------------------------------------------------------
// Subcommand: cancel
// ---------------------------------------------------------------------------

/**
 * Find a task by full ID or prefix match.
 */
function findTaskByPrefix(store: SqliteTaskStore, prefix: string): TaskQueueRow | null {
  const { rows } = store.listTasksRaw({ limit: 500 });
  return rows.find(r => r.id === prefix || r.id.startsWith(prefix)) ?? null;
}

async function handleCancel(
  positional: string[],
  _flags: Record<string, string | boolean>
): Promise<void> {
  const taskId = positional[0];
  if (!taskId) {
    console.error('Usage: visor tasks cancel <task-id>');
    process.exitCode = 1;
    return;
  }

  await withTaskStore(async store => {
    const match = findTaskByPrefix(store, taskId);
    if (!match) {
      console.error(`Task not found: ${taskId}`);
      process.exitCode = 1;
      return;
    }

    if (isTerminalState(match.state as TaskState)) {
      console.error(`Cannot cancel task in '${match.state}' state (already terminal)`);
      process.exitCode = 1;
      return;
    }

    store.updateTaskState(match.id, 'canceled');
    console.log(`Task ${match.id.slice(0, 8)} canceled (was: ${match.state})`);
  });
}

// ---------------------------------------------------------------------------
// Subcommand: show
// ---------------------------------------------------------------------------

async function handleShow(
  positional: string[],
  flags: Record<string, string | boolean>
): Promise<void> {
  const taskId = positional[0];
  if (!taskId) {
    console.error('Usage: visor tasks show <task-id>');
    process.exitCode = 1;
    return;
  }

  const output = typeof flags.output === 'string' ? flags.output : 'table';

  await withTaskStore(async store => {
    const match = findTaskByPrefix(store, taskId);
    if (!match) {
      console.error(`Task not found: ${taskId}`);
      process.exitCode = 1;
      return;
    }

    if (output === 'json') {
      console.log(JSON.stringify(match, null, 2));
      return;
    }

    const duration = isTerminalState(match.state as TaskState)
      ? formatDuration(match.created_at, match.updated_at)
      : formatDuration(match.claimed_at || match.created_at);

    const detailTable = new CliTable3({
      style: { head: ['cyan', 'bold'], border: ['grey'] },
      wordWrap: false,
    });

    detailTable.push(
      { 'Task ID': match.id },
      { State: stateColor(match.state) },
      { Source: match.source },
      { Workflow: match.workflow_id || '-' },
      { Instance: match.claimed_by || '-' },
      { Duration: duration },
      { Created: match.created_at },
      { Updated: match.updated_at }
    );
    if (match.run_id) detailTable.push({ 'Run ID': match.run_id });
    detailTable.push({ Input: match.request_message });

    // Show AI response from status_message (recorded on completion/failure)
    const fullTask = store.getTask(match.id);
    if (fullTask?.status?.message) {
      const parts = fullTask.status.message.parts ?? [];
      const textPart = parts.find((p: any) => typeof p.text === 'string');
      if (textPart) {
        const responseText = (textPart as any).text as string;
        // Truncate long responses for display
        const maxLen = 500;
        const display =
          responseText.length > maxLen ? responseText.slice(0, maxLen) + '...' : responseText;
        detailTable.push({ Response: display });
      }
    }

    // Show metadata
    const meta = match.metadata;
    const metaKeys = Object.keys(meta).filter(k => k !== 'source');
    for (const key of metaKeys) {
      detailTable.push({ [key]: String(meta[key]) });
    }

    console.log(detailTable.toString());
  });
}

// ---------------------------------------------------------------------------
// Subcommand: purge
// ---------------------------------------------------------------------------

async function handlePurge(flags: Record<string, string | boolean>): Promise<void> {
  const ageStr = typeof flags.age === 'string' ? flags.age : '7d';
  const match = ageStr.match(/^(\d+)([hdm])$/);
  if (!match) {
    console.error('Invalid --age format. Use e.g. 24h, 7d, 30d');
    process.exitCode = 1;
    return;
  }
  const value = parseInt(match[1], 10);
  const unit = match[2];
  const ms =
    unit === 'h' ? value * 3600_000 : unit === 'd' ? value * 86400_000 : value * 2592000_000;

  await withTaskStore(async store => {
    const deleted = store.purgeOldTasks(ms);
    console.log(`Purged ${deleted} terminal task(s) older than ${ageStr}.`);
  });
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printHelp(): void {
  console.log(`
Visor Tasks - Monitor and manage agent tasks

USAGE:
  visor tasks [command] [options]

COMMANDS:
  list                            List active tasks (default)
  show <task-id>                  Show task details (supports prefix match)
  stats                           Queue summary statistics
  cancel <task-id>                Cancel a task
  purge [--age 7d]                Delete old completed/failed tasks
  help                            Show this help

OPTIONS:
  --all                           Show all tasks including completed/failed history
  --state <state>                 Filter by state: submitted, working, completed, failed, canceled
  --search <text>                 Search tasks by input text
  --instance <id>                 Filter by visor instance ID
  --agent <workflow-id>           Filter by agent/workflow
  --limit <n>                     Number of tasks per page (default: 20)
  --page <n>                      Page number for pagination
  --output <format>               Output format: table (default), json, markdown
  --watch                         Refresh every 2 seconds

EXAMPLES:
  visor tasks                     List active tasks only
  visor tasks --all               List all tasks including history
  visor tasks --state failed      Show failed tasks
  visor tasks --search "auth"     Search tasks by text
  visor tasks show abc123         Show full task details
  visor tasks list --watch        Live monitoring
  visor tasks stats               Show queue statistics
  visor tasks cancel abc123       Cancel a task
  visor tasks purge --age 30d     Delete tasks older than 30 days
`);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function handleTasksCommand(argv: string[]): Promise<void> {
  const { subcommand, positional, flags } = parseArgs(argv);

  configureLoggerFromCli({
    output: 'table',
    debug: flags.debug === true || process.env.VISOR_DEBUG === 'true',
    verbose: flags.verbose === true,
    quiet: true, // suppress logger noise for CLI output
  });

  switch (subcommand) {
    case 'list':
      await handleList(flags);
      break;
    case 'show':
      await handleShow(positional, flags);
      break;
    case 'stats':
      await handleStats(flags);
      break;
    case 'cancel':
      await handleCancel(positional, flags);
      break;
    case 'purge':
      await handlePurge(flags);
      break;
    case 'help':
      printHelp();
      break;
    default:
      // Default: if first arg looks like a flag, treat as 'list' with flags
      if (subcommand.startsWith('--')) {
        const mergedFlags = { ...flags };
        // Re-parse with 'list' as subcommand
        const reparsed = parseArgs(['list', ...argv]);
        Object.assign(mergedFlags, reparsed.flags);
        await handleList(mergedFlags);
      } else {
        printHelp();
      }
      break;
  }
}
