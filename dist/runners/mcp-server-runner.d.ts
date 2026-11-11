import type { Runner } from './runner';
import type { VisorConfig } from '../types/config';
import type { TaskStore } from '../agent-protocol/task-store';
import type { StateMachineExecutionEngine } from '../state-machine-execution-engine';
export interface McpFrontendOptions {
    /** Port for HTTP transport (default: 8080). */
    port?: number;
    /** Host/bind address (default: '0.0.0.0'). */
    host?: string;
    /** Bearer token for authentication. */
    authToken?: string;
    /** Env var name containing the bearer token. */
    authTokenEnv?: string;
    /** Path to TLS certificate PEM. */
    tlsCert?: string;
    /** Path to TLS private key PEM. */
    tlsKey?: string;
    /** Tool name (default: 'send_message'). */
    toolName?: string;
    /** Tool description. */
    toolDescription?: string;
    /** Enable async job mode (start_job/get_job instead of blocking tool). */
    asyncMode?: boolean;
    /** Long poll timeout in seconds for get_job (default: 59). */
    longPollTimeout?: number;
}
/**
 * MCP Frontend Runner — exposes the Visor assistant as an MCP tool.
 *
 * Unlike the standalone `visor mcp-server` (which calls runChecks from the SDK),
 * this runner dispatches messages through the StateMachineExecutionEngine just like
 * the Slack/Telegram runners do. This means `{{ conversation.current.text }}` works,
 * the full workflow config is used, and responses flow back through the engine.
 */
export declare class McpServerRunner implements Runner {
    private engine;
    private cfg;
    private options;
    readonly name = "mcp";
    private httpServer;
    private transports;
    private taskStore?;
    private configPath?;
    private activeRequests;
    private draining;
    constructor(engine: StateMachineExecutionEngine, cfg: VisorConfig, options: McpFrontendOptions);
    start(): Promise<void>;
    /**
     * Stop listening for new connections and free the port so a new process can bind.
     * Existing in-flight requests continue processing (tracked via activeRequests).
     */
    stopListening(): Promise<void>;
    /**
     * Enter drain mode: stop accepting new connections, wait for active requests to finish.
     * @param timeoutMs - Max wait time. 0 = unlimited (default).
     */
    drain(timeoutMs?: number): Promise<void>;
    stop(): Promise<void>;
    updateConfig(cfg: VisorConfig): void;
    setTaskStore(store: TaskStore, configPath?: string): void;
    /**
     * Handle an incoming message by dispatching it through the engine,
     * following the same pattern as Slack/Telegram runners.
     */
    private handleMessage;
    /**
     * Extract a human-readable response from engine execution results.
     *
     * The result from executeChecks() has this structure:
     * {
     *   repositoryInfo, reviewSummary: { issues, history: Record<checkId, output[]> },
     *   executionStatistics: { checks: [...], groupedResults: { group: CheckResult[] } },
     *   checksExecuted: string[]
     * }
     *
     * The assistant response text is typically in:
     * 1. reviewSummary.history.<checkId>[last].text  (output history from journal)
     * 2. executionStatistics.groupedResults.<group>[].output.text (grouped check results)
     */
    private extractResponseText;
}
//# sourceMappingURL=mcp-server-runner.d.ts.map