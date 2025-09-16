import { ProbeAgent } from '@probelabs/probe';
/**
 * Registry to manage active ProbeAgent sessions for session reuse
 */
export declare class SessionRegistry {
    private static instance;
    private sessions;
    private constructor();
    /**
     * Get the singleton instance of SessionRegistry
     */
    static getInstance(): SessionRegistry;
    /**
     * Register a ProbeAgent session
     */
    registerSession(sessionId: string, agent: ProbeAgent): void;
    /**
     * Get an existing ProbeAgent session
     */
    getSession(sessionId: string): ProbeAgent | undefined;
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
}
//# sourceMappingURL=session-registry.d.ts.map