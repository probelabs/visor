/**
 * Interactive TUI for browsing agent tasks.
 *
 * Uses blessed to render a navigable list of tasks with detail view.
 * Arrow keys to navigate, Enter for details, Escape to go back, q to quit.
 */
import blessed from 'blessed';
import { SqliteTaskStore, type ListTasksFilter, type TaskQueueRow } from './task-store';
import type { AgentTask } from './types';
import { isTerminalState } from './state-transitions';
import { getInstanceId } from '../utils/instance-id';

// ---------------------------------------------------------------------------
// Blessed monkey-patch (same guard as chat-tui.ts)
// ---------------------------------------------------------------------------
const BlessedElement = (blessed as any).widget?.Element?.prototype;
if (BlessedElement) {
  for (const method of [
    '_getWidth',
    '_getHeight',
    '_getLeft',
    '_getRight',
    '_getTop',
    '_getBottom',
  ]) {
    const orig = BlessedElement[method];
    if (typeof orig === 'function') {
      BlessedElement[method] = function (this: any, ...args: any[]) {
        if (!this.parent) return 0;
        return orig.apply(this, args);
      };
    }
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TaskListItem {
  row: TaskQueueRow;
  fullTask?: AgentTask;
}

type ViewMode = 'list' | 'detail';

// ---------------------------------------------------------------------------
// Helpers
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

function stateTag(state: string): string {
  switch (state) {
    case 'working':
      return '{yellow-fg}working{/yellow-fg}';
    case 'completed':
      return '{green-fg}completed{/green-fg}';
    case 'failed':
      return '{red-fg}failed{/red-fg}';
    case 'canceled':
    case 'rejected':
      return '{grey-fg}' + state + '{/grey-fg}';
    case 'submitted':
      return '{cyan-fg}submitted{/cyan-fg}';
    case 'input_required':
    case 'auth_required':
      return '{magenta-fg}' + state + '{/magenta-fg}';
    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Main TUI class
// ---------------------------------------------------------------------------

export class TasksTUI {
  private screen: blessed.Widgets.Screen;
  private listBox: blessed.Widgets.BoxElement;
  private detailBox: blessed.Widgets.BoxElement;
  private statusBar: blessed.Widgets.BoxElement;
  private store: SqliteTaskStore;
  private filter: ListTasksFilter;
  private instanceId: string;

  private items: TaskListItem[] = [];
  private total = 0;
  private selectedIndex = 0;
  private scrollOffset = 0;
  private mode: ViewMode = 'list';
  private detailScrollOffset = 0;
  private detailLines: string[] = [];

  private refreshInterval?: NodeJS.Timeout;
  private destroyed = false;

  constructor(store: SqliteTaskStore, filter: ListTasksFilter) {
    this.store = store;
    this.filter = { ...filter };
    this.filter.limit = this.filter.limit ?? 50;
    this.instanceId = getInstanceId();

    this.screen = blessed.screen({
      smartCSR: true,
      title: 'Visor Tasks',
      fullUnicode: true,
    });

    // Status bar at top
    this.statusBar = blessed.box({
      parent: this.screen,
      top: 0,
      left: 0,
      width: '100%',
      height: 1,
      tags: true,
      style: {
        bg: 'blue',
        fg: 'white',
      },
    });

    // List view
    this.listBox = blessed.box({
      parent: this.screen,
      top: 1,
      left: 0,
      width: '100%',
      height: '100%-2',
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      mouse: true,
      keys: true,
    });

    // Detail view (hidden initially)
    this.detailBox = blessed.box({
      parent: this.screen,
      top: 1,
      left: 0,
      width: '100%',
      height: '100%-2',
      tags: true,
      scrollable: true,
      alwaysScroll: true,
      mouse: true,
      keys: true,
      hidden: true,
    });

    // Help bar at bottom
    const helpBar = blessed.box({
      parent: this.screen,
      bottom: 0,
      left: 0,
      width: '100%',
      height: 1,
      tags: true,
      style: {
        bg: 'black',
        fg: 'grey',
      },
    });
    helpBar.setContent(
      ' {bold}Up/Down{/bold} Navigate  {bold}Enter{/bold} Details  {bold}Esc{/bold} Back  {bold}a{/bold} Toggle All  {bold}r{/bold} Refresh  {bold}q{/bold} Quit'
    );

    this.setupKeyBindings();
  }

  private setupKeyBindings(): void {
    // Navigation in list mode
    this.screen.key(['up', 'k'], () => {
      if (this.mode === 'list') {
        this.moveSelection(-1);
      } else {
        this.scrollDetail(-1);
      }
    });

    this.screen.key(['down', 'j'], () => {
      if (this.mode === 'list') {
        this.moveSelection(1);
      } else {
        this.scrollDetail(1);
      }
    });

    this.screen.key(['pageup'], () => {
      if (this.mode === 'list') {
        this.moveSelection(-this.getVisibleHeight());
      } else {
        this.scrollDetail(-this.getVisibleHeight());
      }
    });

    this.screen.key(['pagedown'], () => {
      if (this.mode === 'list') {
        this.moveSelection(this.getVisibleHeight());
      } else {
        this.scrollDetail(this.getVisibleHeight());
      }
    });

    this.screen.key(['home', 'g'], () => {
      if (this.mode === 'list') {
        this.selectedIndex = 0;
        this.scrollOffset = 0;
        this.render();
      } else {
        this.detailScrollOffset = 0;
        this.renderDetail();
      }
    });

    this.screen.key(['end', 'S-g'], () => {
      if (this.mode === 'list') {
        this.selectedIndex = Math.max(0, this.items.length - 1);
        this.ensureVisible();
        this.render();
      } else {
        this.detailScrollOffset = Math.max(0, this.detailLines.length - this.getVisibleHeight());
        this.renderDetail();
      }
    });

    // Enter detail mode
    this.screen.key(['enter'], () => {
      if (this.mode === 'list' && this.items.length > 0) {
        this.enterDetail();
      }
    });

    // Back to list
    this.screen.key(['escape'], () => {
      if (this.mode === 'detail') {
        this.mode = 'list';
        this.detailBox.hide();
        this.listBox.show();
        this.listBox.focus();
        this.render();
      }
    });

    // Toggle all tasks vs active only
    this.screen.key(['a'], () => {
      if (this.mode !== 'list') return;
      if (this.filter.state) {
        // Currently showing filtered — switch to all
        delete this.filter.state;
      } else {
        // Currently showing all — switch to active only
        this.filter.state = ['submitted', 'working', 'input_required', 'auth_required'];
      }
      this.selectedIndex = 0;
      this.scrollOffset = 0;
      this.loadTasks();
    });

    // Refresh
    this.screen.key(['r'], () => {
      this.loadTasks();
    });

    // Cancel task
    this.screen.key(['c'], () => {
      if (this.items.length === 0) return;
      const item = this.items[this.selectedIndex];
      if (item && !isTerminalState(item.row.state)) {
        try {
          this.store.updateTaskState(item.row.id, 'canceled');
          this.loadTasks();
        } catch {
          // ignore
        }
      }
    });

    // Quit
    this.screen.key(['q', 'C-c'], () => {
      this.destroy();
    });
  }

  private getVisibleHeight(): number {
    const h = (this.listBox as any).height;
    return typeof h === 'number' ? h - 2 : 20; // subtract header lines
  }

  private moveSelection(delta: number): void {
    if (this.items.length === 0) return;
    this.selectedIndex = Math.max(0, Math.min(this.items.length - 1, this.selectedIndex + delta));
    this.ensureVisible();
    this.render();
  }

  private ensureVisible(): void {
    const visHeight = this.getVisibleHeight();
    // Account for 2 header lines (header + separator)
    const effectiveHeight = visHeight - 2;
    if (effectiveHeight <= 0) return;
    if (this.selectedIndex < this.scrollOffset) {
      this.scrollOffset = this.selectedIndex;
    } else if (this.selectedIndex >= this.scrollOffset + effectiveHeight) {
      this.scrollOffset = this.selectedIndex - effectiveHeight + 1;
    }
  }

  private scrollDetail(delta: number): void {
    const maxScroll = Math.max(0, this.detailLines.length - this.getVisibleHeight());
    this.detailScrollOffset = Math.max(0, Math.min(maxScroll, this.detailScrollOffset + delta));
    this.renderDetail();
  }

  private loadTasks(): void {
    try {
      const { rows, total } = this.store.listTasksRaw(this.filter);
      this.items = rows.map(row => ({ row }));
      this.total = total;
      if (this.selectedIndex >= this.items.length) {
        this.selectedIndex = Math.max(0, this.items.length - 1);
      }
      this.render();
    } catch (err) {
      this.statusBar.setContent(` {red-fg}Error: ${err}{/red-fg}`);
      this.screen.render();
    }
  }

  private enterDetail(): void {
    const item = this.items[this.selectedIndex];
    if (!item) return;

    // Load full task data
    const fullTask = this.store.getTask(item.row.id);
    item.fullTask = fullTask ?? undefined;

    this.mode = 'detail';
    this.detailScrollOffset = 0;
    this.listBox.hide();
    this.detailBox.show();
    this.detailBox.focus();
    this.renderDetail();
  }

  private render(): void {
    if (this.destroyed) return;

    // Update status bar
    const stateLabel = this.filter.state ? 'active' : 'all';
    const page = Math.floor((this.filter.offset ?? 0) / (this.filter.limit ?? 50)) + 1;
    const totalPages = Math.ceil(this.total / (this.filter.limit ?? 50));
    this.statusBar.setContent(
      ` {bold}Visor Tasks{/bold} | Instance: ${this.instanceId} | Showing: ${stateLabel} | ${this.total} tasks (page ${page}/${totalPages || 1}) | Auto-refresh: 2s`
    );

    // Build list content
    const lines: string[] = [];
    const termWidth = (this.screen as any).width || 120;

    // Header
    const idW = 10;
    const stateW = 16;
    const sourceW = 10;
    const workflowW = 14;
    const createdW = 10;
    const durationW = 10;
    const fixedW = idW + stateW + sourceW + workflowW + createdW + durationW + 8; // borders
    const inputW = Math.max(10, termWidth - fixedW);

    const header = ` ${'ID'.padEnd(idW)}${'State'.padEnd(stateW)}${'Source'.padEnd(sourceW)}${'Workflow'.padEnd(workflowW)}${'Created'.padEnd(createdW)}${'Duration'.padEnd(durationW)}${'Input'.padEnd(inputW)}`;
    lines.push(`{bold}${header}{/bold}`);
    lines.push('{grey-fg}' + '\u2500'.repeat(Math.min(termWidth, 200)) + '{/grey-fg}');

    // Task rows
    const visHeight = this.getVisibleHeight() - 2; // subtract header + separator
    const endIdx = Math.min(this.items.length, this.scrollOffset + visHeight);

    for (let i = this.scrollOffset; i < endIdx; i++) {
      const item = this.items[i];
      const r = item.row;
      const isSelected = i === this.selectedIndex;

      const duration = isTerminalState(r.state)
        ? formatDuration(r.created_at, r.updated_at)
        : formatDuration(r.claimed_at || r.created_at);

      const input =
        r.request_message.length > inputW - 3
          ? r.request_message.slice(0, inputW - 6) + '...'
          : r.request_message || '-';

      const id = r.id.slice(0, 8).padEnd(idW);
      const source = (r.source || '-').slice(0, sourceW - 2).padEnd(sourceW);
      const workflow = (r.workflow_id || '-').slice(0, workflowW - 2).padEnd(workflowW);
      const created = formatTimeAgo(r.created_at).padEnd(createdW);
      const dur = duration.padEnd(durationW);

      if (isSelected) {
        // Use state-colored line with inverse selection
        const coloredState = stateTag(r.state);
        const coloredLine = ` ${id}${coloredState}${' '.repeat(Math.max(0, stateW - r.state.length))}${source}${workflow}${created}${dur}${input}`;
        lines.push(`{inverse}${coloredLine}{/inverse}`);
      } else {
        const coloredState = stateTag(r.state);
        const coloredLine = ` ${id}${coloredState}${' '.repeat(Math.max(0, stateW - r.state.length))}${source}${workflow}${created}${dur}${input}`;
        lines.push(coloredLine);
      }
    }

    if (this.items.length === 0) {
      lines.push('');
      lines.push('  No tasks found.');
      lines.push('  Press {bold}a{/bold} to toggle between active/all tasks.');
    }

    this.listBox.setContent(lines.join('\n'));
    this.screen.render();
  }

  private renderDetail(): void {
    if (this.destroyed) return;

    const item = this.items[this.selectedIndex];
    if (!item) return;

    const r = item.row;
    const fullTask = item.fullTask;
    const lines: string[] = [];

    lines.push('{bold}Task Detail{/bold}');
    lines.push('{grey-fg}' + '\u2500'.repeat(60) + '{/grey-fg}');
    lines.push('');
    lines.push(`  {bold}Task ID:{/bold}    ${r.id}`);
    lines.push(`  {bold}State:{/bold}      ${stateTag(r.state)}`);
    lines.push(`  {bold}Source:{/bold}     ${r.source || '-'}`);
    lines.push(`  {bold}Workflow:{/bold}   ${r.workflow_id || '-'}`);
    lines.push(`  {bold}Instance:{/bold}   ${r.claimed_by || '-'}`);

    const duration = isTerminalState(r.state)
      ? formatDuration(r.created_at, r.updated_at)
      : formatDuration(r.claimed_at || r.created_at);
    lines.push(`  {bold}Duration:{/bold}   ${duration}`);
    lines.push(`  {bold}Created:{/bold}    ${r.created_at}`);
    lines.push(`  {bold}Updated:{/bold}    ${r.updated_at}`);
    if (r.run_id) {
      lines.push(`  {bold}Run ID:{/bold}     ${r.run_id}`);
    }

    // Context ID
    lines.push(`  {bold}Context:{/bold}    ${r.context_id}`);

    // Metadata
    const metaKeys = Object.keys(r.metadata).filter(k => k !== 'source');
    if (metaKeys.length > 0) {
      lines.push('');
      lines.push('{bold}Metadata{/bold}');
      lines.push('{grey-fg}' + '\u2500'.repeat(60) + '{/grey-fg}');
      for (const key of metaKeys) {
        const val =
          typeof r.metadata[key] === 'string' ? r.metadata[key] : JSON.stringify(r.metadata[key]);
        lines.push(`  {bold}${key}:{/bold} ${val}`);
      }
    }

    // Input message
    lines.push('');
    lines.push('{bold}Input{/bold}');
    lines.push('{grey-fg}' + '\u2500'.repeat(60) + '{/grey-fg}');
    lines.push('');
    // Word-wrap the input message
    const inputText = r.request_message || '(empty)';
    lines.push(...this.wrapText(inputText, (this.screen as any).width - 4 || 116));

    // Response (from status message)
    if (fullTask?.status?.message) {
      const parts = fullTask.status.message.parts ?? [];
      const textPart = parts.find((p: any) => typeof p.text === 'string');
      if (textPart) {
        const responseText = (textPart as any).text as string;
        lines.push('');
        lines.push('{bold}Response{/bold}');
        lines.push('{grey-fg}' + '\u2500'.repeat(60) + '{/grey-fg}');
        lines.push('');
        lines.push(...this.wrapText(responseText, (this.screen as any).width - 4 || 116));
      }
    }

    // History
    if (fullTask?.history && fullTask.history.length > 0) {
      lines.push('');
      lines.push(`{bold}History{/bold} (${fullTask.history.length} messages)`);
      lines.push('{grey-fg}' + '\u2500'.repeat(60) + '{/grey-fg}');
      for (let i = 0; i < fullTask.history.length; i++) {
        const msg = fullTask.history[i];
        const role = (msg as any).role || 'unknown';
        const parts = (msg as any).parts ?? [];
        const textPart = parts.find((p: any) => typeof p.text === 'string');
        const text = textPart ? (textPart as any).text : '(no text)';
        lines.push('');
        lines.push(`  {bold}[${i + 1}] ${role}{/bold}`);
        const truncated = text.length > 500 ? text.slice(0, 500) + '...' : text;
        lines.push(...this.wrapText('  ' + truncated, (this.screen as any).width - 6 || 114));
      }
    }

    // Artifacts
    if (fullTask?.artifacts && fullTask.artifacts.length > 0) {
      lines.push('');
      lines.push(`{bold}Artifacts{/bold} (${fullTask.artifacts.length})`);
      lines.push('{grey-fg}' + '\u2500'.repeat(60) + '{/grey-fg}');
      for (const art of fullTask.artifacts) {
        const name = (art as any).name || '(unnamed)';
        const parts = (art as any).parts ?? [];
        lines.push(`  - ${name} (${parts.length} parts)`);
      }
    }

    lines.push('');
    lines.push('{grey-fg}Press Escape to return to list{/grey-fg}');

    this.detailLines = lines;

    // Apply scroll
    const visHeight = this.getVisibleHeight();
    const visibleLines = lines.slice(this.detailScrollOffset, this.detailScrollOffset + visHeight);
    this.detailBox.setContent(visibleLines.join('\n'));
    this.screen.render();
  }

  private wrapText(text: string, width: number): string[] {
    const result: string[] = [];
    for (const rawLine of text.split('\n')) {
      if (rawLine.length <= width) {
        result.push(rawLine);
      } else {
        let remaining = rawLine;
        while (remaining.length > width) {
          // Try to break at a space
          let breakAt = remaining.lastIndexOf(' ', width);
          if (breakAt <= 0) breakAt = width;
          result.push(remaining.slice(0, breakAt));
          remaining = remaining.slice(breakAt).trimStart();
        }
        if (remaining) result.push(remaining);
      }
    }
    return result;
  }

  async start(): Promise<void> {
    this.loadTasks();
    this.listBox.focus();

    // Auto-refresh every 2 seconds
    this.refreshInterval = setInterval(() => {
      if (this.mode === 'list') {
        this.loadTasks();
      }
    }, 2000);

    // Wait for quit
    return new Promise<void>(resolve => {
      this.screen.on('destroy', () => {
        resolve();
      });
    });
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.refreshInterval) {
      clearInterval(this.refreshInterval);
      this.refreshInterval = undefined;
    }
    try {
      this.screen.destroy();
    } catch {
      // blessed destroy can crash
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point for `visor tasks --tui` or `visor tasks tui`
// ---------------------------------------------------------------------------

export async function runTasksTUI(filter: ListTasksFilter): Promise<void> {
  const store = new SqliteTaskStore();
  await store.initialize();

  const tui = new TasksTUI(store, filter);
  try {
    await tui.start();
  } finally {
    await store.shutdown();
  }
}
