import type { VisorConfig, EventTrigger } from './config';
import type { DependencyGraph, ExecutionGroup } from '../dependency-resolver';
import type { ExecutionJournal, ScopePath } from '../snapshot-store';
import type { MemoryStore } from '../memory-store';
import type { GitHubCheckService } from '../github-check-service';
import type { ReviewSummary } from '../reviewer';
import type { CheckExecutionStats } from './execution';

/**
 * Engine execution modes
 */
export type EngineMode = 'legacy' | 'state-machine';

/**
 * Options for engine execution
 */
export interface EngineOptions {
  /** Execution mode (default: 'legacy') */
  mode?: EngineMode;
}

/**
 * State machine states
 */
export type EngineState =
  | 'Init'
  | 'PlanReady'
  | 'WavePlanning'
  | 'LevelDispatch'
  | 'CheckRunning'
  | 'Routing'
  | 'Completed'
  | 'Error';

/**
 * Events that drive state transitions
 */
export type EngineEvent =
  | { type: 'PlanBuilt'; graph: DependencyGraph }
  | { type: 'WaveRequested'; wave: number }
  | { type: 'LevelReady'; level: ExecutionGroup; wave: number }
  | { type: 'LevelDepleted'; level: number; wave: number }
  | { type: 'CheckScheduled'; checkId: string; scope: ScopePath }
  | {
      type: 'CheckCompleted';
      checkId: string;
      scope: ScopePath;
      result: ReviewSummary & { output?: unknown; content?: string };
    }
  | { type: 'CheckErrored'; checkId: string; scope: ScopePath; error: SerializedError }
  | {
      type: 'ForwardRunRequested';
      target: string;
      gotoEvent?: EventTrigger;
      scope?: ScopePath;
      origin?: 'run' | 'goto' | 'run_js' | 'goto_js';
    }
  | { type: 'WaveRetry'; reason: 'on_fail' | 'on_finish' | 'external' }
  | { type: 'StateTransition'; from: EngineState; to: EngineState }
  | { type: 'Shutdown'; error?: SerializedError };

/**
 * Serialized error for event passing
 */
export interface SerializedError {
  message: string;
  stack?: string;
  name?: string;
}

/**
 * Per-check dispatch record tracking execution details
 */
export interface DispatchRecord {
  id: string;
  checkId: string;
  scope: ScopePath;
  provider: string;
  startMs: number;
  attempts: number;
  foreachIndex?: number;
  sessionInfo?: {
    parent?: string;
    reuse?: boolean;
  };
}

/**
 * Check metadata stored in context
 */
export interface CheckMetadata {
  tags: string[];
  triggers: EventTrigger[];
  group?: string;
  sessionProvider?: string;
  fanout?: 'map' | 'reduce';
  providerType: string;
  dependencies: string[];
}

/**
 * Engine execution context (immutable configuration and services)
 */
export interface EngineContext {
  mode: EngineMode;
  config: VisorConfig;
  dependencyGraph?: DependencyGraph;
  checks: Record<string, CheckMetadata>;
  journal: ExecutionJournal;
  memory: MemoryStore;
  gitHubChecks?: GitHubCheckService;
  workingDirectory?: string;
  sessionId: string;
  event?: EventTrigger;
  debug?: boolean;
  maxParallelism?: number;
  failFast?: boolean;
  /** Explicit list of checks requested (if provided), used to filter which checks to execute */
  requestedChecks?: string[];
  // Support for nested workflows - events bubbled from child workflows
  _bubbledEvents?: EngineEvent[];
  /** Execution context with hooks for prompt capture, mocks, etc. */
  executionContext?: import('../providers/check-provider.interface').ExecutionContext;
  /** PR information for test fixture data and AI provider context */
  prInfo?: import('../pr-analyzer').PRInfo;
}

/**
 * Mutable runtime state for state machine execution
 */
export interface RunState {
  currentState: EngineState;
  wave: number;
  levelQueue: ExecutionGroup[];
  eventQueue: EngineEvent[];
  activeDispatches: Map<string, DispatchRecord>;
  completedChecks: Set<string>;
  flags: {
    failFastTriggered: boolean;
    forwardRunRequested: boolean;
    maxWorkflowDepth: number; // Maximum nesting depth for workflows (default 3)
    currentWorkflowDepth: number; // Current nesting depth
  };
  stats: Map<string, CheckExecutionStats>;
  historyLog: EngineEvent[];
  // Deduplication guards
  forwardRunGuards: Set<string>;
  currentLevel?: number;
  currentLevelChecks: Set<string>;
  // Optional per-check scopes for the next wave (from ForwardRunRequested events)
  pendingRunScopes?: Map<string, ScopePath[]>;
  // Parent context for nested workflows
  parentScope?: ScopePath;
  parentContext?: EngineContext;
  // Loop budget tracking for routing (on_success, on_fail, on_finish)
  routingLoopCount: number;
}

/**
 * Serialized run state for persistence
 */
export interface SerializedRunState {
  wave: number;
  levelQueue: ExecutionGroup[];
  eventQueue: EngineEvent[];
  flags: RunState['flags'];
  stats: CheckExecutionStats[];
  historyLog: EngineEvent[];
}
