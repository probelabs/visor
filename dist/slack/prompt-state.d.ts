export interface WaitingPromptInfo {
    checkName: string;
    prompt: string;
    timestamp: number;
    channel: string;
    threadTs: string;
    promptMessageTs?: string;
    snapshotPath?: string;
    promptsPosted?: number;
    context?: Record<string, unknown>;
}
export declare class PromptStateManager {
    private waiting;
    private ttlMs;
    private timer?;
    private firstMessage;
    private summaryTs;
    constructor(ttlMs?: number);
    private key;
    setWaiting(channel: string, threadTs: string, info: Omit<WaitingPromptInfo, 'timestamp' | 'channel' | 'threadTs'>): void;
    getWaiting(channel: string, threadTs: string): WaitingPromptInfo | undefined;
    clear(channel: string, threadTs: string): boolean;
    /** Merge updates into an existing waiting entry */
    update(channel: string, threadTs: string, patch: Partial<WaitingPromptInfo>): WaitingPromptInfo | undefined;
    setFirstMessage(channel: string, threadTs: string, text: string): void;
    consumeFirstMessage(channel: string, threadTs: string): string | undefined;
    hasUnconsumedFirstMessage(channel: string, threadTs: string): boolean;
    private startCleanup;
    private cleanup;
}
export declare function getPromptStateManager(ttlMs?: number): PromptStateManager;
export declare function resetPromptStateManager(): void;
//# sourceMappingURL=prompt-state.d.ts.map