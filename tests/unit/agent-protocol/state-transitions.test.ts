import {
  assertValidTransition,
  isTerminalState,
  isValidTaskState,
  VALID_TRANSITIONS,
} from '../../../src/agent-protocol/state-transitions';
import { InvalidStateTransitionError } from '../../../src/agent-protocol/types';
import type { TaskState } from '../../../src/agent-protocol/types';

describe('state-transitions', () => {
  describe('assertValidTransition', () => {
    it('should allow all valid transitions', () => {
      for (const [from, targets] of Object.entries(VALID_TRANSITIONS)) {
        for (const to of targets) {
          expect(() => assertValidTransition(from as TaskState, to)).not.toThrow();
        }
      }
    });

    it('should reject transitions from terminal states', () => {
      const terminalStates: TaskState[] = ['completed', 'failed', 'canceled', 'rejected'];
      const nonTerminalTargets: TaskState[] = ['submitted', 'working', 'input_required'];

      for (const from of terminalStates) {
        for (const to of nonTerminalTargets) {
          expect(() => assertValidTransition(from, to)).toThrow(InvalidStateTransitionError);
        }
      }
    });

    it('should reject submitted -> completed (must go through working)', () => {
      expect(() => assertValidTransition('submitted', 'completed')).toThrow(
        InvalidStateTransitionError
      );
    });

    it('should reject submitted -> input_required', () => {
      expect(() => assertValidTransition('submitted', 'input_required')).toThrow(
        InvalidStateTransitionError
      );
    });
  });

  describe('isTerminalState', () => {
    it('should return true for terminal states', () => {
      expect(isTerminalState('completed')).toBe(true);
      expect(isTerminalState('failed')).toBe(true);
      expect(isTerminalState('canceled')).toBe(true);
      expect(isTerminalState('rejected')).toBe(true);
    });

    it('should return false for non-terminal states', () => {
      expect(isTerminalState('submitted')).toBe(false);
      expect(isTerminalState('working')).toBe(false);
      expect(isTerminalState('input_required')).toBe(false);
      expect(isTerminalState('auth_required')).toBe(false);
    });
  });

  describe('isValidTaskState', () => {
    it('should return true for valid states', () => {
      const validStates = [
        'submitted',
        'working',
        'completed',
        'failed',
        'canceled',
        'rejected',
        'input_required',
        'auth_required',
      ];
      for (const state of validStates) {
        expect(isValidTaskState(state)).toBe(true);
      }
    });

    it('should return false for invalid states', () => {
      expect(isValidTaskState('pending')).toBe(false);
      expect(isValidTaskState('running')).toBe(false);
      expect(isValidTaskState('')).toBe(false);
    });
  });
});
