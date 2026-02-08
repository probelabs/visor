/**
 * TraceViewer - ASCII OpenTelemetry Trace Visualization
 *
 * Renders spans as an ASCII tree with timing information.
 * Supports live updates by re-parsing the trace file.
 */
import blessed from 'blessed';
import * as fs from 'fs';
import * as readline from 'readline';

type Box = blessed.Widgets.BoxElement;
type Log = blessed.Widgets.Log;

/**
 * Simplified span structure for display
 */
interface DisplaySpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTime: number; // milliseconds
  endTime: number; // milliseconds
  duration: number; // milliseconds
  status: 'ok' | 'error';
  checkId?: string;
  checkType?: string;
  input?: string; // Truncated input preview
  output?: string; // Truncated output preview
  error?: string; // Error message if any
  children: DisplaySpan[];
}

export interface TraceViewerOptions {
  parent: Box;
  traceFilePath?: string;
}

export class TraceViewer {
  private container: Box;
  private contentBox: Log;
  private traceFilePath?: string;
  private spans: DisplaySpan[] = [];
  private rootSpans: DisplaySpan[] = [];
  private lastModified = 0;
  private watchInterval?: NodeJS.Timeout;

  constructor(options: TraceViewerOptions) {
    this.traceFilePath = options.traceFilePath;

    this.container = blessed.box({
      parent: options.parent,
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
    });

    this.contentBox = blessed.log({
      parent: this.container,
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
      label: ' Traces ',
      border: { type: 'line' },
      scrollable: true,
      alwaysScroll: true,
      mouse: true,
      keys: true,
      tags: false,
      wrap: false,
      scrollbar: {
        ch: ' ',
      },
    });

    // Initial content
    if (!this.traceFilePath) {
      this.contentBox.log('Waiting for trace data...');
      this.contentBox.log('');
      this.contentBox.log('Traces will appear here once execution starts.');
    }
  }

  setTraceFile(path: string): void {
    this.traceFilePath = path;
    this.startWatching();
  }

  startWatching(): void {
    if (this.watchInterval) return;

    // Check for updates every 500ms
    this.watchInterval = setInterval(() => {
      this.checkForUpdates();
    }, 500);

    // Initial load
    this.checkForUpdates();
  }

  stopWatching(): void {
    if (this.watchInterval) {
      clearInterval(this.watchInterval);
      this.watchInterval = undefined;
    }
  }

  private async checkForUpdates(): Promise<void> {
    if (!this.traceFilePath) return;

    try {
      const stats = fs.statSync(this.traceFilePath);
      if (stats.mtimeMs > this.lastModified) {
        this.lastModified = stats.mtimeMs;
        await this.loadAndRender();
      }
    } catch {
      // File doesn't exist yet, that's okay
    }
  }

  private async loadAndRender(): Promise<void> {
    if (!this.traceFilePath) return;

    try {
      const spans = await this.parseTraceFile(this.traceFilePath);
      this.spans = spans;
      this.buildTree();
      this.render();
    } catch (error) {
      this.contentBox.setContent(`Error loading traces: ${error}`);
    }
  }

  private async parseTraceFile(filePath: string): Promise<DisplaySpan[]> {
    const spans: DisplaySpan[] = [];

    const fileStream = fs.createReadStream(filePath);
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      if (!line.trim()) continue;

      try {
        const raw = JSON.parse(line);
        const span = this.convertSpan(raw);
        spans.push(span);
      } catch {
        // Skip malformed lines
      }
    }

    return spans;
  }

  private convertSpan(raw: any): DisplaySpan {
    const startTime = this.timeToMillis(raw.startTime || [0, 0]);
    const endTime = this.timeToMillis(raw.endTime || raw.startTime || [0, 0]);
    const attrs = raw.attributes || {};

    // Extract input preview (from context or input keys)
    let input: string | undefined;
    if (attrs['visor.check.input.keys']) {
      input = `keys: ${this.truncate(attrs['visor.check.input.keys'], 60)}`;
    } else if (attrs['visor.check.input.context']) {
      input = this.truncate(attrs['visor.check.input.context'], 80);
    }

    // Extract output preview
    let output: string | undefined;
    if (attrs['visor.check.output.preview']) {
      output = this.truncate(attrs['visor.check.output.preview'], 80);
    } else if (attrs['visor.check.output']) {
      output = this.truncate(attrs['visor.check.output'], 80);
    }

    // Extract error message
    let error: string | undefined;
    if (attrs['visor.check.error']) {
      error = this.truncate(attrs['visor.check.error'], 100);
    }

    return {
      traceId: raw.traceId || '',
      spanId: raw.spanId || '',
      parentSpanId: raw.parentSpanId || undefined,
      name: raw.name || 'unknown',
      startTime,
      endTime,
      duration: endTime - startTime,
      status: raw.status?.code === 2 ? 'error' : 'ok',
      checkId: attrs['visor.check.id'],
      checkType: attrs['visor.check.type'],
      input,
      output,
      error,
      children: [],
    };
  }

  private truncate(str: string, maxLen: number): string {
    if (!str) return '';
    const cleaned = str.replace(/[\n\r]+/g, ' ').trim();
    if (cleaned.length <= maxLen) return cleaned;
    return cleaned.substring(0, maxLen - 3) + '...';
  }

  private timeToMillis(time: [number, number]): number {
    return time[0] * 1000 + time[1] / 1_000_000;
  }

  private buildTree(): void {
    // Create map for quick lookup
    const spanMap = new Map<string, DisplaySpan>();
    for (const span of this.spans) {
      span.children = []; // Reset children
      spanMap.set(span.spanId, span);
    }

    // Build parent-child relationships
    this.rootSpans = [];
    for (const span of this.spans) {
      if (!span.parentSpanId) {
        this.rootSpans.push(span);
      } else {
        const parent = spanMap.get(span.parentSpanId);
        if (parent) {
          parent.children.push(span);
        } else {
          // Orphaned span - treat as root
          this.rootSpans.push(span);
        }
      }
    }

    // Sort children by start time
    const sortChildren = (span: DisplaySpan) => {
      span.children.sort((a, b) => a.startTime - b.startTime);
      span.children.forEach(sortChildren);
    };
    this.rootSpans.forEach(sortChildren);
    this.rootSpans.sort((a, b) => a.startTime - b.startTime);
  }

  private render(): void {
    const lines: string[] = [];

    // Header
    lines.push('┌─────────────────────────────────────────────────────────────────────────────┐');
    lines.push('│                         OPENTELEMETRY TRACE VIEWER                          │');
    lines.push('├─────────────────────────────────────────────────────────────────────────────┤');

    if (this.spans.length === 0) {
      lines.push('│  Waiting for trace data...                                                  │');
      lines.push('│  Traces will appear here as the workflow executes.                         │');
      lines.push('└─────────────────────────────────────────────────────────────────────────────┘');
    } else {
      // Summary
      const totalDuration = this.calculateTotalDuration();
      const successCount = this.spans.filter(s => s.status === 'ok').length;
      const errorCount = this.spans.filter(s => s.status === 'error').length;
      lines.push(
        `│  Total Spans: ${this.spans.length.toString().padEnd(6)} ✓ Success: ${successCount.toString().padEnd(4)} ✗ Errors: ${errorCount.toString().padEnd(4)} Duration: ${this.formatDuration(totalDuration).padEnd(10)}│`
      );
      lines.push('└─────────────────────────────────────────────────────────────────────────────┘');
      lines.push('');

      // Render tree with proper nesting
      lines.push('Execution Tree:');
      lines.push('───────────────');
      for (let i = 0; i < this.rootSpans.length; i++) {
        const root = this.rootSpans[i];
        const isLast = i === this.rootSpans.length - 1;
        this.renderSpan(root, '', isLast, lines);
      }

      // Legend
      lines.push('');
      lines.push('───────────────────────────────────────────────────────────────────────────────');
      lines.push('Legend: ✓ = success  ✗ = error  ↳ IN/OUT/ERR = inputs/outputs/errors');
      lines.push('Use Shift+Tab to switch tabs, scroll with mouse/arrows');
    }

    // Clear and set new content
    this.contentBox.setContent(lines.join('\n'));
    this.contentBox.screen?.render();
  }

  private renderSpan(span: DisplaySpan, prefix: string, isLast: boolean, lines: string[]): void {
    // Status icon with color indicator
    const icon = span.status === 'error' ? '✗' : '✓';
    const statusIndicator = span.status === 'error' ? '[ERR]' : '[OK] ';

    // Tree branch characters
    const branch = isLast ? '└── ' : '├── ';
    const childPrefix = prefix + (isLast ? '    ' : '│   ');
    const detailPrefix = childPrefix + '    ';

    // Format name (truncate if too long)
    let name = span.name;
    if (span.checkId && span.name !== span.checkId) {
      name = `${span.checkId}`;
      if (span.checkType) {
        name += ` (${span.checkType})`;
      }
    }
    if (name.length > 50) {
      name = name.substring(0, 47) + '...';
    }

    // Format duration
    const duration = this.formatDuration(span.duration);

    // Build the main line
    const line = `${prefix}${branch}${icon} ${name.padEnd(52)} ${statusIndicator} ${duration}`;
    lines.push(line);

    // Show input if available
    if (span.input) {
      lines.push(`${detailPrefix}↳ IN:  ${span.input}`);
    }

    // Show output if available
    if (span.output) {
      lines.push(`${detailPrefix}↳ OUT: ${span.output}`);
    }

    // Show error if available
    if (span.error) {
      lines.push(`${detailPrefix}↳ ERR: ${span.error}`);
    }

    // Render children
    for (let i = 0; i < span.children.length; i++) {
      const child = span.children[i];
      const isChildLast = i === span.children.length - 1;
      this.renderSpan(child, childPrefix, isChildLast, lines);
    }
  }

  private formatDuration(ms: number): string {
    if (ms < 1) {
      return '<1ms';
    } else if (ms < 1000) {
      return `${Math.round(ms)}ms`;
    } else if (ms < 60000) {
      return `${(ms / 1000).toFixed(2)}s`;
    } else {
      const mins = Math.floor(ms / 60000);
      const secs = ((ms % 60000) / 1000).toFixed(1);
      return `${mins}m ${secs}s`;
    }
  }

  private calculateTotalDuration(): number {
    if (this.spans.length === 0) return 0;

    let minStart = Infinity;
    let maxEnd = 0;

    for (const span of this.spans) {
      if (span.startTime < minStart) minStart = span.startTime;
      if (span.endTime > maxEnd) maxEnd = span.endTime;
    }

    return maxEnd - minStart;
  }

  focus(): void {
    this.contentBox.focus();
  }

  destroy(): void {
    this.stopWatching();
    this.container.destroy();
  }
}
