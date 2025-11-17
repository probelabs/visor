/**
 * Init State Handler
 *
 * Responsibilities:
 * - Validate configuration
 * - Initialize services (journal, memory, GitHub checks)
 * - Transition to PlanReady
 */

import type { EngineContext, RunState, EngineState } from '../../types/engine';
import { logger } from '../../logger';

export async function handleInit(
  context: EngineContext,
  state: RunState,
  transition: (newState: EngineState) => void
): Promise<void> {
  if (context.debug) {
    logger.info('[Init] Initializing state machine...');
  }

  // Validate configuration
  if (!context.config) {
    throw new Error('Configuration is required');
  }

  // Initialize memory store if needed
  if (context.memory) {
    await context.memory.initialize();
  }

  // Initialize GitHub checks if configured
  if (context.gitHubChecks) {
    // GitHub check initialization happens in the main engine
    // We just validate it's available here
    if (context.debug) {
      logger.info('[Init] GitHub checks service available');
    }
  }

  // Reset journal for this session
  if (context.debug) {
    logger.info(`[Init] Session ID: ${context.sessionId}`);
  }

  // Transition to PlanReady
  transition('PlanReady');
}
