/**
 * Task state machine transitions.
 *
 * Enforces the valid state transition graph per the A2A specification.
 * Protocol-agnostic — the same states work for any agent protocol.
 */

import { TaskState, InvalidStateTransitionError } from './types';

export const VALID_TRANSITIONS: Record<TaskState, TaskState[]> = {
  submitted: ['working', 'canceled', 'rejected'],
  working: ['completed', 'failed', 'canceled', 'input_required', 'auth_required'],
  input_required: ['working', 'canceled', 'failed'],
  auth_required: ['working', 'canceled', 'failed'],
  // Terminal states: no outgoing transitions
  completed: [],
  failed: [],
  canceled: [],
  rejected: [],
};

const TERMINAL_STATES: ReadonlySet<TaskState> = new Set([
  'completed',
  'failed',
  'canceled',
  'rejected',
]);

export function assertValidTransition(from: TaskState, to: TaskState): void {
  const allowed = VALID_TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    throw new InvalidStateTransitionError(from, to);
  }
}

export function isTerminalState(state: TaskState): boolean {
  return TERMINAL_STATES.has(state);
}

export function isValidTaskState(value: string): value is TaskState {
  return value in VALID_TRANSITIONS;
}
