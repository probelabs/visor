"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SessionRegistry = void 0;
/**
 * Registry to manage active ProbeAgent sessions for session reuse
 */
class SessionRegistry {
    static instance;
    sessions = new Map();
    constructor() { }
    /**
     * Get the singleton instance of SessionRegistry
     */
    static getInstance() {
        if (!SessionRegistry.instance) {
            SessionRegistry.instance = new SessionRegistry();
        }
        return SessionRegistry.instance;
    }
    /**
     * Register a ProbeAgent session
     */
    registerSession(sessionId, agent) {
        console.error(`🔄 Registering AI session: ${sessionId}`);
        this.sessions.set(sessionId, agent);
    }
    /**
     * Get an existing ProbeAgent session
     */
    getSession(sessionId) {
        const agent = this.sessions.get(sessionId);
        if (agent) {
            console.error(`♻️  Reusing AI session: ${sessionId}`);
        }
        return agent;
    }
    /**
     * Remove a session from the registry
     */
    unregisterSession(sessionId) {
        if (this.sessions.has(sessionId)) {
            console.error(`🗑️  Unregistering AI session: ${sessionId}`);
            this.sessions.delete(sessionId);
        }
    }
    /**
     * Clear all sessions (useful for cleanup)
     */
    clearAllSessions() {
        console.error(`🧹 Clearing all AI sessions (${this.sessions.size} sessions)`);
        this.sessions.clear();
    }
    /**
     * Get all active session IDs
     */
    getActiveSessionIds() {
        return Array.from(this.sessions.keys());
    }
    /**
     * Check if a session exists
     */
    hasSession(sessionId) {
        return this.sessions.has(sessionId);
    }
}
exports.SessionRegistry = SessionRegistry;
//# sourceMappingURL=session-registry.js.map