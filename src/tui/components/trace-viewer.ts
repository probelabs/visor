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
  foreachIndex?: number; // forEach iteration index
  wave?: number; // execution wave
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
  private showEngineStates = false; // Hidden by default
  private destroyed = false;

  constructor(options: TraceViewerOptions) {
    this.traceFilePath = options.traceFilePath;

    this.container = blessed.box({
      parent: options.parent,
      top: 0,
      left: 0,
      width: '100%',
      height: '100%-1', // Leave room for status bar
    });

    this.contentBox = blessed.log({
      parent: this.container,
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
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

  /**
   * Toggle visibility of engine state spans (WavePlanning, LevelDispatch, etc.)
   */
  toggleEngineStates(): void {
    this.showEngineStates = !this.showEngineStates;
    this.render();
  }

  /**
   * Get the current visibility setting for engine states
   */
  isShowingEngineStates(): boolean {
    return this.showEngineStates;
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
    if (!this.traceFilePath || this.destroyed) return;

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
    if (!this.traceFilePath || this.destroyed) return;

    try {
      const spans = await this.parseTraceFile(this.traceFilePath);
      this.spans = spans;
      this.buildTree();
      if (!this.destroyed) this.render();
    } catch (error) {
      if (!this.destroyed) this.contentBox.setContent(`Error loading traces: ${error}`);
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

    // Extract forEach index and wave for grouping
    const foreachIndex =
      attrs['visor.foreach.index'] !== undefined ? Number(attrs['visor.foreach.index']) : undefined;
    const wave = attrs['wave'] !== undefined ? Number(attrs['wave']) : undefined;

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
      foreachIndex,
      wave,
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
      if (span.spanId) {
        spanMap.set(span.spanId, span);
      }
    }

    // First try: Build parent-child relationships using parentSpanId
    this.rootSpans = [];
    const hasParentRelationships = this.spans.some(
      s => s.parentSpanId && spanMap.has(s.parentSpanId)
    );

    if (hasParentRelationships) {
      // Use actual parent-child relationships
      for (const span of this.spans) {
        if (!span.parentSpanId) {
          this.rootSpans.push(span);
        } else {
          const parent = spanMap.get(span.parentSpanId);
          if (parent) {
            parent.children.push(span);
          } else {
            this.rootSpans.push(span);
          }
        }
      }
    } else {
      // Build logical hierarchy from span names and check IDs
      this.buildLogicalTree();
    }

    // Sort children by start time
    const sortChildren = (span: DisplaySpan) => {
      span.children.sort((a, b) => a.startTime - b.startTime);
      span.children.forEach(sortChildren);
    };
    this.rootSpans.forEach(sortChildren);
    this.rootSpans.sort((a, b) => a.startTime - b.startTime);
  }

  /**
   * Build a logical tree when parentSpanId is not available.
   * Creates a natural execution flow:
   * - Workflow Execution (root)
   *   - LevelDispatch (wave 1)
   *     - check-1 (executed during this phase)
   *       - provider spans
   *     - check-with-foreach (parent)
   *       - [0] iteration 1
   *       - [1] iteration 2
   *   - LevelDispatch (wave 2)
   *     - check-3
   */
  private buildLogicalTree(): void {
    // Filter out marker spans (no spanId)
    const validSpans = this.spans.filter(s => s.spanId);

    // Find or create root span
    let rootSpan = validSpans.find(s => s.name === 'visor.run');
    if (!rootSpan) {
      // Create synthetic root
      const minStart = validSpans.reduce((min, s) => Math.min(min, s.startTime), Infinity);
      const maxEnd = validSpans.reduce((max, s) => Math.max(max, s.endTime), 0);
      rootSpan = {
        traceId: validSpans[0]?.traceId || '',
        spanId: 'synthetic-root',
        name: 'Workflow Execution',
        startTime: minStart,
        endTime: maxEnd,
        duration: maxEnd - minStart,
        status: validSpans.some(s => s.status === 'error') ? 'error' : 'ok',
        children: [],
      };
    }

    // Categorize spans
    const levelDispatchSpans: DisplaySpan[] = [];
    const otherStateSpans: DisplaySpan[] = [];
    const checkSpans: DisplaySpan[] = [];
    const providerSpans: DisplaySpan[] = [];
    const otherSpans: DisplaySpan[] = [];

    for (const span of validSpans) {
      if (span === rootSpan) continue;

      if (span.name === 'engine.state.level_dispatch') {
        levelDispatchSpans.push(span);
      } else if (span.name.startsWith('engine.state.')) {
        otherStateSpans.push(span);
      } else if (span.name.startsWith('visor.check') || span.checkId) {
        checkSpans.push(span);
      } else if (span.name.startsWith('visor.provider') || span.name === 'visor.provider') {
        providerSpans.push(span);
      } else {
        otherSpans.push(span);
      }
    }

    // Sort level dispatch spans by start time
    levelDispatchSpans.sort((a, b) => a.startTime - b.startTime);

    // Helper: check if a span falls within a time range
    const spanWithinTime = (span: DisplaySpan, start: number, end: number): boolean => {
      return span.startTime >= start && span.startTime <= end;
    };

    // Group forEach iterations by checkId
    const groupForEachIterations = (checks: DisplaySpan[]): DisplaySpan[] => {
      const byCheckId = new Map<string, DisplaySpan[]>();
      const nonForEach: DisplaySpan[] = [];

      for (const check of checks) {
        if (check.foreachIndex !== undefined && check.checkId) {
          if (!byCheckId.has(check.checkId)) {
            byCheckId.set(check.checkId, []);
          }
          byCheckId.get(check.checkId)!.push(check);
        } else {
          nonForEach.push(check);
        }
      }

      const result: DisplaySpan[] = [...nonForEach];

      // Create parent nodes for forEach groups
      for (const [checkId, iterations] of byCheckId) {
        // Sort by index
        iterations.sort((a, b) => (a.foreachIndex || 0) - (b.foreachIndex || 0));

        if (iterations.length === 1) {
          // Single iteration, just add it with index indicator
          const iter = iterations[0];
          iter.name = `[${iter.foreachIndex}] ${checkId}`;
          result.push(iter);
        } else {
          // Multiple iterations, create parent group
          const minStart = Math.min(...iterations.map(i => i.startTime));
          const maxEnd = Math.max(...iterations.map(i => i.endTime));

          const forEachParent: DisplaySpan = {
            traceId: iterations[0].traceId,
            spanId: `foreach-${checkId}`,
            name: `${checkId} (forEach)`,
            checkId: checkId,
            checkType: iterations[0].checkType,
            startTime: minStart,
            endTime: maxEnd,
            duration: maxEnd - minStart,
            status: iterations.some(i => i.status === 'error') ? 'error' : 'ok',
            children: [],
          };

          // Add iterations as children with index prefix
          for (const iter of iterations) {
            iter.name = `[${iter.foreachIndex}]`;
            forEachParent.children.push(iter);
          }

          result.push(forEachParent);
        }
      }

      return result;
    };

    // Nest checks under their LevelDispatch phase based on timing
    for (const levelSpan of levelDispatchSpans) {
      levelSpan.children = [];

      // Find checks that started during this level dispatch
      const checksInLevel = checkSpans.filter(c =>
        spanWithinTime(c, levelSpan.startTime, levelSpan.endTime)
      );

      // Group forEach iterations
      const groupedChecks = groupForEachIterations(checksInLevel);

      for (const check of groupedChecks) {
        // Find provider spans for this check (or its iterations)
        const attachProviders = (span: DisplaySpan) => {
          const providersForCheck = providerSpans.filter(
            p => p.checkId === span.checkId && spanWithinTime(p, span.startTime, span.endTime)
          );

          for (const provider of providersForCheck) {
            span.children.push(provider);
            const idx = providerSpans.indexOf(provider);
            if (idx >= 0) providerSpans.splice(idx, 1);
          }

          // Also attach to children (for forEach iterations)
          for (const child of span.children) {
            if (child.checkId) {
              attachProviders(child);
            }
          }
        };

        attachProviders(check);
        levelSpan.children.push(check);

        // Mark original spans as used
        for (const c of checksInLevel) {
          const idx = checkSpans.indexOf(c);
          if (idx >= 0) checkSpans.splice(idx, 1);
        }
      }

      rootSpan.children.push(levelSpan);
    }

    // Handle remaining checks (not in any level dispatch)
    if (checkSpans.length > 0) {
      const groupedRemaining = groupForEachIterations([...checkSpans]);

      for (const check of groupedRemaining) {
        // Find provider spans for this check
        const providersForCheck = providerSpans.filter(p => p.checkId === check.checkId);
        for (const provider of providersForCheck) {
          check.children.push(provider);
          const idx = providerSpans.indexOf(provider);
          if (idx >= 0) providerSpans.splice(idx, 1);
        }

        rootSpan.children.push(check);
      }
    }

    // Add other state spans (Init, PlanReady, etc.) as siblings to level dispatch
    for (const span of otherStateSpans) {
      rootSpan.children.push(span);
    }

    // Add remaining provider spans
    for (const span of providerSpans) {
      rootSpan.children.push(span);
    }

    // Add other spans
    for (const span of otherSpans) {
      rootSpan.children.push(span);
    }

    this.rootSpans = [rootSpan];
  }

  private render(): void {
    if (this.destroyed) return;
    const lines: string[] = [];

    // Filter spans to render based on settings
    const spansToRender = this.getFilteredRootSpans();

    // Header
    lines.push('┌─────────────────────────────────────────────────────────────────────────────┐');
    lines.push('│                         OPENTELEMETRY TRACE VIEWER                          │');
    lines.push('├─────────────────────────────────────────────────────────────────────────────┤');

    if (this.spans.length === 0) {
      lines.push('│  Waiting for trace data...                                                  │');
      lines.push('│  Traces will appear here as the workflow executes.                         │');
      lines.push('└─────────────────────────────────────────────────────────────────────────────┘');
    } else {
      // Summary with engine states toggle indicator
      const totalDuration = this.calculateTotalDuration();
      const successCount = this.spans.filter(s => s.status === 'ok').length;
      const errorCount = this.spans.filter(s => s.status === 'error').length;
      const engineLabel = this.showEngineStates ? 'Engine: ON ' : 'Engine: OFF';
      lines.push(
        `│  Spans: ${this.spans.length.toString().padEnd(4)} ✓ ${successCount.toString().padEnd(3)} ✗ ${errorCount.toString().padEnd(3)} ${this.formatDuration(totalDuration).padEnd(8)} ${engineLabel.padEnd(12)}│`
      );
      lines.push('└─────────────────────────────────────────────────────────────────────────────┘');
      lines.push('');

      // Render tree with proper nesting
      lines.push('Execution Tree:');
      lines.push('───────────────');
      for (let i = 0; i < spansToRender.length; i++) {
        const root = spansToRender[i];
        const isLast = i === spansToRender.length - 1;
        this.renderSpan(root, '', isLast, lines);
      }

      // Legend with keybinding help
      lines.push('');
      lines.push('───────────────────────────────────────────────────────────────────────────────');
      lines.push('Legend: ✓ = success  ✗ = error  ↳ IN/OUT/ERR = inputs/outputs/errors');
      lines.push('Keys: e = toggle engine states | Shift+Tab = switch tabs | scroll with arrows');
    }

    // Clear and set new content
    this.contentBox.setContent(lines.join('\n'));
    this.contentBox.screen?.render();
  }

  /**
   * Get filtered root spans based on current settings.
   * When showEngineStates is false, removes LevelDispatch and other state spans,
   * promoting their children (checks) to be direct children of the root.
   */
  private getFilteredRootSpans(): DisplaySpan[] {
    if (this.showEngineStates) {
      return this.rootSpans;
    }

    // Filter out engine states but keep their children
    const result: DisplaySpan[] = [];

    for (const root of this.rootSpans) {
      const filteredRoot = this.filterEngineStates(root);
      if (filteredRoot) {
        result.push(filteredRoot);
      }
    }

    return result;
  }

  /**
   * Recursively filter out engine state spans while preserving their children.
   */
  private filterEngineStates(span: DisplaySpan): DisplaySpan | null {
    const isEngineState = span.name.startsWith('engine.state.');

    if (isEngineState) {
      // Don't include this span, but return its children's filtered versions
      // This effectively "flattens" the engine states out
      return null;
    }

    // Not an engine state - include it but filter its children
    const filteredChildren: DisplaySpan[] = [];

    for (const child of span.children) {
      const isChildEngineState = child.name.startsWith('engine.state.');

      if (isChildEngineState) {
        // Skip this child but add its grandchildren directly
        for (const grandchild of child.children) {
          const filtered = this.filterEngineStates(grandchild);
          if (filtered) {
            filteredChildren.push(filtered);
          }
        }
      } else {
        // Not an engine state - filter recursively
        const filtered = this.filterEngineStates(child);
        if (filtered) {
          filteredChildren.push(filtered);
        }
      }
    }

    return {
      ...span,
      children: filteredChildren,
    };
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
    this.destroyed = true;
    this.stopWatching();
    this.container.destroy();
  }
}
