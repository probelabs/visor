/**
 * State Machine Runner - Core orchestration
 *
 * Implements the main event loop that drives state transitions.
 * Supports OTEL telemetry and debug visualizer event streaming (M4).
 */
import type { EngineContext, RunState, EngineEvent } from '../types/engine';
import type { ExecutionResult } from '../types/execution';
import type { DebugVisualizerServer } from '../debug-visualizer/ws-server';
/**
 * Main state machine runner
 */
export declare class StateMachineRunner {
    private context;
    private state;
    private debugServer?;
    private hasRun;
    constructor(context: EngineContext, debugServer?: DebugVisualizerServer);
    /**
     * Initialize the run state
     */
    private initializeState;
    /**
     * Execute the state machine
     */
    run(): Promise<ExecutionResult>;
    /**
     * Execute a specific state handler
     * M4: Wraps each state execution in an OTEL span for observability
     */
    private executeState;
    /**
     * Transition to a new state
     * M4: Emits OTEL span for the transition with state metadata
     */
    private transition;
    /**
     * Emit an engine event
     * M4: Streams events to debug visualizer for time-travel debugging
     */
    private emitEvent;
    /**
     * Stream an engine event to debug visualizer (M4)
     * Converts EngineEvent to ProcessedSpan format for visualization
     */
    private streamEventToDebugServer;
    /**
     * Extract type-specific attributes from engine events
     */
    private extractEventAttributes;
    /**
     * Check if a state is terminal
     */
    private isTerminalState;
    /**
     * Build the final execution result
     */
    private buildExecutionResult;
    /**
     * Aggregate results from journal into GroupedCheckResults format
     * This matches the format returned by the legacy engine
     */
    private aggregateResultsFromJournal;
    /**
     * Get current run state (for debugging/testing)
     */
    getState(): RunState;
    /**
     * Hydrate the runner with a previously serialized state. Must be called
     * before `run()` (i.e., when the runner has not started yet).
     */
    setState(state: RunState): void;
    /**
     * Bubble an event to parent context (nested workflows support)
     * This allows nested workflows to trigger re-runs in parent workflows
     */
    bubbleEventToParent(event: EngineEvent): void;
}
//# sourceMappingURL=runner.d.ts.map