import {
  init_logger,
  logger
} from "./chunk-6E625R3C.mjs";
import {
  __esm,
  __export
} from "./chunk-J7LXIPZS.mjs";

// src/session-registry.ts
var session_registry_exports = {};
__export(session_registry_exports, {
  SessionRegistry: () => SessionRegistry
});
var SessionRegistry;
var init_session_registry = __esm({
  "src/session-registry.ts"() {
    init_logger();
    SessionRegistry = class _SessionRegistry {
      static instance;
      sessions = /* @__PURE__ */ new Map();
      constructor() {
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
        logger.debug(`[SessionRegistry] Registering AI session: ${sessionId}`);
        this.sessions.set(sessionId, agent);
      }
      /**
       * Get an existing ProbeAgent session
       */
      getSession(sessionId) {
        const agent = this.sessions.get(sessionId);
        if (agent) {
          logger.debug(`[SessionRegistry] Reusing AI session: ${sessionId}`);
        }
        return agent;
      }
      /**
       * Remove a session from the registry
       */
      async unregisterSession(sessionId) {
        if (this.sessions.has(sessionId)) {
          const agent = this.sessions.get(sessionId);
          this.sessions.delete(sessionId);
          if (agent && typeof agent.cleanup === "function") {
            try {
              await agent.cleanup();
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
      async clearAllSessions() {
        if (this.sessions.size === 0) {
          return;
        }
        logger.debug(`[SessionRegistry] Clearing all AI sessions (${this.sessions.size} sessions)`);
        const sessions = Array.from(this.sessions.entries());
        this.sessions.clear();
        await Promise.allSettled(
          sessions.map(async ([sessionId, agent]) => {
            if (agent && typeof agent.cleanup === "function") {
              try {
                await agent.cleanup();
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
          logger.warn(`[SessionRegistry] Cannot clone session: ${sourceSessionId} not found`);
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
              const { initializeTracer } = await import("./tracer-init-XPRWKMZT.mjs");
              const tracerResult = await initializeTracer(newSessionId, checkName);
              if (tracerResult) {
                clonedAgent.tracer = tracerResult.tracer;
                clonedAgent._telemetryConfig = tracerResult.telemetryConfig;
                clonedAgent._traceFilePath = tracerResult.filePath;
              }
            } catch (traceError) {
              logger.warn(
                `[SessionRegistry] Failed to initialize tracing for cloned session ${newSessionId}: ${traceError}`
              );
            }
          }
          if (sourceAgent._mcpInitialized && typeof clonedAgent.initialize === "function") {
            try {
              await clonedAgent.initialize();
              logger.debug(
                `[SessionRegistry] Initialized MCP tools for cloned session ${newSessionId}`
              );
            } catch (initError) {
              logger.warn(
                `[SessionRegistry] Failed to initialize cloned agent ${newSessionId}: ${initError}`
              );
            }
          }
          const historyLength = clonedAgent.history?.length || 0;
          logger.debug(
            `[SessionRegistry] Cloned session ${sourceSessionId} -> ${newSessionId} using ProbeAgent.clone() (${historyLength} messages, internal messages filtered)`
          );
          this.registerSession(newSessionId, clonedAgent);
          return clonedAgent;
        } catch (error) {
          logger.warn(`[SessionRegistry] Failed to clone session ${sourceSessionId}: ${error}`);
          return void 0;
        }
      }
    };
  }
});

export {
  SessionRegistry,
  session_registry_exports,
  init_session_registry
};
//# sourceMappingURL=chunk-77AKSSW2.mjs.map