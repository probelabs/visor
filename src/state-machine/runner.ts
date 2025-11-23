/**
 * State Machine Runner - Core orchestration
 *
 * Implements the main event loop that drives state transitions.
 * Supports OTEL telemetry and debug visualizer event streaming (M4).
 */

import type {
  EngineContext,
  RunState,
  EngineEvent,
  EngineState,
  SerializedError,
} from '../types/engine';
import { v4 as uuidv4 } from 'uuid';
import type { EventEnvelope } from '../event-bus/types';
import { logger } from '../logger';
import type { ExecutionResult } from '../types/execution';
import { GroupedCheckResults } from '../reviewer';
import { withActiveSpan, addEvent as addOtelEvent } from '../telemetry/trace-helpers';
import type { DebugVisualizerServer } from '../debug-visualizer/ws-server';

// Import state handlers
import { handleInit } from './states/init';
import { handlePlanReady } from './states/plan-ready';
import { handleWavePlanning } from './states/wave-planning';
import { handleLevelDispatch } from './states/level-dispatch';
import { handleCheckRunning } from './states/check-running';
import { handleCompleted } from './states/completed';
import { handleError } from './states/error';

/**
 * Main state machine runner
 */
export class StateMachineRunner {
  private context: EngineContext;
  private state: RunState;
  private debugServer?: DebugVisualizerServer;
  private hasRun = false;

  constructor(context: EngineContext, debugServer?: DebugVisualizerServer) {
    this.context = context;
    this.state = this.initializeState();
    this.debugServer = debugServer;
  }

  /**
   * Initialize the run state
   */
  private initializeState(): RunState {
    // Pull defaults from config where available
    const DEFAULT_MAX_WORKFLOW_DEPTH = 3;
    const configuredMaxDepth =
      (this.context && this.context.config && this.context.config.limits
        ? this.context.config.limits.max_workflow_depth
        : undefined) ?? DEFAULT_MAX_WORKFLOW_DEPTH;
    return {
      currentState: 'Init',
      wave: 0,
      levelQueue: [],
      eventQueue: [],
      activeDispatches: new Map(),
      completedChecks: new Set(),
      flags: {
        failFastTriggered: false,
        forwardRunRequested: false,
        // Maximum nesting depth for nested workflows (configurable)
        maxWorkflowDepth: configuredMaxDepth,
        currentWorkflowDepth: 0, // Start at root level
      },
      stats: new Map(),
      historyLog: [],
      forwardRunGuards: new Set(),
      currentLevelChecks: new Set(),
      routingLoopCount: 0,
      pendingRunScopes: new Map(),
    };
  }

  /**
   * Execute the state machine
   */
  async run(): Promise<ExecutionResult> {
    this.hasRun = true;
    try {
      // Emit initial state transition event
      this.emitEvent({ type: 'StateTransition', from: 'Init', to: 'Init' });

      // Main event loop
      while (!this.isTerminalState(this.state.currentState)) {
        const currentState = this.state.currentState;

        if (this.context.debug) {
          logger.info(`[StateMachine] State: ${currentState}, Wave: ${this.state.wave}`);
        }

        // Execute current state handler
        await this.executeState(currentState);

        // Check for errors
        if (this.state.currentState === 'Error') {
          break;
        }
      }

      // Return final results
      return this.buildExecutionResult();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`[StateMachine] Fatal error: ${errorMsg}`);
      const serializedError: SerializedError = {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        name: error instanceof Error ? error.name : undefined,
      };
      this.emitEvent({ type: 'Shutdown', error: serializedError });
      throw error;
    }
  }

  /**
   * Execute a specific state handler
   * M4: Wraps each state execution in an OTEL span for observability
   */
  private async executeState(state: EngineState): Promise<void> {
    // M4: Wrap state execution in OTEL span
    return withActiveSpan(
      `engine.state.${state.toLowerCase()}`,
      {
        state: state,
        engine_mode: this.context.mode,
        wave: this.state.wave,
        session_id: this.context.sessionId,
      },
      async () => {
        try {
          switch (state) {
            case 'Init':
              await handleInit(this.context, this.state, this.transition.bind(this));
              break;
            case 'PlanReady':
              await handlePlanReady(this.context, this.state, this.transition.bind(this));
              break;
            case 'WavePlanning':
              await handleWavePlanning(this.context, this.state, this.transition.bind(this));
              break;
            case 'LevelDispatch':
              await handleLevelDispatch(
                this.context,
                this.state,
                this.transition.bind(this),
                this.emitEvent.bind(this)
              );
              break;
            case 'CheckRunning':
              await handleCheckRunning(
                this.context,
                this.state,
                this.transition.bind(this),
                this.emitEvent.bind(this)
              );
              break;
            case 'Routing':
              // Routing is handled inline by CheckRunning for now
              throw new Error('Routing state should be handled by CheckRunning');
            case 'Completed':
              await handleCompleted(this.context, this.state);
              break;
            case 'Error':
              await handleError(this.context, this.state);
              break;
            default:
              throw new Error(`Unknown state: ${state}`);
          }
        } catch (error) {
          const errorMsg = error instanceof Error ? error.message : String(error);
          logger.error(`[StateMachine] Error in state ${state}: ${errorMsg}`);
          const serializedError: SerializedError = {
            message: error instanceof Error ? error.message : String(error),
            stack: error instanceof Error ? error.stack : undefined,
            name: error instanceof Error ? error.name : undefined,
          };
          this.emitEvent({ type: 'Shutdown', error: serializedError });
          this.state.currentState = 'Error';
          throw error; // Re-throw to trigger span error recording
        }
      }
    );
  }

  /**
   * Transition to a new state
   * M4: Emits OTEL span for the transition with state metadata
   */
  private transition(newState: EngineState): void {
    const oldState = this.state.currentState;
    this.state.currentState = newState;

    // Emit state transition event
    const transitionEvent = { type: 'StateTransition' as const, from: oldState, to: newState };
    this.emitEvent(transitionEvent);

    // M4: Emit OTEL event for state transition
    try {
      addOtelEvent('engine.state_transition', {
        state_from: oldState,
        state_to: newState,
        engine_mode: this.context.mode,
        wave: this.state.wave,
        session_id: this.context.sessionId,
      });
    } catch (_err) {
      // Ignore telemetry errors
    }

    if (this.context.debug) {
      logger.info(`[StateMachine] Transition: ${oldState} -> ${newState}`);
    }
  }

  /**
   * Emit an engine event
   * M4: Streams events to debug visualizer for time-travel debugging
   */
  private emitEvent(event: EngineEvent): void {
    this.state.historyLog.push(event);

    // Queue events that require processing by WavePlanning
    if (event.type === 'ForwardRunRequested' || event.type === 'WaveRetry') {
      this.state.eventQueue.push(event);
    }

    // M4: Stream event to debug visualizer for live monitoring
    if (this.debugServer) {
      try {
        this.streamEventToDebugServer(event);
      } catch (_err) {
        // Ignore debug server errors
      }
    }

    // Optional: publish to event bus if present in context (no-ops otherwise)
    try {
      const bus: any = (this.context as any).eventBus;
      if (bus && typeof bus.emit === 'function') {
        const envelope: EventEnvelope<EngineEvent> = {
          id: uuidv4(),
          version: 1,
          timestamp: new Date().toISOString(),
          runId: this.context.sessionId,
          workflowId: (this.context as any).workflowId,
          wave: this.state.wave,
          payload: event,
        };
        void bus.emit(envelope);
      }
    } catch {}

    if (this.context.debug && event.type !== 'StateTransition') {
      logger.debug(`[StateMachine] Event: ${event.type}`);
    }
  }

  /**
   * Stream an engine event to debug visualizer (M4)
   * Converts EngineEvent to ProcessedSpan format for visualization
   */
  private streamEventToDebugServer(event: EngineEvent): void {
    if (!this.debugServer) return;

    // Convert EngineEvent to a ProcessedSpan-like structure
    const timestamp = process.hrtime();
    const span = {
      traceId: this.context.sessionId,
      spanId: `${event.type}-${Date.now()}`,
      name: `engine.event.${event.type.toLowerCase()}`,
      startTime: timestamp,
      endTime: timestamp,
      duration: 0,
      attributes: {
        event_type: event.type,
        engine_mode: this.context.mode,
        wave: this.state.wave,
        session_id: this.context.sessionId,
        ...this.extractEventAttributes(event),
      },
      events: [],
      status: 'ok' as const,
    };

    this.debugServer.emitSpan(span);
  }

  /**
   * Extract type-specific attributes from engine events
   */
  private extractEventAttributes(event: EngineEvent): Record<string, any> {
    switch (event.type) {
      case 'StateTransition':
        return { state_from: event.from, state_to: event.to };
      case 'CheckScheduled':
      case 'CheckCompleted':
      case 'CheckErrored':
        return {
          check_id: event.checkId,
          scope: event.scope?.join('.') || '',
        };
      case 'ForwardRunRequested':
        return {
          target: event.target,
          goto_event: event.gotoEvent,
          scope: event.scope?.join('.') || '',
        };
      case 'WaveRetry':
        return { reason: event.reason };
      case 'Shutdown':
        return {
          error: event.error?.message,
        };
      default:
        return {};
    }
  }

  /**
   * Check if a state is terminal
   */
  private isTerminalState(state: EngineState): boolean {
    return state === 'Completed' || state === 'Error';
  }

  /**
   * Build the final execution result
   */
  private buildExecutionResult(): ExecutionResult {
    const stats = Array.from(this.state.stats.values());
    // Surface execution errors first for clearer reporting and to satisfy
    // tests that read the first entry for error messages.
    stats.sort((a, b) => (b.errorMessage ? 1 : 0) - (a.errorMessage ? 1 : 0));

    // Build results from completed checks by reading from journal
    const results: GroupedCheckResults = this.aggregateResultsFromJournal();

    // Aggregate total duration
    let totalDuration = 0;
    for (const stat of stats) {
      totalDuration = Math.max(totalDuration, stat.totalDuration);
    }

    // Normalize statistics: ensure successfulRuns + failedRuns == totalRuns
    // The updateStats function in level-dispatch.ts already counts all executions correctly,
    // including forEach iterations, retries, and goto re-runs. We just need to ensure consistency.
    try {
      for (const s of stats) {
        // Final clamp: ensure successfulRuns + failedRuns == totalRuns
        // Prefer to preserve failures and adjust successes accordingly.
        const sumSF = (s.successfulRuns || 0) + (s.failedRuns || 0);
        if (s.totalRuns !== undefined && sumSF !== s.totalRuns) {
          if (sumSF > s.totalRuns) {
            // Too many counted: clamp successes to fill remaining after failures
            const failures = Math.min(s.failedRuns || 0, s.totalRuns);
            s.failedRuns = failures;
            s.successfulRuns = Math.max(0, s.totalRuns - failures);
          } else {
            // Not enough counted: assume remaining were successful
            s.successfulRuns = (s.successfulRuns || 0) + (s.totalRuns - sumSF);
          }
        }
      }
    } catch {}

    // Debug: log stats breakdown for debugging
    if (this.context.debug) {
      logger.info('[StateMachine][Stats] Final statistics breakdown:');
      for (const s of stats) {
        logger.info(
          `  ${s.checkName}: totalRuns=${s.totalRuns}, successful=${s.successfulRuns}, failed=${s.failedRuns}`
        );
      }
      logger.info(
        `[StateMachine][Stats] Total: ${this.state.stats.size} configured, ${stats.reduce((sum, s) => sum + s.totalRuns, 0)} executions`
      );
    }

    return {
      results,
      statistics: {
        totalChecksConfigured: this.state.stats.size,
        totalExecutions: stats.reduce((sum, s) => sum + s.totalRuns, 0),
        successfulExecutions: stats.reduce((sum, s) => sum + s.successfulRuns, 0),
        failedExecutions: stats.reduce((sum, s) => sum + s.failedRuns, 0),
        skippedChecks: stats.filter(s => s.skipped).length,
        totalDuration,
        checks: stats,
      },
    };
  }

  /**
   * Aggregate results from journal into GroupedCheckResults format
   * This matches the format returned by the legacy engine
   */
  private aggregateResultsFromJournal(): GroupedCheckResults {
    const groupedResults: GroupedCheckResults = {};

    // Read all journal entries for this session
    const allEntries = this.context.journal.readVisible(
      this.context.sessionId,
      this.context.journal.beginSnapshot(),
      undefined
    );

    // Group entries by check ID to handle forEach iterations
    const checkEntries = new Map<string, typeof allEntries>();
    for (const entry of allEntries) {
      const existing = checkEntries.get(entry.checkId) || [];
      existing.push(entry);
      checkEntries.set(entry.checkId, existing);
    }

    // Process each check
    for (const [checkId, entries] of checkEntries) {
      const checkConfig = this.context.config.checks?.[checkId];

      // Special handling for system errors (validation, cycles, etc.)
      if (!checkConfig && checkId === 'system') {
        const latestEntry = entries[entries.length - 1];
        if (latestEntry && latestEntry.result.issues) {
          // Add system issues to a 'system' group
          if (!groupedResults['system']) {
            groupedResults['system'] = [];
          }
          groupedResults['system'].push({
            checkName: 'system',
            content: '',
            group: 'system',
            output: undefined,
            debug: undefined,
            issues: latestEntry.result.issues,
          });
        }
        continue;
      }

      if (!checkConfig) continue;

      // Determine group: use explicit group or fall back to check name
      const group = checkConfig.group || checkId;

      // For forEach checks, we aggregate all iterations
      // For non-forEach, we take the latest entry
      let content = '';
      let output: unknown = undefined;
      const allIssues: any[] = [];
      let debug: any = undefined;

      if (checkConfig.forEach && entries.length > 1) {
        // Aggregate all forEach iterations
        const contents: string[] = [];
        for (const entry of entries) {
          if (entry.result.content) {
            contents.push(entry.result.content);
          }
          if (entry.result.issues) {
            allIssues.push(...entry.result.issues);
          }
          if (entry.result.debug) {
            debug = entry.result.debug;
          }
          // For forEach, output is typically an array from the last iteration
          if (entry.result.output !== undefined) {
            output = entry.result.output;
          }
        }
        content = contents.join('\n');
      } else {
        // For non-forEach or single-entry forEach, take the latest entry
        const latestEntry = entries[entries.length - 1];
        if (latestEntry) {
          content = latestEntry.result.content || '';
          output = latestEntry.result.output;
          if (latestEntry.result.issues) {
            allIssues.push(...latestEntry.result.issues);
          }
          debug = latestEntry.result.debug;
        }
      }

      // Create CheckResult
      const checkResult: import('../reviewer').CheckResult = {
        checkName: checkId,
        content,
        group,
        output,
        debug,
        issues: allIssues,
      };

      // Add to appropriate group
      if (!groupedResults[group]) {
        groupedResults[group] = [];
      }
      groupedResults[group].push(checkResult);
    }

    // Apply issue suppression if enabled
    const suppressionEnabled = this.context.config.output?.suppressionEnabled ?? true;
    if (suppressionEnabled) {
      const { IssueFilter } = require('../issue-filter');
      const filter = new IssueFilter(true);

      // Filter issues in each check result
      for (const group of Object.keys(groupedResults)) {
        for (const checkResult of groupedResults[group]) {
          if (checkResult.issues && checkResult.issues.length > 0) {
            checkResult.issues = filter.filterIssues(
              checkResult.issues,
              this.context.workingDirectory
            );
          }
        }
      }
    }

    return groupedResults;
  }

  /**
   * Get current run state (for debugging/testing)
   */
  getState(): RunState {
    return this.state;
  }

  /**
   * Hydrate the runner with a previously serialized state. Must be called
   * before `run()` (i.e., when the runner has not started yet).
   */
  setState(state: RunState): void {
    if (this.hasRun) {
      throw new Error('StateMachineRunner.setState: cannot set state after run() has started');
    }
    this.state = state;
  }

  /**
   * Bubble an event to parent context (nested workflows support)
   * This allows nested workflows to trigger re-runs in parent workflows
   */
  bubbleEventToParent(event: EngineEvent): void {
    if (this.state.parentContext && this.state.parentContext.mode === 'state-machine') {
      // Emit event to parent's event queue
      if (this.context.debug) {
        logger.info(`[StateMachine] Bubbling event to parent: ${event.type}`);
      }

      // We need to access the parent runner to bubble events
      // For now, we'll store events in a queue that can be retrieved
      // The parent will poll for bubbled events after child execution
      if (!this.state.parentContext._bubbledEvents) {
        (this.state.parentContext as any)._bubbledEvents = [];
      }
      (this.state.parentContext as any)._bubbledEvents.push(event);
    }
  }
}
