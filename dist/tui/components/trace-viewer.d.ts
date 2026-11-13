/**
 * TraceViewer - ASCII OpenTelemetry Trace Visualization
 *
 * Renders spans as an ASCII tree with timing information.
 * Supports live updates by re-parsing the trace file.
 */
import blessed from 'blessed';
type Box = blessed.Widgets.BoxElement;
export interface TraceViewerOptions {
    parent: Box;
    traceFilePath?: string;
}
export declare class TraceViewer {
    private static readonly MAX_DISPLAY_SPANS;
    private static readonly MAX_TREE_DEPTH;
    private container;
    private contentBox;
    private traceFilePath?;
    private spans;
    private rootSpans;
    private lastFileSize;
    private watchInterval?;
    private showEngineStates;
    private destroyed;
    private loadingInProgress;
    private flatLines;
    private selectableIndices;
    private selectedPos;
    private detailMode;
    private detailSpan;
    constructor(options: TraceViewerOptions);
    setTraceFile(path: string): void;
    /**
     * Toggle visibility of engine state spans (WavePlanning, LevelDispatch, etc.)
     */
    toggleEngineStates(): void;
    /**
     * Get the current visibility setting for engine states
     */
    isShowingEngineStates(): boolean;
    startWatching(): void;
    stopWatching(): void;
    private checkForUpdates;
    private loadAndRender;
    private parseTraceFile;
    private convertSpan;
    private truncate;
    private timeToMillis;
    private buildTree;
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
    private buildLogicalTree;
    private render;
    /**
     * Render the current view (tree or detail) to the content box.
     */
    private renderContent;
    /**
     * Escape blessed tags in text to prevent unintended formatting.
     */
    private escapeBlessed;
    /**
     * Render a full detail view for a span (plain text, no truncation).
     */
    private renderDetail;
    /**
     * Format an attribute value for display.
     */
    private formatAttrValue;
    /**
     * Get filtered root spans based on current settings.
     * When showEngineStates is false, removes LevelDispatch and other state spans,
     * promoting their children (checks) to be direct children of the root.
     */
    private getFilteredRootSpans;
    /**
     * Recursively filter out engine state spans while preserving their children.
     */
    private filterEngineStates;
    private renderSpan;
    private formatDuration;
    private calculateTotalDuration;
    focus(): void;
    destroy(): void;
}
export {};
//# sourceMappingURL=trace-viewer.d.ts.map