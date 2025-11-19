/**
 * CheckRunning State Handler
 *
 * Responsibilities:
 * - Execute provider logic for a check
 * - Assemble CheckResult
 * - Transition to Routing state
 *
 * M1: This state is handled inline by LevelDispatch
 * M2: Will be a proper state when we add routing
 */

import type { EngineContext, RunState, EngineState, EngineEvent } from '../../types/engine';

export async function handleCheckRunning(
  _context: EngineContext,
  _state: RunState,
  transition: (newState: EngineState) => void,
  _emitEvent: (event: EngineEvent) => void
): Promise<void> {
  // M2: This state is not used yet - LevelDispatch handles execution inline with routing
  // The routing happens directly in LevelDispatch after check execution
  transition('WavePlanning');
}
