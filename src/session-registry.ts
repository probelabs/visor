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
   * Clone a session with a new session ID
   * Creates a new ProbeAgent with a copy of the conversation history
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
      // Access the conversation history from the source agent
      // ProbeAgent stores history in the 'history' property (not 'conversationHistory')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sourceHistory = (sourceAgent as any).history || [];

      // Extract all important configuration properties from the source agent
      // ProbeAgent stores these as instance properties, not in an options object
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sourceAgentAny = sourceAgent as any;
      const cloneOptions = {
        sessionId: newSessionId,
        debug: sourceAgentAny.debug || false,
        allowEdit: sourceAgentAny.allowEdit || false,
        path: sourceAgentAny.allowedFolders?.[0], // Use first allowed folder as path
        allowedFolders: sourceAgentAny.allowedFolders, // Copy all allowed folders
        provider: sourceAgentAny.clientApiProvider,
        model: sourceAgentAny.model,
        promptType: sourceAgentAny.promptType,
        customPrompt: sourceAgentAny.customPrompt, // Preserve custom prompt
        enableMcp: sourceAgentAny.enableMcp,
        mcpConfig: sourceAgentAny.mcpConfig,
        mcpConfigPath: sourceAgentAny.mcpConfigPath, // Preserve MCP config path
        mcpServers: sourceAgentAny.mcpServers, // Preserve MCP servers
        // Don't preserve tracer - each clone needs its own trace file
        // tracer: sourceAgentAny.tracer,
        outline: sourceAgentAny.outline, // Preserve outline setting
        maxResponseTokens: sourceAgentAny.maxResponseTokens, // Preserve token limits
        maxIterations: sourceAgentAny.maxIterations, // Preserve iteration limits
        disableMermaidValidation: sourceAgentAny.disableMermaidValidation, // Preserve validation settings
        storageAdapter: sourceAgentAny.storageAdapter, // Preserve storage adapter
        enableBash: sourceAgentAny.enableBash, // Preserve bash settings
        bashConfig: sourceAgentAny.bashConfig, // Preserve bash config
      };

      // Import ProbeAgent dynamically to create new instance
      const { ProbeAgent: ProbeAgentClass } = await import('@probelabs/probe');

      const clonedAgent = new ProbeAgentClass(cloneOptions);

      // Create a new tracer for the cloned session if debug mode is enabled
      if (cloneOptions.debug && checkName) {
        try {
          // Import telemetry modules dynamically
          const probeModule = await import('@probelabs/probe') as any;

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
          console.error('⚠️  Warning: Failed to initialize tracing for cloned session:', traceError);
        }
      }

      // Initialize the cloned agent if the source agent was initialized (MCP tools, etc.)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      if (sourceAgentAny._mcpInitialized && typeof (clonedAgent as any).initialize === 'function') {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await (clonedAgent as any).initialize();
          console.error(`🔧 Initialized MCP tools for cloned session`);
        } catch (initError) {
          console.error(`⚠️  Warning: Failed to initialize cloned agent: ${initError}`);
          // Continue even if initialization fails - basic functionality should still work
        }
      }

      // Copy runtime state that might not be in the constructor options
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const clonedAgentAny = clonedAgent as any;

      // Copy token counter state if it exists
      if (sourceAgentAny.tokenCounter) {
        try {
          // Copy token usage data to maintain cost tracking
          clonedAgentAny.tokenCounter.totalPromptTokens =
            sourceAgentAny.tokenCounter.totalPromptTokens || 0;
          clonedAgentAny.tokenCounter.totalCompletionTokens =
            sourceAgentAny.tokenCounter.totalCompletionTokens || 0;
          clonedAgentAny.tokenCounter.contextSize = sourceAgentAny.tokenCounter.contextSize || 0;
        } catch {
          // Ignore if token counter structure is different
        }
      }

      // Preserve any runtime flags that might have been set
      clonedAgentAny.cancelled = false; // Reset cancelled state for new session
      clonedAgentAny._schemaFormatted = false; // Reset schema formatting flag

      console.error(
        `📋 Cloning session with config: debug=${cloneOptions.debug}, model=${cloneOptions.model}, provider=${cloneOptions.provider}, mcpEnabled=${cloneOptions.enableMcp}`
      );

      // Log detailed clone configuration in debug mode
      if (cloneOptions.debug) {
        console.error(`🔍 Clone configuration details:`);
        console.error(`  - Session ID: ${cloneOptions.sessionId}`);
        console.error(`  - Model: ${cloneOptions.model || 'default'}`);
        console.error(`  - Provider: ${cloneOptions.provider || 'auto'}`);
        console.error(`  - MCP Enabled: ${cloneOptions.enableMcp}`);
        console.error(
          `  - MCP Servers: ${cloneOptions.mcpServers ? Object.keys(cloneOptions.mcpServers).length : 0}`
        );
        console.error(`  - Allow Edit: ${cloneOptions.allowEdit}`);
        console.error(`  - Max Iterations: ${cloneOptions.maxIterations || 'default'}`);
        console.error(`  - Prompt Type: ${cloneOptions.promptType || 'default'}`);
      }

      // Deep copy and filter the conversation history
      // Remove schema-specific formatting messages while preserving core context
      if (sourceHistory.length > 0) {
        try {
          // Deep clone the history array and all message objects within it
          const deepClonedHistory = JSON.parse(JSON.stringify(sourceHistory));

          // Filter out schema-specific formatting messages
          const filteredHistory = this.filterHistoryForClone(deepClonedHistory);

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (clonedAgent as any).history = filteredHistory;

          const removedCount = deepClonedHistory.length - filteredHistory.length;
          console.error(
            `📋 Cloned session ${sourceSessionId} → ${newSessionId} (${filteredHistory.length} messages kept, ${removedCount} schema-related removed)`
          );

          if (cloneOptions.debug && removedCount > 0) {
            console.error(
              `🧹 Removed ${removedCount} schema/formatting messages from cloned history`
            );
          }
        } catch (cloneError) {
          // Fallback to shallow copy if deep clone fails (e.g., circular references)
          console.error(
            `⚠️  Warning: Deep clone failed for session ${sourceSessionId}, using shallow copy: ${cloneError}`
          );
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (clonedAgent as any).history = [...sourceHistory];
        }
      } else {
        console.error(`📋 Cloned session ${sourceSessionId} → ${newSessionId} (no history)`);
      }

      // Register the cloned session
      this.registerSession(newSessionId, clonedAgent);

      return clonedAgent;
    } catch (error) {
      console.error(`⚠️  Failed to clone session ${sourceSessionId}: ${error}`);
      return undefined;
    }
  }

  /**
   * Filter conversation history to remove schema-specific formatting messages
   * Preserves core context (PR diff, tool results, main analysis)
   * Removes schema formatting prompts, JSON validation attempts, and mermaid fixes
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private filterHistoryForClone(history: any[]): any[] {
    // Patterns to identify schema/formatting-related messages to remove
    const schemaPatterns = [
      // Schema formatting prompts
      /CRITICAL:\s*You MUST respond with ONLY valid JSON DATA/i,
      /Schema to follow.*provide ACTUAL DATA/i,
      /Convert your previous response.*into actual JSON data/i,
      /Please reformat your previous response to match this schema/i,
      /Now you need to respond according to this schema/i,
      /DO NOT return the schema definition itself/i,
      /this is just the structure - provide ACTUAL DATA/i,
      /You must provide your response as.*JSON/i,
      /respond with.*valid JSON/i,

      // JSON validation and correction prompts
      /CRITICAL JSON ERROR/i,
      /URGENT - JSON PARSING FAILED/i,
      /Your previous JSON response was invalid/i,
      /Your previous response is not valid JSON/i,
      /Please correct the following JSON errors/i,
      /Response is a JSON schema definition instead of data/i,
      /You returned the schema definition itself/i,
      /JSON PARSING FAILED.*cannot be parsed/i,

      // Mermaid validation and fixes
      /The mermaid diagram in your response has syntax errors/i,
      /Please fix the following mermaid diagram/i,
      /Mermaid validation failed/i,

      // Schema reminders in error messages
      /Please use proper XML format with BOTH opening and closing tags/i,
      /Remember to format your response as JSON/i,
      /Your response must match the provided schema/i,

      // ProbeAgent's attempt_completion format instructions
      /<attempt_completion>/i,
      /attempt_completion.*tool.*provide.*final/i,
      /Use attempt_completion.*response.*inside.*tags/i,
    ];

    // Additional patterns for system/reminder messages about formatting
    const systemReminderPatterns = [
      /⚠️ WARNING: You have reached the maximum tool iterations/i,
      /This is your final message.*respond with the data you have/i,
    ];

    // Filter out messages that match schema/formatting patterns
    const filtered = history.filter((message, index) => {
      // Always keep the system message (usually first message)
      if (index === 0 && message.role === 'system') {
        return true;
      }

      // Check message content for schema-related patterns
      const content =
        typeof message.content === 'string' ? message.content : JSON.stringify(message.content);

      // Check if this is a schema/formatting message
      const isSchemaMessage = schemaPatterns.some(pattern => pattern.test(content));
      const isSystemReminder = systemReminderPatterns.some(pattern => pattern.test(content));

      // Also check for messages that are purely JSON validation results
      const isJsonValidationResult =
        content.includes('"jsonParseSuccess"') ||
        content.includes('"isValid"') ||
        content.includes('"validationError"');

      // Also filter out messages that contain actual JSON schema definitions
      // These typically have "$schema", "properties", "required" fields
      const containsSchemaDefinition =
        content.includes('"$schema"') &&
        content.includes('"properties"') &&
        (content.includes('"type"') || content.includes('"required"'));

      // Keep message if it's NOT a schema/formatting message or schema definition
      return !isSchemaMessage && !isSystemReminder && !isJsonValidationResult && !containsSchemaDefinition;
    });

    // Ensure we don't accidentally remove too much
    // Keep at least system message and first user message
    if (filtered.length < 2 && history.length >= 2) {
      const minimalHistory = [
        history[0], // System message
        history[1], // First user message
      ];

      // Add any tool result messages from early in the conversation
      for (let i = 2; i < Math.min(history.length, 10); i++) {
        const content =
          typeof history[i].content === 'string'
            ? history[i].content
            : JSON.stringify(history[i].content);

        if (content.includes('<tool_result>') || content.includes('```diff')) {
          minimalHistory.push(history[i]);
        }
      }

      return minimalHistory;
    }

    return filtered;
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
