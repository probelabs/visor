import type { SlackClient } from '../slack/client';
import type { TaskLiveUpdateSink } from './task-live-updates';
export declare class SlackTaskLiveUpdateSink implements TaskLiveUpdateSink {
    private readonly slack;
    private readonly channel;
    private readonly threadTs;
    readonly kind = "slack";
    private messageTs?;
    /** Serialize all publish calls to prevent concurrent postMessage races */
    private publishQueue;
    /** Count consecutive chat.update failures for observability and final-message fallback decisions */
    private consecutiveUpdateFailures;
    constructor(slack: SlackClient, channel: string, threadTs: string, initialMessageTs?: string);
    start(): Promise<{
        ref?: Record<string, unknown>;
    } | null>;
    update(text: string): Promise<{
        ref?: Record<string, unknown>;
    } | null>;
    complete(text: string): Promise<{
        ref?: Record<string, unknown>;
    } | null>;
    fail(text: string): Promise<{
        ref?: Record<string, unknown>;
    } | null>;
    /**
     * Enqueue a publish call so they execute serially.
     * This prevents the race where tick() and complete() both see messageTs=undefined
     * and each call chat.postMessage, creating duplicate messages.
     */
    private enqueue;
    private publish;
}
//# sourceMappingURL=task-live-update-slack.d.ts.map