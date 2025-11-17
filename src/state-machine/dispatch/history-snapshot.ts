import type { EngineContext } from '../../types/engine';
import { logger } from '../../logger';

/**
 * Build output history Map from journal for template rendering
 * This matches the format expected by AI providers.
 * Moved from LevelDispatch to reduce file size and improve reuse.
 */
export function buildOutputHistoryFromJournal(context: EngineContext): Map<string, unknown[]> {
  const outputHistory = new Map<string, unknown[]>();

  try {
    const snapshot = context.journal.beginSnapshot();
    const allEntries = context.journal.readVisible(context.sessionId, snapshot, undefined);

    for (const entry of allEntries) {
      const checkId = entry.checkId;
      if (!outputHistory.has(checkId)) {
        outputHistory.set(checkId, []);
      }
      if (entry.result.output !== undefined) {
        outputHistory.get(checkId)!.push(entry.result.output);
      }
    }
  } catch (error) {
    logger.debug(`[LevelDispatch] Error building output history: ${error}`);
  }

  return outputHistory;
}
