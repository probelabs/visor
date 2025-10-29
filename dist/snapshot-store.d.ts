import type { ReviewSummary } from './reviewer';
import type { EventTrigger } from './types/config';
export type ScopePath = Array<{
    check: string;
    index: number;
}>;
export interface JournalEntry {
    commitId: number;
    sessionId: string;
    scope: ScopePath;
    checkId: string;
    event: EventTrigger | undefined;
    result: ReviewSummary & {
        output?: unknown;
        content?: string;
    };
}
export declare class ExecutionJournal {
    private commit;
    private entries;
    beginSnapshot(): number;
    commitEntry(entry: {
        sessionId: string;
        scope: ScopePath;
        checkId: string;
        result: ReviewSummary & {
            output?: unknown;
            content?: string;
        };
        event?: EventTrigger;
    }): JournalEntry;
    readVisible(sessionId: string, commitMax: number, event?: EventTrigger): JournalEntry[];
    size(): number;
}
export declare class ContextView {
    private journal;
    private sessionId;
    private snapshotId;
    private scope;
    private event?;
    constructor(journal: ExecutionJournal, sessionId: string, snapshotId: number, scope: ScopePath, event?: EventTrigger | undefined);
    /** Return the nearest result for a check in this scope (exact item → ancestor → latest). */
    get(checkId: string): (ReviewSummary & {
        output?: unknown;
        content?: string;
    }) | undefined;
    /** Return an aggregate (raw) result – the shallowest scope for this check. */
    getRaw(checkId: string): (ReviewSummary & {
        output?: unknown;
        content?: string;
    }) | undefined;
    /** All results for a check up to this snapshot. */
    getHistory(checkId: string): Array<ReviewSummary & {
        output?: unknown;
        content?: string;
    }>;
    private sameScope;
    private ancestorDistance;
}
