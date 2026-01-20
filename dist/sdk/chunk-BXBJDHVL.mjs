import {
  __esm,
  __export
} from "./chunk-WMJKH4XE.mjs";

// src/session-registry.ts
var session_registry_exports = {};
__export(session_registry_exports, {
  SessionRegistry: () => SessionRegistry
});
var SessionRegistry;
var init_session_registry = __esm({
  "src/session-registry.ts"() {
    SessionRegistry = class _SessionRegistry {
      static instance;
      sessions = /* @__PURE__ */ new Map();
      exitHandlerRegistered = false;
      constructor() {
        this.registerExitHandlers();
      }
      /**
       * Get the singleton instance of SessionRegistry
       */
      static getInstance() {
        if (!_SessionRegistry.instance) {
          _SessionRegistry.instance = new _SessionRegistry();
        }
        return _SessionRegistry.instance;
      }
      /**
       * Register a ProbeAgent session
       */
      registerSession(sessionId, agent) {
        console.error(`\u{1F504} Registering AI session: ${sessionId}`);
        this.sessions.set(sessionId, agent);
      }
      /**
       * Get an existing ProbeAgent session
       */
      getSession(sessionId) {
        const agent = this.sessions.get(sessionId);
        if (agent) {
          console.error(`\u267B\uFE0F  Reusing AI session: ${sessionId}`);
        }
        return agent;
      }
      /**
       * Remove a session from the registry
       */
      unregisterSession(sessionId) {
        if (this.sessions.has(sessionId)) {
          console.error(`\u{1F5D1}\uFE0F  Unregistering AI session: ${sessionId}`);
          const agent = this.sessions.get(sessionId);
          this.sessions.delete(sessionId);
          if (agent && typeof agent.cleanup === "function") {
            try {
              agent.cleanup();
            } catch (error) {
              console.error(`\u26A0\uFE0F  Warning: Failed to cleanup ProbeAgent: ${error}`);
            }
          }
        }
      }
      /**
       * Clear all sessions (useful for cleanup)
       */
      clearAllSessions() {
        console.error(`\u{1F9F9} Clearing all AI sessions (${this.sessions.size} sessions)`);
        for (const [, agent] of this.sessions.entries()) {
          if (agent && typeof agent.cleanup === "function") {
            try {
              agent.cleanup();
            } catch {
            }
          }
        }
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
      /**
       * Clone a session with a new session ID using ProbeAgent's official clone() method
       * This uses ProbeAgent's built-in cloning which automatically handles:
       * - Intelligent filtering of internal messages (schema reminders, tool prompts, etc.)
       * - Preserving system message for cache efficiency
       * - Deep copying conversation history
       * - Copying agent configuration
       */
      async cloneSession(sourceSessionId, newSessionId, checkName) {
        const sourceAgent = this.sessions.get(sourceSessionId);
        if (!sourceAgent) {
          console.error(`\u26A0\uFE0F  Cannot clone session: ${sourceSessionId} not found`);
          return void 0;
        }
        try {
          const clonedAgent = sourceAgent.clone({
            sessionId: newSessionId,
            stripInternalMessages: true,
            // Remove schema reminders, tool prompts, etc.
            keepSystemMessage: true,
            // Keep for cache efficiency
            deepCopy: true
            // Safe deep copy of history
          });
          if (sourceAgent.debug && checkName) {
            try {
              const { initializeTracer } = await import("./tracer-init-7YGQVQ2P.mjs");
              const tracerResult = await initializeTracer(newSessionId, checkName);
              if (tracerResult) {
                clonedAgent.tracer = tracerResult.tracer;
                clonedAgent._telemetryConfig = tracerResult.telemetryConfig;
                clonedAgent._traceFilePath = tracerResult.filePath;
              }
            } catch (traceError) {
              console.error(
                "\u26A0\uFE0F  Warning: Failed to initialize tracing for cloned session:",
                traceError
              );
            }
          }
          if (sourceAgent._mcpInitialized && typeof clonedAgent.initialize === "function") {
            try {
              await clonedAgent.initialize();
              console.error(`\u{1F527} Initialized MCP tools for cloned session`);
            } catch (initError) {
              console.error(`\u26A0\uFE0F  Warning: Failed to initialize cloned agent: ${initError}`);
            }
          }
          const historyLength = clonedAgent.history?.length || 0;
          console.error(
            `\u{1F4CB} Cloned session ${sourceSessionId} \u2192 ${newSessionId} using ProbeAgent.clone() (${historyLength} messages, internal messages filtered)`
          );
          this.registerSession(newSessionId, clonedAgent);
          return clonedAgent;
        } catch (error) {
          console.error(`\u26A0\uFE0F  Failed to clone session ${sourceSessionId}:`, error);
          return void 0;
        }
      }
      /**
       * Register process exit handlers to cleanup sessions on exit
       */
      registerExitHandlers() {
        if (this.exitHandlerRegistered) {
          return;
        }
        const cleanupAndExit = (signal) => {
          if (this.sessions.size > 0) {
            console.error(`
\u{1F9F9} [${signal}] Cleaning up ${this.sessions.size} active AI sessions...`);
            this.clearAllSessions();
          }
        };
        process.on("exit", () => {
          if (this.sessions.size > 0) {
            console.error(`\u{1F9F9} [exit] Cleaning up ${this.sessions.size} active AI sessions...`);
            for (const [, agent] of this.sessions.entries()) {
              if (agent && typeof agent.cleanup === "function") {
                try {
                  agent.cleanup();
                } catch {
                }
              }
            }
            this.sessions.clear();
          }
        });
        process.on("SIGINT", () => {
          cleanupAndExit("SIGINT");
          process.exit(0);
        });
        process.on("SIGTERM", () => {
          cleanupAndExit("SIGTERM");
          process.exit(0);
        });
        this.exitHandlerRegistered = true;
      }
    };
  }
});

export {
  SessionRegistry,
  session_registry_exports,
  init_session_registry
};
//# sourceMappingURL=chunk-BXBJDHVL.mjs.map