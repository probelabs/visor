/**
 * Completed State Handler
 *
 * Responsibilities:
 * - Finalize stats
 * - Flush telemetry
 * - Update GitHub CheckRuns
 * - Terminal state
 */

import type { EngineContext, RunState } from '../../types/engine';
import { logger } from '../../logger';

export async function handleCompleted(context: EngineContext, state: RunState): Promise<void> {
  if (context.debug) {
    logger.info('[Completed] Execution complete');
    logger.info(`[Completed] Total waves: ${state.wave + 1}`);
    logger.info(`[Completed] Checks completed: ${state.completedChecks.size}`);
    logger.info(`[Completed] Stats collected: ${state.stats.size}`);
  }

  // Finalize GitHub checks if configured
  if (context.gitHubChecks) {
    // GitHub check finalization happens in the main engine
    if (context.debug) {
      logger.info('[Completed] GitHub checks will be finalized by main engine');
    }
  }

  // Note: This handler is currently unreachable because the main event loop
  // in runner.ts exits before executing terminal states. The idle log message
  // is emitted from runner.ts after the loop exits instead.

  // Flush telemetry
  // M4: Will add structured event streaming to debug visualizer

  // Terminal state - no transition
}
