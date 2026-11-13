/**
 * Task state machine transitions.
 *
 * Enforces the valid state transition graph per the A2A specification.
 * Protocol-agnostic — the same states work for any agent protocol.
 */
import { TaskState } from './types';
export declare const VALID_TRANSITIONS: Record<TaskState, TaskState[]>;
export declare function assertValidTransition(from: TaskState, to: TaskState): void;
export declare function isTerminalState(state: TaskState): boolean;
export declare function isValidTaskState(value: string): value is TaskState;
//# sourceMappingURL=state-transitions.d.ts.map