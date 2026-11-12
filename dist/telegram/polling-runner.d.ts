import type { Runner } from '../runners/runner';
import type { VisorConfig } from '../types/config';
import { StateMachineExecutionEngine } from '../state-machine-execution-engine';
import { TelegramClient } from './client';
export type TelegramPollingConfig = {
    botToken?: string;
    pollingTimeout?: number;
    chatAllowlist?: (string | number)[];
    requireMention?: boolean;
    workflow?: string;
};
export declare class TelegramPollingRunner implements Runner {
    readonly name = "telegram";
    private client;
    private adapter;
    private engine;
    private cfg;
    private chatAllowlist;
    private requireMention;
    private runnerHandle?;
    private processedUpdates;
    private activeChats;
    private taskStore?;
    private configPath?;
    private storageCleanupStop?;
    constructor(engine: StateMachineExecutionEngine, cfg: VisorConfig, opts: TelegramPollingConfig);
    /** Get the TelegramClient instance (for shared access) */
    getClient(): TelegramClient;
    /** Set shared task store for execution tracking */
    setTaskStore(store: import('../agent-protocol/task-store').TaskStore, configPath?: string): void;
    /** Hot-swap config for future requests */
    updateConfig(cfg: VisorConfig): void;
    start(): Promise<void>;
    stopListening(): Promise<void>;
    drain(timeoutMs?: number): Promise<void>;
    stop(): Promise<void>;
    private handleMessage;
    /** Ensure telegram frontend is in the config for this run */
    private prepareConfigForRun;
    /** Deduplication: track processed updates by chat_id:message_id */
    private isDuplicate;
    private trackChat;
    private untrackChat;
}
//# sourceMappingURL=polling-runner.d.ts.map