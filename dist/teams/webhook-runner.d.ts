import type { Runner } from '../runners/runner';
import type { VisorConfig } from '../types/config';
import { StateMachineExecutionEngine } from '../state-machine-execution-engine';
import { TeamsClient } from './client';
export type TeamsWebhookConfig = {
    appId?: string;
    appPassword?: string;
    tenantId?: string;
    port?: number;
    host?: string;
    userAllowlist?: string[];
    workflow?: string;
};
export declare class TeamsWebhookRunner implements Runner {
    readonly name = "teams";
    private client;
    private adapter;
    private engine;
    private cfg;
    private userAllowlist;
    private processedActivities;
    private server?;
    private port;
    private host;
    private taskStore?;
    private configPath?;
    private activeRequests;
    private storageCleanupStop?;
    constructor(engine: StateMachineExecutionEngine, cfg: VisorConfig, opts: TeamsWebhookConfig);
    /** Get the TeamsClient instance (for shared access) */
    getClient(): TeamsClient;
    /** Set shared task store for execution tracking */
    setTaskStore(store: import('../agent-protocol/task-store').TaskStore, configPath?: string): void;
    /** Hot-swap config for future requests */
    updateConfig(cfg: VisorConfig): void;
    start(): Promise<void>;
    stopListening(): Promise<void>;
    drain(timeoutMs?: number): Promise<void>;
    stop(): Promise<void>;
    private handleMessage;
    private handleMessageInner;
    /** Ensure teams frontend is in the config for this run */
    private prepareConfigForRun;
    /** Deduplication: track processed activities by ID */
    private isDuplicate;
}
//# sourceMappingURL=webhook-runner.d.ts.map