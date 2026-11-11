export interface RecordedCall {
    provider: 'github';
    op: string;
    args: Record<string, unknown>;
    ts: number;
}
/**
 * Very small Recording Octokit that implements only the methods we need for
 * discovery/MVP. It records all invocations in-memory.
 */
export declare class RecordingOctokit {
    readonly calls: RecordedCall[];
    readonly rest: any;
    private readonly mode?;
    private comments;
    private nextCommentId;
    constructor(opts?: {
        errorCode?: number;
        timeoutMs?: number;
    });
    private stubResponse;
}
//# sourceMappingURL=github-recorder.d.ts.map