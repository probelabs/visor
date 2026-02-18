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

/**
 * Simplified span structure for display
 */
interface DisplaySpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  displayName?: string; // enriched name for AI/tool spans
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
  attributes: Record<string, unknown>; // all raw attributes
  events: Array<{ name: string; time?: number; attributes: Record<string, unknown> }>;
  children: DisplaySpan[];
}

export interface TraceViewerOptions {
  parent: Box;
  traceFilePath?: string;
}

export class TraceViewer {
  private static readonly MAX_DISPLAY_SPANS = 500;
  private static readonly MAX_TREE_DEPTH = 10;

  private container: Box;
  private contentBox: Box;
  private traceFilePath?: string;
  private spans: DisplaySpan[] = [];
  private rootSpans: DisplaySpan[] = [];
  private lastFileSize = 0;
  private watchInterval?: NodeJS.Timeout;
  private showEngineStates = false; // Hidden by default
  private destroyed = false;
  private loadingInProgress = false;

  // Interactive navigation state
  private flatLines: { text: string; span: DisplaySpan | null; selectable: boolean }[] = [];
  private selectableIndices: number[] = [];
  private selectedPos: number = 0;
  private detailMode: boolean = false;
  private detailSpan: DisplaySpan | null = null;

  constructor(options: TraceViewerOptions) {
    this.traceFilePath = options.traceFilePath;

    this.container = blessed.box({
      parent: options.parent,
      top: 0,
      left: 0,
      width: '100%',
      height: '100%-1', // Leave room for status bar
    });

    this.contentBox = blessed.box({
      parent: this.container,
      top: 0,
      left: 0,
      width: '100%',
      height: '100%',
      scrollable: true,
      alwaysScroll: true,
      mouse: true,
      keys: true,
      tags: true,
      wrap: false,
      scrollbar: {
        ch: ' ',
      },
    });

    // Key bindings for interactive navigation
    this.contentBox.key(['up', 'k'], () => {
      if (this.detailMode) return;
      if (this.selectableIndices.length === 0) return;
      if (this.selectedPos > 0) {
        this.selectedPos--;
        this.renderContent();
      }
    });

    this.contentBox.key(['down', 'j'], () => {
      if (this.detailMode) return;
      if (this.selectableIndices.length === 0) return;
      if (this.selectedPos < this.selectableIndices.length - 1) {
        this.selectedPos++;
        this.renderContent();
      }
    });

    this.contentBox.key(['enter', 'space'], () => {
      if (this.detailMode) {
        // Exit detail mode
        this.detailMode = false;
        this.detailSpan = null;
        this.renderContent();
        return;
      }
      // Enter detail mode for selected span
      if (this.selectableIndices.length === 0) return;
      const lineIdx = this.selectableIndices[this.selectedPos];
      const line = this.flatLines[lineIdx];
      if (line?.span) {
        this.detailMode = true;
        this.detailSpan = line.span;
        this.renderContent();
      }
    });

    this.contentBox.key(['escape'], () => {
      if (this.detailMode) {
        this.detailMode = false;
        this.detailSpan = null;
        this.renderContent();
      }
    });

    this.contentBox.key(['q'], () => {
      // Only handle q in detail mode to avoid conflicting with global quit
      if (this.detailMode) {
        this.detailMode = false;
        this.detailSpan = null;
        this.renderContent();
      }
    });

    // Initial content
    if (!this.traceFilePath) {
      this.contentBox.setContent(
        'Waiting for trace data...\n\nTraces will appear here once execution starts.'
      );
    }
  }

  setTraceFile(path: string): void {
    this.traceFilePath = path;
    this.lastFileSize = 0;
    this.spans = [];
    this.rootSpans = [];
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
      if (stats.size > this.lastFileSize) {
        await this.loadAndRender();
      }
    } catch {
      // File doesn't exist yet, that's okay
    }
  }

  private async loadAndRender(): Promise<void> {
    if (this.loadingInProgress || !this.traceFilePath || this.destroyed) return;
    this.loadingInProgress = true;
    try {
      const newSpans = await this.parseTraceFile(this.traceFilePath);
      this.spans.push(...newSpans);
      this.buildTree();
      if (!this.destroyed) this.render();
    } catch (error) {
      if (!this.destroyed) this.contentBox.setContent(`Error loading traces: ${error}`);
    } finally {
      this.loadingInProgress = false;
    }
  }

  private async parseTraceFile(filePath: string): Promise<DisplaySpan[]> {
    const spans: DisplaySpan[] = [];

    const fileStream = fs.createReadStream(filePath, { start: this.lastFileSize });
    const rl = readline.createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    let bytesRead = 0;
    for await (const line of rl) {
      // +1 for the newline character
      bytesRead += Buffer.byteLength(line, 'utf8') + 1;
      if (!line.trim()) continue;

      try {
        const raw = JSON.parse(line);
        const span = this.convertSpan(raw);
        spans.push(span);
      } catch {
        // Skip malformed lines
      }
    }

    this.lastFileSize += bytesRead;
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

    // Detect AI/tool child spans and build enriched display name
    const name = raw.name || 'unknown';
    let displayName: string | undefined;

    if (name === 'tool.call' || name === 'child: tool.call') {
      const toolName = attrs['tool.name'];
      if (toolName) {
        displayName = `tool.call (${toolName})`;
      }
      if (attrs['tool.params'] && !input) {
        input = `params: ${this.truncate(String(attrs['tool.params']), 80)}`;
      }
    } else if (name === 'ai.request' || name === 'child: ai.request') {
      const model = attrs['ai.model'];
      const provider = attrs['ai.provider'];
      if (model) {
        displayName = `ai.request (${model})`;
      } else if (provider) {
        displayName = `ai.request (${provider})`;
      }
      if (attrs['ai.provider'] && !input) {
        input = `provider: ${attrs['ai.provider']}`;
      }
    }

    // Convert raw events
    const events: Array<{ name: string; time?: number; attributes: Record<string, unknown> }> = [];
    if (Array.isArray(raw.events)) {
      for (const evt of raw.events) {
        events.push({
          name: evt.name || 'event',
          time: evt.time ? this.timeToMillis(evt.time) : undefined,
          attributes: evt.attributes || {},
        });
      }
    }

    return {
      traceId: raw.traceId || '',
      spanId: raw.spanId || '',
      parentSpanId: raw.parentSpanId || undefined,
      name,
      displayName,
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
      attributes: { ...attrs },
      events,
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
    // Cap spans used for tree building to prevent excessive rendering
    const displaySpans =
      this.spans.length > TraceViewer.MAX_DISPLAY_SPANS
        ? this.spans.slice(-TraceViewer.MAX_DISPLAY_SPANS)
        : this.spans;

    // Create map for quick lookup
    const spanMap = new Map<string, DisplaySpan>();
    for (const span of displaySpans) {
      span.children = []; // Reset children
      if (span.spanId) {
        spanMap.set(span.spanId, span);
      }
    }

    // First try: Build parent-child relationships using parentSpanId
    this.rootSpans = [];
    const hasParentRelationships = displaySpans.some(
      s => s.parentSpanId && spanMap.has(s.parentSpanId)
    );

    if (hasParentRelationships) {
      // Use actual parent-child relationships
      for (const span of displaySpans) {
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
        attributes: {},
        events: [],
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
            attributes: {},
            events: [],
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

    // Build flat lines from tree traversal
    this.flatLines = [];
    this.selectableIndices = [];

    // Filter spans to render based on settings
    const spansToRender = this.getFilteredRootSpans();

    // Header
    this.flatLines.push({
      text: '┌─────────────────────────────────────────────────────────────────────────────┐',
      span: null,
      selectable: false,
    });
    this.flatLines.push({
      text: '│                         OPENTELEMETRY TRACE VIEWER                          │',
      span: null,
      selectable: false,
    });
    this.flatLines.push({
      text: '├─────────────────────────────────────────────────────────────────────────────┤',
      span: null,
      selectable: false,
    });

    if (this.spans.length === 0) {
      this.flatLines.push({
        text: '│  Waiting for trace data...                                                  │',
        span: null,
        selectable: false,
      });
      this.flatLines.push({
        text: '│  Traces will appear here as the workflow executes.                         │',
        span: null,
        selectable: false,
      });
      this.flatLines.push({
        text: '└─────────────────────────────────────────────────────────────────────────────┘',
        span: null,
        selectable: false,
      });
    } else {
      // Summary with engine states toggle indicator
      const totalDuration = this.calculateTotalDuration();
      const successCount = this.spans.filter(s => s.status === 'ok').length;
      const errorCount = this.spans.filter(s => s.status === 'error').length;
      const engineLabel = this.showEngineStates ? 'Engine: ON ' : 'Engine: OFF';
      const traceId = this.spans[0]?.traceId || '';
      this.flatLines.push({
        text: `│  Spans: ${this.spans.length.toString().padEnd(4)} ✓ ${successCount.toString().padEnd(3)} ✗ ${errorCount.toString().padEnd(3)} ${this.formatDuration(totalDuration).padEnd(8)} ${engineLabel.padEnd(4)}│`,
        span: null,
        selectable: false,
      });
      if (traceId) {
        this.flatLines.push({
          text: `│  Trace: ${traceId}`,
          span: null,
          selectable: false,
        });
      }
      this.flatLines.push({
        text: '└─────────────────────────────────────────────────────────────────────────────┘',
        span: null,
        selectable: false,
      });
      this.flatLines.push({ text: '', span: null, selectable: false });

      // Render tree with proper nesting
      this.flatLines.push({ text: 'Execution Tree:', span: null, selectable: false });
      this.flatLines.push({ text: '───────────────', span: null, selectable: false });

      if (this.spans.length > TraceViewer.MAX_DISPLAY_SPANS) {
        this.flatLines.push({
          text: `  ⚠ Showing most recent ${TraceViewer.MAX_DISPLAY_SPANS} of ${this.spans.length} spans`,
          span: null,
          selectable: false,
        });
        this.flatLines.push({ text: '', span: null, selectable: false });
      }

      for (let i = 0; i < spansToRender.length; i++) {
        const root = spansToRender[i];
        const isLast = i === spansToRender.length - 1;
        this.renderSpan(root, '', isLast);
      }

      // Legend with keybinding help
      this.flatLines.push({ text: '', span: null, selectable: false });
      this.flatLines.push({
        text: '───────────────────────────────────────────────────────────────────────────────',
        span: null,
        selectable: false,
      });
      this.flatLines.push({
        text: 'Legend: ✓ = success  ✗ = error  ↳ IN/OUT/ERR = inputs/outputs/errors',
        span: null,
        selectable: false,
      });
      this.flatLines.push({
        text: 'Keys: j/k or arrows = navigate | Enter = details | e = engine states',
        span: null,
        selectable: false,
      });
    }

    // Build selectable indices
    this.selectableIndices = [];
    for (let i = 0; i < this.flatLines.length; i++) {
      if (this.flatLines[i].selectable) {
        this.selectableIndices.push(i);
      }
    }

    // Clamp selected position
    if (this.selectedPos >= this.selectableIndices.length) {
      this.selectedPos = Math.max(0, this.selectableIndices.length - 1);
    }

    this.renderContent();
  }

  /**
   * Render the current view (tree or detail) to the content box.
   */
  private renderContent(): void {
    if (this.destroyed) return;

    if (this.detailMode && this.detailSpan) {
      (this.contentBox as any).wrap = true;
      this.renderDetail(this.detailSpan);
      return;
    }

    (this.contentBox as any).wrap = false;

    // Build output with selection highlighting
    const outputLines: string[] = [];
    const selectedLineIdx = this.selectableIndices[this.selectedPos] ?? -1;

    for (let i = 0; i < this.flatLines.length; i++) {
      const fl = this.flatLines[i];
      if (i === selectedLineIdx) {
        outputLines.push(`{inverse}${this.escapeBlessed(fl.text)}{/inverse}`);
      } else {
        outputLines.push(this.escapeBlessed(fl.text));
      }
    }

    this.contentBox.setContent(outputLines.join('\n'));

    // Auto-scroll to keep selection visible
    if (selectedLineIdx >= 0) {
      const boxHeight = (this.contentBox as any).height || 20;
      const visibleHeight = typeof boxHeight === 'number' ? boxHeight : 20;
      const scrollTarget = Math.max(0, selectedLineIdx - Math.floor(visibleHeight / 2));
      (this.contentBox as any).scrollTo(scrollTarget);
    }

    this.contentBox.screen?.render();
  }

  /**
   * Escape blessed tags in text to prevent unintended formatting.
   */
  private escapeBlessed(text: string): string {
    // Blessed with tags:true interprets {word} as tags (e.g. {bold}, {red}).
    // Escape opening braces that might match known blessed tags.
    return text.replace(
      /\{(\/?)(bold|underline|blink|inverse|strike|red|green|blue|yellow|cyan|magenta|white|black|grey|gray|light-|#[0-9a-fA-F])/g,
      '\\{$1$2'
    );
  }

  /**
   * Render a full detail view for a span (plain text, no truncation).
   */
  private renderDetail(span: DisplaySpan): void {
    const lines: string[] = [];

    lines.push('Span Detail');
    lines.push('───────────');
    lines.push(`Name:      ${span.displayName || span.name}`);
    lines.push(`Span ID:   ${span.spanId}`);
    lines.push(`Trace ID:  ${span.traceId}`);
    if (span.parentSpanId) {
      lines.push(`Parent:    ${span.parentSpanId}`);
    }
    lines.push(`Duration:  ${this.formatDuration(span.duration)}`);
    lines.push(`Status:    ${span.status === 'error' ? 'ERROR' : 'OK'}`);
    if (span.checkId) {
      lines.push(`Check ID:  ${span.checkId}`);
    }
    if (span.checkType) {
      lines.push(`Type:      ${span.checkType}`);
    }

    // Attributes section
    const attrKeys = Object.keys(span.attributes);
    if (attrKeys.length > 0) {
      lines.push('');
      lines.push('Attributes');
      lines.push('──────────');
      for (const key of attrKeys) {
        const val = this.formatAttrValue(span.attributes[key]);
        lines.push(`${key} = ${val}`);
      }
    }

    // Events section
    if (span.events.length > 0) {
      lines.push('');
      lines.push('Events');
      lines.push('──────');
      for (let i = 0; i < span.events.length; i++) {
        const evt = span.events[i];
        lines.push(`[${i}] ${evt.name}`);
        const evtAttrKeys = Object.keys(evt.attributes);
        for (const key of evtAttrKeys) {
          const val = this.formatAttrValue(evt.attributes[key]);
          lines.push(`    ${key} = ${val}`);
        }
      }
    }

    lines.push('');
    lines.push('Press Enter/Escape to return to tree view');

    this.contentBox.setContent(lines.map(l => this.escapeBlessed(l)).join('\n'));
    (this.contentBox as any).scrollTo(0);
    this.contentBox.screen?.render();
  }

  /**
   * Format an attribute value for display.
   */
  private formatAttrValue(val: unknown): string {
    if (val === null || val === undefined) return 'null';
    if (typeof val === 'string') return val;
    if (typeof val === 'number' || typeof val === 'boolean') return String(val);
    try {
      return JSON.stringify(val);
    } catch {
      return String(val);
    }
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

  private renderSpan(span: DisplaySpan, prefix: string, isLast: boolean, depth = 0): void {
    if (depth > TraceViewer.MAX_TREE_DEPTH) {
      this.flatLines.push({ text: `${prefix}  ... (depth limit)`, span: null, selectable: false });
      return;
    }
    // Status icon with color indicator
    const icon = span.status === 'error' ? '✗' : '✓';
    const statusIndicator = span.status === 'error' ? '[ERR]' : '[OK] ';

    // Tree branch characters
    const branch = isLast ? '└── ' : '├── ';
    const childPrefix = prefix + (isLast ? '    ' : '│   ');
    const detailPrefix = childPrefix + '    ';

    // Format name - use enriched displayName for AI/tool spans
    let name = span.displayName || span.name;
    if (!span.displayName && span.checkId && span.name !== span.checkId) {
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

    // Build the main line (selectable)
    const line = `${prefix}${branch}${icon} ${name.padEnd(52)} ${statusIndicator} ${duration}`;
    this.flatLines.push({ text: line, span, selectable: true });

    // Show AI/tool-specific metadata for Probe child spans
    if (span.name === 'tool.call' || span.name === 'child: tool.call') {
      const toolName = span.attributes['tool.name'];
      const toolParams = span.attributes['tool.params'];
      if (toolName) {
        this.flatLines.push({
          text: `${detailPrefix}↳ tool: ${toolName}`,
          span: null,
          selectable: false,
        });
      }
      if (toolParams) {
        this.flatLines.push({
          text: `${detailPrefix}↳ params: ${this.truncate(String(toolParams), 120)}`,
          span: null,
          selectable: false,
        });
      }
      const toolResult = span.attributes['tool.result'];
      if (toolResult) {
        this.flatLines.push({
          text: `${detailPrefix}↳ result: ${this.truncate(String(toolResult), 120)}`,
          span: null,
          selectable: false,
        });
      }
    } else if (span.name === 'ai.request' || span.name === 'child: ai.request') {
      const model = span.attributes['ai.model'];
      const provider = span.attributes['ai.provider'];
      const inputTokens = span.attributes['ai.input_tokens'];
      const outputTokens = span.attributes['ai.output_tokens'];
      if (provider) {
        this.flatLines.push({
          text: `${detailPrefix}↳ provider: ${provider}`,
          span: null,
          selectable: false,
        });
      }
      if (model) {
        this.flatLines.push({
          text: `${detailPrefix}↳ model: ${model}`,
          span: null,
          selectable: false,
        });
      }
      if (inputTokens !== undefined || outputTokens !== undefined) {
        this.flatLines.push({
          text: `${detailPrefix}↳ tokens: ${inputTokens ?? '?'} in / ${outputTokens ?? '?'} out`,
          span: null,
          selectable: false,
        });
      }
    } else {
      // Generic input/output/error for non-AI/tool spans
      if (span.input) {
        this.flatLines.push({
          text: `${detailPrefix}↳ IN:  ${span.input}`,
          span: null,
          selectable: false,
        });
      }
      if (span.output) {
        this.flatLines.push({
          text: `${detailPrefix}↳ OUT: ${span.output}`,
          span: null,
          selectable: false,
        });
      }
    }

    // Show error if available (for all span types)
    if (span.error) {
      this.flatLines.push({
        text: `${detailPrefix}↳ ERR: ${span.error}`,
        span: null,
        selectable: false,
      });
    }

    // Render children
    for (let i = 0; i < span.children.length; i++) {
      const child = span.children[i];
      const isChildLast = i === span.children.length - 1;
      this.renderSpan(child, childPrefix, isChildLast, depth + 1);
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
    // Hide the terminal cursor (no text editing in trace viewer)
    const program = this.contentBox.screen?.program;
    if (program) {
      program.hideCursor();
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.stopWatching();
    this.container.destroy();
  }
}
