import { ProbeAgent } from '@probelabs/probe';
import { logger } from './logger';

/**
 * Extended ProbeAgent interface that includes tracing properties
 */
interface TracedProbeAgent extends ProbeAgent {
  tracer?: any; // AppTracer removed from probe
  _telemetryConfig?: any; // TelemetryConfig removed from probe
  _traceFilePath?: string;
}

/**
 * Registry to manage active ProbeAgent sessions for session reuse
 */
export class SessionRegistry {
  private static instance: SessionRegistry;
  private sessions: Map<string, TracedProbeAgent> = new Map();

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
  public registerSession(sessionId: string, agent: TracedProbeAgent): void {
    logger.debug(`[SessionRegistry] Registering AI session: ${sessionId}`);
    this.sessions.set(sessionId, agent);
  }

  /**
   * Get an existing ProbeAgent session
   */
  public getSession(sessionId: string): TracedProbeAgent | undefined {
    const agent = this.sessions.get(sessionId);
    if (agent) {
      logger.debug(`[SessionRegistry] Reusing AI session: ${sessionId}`);
    }
    return agent;
  }

  /**
   * Remove a session from the registry
   */
  public async unregisterSession(sessionId: string): Promise<void> {
    if (this.sessions.has(sessionId)) {
      const agent = this.sessions.get(sessionId);
      this.sessions.delete(sessionId);

      // Cleanup the ProbeAgent instance to prevent hanging processes
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (agent && typeof (agent as any).cleanup === 'function') {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (agent as any).cleanup();
        } catch (error) {
          logger.warn(
            `[SessionRegistry] Failed to cleanup ProbeAgent session ${sessionId}: ${error}`
          );
        }
      }
    }
  }

  /**
   * Clear all sessions (useful for cleanup)
   */
  public async clearAllSessions(): Promise<void> {
    if (this.sessions.size === 0) {
      return;
    }

    logger.debug(`[SessionRegistry] Clearing all AI sessions (${this.sessions.size} sessions)`);

    // Cleanup each ProbeAgent instance before clearing
    const sessions = Array.from(this.sessions.entries());
    this.sessions.clear();

    await Promise.allSettled(
      sessions.map(async ([sessionId, agent]) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (agent && typeof (agent as any).cleanup === 'function') {
          try {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            await (agent as any).cleanup();
          } catch (error) {
            logger.warn(
              `[SessionRegistry] Failed to cleanup ProbeAgent session ${sessionId}: ${error}`
            );
          }
        }
      })
    );
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
   * Clone a session with a new session ID using ProbeAgent's official clone() method
   * This uses ProbeAgent's built-in cloning which automatically handles:
   * - Intelligent filtering of internal messages (schema reminders, tool prompts, etc.)
   * - Preserving system message for cache efficiency
   * - Deep copying conversation history
   * - Copying agent configuration
   */
  public async cloneSession(
    sourceSessionId: string,
    newSessionId: string,
    checkName?: string
  ): Promise<ProbeAgent | undefined> {
    const sourceAgent = this.sessions.get(sourceSessionId);
    if (!sourceAgent) {
      logger.warn(`[SessionRegistry] Cannot clone session: ${sourceSessionId} not found`);
      return undefined;
    }

    try {
      // Use ProbeAgent's official clone() method with options
      // This handles intelligent message filtering automatically
      const clonedAgent = (sourceAgent as any).clone({
        sessionId: newSessionId,
        stripInternalMessages: true, // Remove schema reminders, tool prompts, etc.
        keepSystemMessage: true, // Keep for cache efficiency
        deepCopy: true, // Safe deep copy of history
      }) as TracedProbeAgent;

      // Set up tracing for cloned session if debug mode is enabled
      if ((sourceAgent as any).debug && checkName) {
        try {
          const { initializeTracer } = await import('./utils/tracer-init');
          const tracerResult = await initializeTracer(newSessionId, checkName);
          if (tracerResult) {
            clonedAgent.tracer = tracerResult.tracer;
            // Store telemetry config and trace file path for proper shutdown
            clonedAgent._telemetryConfig = tracerResult.telemetryConfig;
            clonedAgent._traceFilePath = tracerResult.filePath;
          }
        } catch (traceError) {
          logger.warn(
            `[SessionRegistry] Failed to initialize tracing for cloned session ${newSessionId}: ${traceError}`
          );
        }
      }

      // Initialize MCP tools if the source agent had them initialized
      if (
        (sourceAgent as any)._mcpInitialized &&
        typeof (clonedAgent as any).initialize === 'function'
      ) {
        try {
          await (clonedAgent as any).initialize();
          logger.debug(
            `[SessionRegistry] Initialized MCP tools for cloned session ${newSessionId}`
          );
        } catch (initError) {
          logger.warn(
            `[SessionRegistry] Failed to initialize cloned agent ${newSessionId}: ${initError}`
          );
        }
      }

      // Get history length for logging
      const historyLength = (clonedAgent as any).history?.length || 0;

      logger.debug(
        `[SessionRegistry] Cloned session ${sourceSessionId} -> ${newSessionId} using ProbeAgent.clone() (${historyLength} messages, internal messages filtered)`
      );

      // Register the cloned session
      this.registerSession(newSessionId, clonedAgent);

      return clonedAgent;
    } catch (error) {
      logger.warn(`[SessionRegistry] Failed to clone session ${sourceSessionId}: ${error}`);
      return undefined;
    }
  }
}
