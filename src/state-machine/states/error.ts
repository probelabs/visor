/**
 * Error State Handler
 *
 * Responsibilities:
 * - Capture fatal errors
 * - Unwind gracefully
 * - Terminal state
 */

import type { EngineContext, RunState } from '../../types/engine';
import { logger } from '../../logger';

export async function handleError(context: EngineContext, state: RunState): Promise<void> {
  logger.error('[Error] State machine entered error state');

  // Check if there's an error in the event queue
  const errorEvent = state.eventQueue.find(e => e.type === 'Shutdown' && e.error);
  if (errorEvent && errorEvent.type === 'Shutdown' && errorEvent.error) {
    logger.error(`[Error] Fatal error: ${errorEvent.error.message}`);
    if (errorEvent.error.stack) {
      logger.error(`[Error] Stack: ${errorEvent.error.stack}`);
    }
  }

  // Log stats for debugging
  if (context.debug) {
    logger.info(`[Error] Completed ${state.completedChecks.size} checks before error`);
    logger.info(`[Error] Active dispatches: ${state.activeDispatches.size}`);
  }

  // Terminal state - no transition
}
