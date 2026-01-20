import type { VisorConfig } from '../types/config';
import { StateMachineExecutionEngine } from '../state-machine-execution-engine';
type SlackSocketConfig = {
    appToken?: string;
    endpoint?: string;
    mentions?: 'direct' | 'all';
    threads?: 'required' | 'any';
    channel_allowlist?: string[];
};
export declare class SlackSocketRunner {
    private appToken;
    private endpoint;
    private mentions;
    private threads;
    private allow;
    private ws?;
    private engine;
    private cfg;
    private client?;
    private limiter?;
    private botUserId?;
    private processedKeys;
    private adapter?;
    private retryCount;
    constructor(engine: StateMachineExecutionEngine, cfg: VisorConfig, opts: SlackSocketConfig);
    /**
     * Lazily initialize the SlackClient if not already set.
     * Called by both start() and handleMessage() to ensure the client is available.
     */
    private ensureClient;
    start(): Promise<void>;
    private openConnection;
    private connect;
    private restart;
    private send;
    private matchesAllowlist;
    private handleMessage;
    /** Lazily construct a SlackAdapter for conversation context (cache-first thread fetch) */
    private getSlackAdapter;
}
export {};
//# sourceMappingURL=socket-runner.d.ts.map