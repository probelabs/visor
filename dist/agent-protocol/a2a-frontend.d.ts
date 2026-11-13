/**
 * A2A Frontend — serves Visor as an A2A-compliant agent.
 *
 * Implements the A2A HTTP endpoints:
 *   GET  /.well-known/agent-card.json  (public, no auth)
 *   POST /message:send                 (auth required)
 *   GET  /tasks/{id}                   (auth required)
 *   GET  /tasks                        (auth required)
 *   POST /tasks/{id}:cancel            (auth required)
 *
 * Milestone 5 adds SSE streaming and push notifications.
 */
import type { ActiveFrontend, FrontendContext } from '../frontends/host';
import type { TaskStore } from './task-store';
import type { AgentCard, AgentProtocolConfig, AgentMessage, AgentTask, AgentArtifact, TaskState } from './types';
import type { VisorConfig } from '../types/config';
export declare function messageToWorkflowInput(message: AgentMessage, task: AgentTask): Record<string, unknown>;
/** Convert engine check results to A2A artifacts (used by task queue in M4) */
export declare function resultToArtifacts(checkResults: Record<string, unknown>): AgentArtifact[];
export declare class A2AFrontend implements ActiveFrontend {
    readonly name = "a2a";
    private server;
    private taskStore;
    private agentCard;
    private config;
    private cleanupTimer;
    private _ctx;
    private streamManager;
    private pushManager;
    private _engine;
    private _visorConfig;
    private taskQueue;
    private _boundPort;
    constructor(config: AgentProtocolConfig, taskStore?: TaskStore);
    /** The actual port the server is listening on (useful when config.port is 0). */
    get boundPort(): number;
    /** Set the execution engine for running workflows. */
    setEngine(engine: any): void;
    /** Set the full Visor config (needed for check definitions). */
    setVisorConfig(config: VisorConfig): void;
    start(ctx: FrontendContext): Promise<void>;
    /**
     * Stop listening for new connections and free the port.
     * In-flight tasks continue processing.
     */
    stopListening(): Promise<void>;
    /**
     * Drain: stop accepting new tasks, wait for in-flight tasks to complete.
     * @param timeoutMs - Max wait time. 0 = unlimited (default).
     */
    drain(timeoutMs?: number): Promise<void>;
    stop(): Promise<void>;
    private handleRequest;
    private serveAgentCard;
    private handleSendMessage;
    private handleFollowUpMessage;
    private handleGetTask;
    private handleListTasks;
    private handleCancelTask;
    private handleSendStreamingMessage;
    private handleSubscribeToTask;
    private handleCreatePushConfig;
    private handleListPushConfigs;
    private handleGetPushConfig;
    private handleDeletePushConfig;
    /** Emit a task status update to SSE subscribers and push notification targets. */
    emitStatusEvent(taskId: string, contextId: string, status: {
        state: TaskState;
        message?: AgentMessage;
        timestamp: string;
    }): void;
    /** Emit an artifact update to SSE subscribers and push notification targets. */
    emitArtifactEvent(taskId: string, contextId: string, artifact: AgentArtifact, append: boolean, lastChunk: boolean): void;
    /**
     * Execute a task, either via the engine (if available) or with a stub response (for tests).
     */
    private executeTaskDirectly;
    /**
     * Execute a task through the Visor engine.
     * Creates a fresh engine execution per task and converts results to artifacts.
     */
    private executeTaskViaEngine;
    /**
     * Create a TaskExecutor callback for the TaskQueue.
     * The queue handles state transitions (submitted → working), so the executor
     * focuses on running the engine and converting results.
     */
    private createTaskExecutor;
    private checkResultToArtifact;
    private filterOutputModes;
    private startCleanupSweep;
    private stopCleanupSweep;
    getTaskStore(): TaskStore;
    getAgentCard(): AgentCard | null;
}
//# sourceMappingURL=a2a-frontend.d.ts.map