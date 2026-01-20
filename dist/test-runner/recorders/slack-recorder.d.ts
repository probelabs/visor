export interface SlackRecordedCall {
    provider: 'slack';
    op: string;
    args: Record<string, unknown>;
    ts: number;
}
/**
 * Minimal Slack recording client used in tests. It mimics a tiny subset of the
 * Slack Web API (`chat.postMessage`, `chat.update`) and keeps an in-memory log
 * of all invocations for assertions.
 */
export declare class RecordingSlack {
    readonly calls: SlackRecordedCall[];
    readonly chat: any;
    constructor();
}
//# sourceMappingURL=slack-recorder.d.ts.map