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
  return `${hours}h ${remMins}m`;
}

// ---------------------------------------------------------------------------
// Filter builder
// ---------------------------------------------------------------------------

function buildFilter(flags: Record<string, string | boolean>): ListTasksFilter {
  const filter: ListTasksFilter = {};
  if (typeof flags.state === 'string' && isValidTaskState(flags.state)) {
    filter.state = [flags.state as TaskState];
  }
  if (typeof flags.agent === 'string') {
    filter.workflowId = flags.agent;
  }
  if (typeof flags.limit === 'string') {
    const n = parseInt(flags.limit, 10);
    if (!isNaN(n) && n > 0) filter.limit = n;
  }
  filter.limit = filter.limit ?? 20;
  return filter;
}

// ---------------------------------------------------------------------------
// Table formatting
// ---------------------------------------------------------------------------

function formatTable(rows: TaskQueueRow[], total: number): string {
  if (rows.length === 0) return 'No tasks found.';

  const header = ['ID', 'Source', 'State', 'Workflow', 'Duration', 'Instance', 'Input'];
  const data = rows.map(r => {
    const duration = isTerminalState(r.state as TaskState)
      ? formatDuration(r.created_at, r.updated_at)
      : formatDuration(r.claimed_at || r.created_at);

    const instance = r.claimed_by || '-';
    const workflow = r.workflow_id || '-';
    const source = r.source || '-';
    const input =
      r.request_message.length > 60
        ? r.request_message.slice(0, 57) + '...'
        : r.request_message || '-';

    return [r.id.slice(0, 8), source, r.state, workflow, duration, instance, input];
  });

  const widths = header.map((h, i) => Math.max(h.length, ...data.map(row => row[i].length)));

  const sep = widths.map(w => '-'.repeat(w)).join('  ');
  const fmt = (row: string[]) => row.map((cell, i) => cell.padEnd(widths[i])).join('  ');

  const lines = [fmt(header), sep, ...data.map(fmt)];
  if (total > rows.length) lines.push(`\n(${total} total, showing ${rows.length})`);
  return lines.join('\n');
}

function formatMarkdown(rows: TaskQueueRow[], total: number): string {
  if (rows.length === 0) return 'No tasks found.';

  const header = ['ID', 'Source', 'State', 'Workflow', 'Duration', 'Instance', 'Input'];
  const data = rows.map(r => {
    const duration = isTerminalState(r.state as TaskState)
      ? formatDuration(r.created_at, r.updated_at)
      : formatDuration(r.claimed_at || r.created_at);

    const instance = r.claimed_by || '-';
    const workflow = r.workflow_id || '-';
    const source = r.source || '-';
    const input =
      r.request_message.length > 60
        ? r.request_message.slice(0, 57) + '...'
        : r.request_message || '-';

    return [r.id.slice(0, 8), source, r.state, workflow, duration, instance, input];
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

      if (output === 'json') {
        console.log(JSON.stringify({ instance_id: instanceId, tasks: rows, total }, null, 2));
      } else if (output === 'markdown') {
        console.log(`Instance: ${instanceId}\n`);
        console.log(formatMarkdown(rows, total));
      } else {
        console.log(`Instance: ${instanceId}\n`);
        console.log(formatTable(rows, total));
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

    console.log('Task State Summary');
    console.log('------------------');
    for (const [state, count] of Object.entries(stateCounts)) {
      if (count > 0) console.log(`  ${state.padEnd(18)} ${count}`);
    }

    if (Object.keys(agentCounts).length > 0) {
      console.log('\nActive Tasks by Agent');
      console.log('---------------------');
      for (const [agent, count] of Object.entries(agentCounts)) {
        console.log(`  ${agent.padEnd(24)} ${count}`);
      }
    }

    console.log(`\nActive workers: ${workerSet.size}`);
  });
}

// ---------------------------------------------------------------------------
// Subcommand: cancel
// ---------------------------------------------------------------------------

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
    const task = store.getTask(taskId);
    if (!task) {
      console.error(`Task not found: ${taskId}`);
      process.exitCode = 1;
      return;
    }

    if (isTerminalState(task.status.state)) {
      console.error(`Cannot cancel task in '${task.status.state}' state (already terminal)`);
      process.exitCode = 1;
      return;
    }

    store.updateTaskState(taskId, 'canceled');
    console.log(`Task ${taskId.slice(0, 8)} canceled (was: ${task.status.state})`);
  });
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function printHelp(): void {
  console.log(`
Visor Tasks - Monitor and manage A2A agent tasks

USAGE:
  visor tasks [command] [options]

COMMANDS:
  list                            List tasks (default)
  stats                           Queue summary statistics
  cancel <task-id>                Cancel a task
  help                            Show this help

OPTIONS:
  --output <format>               Output format: table (default), json, markdown
  --state <state>                 Filter by state: submitted, working, completed, failed, canceled
  --agent <workflow-id>           Filter by agent/workflow
  --limit <n>                     Number of tasks to show (default: 20)
  --watch                         Refresh every 2 seconds

EXAMPLES:
  visor tasks                     List all tasks
  visor tasks list --state working   Show only working tasks
  visor tasks list --agent security-review   Show tasks for a specific agent
  visor tasks list --output json  JSON output
  visor tasks list --watch        Live monitoring
  visor tasks stats               Show queue statistics
  visor tasks cancel abc123       Cancel a task
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
    case 'stats':
      await handleStats(flags);
      break;
    case 'cancel':
      await handleCancel(positional, flags);
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
