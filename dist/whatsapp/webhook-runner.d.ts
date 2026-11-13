import type { Runner } from '../runners/runner';
import type { VisorConfig } from '../types/config';
import { StateMachineExecutionEngine } from '../state-machine-execution-engine';
import { WhatsAppClient } from './client';
export type WhatsAppWebhookConfig = {
    accessToken?: string;
    phoneNumberId?: string;
    appSecret?: string;
    verifyToken?: string;
    apiVersion?: string;
    port?: number;
    host?: string;
    phoneAllowlist?: string[];
    workflow?: string;
};
export declare class WhatsAppWebhookRunner implements Runner {
    readonly name = "whatsapp";
    private client;
    private adapter;
    private engine;
    private cfg;
    private phoneAllowlist;
    private processedMessages;
    private server?;
    private port;
    private host;
    private taskStore?;
    private configPath?;
    private activeRequests;
    private storageCleanupStop?;
    constructor(engine: StateMachineExecutionEngine, cfg: VisorConfig, opts: WhatsAppWebhookConfig);
    /** Get the WhatsAppClient instance (for shared access) */
    getClient(): WhatsAppClient;
    /** Set shared task store for execution tracking */
    setTaskStore(store: import('../agent-protocol/task-store').TaskStore, configPath?: string): void;
    /** Hot-swap config for future requests */
    updateConfig(cfg: VisorConfig): void;
    start(): Promise<void>;
    stopListening(): Promise<void>;
    drain(timeoutMs?: number): Promise<void>;
    stop(): Promise<void>;
    /** Handle GET webhook verification */
    handleWebhookGet(query: Record<string, string>): Promise<{
        status: number;
        body: string;
    }>;
    /** Handle POST webhook messages */
    handleWebhookPost(body: string, headers: Record<string, string>): Promise<{
        status: number;
        body: string;
    }>;
    private handleMessage;
    private handleMessageInner;
    /** Ensure whatsapp frontend is in the config for this run */
    private prepareConfigForRun;
    /** Deduplication: track processed messages by message ID */
    private isDuplicate;
}
//# sourceMappingURL=webhook-runner.d.ts.map