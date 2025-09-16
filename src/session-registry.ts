import { ProbeAgent } from '@probelabs/probe';

/**
 * Registry to manage active ProbeAgent sessions for session reuse
 */
export class SessionRegistry {
  private static instance: SessionRegistry;
  private sessions: Map<string, ProbeAgent> = new Map();

  private constructor() {}

  /**
   * Get the singleton instance of SessionRegistry
   */
  public static getInstance(): SessionRegistry {
    if (!SessionRegistry.instance) {
      SessionRegistry.instance = new SessionRegistry();
    }
    return SessionRegistry.instance;
  }

  /**
   * Register a ProbeAgent session
   */
  public registerSession(sessionId: string, agent: ProbeAgent): void {
    console.error(`🔄 Registering AI session: ${sessionId}`);
    this.sessions.set(sessionId, agent);
  }

  /**
   * Get an existing ProbeAgent session
   */
  public getSession(sessionId: string): ProbeAgent | undefined {
    const agent = this.sessions.get(sessionId);
    if (agent) {
      console.error(`♻️  Reusing AI session: ${sessionId}`);
    }
    return agent;
  }

  /**
   * Remove a session from the registry
   */
  public unregisterSession(sessionId: string): void {
    if (this.sessions.has(sessionId)) {
      console.error(`🗑️  Unregistering AI session: ${sessionId}`);
      this.sessions.delete(sessionId);
    }
  }

  /**
   * Clear all sessions (useful for cleanup)
   */
  public clearAllSessions(): void {
    console.error(`🧹 Clearing all AI sessions (${this.sessions.size} sessions)`);
    this.sessions.clear();
  }

  /**
   * Get all active session IDs
   */
  public getActiveSessionIds(): string[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * Check if a session exists
   */
  public hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }
}
