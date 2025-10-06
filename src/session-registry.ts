import { ProbeAgent } from '@probelabs/probe';

/**
 * Registry to manage active ProbeAgent sessions for session reuse
 */
export class SessionRegistry {
  private static instance: SessionRegistry;
  private sessions: Map<string, ProbeAgent> = new Map();
  private exitHandlerRegistered = false;

  private constructor() {
    // Register process exit handlers to cleanup sessions
    this.registerExitHandlers();
  }

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
      const agent = this.sessions.get(sessionId);
      this.sessions.delete(sessionId);

      // Cleanup the ProbeAgent instance to prevent hanging processes
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (agent && typeof (agent as any).cleanup === 'function') {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (agent as any).cleanup();
        } catch (error) {
          console.error(`⚠️  Warning: Failed to cleanup ProbeAgent: ${error}`);
        }
      }
    }
  }

  /**
   * Clear all sessions (useful for cleanup)
   */
  public clearAllSessions(): void {
    console.error(`🧹 Clearing all AI sessions (${this.sessions.size} sessions)`);

    // Cleanup each ProbeAgent instance before clearing
    for (const [, agent] of this.sessions.entries()) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (agent && typeof (agent as any).cleanup === 'function') {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (agent as any).cleanup();
        } catch {
          // Silent fail during bulk cleanup
        }
      }
    }

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

  /**
   * Register process exit handlers to cleanup sessions on exit
   */
  private registerExitHandlers(): void {
    if (this.exitHandlerRegistered) {
      return;
    }

    const cleanupAndExit = (signal: string) => {
      if (this.sessions.size > 0) {
        console.error(`\n🧹 [${signal}] Cleaning up ${this.sessions.size} active AI sessions...`);
        this.clearAllSessions();
      }
    };

    // Handle normal process exit
    process.on('exit', () => {
      if (this.sessions.size > 0) {
        console.error(`🧹 [exit] Cleaning up ${this.sessions.size} active AI sessions...`);
        // Note: async operations won't complete here, but sync cleanup methods will
        for (const [, agent] of this.sessions.entries()) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          if (agent && typeof (agent as any).cleanup === 'function') {
            try {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              (agent as any).cleanup();
            } catch {
              // Silent fail on exit
            }
          }
        }
        this.sessions.clear();
      }
    });

    // Handle SIGINT (Ctrl+C)
    process.on('SIGINT', () => {
      cleanupAndExit('SIGINT');
      process.exit(0);
    });

    // Handle SIGTERM
    process.on('SIGTERM', () => {
      cleanupAndExit('SIGTERM');
      process.exit(0);
    });

    this.exitHandlerRegistered = true;
  }
}
