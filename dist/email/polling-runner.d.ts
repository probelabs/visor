import type { Runner } from '../runners/runner';
import type { VisorConfig } from '../types/config';
import { StateMachineExecutionEngine } from '../state-machine-execution-engine';
import { EmailClient } from './client';
export type EmailPollingConfig = {
    receive?: {
        type?: 'imap' | 'resend';
        host?: string;
        port?: number;
        auth?: {
            user?: string;
            pass?: string;
        };
        secure?: boolean;
        poll_interval?: number;
        folder?: string;
        mark_read?: boolean;
        api_key?: string;
        webhook_secret?: string;
    };
    send?: {
        type?: 'smtp' | 'resend';
        host?: string;
        port?: number;
        auth?: {
            user?: string;
            pass?: string;
        };
        secure?: boolean;
        from?: string;
        api_key?: string;
    };
    allowlist?: string[];
    workflow?: string;
};
export declare class EmailPollingRunner implements Runner {
    readonly name = "email";
    private client;
    private adapter;
    private engine;
    private cfg;
    private senderAllowlist;
    private pollInterval;
    private pollTimer?;
    private processedMessageIds;
    private stopped;
    private taskStore?;
    private configPath?;
    private receiveType;
    private sendConfig?;
    private resendLastSeenId?;
    private hasWebhookSecret;
    private activeProcessing;
    private storageCleanupStop?;
    constructor(engine: StateMachineExecutionEngine, cfg: VisorConfig, opts: EmailPollingConfig);
    /** Get the EmailClient instance (for shared access) */
    getClient(): EmailClient;
    /** Set shared task store for execution tracking */
    setTaskStore(store: import('../agent-protocol/task-store').TaskStore, configPath?: string): void;
    /** Hot-swap config for future requests */
    updateConfig(cfg: VisorConfig): void;
    start(): Promise<void>;
    stopListening(): Promise<void>;
    drain(timeoutMs?: number): Promise<void>;
    stop(): Promise<void>;
    private startImapPolling;
    private pollOnce;
    private startResendPolling;
    private pollResendOnce;
    /**
     * Handle inbound Resend webhook event.
     * Call this from your HTTP server when POST /webhooks/email/resend arrives.
     */
    handleResendWebhook(body: string, headers: Record<string, string>): Promise<{
        ok: boolean;
        error?: string;
    }>;
    private handleMessage;
    private handleMessageInner;
    /** Ensure email frontend is in the config for this run */
    private prepareConfigForRun;
    /** Deduplication: track processed messages by Message-ID */
    private isDuplicate;
    /** Clean up old dedup entries */
    private cleanupDedup;
}
//# sourceMappingURL=polling-runner.d.ts.map