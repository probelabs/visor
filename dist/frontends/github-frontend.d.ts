import type { Frontend, FrontendContext } from './host';
/**
 * Skeleton GitHub frontend.
 * - Subscribes to engine events via EventBus when present
 * - Maps key events to debug logs for now (no side effects)
 * - Real implementation will upsert checks and manage grouped PR comments
 */
export declare class GitHubFrontend implements Frontend {
    readonly name = "github";
    private subs;
    private checkRunIds;
    private revision;
    private cachedCommentId?;
    private stepStatus;
    private debounceMs;
    private maxWaitMs;
    private _timer;
    private _lastFlush;
    private _pendingIds;
    start(ctx: FrontendContext): void;
    stop(): void;
    private buildFullBody;
    private threadKeyFor;
    private renderThreadHeader;
    private renderSections;
    private updateGroupedComment;
    private mergeIntoExistingBody;
    private parseSections;
    private serializeSections;
    private extractSectionById;
    private escapeRegExp;
    /**
     * Compute failure condition results for a completed check so Check Runs map to the
     * correct GitHub conclusion. This mirrors the engine's evaluation for fail_if.
     */
    private evaluateFailureResults;
    private scheduleUpdate;
    private flushNow;
}
//# sourceMappingURL=github-frontend.d.ts.map