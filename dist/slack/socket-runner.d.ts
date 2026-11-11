import type { Runner } from '../runners/runner';
import type { VisorConfig } from '../types/config';
import { StateMachineExecutionEngine } from '../state-machine-execution-engine';
import { Scheduler } from '../scheduler/scheduler';
import { type Schedule } from '../scheduler/schedule-store';
import { type MessageTrigger } from '../scheduler/store/types';
type SlackSocketConfig = {
    appToken?: string;
    endpoint?: string;
    mentions?: 'direct' | 'all';
    threads?: 'required' | 'any';
    channel_allowlist?: string[];
    allowBotMessages?: boolean;
    allowGuests?: boolean;
};
export declare class SlackSocketRunner implements Runner {
    readonly name = "slack";
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
    private allowBotMessages;
    private allowGuests;
    private processedKeys;
    private userInfoCache;
    private adapter?;
    private retryCount;
    private genericScheduler?;
    private messageTriggerEvaluator?;
    private activeThreads;
    private heartbeatTimer?;
    private lastPong;
    private lastSlackEvent;
    private closing;
    private draining;
    private taskStore?;
    private configPath?;
    private staleTaskTimer?;
    private storageCleanupStop?;
    constructor(engine: StateMachineExecutionEngine, cfg: VisorConfig, opts: SlackSocketConfig);
    /** Set shared task store for execution tracking. */
    setTaskStore(store: import('../agent-protocol/task-store').TaskStore, configPath?: string): void;
    /** Hot-swap the config used for future requests (does not affect in-flight ones). */
    updateConfig(cfg: VisorConfig): void;
    /**
     * Initialize message triggers from config only (sync, used in constructor).
     * Does not include DB triggers since the store may not be initialized yet.
     */
    private initMessageTriggersFromConfig;
    /**
     * Initialize or rebuild the message trigger evaluator by merging config + DB triggers.
     */
    private initMessageTriggersAsync;
    /**
     * Lazily initialize the SlackClient if not already set.
     * Called by both start() and handleMessage() to ensure the client is available.
     */
    private ensureClient;
    start(): Promise<void>;
    private openConnection;
    private connect;
    /**
     * Close the current WebSocket connection and stop heartbeat.
     * Safe to call multiple times.
     */
    private closeWebSocket;
    /**
     * Start periodic WebSocket ping to detect dead connections.
     * If no pong is received within 60s, force a reconnect.
     */
    private startHeartbeat;
    private stopHeartbeat;
    private restart;
    private send;
    private matchesAllowlist;
    /**
     * Fetch and cache user info including guest status, email, and name.
     * Results are cached for 5 minutes to avoid excessive API calls.
     */
    private fetchUserInfo;
    /**
     * Check if user is a guest (single-channel or multi-channel guest).
     */
    private isGuestUser;
    private handleMessage;
    /**
     * Dispatch a matched message trigger as an asynchronous workflow execution.
     */
    private dispatchMessageTrigger;
    private trackThread;
    private untrackThread;
    /**
     * Send a best-effort shutdown notice to all active Slack threads.
     * Bounded by timeoutMs so we never block process exit indefinitely.
     */
    notifyActiveThreadsOfShutdown(timeoutMs?: number): Promise<void>;
    /**
     * Publish the App Home tab for the given user.
     * Shows the user's schedules, message triggers, and available workflows.
     */
    private publishAppHome;
    /**
     * Build Slack Block Kit blocks for the App Home tab.
     * Exposed as a separate method for testability.
     */
    buildHomeBlocks(userInfo: {
        realName?: string;
        name?: string;
    } | null, schedules: Schedule[], triggers: MessageTrigger[], workflows: {
        id: string;
        name: string;
        description?: string;
    }[]): unknown[];
    /**
     * Stop listening for new messages. Closes the WebSocket and stops the scheduler,
     * but does NOT wait for in-flight work to complete. Frees the connection so
     * a new process can connect to Slack immediately.
     */
    stopListening(): Promise<void>;
    /**
     * Enter drain mode: stop accepting new messages, wait for active threads to complete.
     * @param timeoutMs - Max wait time. 0 = unlimited (default).
     */
    drain(timeoutMs?: number): Promise<void>;
    /**
     * Stop the socket runner and clean up resources
     */
    stop(): Promise<void>;
    /**
     * Get the scheduler instance
     */
    getScheduler(): Scheduler | undefined;
    /** Lazily construct a SlackAdapter for conversation context (cache-first thread fetch) */
    private getSlackAdapter;
}
export {};
//# sourceMappingURL=socket-runner.d.ts.map