import { HttpServerConfig, VisorConfig } from './types/config';
import { StateMachineExecutionEngine } from './state-machine-execution-engine';
export interface WebhookPayload {
    endpoint: string;
    headers: Record<string, string>;
    body: unknown;
    timestamp: string;
}
export interface WebhookContext {
    webhookData: Map<string, unknown>;
}
/**
 * HTTP/HTTPS server for receiving webhook requests
 */
export declare class WebhookServer {
    private server?;
    private config;
    private liquid;
    private webhookData;
    private executionEngine?;
    private visorConfig?;
    private isGitHubActions;
    constructor(config: HttpServerConfig, visorConfig?: VisorConfig);
    /**
     * Set the execution engine for triggering checks on webhook receipt
     */
    setExecutionEngine(engine: StateMachineExecutionEngine): void;
    /**
     * Start the HTTP server
     */
    start(): Promise<void>;
    /**
     * Load TLS options from configuration
     */
    private loadTlsOptions;
    /**
     * Stop the HTTP server
     */
    stop(): Promise<void>;
    /**
     * Handle incoming HTTP requests
     */
    private handleRequest;
    /**
     * Authenticate incoming request
     */
    private authenticateRequest;
    /**
     * Verify HMAC-SHA256 signature
     */
    private verifyHmacSignature;
    /**
     * Timing-safe string comparison to prevent timing attacks
     */
    private timingSafeEqual;
    /**
     * Parse request body with size limits to prevent DoS attacks
     */
    private parseRequestBody;
    /**
     * Find endpoint configuration
     */
    private findEndpoint;
    /**
     * Process webhook payload
     */
    private processWebhook;
    /**
     * Trigger checks that are waiting for webhook data
     */
    private triggerWebhookChecks;
    /**
     * Get stored webhook data for an endpoint
     */
    getWebhookData(endpoint: string): unknown;
    /**
     * Clear webhook data for an endpoint
     */
    clearWebhookData(endpoint: string): void;
    /**
     * Get server status
     */
    getStatus(): {
        running: boolean;
        port?: number;
        host?: string;
        endpoints?: string[];
    };
}
/**
 * Create and configure an HTTP server for webhooks
 */
export declare function createWebhookServer(config: HttpServerConfig, visorConfig?: VisorConfig, executionEngine?: StateMachineExecutionEngine): WebhookServer;
