/**
 * CLI command handlers for A2A task monitoring.
 *
 * Uses Commander.js for proper --help, error reporting, and option parsing.
 */
import { Command } from 'commander';
import CliTable3 from 'cli-table3';
import { configureLoggerFromCli } from '../logger';
import { getInstanceId } from '../utils/instance-id';
import { SqliteTaskStore, type ListTasksFilter, type TaskQueueRow } from './task-store';
import type { TaskState } from './types';
import { isValidTaskState, isTerminalState } from './state-transitions';

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

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const RESET = '\x1b[0m';

/** Strip ANSI escape sequences for length calculations */
function stripAnsi(s: string): number {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[\d*(;\d+)*m/g, '').length;
}

/** State icon */
function stateIcon(state: string): string {
  switch (state) {
    case 'working':
      return '⟳';
    case 'completed':
      return '✓';
    case 'failed':
      return '✗';
    case 'canceled':
    case 'rejected':
      return '⊘';
    case 'submitted':
      return '◦';
    case 'input_required':
    case 'auth_required':
      return '⏎';
    default:
      return '?';
  }
}

// ---------------------------------------------------------------------------
// Card formatting
// ---------------------------------------------------------------------------

function formatCards(rows: TaskQueueRow[], total: number, filter?: ListTasksFilter): string {
  if (rows.length === 0) return 'No tasks found.';

  const termWidth = process.stdout.columns || 80;
  const lines: string[] = [];

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const duration = isTerminalState(r.state as TaskState)
      ? formatDuration(r.created_at, r.updated_at)
      : formatDuration(r.claimed_at || r.created_at);

    const icon = stateIcon(r.state);
    const colorState = stateColor(r.state);

    // Line 1: state icon + ID + state + duration + time ago (right-aligned)
    const left1 = `${icon} ${BOLD}${r.id.slice(0, 8)}${RESET} ${colorState}`;
    const right1 = `${DIM}${duration} · ${formatTimeAgo(r.created_at)}${RESET}`;
    const pad1 = Math.max(1, termWidth - stripAnsi(left1) - stripAnsi(right1));
    lines.push(left1 + ' '.repeat(pad1) + right1);

    // Line 2: input text (truncated to terminal width with indent)
    const indent = '  ';
    const inputMax = termWidth - indent.length;
    const inputText = r.request_message || '-';
    const inputDisplay =
      inputText.length > inputMax ? inputText.slice(0, inputMax - 1) + '…' : inputText;
    lines.push(`${indent}${inputDisplay}`);

    // Line 3: metadata tags
    const tags: string[] = [];
    if (r.source) tags.push(r.source);
    if (r.workflow_id) tags.push(r.workflow_id);
    if (r.claimed_by) tags.push(`on:${r.claimed_by}`);
    const meta = r.metadata;
    if (meta.visor_version) {
      const ver = meta.visor_commit
        ? `v${meta.visor_version} (${meta.visor_commit})`
        : `v${meta.visor_version}`;
      tags.push(ver);
    }
    if (meta.slack_user) tags.push(`user:${meta.slack_user}`);
    if (meta.slack_channel) tags.push(`ch:${meta.slack_channel}`);
    if (meta.trace_id) tags.push(`trace:${String(meta.trace_id).slice(0, 8)}`);
    if (meta.schedule_id) tags.push(`sched:${meta.schedule_id}`);

    if (tags.length > 0) {
      lines.push(`${indent}${DIM}${tags.join(' · ')}${RESET}`);
    }

    // Separator between cards (except after last)
    if (i < rows.length - 1) {
      lines.push('');
    }
  }

  // Pagination info
  const limit = filter?.limit ?? 20;
  const offset = filter?.offset ?? 0;
  const page = Math.floor(offset / limit) + 1;
  const totalPages = Math.ceil(total / limit);
  if (total > rows.length) {
    lines.push('');
    lines.push(`${DIM}(${total} total, page ${page}/${totalPages}, --page N to navigate)${RESET}`);
  }
  return lines.join('\n');
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

  // Blessed TUI only when explicitly requested
  if (flags.tui === true) {
    const { runTasksTUI } = await import('./tasks-tui');
    await runTasksTUI(filter);
    return;
  }

  const instanceId = getInstanceId();

  const render = async () => {
    await withTaskStore(async store => {
      const { rows, total } = store.listTasksRaw(filter);

      const activeOnly = !flags.all && !flags.state;
      if (output === 'json') {
        // Enhanced JSON: include pagination info and response data for each task
        const limit = filter.limit ?? 20;
        const offset = filter.offset ?? 0;
        const page = Math.floor(offset / limit) + 1;
        const totalPages = Math.ceil(total / limit);

        // Enrich tasks with response data from the full task record
        const enrichedTasks = rows.map(row => {
          const fullTask = store.getTask(row.id);
          const enriched: Record<string, unknown> = { ...row };

          // Add response text from status_message
          if (fullTask?.status?.message) {
            const parts = fullTask.status.message.parts ?? [];
            const textPart = parts.find((p: any) => typeof p.text === 'string');
            if (textPart) {
              enriched.response = (textPart as any).text;
            }
            enriched.status_message = fullTask.status.message;
          }

          // Add history and artifacts counts
          if (fullTask) {
            enriched.history_count = fullTask.history?.length ?? 0;
            enriched.artifacts_count = fullTask.artifacts?.length ?? 0;
          }

          return enriched;
        });

        console.log(
          JSON.stringify(
            {
              instance_id: instanceId,
              active_only: activeOnly,
              tasks: enrichedTasks,
              total,
              pagination: {
                page,
                per_page: limit,
                total_pages: totalPages,
                offset,
                has_next: page < totalPages,
                has_prev: page > 1,
              },
            },
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
        console.log(formatCards(rows, total, filter));
      }
    });
  };

  if (flags.watch) {
    const watchRender = async () => {
      process.stdout.write('\x1Bc'); // clear terminal
      const activeOnly = !flags.all && !flags.state;
      console.log(
        `${BOLD}visor tasks${RESET} ${DIM}(instance: ${instanceId}${activeOnly ? ', active only' : ''}, Ctrl+C to exit)${RESET}\n`
      );
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
      // Enhanced JSON: include full task data with response, history, artifacts
      const fullTask = store.getTask(match.id);
      const enriched: Record<string, unknown> = { ...match };

      if (fullTask) {
        // Add response text from status_message
        if (fullTask.status?.message) {
          const parts = fullTask.status.message.parts ?? [];
          const textPart = parts.find((p: any) => typeof p.text === 'string');
          if (textPart) {
            enriched.response = (textPart as any).text;
          }
          enriched.status_message = fullTask.status.message;
        }

        // Add full history and artifacts
        enriched.history = fullTask.history ?? [];
        enriched.artifacts = fullTask.artifacts ?? [];

        // Include stored evaluation if present
        const evalArtifact = (fullTask.artifacts ?? []).find((a: any) => a.name === 'evaluation');
        if (evalArtifact) {
          try {
            const textPart = evalArtifact.parts?.find((p: any) => typeof p.text === 'string');
            if (textPart) {
              enriched.evaluation = JSON.parse((textPart as any).text);
            }
          } catch {}
        }
      }

      console.log(JSON.stringify(enriched, null, 2));
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

    // Show stored evaluation if present
    const evalArtifact = (fullTask?.artifacts ?? []).find((a: any) => a.name === 'evaluation');
    if (evalArtifact) {
      try {
        const evalTextPart = evalArtifact.parts?.find((p: any) => typeof p.text === 'string');
        if (evalTextPart) {
          const evaluation = JSON.parse((evalTextPart as any).text);
          const rq = evaluation.response_quality;
          detailTable.push({
            Evaluation: `${evaluation.overall_rating}/5 — ${evaluation.summary}`,
          });
          if (rq) {
            detailTable.push({
              'Response Quality': `${rq.rating}/5 (${rq.category}) — ${rq.reasoning}`,
            });
          }
          if (evaluation.execution_quality) {
            const eq = evaluation.execution_quality;
            detailTable.push({
              'Execution Quality': `${eq.rating}/5 (${eq.category}) — ${eq.reasoning}`,
            });
          }
        }
      } catch {}
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
// Subcommand: evaluate
// ---------------------------------------------------------------------------

async function handleEvaluate(
  positional: string[],
  flags: Record<string, string | boolean>
): Promise<void> {
  const output = typeof flags.output === 'string' ? flags.output : 'table';

  // Batch mode: --last N
  if (typeof flags.last === 'string') {
    const n = parseInt(flags.last, 10);
    if (isNaN(n) || n < 1) {
      console.error('Invalid --last value. Use a positive integer.');
      process.exitCode = 1;
      return;
    }

    await withTaskStore(async store => {
      const filter: ListTasksFilter = {
        state:
          typeof flags.state === 'string' && isValidTaskState(flags.state)
            ? [flags.state as TaskState]
            : ['completed'],
        limit: n,
      };
      const { rows } = store.listTasksRaw(filter);

      if (rows.length === 0) {
        console.log('No tasks found to evaluate.');
        return;
      }

      const { evaluateAndStore } = await import('./task-evaluator');
      const evalConfig = buildEvalConfig(flags);

      const results: Array<{ id: string; rating: number; category: string; summary: string }> = [];

      for (const row of rows) {
        try {
          console.error(`Evaluating ${row.id.slice(0, 8)}...`);
          const result = await evaluateAndStore(row.id, store, evalConfig);
          results.push({
            id: row.id.slice(0, 8),
            rating: result.overall_rating,
            category: result.response_quality.category,
            summary: result.summary,
          });
        } catch (err) {
          results.push({
            id: row.id.slice(0, 8),
            rating: 0,
            category: 'error',
            summary: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (output === 'json') {
        console.log(JSON.stringify(results, null, 2));
      } else {
        const CliTable3 = (await import('cli-table3')).default;
        const table = new CliTable3({
          head: ['ID', 'Rating', 'Category', 'Summary'],
          style: { head: ['cyan', 'bold'], border: ['grey'] },
          colWidths: [10, 8, 12, 60],
          wordWrap: true,
        });
        for (const r of results) {
          table.push([r.id, ratingDisplay(r.rating), r.category, r.summary]);
        }
        console.log(table.toString());
      }
    });
    return;
  }

  // Single task mode
  const taskId = positional[0];
  if (!taskId) {
    console.error('Usage: visor tasks evaluate <task-id> [--model X] [--provider Y]');
    console.error('       visor tasks evaluate --last N [--state completed]');
    process.exitCode = 1;
    return;
  }

  await withTaskStore(async store => {
    const { evaluateAndStore } = await import('./task-evaluator');
    const evalConfig = buildEvalConfig(flags);

    try {
      const result = await evaluateAndStore(taskId, store, evalConfig);

      if (output === 'json') {
        console.log(JSON.stringify(result, null, 2));
      } else {
        const CliTable3 = (await import('cli-table3')).default;
        const table = new CliTable3({
          style: { head: ['cyan', 'bold'], border: ['grey'] },
          wordWrap: true,
        });

        table.push(
          { 'Overall Rating': ratingDisplay(result.overall_rating) },
          { Summary: result.summary },
          {
            'Response Rating': `${ratingDisplay(result.response_quality.rating)} (${result.response_quality.category})`,
          },
          { Relevance: result.response_quality.relevance ? '✓' : '✗' },
          { Completeness: result.response_quality.completeness ? '✓' : '✗' },
          { Actionable: result.response_quality.actionable ? '✓' : '✗' },
          { 'Response Reasoning': result.response_quality.reasoning }
        );

        if (result.execution_quality) {
          table.push(
            {
              'Execution Rating': `${ratingDisplay(result.execution_quality.rating)} (${result.execution_quality.category})`,
            },
            { 'Execution Reasoning': result.execution_quality.reasoning }
          );
          if (result.execution_quality.unnecessary_tool_calls !== undefined) {
            table.push({
              'Unnecessary Tool Calls': String(result.execution_quality.unnecessary_tool_calls),
            });
          }
        }

        console.log(table.toString());
      }
    } catch (err) {
      console.error(`Evaluation failed: ${err instanceof Error ? err.message : err}`);
      process.exitCode = 1;
    }
  });
}

function buildEvalConfig(flags: Record<string, string | boolean>) {
  return {
    model: typeof flags.model === 'string' ? flags.model : undefined,
    provider: typeof flags.provider === 'string' ? flags.provider : undefined,
    prompt: typeof flags.prompt === 'string' ? flags.prompt : undefined,
  };
}

function ratingDisplay(rating: number): string {
  if (rating <= 0) return '-';
  const stars = '★'.repeat(rating) + '☆'.repeat(5 - rating);
  return `${rating}/5 ${stars}`;
}

// ---------------------------------------------------------------------------
// Subcommand: trace
// ---------------------------------------------------------------------------

async function handleTrace(
  positional: string[],
  flags: Record<string, string | boolean>
): Promise<void> {
  const taskId = positional[0];
  if (!taskId) {
    console.error('Usage: visor tasks trace <task-id>');
    process.exitCode = 1;
    return;
  }

  const output = typeof flags.output === 'string' ? flags.output : 'tree';

  await withTaskStore(async store => {
    const match = findTaskByPrefix(store, taskId);
    if (!match) {
      console.error(`Task not found: ${taskId}`);
      process.exitCode = 1;
      return;
    }

    const traceId = match.metadata?.trace_id as string | undefined;
    const traceFile = match.metadata?.trace_file as string | undefined;

    if (!traceId && !traceFile) {
      console.error('No trace information available for this task.');
      process.exitCode = 1;
      return;
    }

    const { serializeTraceForPrompt, fetchTraceSpans } = await import('./trace-serializer');

    // Use trace file path if available, otherwise use trace ID
    // (auto-detects backend: Grafana Tempo, Jaeger, or local files)
    const traceRef = traceFile || traceId!;

    if (output === 'json') {
      const spans = await fetchTraceSpans(traceId!, {
        traceDir: typeof flags['trace-dir'] === 'string' ? flags['trace-dir'] : undefined,
      });
      if (spans.length === 0) {
        console.error(`No trace data found for trace_id=${traceId?.slice(0, 16)}`);
        console.error('Tried: Grafana Tempo, Jaeger, local NDJSON files');
        process.exitCode = 1;
        return;
      }
      const totalDuration =
        Math.max(...spans.map(s => s.endTimeMs)) - Math.min(...spans.map(s => s.startTimeMs));
      console.log(
        JSON.stringify(
          {
            trace_id: traceId,
            total_spans: spans.length,
            duration_ms: Math.round(totalDuration),
            spans: spans.map(s => ({
              name: s.name,
              duration_ms: Math.round(s.durationMs),
              parent: s.parentSpanId?.slice(0, 8) || null,
              attributes: s.attributes,
            })),
          },
          null,
          2
        )
      );
    } else {
      const maxChars = flags.full ? 1_000_000 : 8000;

      // Get the task's final response from the task store (not truncated by OTEL)
      const fullTask = store.getTask(match.id);
      let taskResponse: string | undefined;
      if (fullTask?.status?.message) {
        const parts = fullTask.status.message.parts ?? [];
        const textPart = parts.find((p: any) => typeof p.text === 'string');
        if (textPart) taskResponse = (textPart as any).text;
      }

      const tree = await serializeTraceForPrompt(traceRef, maxChars, undefined, taskResponse);
      if (tree === '(no trace data available)') {
        console.error(`No trace data found for trace_id=${traceId?.slice(0, 16)}`);
        console.error('Tried: Grafana Tempo, Jaeger, local NDJSON files');
        console.error('Set GRAFANA_URL, JAEGER_URL, or VISOR_TRACE_BACKEND to configure.');
        process.exitCode = 1;
        return;
      }
      console.log(tree);
    }
  });
}

// ---------------------------------------------------------------------------
// Commander-based entry point
// ---------------------------------------------------------------------------

/**
 * Convert Commander options object → legacy flags Record for handler compatibility.
 */
function optsToFlags(opts: Record<string, any>): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (const [k, v] of Object.entries(opts)) {
    if (v === undefined) continue;
    flags[k] = v;
  }
  return flags;
}

function configureLogger(opts: Record<string, any>): void {
  configureLoggerFromCli({
    output: 'table',
    debug: opts.debug === true || process.env.VISOR_DEBUG === 'true',
    verbose: opts.verbose === true,
    quiet: true, // suppress logger noise for CLI output
  });
}

export async function handleTasksCommand(argv: string[]): Promise<void> {
  const program = new Command('tasks')
    .description('Monitor and manage agent tasks')
    .option('--debug', 'Enable debug logging')
    .option('--verbose', 'Enable verbose logging');

  // --- list (default) ---
  program
    .command('list', { isDefault: true })
    .description('List tasks (auto-refreshes in TTY)')
    .option('--all', 'Show all tasks including completed/failed history')
    .option('--state <state>', 'Filter by state: submitted, working, completed, failed, canceled')
    .option('--search <text>', 'Search tasks by input text')
    .option('--instance <id>', 'Filter by visor instance ID')
    .option('--agent <workflow-id>', 'Filter by agent/workflow')
    .option('--limit <n>', 'Number of tasks per page (default: 20)')
    .option('--page <n>', 'Page number')
    .option('--output <format>', 'Output format: table, json, markdown')
    .option('--tui', 'Use interactive blessed TUI (table view, keyboard nav)')
    .option('--watch', 'Refresh every 2 seconds (same as default TTY behavior)')
    .action(async opts => {
      configureLogger(opts);
      await handleList(optsToFlags(opts));
    });

  // --- show ---
  program
    .command('show <task-id>')
    .description('Show task details (supports prefix match)')
    .option('--output <format>', 'Output format: table, json')
    .action(async (taskId, opts) => {
      configureLogger(opts);
      await handleShow([taskId], optsToFlags(opts));
    });

  // --- stats ---
  program
    .command('stats')
    .description('Queue summary statistics')
    .option('--output <format>', 'Output format: table, json')
    .action(async opts => {
      configureLogger(opts);
      await handleStats(optsToFlags(opts));
    });

  // --- cancel ---
  program
    .command('cancel <task-id>')
    .description('Cancel a running task')
    .action(async (taskId, opts) => {
      configureLogger(opts);
      await handleCancel([taskId], optsToFlags(opts));
    });

  // --- evaluate ---
  program
    .command('evaluate [task-id]')
    .description('Evaluate task response quality with LLM judge')
    .option('--model <model>', 'LLM model for evaluation')
    .option('--provider <provider>', 'AI provider (google, openai, anthropic)')
    .option('--last <n>', 'Batch evaluate last N tasks')
    .option('--state <state>', 'Filter by state for batch mode (default: completed)')
    .option('--prompt <text>', 'Custom evaluation prompt')
    .option('--output <format>', 'Output format: table, json')
    .action(async (taskId, opts) => {
      configureLogger(opts);
      const flags = optsToFlags(opts);
      if (!taskId && !flags.last) {
        console.error('Error: specify a <task-id> or use --last <n> for batch mode');
        process.exitCode = 1;
        return;
      }
      await handleEvaluate(taskId ? [taskId] : [], flags);
    });

  // --- trace ---
  program
    .command('trace <task-id>')
    .description('Show execution trace tree')
    .option('--full', 'Show full output without truncation')
    .option('--output <format>', 'Output format: tree, json')
    .action(async (taskId, opts) => {
      configureLogger(opts);
      await handleTrace([taskId], optsToFlags(opts));
    });

  // --- purge ---
  program
    .command('purge')
    .description('Delete old completed/failed tasks')
    .option('--age <duration>', 'Maximum age (e.g. 24h, 7d, 30d)', '7d')
    .action(async opts => {
      configureLogger(opts);
      await handlePurge(optsToFlags(opts));
    });

  // Commander writes help/errors to stdout/stderr and calls process.exit
  // by default, which is the behavior we want for a CLI tool.
  program.exitOverride(); // throw instead of process.exit so we can handle it
  try {
    await program.parseAsync(argv, { from: 'user' });
  } catch (err: any) {
    // Commander throws on --help and --version (exit code 0) and on errors
    if (err?.exitCode === 0) return; // --help
    if (err?.code === 'commander.helpDisplayed') return;
    if (err?.code === 'commander.unknownCommand' || err?.code === 'commander.missingArgument') {
      // Commander already printed the error
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}
