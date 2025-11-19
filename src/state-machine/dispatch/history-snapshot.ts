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
      // Skip skip-stubs committed for visibility in stats
      try {
        if (entry && typeof entry.result === 'object' && (entry.result as any).__skipped) {
          continue;
        }
      } catch {}

      // Prefer explicit output; fall back to full result to preserve access to
      // fields like `issues` for code-review style checks. Filter out aggregated
      // forEach metadata objects to keep history aligned with per-item outputs
      // for consumers like reducers and post-aggregation scripts.
      const payload =
        entry.result.output !== undefined ? entry.result.output : (entry.result as unknown);
      try {
        if (
          payload &&
          typeof payload === 'object' &&
          (payload as any).forEachItems &&
          Array.isArray((payload as any).forEachItems)
        ) {
          continue;
        }
      } catch {}
      if (payload !== undefined) outputHistory.get(checkId)!.push(payload);
    }
  } catch (error) {
    logger.debug(`[LevelDispatch] Error building output history: ${error}`);
  }

  return outputHistory;
}
