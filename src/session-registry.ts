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
      console.error(`⚠️  Cannot clone session: ${sourceSessionId} not found`);
      return undefined;
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sourceAgentAny = sourceAgent as any;

      // Use ProbeAgent's official clone() method with options
      // This handles intelligent message filtering automatically
      // Note: TypeScript doesn't have types for clone() yet, so we cast to any
      const clonedAgent = (sourceAgent as any).clone({
        sessionId: newSessionId,
        stripInternalMessages: true, // Remove schema reminders, tool prompts, etc.
        keepSystemMessage: true, // Keep for cache efficiency
        deepCopy: true, // Safe deep copy of history
      }) as ProbeAgent;

      // Set up tracing for cloned session if debug mode is enabled
      if (sourceAgentAny.debug && checkName) {
        try {
          // Import telemetry modules dynamically
          const probeModule = (await import('@probelabs/probe')) as any;

          if (probeModule.SimpleTelemetry && probeModule.SimpleAppTracer) {
            const SimpleTelemetry = probeModule.SimpleTelemetry;
            const SimpleAppTracer = probeModule.SimpleAppTracer;

            // Create trace file path in debug-artifacts directory
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            const traceDir = process.env.GITHUB_WORKSPACE
              ? `${process.env.GITHUB_WORKSPACE}/debug-artifacts`
              : `${process.cwd()}/debug-artifacts`;

            // Create traces directory if it doesn't exist
            const fs = require('fs');
            if (!fs.existsSync(traceDir)) {
              fs.mkdirSync(traceDir, { recursive: true });
            }

            const traceFilePath = `${traceDir}/trace-${checkName}-${timestamp}.jsonl`;

            // Initialize telemetry and tracer
            const telemetry = new SimpleTelemetry({
              serviceName: 'visor-ai-clone',
              enableFile: true,
              filePath: traceFilePath,
              enableConsole: false,
            });

            const tracer = new SimpleAppTracer(telemetry, newSessionId);
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (clonedAgent as any).tracer = tracer;
            // Store trace file path for later use
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (clonedAgent as any)._traceFilePath = traceFilePath;

            console.error(`📊 Tracing enabled for cloned session, will save to: ${traceFilePath}`);
          }
        } catch (traceError) {
          console.error(
            '⚠️  Warning: Failed to initialize tracing for cloned session:',
            traceError
          );
        }
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const clonedAgentAny = clonedAgent as any;

      // Initialize MCP tools if the source agent had them initialized
      if (sourceAgentAny._mcpInitialized && typeof clonedAgentAny.initialize === 'function') {
        try {
          await clonedAgentAny.initialize();
          console.error(`🔧 Initialized MCP tools for cloned session`);
        } catch (initError) {
          console.error(`⚠️  Warning: Failed to initialize cloned agent: ${initError}`);
        }
      }

      // Get history length for logging
      const historyLength = clonedAgentAny.history?.length || 0;

      console.error(
        `📋 Cloned session ${sourceSessionId} → ${newSessionId} using ProbeAgent.clone() (${historyLength} messages, internal messages filtered)`
      );

      // Register the cloned session
      this.registerSession(newSessionId, clonedAgent);

      return clonedAgent;
    } catch (error) {
      console.error(`⚠️  Failed to clone session ${sourceSessionId}: ${error}`);
      return undefined;
    }
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
