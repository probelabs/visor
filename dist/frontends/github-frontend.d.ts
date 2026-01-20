import type { Frontend, FrontendContext } from './host';
export declare class GitHubFrontend implements Frontend {
    readonly name = "github";
    private subs;
    private checkRunIds;
    private revision;
    private cachedCommentId?;
    private stepStatusByGroup;
    private debounceMs;
    private maxWaitMs;
    private _timer;
    private _lastFlush;
    private _pendingIds;
    private updateLocks;
    minUpdateDelayMs: number;
    private createdCommentGithubIds;
    start(ctx: FrontendContext): void;
    stop(): void;
    private buildFullBody;
    private threadKeyFor;
    private renderThreadHeader;
    private renderSections;
    /**
     * Acquires a mutex lock for the given group and executes the update.
     * This ensures only one comment update happens at a time per group,
     * preventing race conditions where updates overwrite each other.
     *
     * Uses a proper queue-based mutex: each new caller chains onto the previous
     * lock, ensuring strict serialization even when multiple callers wait
     * simultaneously.
     */
    private updateGroupedComment;
    /**
     * Performs the actual comment update with delay enforcement.
     */
    private performGroupedCommentUpdate;
    private deriveTriggeredBy;
    private mergeIntoExistingBody;
    private parseSections;
    private serializeSections;
    private extractSectionById;
    private escapeRegExp;
    private getGroupForCheck;
    private upsertSectionState;
    private commentIdForGroup;
    /**
     * Compute failure condition results for a completed check so Check Runs map to the
     * correct GitHub conclusion. This mirrors the engine's evaluation for fail_if.
     */
    private evaluateFailureResults;
    private scheduleUpdate;
    private flushNow;
    /**
     * Sleep utility for enforcing delays
     */
    private sleep;
}
//# sourceMappingURL=github-frontend.d.ts.map