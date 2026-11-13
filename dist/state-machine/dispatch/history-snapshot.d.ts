import type { EngineContext } from '../../types/engine';
/**
 * Build output history Map from journal for template rendering
 * This matches the format expected by AI providers.
 * Moved from LevelDispatch to reduce file size and improve reuse.
 */
export declare function buildOutputHistoryFromJournal(context: EngineContext): Map<string, unknown[]>;
//# sourceMappingURL=history-snapshot.d.ts.map