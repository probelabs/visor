import { ProbeAgent } from '@probelabs/probe';
/**
 * Extended ProbeAgent interface that includes tracing properties
 */
interface TracedProbeAgent extends ProbeAgent {
    tracer?: any;
    _telemetryConfig?: any;
    _traceFilePath?: string;
}
/**
 * Registry to manage active ProbeAgent sessions for session reuse
 */
export declare class SessionRegistry {
    private static instance;
    private sessions;
    private exitHandlerRegistered;
    private constructor();
    /**
     * Get the singleton instance of SessionRegistry
     */
    static getInstance(): SessionRegistry;
    /**
     * Register a ProbeAgent session
     */
    registerSession(sessionId: string, agent: TracedProbeAgent): void;
    /**
     * Get an existing ProbeAgent session
     */
    getSession(sessionId: string): TracedProbeAgent | undefined;
    /**
     * Remove a session from the registry
     */
    unregisterSession(sessionId: string): void;
    /**
     * Clear all sessions (useful for cleanup)
     */
    clearAllSessions(): void;
    /**
     * Get all active session IDs
     */
    getActiveSessionIds(): string[];
    /**
     * Check if a session exists
     */
    hasSession(sessionId: string): boolean;
    /**
     * Clone a session with a new session ID using ProbeAgent's official clone() method
     * This uses ProbeAgent's built-in cloning which automatically handles:
     * - Intelligent filtering of internal messages (schema reminders, tool prompts, etc.)
     * - Preserving system message for cache efficiency
     * - Deep copying conversation history
     * - Copying agent configuration
     */
    cloneSession(sourceSessionId: string, newSessionId: string, checkName?: string): Promise<ProbeAgent | undefined>;
    /**
     * Register process exit handlers to cleanup sessions on exit
     */
    private registerExitHandlers;
}
export {};
