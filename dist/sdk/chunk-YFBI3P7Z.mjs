import {
  createExtendedLiquid,
  createPermissionHelpers,
  detectLocalMode
} from "./chunk-F2MPYRH3.mjs";
import {
  __esm,
  __export,
  __require,
  __toCommonJS
} from "./chunk-WMJKH4XE.mjs";

// src/session-registry.ts
var session_registry_exports = {};
__export(session_registry_exports, {
  SessionRegistry: () => SessionRegistry
});
var SessionRegistry;
var init_session_registry = __esm({
  "src/session-registry.ts"() {
    "use strict";
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
       * Clone a session with a new session ID
       * Creates a new ProbeAgent with a copy of the conversation history
       */
      async cloneSession(sourceSessionId, newSessionId) {
        const sourceAgent = this.sessions.get(sourceSessionId);
        if (!sourceAgent) {
          console.error(`\u26A0\uFE0F  Cannot clone session: ${sourceSessionId} not found`);
          return void 0;
        }
        try {
          const sourceHistory = sourceAgent.history || [];
          const sourceOptions = sourceAgent.options || {};
          const { ProbeAgent: ProbeAgentClass } = await import("@probelabs/probe");
          const clonedAgent = new ProbeAgentClass({
            ...sourceOptions,
            sessionId: newSessionId
          });
          if (sourceHistory.length > 0) {
            try {
              const deepClonedHistory = JSON.parse(JSON.stringify(sourceHistory));
              clonedAgent.history = deepClonedHistory;
              console.error(
                `\u{1F4CB} Cloned session ${sourceSessionId} \u2192 ${newSessionId} (${sourceHistory.length} messages, deep copy)`
              );
            } catch (cloneError) {
              console.error(
                `\u26A0\uFE0F  Warning: Deep clone failed for session ${sourceSessionId}, using shallow copy: ${cloneError}`
              );
              clonedAgent.history = [...sourceHistory];
            }
          } else {
            console.error(`\u{1F4CB} Cloned session ${sourceSessionId} \u2192 ${newSessionId} (no history)`);
          }
          this.registerSession(newSessionId, clonedAgent);
          return clonedAgent;
        } catch (error) {
          console.error(`\u26A0\uFE0F  Failed to clone session ${sourceSessionId}: ${error}`);
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

// src/logger.ts
var logger_exports = {};
__export(logger_exports, {
  configureLoggerFromCli: () => configureLoggerFromCli,
  logger: () => logger
});
function levelToNumber(level) {
  switch (level) {
    case "silent":
      return 0;
    case "error":
      return 10;
    case "warn":
      return 20;
    case "info":
      return 30;
    case "verbose":
      return 40;
    case "debug":
      return 50;
  }
}
function configureLoggerFromCli(options) {
  logger.configure({
    outputFormat: options.output,
    debug: options.debug,
    verbose: options.verbose,
    quiet: options.quiet
  });
  try {
    if (options.output) process.env.VISOR_OUTPUT_FORMAT = String(options.output);
    if (typeof options.debug === "boolean") {
      process.env.VISOR_DEBUG = options.debug ? "true" : "false";
    }
  } catch {
  }
}
var Logger, logger;
var init_logger = __esm({
  "src/logger.ts"() {
    "use strict";
    Logger = class {
      level = "info";
      isJsonLike = false;
      isTTY = typeof process !== "undefined" ? !!process.stderr.isTTY : false;
      configure(opts = {}) {
        let lvl = "info";
        if (opts.debug || process.env.VISOR_DEBUG === "true") {
          lvl = "debug";
        } else if (opts.verbose || process.env.VISOR_LOG_LEVEL === "verbose") {
          lvl = "verbose";
        } else if (opts.quiet || process.env.VISOR_LOG_LEVEL === "quiet") {
          lvl = "warn";
        } else if (opts.level) {
          lvl = opts.level;
        } else if (process.env.VISOR_LOG_LEVEL) {
          const envLvl = process.env.VISOR_LOG_LEVEL;
          if (["silent", "error", "warn", "info", "verbose", "debug"].includes(envLvl)) {
            lvl = envLvl;
          }
        }
        this.level = lvl;
        const output = opts.outputFormat || process.env.VISOR_OUTPUT_FORMAT || "table";
        this.isJsonLike = output === "json" || output === "sarif";
      }
      shouldLog(level) {
        const desired = levelToNumber(level);
        const current = levelToNumber(this.level);
        if (desired > current) return false;
        if (this.isJsonLike && desired < levelToNumber("error") && this.level !== "debug" && this.level !== "verbose") {
          return false;
        }
        return true;
      }
      write(msg) {
        try {
          process.stderr.write(msg + "\n");
        } catch {
        }
      }
      info(msg) {
        if (this.shouldLog("info")) this.write(msg);
      }
      warn(msg) {
        if (this.shouldLog("warn")) this.write(msg);
      }
      error(msg) {
        if (this.shouldLog("error")) this.write(msg);
      }
      verbose(msg) {
        if (this.shouldLog("verbose")) this.write(msg);
      }
      debug(msg) {
        if (this.shouldLog("debug")) this.write(msg);
      }
      step(msg) {
        if (this.shouldLog("info")) this.write(`\u25B6 ${msg}`);
      }
      success(msg) {
        if (this.shouldLog("info")) this.write(`\u2714 ${msg}`);
      }
    };
    logger = new Logger();
  }
});

// src/github-comments.ts
import { v4 as uuidv4 } from "uuid";
var CommentManager = class {
  octokit;
  retryConfig;
  constructor(octokit, retryConfig) {
    this.octokit = octokit;
    this.retryConfig = {
      maxRetries: 3,
      baseDelay: 1e3,
      maxDelay: 1e4,
      backoffFactor: 2,
      ...retryConfig
    };
  }
  /**
   * Find existing Visor comment by comment ID marker
   */
  async findVisorComment(owner, repo, prNumber, commentId) {
    try {
      const comments = await this.octokit.rest.issues.listComments({
        owner,
        repo,
        issue_number: prNumber,
        per_page: 100
        // GitHub default max
      });
      for (const comment of comments.data) {
        if (comment.body && this.isVisorComment(comment.body, commentId)) {
          return comment;
        }
      }
      return null;
    } catch (error) {
      if (this.isRateLimitError(
        error
      )) {
        await this.handleRateLimit(error);
        return this.findVisorComment(owner, repo, prNumber, commentId);
      }
      throw error;
    }
  }
  /**
   * Update existing comment or create new one with collision detection
   */
  async updateOrCreateComment(owner, repo, prNumber, content, options = {}) {
    const {
      commentId = this.generateCommentId(),
      triggeredBy = "unknown",
      allowConcurrentUpdates = false,
      commitSha
    } = options;
    return this.withRetry(async () => {
      const existingComment = await this.findVisorComment(owner, repo, prNumber, commentId);
      const formattedContent = this.formatCommentWithMetadata(content, {
        commentId,
        lastUpdated: (/* @__PURE__ */ new Date()).toISOString(),
        triggeredBy,
        commitSha
      });
      if (existingComment) {
        if (!allowConcurrentUpdates) {
          const currentComment = await this.octokit.rest.issues.getComment({
            owner,
            repo,
            comment_id: existingComment.id
          });
          if (currentComment.data.updated_at !== existingComment.updated_at) {
            throw new Error(
              `Comment collision detected for comment ${commentId}. Another process may have updated it.`
            );
          }
        }
        const updatedComment = await this.octokit.rest.issues.updateComment({
          owner,
          repo,
          comment_id: existingComment.id,
          body: formattedContent
        });
        return updatedComment.data;
      } else {
        const newComment = await this.octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: prNumber,
          body: formattedContent
        });
        return newComment.data;
      }
    });
  }
  /**
   * Format comment content with metadata markers
   */
  formatCommentWithMetadata(content, metadata) {
    const { commentId, lastUpdated, triggeredBy, commitSha } = metadata;
    const commitInfo = commitSha ? ` | Commit: ${commitSha.substring(0, 7)}` : "";
    return `<!-- visor-comment-id:${commentId} -->
${content}

*Last updated: ${lastUpdated} | Triggered by: ${triggeredBy}${commitInfo}*
<!-- /visor-comment-id:${commentId} -->`;
  }
  /**
   * Create collapsible sections for comment content
   */
  createCollapsibleSection(title, content, isExpanded = false) {
    const openAttribute = isExpanded ? " open" : "";
    return `<details${openAttribute}>
<summary>${title}</summary>

${content}

</details>`;
  }
  /**
   * Group review results by check type with collapsible sections
   */
  formatGroupedResults(results, groupBy = "check") {
    const grouped = this.groupResults(results, groupBy);
    const sections = [];
    for (const [groupKey, items] of Object.entries(grouped)) {
      const totalScore = items.reduce((sum, item) => sum + (item.score || 0), 0) / items.length;
      const totalIssues = items.reduce((sum, item) => sum + (item.issuesFound || 0), 0);
      const emoji = this.getCheckTypeEmoji(groupKey);
      const title = `${emoji} ${this.formatGroupTitle(groupKey, totalScore, totalIssues)}`;
      const sectionContent = items.map((item) => item.content).join("\n\n");
      sections.push(this.createCollapsibleSection(title, sectionContent, totalIssues > 0));
    }
    return sections.join("\n\n");
  }
  /**
   * Generate unique comment ID
   */
  generateCommentId() {
    return uuidv4().substring(0, 8);
  }
  /**
   * Check if comment is a Visor comment
   */
  isVisorComment(body, commentId) {
    if (commentId) {
      if (body.includes(`visor-comment-id:${commentId} `) || body.includes(`visor-comment-id:${commentId} -->`)) {
        return true;
      }
      if (commentId.startsWith("pr-review-") && body.includes("visor-review-")) {
        return true;
      }
      return false;
    }
    return body.includes("visor-comment-id:") && body.includes("<!-- /visor-comment-id:") || body.includes("visor-review-");
  }
  /**
   * Extract comment ID from comment body
   */
  extractCommentId(body) {
    const match = body.match(/visor-comment-id:([a-f0-9-]+)/);
    return match ? match[1] : null;
  }
  /**
   * Handle rate limiting with exponential backoff
   */
  async handleRateLimit(error) {
    const resetTime = error.response?.headers?.["x-ratelimit-reset"];
    if (resetTime) {
      const resetDate = new Date(parseInt(resetTime) * 1e3);
      const waitTime = Math.max(resetDate.getTime() - Date.now(), this.retryConfig.baseDelay);
      console.log(`Rate limit exceeded. Waiting ${Math.round(waitTime / 1e3)}s until reset...`);
      await this.sleep(Math.min(waitTime, this.retryConfig.maxDelay));
    } else {
      await this.sleep(this.retryConfig.baseDelay);
    }
  }
  /**
   * Check if error is a rate limit error
   */
  isRateLimitError(error) {
    return error.status === 403 && (error.response?.data?.message?.includes("rate limit") ?? false);
  }
  /**
   * Check if error should not be retried (auth errors, not found, etc.)
   */
  isNonRetryableError(error) {
    const nonRetryableStatuses = [401, 404, 422];
    const status = error.status || error.response?.status;
    if (status === 403) {
      return !this.isRateLimitError(error);
    }
    return status !== void 0 && nonRetryableStatuses.includes(status);
  }
  /**
   * Retry wrapper with exponential backoff
   */
  async withRetry(operation) {
    let lastError = new Error("Unknown error");
    for (let attempt = 0; attempt <= this.retryConfig.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        if (attempt === this.retryConfig.maxRetries) {
          break;
        }
        if (this.isRateLimitError(
          error
        )) {
          await this.handleRateLimit(error);
        } else if (this.isNonRetryableError(error)) {
          throw error;
        } else {
          const delay = Math.min(
            this.retryConfig.baseDelay * Math.pow(this.retryConfig.backoffFactor, attempt),
            this.retryConfig.maxDelay
          );
          await this.sleep(delay);
        }
      }
    }
    throw lastError;
  }
  /**
   * Sleep utility
   */
  sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  /**
   * Group results by specified criteria
   */
  groupResults(results, groupBy) {
    const grouped = {};
    for (const result of results) {
      const key = groupBy === "check" ? result.checkType : this.getSeverityGroup(result.score);
      if (!grouped[key]) {
        grouped[key] = [];
      }
      grouped[key].push(result);
    }
    return grouped;
  }
  /**
   * Get severity group based on score
   */
  getSeverityGroup(score) {
    if (!score) return "Unknown";
    if (score >= 90) return "Excellent";
    if (score >= 75) return "Good";
    if (score >= 50) return "Needs Improvement";
    return "Critical Issues";
  }
  /**
   * Get emoji for check type
   */
  getCheckTypeEmoji(checkType) {
    const emojiMap = {
      performance: "\u{1F4C8}",
      security: "\u{1F512}",
      architecture: "\u{1F3D7}\uFE0F",
      style: "\u{1F3A8}",
      all: "\u{1F50D}",
      Excellent: "\u2705",
      Good: "\u{1F44D}",
      "Needs Improvement": "\u26A0\uFE0F",
      "Critical Issues": "\u{1F6A8}",
      Unknown: "\u2753"
    };
    return emojiMap[checkType] || "\u{1F4DD}";
  }
  /**
   * Format group title with score and issue count
   */
  formatGroupTitle(groupKey, score, issuesFound) {
    const formattedScore = Math.round(score);
    return `${groupKey} Review (Score: ${formattedScore}/100)${issuesFound > 0 ? ` - ${issuesFound} issues found` : ""}`;
  }
};

// src/ai-review-service.ts
init_session_registry();
init_logger();
import { ProbeAgent } from "@probelabs/probe";
function log(...args) {
  logger.debug(args.join(" "));
}
var AIReviewService = class {
  config;
  sessionRegistry;
  constructor(config = {}) {
    this.config = {
      timeout: 6e5,
      // Increased timeout to 10 minutes for AI responses
      ...config
    };
    this.sessionRegistry = SessionRegistry.getInstance();
    if (!this.config.apiKey) {
      if (process.env.CLAUDE_CODE_API_KEY) {
        this.config.apiKey = process.env.CLAUDE_CODE_API_KEY;
        this.config.provider = "claude-code";
      } else if (process.env.GOOGLE_API_KEY) {
        this.config.apiKey = process.env.GOOGLE_API_KEY;
        this.config.provider = "google";
      } else if (process.env.ANTHROPIC_API_KEY) {
        this.config.apiKey = process.env.ANTHROPIC_API_KEY;
        this.config.provider = "anthropic";
      } else if (process.env.OPENAI_API_KEY) {
        this.config.apiKey = process.env.OPENAI_API_KEY;
        this.config.provider = "openai";
      } else if (
        // Check for AWS Bedrock credentials
        process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY || process.env.AWS_BEDROCK_API_KEY
      ) {
        this.config.provider = "bedrock";
        this.config.apiKey = "AWS_CREDENTIALS";
      }
    }
    if (!this.config.model && process.env.MODEL_NAME) {
      this.config.model = process.env.MODEL_NAME;
    }
  }
  /**
   * Execute AI review using probe agent
   */
  async executeReview(prInfo, customPrompt, schema, _checkName, sessionId) {
    const startTime = Date.now();
    const timestamp = (/* @__PURE__ */ new Date()).toISOString();
    const prompt = await this.buildCustomPrompt(prInfo, customPrompt, schema);
    log(`Executing AI review with ${this.config.provider} provider...`);
    log(`\u{1F527} Debug: Raw schema parameter: ${JSON.stringify(schema)} (type: ${typeof schema})`);
    log(`Schema type: ${schema || "none (no schema)"}`);
    let debugInfo;
    if (this.config.debug) {
      debugInfo = {
        prompt,
        rawResponse: "",
        provider: this.config.provider || "unknown",
        model: this.config.model || "default",
        apiKeySource: this.getApiKeySource(),
        processingTime: 0,
        promptLength: prompt.length,
        responseLength: 0,
        errors: [],
        jsonParseSuccess: false,
        timestamp,
        schemaName: typeof schema === "object" ? "custom" : schema,
        schema: void 0
        // Will be populated when schema is loaded
      };
    }
    if (this.config.model === "mock" || this.config.provider === "mock") {
      log("\u{1F3AD} Using mock AI model/provider for testing - skipping API key validation");
    } else {
      if (!this.config.apiKey) {
        const errorMessage = "No API key configured. Please set GOOGLE_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY environment variable, or configure AWS credentials for Bedrock (AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY).";
        if (debugInfo) {
          debugInfo.errors = [errorMessage];
          debugInfo.processingTime = Date.now() - startTime;
          debugInfo.rawResponse = "API call not attempted - no API key configured";
          return {
            issues: [
              {
                file: "system",
                line: 0,
                ruleId: "system/api-key-missing",
                message: errorMessage,
                severity: "error",
                category: "logic"
              }
            ],
            debug: debugInfo
          };
        }
        throw new Error(errorMessage);
      }
    }
    try {
      const { response, effectiveSchema } = await this.callProbeAgent(
        prompt,
        schema,
        debugInfo,
        _checkName,
        sessionId
      );
      const processingTime = Date.now() - startTime;
      if (debugInfo) {
        debugInfo.rawResponse = response;
        debugInfo.responseLength = response.length;
        debugInfo.processingTime = processingTime;
      }
      const result = this.parseAIResponse(response, debugInfo, effectiveSchema);
      if (debugInfo) {
        result.debug = debugInfo;
      }
      return result;
    } catch (error) {
      if (debugInfo) {
        debugInfo.errors = [error instanceof Error ? error.message : String(error)];
        debugInfo.processingTime = Date.now() - startTime;
        return {
          issues: [
            {
              file: "system",
              line: 0,
              ruleId: "system/ai-execution-error",
              message: error instanceof Error ? error.message : String(error),
              severity: "error",
              category: "logic"
            }
          ],
          debug: debugInfo
        };
      }
      throw error;
    }
  }
  /**
   * Execute AI review using session reuse - reuses an existing ProbeAgent session
   * @param sessionMode - 'clone' (default) clones history, 'append' shares history
   */
  async executeReviewWithSessionReuse(prInfo, customPrompt, parentSessionId, schema, checkName, sessionMode = "clone") {
    const startTime = Date.now();
    const timestamp = (/* @__PURE__ */ new Date()).toISOString();
    const existingAgent = this.sessionRegistry.getSession(parentSessionId);
    if (!existingAgent) {
      throw new Error(
        `Session not found for reuse: ${parentSessionId}. Ensure the parent check completed successfully.`
      );
    }
    const prompt = await this.buildCustomPrompt(prInfo, customPrompt, schema);
    let agentToUse;
    let currentSessionId;
    if (sessionMode === "clone") {
      currentSessionId = `${parentSessionId}-clone-${Date.now()}`;
      log(`\u{1F4CB} Cloning AI session ${parentSessionId} \u2192 ${currentSessionId}...`);
      const clonedAgent = await this.sessionRegistry.cloneSession(
        parentSessionId,
        currentSessionId
      );
      if (!clonedAgent) {
        throw new Error(`Failed to clone session ${parentSessionId}. Falling back to append mode.`);
      }
      agentToUse = clonedAgent;
    } else {
      log(`\u{1F504} Appending to AI session ${parentSessionId} (shared history)...`);
      agentToUse = existingAgent;
      currentSessionId = parentSessionId;
    }
    log(`\u{1F527} Debug: Raw schema parameter: ${JSON.stringify(schema)} (type: ${typeof schema})`);
    log(`Schema type: ${schema || "none (no schema)"}`);
    let debugInfo;
    if (this.config.debug) {
      debugInfo = {
        prompt,
        rawResponse: "",
        provider: this.config.provider || "unknown",
        model: this.config.model || "default",
        apiKeySource: this.getApiKeySource(),
        processingTime: 0,
        promptLength: prompt.length,
        responseLength: 0,
        errors: [],
        jsonParseSuccess: false,
        timestamp,
        schemaName: typeof schema === "object" ? "custom" : schema,
        schema: void 0
        // Will be populated when schema is loaded
      };
    }
    try {
      const { response, effectiveSchema } = await this.callProbeAgentWithExistingSession(
        agentToUse,
        prompt,
        schema,
        debugInfo,
        checkName
      );
      const processingTime = Date.now() - startTime;
      if (debugInfo) {
        debugInfo.rawResponse = response;
        debugInfo.responseLength = response.length;
        debugInfo.processingTime = processingTime;
      }
      const result = this.parseAIResponse(response, debugInfo, effectiveSchema);
      if (debugInfo) {
        result.debug = debugInfo;
      }
      if (sessionMode === "clone" && currentSessionId !== parentSessionId) {
        result.sessionId = currentSessionId;
      }
      return result;
    } catch (error) {
      if (debugInfo) {
        debugInfo.errors = [error instanceof Error ? error.message : String(error)];
        debugInfo.processingTime = Date.now() - startTime;
        return {
          issues: [
            {
              file: "system",
              line: 0,
              ruleId: "system/ai-session-reuse-error",
              message: error instanceof Error ? error.message : String(error),
              severity: "error",
              category: "logic"
            }
          ],
          debug: debugInfo
        };
      }
      throw error;
    }
  }
  /**
   * Register a new AI session in the session registry
   */
  registerSession(sessionId, agent) {
    this.sessionRegistry.registerSession(sessionId, agent);
  }
  /**
   * Cleanup a session from the registry
   */
  cleanupSession(sessionId) {
    this.sessionRegistry.unregisterSession(sessionId);
  }
  /**
   * Build a custom prompt for AI review with XML-formatted data
   */
  async buildCustomPrompt(prInfo, customInstructions, schema) {
    const prContext = this.formatPRContext(prInfo);
    const isIssue = prInfo.isIssue === true;
    const isCodeReviewSchema = schema === "code-review";
    if (isIssue) {
      return `<review_request>
  <instructions>
${customInstructions}
  </instructions>

  <context>
${prContext}
  </context>

  <rules>
    <rule>Understand the issue context and requirements from the XML data structure</rule>
    <rule>Provide helpful, actionable guidance based on the issue details</rule>
    <rule>Be constructive and supportive in your analysis</rule>
    <rule>Consider project conventions and patterns when making recommendations</rule>
    <rule>Suggest practical solutions or next steps that address the specific concern</rule>
    <rule>Focus on addressing the specific concern raised in the issue</rule>
    <rule>Reference relevant XML elements like metadata, description, labels, assignees when providing context</rule>
  </rules>
</review_request>`;
    }
    if (isCodeReviewSchema) {
      const analysisType = prInfo.isIncremental ? "INCREMENTAL" : "FULL";
      return `<review_request>
  <analysis_type>${analysisType}</analysis_type>

  <analysis_focus>
    ${analysisType === "INCREMENTAL" ? "You are analyzing a NEW COMMIT added to an existing PR. Focus on the changes in the commit_diff section for this specific commit." : "You are analyzing the COMPLETE PR. Review all changes in the full_diff section."}
  </analysis_focus>

  <instructions>
${customInstructions}
  </instructions>

  <context>
${prContext}
  </context>

  <rules>
    <rule>Only analyze code that appears with + (additions) or - (deletions) in the diff sections</rule>
    <rule>Ignore unchanged code unless directly relevant to understanding a change</rule>
    <rule>Line numbers in your response should match actual file line numbers from the diff</rule>
    <rule>Focus on real issues, not nitpicks or cosmetic concerns</rule>
    <rule>Provide actionable, specific feedback with clear remediation steps</rule>
    <rule>For INCREMENTAL analysis, ONLY review changes in commit_diff section</rule>
    <rule>For FULL analysis, review all changes in full_diff section</rule>
    <rule>Reference specific XML elements like files_summary, metadata when providing context</rule>
    <rule>STRICT OUTPUT POLICY: Report only actual problems, risks, or deficiencies. Do not write praise, congratulations, or celebratory text. Do not create issues that merely restate improvements or say "no action needed".</rule>
    <rule>SEVERITY ASSIGNMENT: Assign severity ONLY to problems introduced or left unresolved by this change (critical/error/warning/info as appropriate). Do NOT create issue entries solely to acknowledge improvements; if no problems exist, return zero issues.</rule>
  </rules>
</review_request>`;
    }
    return `<instructions>
${customInstructions}
</instructions>

<context>
${prContext}
</context>`;
  }
  // REMOVED: Built-in prompts - only use custom prompts from .visor.yaml
  // REMOVED: getFocusInstructions - only use custom prompts from .visor.yaml
  /**
   * Format PR or Issue context for the AI using XML structure
   */
  formatPRContext(prInfo) {
    const prContextInfo = prInfo;
    const isIssue = prContextInfo.isIssue === true;
    const isPRContext = prContextInfo.isPRContext === true;
    const includeCodeContext = isPRContext || prContextInfo.includeCodeContext !== false;
    const log2 = this.config.debug ? console.error : () => {
    };
    if (isPRContext) {
      log2("\u{1F50D} Including full code diffs in AI context (PR mode)");
    } else if (!includeCodeContext) {
      log2("\u{1F4CA} Including only file summary in AI context (no diffs)");
    } else {
      log2("\u{1F50D} Including code diffs in AI context");
    }
    if (isIssue) {
      let context2 = `<issue>
  <!-- Core issue metadata including identification, status, and timeline information -->
  <metadata>
    <number>${prInfo.number}</number>
    <title>${this.escapeXml(prInfo.title)}</title>
    <author>${prInfo.author}</author>
    <state>${prInfo.eventContext?.issue?.state || "open"}</state>
    <created_at>${prInfo.eventContext?.issue?.created_at || ""}</created_at>
    <updated_at>${prInfo.eventContext?.issue?.updated_at || ""}</updated_at>
    <comments_count>${prInfo.eventContext?.issue?.comments || 0}</comments_count>
  </metadata>`;
      if (prInfo.body) {
        context2 += `
  <!-- Full issue description and body text provided by the issue author -->
  <description>
${this.escapeXml(prInfo.body)}
  </description>`;
      }
      const eventContext = prInfo;
      const labels = eventContext.eventContext?.issue?.labels;
      if (labels && labels.length > 0) {
        context2 += `
  <!-- Applied labels for issue categorization and organization -->
  <labels>`;
        labels.forEach((label) => {
          const labelName = typeof label === "string" ? label : label.name || "unknown";
          context2 += `
    <label>${this.escapeXml(labelName)}</label>`;
        });
        context2 += `
  </labels>`;
      }
      const assignees = prInfo.eventContext?.issue?.assignees;
      if (assignees && assignees.length > 0) {
        context2 += `
  <!-- Users assigned to work on this issue -->
  <assignees>`;
        assignees.forEach((assignee) => {
          const assigneeName = typeof assignee === "string" ? assignee : assignee.login || "unknown";
          context2 += `
    <assignee>${this.escapeXml(assigneeName)}</assignee>`;
        });
        context2 += `
  </assignees>`;
      }
      const milestone = prInfo.eventContext?.issue?.milestone;
      if (milestone) {
        context2 += `
  <!-- Associated project milestone information -->
  <milestone>
    <title>${this.escapeXml(milestone.title || "")}</title>
    <state>${milestone.state || "open"}</state>
    <due_on>${milestone.due_on || ""}</due_on>
  </milestone>`;
      }
      const triggeringComment2 = prInfo.eventContext?.comment;
      if (triggeringComment2) {
        context2 += `
  <!-- The comment that triggered this analysis -->
  <triggering_comment>
    <author>${this.escapeXml(triggeringComment2.user?.login || "unknown")}</author>
    <created_at>${triggeringComment2.created_at || ""}</created_at>
    <body>${this.escapeXml(triggeringComment2.body || "")}</body>
  </triggering_comment>`;
      }
      const issueComments = prInfo.comments;
      if (issueComments && issueComments.length > 0) {
        const historicalComments = triggeringComment2 ? issueComments.filter((c) => c.id !== triggeringComment2.id) : issueComments;
        if (historicalComments.length > 0) {
          context2 += `
  <!-- Previous comments in chronological order (excluding triggering comment) -->
  <comment_history>`;
          historicalComments.forEach((comment) => {
            context2 += `
    <comment>
      <author>${this.escapeXml(comment.author || "unknown")}</author>
      <created_at>${comment.createdAt || ""}</created_at>
      <body>${this.escapeXml(comment.body || "")}</body>
    </comment>`;
          });
          context2 += `
  </comment_history>`;
        }
      }
      context2 += `
</issue>`;
      return context2;
    }
    let context = `<pull_request>
  <!-- Core pull request metadata including identification, branches, and change statistics -->
  <metadata>
    <number>${prInfo.number}</number>
    <title>${this.escapeXml(prInfo.title)}</title>
    <author>${prInfo.author}</author>
    <base_branch>${prInfo.base}</base_branch>
    <target_branch>${prInfo.head}</target_branch>
    <total_additions>${prInfo.totalAdditions}</total_additions>
    <total_deletions>${prInfo.totalDeletions}</total_deletions>
    <files_changed_count>${prInfo.files.length}</files_changed_count>
  </metadata>`;
    if (prInfo.body) {
      context += `
  <!-- Full pull request description provided by the author -->
  <description>
${this.escapeXml(prInfo.body)}
  </description>`;
    }
    if (includeCodeContext) {
      if (prInfo.fullDiff) {
        context += `
  <!-- Complete unified diff showing all changes in the pull request -->
  <full_diff>
${this.escapeXml(prInfo.fullDiff)}
  </full_diff>`;
      }
      if (prInfo.isIncremental) {
        if (prInfo.commitDiff && prInfo.commitDiff.length > 0) {
          context += `
  <!-- Diff of only the latest commit for incremental analysis -->
  <commit_diff>
${this.escapeXml(prInfo.commitDiff)}
  </commit_diff>`;
        } else {
          context += `
  <!-- Commit diff could not be retrieved - falling back to full diff analysis -->
  <commit_diff>
${prInfo.fullDiff ? this.escapeXml(prInfo.fullDiff) : ""}
  </commit_diff>`;
        }
      }
    } else {
      context += `
  <!-- Code diffs excluded to reduce token usage (no code-review schema detected or disabled by flag) -->`;
    }
    if (prInfo.files.length > 0) {
      context += `
  <!-- Summary of all files changed with statistics -->
  <files_summary>`;
      prInfo.files.forEach((file) => {
        context += `
    <file>
      <filename>${this.escapeXml(file.filename)}</filename>
      <status>${file.status}</status>
      <additions>${file.additions}</additions>
      <deletions>${file.deletions}</deletions>
    </file>`;
      });
      context += `
  </files_summary>`;
    }
    const triggeringComment = prInfo.eventContext?.comment;
    if (triggeringComment) {
      context += `
  <!-- The comment that triggered this analysis -->
  <triggering_comment>
    <author>${this.escapeXml(triggeringComment.user?.login || "unknown")}</author>
    <created_at>${triggeringComment.created_at || ""}</created_at>
    <body>${this.escapeXml(triggeringComment.body || "")}</body>
  </triggering_comment>`;
    }
    const prComments = prInfo.comments;
    if (prComments && prComments.length > 0) {
      const historicalComments = triggeringComment ? prComments.filter((c) => c.id !== triggeringComment.id) : prComments;
      if (historicalComments.length > 0) {
        context += `
  <!-- Previous PR comments in chronological order (excluding triggering comment) -->
  <comment_history>`;
        historicalComments.forEach((comment) => {
          context += `
    <comment>
      <author>${this.escapeXml(comment.author || "unknown")}</author>
      <created_at>${comment.createdAt || ""}</created_at>
      <body>${this.escapeXml(comment.body || "")}</body>
    </comment>`;
        });
        context += `
  </comment_history>`;
      }
    }
    context += `
</pull_request>`;
    return context;
  }
  /**
   * No longer escaping XML - returning text as-is
   */
  escapeXml(text) {
    return text;
  }
  /**
   * Call ProbeAgent with an existing session
   */
  async callProbeAgentWithExistingSession(agent, prompt, schema, debugInfo, _checkName) {
    if (this.config.model === "mock" || this.config.provider === "mock") {
      log("\u{1F3AD} Using mock AI model/provider for testing (session reuse)");
      const response = await this.generateMockResponse(prompt);
      return { response, effectiveSchema: typeof schema === "object" ? "custom" : schema };
    }
    log("\u{1F504} Reusing existing ProbeAgent session for AI review...");
    log(`\u{1F4DD} Prompt length: ${prompt.length} characters`);
    log(`\u2699\uFE0F Model: ${this.config.model || "default"}, Provider: ${this.config.provider || "auto"}`);
    try {
      log("\u{1F680} Calling existing ProbeAgent with answer()...");
      let schemaString = void 0;
      let effectiveSchema = typeof schema === "object" ? "custom" : schema;
      if (schema && schema !== "plain") {
        try {
          schemaString = await this.loadSchemaContent(schema);
          log(`\u{1F4CB} Loaded schema content for: ${schema}`);
          log(`\u{1F4C4} Raw schema JSON:
${schemaString}`);
        } catch (error) {
          log(`\u26A0\uFE0F Failed to load schema ${schema}, proceeding without schema:`, error);
          schemaString = void 0;
          effectiveSchema = void 0;
          if (debugInfo && debugInfo.errors) {
            debugInfo.errors.push(`Failed to load schema: ${error}`);
          }
        }
      } else if (schema === "plain") {
        log(`\u{1F4CB} Using plain schema - no JSON validation will be applied`);
      }
      const schemaOptions = schemaString ? { schema: schemaString } : void 0;
      if (debugInfo && schemaOptions) {
        debugInfo.schema = JSON.stringify(schemaOptions, null, 2);
      }
      if (schemaOptions) {
        log(`\u{1F3AF} Schema options passed to ProbeAgent.answer() (session reuse):`);
        log(JSON.stringify(schemaOptions, null, 2));
      }
      const response = await agent.answer(prompt, void 0, schemaOptions);
      log("\u2705 ProbeAgent session reuse completed successfully");
      log(`\u{1F4E4} Response length: ${response.length} characters`);
      return { response, effectiveSchema };
    } catch (error) {
      console.error("\u274C ProbeAgent session reuse failed:", error);
      throw new Error(
        `ProbeAgent session reuse failed: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }
  /**
   * Call ProbeAgent SDK with built-in schema validation
   */
  async callProbeAgent(prompt, schema, debugInfo, _checkName, providedSessionId) {
    if (this.config.model === "mock" || this.config.provider === "mock") {
      log("\u{1F3AD} Using mock AI model/provider for testing");
      const response = await this.generateMockResponse(prompt);
      return { response, effectiveSchema: typeof schema === "object" ? "custom" : schema };
    }
    const sessionId = providedSessionId || (() => {
      const timestamp = (/* @__PURE__ */ new Date()).toISOString();
      return `visor-${timestamp.replace(/[:.]/g, "-")}-${_checkName || "unknown"}`;
    })();
    log("\u{1F916} Creating ProbeAgent for AI review...");
    log(`\u{1F194} Session ID: ${sessionId}`);
    log(`\u{1F4DD} Prompt length: ${prompt.length} characters`);
    log(`\u2699\uFE0F Model: ${this.config.model || "default"}, Provider: ${this.config.provider || "auto"}`);
    const originalEnv = {
      CLAUDE_CODE_API_KEY: process.env.CLAUDE_CODE_API_KEY,
      GOOGLE_API_KEY: process.env.GOOGLE_API_KEY,
      ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
      OPENAI_API_KEY: process.env.OPENAI_API_KEY
    };
    try {
      if (this.config.provider === "claude-code" && this.config.apiKey) {
        process.env.CLAUDE_CODE_API_KEY = this.config.apiKey;
        process.env.ANTHROPIC_API_KEY = this.config.apiKey;
      } else if (this.config.provider === "google" && this.config.apiKey) {
        process.env.GOOGLE_API_KEY = this.config.apiKey;
      } else if (this.config.provider === "anthropic" && this.config.apiKey) {
        process.env.ANTHROPIC_API_KEY = this.config.apiKey;
      } else if (this.config.provider === "openai" && this.config.apiKey) {
        process.env.OPENAI_API_KEY = this.config.apiKey;
      } else if (this.config.provider === "bedrock") {
      }
      const options = {
        sessionId,
        promptType: schema ? "code-review-template" : void 0,
        allowEdit: false,
        // We don't want the agent to modify files
        debug: this.config.debug || false
      };
      if (this.config.mcpServers && Object.keys(this.config.mcpServers).length > 0) {
        options.enableMcp = true;
        options.mcpConfig = { mcpServers: this.config.mcpServers };
      }
      if (this.config.provider) {
        const providerOverride = this.config.provider === "claude-code" || this.config.provider === "bedrock" ? "anthropic" : this.config.provider === "anthropic" || this.config.provider === "openai" || this.config.provider === "google" ? this.config.provider : void 0;
        if (providerOverride) {
          options.provider = providerOverride;
        }
      }
      if (this.config.model) {
        options.model = this.config.model;
      }
      const agent = new ProbeAgent(options);
      log("\u{1F680} Calling ProbeAgent...");
      let schemaString = void 0;
      let effectiveSchema = typeof schema === "object" ? "custom" : schema;
      if (schema && schema !== "plain") {
        try {
          schemaString = await this.loadSchemaContent(schema);
          log(`\u{1F4CB} Loaded schema content for: ${schema}`);
          log(`\u{1F4C4} Raw schema JSON:
${schemaString}`);
        } catch (error) {
          log(`\u26A0\uFE0F Failed to load schema ${schema}, proceeding without schema:`, error);
          schemaString = void 0;
          effectiveSchema = void 0;
          if (debugInfo && debugInfo.errors) {
            debugInfo.errors.push(`Failed to load schema: ${error}`);
          }
        }
      } else if (schema === "plain") {
        log(`\u{1F4CB} Using plain schema - no JSON validation will be applied`);
      }
      const schemaOptions = schemaString ? { schema: schemaString } : void 0;
      if (debugInfo && schemaOptions) {
        debugInfo.schema = JSON.stringify(schemaOptions, null, 2);
      }
      if (schemaOptions) {
        log(`\u{1F3AF} Schema options passed to ProbeAgent.answer():`);
        log(JSON.stringify(schemaOptions, null, 2));
      }
      const provider = this.config.provider || "auto";
      const model = this.config.model || "default";
      try {
        const fs5 = __require("fs");
        const path5 = __require("path");
        const os = __require("os");
        const tempDir = os.tmpdir();
        const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
        const promptFile = path5.join(tempDir, `visor-prompt-${timestamp}.txt`);
        fs5.writeFileSync(promptFile, prompt, "utf-8");
        log(`
\u{1F4BE} Prompt saved to: ${promptFile}`);
        log(`
\u{1F4DD} To reproduce locally, run:`);
        let cliCommand = `npx @probelabs/probe@latest agent`;
        cliCommand += ` --provider ${provider}`;
        if (model !== "default") {
          cliCommand += ` --model ${model}`;
        }
        if (schema) {
          cliCommand += ` --schema output/${schema}/schema.json`;
        }
        cliCommand += ` "${promptFile}"`;
        log(`
$ ${cliCommand}
`);
      } catch (error) {
        log(`\u26A0\uFE0F Could not save prompt file: ${error}`);
      }
      const response = await agent.answer(prompt, void 0, schemaOptions);
      log("\u2705 ProbeAgent completed successfully");
      log(`\u{1F4E4} Response length: ${response.length} characters`);
      if (_checkName) {
        this.registerSession(sessionId, agent);
        log(`\u{1F527} Debug: Registered AI session for potential reuse: ${sessionId}`);
      }
      return { response, effectiveSchema };
    } catch (error) {
      console.error("\u274C ProbeAgent failed:", error);
      throw new Error(
        `ProbeAgent execution failed: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    } finally {
      Object.keys(originalEnv).forEach((key) => {
        if (originalEnv[key] === void 0) {
          delete process.env[key];
        } else {
          process.env[key] = originalEnv[key];
        }
      });
    }
  }
  /**
   * Load schema content from schema files or inline definitions
   */
  async loadSchemaContent(schema) {
    const fs5 = __require("fs").promises;
    const path5 = __require("path");
    if (typeof schema === "object" && schema !== null) {
      log("\u{1F4CB} Using inline schema object from configuration");
      return JSON.stringify(schema);
    }
    try {
      const parsed = JSON.parse(schema);
      if (typeof parsed === "object" && parsed !== null) {
        log("\u{1F4CB} Using inline schema JSON string");
        return schema;
      }
    } catch {
    }
    if ((schema.startsWith("./") || schema.includes(".json")) && !path5.isAbsolute(schema)) {
      if (schema.includes("..") || schema.includes("\0")) {
        throw new Error("Invalid schema path: path traversal not allowed");
      }
      try {
        const schemaPath2 = path5.resolve(process.cwd(), schema);
        log(`\u{1F4CB} Loading custom schema from file: ${schemaPath2}`);
        const schemaContent = await fs5.readFile(schemaPath2, "utf-8");
        return schemaContent.trim();
      } catch (error) {
        throw new Error(
          `Failed to load custom schema from ${schema}: ${error instanceof Error ? error.message : "Unknown error"}`
        );
      }
    }
    const sanitizedSchemaName = schema.replace(/[^a-zA-Z0-9-]/g, "");
    if (!sanitizedSchemaName || sanitizedSchemaName !== schema) {
      throw new Error("Invalid schema name");
    }
    const schemaPath = path5.join(process.cwd(), "output", sanitizedSchemaName, "schema.json");
    try {
      const schemaContent = await fs5.readFile(schemaPath, "utf-8");
      return schemaContent.trim();
    } catch (error) {
      throw new Error(
        `Failed to load schema from ${schemaPath}: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }
  /**
   * Parse AI response JSON
   */
  parseAIResponse(response, debugInfo, _schema) {
    log("\u{1F50D} Parsing AI response...");
    log(`\u{1F4CA} Raw response length: ${response.length} characters`);
    if (response.length > 400) {
      log("\u{1F4CB} Response preview (first 200 chars):", response.substring(0, 200));
      log("\u{1F4CB} Response preview (last 200 chars):", response.substring(response.length - 200));
    } else {
      log("\u{1F4CB} Full response preview:", response);
    }
    try {
      let reviewData;
      if (_schema === "plain" || !_schema) {
        log(
          `\u{1F4CB} ${_schema === "plain" ? "Plain" : "No"} schema detected - returning raw response without JSON parsing`
        );
        return {
          issues: [
            {
              file: "AI_RESPONSE",
              line: 1,
              ruleId: "ai/raw_response",
              message: response,
              severity: "info",
              category: "documentation"
            }
          ],
          debug: debugInfo
        };
      }
      {
        log("\u{1F50D} Extracting JSON from AI response...");
        try {
          reviewData = JSON.parse(response.trim());
          log("\u2705 Successfully parsed direct JSON response");
          if (debugInfo) debugInfo.jsonParseSuccess = true;
        } catch {
          log("\u{1F50D} Direct parsing failed, trying to extract JSON from response...");
          if (response.toLowerCase().includes("i cannot") || response.toLowerCase().includes("unable to")) {
            console.error("\u{1F6AB} AI refused to analyze - returning empty result");
            return {
              issues: []
            };
          }
          const jsonString = this.extractJsonFromResponse(response);
          if (jsonString) {
            try {
              reviewData = JSON.parse(jsonString);
              log("\u2705 Successfully parsed extracted JSON");
              if (debugInfo) debugInfo.jsonParseSuccess = true;
            } catch {
              log("\u{1F527} Extracted JSON parsing failed, falling back to plain text handling...");
              if (!response.includes("{") && !response.includes("}")) {
                log("\u{1F527} Plain text response detected, creating structured fallback...");
                reviewData = {
                  issues: [
                    {
                      file: "AI_RESPONSE",
                      line: 1,
                      ruleId: "ai/raw_response",
                      message: response,
                      severity: "info",
                      category: "documentation"
                    }
                  ]
                };
              } else {
                log("\u{1F527} Creating fallback response from non-JSON content...");
                reviewData = {
                  issues: [
                    {
                      file: "AI_RESPONSE",
                      line: 1,
                      ruleId: "ai/raw_response",
                      message: response,
                      severity: "info",
                      category: "documentation"
                    }
                  ]
                };
              }
            }
          } else {
            log("\u{1F527} No JSON found in response, treating as plain text...");
            reviewData = {
              issues: [
                {
                  file: "AI_RESPONSE",
                  line: 1,
                  ruleId: "ai/raw_response",
                  message: response,
                  severity: "info",
                  category: "documentation"
                }
              ]
            };
          }
        }
      }
      const isCustomSchema = _schema === "custom" || _schema && (_schema.startsWith("./") || _schema.endsWith(".json")) || _schema && _schema !== "code-review" && !_schema.includes("output/");
      if (isCustomSchema) {
        log("\u{1F4CB} Custom schema detected - preserving all fields from parsed JSON");
        log(`\u{1F4CA} Schema: ${_schema}`);
        log(`\u{1F4CA} Custom schema keys: ${Object.keys(reviewData).join(", ")}`);
        const result2 = {
          issues: [],
          // Empty array for custom schemas (no code review issues)
          output: reviewData
          // Preserve ALL custom schema fields here
        };
        log("\u2705 Successfully created ReviewSummary with custom schema output");
        return result2;
      }
      log("\u{1F50D} Validating parsed review data...");
      log(`\u{1F4CA} Overall score: ${0}`);
      log(`\u{1F4CB} Total issues: ${reviewData.issues?.length || 0}`);
      log(
        `\u{1F6A8} Critical issues: ${reviewData.issues?.filter((i) => i.severity === "critical").length || 0}`
      );
      log(`\u{1F4AC} Comments count: ${Array.isArray(reviewData.issues) ? reviewData.issues.length : 0}`);
      const processedIssues = Array.isArray(reviewData.issues) ? reviewData.issues.map((issue, index) => {
        log(`\u{1F50D} Processing issue ${index + 1}:`, issue);
        return {
          file: issue.file || "unknown",
          line: issue.line || 1,
          endLine: issue.endLine,
          ruleId: issue.ruleId || `${issue.category || "general"}/unknown`,
          message: issue.message || "",
          severity: issue.severity,
          category: issue.category,
          suggestion: issue.suggestion,
          replacement: issue.replacement
        };
      }) : [];
      const result = {
        issues: processedIssues
      };
      const criticalCount = (result.issues || []).filter((i) => i.severity === "critical").length;
      if (criticalCount > 0) {
        log(`\u{1F6A8} Found ${criticalCount} critical severity issue(s)`);
      }
      log(`\u{1F4C8} Total issues: ${(result.issues || []).length}`);
      log("\u2705 Successfully created ReviewSummary");
      return result;
    } catch (error) {
      console.error("\u274C Failed to parse AI response:", error);
      console.error("\u{1F4C4} FULL RAW RESPONSE:");
      console.error("=".repeat(80));
      console.error(response);
      console.error("=".repeat(80));
      console.error(`\u{1F4CF} Response length: ${response.length} characters`);
      if (error instanceof SyntaxError) {
        console.error("\u{1F50D} JSON parsing error - the response may not be valid JSON");
        console.error("\u{1F50D} Error details:", error.message);
        const errorMatch = error.message.match(/position (\d+)/);
        if (errorMatch) {
          const position = parseInt(errorMatch[1]);
          console.error(`\u{1F50D} Error at position ${position}:`);
          const start = Math.max(0, position - 50);
          const end = Math.min(response.length, position + 50);
          console.error(`\u{1F50D} Context: "${response.substring(start, end)}"`);
          console.error(`\u{1F50D} Response beginning: "${response.substring(0, 100)}"`);
        }
        if (response.includes("I cannot")) {
          console.error("\u{1F50D} Response appears to be a refusal/explanation rather than JSON");
        }
        if (response.includes("```")) {
          console.error("\u{1F50D} Response appears to contain markdown code blocks");
        }
        if (response.startsWith("<")) {
          console.error("\u{1F50D} Response appears to start with XML/HTML");
        }
      }
      throw new Error(
        `Invalid AI response format: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }
  /**
   * Extract JSON from a response that might contain surrounding text
   * Uses proper bracket matching to find valid JSON objects or arrays
   */
  extractJsonFromResponse(response) {
    const text = response.trim();
    let bestJson = this.findJsonWithBracketMatching(text, "{", "}");
    if (!bestJson) {
      bestJson = this.findJsonWithBracketMatching(text, "[", "]");
    }
    return bestJson;
  }
  /**
   * Find JSON with proper bracket matching to avoid false positives
   */
  findJsonWithBracketMatching(text, openChar, closeChar) {
    const firstIndex = text.indexOf(openChar);
    if (firstIndex === -1) return null;
    let depth = 0;
    let inString = false;
    let escaping = false;
    for (let i = firstIndex; i < text.length; i++) {
      const char = text[i];
      if (escaping) {
        escaping = false;
        continue;
      }
      if (char === "\\" && inString) {
        escaping = true;
        continue;
      }
      if (char === '"' && !escaping) {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (char === openChar) {
          depth++;
        } else if (char === closeChar) {
          depth--;
          if (depth === 0) {
            const candidate = text.substring(firstIndex, i + 1);
            try {
              JSON.parse(candidate);
              return candidate;
            } catch {
              break;
            }
          }
        }
      }
    }
    return null;
  }
  /**
   * Generate mock response for testing
   */
  async generateMockResponse(_prompt) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const mockResponse = {
      content: JSON.stringify({
        issues: [
          {
            file: "test.ts",
            line: 7,
            endLine: 11,
            ruleId: "security/sql-injection",
            message: "SQL injection vulnerability detected in dynamic query construction",
            severity: "critical",
            category: "security",
            suggestion: "Use parameterized queries or ORM methods to prevent SQL injection"
          },
          {
            file: "test.ts",
            line: 14,
            endLine: 23,
            ruleId: "performance/nested-loops",
            message: "Inefficient nested loops with O(n\xB2) complexity",
            severity: "warning",
            category: "performance",
            suggestion: "Consider using more efficient algorithms or caching mechanisms"
          },
          {
            file: "test.ts",
            line: 28,
            ruleId: "style/inconsistent-naming",
            message: "Inconsistent variable naming and formatting",
            severity: "info",
            category: "style",
            suggestion: "Use consistent camelCase naming and proper spacing"
          }
        ],
        summary: {
          totalIssues: 3,
          criticalIssues: 1
        }
      })
    };
    return JSON.stringify(mockResponse);
  }
  /**
   * Get the API key source for debugging (without revealing the key)
   */
  getApiKeySource() {
    if (process.env.CLAUDE_CODE_API_KEY && this.config.provider === "claude-code") {
      return "CLAUDE_CODE_API_KEY";
    }
    if (process.env.GOOGLE_API_KEY && this.config.provider === "google") {
      return "GOOGLE_API_KEY";
    }
    if (process.env.ANTHROPIC_API_KEY && this.config.provider === "anthropic") {
      return "ANTHROPIC_API_KEY";
    }
    if (process.env.OPENAI_API_KEY && this.config.provider === "openai") {
      return "OPENAI_API_KEY";
    }
    if (this.config.provider === "bedrock") {
      if (process.env.AWS_BEDROCK_API_KEY) {
        return "AWS_BEDROCK_API_KEY";
      }
      if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
        return "AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY";
      }
    }
    return "unknown";
  }
};

// src/reviewer.ts
var PRReviewer = class {
  constructor(octokit) {
    this.octokit = octokit;
    this.commentManager = new CommentManager(octokit);
    this.aiReviewService = new AIReviewService();
  }
  commentManager;
  aiReviewService;
  async reviewPR(owner, repo, prNumber, prInfo, options = {}) {
    const { debug = false, config, checks } = options;
    if (config && checks && checks.length > 0) {
      const { CheckExecutionEngine: CheckExecutionEngine2 } = await import("./check-execution-engine-DLZBCPUH.mjs");
      const engine = new CheckExecutionEngine2();
      const { results } = await engine.executeGroupedChecks(
        prInfo,
        checks,
        void 0,
        config,
        void 0,
        debug,
        void 0,
        void 0,
        options.tagFilter
      );
      return results;
    }
    throw new Error(
      "No configuration provided. Please create a .visor.yaml file with check definitions. Built-in prompts have been removed - all checks must be explicitly configured."
    );
  }
  async postReviewComment(owner, repo, prNumber, groupedResults, options = {}) {
    for (const [groupName, checkResults] of Object.entries(groupedResults)) {
      const filteredResults = options.config ? checkResults.filter((r) => options.config.checks?.[r.checkName]?.type !== "command") : checkResults;
      if (!filteredResults || filteredResults.length === 0) {
        continue;
      }
      const comment = await this.formatGroupComment(filteredResults, options, {
        owner,
        repo,
        prNumber,
        commitSha: options.commitSha
      });
      let commentId;
      if (groupName === "dynamic") {
        const timestamp = Date.now();
        commentId = `visor-dynamic-${timestamp}`;
      } else {
        commentId = options.commentId ? `${options.commentId}-${groupName}` : `visor-review-${groupName}`;
      }
      if (!comment || !comment.trim()) continue;
      await this.commentManager.updateOrCreateComment(owner, repo, prNumber, comment, {
        commentId,
        triggeredBy: options.triggeredBy || "unknown",
        allowConcurrentUpdates: false,
        commitSha: options.commitSha
      });
    }
  }
  async formatGroupComment(checkResults, _options, _githubContext) {
    let comment = "";
    comment += `## \u{1F50D} Code Analysis Results

`;
    const normalize = (s) => s.replace(/\\n/g, "\n");
    const checkContents = checkResults.map((result) => {
      const trimmed = result.content?.trim();
      if (trimmed) return normalize(trimmed);
      const out = result.output;
      if (out) {
        if (typeof out === "string" && out.trim()) return normalize(out.trim());
        if (typeof out === "object") {
          const txt = out.text || out.response || out.message;
          if (typeof txt === "string" && txt.trim()) return normalize(txt.trim());
        }
      }
      return "";
    }).filter((content) => content && content.trim());
    comment += checkContents.join("\n\n");
    const debugInfo = checkResults.find((result) => result.debug)?.debug;
    if (debugInfo) {
      comment += "\n\n" + this.formatDebugSection(debugInfo);
      comment += "\n\n";
    }
    comment += `

---

*Powered by [Visor](https://probelabs.com/visor) from [Probelabs](https://probelabs.com)*`;
    return comment;
  }
  formatDebugSection(debug) {
    const formattedContent = [
      `**Provider:** ${debug.provider}`,
      `**Model:** ${debug.model}`,
      `**API Key Source:** ${debug.apiKeySource}`,
      `**Processing Time:** ${debug.processingTime}ms`,
      `**Timestamp:** ${debug.timestamp}`,
      `**Prompt Length:** ${debug.promptLength} characters`,
      `**Response Length:** ${debug.responseLength} characters`,
      `**JSON Parse Success:** ${debug.jsonParseSuccess ? "\u2705" : "\u274C"}`
    ];
    if (debug.errors && debug.errors.length > 0) {
      formattedContent.push("", "### Errors");
      debug.errors.forEach((error) => {
        formattedContent.push(`- ${error}`);
      });
    }
    const fullDebugContent = [
      ...formattedContent,
      "",
      "### AI Prompt",
      "```",
      debug.prompt,
      "```",
      "",
      "### Raw AI Response",
      "```json",
      debug.rawResponse,
      "```"
    ].join("\n");
    if (fullDebugContent.length > 6e4) {
      const artifactPath = this.saveDebugArtifact(debug);
      formattedContent.push("");
      formattedContent.push("### Debug Details");
      formattedContent.push("\u26A0\uFE0F Debug information is too large for GitHub comments.");
      if (artifactPath) {
        formattedContent.push(
          `\u{1F4C1} **Full debug information saved to artifact:** \`${artifactPath}\``
        );
        formattedContent.push("");
        const runId = process.env.GITHUB_RUN_ID;
        const repoUrl = process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}` : null;
        if (runId && repoUrl) {
          formattedContent.push(
            `\u{1F517} **Download Link:** [visor-debug-${process.env.GITHUB_RUN_NUMBER || runId}](${repoUrl}/actions/runs/${runId})`
          );
        }
        formattedContent.push(
          "\u{1F4A1} Go to the GitHub Action run above and download the debug artifact to view complete prompts and responses."
        );
      } else {
        formattedContent.push("\u{1F4DD} **Prompt preview:** " + debug.prompt.substring(0, 500) + "...");
        formattedContent.push(
          "\u{1F4DD} **Response preview:** " + debug.rawResponse.substring(0, 500) + "..."
        );
      }
    } else {
      formattedContent.push("");
      formattedContent.push("### AI Prompt");
      formattedContent.push("```");
      formattedContent.push(debug.prompt);
      formattedContent.push("```");
      formattedContent.push("");
      formattedContent.push("### Raw AI Response");
      formattedContent.push("```json");
      formattedContent.push(debug.rawResponse);
      formattedContent.push("```");
    }
    return this.commentManager.createCollapsibleSection(
      "\u{1F41B} Debug Information",
      formattedContent.join("\n"),
      false
    );
  }
  saveDebugArtifact(debug) {
    try {
      const fs5 = __require("fs");
      const path5 = __require("path");
      const debugDir = path5.join(process.cwd(), "debug-artifacts");
      if (!fs5.existsSync(debugDir)) {
        fs5.mkdirSync(debugDir, { recursive: true });
      }
      const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
      const filename = `visor-debug-${timestamp}.md`;
      const filepath = path5.join(debugDir, filename);
      const content = [
        `# Visor Debug Information`,
        ``,
        `**Timestamp:** ${debug.timestamp}`,
        `**Provider:** ${debug.provider}`,
        `**Model:** ${debug.model}`,
        `**Processing Time:** ${debug.processingTime}ms`,
        ``,
        `## AI Prompt`,
        ``,
        "```",
        debug.prompt,
        "```",
        ``,
        `## Raw AI Response`,
        ``,
        "```json",
        debug.rawResponse,
        "```"
      ].join("\n");
      fs5.writeFileSync(filepath, content, "utf8");
      return filename;
    } catch (error) {
      console.error("Failed to save debug artifact:", error);
      return null;
    }
  }
};

// src/git-repository-analyzer.ts
import { simpleGit } from "simple-git";
import * as path from "path";
import * as fs from "fs";
var GitRepositoryAnalyzer = class {
  git;
  cwd;
  constructor(workingDirectory = process.cwd()) {
    this.cwd = workingDirectory;
    this.git = simpleGit(workingDirectory);
  }
  /**
   * Analyze the current git repository state and return data compatible with PRInfo interface
   */
  async analyzeRepository(includeContext = true) {
    const isRepo = await this.isGitRepository();
    if (!isRepo) {
      return this.createEmptyRepositoryInfo("Not a git repository");
    }
    try {
      const [status, currentBranch] = await Promise.all([
        this.git.status(),
        this.getCurrentBranch()
      ]);
      const uncommittedFiles = await this.getUncommittedChanges(includeContext);
      let lastCommit = null;
      try {
        const recentCommits = await this.git.log({ maxCount: 1 });
        lastCommit = recentCommits.latest;
      } catch {
        console.log("\u{1F4DD} Repository has no commits yet, analyzing uncommitted changes");
      }
      let author = lastCommit?.author_name;
      if (!author) {
        try {
          const [userName, userEmail] = await Promise.all([
            this.git.raw(["config", "--local", "user.name"]).catch(() => null),
            this.git.raw(["config", "--local", "user.email"]).catch(() => null)
          ]);
          author = userName?.trim() || userEmail?.trim() || "unknown";
        } catch {
          author = "unknown";
        }
      }
      const repositoryInfo = {
        title: this.generateTitle(status, currentBranch),
        body: this.generateDescription(status, lastCommit),
        author,
        base: await this.getBaseBranch(),
        head: currentBranch,
        files: uncommittedFiles,
        totalAdditions: uncommittedFiles.reduce((sum, file) => sum + file.additions, 0),
        totalDeletions: uncommittedFiles.reduce((sum, file) => sum + file.deletions, 0),
        isGitRepository: true,
        workingDirectory: this.cwd
      };
      return repositoryInfo;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      console.error("Error analyzing git repository:", errorMessage);
      return this.createEmptyRepositoryInfo("Error analyzing git repository");
    }
  }
  /**
   * Convert GitRepositoryInfo to PRInfo format for compatibility with existing PRReviewer
   */
  toPRInfo(repositoryInfo, includeContext = true) {
    const files = repositoryInfo.files.map(
      (file) => ({
        filename: file.filename,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        patch: includeContext ? file.patch : void 0,
        status: file.status
      })
    );
    let fullDiff;
    if (includeContext) {
      fullDiff = files.filter((file) => file.patch).map((file) => `--- ${file.filename}
${file.patch}`).join("\n\n");
    }
    return {
      number: 0,
      // Local analysis doesn't have PR number
      title: repositoryInfo.title,
      body: repositoryInfo.body,
      author: repositoryInfo.author,
      base: repositoryInfo.base,
      head: repositoryInfo.head,
      files,
      totalAdditions: repositoryInfo.totalAdditions,
      totalDeletions: repositoryInfo.totalDeletions,
      fullDiff
    };
  }
  async isGitRepository() {
    try {
      await this.git.checkIsRepo();
      return true;
    } catch {
      return false;
    }
  }
  async getCurrentBranch() {
    try {
      const branchSummary = await this.git.branch();
      return branchSummary.current || "unknown";
    } catch {
      return "unknown";
    }
  }
  async getBaseBranch() {
    try {
      const branches = await this.git.branch(["-r"]);
      const mainBranches = ["origin/main", "origin/master", "origin/develop"];
      for (const mainBranch of mainBranches) {
        if (branches.all.includes(mainBranch)) {
          return mainBranch.replace("origin/", "");
        }
      }
      return "main";
    } catch {
      return "main";
    }
  }
  async getRemoteInfo() {
    try {
      const remotes = await this.git.getRemotes(true);
      const origin = remotes.find((r) => r.name === "origin");
      return origin ? { name: origin.name, url: origin.refs.fetch || origin.refs.push || "" } : null;
    } catch {
      return null;
    }
  }
  async getUncommittedChanges(includeContext = true) {
    try {
      const status = await this.git.status();
      const changes = [];
      const fileChanges = [
        ...status.created.map((f) => ({ file: f, status: "added" })),
        ...status.deleted.map((f) => ({ file: f, status: "removed" })),
        ...status.modified.map((f) => ({ file: f, status: "modified" })),
        ...status.renamed.map((f) => ({
          file: typeof f === "string" ? f : f.to || f.from,
          status: "renamed"
        }))
      ];
      for (const { file, status: status2 } of fileChanges) {
        const filePath = path.join(this.cwd, file);
        const fileChange = await this.analyzeFileChange(file, status2, filePath, includeContext);
        changes.push(fileChange);
      }
      return changes;
    } catch (error) {
      console.error("Error getting uncommitted changes:", error);
      return [];
    }
  }
  async analyzeFileChange(filename, status, filePath, includeContext = true) {
    let additions = 0;
    let deletions = 0;
    let patch;
    let content;
    try {
      if (includeContext && status !== "added" && fs.existsSync(filePath)) {
        const diff = await this.git.diff(["--", filename]).catch(() => "");
        if (diff) {
          patch = diff;
          const lines = diff.split("\n");
          additions = lines.filter((line) => line.startsWith("+")).length;
          deletions = lines.filter((line) => line.startsWith("-")).length;
        }
      } else if (status !== "added" && fs.existsSync(filePath)) {
        const diff = await this.git.diff(["--", filename]).catch(() => "");
        if (diff) {
          const lines = diff.split("\n");
          additions = lines.filter((line) => line.startsWith("+")).length;
          deletions = lines.filter((line) => line.startsWith("-")).length;
        }
      }
      if (status === "added" && fs.existsSync(filePath)) {
        try {
          const stats = fs.statSync(filePath);
          if (stats.isFile() && stats.size < 1024 * 1024) {
            if (includeContext) {
              content = fs.readFileSync(filePath, "utf8");
              patch = content;
            }
            const fileContent = includeContext ? content : fs.readFileSync(filePath, "utf8");
            additions = fileContent.split("\n").length;
          }
        } catch {
        }
      }
      if (status === "removed") {
        deletions = 1;
      }
    } catch (error) {
      console.error(`Error analyzing file change for ${filename}:`, error);
    }
    return {
      filename,
      status,
      additions,
      deletions,
      changes: additions + deletions,
      content,
      patch
    };
  }
  generateTitle(status, branch) {
    if (status.files.length === 0) {
      return `Local Analysis: ${branch} (No changes)`;
    }
    const changeTypes = [];
    if (status.created.length > 0) changeTypes.push(`${status.created.length} added`);
    if (status.modified.length > 0) changeTypes.push(`${status.modified.length} modified`);
    if (status.deleted.length > 0) changeTypes.push(`${status.deleted.length} deleted`);
    if (status.renamed.length > 0) changeTypes.push(`${status.renamed.length} renamed`);
    return `Local Analysis: ${branch} (${changeTypes.join(", ")})`;
  }
  generateDescription(status, lastCommit) {
    let description = `Analysis of local git repository working directory.

`;
    if (lastCommit) {
      description += `**Last Commit:** ${lastCommit.message}
`;
      description += `**Author:** ${lastCommit.author_name} <${lastCommit.author_email}>
`;
      description += `**Date:** ${lastCommit.date}

`;
    }
    if (status.files.length === 0) {
      description += `**Status:** Working directory is clean - no uncommitted changes found.
`;
    } else {
      description += `**Changes Summary:**
`;
      description += `- Files to be committed: ${status.staged.length}
`;
      description += `- Modified files: ${status.modified.length}
`;
      description += `- Untracked files: ${status.not_added.length}
`;
      if (status.conflicted.length > 0) {
        description += `- Conflicted files: ${status.conflicted.length}
`;
      }
    }
    return description;
  }
  createEmptyRepositoryInfo(reason) {
    return {
      title: `Local Analysis: ${reason}`,
      body: `Unable to analyze repository: ${reason}`,
      author: "system",
      base: "main",
      head: "HEAD",
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
      isGitRepository: false,
      workingDirectory: this.cwd
    };
  }
};

// src/pr-analyzer.ts
var PRAnalyzer = class {
  constructor(octokit, maxRetries = 3) {
    this.octokit = octokit;
    this.maxRetries = maxRetries;
  }
  /**
   * Fetch commit diff for incremental analysis
   */
  async fetchCommitDiff(owner, repo, commitSha) {
    try {
      const { data: commit } = await this.withRetry(
        () => this.octokit.rest.repos.getCommit({
          owner,
          repo,
          ref: commitSha
        })
      );
      const patches = commit.files?.filter((file) => file.patch).map((file) => `--- ${file.filename}
${file.patch}`).join("\n\n") || "";
      return patches;
    } catch (error) {
      console.warn(`Failed to fetch commit diff for ${commitSha}:`, error);
      return "";
    }
  }
  /**
   * Generate unified diff for all PR files
   */
  generateFullDiff(files) {
    return files.filter((file) => file.patch).map((file) => `--- ${file.filename}
${file.patch}`).join("\n\n");
  }
  async fetchPRDiff(owner, repo, prNumber, commitSha, eventType) {
    const [prData, filesData] = await Promise.all([
      this.withRetry(
        () => this.octokit.rest.pulls.get({
          owner,
          repo,
          pull_number: prNumber
        })
      ),
      this.withRetry(
        () => this.octokit.rest.pulls.listFiles({
          owner,
          repo,
          pull_number: prNumber
        })
      )
    ]);
    const pr = prData?.data;
    const files = filesData?.data || [];
    if (!pr) {
      throw new Error("Invalid or missing pull request data");
    }
    const title = typeof pr.title === "string" ? pr.title : pr.title ? String(pr.title) : "MISSING";
    const body = typeof pr.body === "string" ? pr.body : pr.body ? String(pr.body) : "";
    const author = pr.user && typeof pr.user === "object" && pr.user.login ? typeof pr.user.login === "string" ? pr.user.login : String(pr.user.login) : "unknown";
    const authorAssociation = pr.author_association && typeof pr.author_association === "string" ? pr.author_association : void 0;
    const base = pr.base && typeof pr.base === "object" && pr.base.ref ? typeof pr.base.ref === "string" ? pr.base.ref : String(pr.base.ref) : "main";
    const head = pr.head && typeof pr.head === "object" && pr.head.ref ? typeof pr.head.ref === "string" ? pr.head.ref : String(pr.head.ref) : "feature";
    const validFiles = files ? files.filter((file) => file && typeof file === "object" && file.filename).map((file) => ({
      filename: typeof file.filename === "string" ? file.filename : String(file.filename || "unknown"),
      additions: typeof file.additions === "number" ? Math.max(0, file.additions) : 0,
      deletions: typeof file.deletions === "number" ? Math.max(0, file.deletions) : 0,
      changes: typeof file.changes === "number" ? Math.max(0, file.changes) : 0,
      patch: typeof file.patch === "string" ? file.patch : void 0,
      status: ["added", "removed", "modified", "renamed"].includes(file.status) ? file.status : "modified"
    })).filter((file) => file.filename.length > 0) : [];
    const prInfo = {
      number: typeof pr.number === "number" ? pr.number : parseInt(String(pr.number || 1), 10),
      title,
      body,
      author,
      authorAssociation,
      base,
      head,
      files: validFiles,
      totalAdditions: validFiles.reduce((sum, file) => sum + file.additions, 0),
      totalDeletions: validFiles.reduce((sum, file) => sum + file.deletions, 0),
      fullDiff: this.generateFullDiff(validFiles),
      eventType
    };
    try {
      console.log(`\u{1F4AC} Fetching comment history for PR #${prInfo.number}`);
      const comments = await this.fetchPRComments(owner, repo, prInfo.number);
      prInfo.comments = comments;
      console.log(`\u2705 Retrieved ${comments.length} comments`);
    } catch (error) {
      console.warn(
        `\u26A0\uFE0F Could not fetch comments: ${error instanceof Error ? error.message : "Unknown error"}`
      );
      prInfo.comments = [];
    }
    if (commitSha) {
      console.log(`\u{1F527} Fetching incremental diff for commit: ${commitSha}`);
      prInfo.commitDiff = await this.fetchCommitDiff(owner, repo, commitSha);
      prInfo.isIncremental = true;
      if (!prInfo.commitDiff || prInfo.commitDiff.length === 0) {
        console.warn(
          `\u26A0\uFE0F No commit diff retrieved for ${commitSha}, will use full diff as fallback`
        );
      } else {
        console.log(`\u2705 Incremental diff retrieved (${prInfo.commitDiff.length} chars)`);
      }
    } else {
      prInfo.isIncremental = false;
    }
    return prInfo;
  }
  async fetchPRComments(owner, repo, prNumber) {
    const { data: comments } = await this.withRetry(
      () => this.octokit.rest.issues.listComments({
        owner,
        repo,
        issue_number: prNumber
      })
    );
    return comments.map((comment) => ({
      id: comment.id,
      author: comment.user?.login || "unknown",
      body: comment.body || "",
      createdAt: comment.created_at,
      updatedAt: comment.updated_at
    }));
  }
  async withRetry(operation) {
    let lastError = new Error("Unknown error");
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        if (error instanceof Error) {
          lastError = error;
        } else if (typeof error === "object" && error !== null) {
          const errorObj = error;
          const message = errorObj.message || errorObj.code || "Unknown error";
          lastError = new Error(String(message));
          Object.assign(lastError, error);
        } else {
          lastError = new Error(String(error));
        }
        if (attempt === this.maxRetries) {
          break;
        }
        if (this.isRetryableError(error)) {
          const delay = Math.min(1e3 * Math.pow(2, attempt), 5e3);
          await new Promise((resolve) => setTimeout(resolve, delay));
        } else {
          throw error;
        }
      }
    }
    throw lastError;
  }
  isRetryableError(error) {
    const retryableErrors = ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN"];
    const retryableStatuses = [408, 429, 500, 502, 503, 504];
    if (typeof error !== "object" || error === null) {
      return false;
    }
    const err = error;
    return err.code !== void 0 && retryableErrors.includes(err.code) || err.status !== void 0 && retryableStatuses.includes(err.status) || err.response?.status !== void 0 && retryableStatuses.includes(err.response.status);
  }
};

// src/providers/check-provider.interface.ts
var CheckProvider = class {
};

// src/utils/env-resolver.ts
var EnvironmentResolver = class {
  /**
   * Resolves a single configuration value that may contain environment variable references
   */
  static resolveValue(value) {
    if (typeof value !== "string") {
      return value;
    }
    let resolved = value.replace(/\$\{\{\s*env\.([A-Z_][A-Z0-9_]*)\s*\}\}/g, (match, envVar) => {
      return process.env[envVar] || match;
    });
    resolved = resolved.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (match, envVar) => {
      return process.env[envVar] || match;
    });
    resolved = resolved.replace(/\$([A-Z_][A-Z0-9_]*)/g, (match, envVar) => {
      return process.env[envVar] || match;
    });
    return resolved;
  }
  /**
   * Resolves all environment variables in an EnvConfig object
   */
  static resolveEnvConfig(envConfig) {
    const resolved = {};
    for (const [key, value] of Object.entries(envConfig)) {
      resolved[key] = this.resolveValue(value);
    }
    return resolved;
  }
  /**
   * Applies environment configuration to the process environment
   * This allows checks to access their specific environment variables
   */
  static applyEnvConfig(envConfig) {
    const resolved = this.resolveEnvConfig(envConfig);
    for (const [key, value] of Object.entries(resolved)) {
      if (value !== void 0) {
        process.env[key] = String(value);
      }
    }
  }
  /**
   * Creates a temporary environment for a specific check execution
   * Returns a cleanup function to restore the original environment
   */
  static withTemporaryEnv(envConfig, callback) {
    const resolved = this.resolveEnvConfig(envConfig);
    const originalValues = {};
    for (const [key, value] of Object.entries(resolved)) {
      originalValues[key] = process.env[key];
      if (value !== void 0) {
        process.env[key] = String(value);
      }
    }
    try {
      const result = callback();
      if (result instanceof Promise) {
        return result.finally(() => {
          for (const [key, originalValue] of Object.entries(originalValues)) {
            if (originalValue === void 0) {
              delete process.env[key];
            } else {
              process.env[key] = originalValue;
            }
          }
        });
      }
      for (const [key, originalValue] of Object.entries(originalValues)) {
        if (originalValue === void 0) {
          delete process.env[key];
        } else {
          process.env[key] = originalValue;
        }
      }
      return result;
    } catch (error) {
      for (const [key, originalValue] of Object.entries(originalValues)) {
        if (originalValue === void 0) {
          delete process.env[key];
        } else {
          process.env[key] = originalValue;
        }
      }
      throw error;
    }
  }
  /**
   * Validates that all required environment variables are available
   */
  static validateRequiredEnvVars(envConfig, requiredVars) {
    const resolved = this.resolveEnvConfig(envConfig);
    const missing = [];
    for (const varName of requiredVars) {
      const value = resolved[varName] || process.env[varName];
      if (!value) {
        missing.push(varName);
      }
    }
    return missing;
  }
};

// src/issue-filter.ts
import * as fs2 from "fs";
import * as path2 from "path";
var IssueFilter = class {
  fileCache = /* @__PURE__ */ new Map();
  suppressionEnabled;
  constructor(suppressionEnabled = true) {
    this.suppressionEnabled = suppressionEnabled;
  }
  /**
   * Filter out issues that have suppression comments
   * @param issues Array of issues to filter
   * @param workingDir Working directory for resolving file paths
   * @returns Filtered array of issues with suppressed ones removed
   */
  filterIssues(issues, workingDir = process.cwd()) {
    if (!this.suppressionEnabled || !issues || issues.length === 0) {
      return issues;
    }
    const filteredIssues = [];
    const suppressedCount = {};
    for (const issue of issues) {
      if (this.shouldSuppressIssue(issue, workingDir)) {
        suppressedCount[issue.file] = (suppressedCount[issue.file] || 0) + 1;
      } else {
        filteredIssues.push(issue);
      }
    }
    const totalSuppressed = Object.values(suppressedCount).reduce((sum, count) => sum + count, 0);
    if (totalSuppressed > 0) {
      console.log(`\u{1F507} Suppressed ${totalSuppressed} issue(s) via visor-disable comments:`);
      for (const [file, count] of Object.entries(suppressedCount)) {
        console.log(`   - ${file}: ${count} issue(s)`);
      }
    }
    return filteredIssues;
  }
  /**
   * Check if an issue should be suppressed based on comments in the file
   */
  shouldSuppressIssue(issue, workingDir) {
    if (!issue.file || issue.file === "system" || issue.file === "webhook" || issue.line === 0) {
      return false;
    }
    const lines = this.getFileLines(issue.file, workingDir);
    if (!lines || lines.length === 0) {
      return false;
    }
    const firstFiveLines = lines.slice(0, 5).join("\n").toLowerCase();
    if (firstFiveLines.includes("visor-disable-file")) {
      return true;
    }
    const lineIndex = issue.line - 1;
    const startLine = Math.max(0, lineIndex - 2);
    const endLine = Math.min(lines.length - 1, lineIndex + 2);
    for (let i = startLine; i <= endLine; i++) {
      if (lines[i].toLowerCase().includes("visor-disable")) {
        return true;
      }
    }
    return false;
  }
  /**
   * Get file lines from cache or read from disk
   */
  getFileLines(filePath, workingDir) {
    if (this.fileCache.has(filePath)) {
      return this.fileCache.get(filePath);
    }
    try {
      const resolvedPath = path2.isAbsolute(filePath) ? filePath : path2.join(workingDir, filePath);
      if (!fs2.existsSync(resolvedPath)) {
        if (fs2.existsSync(filePath)) {
          const content2 = fs2.readFileSync(filePath, "utf8");
          const lines2 = content2.split("\n");
          this.fileCache.set(filePath, lines2);
          return lines2;
        }
        return null;
      }
      const content = fs2.readFileSync(resolvedPath, "utf8");
      const lines = content.split("\n");
      this.fileCache.set(filePath, lines);
      return lines;
    } catch {
      return null;
    }
  }
  /**
   * Clear the file cache (useful for testing or long-running processes)
   */
  clearCache() {
    this.fileCache.clear();
  }
};

// src/providers/ai-check-provider.ts
import fs3 from "fs/promises";
import path3 from "path";
var AICheckProvider = class extends CheckProvider {
  aiReviewService;
  liquidEngine;
  constructor() {
    super();
    this.aiReviewService = new AIReviewService();
    this.liquidEngine = createExtendedLiquid();
  }
  getName() {
    return "ai";
  }
  getDescription() {
    return "AI-powered code review using Google Gemini, Anthropic Claude, OpenAI GPT, or AWS Bedrock models";
  }
  async validateConfig(config) {
    if (!config || typeof config !== "object") {
      return false;
    }
    const cfg = config;
    if (cfg.type !== "ai") {
      return false;
    }
    const prompt = cfg.prompt || cfg.focus;
    if (typeof prompt !== "string") {
      return false;
    }
    if (cfg.focus && !["security", "performance", "style", "all"].includes(cfg.focus)) {
      return false;
    }
    if (cfg.ai) {
      if (cfg.ai.provider && !["google", "anthropic", "openai", "bedrock", "mock"].includes(cfg.ai.provider)) {
        return false;
      }
      if (cfg.ai.mcpServers) {
        if (!this.validateMcpServers(cfg.ai.mcpServers)) {
          return false;
        }
      }
    }
    const checkLevelMcpServers = cfg.ai_mcp_servers;
    if (checkLevelMcpServers) {
      if (!this.validateMcpServers(checkLevelMcpServers)) {
        return false;
      }
    }
    return true;
  }
  /**
   * Validate MCP servers configuration
   */
  validateMcpServers(mcpServers) {
    if (typeof mcpServers !== "object" || mcpServers === null) {
      return false;
    }
    for (const serverConfig of Object.values(mcpServers)) {
      if (!serverConfig || typeof serverConfig !== "object") {
        return false;
      }
      const config = serverConfig;
      if (typeof config.command !== "string") {
        return false;
      }
      if (config.args !== void 0 && !Array.isArray(config.args)) {
        return false;
      }
    }
    return true;
  }
  /**
   * Group files by their file extension for template context
   */
  groupFilesByExtension(files) {
    const grouped = {};
    files.forEach((file) => {
      const parts = file.filename.split(".");
      const ext = parts.length > 1 ? parts.pop()?.toLowerCase() || "noext" : "noext";
      if (!grouped[ext]) {
        grouped[ext] = [];
      }
      grouped[ext].push(file);
    });
    return grouped;
  }
  /**
   * Process prompt configuration to resolve final prompt string
   */
  async processPrompt(promptConfig, prInfo, eventContext, dependencyResults) {
    let promptContent;
    if (await this.isFilePath(promptConfig)) {
      promptContent = await this.loadPromptFromFile(promptConfig);
    } else {
      promptContent = promptConfig;
    }
    return await this.renderPromptTemplate(promptContent, prInfo, eventContext, dependencyResults);
  }
  /**
   * Detect if a string is likely a file path and if the file exists
   */
  async isFilePath(str) {
    if (!str || str.trim() !== str || str.length > 512) {
      return false;
    }
    if (/\s{2,}/.test(str) || // Multiple consecutive spaces
    /\n/.test(str) || // Contains newlines
    /^(please|analyze|review|check|find|identify|look|search)/i.test(str.trim()) || // Starts with command words
    str.split(" ").length > 8) {
      return false;
    }
    if (!/[\/\\]/.test(str)) {
      if (/\b(the|and|or|but|for|with|by|from|in|on|at|as)\b/i.test(str)) {
        return false;
      }
    }
    const hasFileExtension = /\.[a-zA-Z0-9]{1,10}$/i.test(str);
    const hasPathSeparators = /[\/\\]/.test(str);
    const isRelativePath = /^\.{1,2}\//.test(str);
    const isAbsolutePath = path3.isAbsolute(str);
    const hasTypicalFileChars = /^[a-zA-Z0-9._\-\/\\:~]+$/.test(str);
    if (!(hasFileExtension || isRelativePath || isAbsolutePath || hasPathSeparators)) {
      return false;
    }
    if (!hasTypicalFileChars) {
      return false;
    }
    try {
      let resolvedPath;
      if (path3.isAbsolute(str)) {
        resolvedPath = path3.normalize(str);
      } else {
        resolvedPath = path3.resolve(process.cwd(), str);
      }
      const fs5 = __require("fs").promises;
      try {
        const stat = await fs5.stat(resolvedPath);
        return stat.isFile();
      } catch {
        return hasFileExtension && (isRelativePath || isAbsolutePath || hasPathSeparators);
      }
    } catch {
      return false;
    }
  }
  /**
   * Load prompt content from file with security validation
   */
  async loadPromptFromFile(promptPath) {
    if (!promptPath.endsWith(".liquid")) {
      throw new Error("Prompt file must have .liquid extension");
    }
    let resolvedPath;
    if (path3.isAbsolute(promptPath)) {
      resolvedPath = promptPath;
    } else {
      resolvedPath = path3.resolve(process.cwd(), promptPath);
    }
    if (!path3.isAbsolute(promptPath)) {
      const normalizedPath = path3.normalize(resolvedPath);
      const currentDir = path3.resolve(process.cwd());
      if (!normalizedPath.startsWith(currentDir)) {
        throw new Error("Invalid prompt file path: path traversal detected");
      }
    }
    if (promptPath.includes("../..")) {
      throw new Error("Invalid prompt file path: path traversal detected");
    }
    try {
      const promptContent = await fs3.readFile(resolvedPath, "utf-8");
      return promptContent;
    } catch (error) {
      throw new Error(
        `Failed to load prompt from ${resolvedPath}: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }
  /**
   * Render Liquid template in prompt with comprehensive event context
   */
  async renderPromptTemplate(promptContent, prInfo, eventContext, dependencyResults) {
    const templateContext = {
      // PR Information
      pr: {
        number: prInfo.number,
        title: prInfo.title,
        body: prInfo.body,
        author: prInfo.author,
        baseBranch: prInfo.base,
        headBranch: prInfo.head,
        isIncremental: prInfo.isIncremental,
        filesChanged: prInfo.files?.map((f) => f.filename) || [],
        totalAdditions: prInfo.files?.reduce((sum, f) => sum + f.additions, 0) || 0,
        totalDeletions: prInfo.files?.reduce((sum, f) => sum + f.deletions, 0) || 0,
        totalChanges: prInfo.files?.reduce((sum, f) => sum + f.changes, 0) || 0,
        base: prInfo.base,
        head: prInfo.head
      },
      // File Details
      files: prInfo.files || [],
      description: prInfo.body || "",
      // GitHub Event Context
      event: eventContext ? {
        name: eventContext.event_name || "unknown",
        action: eventContext.action,
        isPullRequest: !prInfo.isIssue,
        // Set based on whether this is a PR or an issue
        // Repository Info
        repository: eventContext.repository ? {
          owner: eventContext.repository?.owner?.login,
          name: eventContext.repository?.name,
          fullName: eventContext.repository ? `${eventContext.repository?.owner?.login}/${eventContext.repository?.name}` : void 0
        } : void 0,
        // Comment Data (for comment events)
        comment: eventContext.comment ? {
          body: eventContext.comment?.body,
          author: eventContext.comment?.user?.login
        } : void 0,
        // Issue Data (for issue events)
        issue: eventContext.issue ? {
          number: eventContext.issue?.number,
          title: eventContext.issue?.title,
          body: eventContext.issue?.body,
          state: eventContext.issue?.state,
          author: eventContext.issue?.user?.login,
          labels: eventContext.issue?.labels || [],
          assignees: eventContext?.issue?.assignees?.map((a) => a.login) || [],
          createdAt: eventContext.issue?.created_at,
          updatedAt: eventContext.issue?.updated_at,
          isPullRequest: !!eventContext.issue?.pull_request
        } : void 0,
        // Pull Request Event Data
        pullRequest: eventContext.pull_request ? {
          number: eventContext.pull_request?.number,
          state: eventContext.pull_request?.state,
          draft: eventContext.pull_request?.draft,
          headSha: eventContext.pull_request?.head?.sha,
          headRef: eventContext.pull_request?.head?.ref,
          baseSha: eventContext.pull_request?.base?.sha,
          baseRef: eventContext.pull_request?.base?.ref
        } : void 0,
        // Raw event payload for advanced use cases
        payload: eventContext
      } : void 0,
      // Utility data for templates
      utils: {
        // Date/time helpers
        now: (/* @__PURE__ */ new Date()).toISOString(),
        today: (/* @__PURE__ */ new Date()).toISOString().split("T")[0],
        // Dynamic file grouping by extension
        filesByExtension: this.groupFilesByExtension(prInfo.files || []),
        // File status categorizations
        addedFiles: (prInfo.files || []).filter((f) => f.status === "added"),
        modifiedFiles: (prInfo.files || []).filter((f) => f.status === "modified"),
        removedFiles: (prInfo.files || []).filter((f) => f.status === "removed"),
        renamedFiles: (prInfo.files || []).filter((f) => f.status === "renamed"),
        // Change analysis
        hasLargeChanges: (prInfo.files || []).some((f) => f.changes > 50),
        totalFiles: (prInfo.files || []).length
      },
      // Previous check outputs (dependency results)
      // Expose raw output directly if available, otherwise expose the result as-is
      outputs: dependencyResults ? Object.fromEntries(
        Array.from(dependencyResults.entries()).map(([checkName, result]) => [
          checkName,
          (() => {
            const summary = result;
            return summary.output !== void 0 ? summary.output : summary;
          })()
        ])
      ) : {}
    };
    try {
      return await this.liquidEngine.parseAndRender(promptContent, templateContext);
    } catch (error) {
      throw new Error(
        `Failed to render prompt template: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }
  async execute(prInfo, config, _dependencyResults, sessionInfo) {
    if (config.env) {
      const result = EnvironmentResolver.withTemporaryEnv(config.env, () => {
        return this.executeWithConfig(prInfo, config, _dependencyResults, sessionInfo);
      });
      if (result instanceof Promise) {
        return result;
      }
      return result;
    }
    return this.executeWithConfig(prInfo, config, _dependencyResults, sessionInfo);
  }
  async executeWithConfig(prInfo, config, _dependencyResults, sessionInfo) {
    const aiConfig = {};
    if (config.ai) {
      if (config.ai.apiKey !== void 0) {
        aiConfig.apiKey = config.ai.apiKey;
      }
      if (config.ai.model !== void 0) {
        aiConfig.model = config.ai.model;
      }
      if (config.ai.timeout !== void 0) {
        aiConfig.timeout = config.ai.timeout;
      }
      if (config.ai.provider !== void 0) {
        aiConfig.provider = config.ai.provider;
      }
      if (config.ai.debug !== void 0) {
        aiConfig.debug = config.ai.debug;
      }
    }
    if (config.ai_model !== void 0) {
      aiConfig.model = config.ai_model;
    }
    if (config.ai_provider !== void 0) {
      aiConfig.provider = config.ai_provider;
    }
    const customPrompt = config.prompt;
    if (!customPrompt) {
      throw new Error(
        `No prompt defined for check. All checks must have prompts defined in .visor.yaml configuration.`
      );
    }
    const mcpServers = {};
    const globalConfig = config;
    if (globalConfig.ai_mcp_servers) {
      Object.assign(mcpServers, globalConfig.ai_mcp_servers);
    }
    if (config.ai_mcp_servers) {
      Object.assign(mcpServers, config.ai_mcp_servers);
    }
    if (config.ai?.mcpServers) {
      Object.assign(mcpServers, config.ai.mcpServers);
    }
    if (Object.keys(mcpServers).length > 0) {
      aiConfig.mcpServers = mcpServers;
      if (aiConfig.debug) {
        console.error(
          `\u{1F527} Debug: AI check MCP configured with ${Object.keys(mcpServers).length} servers`
        );
      }
    }
    const processedPrompt = await this.processPrompt(
      customPrompt,
      prInfo,
      config.eventContext,
      _dependencyResults
    );
    const service = new AIReviewService(aiConfig);
    const schema = config.schema;
    if (aiConfig.debug) {
      console.error(
        `\u{1F527} Debug: AICheckProvider using processed prompt: ${processedPrompt.substring(0, 100)}...`
      );
      console.error(`\u{1F527} Debug: AICheckProvider schema from config: ${JSON.stringify(schema)}`);
      console.error(`\u{1F527} Debug: AICheckProvider full config: ${JSON.stringify(config, null, 2)}`);
    }
    try {
      if (aiConfig.debug) {
        console.error(
          `\u{1F527} Debug: AICheckProvider passing checkName: ${config.checkName} to service`
        );
      }
      let result;
      if (sessionInfo?.reuseSession && sessionInfo.parentSessionId) {
        const sessionMode = config.session_mode || "clone";
        if (aiConfig.debug) {
          console.error(
            `\u{1F504} Debug: Using session reuse with parent session: ${sessionInfo.parentSessionId} (mode: ${sessionMode})`
          );
        }
        result = await service.executeReviewWithSessionReuse(
          prInfo,
          processedPrompt,
          sessionInfo.parentSessionId,
          schema,
          config.checkName,
          sessionMode
        );
      } else {
        if (aiConfig.debug) {
          console.error(`\u{1F195} Debug: Creating new AI session for check: ${config.checkName}`);
        }
        result = await service.executeReview(
          prInfo,
          processedPrompt,
          schema,
          config.checkName,
          config.sessionId
        );
      }
      const suppressionEnabled = config.suppressionEnabled !== false;
      const issueFilter = new IssueFilter(suppressionEnabled);
      const filteredIssues = issueFilter.filterIssues(result.issues || [], process.cwd());
      return {
        ...result,
        issues: filteredIssues
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`\u274C AI Check Provider Error for check: ${errorMessage}`);
      const isCriticalError = errorMessage.includes("API rate limit") || errorMessage.includes("403") || errorMessage.includes("401") || errorMessage.includes("authentication") || errorMessage.includes("API key");
      if (isCriticalError) {
        console.error(`\u{1F6A8} CRITICAL ERROR: AI provider authentication or rate limit issue detected`);
        console.error(`\u{1F6A8} This check cannot proceed without valid API credentials`);
      }
      throw new Error(`AI analysis failed: ${errorMessage}`);
    }
  }
  getSupportedConfigKeys() {
    return [
      "type",
      "prompt",
      "focus",
      "schema",
      "group",
      "ai.provider",
      "ai.model",
      "ai.apiKey",
      "ai.timeout",
      "ai.mcpServers",
      "ai_model",
      "ai_provider",
      "ai_mcp_servers",
      "env"
    ];
  }
  async isAvailable() {
    return !!(process.env.GOOGLE_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || // AWS Bedrock credentials check
    process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY || process.env.AWS_BEDROCK_API_KEY);
  }
  getRequirements() {
    return [
      "At least one of: GOOGLE_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, or AWS credentials (AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY)",
      "Optional: MODEL_NAME environment variable",
      "Optional: AWS_REGION for Bedrock provider",
      "Network access to AI provider APIs"
    ];
  }
};

// src/providers/http-check-provider.ts
var HttpCheckProvider = class extends CheckProvider {
  liquid;
  constructor() {
    super();
    this.liquid = createExtendedLiquid();
  }
  getName() {
    return "http";
  }
  getDescription() {
    return "Send data to external HTTP endpoint for notifications or integration";
  }
  async validateConfig(config) {
    if (!config || typeof config !== "object") {
      return false;
    }
    const cfg = config;
    if (cfg.type !== "http") {
      return false;
    }
    if (typeof cfg.url !== "string" || !cfg.url) {
      return false;
    }
    if (typeof cfg.body !== "string" || !cfg.body) {
      return false;
    }
    try {
      new URL(cfg.url);
      return true;
    } catch {
      return false;
    }
  }
  async execute(prInfo, config, dependencyResults, _sessionInfo) {
    const url = config.url;
    const bodyTemplate = config.body;
    const method = config.method || "POST";
    const headers = config.headers || {};
    const timeout = config.timeout || 3e4;
    const templateContext = {
      pr: {
        number: prInfo.number,
        title: prInfo.title,
        body: prInfo.body,
        author: prInfo.author,
        base: prInfo.base,
        head: prInfo.head,
        totalAdditions: prInfo.totalAdditions,
        totalDeletions: prInfo.totalDeletions
      },
      files: prInfo.files.map((f) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.changes,
        patch: f.patch
      })),
      outputs: dependencyResults ? Object.fromEntries(dependencyResults) : {},
      metadata: config.metadata || {}
    };
    let payload;
    try {
      const renderedBody = await this.liquid.parseAndRender(bodyTemplate, templateContext);
      try {
        payload = JSON.parse(renderedBody);
      } catch {
        payload = { message: renderedBody };
      }
    } catch (error) {
      return this.createErrorResult(
        url,
        new Error(
          `Template rendering failed: ${error instanceof Error ? error.message : "Unknown error"}`
        )
      );
    }
    try {
      const response = await this.sendWebhookRequest(url, method, headers, payload, timeout);
      const result = this.parseWebhookResponse(response, url);
      const suppressionEnabled = config.suppressionEnabled !== false;
      const issueFilter = new IssueFilter(suppressionEnabled);
      const filteredIssues = issueFilter.filterIssues(result.issues || [], process.cwd());
      return {
        ...result,
        issues: filteredIssues
      };
    } catch (error) {
      return this.createErrorResult(url, error);
    }
  }
  async sendWebhookRequest(url, method, headers, payload, timeout) {
    if (typeof fetch === "undefined") {
      throw new Error("Webhook provider requires Node.js 18+ or node-fetch package");
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    try {
      const response = await fetch(url, {
        method,
        headers: {
          "Content-Type": "application/json",
          ...headers
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      if (!response.ok) {
        throw new Error(`Webhook returned ${response.status}: ${response.statusText}`);
      }
      return await response.json();
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Webhook request timed out after ${timeout}ms`);
      }
      throw error;
    }
  }
  parseWebhookResponse(response, url) {
    if (!response || typeof response !== "object") {
      return this.createErrorResult(url, new Error("Invalid webhook response format"));
    }
    const issues = Array.isArray(response.comments) ? response.comments.map((c) => ({
      file: c.file || "unknown",
      line: c.line || 0,
      endLine: c.endLine,
      ruleId: c.ruleId || `webhook/${this.validateCategory(c.category)}`,
      message: c.message || "",
      severity: this.validateSeverity(c.severity),
      category: this.validateCategory(c.category),
      suggestion: c.suggestion,
      replacement: c.replacement
    })) : [];
    return {
      issues
    };
  }
  createErrorResult(url, error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    return {
      issues: [
        {
          file: "webhook",
          line: 0,
          endLine: void 0,
          ruleId: "webhook/error",
          message: `Webhook execution error: ${errorMessage}`,
          severity: "error",
          category: "logic",
          suggestion: void 0,
          replacement: void 0
        }
      ]
    };
  }
  validateSeverity(severity) {
    const valid = ["info", "warning", "error", "critical"];
    return valid.includes(severity) ? severity : "info";
  }
  validateCategory(category) {
    const valid = ["security", "performance", "style", "logic", "documentation"];
    return valid.includes(category) ? category : "logic";
  }
  getSupportedConfigKeys() {
    return [
      "type",
      "url",
      "body",
      "method",
      "headers",
      "timeout",
      "metadata",
      "depends_on",
      "on",
      "if",
      "group",
      "schedule"
    ];
  }
  async isAvailable() {
    return typeof fetch !== "undefined";
  }
  getRequirements() {
    return [
      "Valid HTTP URL",
      "Body template (Liquid) for payload construction",
      "Network access to HTTP endpoint",
      "Optional: Dependencies for accessing their outputs in templates"
    ];
  }
};

// src/providers/http-input-provider.ts
init_logger();
var HttpInputProvider = class extends CheckProvider {
  liquid;
  webhookContext;
  constructor() {
    super();
    this.liquid = createExtendedLiquid();
  }
  /**
   * Set webhook context for accessing webhook data
   */
  setWebhookContext(webhookContext) {
    this.webhookContext = webhookContext;
  }
  getName() {
    return "http_input";
  }
  getDescription() {
    return "Receive and process HTTP webhook input data for use by dependent checks";
  }
  async validateConfig(config) {
    if (!config || typeof config !== "object") {
      return false;
    }
    const cfg = config;
    if (cfg.type !== "http_input") {
      return false;
    }
    if (typeof cfg.endpoint !== "string" || !cfg.endpoint) {
      return false;
    }
    if (cfg.transform !== void 0 && typeof cfg.transform !== "string") {
      return false;
    }
    return true;
  }
  async execute(prInfo, config, _dependencyResults, _sessionInfo) {
    const endpoint = config.endpoint;
    const transform = config.transform;
    const webhookData = this.getWebhookData(endpoint);
    if (!webhookData) {
      return {
        issues: []
      };
    }
    let processedData = webhookData;
    if (transform) {
      try {
        const templateContext = {
          webhook: webhookData,
          pr: {
            number: prInfo.number,
            title: prInfo.title,
            author: prInfo.author,
            base: prInfo.base,
            head: prInfo.head
          }
        };
        const rendered = await this.liquid.parseAndRender(transform, templateContext);
        processedData = JSON.parse(rendered);
        logger.verbose(`\u2713 Applied webhook transform successfully`);
      } catch (error) {
        logger.error(
          `\u2717 Failed to transform webhook data: ${error instanceof Error ? error.message : "Unknown error"}`
        );
        return {
          issues: [
            {
              file: "webhook_input",
              line: 0,
              ruleId: "webhook_input/transform_error",
              message: `Failed to transform webhook data: ${error instanceof Error ? error.message : "Unknown error"}`,
              severity: "error",
              category: "logic"
            }
          ]
        };
      }
    }
    return {
      issues: [],
      // Add custom data field that will be passed through
      data: processedData
    };
  }
  getWebhookData(endpoint) {
    if (this.webhookContext) {
      return this.webhookContext.get(endpoint) || null;
    }
    const globalWebhookStore = global.__visor_webhook_data;
    if (globalWebhookStore && globalWebhookStore.get) {
      console.warn(
        "HttpInputProvider: Using deprecated global webhook store. Please use webhook context instead."
      );
      return globalWebhookStore.get(endpoint) || null;
    }
    return null;
  }
  getSupportedConfigKeys() {
    return ["type", "endpoint", "transform", "on", "depends_on", "if", "group"];
  }
  async isAvailable() {
    return true;
  }
  getRequirements() {
    return [
      "HTTP server must be configured and running",
      "Valid endpoint path specified",
      "Optional: Transform template for data processing"
    ];
  }
};

// src/providers/http-client-provider.ts
var HttpClientProvider = class extends CheckProvider {
  liquid;
  constructor() {
    super();
    this.liquid = createExtendedLiquid();
  }
  getName() {
    return "http_client";
  }
  getDescription() {
    return "Fetch data from HTTP endpoints for use by dependent checks";
  }
  async validateConfig(config) {
    if (!config || typeof config !== "object") {
      return false;
    }
    const cfg = config;
    if (cfg.type !== "http_client") {
      return false;
    }
    if (typeof cfg.url !== "string" || !cfg.url) {
      return false;
    }
    try {
      new URL(cfg.url);
      return true;
    } catch {
      return false;
    }
  }
  async execute(prInfo, config, dependencyResults, _sessionInfo) {
    const url = config.url;
    const method = config.method || "GET";
    const headers = config.headers || {};
    const timeout = config.timeout || 3e4;
    const transform = config.transform;
    const bodyTemplate = config.body;
    try {
      const templateContext = {
        pr: {
          number: prInfo.number,
          title: prInfo.title,
          body: prInfo.body,
          author: prInfo.author,
          base: prInfo.base,
          head: prInfo.head,
          totalAdditions: prInfo.totalAdditions,
          totalDeletions: prInfo.totalDeletions
        },
        outputs: dependencyResults ? Object.fromEntries(dependencyResults) : {},
        env: process.env
      };
      let renderedUrl = url;
      if (url.includes("{{") || url.includes("{%")) {
        renderedUrl = await this.liquid.parseAndRender(url, templateContext);
      }
      let requestBody;
      if (bodyTemplate) {
        const renderedBody = await this.liquid.parseAndRender(bodyTemplate, templateContext);
        requestBody = renderedBody;
      }
      const data = await this.fetchData(renderedUrl, method, headers, requestBody, timeout);
      let processedData = data;
      if (transform) {
        try {
          const transformContext = {
            response: data,
            pr: templateContext.pr,
            outputs: templateContext.outputs
          };
          const rendered = await this.liquid.parseAndRender(transform, transformContext);
          if (rendered.trim().startsWith("{") || rendered.trim().startsWith("[")) {
            processedData = JSON.parse(rendered);
          } else {
            processedData = rendered;
          }
        } catch (error) {
          return {
            issues: [
              {
                file: "http_client",
                line: 0,
                ruleId: "http_client/transform_error",
                message: `Failed to transform response data: ${error instanceof Error ? error.message : "Unknown error"}`,
                severity: "error",
                category: "logic"
              }
            ]
          };
        }
      }
      return {
        issues: [],
        // Add custom data field that will be passed through to dependent checks
        data: processedData
      };
    } catch (error) {
      return {
        issues: [
          {
            file: "http_client",
            line: 0,
            ruleId: "http_client/fetch_error",
            message: `Failed to fetch from ${url}: ${error instanceof Error ? error.message : "Unknown error"}`,
            severity: "error",
            category: "logic"
          }
        ]
      };
    }
  }
  async fetchData(url, method, headers, body, timeout = 3e4) {
    if (typeof fetch === "undefined") {
      throw new Error("HTTP client provider requires Node.js 18+ or node-fetch package");
    }
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeout);
    try {
      const requestOptions = {
        method,
        headers: {
          ...headers
        },
        signal: controller.signal
      };
      if (method !== "GET" && body) {
        requestOptions.body = body;
        if (!headers["Content-Type"] && !headers["content-type"]) {
          requestOptions.headers = {
            ...requestOptions.headers,
            "Content-Type": "application/json"
          };
        }
      }
      const response = await fetch(url, requestOptions);
      clearTimeout(timeoutId);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const contentType = response.headers.get("content-type");
      if (contentType && contentType.includes("application/json")) {
        return await response.json();
      }
      const text = await response.text();
      if (text.trim().startsWith("{") || text.trim().startsWith("[")) {
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      }
      return text;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`Request timed out after ${timeout}ms`);
      }
      throw error;
    }
  }
  getSupportedConfigKeys() {
    return [
      "type",
      "url",
      "method",
      "headers",
      "body",
      "transform",
      "timeout",
      "depends_on",
      "on",
      "if",
      "group",
      "schedule"
    ];
  }
  async isAvailable() {
    return typeof fetch !== "undefined";
  }
  getRequirements() {
    return [
      "Valid HTTP/HTTPS URL to fetch from",
      "Network access to the endpoint",
      "Optional: Transform template for processing response data",
      "Optional: Body template for POST/PUT requests"
    ];
  }
};

// src/providers/noop-check-provider.ts
var NoopCheckProvider = class extends CheckProvider {
  getName() {
    return "noop";
  }
  getDescription() {
    return "No-operation provider for command orchestration and dependency triggering";
  }
  async validateConfig(config) {
    if (!config || typeof config !== "object") {
      return false;
    }
    const cfg = config;
    if (cfg.type !== "noop") {
      return false;
    }
    return true;
  }
  async execute(_prInfo, _config, _dependencyResults, _sessionInfo) {
    return {
      issues: []
    };
  }
  getSupportedConfigKeys() {
    return ["type", "command", "depends_on", "on", "if", "group"];
  }
  async isAvailable() {
    return true;
  }
  getRequirements() {
    return [
      "No external dependencies required",
      "Used for command orchestration and dependency triggering"
    ];
  }
};

// src/providers/log-check-provider.ts
init_logger();
var LogCheckProvider = class extends CheckProvider {
  liquid;
  constructor() {
    super();
    this.liquid = createExtendedLiquid({
      strictVariables: false,
      strictFilters: false
    });
  }
  getName() {
    return "log";
  }
  getDescription() {
    return "Output debugging and logging information for troubleshooting check workflows";
  }
  async validateConfig(config) {
    if (!config || typeof config !== "object") {
      return false;
    }
    const cfg = config;
    if (cfg.type !== "log") {
      return false;
    }
    if (!cfg.message || typeof cfg.message !== "string") {
      return false;
    }
    if (cfg.level && !["debug", "info", "warn", "error"].includes(cfg.level)) {
      return false;
    }
    return true;
  }
  async execute(prInfo, config, dependencyResults, _sessionInfo) {
    const message = config.message;
    const level = config.level || "info";
    const includePrContext = config.include_pr_context !== false;
    const includeDependencies = config.include_dependencies !== false;
    const includeMetadata = config.include_metadata !== false;
    const templateContext = this.buildTemplateContext(
      prInfo,
      dependencyResults,
      includePrContext,
      includeDependencies,
      includeMetadata
    );
    const renderedMessage = await this.liquid.parseAndRender(message, templateContext);
    const logOutput = this.formatLogOutput(
      level,
      renderedMessage,
      templateContext,
      includePrContext,
      includeDependencies,
      includeMetadata
    );
    if (level === "error") logger.error(logOutput);
    else if (level === "warn") logger.warn(logOutput);
    else if (level === "debug") logger.debug(logOutput);
    else logger.info(logOutput);
    return {
      issues: [],
      // Add log output as custom field
      logOutput
    };
  }
  buildTemplateContext(prInfo, dependencyResults, _includePrContext = true, _includeDependencies = true, includeMetadata = true) {
    const context = {};
    context.pr = {
      number: prInfo.number,
      title: prInfo.title,
      body: prInfo.body,
      author: prInfo.author,
      base: prInfo.base,
      head: prInfo.head,
      totalAdditions: prInfo.totalAdditions,
      totalDeletions: prInfo.totalDeletions,
      files: prInfo.files.map((f) => ({
        filename: f.filename,
        status: f.status,
        additions: f.additions,
        deletions: f.deletions,
        changes: f.changes
      }))
    };
    context.filenames = prInfo.files.map((f) => f.filename);
    context.fileCount = prInfo.files.length;
    if (dependencyResults) {
      const dependencies = {};
      const outputs = {};
      context.dependencyCount = dependencyResults.size;
      for (const [checkName, result] of dependencyResults.entries()) {
        dependencies[checkName] = {
          issueCount: result.issues?.length || 0,
          suggestionCount: 0,
          issues: result.issues || []
        };
        const summary = result;
        outputs[checkName] = summary.output !== void 0 ? summary.output : summary;
      }
      context.dependencies = dependencies;
      context.outputs = outputs;
    }
    if (includeMetadata) {
      context.metadata = {
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        executionTime: Date.now(),
        nodeVersion: process.version,
        platform: process.platform,
        workingDirectory: process.cwd()
      };
    }
    return context;
  }
  formatLogOutput(level, message, templateContext, includePrContext, includeDependencies, includeMetadata) {
    const sections = [];
    const levelEmoji = this.getLevelEmoji(level);
    sections.push(`${levelEmoji} **${level.toUpperCase()}**: ${message}`);
    if (includePrContext && templateContext.pr) {
      const pr = templateContext.pr;
      sections.push("");
      sections.push("### PR Context");
      sections.push(`- **PR #${pr.number}**: ${pr.title}`);
      sections.push(`- **Author**: ${pr.author}`);
      sections.push(`- **Base**: ${pr.base} \u2192 **Head**: ${pr.head}`);
      sections.push(`- **Changes**: +${pr.totalAdditions} -${pr.totalDeletions}`);
      sections.push(`- **Files Modified**: ${templateContext.fileCount}`);
    }
    if (includeDependencies && templateContext.dependencies) {
      const deps = templateContext.dependencies;
      sections.push("");
      sections.push("### Dependency Results");
      if (Object.keys(deps).length === 0) {
        sections.push("- No dependency results available");
      } else {
        for (const [checkName, result] of Object.entries(deps)) {
          sections.push(
            `- **${checkName}**: ${result.issueCount} issues, ${result.suggestionCount} suggestions`
          );
        }
      }
    }
    if (includeMetadata && templateContext.metadata) {
      const meta = templateContext.metadata;
      sections.push("");
      sections.push("### Execution Metadata");
      sections.push(`- **Timestamp**: ${meta.timestamp}`);
      sections.push(`- **Node Version**: ${meta.nodeVersion}`);
      sections.push(`- **Platform**: ${meta.platform}`);
      sections.push(`- **Working Directory**: ${meta.workingDirectory}`);
    }
    return sections.join("\n");
  }
  getLevelEmoji(level) {
    switch (level) {
      case "debug":
        return "\u{1F41B}";
      case "info":
        return "\u2139\uFE0F";
      case "warn":
        return "\u26A0\uFE0F";
      case "error":
        return "\u274C";
      default:
        return "\u2139\uFE0F";
    }
  }
  getSupportedConfigKeys() {
    return [
      "type",
      "message",
      "level",
      "include_pr_context",
      "include_dependencies",
      "include_metadata",
      "group",
      "command",
      "depends_on",
      "on",
      "if"
    ];
  }
  async isAvailable() {
    return true;
  }
  getRequirements() {
    return [
      "No external dependencies required",
      "Used for debugging and logging check execution flow"
    ];
  }
};

// src/providers/github-ops-provider.ts
var GitHubOpsProvider = class extends CheckProvider {
  getName() {
    return "github";
  }
  getDescription() {
    return "Native GitHub operations (labels, comments, reviewers) executed via Octokit";
  }
  async validateConfig(config) {
    if (!config || typeof config !== "object") return false;
    const cfg = config;
    return typeof cfg.op === "string" && cfg.op.length > 0;
  }
  getSupportedConfigKeys() {
    return ["op", "values", "value", "value_js"];
  }
  async isAvailable() {
    return Boolean(
      process.env.GITHUB_TOKEN || process.env["INPUT_GITHUB-TOKEN"] || process.env.GITHUB_REPOSITORY
    );
  }
  getRequirements() {
    return ["GITHUB_TOKEN or INPUT_GITHUB-TOKEN", "GITHUB_REPOSITORY"];
  }
  async execute(prInfo, config, _dependencyResults) {
    const cfg = config;
    const token = process.env["INPUT_GITHUB-TOKEN"] || process.env["GITHUB_TOKEN"];
    if (!token) {
      return {
        issues: [
          {
            file: "system",
            line: 0,
            ruleId: "github/missing_token",
            message: "No GitHub token available; set GITHUB_TOKEN or pass github-token input for native GitHub operations",
            severity: "error",
            category: "logic"
          }
        ]
      };
    }
    const { Octokit } = await import("@octokit/rest");
    const octokit = new Octokit({ auth: token });
    const repoEnv = process.env.GITHUB_REPOSITORY || "";
    const [owner, repo] = repoEnv.split("/");
    if (!owner || !repo || !prInfo?.number) {
      return {
        issues: [
          {
            file: "system",
            line: 0,
            ruleId: "github/missing_context",
            message: "Missing owner/repo or PR number; GitHub operations require Action context",
            severity: "error",
            category: "logic"
          }
        ]
      };
    }
    let values = [];
    if (Array.isArray(cfg.values)) values = cfg.values.map((v) => String(v));
    else if (typeof cfg.values === "string") values = [cfg.values];
    else if (typeof cfg.value === "string") values = [cfg.value];
    if (cfg.value_js && cfg.value_js.trim()) {
      try {
        const fn = new Function(
          "pr",
          "env",
          "values",
          `"use strict"; const res = (function(){ ${cfg.value_js} })(); return res;`
        );
        const res = fn(prInfo, process.env, values);
        if (typeof res === "string") values = [res];
        else if (Array.isArray(res)) values = res.map((v) => String(v));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          issues: [
            {
              file: "system",
              line: 0,
              ruleId: "github/value_js_error",
              message: `value_js evaluation failed: ${msg}`,
              severity: "error",
              category: "logic"
            }
          ]
        };
      }
    }
    values = values.map((v) => v.trim()).filter((v) => v.length > 0);
    values = Array.from(new Set(values));
    try {
      switch (cfg.op) {
        case "labels.add": {
          if (values.length === 0) break;
          await octokit.rest.issues.addLabels({
            owner,
            repo,
            issue_number: prInfo.number,
            labels: values
          });
          break;
        }
        case "labels.remove": {
          for (const l of values) {
            await octokit.rest.issues.removeLabel({
              owner,
              repo,
              issue_number: prInfo.number,
              name: l
            });
          }
          break;
        }
        case "comment.create": {
          const body = values.join("\n").trim();
          if (body)
            await octokit.rest.issues.createComment({
              owner,
              repo,
              issue_number: prInfo.number,
              body
            });
          break;
        }
        default:
          return {
            issues: [
              {
                file: "system",
                line: 0,
                ruleId: "github/unsupported_op",
                message: `Unsupported GitHub op: ${cfg.op}`,
                severity: "error",
                category: "logic"
              }
            ]
          };
      }
      return { issues: [] };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        issues: [
          {
            file: "system",
            line: 0,
            ruleId: "github/op_failed",
            message: `GitHub operation failed (${cfg.op}): ${msg}`,
            severity: "error",
            category: "logic"
          }
        ]
      };
    }
  }
};

// src/providers/claude-code-check-provider.ts
import fs4 from "fs/promises";
import path4 from "path";

// src/providers/claude-code-types.ts
async function safeImport(moduleName) {
  try {
    return await import(moduleName);
  } catch {
    return null;
  }
}

// src/providers/claude-code-check-provider.ts
function isClaudeCodeConstructor(value) {
  return typeof value === "function";
}
var ClaudeCodeSDKNotInstalledError = class extends Error {
  constructor() {
    super(
      "Claude Code SDK is not installed. Install with: npm install @anthropic/claude-code-sdk @modelcontextprotocol/sdk"
    );
    this.name = "ClaudeCodeSDKNotInstalledError";
  }
};
var ClaudeCodeAPIKeyMissingError = class extends Error {
  constructor() {
    super(
      "No API key found for Claude Code provider. Set CLAUDE_CODE_API_KEY or ANTHROPIC_API_KEY environment variable."
    );
    this.name = "ClaudeCodeAPIKeyMissingError";
  }
};
var ClaudeCodeCheckProvider = class extends CheckProvider {
  liquidEngine;
  claudeCodeClient = null;
  constructor() {
    super();
    this.liquidEngine = createExtendedLiquid();
  }
  getName() {
    return "claude-code";
  }
  getDescription() {
    return "AI-powered code review using Claude Code with MCP tools support";
  }
  async validateConfig(config) {
    if (!config || typeof config !== "object") {
      return false;
    }
    const cfg = config;
    if (cfg.type !== "claude-code") {
      return false;
    }
    if (!cfg.prompt || typeof cfg.prompt !== "string") {
      return false;
    }
    if (cfg.claude_code) {
      const claudeCodeConfig = cfg.claude_code;
      if (claudeCodeConfig.allowedTools && !Array.isArray(claudeCodeConfig.allowedTools)) {
        return false;
      }
      if (claudeCodeConfig.maxTurns && typeof claudeCodeConfig.maxTurns !== "number") {
        return false;
      }
      if (claudeCodeConfig.systemPrompt && typeof claudeCodeConfig.systemPrompt !== "string") {
        return false;
      }
      if (claudeCodeConfig.mcpServers) {
        if (typeof claudeCodeConfig.mcpServers !== "object") {
          return false;
        }
        for (const serverConfig of Object.values(claudeCodeConfig.mcpServers)) {
          if (!serverConfig.command || typeof serverConfig.command !== "string") {
            return false;
          }
          if (serverConfig.args && !Array.isArray(serverConfig.args)) {
            return false;
          }
        }
      }
    }
    return true;
  }
  /**
   * Initialize Claude Code SDK client
   */
  async initializeClaudeCodeClient() {
    if (this.claudeCodeClient) {
      return this.claudeCodeClient;
    }
    const claudeCodeModule = await safeImport("@anthropic/claude-code-sdk");
    if (!claudeCodeModule) {
      throw new ClaudeCodeSDKNotInstalledError();
    }
    const ClaudeCodeCtor = claudeCodeModule.ClaudeCode || claudeCodeModule.default?.ClaudeCode;
    if (!isClaudeCodeConstructor(ClaudeCodeCtor)) {
      throw new Error("ClaudeCode class not found in @anthropic/claude-code-sdk");
    }
    const apiKey = process.env.CLAUDE_CODE_API_KEY || process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new ClaudeCodeAPIKeyMissingError();
    }
    try {
      const client = new ClaudeCodeCtor({
        apiKey
      });
      this.claudeCodeClient = client;
      return client;
    } catch (error) {
      throw new Error(
        `Failed to initialize Claude Code SDK: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }
  /**
   * Group files by their file extension for template context
   */
  groupFilesByExtension(files) {
    const grouped = {};
    files.forEach((file) => {
      const parts = file.filename.split(".");
      const ext = parts.length > 1 ? parts.pop()?.toLowerCase() || "noext" : "noext";
      if (!grouped[ext]) {
        grouped[ext] = [];
      }
      grouped[ext].push(file);
    });
    return grouped;
  }
  /**
   * Process prompt configuration to resolve final prompt string
   */
  async processPrompt(promptConfig, prInfo, eventContext, dependencyResults) {
    let promptContent;
    if (await this.isFilePath(promptConfig)) {
      promptContent = await this.loadPromptFromFile(promptConfig);
    } else {
      promptContent = promptConfig;
    }
    return await this.renderPromptTemplate(promptContent, prInfo, eventContext, dependencyResults);
  }
  /**
   * Detect if a string is likely a file path and if the file exists
   */
  async isFilePath(str) {
    if (!str || str.trim() !== str || str.length > 512) {
      return false;
    }
    if (/\s{2,}/.test(str) || // Multiple consecutive spaces
    /\n/.test(str) || // Contains newlines
    /^(please|analyze|review|check|find|identify|look|search)/i.test(str.trim()) || // Starts with command words
    str.split(" ").length > 8) {
      return false;
    }
    if (!/[\/\\]/.test(str)) {
      if (/\b(the|and|or|but|for|with|by|from|in|on|at|as)\b/i.test(str)) {
        return false;
      }
    }
    const hasFileExtension = /\.[a-zA-Z0-9]{1,10}$/i.test(str);
    const hasPathSeparators = /[\/\\]/.test(str);
    const isRelativePath = /^\.{1,2}\//.test(str);
    const isAbsolutePath = path4.isAbsolute(str);
    const hasTypicalFileChars = /^[a-zA-Z0-9._\-\/\\:~]+$/.test(str);
    if (!(hasFileExtension || isRelativePath || isAbsolutePath || hasPathSeparators)) {
      return false;
    }
    if (!hasTypicalFileChars) {
      return false;
    }
    try {
      let resolvedPath;
      if (path4.isAbsolute(str)) {
        resolvedPath = path4.normalize(str);
      } else {
        resolvedPath = path4.resolve(process.cwd(), str);
      }
      try {
        const stat = await fs4.stat(resolvedPath);
        return stat.isFile();
      } catch {
        return hasFileExtension && (isRelativePath || isAbsolutePath || hasPathSeparators);
      }
    } catch {
      return false;
    }
  }
  /**
   * Load prompt content from file with security validation
   */
  async loadPromptFromFile(promptPath) {
    if (!promptPath.endsWith(".liquid")) {
      throw new Error("Prompt file must have .liquid extension");
    }
    let resolvedPath;
    if (path4.isAbsolute(promptPath)) {
      resolvedPath = promptPath;
    } else {
      resolvedPath = path4.resolve(process.cwd(), promptPath);
    }
    if (!path4.isAbsolute(promptPath)) {
      const normalizedPath = path4.normalize(resolvedPath);
      const currentDir = path4.resolve(process.cwd());
      if (!normalizedPath.startsWith(currentDir)) {
        throw new Error("Invalid prompt file path: path traversal detected");
      }
    }
    if (promptPath.includes("../..")) {
      throw new Error("Invalid prompt file path: path traversal detected");
    }
    try {
      const promptContent = await fs4.readFile(resolvedPath, "utf-8");
      return promptContent;
    } catch (error) {
      throw new Error(
        `Failed to load prompt from ${resolvedPath}: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }
  /**
   * Render Liquid template in prompt with comprehensive context
   */
  async renderPromptTemplate(promptContent, prInfo, eventContext, dependencyResults) {
    const templateContext = {
      // PR Information
      pr: {
        number: prInfo.number,
        title: prInfo.title,
        body: prInfo.body,
        author: prInfo.author,
        baseBranch: prInfo.base,
        headBranch: prInfo.head,
        isIncremental: prInfo.isIncremental,
        filesChanged: prInfo.files?.map((f) => f.filename) || [],
        totalAdditions: prInfo.files?.reduce((sum, f) => sum + f.additions, 0) || 0,
        totalDeletions: prInfo.files?.reduce((sum, f) => sum + f.deletions, 0) || 0,
        totalChanges: prInfo.files?.reduce((sum, f) => sum + f.changes, 0) || 0,
        base: prInfo.base,
        head: prInfo.head
      },
      // File Details
      files: prInfo.files || [],
      description: prInfo.body || "",
      // GitHub Event Context
      event: eventContext ? {
        name: eventContext.event_name || "unknown",
        action: eventContext.action,
        isPullRequest: !prInfo.isIssue,
        // Repository Info
        repository: eventContext.repository ? {
          owner: eventContext.repository?.owner?.login,
          name: eventContext.repository?.name,
          fullName: eventContext.repository ? `${eventContext.repository?.owner?.login}/${eventContext.repository?.name}` : void 0
        } : void 0,
        // Comment Data (for comment events)
        comment: eventContext.comment ? {
          body: eventContext.comment?.body,
          author: eventContext.comment?.user?.login
        } : void 0,
        // Raw event payload for advanced use cases
        payload: eventContext
      } : void 0,
      // Utility data for templates
      utils: {
        // Date/time helpers
        now: (/* @__PURE__ */ new Date()).toISOString(),
        today: (/* @__PURE__ */ new Date()).toISOString().split("T")[0],
        // Dynamic file grouping by extension
        filesByExtension: this.groupFilesByExtension(prInfo.files || []),
        // File status categorizations
        addedFiles: (prInfo.files || []).filter((f) => f.status === "added"),
        modifiedFiles: (prInfo.files || []).filter((f) => f.status === "modified"),
        removedFiles: (prInfo.files || []).filter((f) => f.status === "removed"),
        renamedFiles: (prInfo.files || []).filter((f) => f.status === "renamed"),
        // Change analysis
        hasLargeChanges: (prInfo.files || []).some((f) => f.changes > 50),
        totalFiles: (prInfo.files || []).length
      },
      // Previous check outputs (dependency results)
      // Expose raw output directly if available, otherwise expose the result as-is
      outputs: dependencyResults ? Object.fromEntries(
        Array.from(dependencyResults.entries()).map(([checkName, result]) => [
          checkName,
          // If the result has a direct output field, use it directly
          // Otherwise, expose the entire result
          (() => {
            const summary = result;
            return summary.output !== void 0 ? summary.output : summary;
          })()
        ])
      ) : {}
    };
    try {
      return await this.liquidEngine.parseAndRender(promptContent, templateContext);
    } catch (error) {
      throw new Error(
        `Failed to render prompt template: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }
  /**
   * Parse structured response from Claude Code
   */
  parseStructuredResponse(content) {
    try {
      const parsed = JSON.parse(content);
      return {
        issues: parsed.issues || []
      };
    } catch {
      return {
        issues: []
      };
    }
  }
  async execute(prInfo, config, dependencyResults, sessionInfo) {
    if (config.env) {
      const result = EnvironmentResolver.withTemporaryEnv(config.env, () => {
        return this.executeWithConfig(prInfo, config, dependencyResults, sessionInfo);
      });
      if (result instanceof Promise) {
        return result;
      }
      return result;
    }
    return this.executeWithConfig(prInfo, config, dependencyResults, sessionInfo);
  }
  async executeWithConfig(prInfo, config, dependencyResults, sessionInfo) {
    const claudeCodeConfig = config.claude_code || {};
    const customPrompt = config.prompt;
    if (!customPrompt) {
      throw new Error(
        `No prompt defined for check. All checks must have prompts defined in .visor.yaml configuration.`
      );
    }
    const processedPrompt = await this.processPrompt(
      customPrompt,
      prInfo,
      config.eventContext,
      dependencyResults
    );
    const startTime = Date.now();
    try {
      const client = await this.initializeClaudeCodeClient();
      const query = {
        query: processedPrompt,
        maxTurns: claudeCodeConfig.maxTurns || 5,
        systemPrompt: claudeCodeConfig.systemPrompt,
        subagent: claudeCodeConfig.subagent
      };
      if (claudeCodeConfig.allowedTools && claudeCodeConfig.allowedTools.length > 0) {
        query.tools = claudeCodeConfig.allowedTools.map((name) => ({ name }));
      }
      if (claudeCodeConfig.mcpServers && Object.keys(claudeCodeConfig.mcpServers).length > 0) {
        query.mcpServers = claudeCodeConfig.mcpServers;
      }
      let response;
      if (sessionInfo?.reuseSession && sessionInfo.parentSessionId) {
        response = await client.query({
          ...query,
          sessionId: sessionInfo.parentSessionId
        });
      } else {
        response = await client.query(query);
      }
      const result = this.parseStructuredResponse(response.content);
      result.debug = {
        prompt: processedPrompt,
        rawResponse: response.content,
        provider: "claude-code",
        model: "claude-code",
        apiKeySource: "CLAUDE_CODE_API_KEY",
        processingTime: Date.now() - startTime,
        promptLength: processedPrompt.length,
        responseLength: response.content.length,
        jsonParseSuccess: true,
        errors: [],
        checksExecuted: [config.checkName || "claude-code-check"],
        parallelExecution: false,
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        // Claude Code specific debug info
        sessionId: response.session_id,
        turnCount: response.turn_count,
        usage: response.usage
      };
      const suppressionEnabled = config.suppressionEnabled !== false;
      const issueFilter = new IssueFilter(suppressionEnabled);
      const filteredIssues = issueFilter.filterIssues(result.issues || [], process.cwd());
      return {
        ...result,
        issues: filteredIssues
      };
    } catch (error) {
      if (error instanceof ClaudeCodeSDKNotInstalledError || error instanceof ClaudeCodeAPIKeyMissingError) {
        throw error;
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`\u274C Claude Code Check Provider Error: ${errorMessage}`);
      const isCriticalError = errorMessage.includes("API rate limit") || errorMessage.includes("403") || errorMessage.includes("401") || errorMessage.includes("authentication");
      if (isCriticalError) {
        console.error(
          `\u{1F6A8} CRITICAL ERROR: Claude Code provider authentication or setup issue detected`
        );
        console.error(
          `\u{1F6A8} This check cannot proceed without valid API credentials and SDK installation`
        );
      }
      throw new Error(`Claude Code analysis failed: ${errorMessage}`);
    }
  }
  getSupportedConfigKeys() {
    return [
      "type",
      "prompt",
      "claude_code.allowedTools",
      "claude_code.maxTurns",
      "claude_code.systemPrompt",
      "claude_code.mcpServers",
      "claude_code.subagent",
      "claude_code.hooks",
      "env",
      "checkName",
      "sessionId",
      "suppressionEnabled"
    ];
  }
  async isAvailable() {
    try {
      const hasApiKey = !!(process.env.CLAUDE_CODE_API_KEY || process.env.ANTHROPIC_API_KEY);
      if (!hasApiKey) {
        return false;
      }
      const claudeCodeModule = await safeImport("@anthropic/claude-code-sdk");
      if (!claudeCodeModule) {
        return false;
      }
      const ClaudeCode = claudeCodeModule.ClaudeCode || claudeCodeModule.default?.ClaudeCode;
      return !!ClaudeCode;
    } catch {
      return false;
    }
  }
  getRequirements() {
    return [
      "CLAUDE_CODE_API_KEY or ANTHROPIC_API_KEY environment variable",
      "@anthropic/claude-code-sdk npm package",
      "@modelcontextprotocol/sdk npm package (for MCP support)",
      "Network access to Claude Code API"
    ];
  }
};

// src/providers/command-check-provider.ts
import Sandbox from "@nyariv/sandboxjs";
init_logger();
var CommandCheckProvider = class extends CheckProvider {
  liquid;
  sandbox;
  constructor() {
    super();
    this.liquid = createExtendedLiquid({
      cache: false,
      strictFilters: false,
      strictVariables: false
    });
  }
  createSecureSandbox() {
    const globals = {
      ...Sandbox.SAFE_GLOBALS,
      console,
      JSON
    };
    const prototypeWhitelist = new Map(Sandbox.SAFE_PROTOTYPES);
    return new Sandbox({ globals, prototypeWhitelist });
  }
  getName() {
    return "command";
  }
  getDescription() {
    return "Execute shell commands and capture output for processing";
  }
  async validateConfig(config) {
    if (!config || typeof config !== "object") {
      return false;
    }
    const cfg = config;
    if (!cfg.exec || typeof cfg.exec !== "string") {
      return false;
    }
    return true;
  }
  async execute(prInfo, config, dependencyResults) {
    try {
      logger.info(
        `  command provider: executing check=${String(config.checkName || config.type)} hasTransformJs=${Boolean(
          config.transform_js
        )}`
      );
    } catch {
    }
    const command = config.exec;
    const transform = config.transform;
    const transformJs = config.transform_js;
    const templateContext = {
      pr: {
        number: prInfo.number,
        title: prInfo.title,
        author: prInfo.author,
        branch: prInfo.head,
        base: prInfo.base
      },
      files: prInfo.files,
      fileCount: prInfo.files.length,
      outputs: this.buildOutputContext(dependencyResults),
      env: this.getSafeEnvironmentVariables()
    };
    logger.debug(
      `\u{1F527} Debug: Template outputs keys: ${Object.keys(templateContext.outputs || {}).join(", ")}`
    );
    try {
      let renderedCommand = command;
      if (command.includes("{{") || command.includes("{%")) {
        renderedCommand = await this.renderCommandTemplate(command, templateContext);
      }
      logger.debug(`\u{1F527} Debug: Rendered command: ${renderedCommand}`);
      const scriptEnv = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== void 0) {
          scriptEnv[key] = value;
        }
      }
      if (config.env) {
        for (const [key, value] of Object.entries(config.env)) {
          if (value !== void 0 && value !== null) {
            scriptEnv[key] = String(value);
          }
        }
      }
      const { exec } = await import("child_process");
      const { promisify } = await import("util");
      const execAsync = promisify(exec);
      const timeoutSeconds = config.timeout || 60;
      const timeoutMs = timeoutSeconds * 1e3;
      const { stdout, stderr } = await execAsync(renderedCommand, {
        env: scriptEnv,
        timeout: timeoutMs,
        maxBuffer: 10 * 1024 * 1024
        // 10MB buffer
      });
      if (stderr) {
        logger.debug(`Command stderr: ${stderr}`);
      }
      const rawOutput = stdout.trim();
      let output = rawOutput;
      try {
        const parsed = JSON.parse(rawOutput);
        output = parsed;
        logger.debug(`\u{1F527} Debug: Parsed entire output as JSON successfully`);
      } catch {
        const extractedTail = this.extractJsonFromEnd(rawOutput);
        if (extractedTail) {
          try {
            output = JSON.parse(extractedTail);
          } catch {
            output = rawOutput;
          }
        } else {
          const extractedAny = this.extractJsonAnywhere(rawOutput);
          if (extractedAny) {
            try {
              output = JSON.parse(extractedAny);
            } catch {
              output = rawOutput;
            }
          } else {
            const m = /\berror\b\s*[:=]\s*(true|false)/i.exec(rawOutput);
            if (m) {
              output = { error: m[1].toLowerCase() === "true" };
            } else {
              output = rawOutput;
            }
          }
        }
      }
      let finalOutput = output;
      if (transform) {
        try {
          const transformContext = {
            ...templateContext,
            output
            // Use parsed output for Liquid (object if JSON, string otherwise)
          };
          const rendered = await this.liquid.parseAndRender(transform, transformContext);
          try {
            finalOutput = JSON.parse(rendered.trim());
            logger.verbose(`\u2713 Applied Liquid transform successfully (parsed as JSON)`);
          } catch {
            finalOutput = rendered.trim();
            logger.verbose(`\u2713 Applied Liquid transform successfully (string output)`);
          }
        } catch (error) {
          logger.error(
            `\u2717 Failed to apply Liquid transform: ${error instanceof Error ? error.message : "Unknown error"}`
          );
          return {
            issues: [
              {
                file: "command",
                line: 0,
                ruleId: "command/transform_error",
                message: `Failed to apply Liquid transform: ${error instanceof Error ? error.message : "Unknown error"}`,
                severity: "error",
                category: "logic"
              }
            ]
          };
        }
      }
      if (transformJs) {
        try {
          const jsContext = {
            output: this.makeJsonSmart(rawOutput),
            pr: templateContext.pr,
            files: templateContext.files,
            outputs: this.makeOutputsJsonSmart(templateContext.outputs),
            env: templateContext.env,
            permissions: createPermissionHelpers(prInfo.authorAssociation, detectLocalMode())
          };
          const trimmedTransform = transformJs.trim();
          const buildBodyWithReturn = (raw) => {
            const t = raw.trim();
            const lines = t.split(/\n/);
            let i = lines.length - 1;
            while (i >= 0 && lines[i].trim().length === 0) i--;
            if (i < 0) return "return undefined;";
            const lastLine = lines[i].trim();
            if (/^return\b/i.test(lastLine)) {
              return t;
            }
            const idx = t.lastIndexOf(lastLine);
            const head = idx >= 0 ? t.slice(0, idx) : "";
            const lastExpr = lastLine.replace(/;\s*$/, "");
            return `${head}
return (${lastExpr});`;
          };
          const bodyWithReturn = buildBodyWithReturn(trimmedTransform);
          const code = `
            const output = scope.output;
            const pr = scope.pr;
            const files = scope.files;
            const outputs = scope.outputs;
            const env = scope.env;
            const log = (...args) => { console.log('\u{1F50D} Debug:', ...args); };
            const hasMinPermission = scope.permissions.hasMinPermission;
            const isOwner = scope.permissions.isOwner;
            const isMember = scope.permissions.isMember;
            const isCollaborator = scope.permissions.isCollaborator;
            const isContributor = scope.permissions.isContributor;
            const isFirstTimer = scope.permissions.isFirstTimer;
            const __result = (function(){
${bodyWithReturn}
            })();
            return __result;
          `;
          if (!this.sandbox) {
            this.sandbox = this.createSecureSandbox();
          }
          let parsedFromSandboxJson = void 0;
          try {
            const stringifyCode = `
              const output = scope.output;
              const pr = scope.pr;
              const files = scope.files;
              const outputs = scope.outputs;
              const env = scope.env;
              const log = (...args) => { console.log('\u{1F50D} Debug:', ...args); };
              const hasMinPermission = scope.permissions.hasMinPermission;
              const isOwner = scope.permissions.isOwner;
              const isMember = scope.permissions.isMember;
              const isCollaborator = scope.permissions.isCollaborator;
              const isContributor = scope.permissions.isContributor;
              const isFirstTimer = scope.permissions.isFirstTimer;
              const __ret = (function(){
${bodyWithReturn}
              })();
              return typeof __ret === 'object' && __ret !== null ? JSON.stringify(__ret) : null;
            `;
            const stringifyExec = this.sandbox.compile(stringifyCode);
            const jsonStr = stringifyExec({ scope: jsContext }).run();
            if (typeof jsonStr === "string" && jsonStr.trim().startsWith("{")) {
              parsedFromSandboxJson = JSON.parse(jsonStr);
            }
          } catch {
          }
          if (parsedFromSandboxJson !== void 0) {
            finalOutput = parsedFromSandboxJson;
          } else {
            const exec2 = this.sandbox.compile(code);
            finalOutput = exec2({ scope: jsContext }).run();
          }
          try {
            if (finalOutput && typeof finalOutput === "object" && !Array.isArray(finalOutput) && (finalOutput.error === void 0 || finalOutput.issues === void 0)) {
              const vm = await import("vm");
              const vmContext = vm.createContext({ scope: jsContext });
              const vmCode = `
                (function(){
                  const output = scope.output; const pr = scope.pr; const files = scope.files; const outputs = scope.outputs; const env = scope.env; const log = ()=>{};
${bodyWithReturn}
                })()
              `;
              const vmResult = vm.runInContext(vmCode, vmContext, { timeout: 1e3 });
              if (vmResult && typeof vmResult === "object") {
                finalOutput = vmResult;
              }
            }
          } catch {
          }
          let finalSnapshot = null;
          try {
            if (finalOutput && typeof finalOutput === "object" && !Array.isArray(finalOutput)) {
              try {
                const stringifyExec = this.sandbox.compile("return JSON.stringify(scope.obj);");
                const jsonStr = stringifyExec({ obj: finalOutput }).run();
                if (typeof jsonStr === "string" && jsonStr.trim().startsWith("{")) {
                  finalSnapshot = JSON.parse(jsonStr);
                }
              } catch {
              }
              if (!finalSnapshot) {
                try {
                  finalSnapshot = JSON.parse(JSON.stringify(finalOutput));
                } catch {
                }
              }
              if (!finalSnapshot) {
                const tmp = {};
                for (const k of Object.keys(finalOutput)) {
                  tmp[k] = finalOutput[k];
                }
                finalSnapshot = tmp;
              }
            }
          } catch {
          }
          this.__lastTransformSnapshot = finalSnapshot;
          try {
            const isObj = finalOutput && typeof finalOutput === "object" && !Array.isArray(finalOutput);
            const keys = isObj ? Object.keys(finalOutput).join(",") : typeof finalOutput;
            logger.debug(
              `  transform_js: output typeof=${Array.isArray(finalOutput) ? "array" : typeof finalOutput} keys=${keys}`
            );
            if (isObj && finalOutput.issues) {
              const mi = finalOutput.issues;
              logger.debug(
                `  transform_js: issues typeof=${Array.isArray(mi) ? "array" : typeof mi} len=${mi && mi.length || 0}`
              );
            }
            try {
              if (isObj)
                logger.debug(`  transform_js: error value=${String(finalOutput.error)}`);
            } catch {
            }
          } catch {
          }
          logger.verbose(`\u2713 Applied JavaScript transform successfully`);
        } catch (error) {
          logger.error(
            `\u2717 Failed to apply JavaScript transform: ${error instanceof Error ? error.message : "Unknown error"}`
          );
          return {
            issues: [
              {
                file: "command",
                line: 0,
                ruleId: "command/transform_js_error",
                message: `Failed to apply JavaScript transform: ${error instanceof Error ? error.message : "Unknown error"}`,
                severity: "error",
                category: "logic"
              }
            ]
          };
        }
      }
      let issues = [];
      let outputForDependents = finalOutput;
      const snapshotForExtraction = this.__lastTransformSnapshot || null;
      try {
        if (snapshotForExtraction) {
          logger.debug(`  provider: snapshot keys=${Object.keys(snapshotForExtraction).join(",")}`);
        } else {
          logger.debug(`  provider: snapshot is null`);
        }
      } catch {
      }
      try {
        if (Array.isArray(outputForDependents) && outputForDependents.length === 1) {
          const first = outputForDependents[0];
          if (typeof first === "string") {
            try {
              outputForDependents = JSON.parse(first);
            } catch {
            }
          } else if (first && typeof first === "object") {
            outputForDependents = first;
          }
        }
      } catch {
      }
      let content;
      let extracted = null;
      const trimmedRawOutput = typeof rawOutput === "string" ? rawOutput.trim() : void 0;
      const commandConfig = config;
      const isForEachParent = commandConfig.forEach === true;
      if (!isForEachParent) {
        try {
          const baseObj = snapshotForExtraction || finalOutput;
          if (baseObj && typeof baseObj === "object" && Object.prototype.hasOwnProperty.call(baseObj, "issues")) {
            const remaining = { ...baseObj };
            delete remaining.issues;
            outputForDependents = Object.keys(remaining).length > 0 ? remaining : void 0;
            try {
              const k = outputForDependents && typeof outputForDependents === "object" ? Object.keys(outputForDependents).join(",") : String(outputForDependents);
              logger.debug(`  provider: generic-remaining keys=${k}`);
            } catch {
            }
          }
        } catch {
        }
        const objForExtraction = snapshotForExtraction || finalOutput;
        if (objForExtraction && typeof objForExtraction === "object") {
          try {
            const rec = objForExtraction;
            const maybeIssues = rec.issues;
            const toPlainArray = (v) => {
              if (Array.isArray(v)) return v;
              try {
                if (v && typeof v === "object" && typeof v[Symbol.iterator] === "function") {
                  return Array.from(v);
                }
              } catch {
              }
              const len = Number((v || {}).length);
              if (Number.isFinite(len) && len >= 0) {
                const arr2 = [];
                for (let i = 0; i < len; i++) arr2.push(v[i]);
                return arr2;
              }
              try {
                const cloned = JSON.parse(JSON.stringify(v));
                return Array.isArray(cloned) ? cloned : null;
              } catch {
                return null;
              }
            };
            try {
              const ctor = maybeIssues && maybeIssues.constructor ? maybeIssues.constructor.name : "unknown";
              logger.debug(
                `  provider: issues inspect typeof=${typeof maybeIssues} Array.isArray=${Array.isArray(
                  maybeIssues
                )} ctor=${ctor} keys=${Object.keys(maybeIssues || {}).join(",")}`
              );
            } catch {
            }
            const arr = toPlainArray(maybeIssues);
            if (arr) {
              const norm = this.normalizeIssueArray(arr);
              if (norm) {
                issues = norm;
                const remaining = { ...rec };
                delete remaining.issues;
                outputForDependents = Object.keys(remaining).length > 0 ? remaining : void 0;
                try {
                  const keys = outputForDependents && typeof outputForDependents === "object" ? Object.keys(outputForDependents).join(",") : String(outputForDependents);
                  logger.info(
                    `  provider: fast-path issues=${issues.length} remaining keys=${keys}`
                  );
                } catch {
                }
              } else {
                try {
                  logger.info("  provider: fast-path norm failed");
                } catch {
                }
              }
            } else {
              try {
                logger.info("  provider: fast-path arr unavailable");
              } catch {
              }
            }
          } catch {
          }
        }
        let extractionTarget = snapshotForExtraction || finalOutput;
        try {
          if (Array.isArray(extractionTarget) && extractionTarget.length === 1) {
            const first = extractionTarget[0];
            if (typeof first === "string") {
              try {
                extractionTarget = JSON.parse(first);
              } catch {
                extractionTarget = first;
              }
            } else if (first && typeof first === "object") {
              extractionTarget = first;
            }
          }
        } catch {
        }
        extracted = this.extractIssuesFromOutput(extractionTarget);
        try {
          if (extractionTarget !== (snapshotForExtraction || finalOutput)) {
            finalOutput = extractionTarget;
          }
        } catch {
        }
        if (!extracted && finalOutput && typeof finalOutput === "object") {
          try {
            const rec = finalOutput;
            const maybeIssues = rec.issues;
            if (maybeIssues && typeof maybeIssues === "object") {
              let arr = null;
              try {
                if (typeof maybeIssues[Symbol.iterator] === "function") {
                  arr = Array.from(maybeIssues);
                }
              } catch {
              }
              if (!arr) {
                const len = Number(maybeIssues.length);
                if (Number.isFinite(len) && len >= 0) {
                  arr = [];
                  for (let i = 0; i < len; i++) arr.push(maybeIssues[i]);
                }
              }
              if (!arr) {
                try {
                  arr = JSON.parse(JSON.stringify(maybeIssues));
                } catch {
                }
              }
              if (arr && Array.isArray(arr)) {
                const norm = this.normalizeIssueArray(arr);
                if (norm) {
                  issues = norm;
                  const remaining = { ...rec };
                  delete remaining.issues;
                  outputForDependents = Object.keys(remaining).length > 0 ? remaining : void 0;
                }
              }
            }
          } catch {
          }
        }
        if (!extracted && typeof finalOutput === "string") {
          try {
            const parsed = JSON.parse(finalOutput);
            extracted = this.extractIssuesFromOutput(parsed);
            if (extracted) {
              issues = extracted.issues;
              outputForDependents = extracted.remainingOutput;
              if (typeof extracted.remainingOutput === "object" && extracted.remainingOutput !== null && typeof extracted.remainingOutput.content === "string") {
                const c = String(extracted.remainingOutput.content).trim();
                if (c) content = c;
              }
            }
          } catch {
            try {
              const any = this.extractJsonAnywhere(finalOutput);
              if (any) {
                const parsed = JSON.parse(any);
                extracted = this.extractIssuesFromOutput(parsed);
                if (extracted) {
                  issues = extracted.issues;
                  outputForDependents = extracted.remainingOutput;
                  if (typeof extracted.remainingOutput === "object" && extracted.remainingOutput !== null && typeof extracted.remainingOutput.content === "string") {
                    const c = String(extracted.remainingOutput.content).trim();
                    if (c) content = c;
                  }
                }
              }
            } catch {
            }
          }
        } else if (extracted) {
          issues = extracted.issues;
          outputForDependents = extracted.remainingOutput;
          if (typeof extracted.remainingOutput === "object" && extracted.remainingOutput !== null && typeof extracted.remainingOutput.content === "string") {
            const c = String(extracted.remainingOutput.content).trim();
            if (c) content = c;
          }
        }
        if (!issues.length && this.shouldTreatAsTextOutput(trimmedRawOutput)) {
          content = trimmedRawOutput;
        } else if (issues.length && typeof extracted?.remainingOutput === "string") {
          const trimmed = extracted.remainingOutput.trim();
          if (trimmed) {
            content = trimmed;
          }
        }
        if (!issues.length && typeof trimmedRawOutput === "string") {
          try {
            const tryParsed = JSON.parse(trimmedRawOutput);
            const reextract = this.extractIssuesFromOutput(tryParsed);
            if (reextract && reextract.issues && reextract.issues.length) {
              issues = reextract.issues;
              if (!outputForDependents && reextract.remainingOutput) {
                outputForDependents = reextract.remainingOutput;
              }
            } else if (Array.isArray(tryParsed)) {
              const first = tryParsed[0];
              if (first && typeof first === "object" && Array.isArray(first.issues)) {
                const merged = [];
                for (const el of tryParsed) {
                  if (el && typeof el === "object" && Array.isArray(el.issues)) {
                    merged.push(...el.issues);
                  }
                }
                const flat = this.normalizeIssueArray(merged);
                if (flat) issues = flat;
              } else {
                const converted = [];
                for (const el of tryParsed) {
                  if (typeof el === "string") {
                    try {
                      const obj = JSON.parse(el);
                      converted.push(obj);
                    } catch {
                    }
                  } else {
                    converted.push(el);
                  }
                }
                const flat = this.normalizeIssueArray(converted);
                if (flat) issues = flat;
              }
            }
          } catch {
          }
          if (!issues.length) {
            try {
              const any = this.extractJsonAnywhere(trimmedRawOutput);
              if (any) {
                const tryParsed = JSON.parse(any);
                const reextract = this.extractIssuesFromOutput(tryParsed);
                if (reextract && reextract.issues && reextract.issues.length) {
                  issues = reextract.issues;
                  if (!outputForDependents && reextract.remainingOutput) {
                    outputForDependents = reextract.remainingOutput;
                  }
                }
              }
            } catch {
            }
          }
        }
        try {
          const srcObj = snapshotForExtraction || finalOutput;
          if (outputForDependents && typeof outputForDependents === "object" && srcObj && typeof srcObj === "object") {
            for (const k of Object.keys(srcObj)) {
              const v = srcObj[k];
              if (typeof v === "boolean" || typeof v === "number" || typeof v === "string") {
                outputForDependents[k] = v;
              }
            }
          }
        } catch {
        }
        try {
          if (outputForDependents && typeof outputForDependents === "object" && !Array.isArray(outputForDependents)) {
            const plain = {};
            for (const k of Object.keys(outputForDependents)) {
              plain[k] = outputForDependents[k];
            }
            outputForDependents = plain;
          }
        } catch {
        }
      }
      if (!content && this.shouldTreatAsTextOutput(trimmedRawOutput) && !isForEachParent) {
        content = trimmedRawOutput;
      }
      try {
        if (outputForDependents && typeof outputForDependents === "object") {
          outputForDependents = JSON.parse(JSON.stringify(outputForDependents));
        }
      } catch {
      }
      const promoted = {};
      try {
        const srcObj = snapshotForExtraction || finalOutput;
        if (srcObj && typeof srcObj === "object") {
          for (const k of Object.keys(srcObj)) {
            const v = srcObj[k];
            if (typeof v === "boolean") {
              if (v === true && promoted[k] === void 0) promoted[k] = true;
            } else if ((typeof v === "number" || typeof v === "string") && promoted[k] === void 0) {
              promoted[k] = v;
            }
          }
        }
      } catch {
      }
      const result = {
        issues,
        output: outputForDependents,
        ...content ? { content } : {},
        ...promoted
      };
      try {
        if (transformJs) {
          const rawObj = snapshotForExtraction || finalOutput;
          if (rawObj && typeof rawObj === "object") {
            result.__raw = rawObj;
          }
        }
      } catch {
      }
      try {
        const srcObj = snapshotForExtraction || finalOutput;
        const srcErr = (() => {
          try {
            if (snapshotForExtraction && typeof snapshotForExtraction === "object" && snapshotForExtraction.error !== void 0) {
              return Boolean(snapshotForExtraction.error);
            }
            if (finalOutput && typeof finalOutput === "object" && finalOutput.error !== void 0) {
              return Boolean(finalOutput.error);
            }
          } catch {
          }
          return void 0;
        })();
        const dst = result.output;
        if (srcObj && typeof srcObj === "object" && dst && typeof dst === "object") {
          try {
            logger.debug(
              `  provider: safeguard src.error typeof=${typeof srcObj.error} val=${String(srcObj.error)} dst.hasErrorBefore=${String(dst.error !== void 0)}`
            );
          } catch {
          }
          for (const k of Object.keys(srcObj)) {
            const v = srcObj[k];
            if (typeof v === "boolean" || typeof v === "number" || typeof v === "string") {
              dst[k] = v;
            }
          }
          if (srcErr !== void 0 && dst.error === void 0) {
            dst.error = srcErr;
            try {
              const k = Object.keys(dst).join(",");
              logger.debug(
                `  provider: safeguard merged error -> output keys=${k} val=${String(dst.error)}`
              );
            } catch {
            }
          }
        }
      } catch {
      }
      try {
        const out = result.output;
        if (out && typeof out === "object") {
          const k = Object.keys(out).join(",");
          logger.debug(`  provider: return output keys=${k}`);
        } else {
          logger.debug(`  provider: return output type=${typeof out}`);
        }
      } catch {
      }
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      let isTimeout = false;
      if (error && typeof error === "object") {
        const execError = error;
        if (execError.killed && execError.signal === "SIGTERM") {
          isTimeout = true;
        }
        if (execError.code === "ETIMEDOUT") {
          isTimeout = true;
        }
      }
      let stderrOutput = "";
      if (error && typeof error === "object") {
        const execError = error;
        if (execError.stderr) {
          stderrOutput = execError.stderr.trim();
        }
      }
      let detailedMessage;
      let ruleId;
      if (isTimeout) {
        const timeoutSeconds = config.timeout || 60;
        detailedMessage = `Command execution timed out after ${timeoutSeconds} seconds`;
        if (stderrOutput) {
          detailedMessage += `

Stderr output:
${stderrOutput}`;
        }
        ruleId = "command/timeout";
      } else {
        detailedMessage = stderrOutput ? `Command execution failed: ${errorMessage}

Stderr output:
${stderrOutput}` : `Command execution failed: ${errorMessage}`;
        ruleId = "command/execution_error";
      }
      logger.error(`\u2717 ${detailedMessage}`);
      return {
        issues: [
          {
            file: "command",
            line: 0,
            ruleId,
            message: detailedMessage,
            severity: "error",
            category: "logic"
          }
        ]
      };
    }
  }
  buildOutputContext(dependencyResults) {
    if (!dependencyResults) {
      return {};
    }
    const outputs = {};
    for (const [checkName, result] of dependencyResults) {
      const summary = result;
      const value = summary.output !== void 0 ? summary.output : summary;
      outputs[checkName] = this.makeJsonSmart(value);
    }
    return outputs;
  }
  /**
   * Wrap a value with JSON-smart behavior:
   *  - If it's a JSON string, expose parsed properties via Proxy (e.g., value.key)
   *  - When coerced to string (toString/valueOf/Symbol.toPrimitive), return the original raw string
   *  - If parsing fails or value is not a string, return the value unchanged
   *  - Attempts to extract JSON from the end of the output if full parse fails
   */
  makeJsonSmart(value) {
    if (typeof value !== "string") {
      return value;
    }
    const raw = value;
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const jsonMatch = this.extractJsonFromEnd(raw);
      if (jsonMatch) {
        try {
          parsed = JSON.parse(jsonMatch);
          logger.debug(
            `\u{1F527} Debug: Extracted JSON from end of output (${jsonMatch.length} chars from ${raw.length} total)`
          );
        } catch {
          return raw;
        }
      } else {
        return raw;
      }
    }
    const boxed = new String(raw);
    const handler = {
      get(target, prop, receiver) {
        if (prop === "toString" || prop === "valueOf") {
          return () => raw;
        }
        if (prop === Symbol.toPrimitive) {
          return () => raw;
        }
        if (parsed != null && (typeof parsed === "object" || Array.isArray(parsed))) {
          if (prop in parsed) {
            return parsed[prop];
          }
        }
        return Reflect.get(target, prop, receiver);
      },
      has(_target, prop) {
        if (parsed != null && (typeof parsed === "object" || Array.isArray(parsed))) {
          if (prop in parsed) return true;
        }
        return false;
      },
      ownKeys(_target) {
        if (parsed != null && (typeof parsed === "object" || Array.isArray(parsed))) {
          try {
            return Reflect.ownKeys(parsed);
          } catch {
            return [];
          }
        }
        return [];
      },
      getOwnPropertyDescriptor(_target, prop) {
        if (parsed != null && (typeof parsed === "object" || Array.isArray(parsed))) {
          const descriptor = Object.getOwnPropertyDescriptor(parsed, prop);
          if (descriptor) return descriptor;
        }
        return {
          configurable: true,
          enumerable: true,
          writable: false,
          value: void 0
        };
      }
    };
    return new Proxy(boxed, handler);
  }
  /**
   * Extract JSON from the end of a string that may contain logs/debug output
   * Looks for the last occurrence of { or [ and tries to parse from there
   */
  extractJsonFromEnd(text) {
    const lastBrace = Math.max(text.lastIndexOf("}"), text.lastIndexOf("]"));
    if (lastBrace === -1) return null;
    let open = 0;
    for (let i = lastBrace; i >= 0; i--) {
      const ch = text[i];
      if (ch === "}" || ch === "]") open++;
      else if (ch === "{" || ch === "[") open--;
      if (open === 0 && (ch === "{" || ch === "[")) {
        const candidate = text.slice(i, lastBrace + 1).trim();
        try {
          JSON.parse(candidate);
          return candidate;
        } catch {
          return null;
        }
      }
    }
    return null;
  }
  // Extract any balanced JSON object/array substring from anywhere in the text
  extractJsonAnywhere(text) {
    const n = text.length;
    let best = null;
    for (let i = 0; i < n; i++) {
      const start = text[i];
      if (start !== "{" && start !== "[") continue;
      let open = 0;
      let inString = false;
      let escape = false;
      for (let j = i; j < n; j++) {
        const ch = text[j];
        if (escape) {
          escape = false;
          continue;
        }
        if (ch === "\\") {
          escape = true;
          continue;
        }
        if (ch === '"') {
          inString = !inString;
          continue;
        }
        if (inString) continue;
        if (ch === "{" || ch === "[") open++;
        else if (ch === "}" || ch === "]") open--;
        if (open === 0 && (ch === "}" || ch === "]")) {
          const candidate = text.slice(i, j + 1).trim();
          try {
            JSON.parse(candidate);
            best = candidate;
          } catch {
            const strict = this.looseJsonToStrict(candidate);
            if (strict) {
              try {
                JSON.parse(strict);
                best = strict;
              } catch {
              }
            }
          }
          break;
        }
      }
    }
    return best;
  }
  // Best-effort conversion of object-literal-like strings to strict JSON
  looseJsonToStrict(candidate) {
    try {
      let s = candidate.trim();
      s = s.replace(/'/g, '"');
      s = s.replace(/([\{,]\s*)([A-Za-z_][A-Za-z0-9_-]*)\s*:/g, '$1"$2":');
      s = s.replace(/:\s*([A-Za-z_][A-Za-z0-9_-]*)\s*(?=[,}])/g, (m, word) => {
        const lw = String(word).toLowerCase();
        if (lw === "true" || lw === "false" || lw === "null") return `:${lw}`;
        return `:"${word}"`;
      });
      return s;
    } catch {
      return null;
    }
  }
  /**
   * Recursively apply JSON-smart wrapper to outputs object values
   */
  makeOutputsJsonSmart(outputs) {
    const wrapped = {};
    for (const [k, v] of Object.entries(outputs || {})) {
      wrapped[k] = this.makeJsonSmart(v);
    }
    return wrapped;
  }
  getSafeEnvironmentVariables() {
    const safeVars = {};
    const allowedPrefixes = ["CI_", "GITHUB_", "RUNNER_", "NODE_", "npm_", "PATH", "HOME", "USER"];
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== void 0 && allowedPrefixes.some((prefix) => key.startsWith(prefix))) {
        safeVars[key] = value;
      }
    }
    safeVars["PWD"] = process.cwd();
    return safeVars;
  }
  getSupportedConfigKeys() {
    return [
      "type",
      "exec",
      "transform",
      "transform_js",
      "env",
      "timeout",
      "depends_on",
      "on",
      "if",
      "group",
      "forEach"
    ];
  }
  async isAvailable() {
    return true;
  }
  getRequirements() {
    return [
      "Valid shell command to execute",
      "Shell environment available",
      "Optional: Transform template for processing output"
    ];
  }
  extractIssuesFromOutput(output) {
    try {
      logger.info(
        `  extractIssuesFromOutput: typeof=${Array.isArray(output) ? "array" : typeof output}`
      );
      if (typeof output === "object" && output) {
        const rec = output;
        logger.info(
          `  extractIssuesFromOutput: keys=${Object.keys(rec).join(",")} issuesIsArray=${Array.isArray(
            rec.issues
          )}`
        );
      }
    } catch {
    }
    if (output === null || output === void 0) {
      return null;
    }
    if (typeof output === "string") {
      return null;
    }
    if (Array.isArray(output)) {
      const first = output[0];
      if (first && typeof first === "object" && !Array.isArray(first.message) && Array.isArray(first.issues)) {
        const merged = [];
        for (const el of output) {
          if (el && typeof el === "object" && Array.isArray(el.issues)) {
            merged.push(...el.issues);
          }
        }
        const flat = this.normalizeIssueArray(merged);
        if (flat) return { issues: flat, remainingOutput: void 0 };
      } else {
        const issues = this.normalizeIssueArray(output);
        if (issues) {
          return { issues, remainingOutput: void 0 };
        }
      }
      return null;
    }
    if (typeof output === "object") {
      const record = output;
      if (Array.isArray(record.issues)) {
        const issues = this.normalizeIssueArray(record.issues);
        if (!issues) {
          return null;
        }
        const remaining = { ...record };
        delete remaining.issues;
        const remainingKeys = Object.keys(remaining);
        const remainingOutput = remainingKeys.length > 0 ? remaining : void 0;
        return {
          issues,
          remainingOutput
        };
      }
      const singleIssue = this.normalizeIssue(record);
      if (singleIssue) {
        return { issues: [singleIssue], remainingOutput: void 0 };
      }
    }
    return null;
  }
  shouldTreatAsTextOutput(value) {
    if (!value) {
      return false;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      return false;
    }
    const startsJson = trimmed.startsWith("{") && trimmed.endsWith("}") || trimmed.startsWith("[") && trimmed.endsWith("]");
    return !startsJson;
  }
  normalizeIssueArray(values) {
    const normalized = [];
    for (const value of values) {
      const issue = this.normalizeIssue(value);
      if (!issue) {
        return null;
      }
      normalized.push(issue);
    }
    return normalized;
  }
  normalizeIssue(raw) {
    if (!raw || typeof raw !== "object") {
      return null;
    }
    const data = raw;
    const message = this.toTrimmedString(
      data.message || data.text || data.description || data.summary
    );
    if (!message) {
      return null;
    }
    const allowedSeverities = /* @__PURE__ */ new Set(["info", "warning", "error", "critical"]);
    const severityRaw = this.toTrimmedString(data.severity || data.level || data.priority);
    let severity = "warning";
    if (severityRaw) {
      const lower = severityRaw.toLowerCase();
      if (allowedSeverities.has(lower)) {
        severity = lower;
      } else if (["fatal", "high"].includes(lower)) {
        severity = "error";
      } else if (["medium", "moderate"].includes(lower)) {
        severity = "warning";
      } else if (["low", "minor"].includes(lower)) {
        severity = "info";
      }
    }
    const allowedCategories = /* @__PURE__ */ new Set([
      "security",
      "performance",
      "style",
      "logic",
      "documentation"
    ]);
    const categoryRaw = this.toTrimmedString(data.category || data.type || data.group);
    let category = "logic";
    if (categoryRaw && allowedCategories.has(categoryRaw.toLowerCase())) {
      category = categoryRaw.toLowerCase();
    }
    const file = this.toTrimmedString(data.file || data.path || data.filename) || "system";
    const line = this.toNumber(data.line || data.startLine || data.lineNumber) ?? 0;
    const endLine = this.toNumber(data.endLine || data.end_line || data.stopLine);
    const suggestion = this.toTrimmedString(data.suggestion);
    const replacement = this.toTrimmedString(data.replacement);
    const ruleId = this.toTrimmedString(data.ruleId || data.rule || data.id || data.check) || "command";
    return {
      file,
      line,
      endLine: endLine ?? void 0,
      ruleId,
      message,
      severity,
      category,
      suggestion: suggestion || void 0,
      replacement: replacement || void 0
    };
  }
  toTrimmedString(value) {
    if (typeof value === "string") {
      const trimmed = value.trim();
      return trimmed.length > 0 ? trimmed : null;
    }
    if (value !== null && value !== void 0 && typeof value.toString === "function") {
      const converted = String(value).trim();
      return converted.length > 0 ? converted : null;
    }
    return null;
  }
  toNumber(value) {
    if (value === null || value === void 0) {
      return null;
    }
    const num = Number(value);
    if (Number.isFinite(num)) {
      return Math.trunc(num);
    }
    return null;
  }
  async renderCommandTemplate(template, context) {
    try {
      let tpl = template;
      if (tpl.includes("{{")) {
        tpl = tpl.replace(/\{\{([\s\S]*?)\}\}/g, (_m, inner) => {
          const fixed = String(inner).replace(/\[\"/g, "['").replace(/\"\]/g, "']");
          return `{{ ${fixed} }}`;
        });
      }
      let rendered = await this.liquid.parseAndRender(tpl, context);
      if (/\{\{[\s\S]*?\}\}/.test(rendered)) {
        try {
          rendered = this.renderWithJsExpressions(rendered, context);
        } catch {
        }
      }
      return rendered;
    } catch (error) {
      logger.debug(`\u{1F527} Debug: Liquid templating failed, trying JS-expression fallback: ${error}`);
      try {
        return this.renderWithJsExpressions(template, context);
      } catch {
        return template;
      }
    }
  }
  renderWithJsExpressions(template, context) {
    const scope = {
      pr: context.pr,
      files: context.files,
      outputs: context.outputs,
      env: context.env
    };
    const expressionRegex = /\{\{\s*([^{}]+?)\s*\}\}/g;
    return template.replace(expressionRegex, (_match, expr) => {
      const expression = String(expr).trim();
      if (!expression) return "";
      try {
        const evalCode = `
          const pr = scope.pr;
          const files = scope.files;
          const outputs = scope.outputs;
          const env = scope.env;
          return (${expression});
        `;
        if (!this.sandbox) this.sandbox = this.createSecureSandbox();
        const evaluator = this.sandbox.compile(evalCode);
        const result = evaluator({ scope }).run();
        return result === void 0 || result === null ? "" : String(result);
      } catch {
        return "";
      }
    });
  }
};

// src/providers/check-provider-registry.ts
var CheckProviderRegistry = class _CheckProviderRegistry {
  providers = /* @__PURE__ */ new Map();
  static instance;
  constructor() {
    this.registerDefaultProviders();
  }
  /**
   * Get singleton instance
   */
  static getInstance() {
    if (!_CheckProviderRegistry.instance) {
      _CheckProviderRegistry.instance = new _CheckProviderRegistry();
    }
    return _CheckProviderRegistry.instance;
  }
  /**
   * Register default built-in providers
   */
  registerDefaultProviders() {
    this.register(new AICheckProvider());
    this.register(new CommandCheckProvider());
    this.register(new HttpCheckProvider());
    this.register(new HttpInputProvider());
    this.register(new HttpClientProvider());
    this.register(new NoopCheckProvider());
    this.register(new LogCheckProvider());
    this.register(new GitHubOpsProvider());
    try {
      this.register(new ClaudeCodeCheckProvider());
    } catch (error) {
      console.error(
        `Warning: Failed to register ClaudeCodeCheckProvider: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
  }
  /**
   * Register a check provider
   */
  register(provider) {
    const name = provider.getName();
    if (this.providers.has(name)) {
      throw new Error(`Provider '${name}' is already registered`);
    }
    this.providers.set(name, provider);
    if (process.env.VISOR_DEBUG === "true") {
      console.error(`Registered check provider: ${name}`);
    }
  }
  /**
   * Unregister a check provider
   */
  unregister(name) {
    if (!this.providers.has(name)) {
      throw new Error(`Provider '${name}' not found`);
    }
    this.providers.delete(name);
    console.error(`Unregistered check provider: ${name}`);
  }
  /**
   * Get a provider by name
   */
  getProvider(name) {
    return this.providers.get(name);
  }
  /**
   * Get provider or throw if not found
   */
  getProviderOrThrow(name) {
    const provider = this.providers.get(name);
    if (!provider) {
      throw new Error(
        `Check provider '${name}' not found. Available providers: ${this.getAvailableProviders().join(", ")}`
      );
    }
    return provider;
  }
  /**
   * Check if a provider exists
   */
  hasProvider(name) {
    return this.providers.has(name);
  }
  /**
   * Get all registered provider names
   */
  getAvailableProviders() {
    return Array.from(this.providers.keys());
  }
  /**
   * Get all providers
   */
  getAllProviders() {
    return Array.from(this.providers.values());
  }
  /**
   * Get providers that are currently available (have required dependencies)
   */
  async getActiveProviders() {
    const providers = this.getAllProviders();
    const activeProviders = [];
    for (const provider of providers) {
      if (await provider.isAvailable()) {
        activeProviders.push(provider);
      }
    }
    return activeProviders;
  }
  /**
   * List provider information
   */
  async listProviders() {
    const providers = this.getAllProviders();
    const info = [];
    for (const provider of providers) {
      info.push({
        name: provider.getName(),
        description: provider.getDescription(),
        available: await provider.isAvailable(),
        requirements: provider.getRequirements()
      });
    }
    return info;
  }
  /**
   * Reset registry (mainly for testing)
   */
  reset() {
    this.providers.clear();
    this.registerDefaultProviders();
  }
  /**
   * Clear singleton instance (for testing)
   */
  static clearInstance() {
    _CheckProviderRegistry.instance = void 0;
  }
};

// src/dependency-resolver.ts
var DependencyResolver = class {
  /**
   * Build dependency graph from check dependencies
   */
  static buildDependencyGraph(checkDependencies) {
    const nodes = /* @__PURE__ */ new Map();
    for (const checkId of Object.keys(checkDependencies)) {
      nodes.set(checkId, {
        id: checkId,
        dependencies: checkDependencies[checkId] || [],
        dependents: [],
        depth: 0
      });
    }
    for (const [checkId, dependencies] of Object.entries(checkDependencies)) {
      for (const depId of dependencies || []) {
        if (!nodes.has(depId)) {
          throw new Error(`Check "${checkId}" depends on "${depId}" but "${depId}" is not defined`);
        }
        const depNode = nodes.get(depId);
        depNode.dependents.push(checkId);
      }
    }
    const cycleDetection = this.detectCycles(nodes);
    if (cycleDetection.hasCycles) {
      return {
        nodes,
        executionOrder: [],
        hasCycles: true,
        cycleNodes: cycleDetection.cycleNodes
      };
    }
    const executionOrder = this.topologicalSort(nodes);
    return {
      nodes,
      executionOrder,
      hasCycles: false
    };
  }
  /**
   * Detect cycles in the dependency graph using DFS
   */
  static detectCycles(nodes) {
    const visited = /* @__PURE__ */ new Set();
    const recursionStack = /* @__PURE__ */ new Set();
    const cycleNodes = [];
    const dfs = (nodeId) => {
      if (recursionStack.has(nodeId)) {
        cycleNodes.push(nodeId);
        return true;
      }
      if (visited.has(nodeId)) {
        return false;
      }
      visited.add(nodeId);
      recursionStack.add(nodeId);
      const node = nodes.get(nodeId);
      if (node) {
        for (const depId of node.dependencies) {
          if (dfs(depId)) {
            cycleNodes.push(nodeId);
            return true;
          }
        }
      }
      recursionStack.delete(nodeId);
      return false;
    };
    for (const nodeId of nodes.keys()) {
      if (!visited.has(nodeId)) {
        if (dfs(nodeId)) {
          return { hasCycles: true, cycleNodes: [...new Set(cycleNodes)] };
        }
      }
    }
    return { hasCycles: false };
  }
  /**
   * Perform topological sort to determine execution order
   * Groups checks that can run in parallel at each level
   */
  static topologicalSort(nodes) {
    const remainingNodes = new Map(nodes);
    const executionGroups = [];
    let level = 0;
    while (remainingNodes.size > 0) {
      const readyNodes = [];
      for (const [nodeId, node] of remainingNodes.entries()) {
        const unmetDependencies = node.dependencies.filter((depId) => remainingNodes.has(depId));
        if (unmetDependencies.length === 0) {
          readyNodes.push(nodeId);
        }
      }
      if (readyNodes.length === 0) {
        throw new Error("Unable to resolve dependencies - possible circular dependency detected");
      }
      executionGroups.push({
        parallel: readyNodes,
        level
      });
      for (const nodeId of readyNodes) {
        remainingNodes.delete(nodeId);
      }
      level++;
    }
    return executionGroups;
  }
  /**
   * Validate that all dependencies exist
   */
  static validateDependencies(checkIds, dependencies) {
    const errors = [];
    const checkIdSet = new Set(checkIds);
    for (const [checkId, deps] of Object.entries(dependencies)) {
      if (!checkIdSet.has(checkId)) {
        errors.push(`Check "${checkId}" is not in the list of available checks`);
        continue;
      }
      for (const depId of deps || []) {
        if (!checkIdSet.has(depId)) {
          errors.push(`Check "${checkId}" depends on "${depId}" which is not available`);
        }
      }
    }
    return {
      valid: errors.length === 0,
      errors
    };
  }
  /**
   * Get all transitive dependencies (ancestors) for a given check
   * This returns all checks that must complete before the given check can run,
   * not just the direct dependencies.
   *
   * For example, if A -> B -> C, then:
   * - getAllDependencies(C) returns [A, B]
   * - getAllDependencies(B) returns [A]
   * - getAllDependencies(A) returns []
   *
   * @param checkId The check to find dependencies for
   * @param nodes The dependency graph nodes
   * @returns Array of all transitive dependency IDs
   */
  static getAllDependencies(checkId, nodes) {
    const allDeps = /* @__PURE__ */ new Set();
    const visited = /* @__PURE__ */ new Set();
    const collectDependencies = (currentId) => {
      if (visited.has(currentId)) {
        return;
      }
      visited.add(currentId);
      const node = nodes.get(currentId);
      if (!node) {
        return;
      }
      for (const depId of node.dependencies) {
        allDeps.add(depId);
        collectDependencies(depId);
      }
    };
    collectDependencies(checkId);
    return Array.from(allDeps);
  }
  /**
   * Get execution statistics for debugging
   */
  static getExecutionStats(graph) {
    const totalChecks = graph.nodes.size;
    const parallelLevels = graph.executionOrder.length;
    const maxParallelism = Math.max(...graph.executionOrder.map((group) => group.parallel.length));
    const averageParallelism = totalChecks / parallelLevels;
    const checksWithDependencies = Array.from(graph.nodes.values()).filter(
      (node) => node.dependencies.length > 0
    ).length;
    return {
      totalChecks,
      parallelLevels,
      maxParallelism,
      averageParallelism,
      checksWithDependencies
    };
  }
};

// src/failure-condition-evaluator.ts
import Sandbox2 from "@nyariv/sandboxjs";
var FailureConditionEvaluator = class _FailureConditionEvaluator {
  sandbox;
  constructor() {
  }
  /**
   * Create a secure sandbox with whitelisted functions and globals
   */
  createSecureSandbox() {
    const globals = {
      ...Sandbox2.SAFE_GLOBALS,
      // Allow Math for calculations
      Math,
      // Allow console for debugging (in controlled environment)
      console: {
        log: console.log,
        warn: console.warn,
        error: console.error
      }
    };
    const prototypeWhitelist = new Map(Sandbox2.SAFE_PROTOTYPES);
    const arrayMethods = /* @__PURE__ */ new Set([
      "some",
      "every",
      "filter",
      "map",
      "reduce",
      "find",
      "includes",
      "indexOf",
      "length",
      "slice",
      "concat",
      "join"
    ]);
    prototypeWhitelist.set(Array.prototype, arrayMethods);
    const stringMethods = /* @__PURE__ */ new Set([
      "toLowerCase",
      "toUpperCase",
      "includes",
      "indexOf",
      "startsWith",
      "endsWith",
      "slice",
      "substring",
      "length",
      "trim",
      "split",
      "replace"
    ]);
    prototypeWhitelist.set(String.prototype, stringMethods);
    const objectMethods = /* @__PURE__ */ new Set(["hasOwnProperty", "toString", "valueOf"]);
    prototypeWhitelist.set(Object.prototype, objectMethods);
    return new Sandbox2({
      globals,
      prototypeWhitelist
    });
  }
  /**
   * Evaluate simple fail_if condition
   */
  async evaluateSimpleCondition(checkName, checkSchema, checkGroup, reviewSummary, expression, previousOutputs, authorAssociation) {
    const context = this.buildEvaluationContext(
      checkName,
      checkSchema,
      checkGroup,
      reviewSummary,
      previousOutputs,
      authorAssociation
    );
    try {
      try {
        const isObj = context.output && typeof context.output === "object";
        const keys = isObj ? Object.keys(context.output).join(",") : typeof context.output;
        let errorVal = void 0;
        if (isObj && context.output.error !== void 0)
          errorVal = context.output.error;
        (init_logger(), __toCommonJS(logger_exports)).logger.debug(
          `  fail_if: evaluating '${expression}' with output keys=${keys} error=${String(errorVal)}`
        );
      } catch {
      }
      const res = this.evaluateExpression(expression, context);
      return res;
    } catch (error) {
      console.warn(`Failed to evaluate fail_if expression: ${error}`);
      return false;
    }
  }
  /**
   * Determine if the event is related to pull requests
   */
  determineIfPullRequest(eventType) {
    if (!eventType) return false;
    const prEvents = ["pr_opened", "pr_updated", "pr_closed", "pull_request"];
    return prEvents.includes(eventType) || eventType.startsWith("pr_");
  }
  /**
   * Determine if the event is related to issues
   */
  determineIfIssue(eventType) {
    if (!eventType) return false;
    const issueEvents = ["issue_opened", "issue_comment", "issues"];
    return issueEvents.includes(eventType) || eventType.startsWith("issue_");
  }
  /**
   * Evaluate if condition to determine whether a check should run
   */
  async evaluateIfCondition(checkName, expression, contextData) {
    const context = {
      // Check metadata
      checkName,
      // Git context
      branch: contextData?.branch || "unknown",
      baseBranch: contextData?.baseBranch || "main",
      filesChanged: contextData?.filesChanged || [],
      filesCount: contextData?.filesChanged?.length || 0,
      // GitHub event context
      event: {
        event_name: contextData?.event || "manual",
        action: void 0,
        // Would be populated from actual GitHub context
        repository: void 0
        // Would be populated from actual GitHub context
      },
      // Environment variables
      env: contextData?.environment || {},
      // Previous check results (unwrap output field like templates do)
      outputs: contextData?.previousResults ? (() => {
        const outputs = {};
        for (const [checkName2, result] of contextData.previousResults) {
          const summary = result;
          outputs[checkName2] = summary.output !== void 0 ? summary.output : summary;
        }
        return outputs;
      })() : {},
      // Required output property (empty for if conditions)
      output: {
        issues: []
      },
      // Author association (used by permission helpers)
      authorAssociation: contextData?.authorAssociation,
      // Utility metadata
      metadata: {
        checkName,
        schema: "",
        group: "",
        criticalIssues: 0,
        errorIssues: 0,
        warningIssues: 0,
        infoIssues: 0,
        totalIssues: 0,
        hasChanges: (contextData?.filesChanged?.length || 0) > 0,
        branch: contextData?.branch || "unknown",
        event: contextData?.event || "manual"
      }
    };
    try {
      return this.evaluateExpression(expression, context);
    } catch (error) {
      console.warn(`Failed to evaluate if expression for check '${checkName}': ${error}`);
      return true;
    }
  }
  /**
   * Evaluate all failure conditions for a check result
   */
  async evaluateConditions(checkName, checkSchema, checkGroup, reviewSummary, globalConditions, checkConditions, previousOutputs, authorAssociation) {
    const context = this.buildEvaluationContext(
      checkName,
      checkSchema,
      checkGroup,
      reviewSummary,
      previousOutputs,
      authorAssociation
    );
    const results = [];
    if (globalConditions) {
      const globalResults = await this.evaluateConditionSet(globalConditions, context, "global");
      results.push(...globalResults);
    }
    if (checkConditions) {
      const checkResults = await this.evaluateConditionSet(checkConditions, context, "check");
      const overriddenConditions = new Set(Object.keys(checkConditions));
      const filteredResults = results.filter(
        (result) => !overriddenConditions.has(result.conditionName)
      );
      results.length = 0;
      results.push(...filteredResults, ...checkResults);
    }
    try {
      if (checkName === "B") {
        console.error(
          `\u{1F527} Debug: fail_if results for ${checkName}: ${JSON.stringify(results)} context.output=${JSON.stringify(
            context.output
          )}`
        );
      }
    } catch {
    }
    return results;
  }
  /**
   * Evaluate a set of failure conditions
   */
  async evaluateConditionSet(conditions, context, source) {
    const results = [];
    for (const [conditionName, condition] of Object.entries(conditions)) {
      try {
        const result = await this.evaluateSingleCondition(conditionName, condition, context);
        results.push(result);
      } catch (error) {
        results.push({
          conditionName,
          failed: false,
          expression: this.extractExpression(condition),
          severity: "error",
          haltExecution: false,
          error: `Failed to evaluate ${source} condition '${conditionName}': ${error instanceof Error ? error.message : String(error)}`
        });
      }
    }
    return results;
  }
  /**
   * Evaluate a single failure condition
   */
  async evaluateSingleCondition(conditionName, condition, context) {
    const expression = this.extractExpression(condition);
    const config = this.extractConditionConfig(condition);
    try {
      const failed = this.evaluateExpression(expression, context);
      return {
        conditionName,
        failed,
        expression,
        message: config.message,
        severity: config.severity || "error",
        haltExecution: config.halt_execution || false
      };
    } catch (error) {
      throw new Error(
        `Expression evaluation error: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  /**
   * Secure expression evaluation using SandboxJS
   * Supports the same GitHub Actions-style functions as the previous implementation
   */
  evaluateExpression(condition, context) {
    try {
      const normalize = (expr) => {
        const trimmed = expr.trim();
        if (!/[\n;]/.test(trimmed)) return trimmed;
        const parts = trimmed.split(/[\n;]+/).map((s) => s.trim()).filter((s) => s.length > 0 && !s.startsWith("//"));
        if (parts.length === 0) return "true";
        const lastRaw = parts.pop();
        const last = lastRaw.replace(/^return\s+/i, "").trim();
        if (parts.length === 0) return last;
        return `(${parts.join(", ")}, ${last})`;
      };
      const contains = (searchString, searchValue) => String(searchString).toLowerCase().includes(String(searchValue).toLowerCase());
      const startsWith = (searchString, searchValue) => String(searchString).toLowerCase().startsWith(String(searchValue).toLowerCase());
      const endsWith = (searchString, searchValue) => String(searchString).toLowerCase().endsWith(String(searchValue).toLowerCase());
      const length = (value) => {
        if (typeof value === "string" || Array.isArray(value)) {
          return value.length;
        }
        if (value && typeof value === "object") {
          return Object.keys(value).length;
        }
        return 0;
      };
      const always = () => true;
      const success = () => true;
      const failure = () => false;
      const log2 = (...args) => {
        console.log("\u{1F50D} Debug:", ...args);
      };
      const hasIssue = (issues2, field, value) => {
        if (!Array.isArray(issues2)) return false;
        return issues2.some((issue) => issue[field] === value);
      };
      const countIssues = (issues2, field, value) => {
        if (!Array.isArray(issues2)) return 0;
        return issues2.filter((issue) => issue[field] === value).length;
      };
      const hasFileMatching = (issues2, pattern) => {
        if (!Array.isArray(issues2)) return false;
        return issues2.some((issue) => issue.file?.includes(pattern));
      };
      const hasSuggestion = (suggestions2, text) => {
        if (!Array.isArray(suggestions2)) return false;
        return suggestions2.some((s) => s.toLowerCase().includes(text.toLowerCase()));
      };
      const hasIssueWith = hasIssue;
      const hasFileWith = hasFileMatching;
      const permissionHelpers = createPermissionHelpers(
        context.authorAssociation,
        detectLocalMode()
      );
      const hasMinPermission = permissionHelpers.hasMinPermission;
      const isOwner = permissionHelpers.isOwner;
      const isMember = permissionHelpers.isMember;
      const isCollaborator = permissionHelpers.isCollaborator;
      const isContributor = permissionHelpers.isContributor;
      const isFirstTimer = permissionHelpers.isFirstTimer;
      const output = context.output || {};
      const issues = output.issues || [];
      const suggestions = [];
      const metadata = context.metadata || {
        checkName: context.checkName || "",
        schema: context.schema || "",
        group: context.group || "",
        criticalIssues: issues.filter((i) => i.severity === "critical").length,
        errorIssues: issues.filter((i) => i.severity === "error").length,
        warningIssues: issues.filter((i) => i.severity === "warning").length,
        infoIssues: issues.filter((i) => i.severity === "info").length,
        totalIssues: issues.length,
        hasChanges: context.hasChanges || false
      };
      const criticalIssues = metadata.criticalIssues;
      const errorIssues = metadata.errorIssues;
      const totalIssues = metadata.totalIssues;
      const warningIssues = metadata.warningIssues;
      const infoIssues = metadata.infoIssues;
      const checkName = context.checkName || "";
      const schema = context.schema || "";
      const group = context.group || "";
      const branch = context.branch || "unknown";
      const baseBranch = context.baseBranch || "main";
      const filesChanged = context.filesChanged || [];
      const filesCount = context.filesCount || 0;
      const event = context.event || "manual";
      const env = context.env || {};
      const outputs = context.outputs || {};
      const debugData = context.debug || null;
      const scope = {
        // Primary context variables
        output,
        outputs,
        debug: debugData,
        // Legacy compatibility variables
        issues,
        suggestions,
        metadata,
        criticalIssues,
        errorIssues,
        totalIssues,
        warningIssues,
        infoIssues,
        // If condition context
        checkName,
        schema,
        group,
        branch,
        baseBranch,
        filesChanged,
        filesCount,
        event,
        env,
        // Helper functions
        contains,
        startsWith,
        endsWith,
        length,
        always,
        success,
        failure,
        log: log2,
        hasIssue,
        countIssues,
        hasFileMatching,
        hasSuggestion,
        hasIssueWith,
        hasFileWith,
        // Permission helpers
        hasMinPermission,
        isOwner,
        isMember,
        isCollaborator,
        isContributor,
        isFirstTimer
      };
      const raw = condition.trim();
      if (!this.sandbox) {
        this.sandbox = this.createSecureSandbox();
      }
      let exec;
      try {
        exec = this.sandbox.compile(`return (${raw});`);
      } catch {
        const normalizedExpr = normalize(condition);
        exec = this.sandbox.compile(`return (${normalizedExpr});`);
      }
      const result = exec(scope).run();
      try {
        (init_logger(), __toCommonJS(logger_exports)).logger.debug(`  fail_if: result=${Boolean(result)}`);
      } catch {
      }
      return Boolean(result);
    } catch (error) {
      console.error("\u274C Failed to evaluate expression:", condition, error);
      throw error;
    }
  }
  /**
   * Extract the expression from a failure condition
   */
  extractExpression(condition) {
    if (typeof condition === "string") {
      return condition;
    }
    return condition.condition;
  }
  /**
   * Extract configuration from a failure condition
   */
  extractConditionConfig(condition) {
    if (typeof condition === "string") {
      return {};
    }
    return {
      message: condition.message,
      severity: condition.severity,
      halt_execution: condition.halt_execution
    };
  }
  /**
   * Build the evaluation context for expressions
   */
  buildEvaluationContext(checkName, checkSchema, checkGroup, reviewSummary, previousOutputs, authorAssociation) {
    const { issues, debug } = reviewSummary;
    const reviewSummaryWithOutput = reviewSummary;
    const {
      output: extractedOutput,
      // Exclude issues from otherFields since we handle it separately
      issues: _issues,
      // eslint-disable-line @typescript-eslint/no-unused-vars
      ...otherFields
    } = reviewSummaryWithOutput;
    const aggregatedOutput = {
      issues: (issues || []).map((issue) => ({
        file: issue.file,
        line: issue.line,
        endLine: issue.endLine,
        ruleId: issue.ruleId,
        message: issue.message,
        severity: issue.severity,
        category: issue.category,
        group: issue.group,
        schema: issue.schema,
        suggestion: issue.suggestion,
        replacement: issue.replacement
      })),
      // Include additional schema-specific data from reviewSummary
      ...otherFields
    };
    if (Array.isArray(extractedOutput)) {
      aggregatedOutput.items = extractedOutput;
      const anyError = extractedOutput.find(
        (it) => it && typeof it === "object" && it.error
      );
      if (anyError && anyError.error !== void 0) {
        aggregatedOutput.error = anyError.error;
      }
    } else if (extractedOutput && typeof extractedOutput === "object") {
      Object.assign(aggregatedOutput, extractedOutput);
    }
    try {
      const raw = reviewSummaryWithOutput.__raw;
      if (raw && typeof raw === "object") {
        Object.assign(aggregatedOutput, raw);
      }
    } catch {
    }
    try {
      if (typeof extractedOutput === "string") {
        const parsed = this.tryExtractJsonFromEnd(extractedOutput) ?? (() => {
          try {
            return JSON.parse(extractedOutput);
          } catch {
            return null;
          }
        })();
        if (parsed !== null) {
          if (Array.isArray(parsed)) {
            aggregatedOutput.items = parsed;
          } else if (typeof parsed === "object") {
            Object.assign(aggregatedOutput, parsed);
          }
        }
        const lower = extractedOutput.toLowerCase();
        const boolFrom = (key) => {
          const reTrue = new RegExp(
            `(?:^|[^a-z0-9_])${key}[^a-z0-9_]*[:=][^a-z0-9_]*true(?:[^a-z0-9_]|$)`
          );
          const reFalse = new RegExp(
            `(?:^|[^a-z0-9_])${key}[^a-z0-9_]*[:=][^a-z0-9_]*false(?:[^a-z0-9_]|$)`
          );
          if (reTrue.test(lower)) return true;
          if (reFalse.test(lower)) return false;
          return null;
        };
        const keys = ["error"];
        for (const k of keys) {
          const v = boolFrom(k);
          if (v !== null && aggregatedOutput[k] === void 0) {
            aggregatedOutput[k] = v;
          }
        }
      }
    } catch {
    }
    try {
      const rsAny = reviewSummaryWithOutput;
      const hasStructuredOutput = extractedOutput !== void 0 && extractedOutput !== null;
      if (!hasStructuredOutput && typeof rsAny?.content === "string") {
        const parsedFromContent = this.tryExtractJsonFromEnd(rsAny.content);
        if (parsedFromContent !== null && parsedFromContent !== void 0) {
          if (Array.isArray(parsedFromContent)) {
            aggregatedOutput.items = parsedFromContent;
          } else if (typeof parsedFromContent === "object") {
            Object.assign(aggregatedOutput, parsedFromContent);
          }
        }
      }
    } catch {
    }
    const context = {
      output: aggregatedOutput,
      outputs: (() => {
        if (!previousOutputs) return {};
        const outputs = {};
        for (const [checkName2, result] of Object.entries(previousOutputs)) {
          const summary = result;
          outputs[checkName2] = summary.output !== void 0 ? summary.output : summary;
        }
        return outputs;
      })(),
      // Add basic context info for failure conditions
      checkName,
      schema: checkSchema,
      group: checkGroup,
      authorAssociation
    };
    if (debug) {
      context.debug = {
        errors: debug.errors || [],
        processingTime: debug.processingTime || 0,
        provider: debug.provider || "unknown",
        model: debug.model || "unknown"
      };
    }
    return context;
  }
  // Minimal JSON-from-end extractor for fail_if context fallback
  tryExtractJsonFromEnd(text) {
    try {
      const lines = text.split("\n");
      for (let i = lines.length - 1; i >= 0; i--) {
        const t = lines[i].trim();
        if (t.startsWith("{") || t.startsWith("[")) {
          const candidate = lines.slice(i).join("\n").trim();
          if (candidate.startsWith("{") && candidate.endsWith("}") || candidate.startsWith("[") && candidate.endsWith("]")) {
            return JSON.parse(candidate);
          }
        }
      }
    } catch {
    }
    return null;
  }
  /**
   * Check if any failure condition requires halting execution
   */
  static shouldHaltExecution(results) {
    return results.some((result) => result.failed && result.haltExecution);
  }
  /**
   * Get all failed conditions
   */
  static getFailedConditions(results) {
    return results.filter((result) => result.failed);
  }
  /**
   * Group results by severity
   */
  static groupResultsBySeverity(results) {
    return {
      // Only 'error' severity now (no backward compatibility needed here as this is internal)
      error: results.filter((r) => r.severity === "error"),
      warning: results.filter((r) => r.severity === "warning"),
      info: results.filter((r) => r.severity === "info")
    };
  }
  /**
   * Format results for display
   */
  static formatResults(results) {
    const failed = _FailureConditionEvaluator.getFailedConditions(results);
    if (failed.length === 0) {
      return "\u2705 All failure conditions passed";
    }
    const grouped = _FailureConditionEvaluator.groupResultsBySeverity(failed);
    const sections = [];
    if (grouped.error.length > 0) {
      sections.push(`\u274C **Error severity conditions (${grouped.error.length}):**`);
      grouped.error.forEach((result) => {
        sections.push(`  - ${result.conditionName}: ${result.message || result.expression}`);
      });
    }
    if (grouped.warning.length > 0) {
      sections.push(`\u26A0\uFE0F **Warning conditions (${grouped.warning.length}):**`);
      grouped.warning.forEach((result) => {
        sections.push(`  - ${result.conditionName}: ${result.message || result.expression}`);
      });
    }
    if (grouped.info.length > 0) {
      sections.push(`\u2139\uFE0F **Info conditions (${grouped.info.length}):**`);
      grouped.info.forEach((result) => {
        sections.push(`  - ${result.conditionName}: ${result.message || result.expression}`);
      });
    }
    return sections.join("\n");
  }
};

// src/github-check-service.ts
var GitHubCheckService = class {
  octokit;
  maxAnnotations = 50;
  // GitHub API limit
  constructor(octokit) {
    this.octokit = octokit;
  }
  /**
   * Create a new check run in queued status
   */
  async createCheckRun(options, summary) {
    try {
      const response = await this.octokit.rest.checks.create({
        owner: options.owner,
        repo: options.repo,
        name: options.name,
        head_sha: options.head_sha,
        status: "queued",
        details_url: options.details_url,
        external_id: options.external_id,
        output: summary ? {
          title: summary.title,
          summary: summary.summary,
          text: summary.text
        } : void 0
      });
      return {
        id: response.data.id,
        url: response.data.html_url || ""
      };
    } catch (error) {
      throw new Error(
        `Failed to create check run: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  /**
   * Update check run to in_progress status
   */
  async updateCheckRunInProgress(owner, repo, check_run_id, summary) {
    try {
      await this.octokit.rest.checks.update({
        owner,
        repo,
        check_run_id,
        status: "in_progress",
        output: summary ? {
          title: summary.title,
          summary: summary.summary,
          text: summary.text
        } : void 0
      });
    } catch (error) {
      throw new Error(
        `Failed to update check run to in_progress: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  /**
   * Complete a check run with results based on failure conditions
   */
  async completeCheckRun(owner, repo, check_run_id, checkName, failureResults, reviewIssues = [], executionError, filesChangedInCommit, prNumber, currentCommitSha) {
    try {
      if (prNumber && currentCommitSha) {
        await this.clearOldAnnotations(
          owner,
          repo,
          prNumber,
          checkName,
          currentCommitSha,
          check_run_id
        );
      }
      const { conclusion, summary } = this.determineCheckRunConclusion(
        checkName,
        failureResults,
        reviewIssues,
        executionError
      );
      let filteredIssues = reviewIssues.filter(
        (issue) => !(issue.file === "system" && issue.line === 0)
      );
      if (filesChangedInCommit && filesChangedInCommit.length > 0) {
        filteredIssues = filteredIssues.filter(
          (issue) => filesChangedInCommit.some((changedFile) => issue.file === changedFile)
        );
      }
      const annotations = this.convertIssuesToAnnotations(filteredIssues);
      await this.octokit.rest.checks.update({
        owner,
        repo,
        check_run_id,
        status: "completed",
        conclusion,
        completed_at: (/* @__PURE__ */ new Date()).toISOString(),
        output: {
          title: summary.title,
          summary: summary.summary,
          text: summary.text,
          annotations: annotations.slice(0, this.maxAnnotations)
          // GitHub limit
        }
      });
    } catch (error) {
      throw new Error(
        `Failed to complete check run: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  /**
   * Determine check run conclusion based on failure conditions and issues
   */
  determineCheckRunConclusion(checkName, failureResults, reviewIssues, executionError) {
    if (executionError) {
      return {
        conclusion: "failure",
        summary: {
          title: "\u274C Check Execution Failed",
          summary: `The ${checkName} check failed to execute properly.`,
          text: `**Error:** ${executionError}

Please check your configuration and try again.`
        }
      };
    }
    const failedConditions = failureResults.filter((result) => result.failed);
    const criticalIssues = reviewIssues.filter((issue) => issue.severity === "critical").length;
    const errorIssues = reviewIssues.filter((issue) => issue.severity === "error").length;
    const warningIssues = reviewIssues.filter((issue) => issue.severity === "warning").length;
    const totalIssues = reviewIssues.length;
    let conclusion;
    let title;
    let summaryText;
    let details;
    if (failedConditions.length > 0) {
      conclusion = "failure";
      title = "\u{1F6A8} Check Failed";
      summaryText = `${checkName} check failed because fail_if condition was met.`;
      details = this.formatCheckDetails(failureResults, reviewIssues, {
        failedConditions: failedConditions.length,
        warningConditions: 0,
        criticalIssues,
        errorIssues,
        warningIssues,
        totalIssues
      });
    } else {
      conclusion = "success";
      if (criticalIssues > 0 || errorIssues > 0) {
        title = "\u2705 Check Passed (Issues Found)";
        summaryText = `${checkName} check passed. Found ${criticalIssues} critical and ${errorIssues} error issues, but fail_if condition was not met.`;
      } else if (warningIssues > 0) {
        title = "\u2705 Check Passed (Warnings Found)";
        summaryText = `${checkName} check passed. Found ${warningIssues} warning${warningIssues === 1 ? "" : "s"}, but fail_if condition was not met.`;
      } else {
        title = "\u2705 Check Passed";
        summaryText = `${checkName} check completed successfully with no issues found.`;
      }
      details = this.formatCheckDetails(failureResults, reviewIssues, {
        failedConditions: 0,
        warningConditions: 0,
        criticalIssues,
        errorIssues,
        warningIssues,
        totalIssues
      });
    }
    return {
      conclusion,
      summary: {
        title,
        summary: summaryText,
        text: details
      }
    };
  }
  /**
   * Format detailed check results for the check run summary
   */
  formatCheckDetails(failureResults, reviewIssues, counts) {
    const sections = [];
    sections.push("## \u{1F4CA} Summary");
    sections.push(`- **Total Issues:** ${counts.totalIssues}`);
    if (counts.criticalIssues > 0) {
      sections.push(`- **Critical Issues:** ${counts.criticalIssues}`);
    }
    if (counts.errorIssues > 0) {
      sections.push(`- **Error Issues:** ${counts.errorIssues}`);
    }
    if (counts.warningIssues > 0) {
      sections.push(`- **Warning Issues:** ${counts.warningIssues}`);
    }
    sections.push("");
    if (failureResults.length > 0) {
      sections.push("## \u{1F50D} Failure Condition Results");
      const failedConditions = failureResults.filter((result) => result.failed);
      const passedConditions = failureResults.filter((result) => !result.failed);
      if (failedConditions.length > 0) {
        sections.push("### \u274C Failed Conditions");
        failedConditions.forEach((condition) => {
          sections.push(
            `- **${condition.conditionName}**: ${condition.message || condition.expression}`
          );
          if (condition.severity === "error") {
            sections.push(`  - \u26A0\uFE0F **Severity:** Error`);
          }
        });
        sections.push("");
      }
      if (passedConditions.length > 0) {
        sections.push("### \u2705 Passed Conditions");
        passedConditions.forEach((condition) => {
          sections.push(
            `- **${condition.conditionName}**: ${condition.message || "Condition passed"}`
          );
        });
        sections.push("");
      }
    }
    if (reviewIssues.length > 0) {
      const issuesByCategory = this.groupIssuesByCategory(reviewIssues);
      sections.push("## \u{1F41B} Issues by Category");
      Object.entries(issuesByCategory).forEach(([category, issues]) => {
        if (issues.length > 0) {
          sections.push(
            `### ${this.getCategoryEmoji(category)} ${category.charAt(0).toUpperCase() + category.slice(1)} (${issues.length})`
          );
          const displayIssues = issues.slice(0, 5);
          displayIssues.forEach((issue) => {
            const severityIcon = this.getSeverityIcon(issue.severity);
            sections.push(`- ${severityIcon} **${issue.file}:${issue.line}** - ${issue.message}`);
          });
          if (issues.length > 5) {
            sections.push(`- *...and ${issues.length - 5} more ${category} issues*`);
          }
          sections.push("");
        }
      });
    }
    sections.push("");
    sections.push("---");
    sections.push("");
    sections.push(
      "*Generated by [Visor](https://github.com/probelabs/visor) - AI-powered code review*"
    );
    return sections.join("\n");
  }
  /**
   * Convert review issues to GitHub check run annotations
   */
  convertIssuesToAnnotations(reviewIssues) {
    return reviewIssues.slice(0, this.maxAnnotations).map((issue) => ({
      path: issue.file,
      start_line: issue.line,
      end_line: issue.endLine || issue.line,
      annotation_level: this.mapSeverityToAnnotationLevel(issue.severity),
      message: issue.message,
      title: `${issue.category} Issue`,
      raw_details: issue.suggestion || void 0
    }));
  }
  /**
   * Map Visor issue severity to GitHub annotation level
   */
  mapSeverityToAnnotationLevel(severity) {
    switch (severity) {
      case "critical":
      case "error":
        return "failure";
      case "warning":
        return "warning";
      case "info":
      default:
        return "notice";
    }
  }
  /**
   * Group issues by category
   */
  groupIssuesByCategory(issues) {
    const grouped = {};
    issues.forEach((issue) => {
      const category = issue.category || "general";
      if (!grouped[category]) {
        grouped[category] = [];
      }
      grouped[category].push(issue);
    });
    return grouped;
  }
  /**
   * Get emoji for issue category
   */
  getCategoryEmoji(category) {
    const emojiMap = {
      security: "\u{1F510}",
      performance: "\u26A1",
      style: "\u{1F3A8}",
      logic: "\u{1F9E0}",
      architecture: "\u{1F3D7}\uFE0F",
      documentation: "\u{1F4DA}",
      general: "\u{1F4DD}"
    };
    return emojiMap[category.toLowerCase()] || "\u{1F4DD}";
  }
  /**
   * Get icon for issue severity
   */
  getSeverityIcon(severity) {
    const iconMap = {
      critical: "\u{1F6A8}",
      error: "\u274C",
      warning: "\u26A0\uFE0F",
      info: "\u2139\uFE0F"
    };
    return iconMap[severity.toLowerCase()] || "\u2139\uFE0F";
  }
  /**
   * Create multiple check runs for different checks with failure condition support
   */
  async createMultipleCheckRuns(options, checkResults) {
    const results = [];
    for (const checkResult of checkResults) {
      try {
        const checkRun = await this.createCheckRun({
          ...options,
          name: `Visor: ${checkResult.checkName}`,
          external_id: `visor-${checkResult.checkName}-${options.head_sha.substring(0, 7)}`
        });
        await this.updateCheckRunInProgress(options.owner, options.repo, checkRun.id, {
          title: `Running ${checkResult.checkName} check...`,
          summary: `Analyzing code with ${checkResult.checkName} check using AI.`
        });
        await this.completeCheckRun(
          options.owner,
          options.repo,
          checkRun.id,
          checkResult.checkName,
          checkResult.failureResults,
          checkResult.reviewIssues,
          checkResult.executionError
        );
        results.push({
          checkName: checkResult.checkName,
          id: checkRun.id,
          url: checkRun.url
        });
      } catch (error) {
        console.error(`Failed to create check run for ${checkResult.checkName}:`, error);
      }
    }
    return results;
  }
  /**
   * Get check runs for a specific commit
   */
  async getCheckRuns(owner, repo, ref) {
    try {
      const response = await this.octokit.rest.checks.listForRef({
        owner,
        repo,
        ref,
        filter: "all"
      });
      return response.data.check_runs.filter((check) => check.name.startsWith("Visor:")).map((check) => ({
        id: check.id,
        name: check.name,
        status: check.status,
        conclusion: check.conclusion
      }));
    } catch (error) {
      throw new Error(
        `Failed to get check runs: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  /**
   * Get check runs for a specific commit SHA
   * Returns all check runs with the given name on this commit
   */
  async getCheckRunsForCommit(owner, repo, commitSha, checkName) {
    try {
      const checksResponse = await this.octokit.rest.checks.listForRef({
        owner,
        repo,
        ref: commitSha,
        check_name: `Visor: ${checkName}`
      });
      return checksResponse.data.check_runs.map((check) => ({
        id: check.id,
        head_sha: commitSha
      }));
    } catch (error) {
      throw new Error(
        `Failed to get check runs for commit ${commitSha}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  /**
   * Clear annotations from old check runs on the current commit
   * This prevents annotation accumulation when a check runs multiple times on the same commit
   * (e.g., force push, re-running checks)
   */
  async clearOldAnnotations(owner, repo, prNumber, checkName, currentCommitSha, currentCheckRunId) {
    try {
      const allCheckRuns = await this.getCheckRunsForCommit(
        owner,
        repo,
        currentCommitSha,
        checkName
      );
      const oldRuns = allCheckRuns.filter((run) => run.id !== currentCheckRunId);
      if (oldRuns.length === 0) {
        console.debug(`No old check runs to clear for ${checkName} on commit ${currentCommitSha}`);
        return;
      }
      console.debug(
        `Clearing ${oldRuns.length} old check run(s) for ${checkName} on commit ${currentCommitSha.substring(0, 7)} (keeping current run ${currentCheckRunId})`
      );
      for (const run of oldRuns) {
        try {
          await this.octokit.rest.checks.update({
            owner,
            repo,
            check_run_id: run.id,
            output: {
              title: "Outdated",
              summary: "This check has been superseded by a newer run.",
              annotations: []
              // Clear annotations
            }
          });
          console.debug(`\u2713 Cleared annotations from check run ${run.id}`);
        } catch (error) {
          console.debug(`Could not clear annotations for check run ${run.id}:`, error);
        }
      }
    } catch (error) {
      console.warn("Failed to clear old annotations:", error);
    }
  }
};

// src/check-execution-engine.ts
init_logger();
import Sandbox3 from "@nyariv/sandboxjs";
function getSafeEnvironmentVariables() {
  const safeEnvVars = [
    "CI",
    "GITHUB_EVENT_NAME",
    "GITHUB_REPOSITORY",
    "GITHUB_REF",
    "GITHUB_SHA",
    "GITHUB_HEAD_REF",
    "GITHUB_BASE_REF",
    "GITHUB_ACTOR",
    "GITHUB_WORKFLOW",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_NUMBER",
    "NODE_ENV"
  ];
  const safeEnv = {};
  for (const key of safeEnvVars) {
    if (process.env[key]) {
      safeEnv[key] = process.env[key];
    }
  }
  return safeEnv;
}
var CheckExecutionEngine = class _CheckExecutionEngine {
  gitAnalyzer;
  mockOctokit;
  reviewer;
  providerRegistry;
  failureEvaluator;
  githubCheckService;
  checkRunMap;
  githubContext;
  workingDirectory;
  config;
  webhookContext;
  routingSandbox;
  executionStats = /* @__PURE__ */ new Map();
  // Event override to simulate alternate event (used during routing goto)
  routingEventOverride;
  // Cached GitHub context for context elevation when running in Actions
  actionContext;
  constructor(workingDirectory) {
    this.workingDirectory = workingDirectory || process.cwd();
    this.gitAnalyzer = new GitRepositoryAnalyzer(this.workingDirectory);
    this.providerRegistry = CheckProviderRegistry.getInstance();
    this.failureEvaluator = new FailureConditionEvaluator();
    this.mockOctokit = this.createMockOctokit();
    this.reviewer = new PRReviewer(this.mockOctokit);
  }
  /**
   * Lazily create a secure sandbox for routing JS (goto_js, run_js)
   */
  getRoutingSandbox() {
    if (this.routingSandbox) return this.routingSandbox;
    const globals = {
      ...Sandbox3.SAFE_GLOBALS,
      Math,
      JSON,
      console: { log: console.log }
    };
    const prototypeWhitelist = new Map(Sandbox3.SAFE_PROTOTYPES);
    this.routingSandbox = new Sandbox3({ globals, prototypeWhitelist });
    return this.routingSandbox;
  }
  redact(str, limit = 200) {
    try {
      const s = typeof str === "string" ? str : JSON.stringify(str);
      return s.length > limit ? s.slice(0, limit) + "\u2026" : s;
    } catch {
      return String(str).slice(0, limit);
    }
  }
  async sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
  deterministicJitter(baseMs, seedStr) {
    let h = 2166136261;
    for (let i = 0; i < seedStr.length; i++) h = (h ^ seedStr.charCodeAt(i)) * 16777619;
    const frac = (h >>> 0) % 1e3 / 1e3;
    return Math.floor(baseMs * 0.15 * frac);
  }
  computeBackoffDelay(attempt, mode, baseMs, seed) {
    const jitter = this.deterministicJitter(baseMs, seed);
    if (mode === "exponential") {
      return baseMs * Math.pow(2, Math.max(0, attempt - 1)) + jitter;
    }
    return baseMs + jitter;
  }
  /**
   * Execute a check with retry/backoff and routing semantics (on_fail/on_success)
   */
  async executeWithRouting(checkName, checkConfig, provider, providerConfig, prInfo, dependencyResults, sessionInfo, config, dependencyGraph, debug, resultsMap, foreachContext) {
    const log2 = (msg) => (this.config?.output?.pr_comment ? console.error : console.log)(msg);
    const maxLoops = config?.routing?.max_loops ?? 10;
    const defaults = config?.routing?.defaults?.on_fail || {};
    const onFail = checkConfig.on_fail ? { ...defaults, ...checkConfig.on_fail } : Object.keys(defaults).length ? defaults : void 0;
    const onSuccess = checkConfig.on_success;
    let attempt = 1;
    let loopCount = 0;
    const seed = `${checkName}-${prInfo.number || "local"}`;
    const allAncestors = DependencyResolver.getAllDependencies(checkName, dependencyGraph.nodes);
    const evalRunJs = async (expr, error) => {
      if (!expr) return [];
      try {
        const sandbox = this.getRoutingSandbox();
        const scope = {
          step: { id: checkName, tags: checkConfig.tags || [], group: checkConfig.group },
          attempt,
          loop: loopCount,
          error,
          foreach: foreachContext ? {
            index: foreachContext.index,
            total: foreachContext.total,
            parent: foreachContext.parent
          } : null,
          outputs: Object.fromEntries((dependencyResults || /* @__PURE__ */ new Map()).entries()),
          pr: {
            number: prInfo.number,
            title: prInfo.title,
            author: prInfo.author,
            branch: prInfo.head,
            base: prInfo.base
          },
          files: prInfo.files,
          env: getSafeEnvironmentVariables(),
          permissions: createPermissionHelpers(prInfo.authorAssociation, detectLocalMode())
        };
        const code = `
          const step = scope.step; const attempt = scope.attempt; const loop = scope.loop; const error = scope.error; const foreach = scope.foreach; const outputs = scope.outputs; const pr = scope.pr; const files = scope.files; const env = scope.env; const log = (...a)=>console.log('\u{1F50D} Debug:',...a); const hasMinPermission = scope.permissions.hasMinPermission; const isOwner = scope.permissions.isOwner; const isMember = scope.permissions.isMember; const isCollaborator = scope.permissions.isCollaborator; const isContributor = scope.permissions.isContributor; const isFirstTimer = scope.permissions.isFirstTimer;
          const __fn = () => {
${expr}
};
          const __res = __fn();
          return Array.isArray(__res) ? __res : (__res ? [__res] : []);
        `;
        const exec = sandbox.compile(code);
        const res = exec({ scope }).run();
        if (debug) {
          log2(`\u{1F527} Debug: run_js evaluated \u2192 [${this.redact(res)}]`);
        }
        return Array.isArray(res) ? res.filter((x) => typeof x === "string") : [];
      } catch (e) {
        if (debug) {
          log2(`\u26A0\uFE0F Debug: run_js evaluation failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        return [];
      }
    };
    const evalGotoJs = async (expr, error) => {
      if (!expr) return null;
      try {
        const sandbox = this.getRoutingSandbox();
        const scope = {
          step: { id: checkName, tags: checkConfig.tags || [], group: checkConfig.group },
          attempt,
          loop: loopCount,
          error,
          foreach: foreachContext ? {
            index: foreachContext.index,
            total: foreachContext.total,
            parent: foreachContext.parent
          } : null,
          outputs: Object.fromEntries((dependencyResults || /* @__PURE__ */ new Map()).entries()),
          pr: {
            number: prInfo.number,
            title: prInfo.title,
            author: prInfo.author,
            branch: prInfo.head,
            base: prInfo.base
          },
          files: prInfo.files,
          env: getSafeEnvironmentVariables(),
          permissions: createPermissionHelpers(prInfo.authorAssociation, detectLocalMode())
        };
        const code = `
          const step = scope.step; const attempt = scope.attempt; const loop = scope.loop; const error = scope.error; const foreach = scope.foreach; const outputs = scope.outputs; const pr = scope.pr; const files = scope.files; const env = scope.env; const log = (...a)=>console.log('\u{1F50D} Debug:',...a); const hasMinPermission = scope.permissions.hasMinPermission; const isOwner = scope.permissions.isOwner; const isMember = scope.permissions.isMember; const isCollaborator = scope.permissions.isCollaborator; const isContributor = scope.permissions.isContributor; const isFirstTimer = scope.permissions.isFirstTimer;
          const __fn = () => {
${expr}
};
          const __res = __fn();
          return (typeof __res === 'string' && __res) ? __res : null;
        `;
        const exec = sandbox.compile(code);
        const res = exec({ scope }).run();
        if (debug) {
          log2(`\u{1F527} Debug: goto_js evaluated \u2192 ${this.redact(res)}`);
        }
        return typeof res === "string" && res ? res : null;
      } catch (e) {
        if (debug) {
          log2(`\u26A0\uFE0F Debug: goto_js evaluation failed: ${e instanceof Error ? e.message : String(e)}`);
        }
        return null;
      }
    };
    const getAllDepsFromConfig = (name) => {
      const visited = /* @__PURE__ */ new Set();
      const acc = [];
      const dfs = (n) => {
        if (visited.has(n)) return;
        visited.add(n);
        const cfg = config?.checks?.[n];
        const deps = cfg?.depends_on || [];
        for (const d of deps) {
          acc.push(d);
          dfs(d);
        }
      };
      dfs(name);
      return Array.from(new Set(acc));
    };
    const executeNamedCheckInline = async (target, opts) => {
      const targetCfg = config?.checks?.[target];
      if (!targetCfg) {
        throw new Error(`on_* referenced unknown check '${target}'`);
      }
      const allTargetDeps = getAllDepsFromConfig(target);
      if (allTargetDeps.length > 0) {
        const subSet = /* @__PURE__ */ new Set([...allTargetDeps]);
        const subDeps = {};
        for (const id of subSet) {
          const cfg = config?.checks?.[id];
          subDeps[id] = (cfg?.depends_on || []).filter((d) => subSet.has(d));
        }
        const subGraph = DependencyResolver.buildDependencyGraph(subDeps);
        for (const group of subGraph.executionOrder) {
          for (const depId of group.parallel) {
            if (resultsMap?.has(depId) || dependencyResults.has(depId)) continue;
            await executeNamedCheckInline(depId);
          }
        }
      }
      const providerType = targetCfg.type || "ai";
      const prov = this.providerRegistry.getProviderOrThrow(providerType);
      this.setProviderWebhookContext(prov);
      const provCfg = {
        type: providerType,
        prompt: targetCfg.prompt,
        exec: targetCfg.exec,
        focus: targetCfg.focus || this.mapCheckNameToFocus(target),
        schema: targetCfg.schema,
        group: targetCfg.group,
        checkName: target,
        eventContext: prInfo.eventContext,
        transform: targetCfg.transform,
        transform_js: targetCfg.transform_js,
        env: targetCfg.env,
        forEach: targetCfg.forEach,
        ai: {
          timeout: providerConfig.ai?.timeout || 6e5,
          debug: !!debug,
          ...targetCfg.ai || {}
        }
      };
      const targetDeps = getAllDepsFromConfig(target);
      const depResults = /* @__PURE__ */ new Map();
      for (const depId of targetDeps) {
        const res = dependencyResults.get(depId) || resultsMap?.get(depId);
        if (res) depResults.set(depId, res);
      }
      try {
        const depPreview = {};
        for (const [k, v] of depResults.entries()) {
          const out = v?.output;
          if (out !== void 0) depPreview[k] = out;
        }
        if (debug) {
          log2(`\u{1F527} Debug: inline exec '${target}' deps output: ${JSON.stringify(depPreview)}`);
        }
      } catch {
      }
      if (debug) {
        const execStr = provCfg.exec;
        if (execStr) log2(`\u{1F527} Debug: inline exec '${target}' command: ${execStr}`);
      }
      let prInfoForInline = prInfo;
      const prevEventOverride = this.routingEventOverride;
      if (opts?.eventOverride) {
        const elevated = await this.elevateContextToPullRequest(
          { ...prInfo, eventType: opts.eventOverride },
          opts.eventOverride,
          log2,
          debug
        );
        if (elevated) {
          prInfoForInline = elevated;
        } else {
          prInfoForInline = { ...prInfo, eventType: opts.eventOverride };
        }
        this.routingEventOverride = opts.eventOverride;
        if (debug)
          log2(
            `\u{1F527} Debug: inline '${target}' with goto_event=${opts.eventOverride}${elevated ? " (elevated to PR context)" : ""}`
          );
      }
      let r;
      try {
        r = await prov.execute(prInfoForInline, provCfg, depResults, sessionInfo);
      } finally {
        this.routingEventOverride = prevEventOverride;
      }
      const enrichedIssues = (r.issues || []).map((issue) => ({
        ...issue,
        checkName: target,
        ruleId: `${target}/${issue.ruleId}`,
        group: targetCfg.group,
        schema: typeof targetCfg.schema === "object" ? "custom" : targetCfg.schema,
        template: targetCfg.template,
        timestamp: Date.now()
      }));
      const enriched = { ...r, issues: enrichedIssues };
      resultsMap?.set(target, enriched);
      if (debug) log2(`\u{1F527} Debug: inline executed '${target}', issues: ${enrichedIssues.length}`);
      return enriched;
    };
    while (true) {
      try {
        const res = await provider.execute(prInfo, providerConfig, dependencyResults, sessionInfo);
        const hasSoftFailure = (res.issues || []).some(
          (i) => i.severity === "error" || i.severity === "critical"
        );
        if (hasSoftFailure && onFail) {
          if (debug)
            log2(
              `\u{1F527} Debug: Soft failure detected for '${checkName}' with ${(res.issues || []).length} issue(s)`
            );
          const lastError = {
            message: "soft-failure: issues present",
            code: "soft_failure",
            issues: res.issues
          };
          const dynamicRun = await evalRunJs(onFail.run_js, lastError);
          let runList = [...onFail.run || [], ...dynamicRun].filter(Boolean);
          runList = Array.from(new Set(runList));
          if (debug) log2(`\u{1F527} Debug: on_fail.run (soft) list = [${runList.join(", ")}]`);
          if (runList.length > 0) {
            loopCount++;
            if (loopCount > maxLoops) {
              throw new Error(
                `Routing loop budget exceeded (max_loops=${maxLoops}) during on_fail run`
              );
            }
            if (debug) log2(`\u{1F527} Debug: on_fail.run (soft) executing [${runList.join(", ")}]`);
            for (const stepId of runList) {
              await executeNamedCheckInline(stepId);
            }
          }
          let target = await evalGotoJs(onFail.goto_js, lastError);
          if (!target && onFail.goto) target = onFail.goto;
          if (debug) log2(`\u{1F527} Debug: on_fail.goto (soft) target = ${target}`);
          if (target) {
            if (!allAncestors.includes(target)) {
              if (debug)
                log2(
                  `\u26A0\uFE0F Debug: on_fail.goto (soft) '${target}' is not an ancestor of '${checkName}' \u2014 skipping`
                );
            } else {
              loopCount++;
              if (loopCount > maxLoops) {
                throw new Error(
                  `Routing loop budget exceeded (max_loops=${maxLoops}) during on_fail goto`
                );
              }
              await executeNamedCheckInline(target, { eventOverride: onFail.goto_event });
            }
          }
          const retryMax = onFail.retry?.max ?? 0;
          const base = onFail.retry?.backoff?.delay_ms ?? 0;
          const mode = onFail.retry?.backoff?.mode ?? "fixed";
          if (attempt <= retryMax) {
            loopCount++;
            if (loopCount > maxLoops) {
              throw new Error(`Routing loop budget exceeded (max_loops=${maxLoops}) during retry`);
            }
            const delay = base > 0 ? this.computeBackoffDelay(attempt, mode, base, seed) : 0;
            if (debug)
              log2(
                `\u{1F501} Debug: retrying '${checkName}' (soft) attempt ${attempt + 1}/${retryMax + 1} after ${delay}ms`
              );
            if (delay > 0) await this.sleep(delay);
            attempt++;
            continue;
          }
          return res;
        }
        let needRerun = false;
        let rerunEventOverride;
        if (onSuccess) {
          const dynamicRun = await evalRunJs(onSuccess.run_js);
          const runList = [...onSuccess.run || [], ...dynamicRun].filter(Boolean);
          if (runList.length > 0) {
            loopCount++;
            if (loopCount > maxLoops) {
              throw new Error(
                `Routing loop budget exceeded (max_loops=${maxLoops}) during on_success run`
              );
            }
            for (const stepId of Array.from(new Set(runList))) {
              await executeNamedCheckInline(stepId);
            }
          }
          let target = await evalGotoJs(onSuccess.goto_js);
          if (!target && onSuccess.goto) target = onSuccess.goto;
          if (target) {
            if (!allAncestors.includes(target)) {
              if (debug)
                log2(
                  `\u26A0\uFE0F Debug: on_success.goto '${target}' is not an ancestor of '${checkName}' \u2014 skipping`
                );
            } else {
              loopCount++;
              if (loopCount > maxLoops) {
                throw new Error(
                  `Routing loop budget exceeded (max_loops=${maxLoops}) during on_success goto`
                );
              }
              await executeNamedCheckInline(target, { eventOverride: onSuccess.goto_event });
              needRerun = true;
              rerunEventOverride = onSuccess.goto_event;
            }
          }
        }
        if (needRerun) {
          if (debug) log2(`\u{1F504} Debug: Re-running '${checkName}' after on_success.goto`);
          const prev = this.routingEventOverride;
          if (rerunEventOverride) this.routingEventOverride = rerunEventOverride;
          attempt++;
          this.routingEventOverride = prev;
          continue;
        }
        return res;
      } catch (err) {
        if (!onFail) {
          throw err;
        }
        const lastError = err instanceof Error ? err : new Error(String(err));
        const dynamicRun = await evalRunJs(onFail.run_js, lastError);
        let runList = [...onFail.run || [], ...dynamicRun].filter(Boolean);
        runList = Array.from(new Set(runList));
        if (runList.length > 0) {
          loopCount++;
          if (loopCount > maxLoops) {
            throw new Error(
              `Routing loop budget exceeded (max_loops=${maxLoops}) during on_fail run`
            );
          }
          if (debug) log2(`\u{1F527} Debug: on_fail.run executing [${runList.join(", ")}]`);
          for (const stepId of runList) {
            await executeNamedCheckInline(stepId);
          }
        }
        let target = await evalGotoJs(onFail.goto_js, lastError);
        if (!target && onFail.goto) target = onFail.goto;
        if (target) {
          if (!allAncestors.includes(target)) {
            if (debug)
              log2(
                `\u26A0\uFE0F Debug: on_fail.goto '${target}' is not an ancestor of '${checkName}' \u2014 skipping`
              );
          } else {
            loopCount++;
            if (loopCount > maxLoops) {
              throw new Error(
                `Routing loop budget exceeded (max_loops=${maxLoops}) during on_fail goto`
              );
            }
            await executeNamedCheckInline(target, { eventOverride: onFail.goto_event });
          }
        }
        const retryMax = onFail.retry?.max ?? 0;
        const base = onFail.retry?.backoff?.delay_ms ?? 0;
        const mode = onFail.retry?.backoff?.mode ?? "fixed";
        if (attempt <= retryMax) {
          loopCount++;
          if (loopCount > maxLoops) {
            throw new Error(`Routing loop budget exceeded (max_loops=${maxLoops}) during retry`);
          }
          const delay = base > 0 ? this.computeBackoffDelay(attempt, mode, base, seed) : 0;
          if (debug)
            log2(
              `\u{1F501} Debug: retrying '${checkName}' attempt ${attempt + 1}/${retryMax + 1} after ${delay}ms`
            );
          if (delay > 0) await this.sleep(delay);
          attempt++;
          continue;
        }
        throw lastError;
      }
    }
  }
  /**
   * Set webhook context on a provider if it supports it
   */
  setProviderWebhookContext(provider) {
    if (this.webhookContext && provider.setWebhookContext) {
      provider.setWebhookContext(this.webhookContext.webhookData);
    }
  }
  /**
   * Filter checks based on tag filter configuration
   */
  filterChecksByTags(checks, config, tagFilter) {
    const logFn = this.config?.output?.pr_comment ? console.error : console.log;
    return checks.filter((checkName) => {
      const checkConfig = config?.checks?.[checkName];
      if (!checkConfig) {
        return true;
      }
      const checkTags = checkConfig.tags || [];
      if (checkTags.length > 0 && (!tagFilter || !tagFilter.include && !tagFilter.exclude)) {
        logFn(`\u23ED\uFE0F Skipping check '${checkName}' - check has tags but no tag filter specified`);
        return false;
      }
      if (!tagFilter || !tagFilter.include && !tagFilter.exclude) {
        return true;
      }
      if (checkTags.length === 0) {
        return true;
      }
      if (tagFilter.exclude && tagFilter.exclude.length > 0) {
        const hasExcludedTag = tagFilter.exclude.some((tag) => checkTags.includes(tag));
        if (hasExcludedTag) {
          logFn(`\u23ED\uFE0F Skipping check '${checkName}' - has excluded tag`);
          return false;
        }
      }
      if (tagFilter.include && tagFilter.include.length > 0) {
        const hasIncludedTag = tagFilter.include.some((tag) => checkTags.includes(tag));
        if (!hasIncludedTag) {
          logFn(`\u23ED\uFE0F Skipping check '${checkName}' - does not have required tags`);
          return false;
        }
      }
      return true;
    });
  }
  /**
   * Execute checks on the local repository
   */
  async executeChecks(options) {
    const startTime = Date.now();
    const timestamp = (/* @__PURE__ */ new Date()).toISOString();
    try {
      this.webhookContext = options.webhookContext;
      const logFn = (msg) => logger.info(msg);
      if (options.githubChecks?.enabled && options.githubChecks.octokit) {
        await this.initializeGitHubChecks(options, logFn);
      }
      logFn("\u{1F50D} Analyzing local git repository...");
      const repositoryInfo = await this.gitAnalyzer.analyzeRepository();
      if (!repositoryInfo.isGitRepository) {
        if (this.checkRunMap) {
          await this.completeGitHubChecksWithError("Not a git repository or no changes found");
        }
        return this.createErrorResult(
          repositoryInfo,
          "Not a git repository or no changes found",
          startTime,
          timestamp,
          options.checks
        );
      }
      const prInfo = this.gitAnalyzer.toPRInfo(repositoryInfo);
      const filteredChecks = this.filterChecksByTags(
        options.checks,
        options.config,
        options.tagFilter || options.config?.tag_filter
      );
      if (filteredChecks.length === 0) {
        logger.warn("\u26A0\uFE0F No checks match the tag filter criteria");
        if (this.checkRunMap) {
          await this.completeGitHubChecksWithError("No checks match the tag filter criteria");
        }
        return this.createErrorResult(
          repositoryInfo,
          "No checks match the tag filter criteria",
          startTime,
          timestamp,
          options.checks
        );
      }
      if (this.checkRunMap) {
        await this.updateGitHubChecksInProgress(options);
      }
      logFn(`\u{1F916} Executing checks: ${filteredChecks.join(", ")}`);
      const reviewSummary = await this.executeReviewChecks(
        prInfo,
        filteredChecks,
        options.timeout,
        options.config,
        options.outputFormat,
        options.debug,
        options.maxParallelism,
        options.failFast
      );
      if (this.checkRunMap) {
        await this.completeGitHubChecksWithResults(reviewSummary, options, prInfo);
      }
      const executionTime = Date.now() - startTime;
      let debugInfo;
      if (options.debug && reviewSummary.debug) {
        debugInfo = {
          provider: reviewSummary.debug.provider,
          model: reviewSummary.debug.model,
          processingTime: reviewSummary.debug.processingTime,
          parallelExecution: options.checks.length > 1,
          checksExecuted: options.checks,
          totalApiCalls: reviewSummary.debug.totalApiCalls || options.checks.length,
          apiCallDetails: reviewSummary.debug.apiCallDetails
        };
      }
      const executionStatistics = this.buildExecutionStatistics();
      return {
        repositoryInfo,
        reviewSummary,
        executionTime,
        timestamp,
        checksExecuted: filteredChecks,
        executionStatistics,
        debug: debugInfo
      };
    } catch (error) {
      logger.error(
        "Error executing checks: " + (error instanceof Error ? error.message : String(error))
      );
      if (this.checkRunMap) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
        await this.completeGitHubChecksWithError(errorMessage);
      }
      const fallbackRepositoryInfo = {
        title: "Error during analysis",
        body: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
        author: "system",
        base: "main",
        head: "HEAD",
        files: [],
        totalAdditions: 0,
        totalDeletions: 0,
        isGitRepository: false,
        workingDirectory: options.workingDirectory || process.cwd()
      };
      return this.createErrorResult(
        fallbackRepositoryInfo,
        error instanceof Error ? error.message : "Unknown error occurred",
        startTime,
        timestamp,
        options.checks
      );
    }
  }
  /**
   * Execute tasks with controlled parallelism using a pool pattern
   */
  async executeWithLimitedParallelism(tasks, maxParallelism, failFast) {
    if (maxParallelism <= 0) {
      throw new Error("Max parallelism must be greater than 0");
    }
    if (tasks.length === 0) {
      return [];
    }
    const results = new Array(tasks.length);
    let currentIndex = 0;
    let shouldStop = false;
    const worker = async () => {
      while (currentIndex < tasks.length && !shouldStop) {
        const taskIndex = currentIndex++;
        if (taskIndex >= tasks.length) break;
        try {
          const result = await tasks[taskIndex]();
          results[taskIndex] = { status: "fulfilled", value: result };
          if (failFast && this.shouldFailFast(result)) {
            shouldStop = true;
            break;
          }
        } catch (error) {
          results[taskIndex] = { status: "rejected", reason: error };
          if (failFast) {
            shouldStop = true;
            break;
          }
        }
      }
    };
    const workers = [];
    const workerCount = Math.min(maxParallelism, tasks.length);
    for (let i = 0; i < workerCount; i++) {
      workers.push(worker());
    }
    await Promise.all(workers);
    return results;
  }
  /**
   * Execute review checks using parallel execution for multiple AI checks
   */
  async executeReviewChecks(prInfo, checks, timeout, config, outputFormat, debug, maxParallelism, failFast) {
    this.config = config;
    const logFn = (msg) => logger.debug(msg);
    if (debug) {
      logFn(`\u{1F527} Debug: executeReviewChecks called with checks: ${JSON.stringify(checks)}`);
      logFn(`\u{1F527} Debug: Config available: ${!!config}, Config has checks: ${!!config?.checks}`);
    }
    const filteredChecks = this.filterChecksByEvent(checks, config, prInfo, logFn, debug);
    if (filteredChecks.length !== checks.length && debug) {
      logFn(
        `\u{1F527} Debug: Event filtering reduced checks from ${checks.length} to ${filteredChecks.length}: ${JSON.stringify(filteredChecks)}`
      );
    }
    checks = filteredChecks;
    const allConfigured = config?.checks ? checks.every((name) => !!config.checks[name]) : false;
    if (allConfigured) {
      if (debug) {
        logFn(
          `\u{1F527} Debug: Using dependency-aware execution for ${checks.length} configured check(s)`
        );
      }
      return await this.executeDependencyAwareChecks(
        prInfo,
        checks,
        timeout,
        config,
        logFn,
        debug,
        maxParallelism,
        failFast
      );
    }
    if (checks.length === 1) {
      if (debug) {
        logFn(`\u{1F527} Debug: Using single check execution for: ${checks[0]}`);
      }
      if (config?.checks?.[checks[0]]) {
        return await this.executeSingleConfiguredCheck(prInfo, checks[0], timeout, config, logFn);
      }
      if (this.providerRegistry.hasProvider(checks[0])) {
        const provider = this.providerRegistry.getProviderOrThrow(checks[0]);
        this.setProviderWebhookContext(provider);
        const providerConfig = {
          type: checks[0],
          prompt: "all",
          eventContext: prInfo.eventContext,
          // Pass event context for templates
          ai: timeout ? { timeout } : void 0
        };
        const result = await provider.execute(prInfo, providerConfig);
        const prefixedIssues = (result.issues || []).map((issue) => ({
          ...issue,
          ruleId: `${checks[0]}/${issue.ruleId}`
        }));
        return {
          ...result,
          issues: prefixedIssues
        };
      }
    }
    if (this.providerRegistry.hasProvider("ai")) {
      if (debug) {
        logFn(`\u{1F527} Debug: Using AI provider with focus mapping`);
      }
      const provider = this.providerRegistry.getProviderOrThrow("ai");
      this.setProviderWebhookContext(provider);
      let focus2 = "all";
      let checkName = "all";
      if (checks.length === 1) {
        checkName = checks[0];
        if (checks[0] === "security" || checks[0] === "performance" || checks[0] === "style") {
          focus2 = checks[0];
        }
      } else {
        focus2 = "all";
      }
      const providerConfig = {
        type: "ai",
        prompt: focus2,
        focus: focus2,
        eventContext: prInfo.eventContext,
        // Pass event context for templates
        ai: timeout ? { timeout } : void 0,
        // Inherit global AI provider and model settings if config is available
        ai_provider: config?.ai_provider,
        ai_model: config?.ai_model
      };
      const result = await provider.execute(prInfo, providerConfig);
      const prefixedIssues = (result.issues || []).map((issue) => ({
        ...issue,
        ruleId: `${checkName}/${issue.ruleId}`
      }));
      return {
        ...result,
        issues: prefixedIssues
      };
    }
    if (debug) {
      logFn(`\u{1F527} Debug: Using legacy PRReviewer fallback`);
    }
    const focusMap = {
      security: "security",
      performance: "performance",
      style: "style",
      all: "all",
      architecture: "all"
    };
    let focus = "all";
    if (checks.length === 1 && focusMap[checks[0]]) {
      focus = focusMap[checks[0]];
    }
    return await this.reviewer.reviewPR("local", "repository", 0, prInfo, {
      focus,
      format: "table"
    });
  }
  /**
   * Execute review checks and return grouped results with statistics for new architecture
   */
  async executeGroupedChecks(prInfo, checks, timeout, config, outputFormat, debug, maxParallelism, failFast, tagFilter) {
    const logFn = outputFormat === "json" || outputFormat === "sarif" ? debug ? console.error : () => {
    } : console.log;
    if (debug) {
      logger.debug(`\u{1F527} Debug: executeGroupedChecks called with checks: ${JSON.stringify(checks)}`);
      logger.debug(
        `\u{1F527} Debug: Config available: ${!!config}, Config has checks: ${!!config?.checks}`
      );
    }
    const filteredChecks = this.filterChecksByEvent(checks, config, prInfo, logFn, debug);
    if (filteredChecks.length !== checks.length && debug) {
      logger.debug(
        `\u{1F527} Debug: Event filtering reduced checks from ${checks.length} to ${filteredChecks.length}: ${JSON.stringify(filteredChecks)}`
      );
    }
    const tagFilteredChecks = this.filterChecksByTags(
      filteredChecks,
      config,
      tagFilter || config?.tag_filter
    );
    if (tagFilteredChecks.length !== filteredChecks.length && debug) {
      logger.debug(
        `\u{1F527} Debug: Tag filtering reduced checks from ${filteredChecks.length} to ${tagFilteredChecks.length}: ${JSON.stringify(tagFilteredChecks)}`
      );
    }
    checks = tagFilteredChecks;
    try {
      const repoEnv = process.env.GITHUB_REPOSITORY || "";
      const [owner, repo] = repoEnv.split("/");
      const token = process.env["INPUT_GITHUB-TOKEN"] || process.env["GITHUB_TOKEN"];
      if (owner && repo) {
        this.actionContext = { owner, repo };
        if (token) {
          const { Octokit } = await import("@octokit/rest");
          this.actionContext.octokit = new Octokit({ auth: token });
        }
      }
    } catch {
    }
    if (checks.length === 0) {
      logger.warn("\u26A0\uFE0F No checks remain after tag filtering");
      return {
        results: {},
        statistics: this.buildExecutionStatistics()
      };
    }
    if (!config?.checks) {
      throw new Error("Config with check definitions required for grouped execution");
    }
    const hasDependencies = checks.some((checkName) => {
      const checkConfig = config.checks[checkName];
      return checkConfig?.depends_on && checkConfig.depends_on.length > 0;
    });
    if (checks.length > 1 || hasDependencies) {
      if (debug) {
        logger.debug(
          `\u{1F527} Debug: Using grouped dependency-aware execution for ${checks.length} checks (has dependencies: ${hasDependencies})`
        );
      }
      return await this.executeGroupedDependencyAwareChecks(
        prInfo,
        checks,
        timeout,
        config,
        logFn,
        debug,
        maxParallelism,
        failFast
      );
    }
    if (checks.length === 1) {
      if (debug) {
        logger.debug(`\u{1F527} Debug: Using grouped single check execution for: ${checks[0]}`);
      }
      const checkResult = await this.executeSingleGroupedCheck(
        prInfo,
        checks[0],
        timeout,
        config,
        logFn,
        debug
      );
      const groupedResults = {};
      groupedResults[checkResult.group] = [checkResult];
      return {
        results: groupedResults,
        statistics: this.buildExecutionStatistics()
      };
    }
    return {
      results: {},
      statistics: this.buildExecutionStatistics()
    };
  }
  /**
   * Execute single check and return grouped result
   */
  async executeSingleGroupedCheck(prInfo, checkName, timeout, config, logFn, debug) {
    if (!config?.checks?.[checkName]) {
      throw new Error(`No configuration found for check: ${checkName}`);
    }
    const checkConfig = config.checks[checkName];
    const providerType = checkConfig.type || "ai";
    const provider = this.providerRegistry.getProviderOrThrow(providerType);
    this.setProviderWebhookContext(provider);
    const providerConfig = {
      type: providerType,
      prompt: checkConfig.prompt,
      focus: checkConfig.focus || this.mapCheckNameToFocus(checkName),
      schema: checkConfig.schema,
      group: checkConfig.group,
      eventContext: prInfo.eventContext,
      // Pass event context for templates
      ai: {
        timeout: timeout || 6e5,
        debug,
        ...checkConfig.ai || {}
      },
      ai_provider: checkConfig.ai_provider || config.ai_provider,
      ai_model: checkConfig.ai_model || config.ai_model,
      // Pass claude_code config if present
      claude_code: checkConfig.claude_code,
      // Pass any provider-specific config
      ...checkConfig
    };
    providerConfig.forEach = checkConfig.forEach;
    const result = await provider.execute(prInfo, providerConfig);
    if (checkConfig.forEach && (!result.issues || result.issues.length === 0)) {
      const reviewSummaryWithOutput = result;
      const validation = this.validateAndNormalizeForEachOutput(
        checkName,
        reviewSummaryWithOutput.output,
        checkConfig.group
      );
      if (!validation.isValid) {
        return validation.error;
      }
    }
    if (config && (config.fail_if || checkConfig.fail_if)) {
      const failureResults = await this.evaluateFailureConditions(
        checkName,
        result,
        config,
        prInfo
      );
      if (failureResults.length > 0) {
        const failureIssues = failureResults.filter((f) => f.failed).map((f) => ({
          file: "system",
          line: 0,
          ruleId: f.conditionName,
          message: f.message || `Failure condition met: ${f.expression}`,
          severity: f.severity || "error",
          category: "logic"
        }));
        result.issues = [...result.issues || [], ...failureIssues];
      }
    }
    const content = await this.renderCheckContent(checkName, result, checkConfig, prInfo);
    return {
      checkName,
      content,
      group: checkConfig.group || "default",
      output: result.output,
      debug: result.debug,
      issues: result.issues
      // Include structured issues
    };
  }
  /**
   * Validate and normalize forEach output
   * Returns normalized array or throws validation error result
   */
  validateAndNormalizeForEachOutput(checkName, output, checkGroup) {
    if (output === void 0) {
      logger.error(`\u2717 forEach check "${checkName}" produced undefined output`);
      return {
        isValid: false,
        error: {
          checkName,
          content: "",
          group: checkGroup || "default",
          issues: [
            {
              file: "system",
              line: 0,
              ruleId: "forEach/undefined_output",
              message: `forEach check "${checkName}" produced undefined output. Verify your command outputs valid data and your transform_js returns a value.`,
              severity: "error",
              category: "logic"
            }
          ]
        }
      };
    }
    let normalizedOutput;
    if (Array.isArray(output)) {
      normalizedOutput = output;
    } else if (output && typeof output === "object" && Array.isArray(output.items)) {
      normalizedOutput = output.items;
    } else if (typeof output === "string") {
      try {
        const parsed = JSON.parse(output);
        normalizedOutput = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        normalizedOutput = [output];
      }
    } else if (output === null) {
      normalizedOutput = [];
    } else {
      normalizedOutput = [output];
    }
    logger.info(`  Found ${normalizedOutput.length} items for forEach iteration`);
    return {
      isValid: true,
      normalizedOutput
    };
  }
  /**
   * Execute multiple checks with dependency awareness - return grouped results with statistics
   */
  async executeGroupedDependencyAwareChecks(prInfo, checks, timeout, config, logFn, debug, maxParallelism, failFast) {
    const reviewSummary = await this.executeDependencyAwareChecks(
      prInfo,
      checks,
      timeout,
      config,
      logFn,
      debug,
      maxParallelism,
      failFast
    );
    const executionStatistics = this.buildExecutionStatistics();
    const groupedResults = await this.convertReviewSummaryToGroupedResults(
      reviewSummary,
      checks,
      config,
      prInfo
    );
    return {
      results: groupedResults,
      statistics: executionStatistics
    };
  }
  /**
   * Convert ReviewSummary to GroupedCheckResults
   */
  async convertReviewSummaryToGroupedResults(reviewSummary, checks, config, prInfo) {
    const groupedResults = {};
    const agg = reviewSummary;
    const contentMap = agg.__contents;
    const outputMap = agg.__outputs;
    for (const checkName of checks) {
      const checkConfig = config?.checks?.[checkName];
      if (!checkConfig) continue;
      const checkIssues = (reviewSummary.issues || []).filter(
        (issue) => issue.checkName === checkName
      );
      const checkSummary = {
        issues: checkIssues,
        debug: reviewSummary.debug
      };
      if (contentMap?.[checkName]) {
        checkSummary.content = contentMap[checkName];
      }
      if (outputMap && Object.prototype.hasOwnProperty.call(outputMap, checkName)) {
        checkSummary.output = outputMap[checkName];
      }
      let content = "";
      let issuesForCheck = [...checkIssues];
      try {
        content = await this.renderCheckContent(checkName, checkSummary, checkConfig, prInfo);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error(`\u274C Failed to render content for check '${checkName}': ${msg}`);
        issuesForCheck = [
          ...issuesForCheck,
          {
            file: "system",
            line: 0,
            ruleId: `${checkName}/render-error`,
            message: `Template rendering failed: ${msg}`,
            severity: "error",
            category: "logic"
          }
        ];
      }
      const checkResult = {
        checkName,
        content,
        group: checkConfig.group || "default",
        output: checkSummary.output,
        debug: reviewSummary.debug,
        issues: issuesForCheck
        // Include structured issues + rendering error if any
      };
      const group = checkResult.group;
      if (!groupedResults[group]) {
        groupedResults[group] = [];
      }
      groupedResults[group].push(checkResult);
    }
    return groupedResults;
  }
  /**
   * Validates that a file path is safe and within the project directory
   * Prevents path traversal attacks by:
   * - Blocking absolute paths
   * - Blocking paths with ".." segments
   * - Ensuring resolved path is within project directory
   * - Blocking special characters and null bytes
   * - Enforcing .liquid file extension
   */
  async validateTemplatePath(templatePath) {
    const path5 = await import("path");
    if (!templatePath || typeof templatePath !== "string" || templatePath.trim() === "") {
      throw new Error("Template path must be a non-empty string");
    }
    if (templatePath.includes("\0") || templatePath.includes("\0")) {
      throw new Error("Template path contains invalid characters");
    }
    if (!templatePath.endsWith(".liquid")) {
      throw new Error("Template file must have .liquid extension");
    }
    if (path5.isAbsolute(templatePath)) {
      throw new Error("Template path must be relative to project directory");
    }
    if (templatePath.includes("..")) {
      throw new Error('Template path cannot contain ".." segments');
    }
    if (templatePath.startsWith("~")) {
      throw new Error("Template path cannot reference home directory");
    }
    const repositoryInfo = await this.gitAnalyzer.analyzeRepository();
    const projectRoot = repositoryInfo.workingDirectory;
    if (!projectRoot || typeof projectRoot !== "string") {
      throw new Error("Unable to determine project root directory");
    }
    const resolvedPath = path5.resolve(projectRoot, templatePath);
    const resolvedProjectRoot = path5.resolve(projectRoot);
    if (!resolvedPath || !resolvedProjectRoot || resolvedPath === "" || resolvedProjectRoot === "") {
      throw new Error(
        `Unable to resolve template path: projectRoot="${projectRoot}", templatePath="${templatePath}", resolvedPath="${resolvedPath}", resolvedProjectRoot="${resolvedProjectRoot}"`
      );
    }
    if (!resolvedPath.startsWith(resolvedProjectRoot + path5.sep) && resolvedPath !== resolvedProjectRoot) {
      throw new Error("Template path escapes project directory");
    }
    return resolvedPath;
  }
  /**
   * Evaluate `if` condition for a check
   * @param checkName Name of the check
   * @param condition The condition string to evaluate
   * @param prInfo PR information
   * @param results Current check results
   * @param debug Whether debug mode is enabled
   * @returns true if the check should run, false if it should be skipped
   */
  async evaluateCheckCondition(checkName, condition, prInfo, results, debug) {
    const override = this.routingEventOverride;
    const eventName = override ? override.startsWith("pr_") ? "pull_request" : override === "issue_comment" ? "issue_comment" : override.startsWith("issue_") ? "issues" : "manual" : "issue_comment";
    const commenterAssoc = prInfo?.eventContext?.comment?.author_association || prInfo?.eventContext?.comment?.authorAssociation || prInfo.authorAssociation;
    const shouldRun = await this.failureEvaluator.evaluateIfCondition(checkName, condition, {
      branch: prInfo.head,
      baseBranch: prInfo.base,
      filesChanged: prInfo.files.map((f) => f.filename),
      event: eventName,
      environment: getSafeEnvironmentVariables(),
      previousResults: results,
      authorAssociation: commenterAssoc
    });
    if (!shouldRun && debug) {
      logger.debug(`\u{1F527} Debug: Skipping check '${checkName}' - if condition evaluated to false`);
    }
    return shouldRun;
  }
  /**
   * Render check content using the appropriate template
   */
  async renderCheckContent(checkName, reviewSummary, checkConfig, _prInfo) {
    const directContent = reviewSummary.content;
    if (typeof directContent === "string" && directContent.trim()) {
      return directContent.trim();
    }
    const { createExtendedLiquid: createExtendedLiquid2 } = await import("./liquid-extensions-5FTQ76KX.mjs");
    const fs5 = await import("fs/promises");
    const path5 = await import("path");
    const liquid = createExtendedLiquid2({
      trimTagLeft: false,
      trimTagRight: false,
      trimOutputLeft: false,
      trimOutputRight: false,
      greedy: false
    });
    let schemaName;
    if (typeof checkConfig.schema === "object") {
      schemaName = "plain";
    } else if (typeof checkConfig.schema === "string" && checkConfig.schema.includes("/") && checkConfig.schema.endsWith(".json") && !checkConfig.schema.includes("..")) {
      schemaName = "plain";
    } else {
      schemaName = checkConfig.schema || "plain";
    }
    let templateContent;
    if (checkConfig.template) {
      if (checkConfig.template.content) {
        templateContent = checkConfig.template.content;
      } else if (checkConfig.template.file) {
        const validatedPath = await this.validateTemplatePath(checkConfig.template.file);
        templateContent = await fs5.readFile(validatedPath, "utf-8");
      } else {
        throw new Error('Custom template must specify either "file" or "content"');
      }
    } else if (schemaName === "plain") {
      return reviewSummary.issues?.[0]?.message || "";
    } else {
      const sanitizedSchema = schemaName.replace(/[^a-zA-Z0-9-]/g, "");
      if (!sanitizedSchema) {
        throw new Error("Invalid schema name");
      }
      const templatePath = path5.join(__dirname, `../output/${sanitizedSchema}/template.liquid`);
      templateContent = await fs5.readFile(templatePath, "utf-8");
    }
    const filteredIssues = (reviewSummary.issues || []).filter(
      (issue) => !(issue.file === "system" && issue.line === 0)
    );
    const templateData = {
      issues: filteredIssues,
      checkName,
      // Expose structured output for custom schemas/templates (e.g., overview)
      // This allows templates to render fields like output.text or output.tags
      output: reviewSummary.output
    };
    const rendered = await liquid.parseAndRender(templateContent, templateData);
    return rendered.trim();
  }
  /**
   * Attempt to elevate an issue/issue_comment context to full PR context when routing via goto_event.
   * Returns a new PRInfo with files/diff when possible; otherwise returns null.
   */
  async elevateContextToPullRequest(prInfo, targetEvent, log2, debug) {
    try {
      if (targetEvent !== "pr_opened" && targetEvent !== "pr_updated") return null;
      const isIssueContext = prInfo.isIssue === true;
      const ctx = prInfo.eventContext || {};
      const isPRThread = Boolean(ctx?.issue?.pull_request);
      if (!isIssueContext || !isPRThread) return null;
      let owner = this.actionContext?.owner;
      let repo = this.actionContext?.repo;
      if (!owner || !repo) {
        const repoEnv = process.env.GITHUB_REPOSITORY || "";
        [owner, repo] = repoEnv.split("/");
      }
      if (!owner || !repo) return null;
      const prNumber = ctx?.issue?.number || prInfo.number;
      if (!prNumber) return null;
      let octokit = this.actionContext?.octokit;
      if (!octokit) {
        const token = process.env["INPUT_GITHUB-TOKEN"] || process.env["GITHUB_TOKEN"];
        if (!token) return null;
        const { Octokit } = await import("@octokit/rest");
        octokit = new Octokit({ auth: token });
      }
      const analyzer = new PRAnalyzer(octokit);
      const elevated = await analyzer.fetchPRDiff(owner, repo, prNumber, void 0, targetEvent);
      elevated.eventContext = prInfo.eventContext || ctx;
      elevated.isPRContext = true;
      elevated.includeCodeContext = true;
      if (debug)
        log2?.(`\u{1F527} Debug: Elevated context to PR #${prNumber} for goto_event=${targetEvent}`);
      return elevated;
    } catch (e) {
      if (debug) {
        const msg = e instanceof Error ? e.message : String(e);
        log2?.(`\u26A0\uFE0F Debug: Context elevation to PR failed: ${msg}`);
      }
      return null;
    }
  }
  /**
   * Execute multiple checks with dependency awareness - intelligently parallel and sequential
   */
  async executeDependencyAwareChecks(prInfo, checks, timeout, config, logFn, debug, maxParallelism, failFast) {
    const log2 = logFn || console.error;
    if (debug) {
      log2(`\u{1F527} Debug: Starting dependency-aware execution of ${checks.length} checks`);
    }
    if (!config?.checks) {
      throw new Error("Config with check definitions required for dependency-aware execution");
    }
    const effectiveMaxParallelism = maxParallelism ?? config.max_parallelism ?? 3;
    const effectiveFailFast = failFast ?? config.fail_fast ?? false;
    if (debug) {
      log2(`\u{1F527} Debug: Using max parallelism: ${effectiveMaxParallelism}`);
      log2(`\u{1F527} Debug: Using fail-fast: ${effectiveFailFast}`);
    }
    const dependencies = {};
    const sessionReuseChecks = /* @__PURE__ */ new Set();
    const sessionProviders = /* @__PURE__ */ new Map();
    for (const checkName of checks) {
      const checkConfig = config.checks[checkName];
      if (checkConfig) {
        dependencies[checkName] = checkConfig.depends_on || [];
        if (checkConfig.reuse_ai_session) {
          sessionReuseChecks.add(checkName);
          if (typeof checkConfig.reuse_ai_session === "string") {
            sessionProviders.set(checkName, checkConfig.reuse_ai_session);
          } else if (checkConfig.reuse_ai_session === true) {
            if (checkConfig.depends_on && checkConfig.depends_on.length > 0) {
              sessionProviders.set(checkName, checkConfig.depends_on[0]);
            }
          }
        }
      } else {
        dependencies[checkName] = [];
      }
    }
    if (sessionReuseChecks.size > 0 && debug) {
      log2(
        `\u{1F504} Debug: Found ${sessionReuseChecks.size} checks requiring session reuse: ${Array.from(sessionReuseChecks).join(", ")}`
      );
    }
    const validation = DependencyResolver.validateDependencies(checks, dependencies);
    if (!validation.valid) {
      return {
        issues: [
          {
            severity: "error",
            message: `Dependency validation failed: ${validation.errors.join(", ")}`,
            file: "",
            line: 0,
            ruleId: "dependency-validation-error",
            category: "logic"
          }
        ]
      };
    }
    const expandWithTransitives = (rootChecks) => {
      if (!config?.checks) return rootChecks;
      const set = new Set(rootChecks);
      const visit = (name) => {
        const cfg = config.checks[name];
        if (!cfg || !cfg.depends_on) return;
        for (const dep of cfg.depends_on) {
          if (!set.has(dep)) {
            set.add(dep);
            visit(dep);
          }
        }
      };
      for (const c of rootChecks) visit(c);
      return Array.from(set);
    };
    checks = expandWithTransitives(checks);
    for (const checkName of checks) {
      const checkConfig = config.checks[checkName];
      dependencies[checkName] = checkConfig?.depends_on || [];
    }
    const dependencyGraph = DependencyResolver.buildDependencyGraph(dependencies);
    if (dependencyGraph.hasCycles) {
      return {
        issues: [
          {
            severity: "error",
            message: `Circular dependencies detected: ${dependencyGraph.cycleNodes?.join(" -> ")}`,
            file: "",
            line: 0,
            ruleId: "circular-dependency-error",
            category: "logic"
          }
        ]
      };
    }
    const childrenByParent = /* @__PURE__ */ new Map();
    for (const [child, depsArr] of Object.entries(dependencies)) {
      for (const p of depsArr || []) {
        if (!childrenByParent.has(p)) childrenByParent.set(p, []);
        childrenByParent.get(p).push(child);
      }
    }
    const stats = DependencyResolver.getExecutionStats(dependencyGraph);
    if (debug) {
      log2(
        `\u{1F527} Debug: Execution plan - ${stats.totalChecks} checks in ${stats.parallelLevels} levels, max parallelism: ${stats.maxParallelism}`
      );
    }
    const results = /* @__PURE__ */ new Map();
    const sessionRegistry = (init_session_registry(), __toCommonJS(session_registry_exports)).SessionRegistry.getInstance();
    const sessionIds = /* @__PURE__ */ new Map();
    let shouldStopExecution = false;
    let completedChecksCount = 0;
    const totalChecksCount = stats.totalChecks;
    for (const checkName of checks) {
      this.initializeCheckStats(checkName);
    }
    for (let levelIndex = 0; levelIndex < dependencyGraph.executionOrder.length && !shouldStopExecution; levelIndex++) {
      const executionGroup = dependencyGraph.executionOrder[levelIndex];
      const checksInLevel = executionGroup.parallel;
      const hasSessionReuseInLevel = checksInLevel.some(
        (checkName) => sessionReuseChecks.has(checkName)
      );
      let actualParallelism = Math.min(effectiveMaxParallelism, executionGroup.parallel.length);
      if (hasSessionReuseInLevel) {
        actualParallelism = 1;
        if (debug) {
          log2(
            `\u{1F504} Debug: Level ${executionGroup.level} contains session reuse checks - forcing sequential execution (parallelism: 1)`
          );
        }
      }
      if (debug) {
        log2(
          `\u{1F527} Debug: Executing level ${executionGroup.level} with ${executionGroup.parallel.length} checks (parallelism: ${actualParallelism})`
        );
      }
      const levelChecks = executionGroup.parallel.filter((name) => !results.has(name));
      const levelTaskFunctions = levelChecks.map((checkName) => async () => {
        if (results.has(checkName)) {
          if (debug) log2(`\u{1F527} Debug: Skipping ${checkName} (already satisfied earlier)`);
          return { checkName, error: null, result: results.get(checkName) };
        }
        const checkConfig = config.checks[checkName];
        if (!checkConfig) {
          return {
            checkName,
            error: `No configuration found for check: ${checkName}`,
            result: null
          };
        }
        const checkStartTime = Date.now();
        completedChecksCount++;
        logger.step(`Running check: ${checkName} [${completedChecksCount}/${totalChecksCount}]`);
        try {
          if (debug) {
            log2(`\u{1F527} Debug: Starting check: ${checkName} at level ${executionGroup.level}`);
          }
          const providerType = checkConfig.type || "ai";
          const provider = this.providerRegistry.getProviderOrThrow(providerType);
          if (debug) {
            log2(`\u{1F527} Debug: Provider for '${checkName}' is '${providerType}'`);
          }
          this.setProviderWebhookContext(provider);
          const extendedCheckConfig = checkConfig;
          const providerConfig = {
            type: providerType,
            prompt: checkConfig.prompt,
            exec: checkConfig.exec,
            focus: checkConfig.focus || this.mapCheckNameToFocus(checkName),
            schema: checkConfig.schema,
            group: checkConfig.group,
            checkName,
            // Add checkName for sessionID
            eventContext: prInfo.eventContext,
            // Pass event context for templates
            transform: checkConfig.transform,
            transform_js: checkConfig.transform_js,
            // Important: pass through provider-level timeout from check config
            // (e.g., command/http_client providers expect seconds/ms here)
            timeout: checkConfig.timeout,
            level: extendedCheckConfig.level,
            message: extendedCheckConfig.message,
            env: checkConfig.env,
            forEach: checkConfig.forEach,
            ai: {
              timeout: timeout || 6e5,
              debug,
              ...checkConfig.ai || {}
            }
          };
          const dependencyResults = /* @__PURE__ */ new Map();
          let isForEachDependent = false;
          let forEachItems = [];
          let forEachParentName;
          const forEachParents = [];
          const allDependencies = DependencyResolver.getAllDependencies(
            checkName,
            dependencyGraph.nodes
          );
          for (const depId of allDependencies) {
            if (results.has(depId)) {
              const depResult = results.get(depId);
              dependencyResults.set(depId, depResult);
            }
          }
          const directDeps = checkConfig.depends_on || [];
          const failedDeps = [];
          for (const depId of directDeps) {
            const depRes = results.get(depId);
            if (!depRes) continue;
            const wasSkipped = (depRes.issues || []).some((issue) => {
              const id = issue.ruleId || "";
              return id.endsWith("/__skipped");
            });
            const depExtended = depRes;
            const isDepForEachParent = !!depExtended.isForEach;
            let hasFatalFailure = false;
            if (!isDepForEachParent) {
              const issues = depRes.issues || [];
              hasFatalFailure = issues.some((issue) => {
                const id = issue.ruleId || "";
                return id === "command/execution_error" || id.endsWith("/command/execution_error") || id === "command/timeout" || id.endsWith("/command/timeout") || id === "command/transform_js_error" || id.endsWith("/command/transform_js_error") || id === "command/transform_error" || id.endsWith("/command/transform_error") || id === "forEach/undefined_output" || id.endsWith("/forEach/undefined_output") || id.endsWith("/forEach/iteration_error") || id.endsWith("_fail_if") || id.endsWith("/global_fail_if");
              });
              if (!hasFatalFailure && config && (config.fail_if || config.checks[depId]?.fail_if)) {
                try {
                  hasFatalFailure = await this.failIfTriggered(depId, depRes, config);
                } catch {
                }
              }
            }
            if (debug) {
              log2(
                `\u{1F527} Debug: gating check '${checkName}' against dep '${depId}': wasSkipped=${wasSkipped} hasFatalFailure=${hasFatalFailure}`
              );
            }
            if (wasSkipped || hasFatalFailure) failedDeps.push(depId);
          }
          if (failedDeps.length > 0) {
            this.recordSkip(checkName, "dependency_failed");
            logger.info(`\u23ED  Skipped (dependency failed: ${failedDeps.join(", ")})`);
            return {
              checkName,
              error: null,
              result: { issues: [] },
              skipped: true
            };
          }
          for (const depId of checkConfig.depends_on || []) {
            if (results.has(depId)) {
              const depResult = results.get(depId);
              const depForEachResult = depResult;
              if (depForEachResult.isForEach || Array.isArray(depForEachResult.forEachItemResults) || Array.isArray(depForEachResult.forEachItems)) {
                if (!isForEachDependent) {
                  isForEachDependent = true;
                  forEachItems = Array.isArray(depForEachResult.forEachItems) ? depForEachResult.forEachItems : new Array(
                    Array.isArray(depForEachResult.forEachItemResults) ? depForEachResult.forEachItemResults.length : 0
                  ).fill(void 0);
                  forEachParentName = depId;
                }
                forEachParents.push(depId);
              }
            }
          }
          let sessionInfo = void 0;
          if (sessionReuseChecks.has(checkName)) {
            const parentCheckName = sessionProviders.get(checkName);
            if (parentCheckName && sessionIds.has(parentCheckName)) {
              const parentSessionId = sessionIds.get(parentCheckName);
              sessionInfo = {
                parentSessionId,
                reuseSession: true
              };
              if (debug) {
                log2(
                  `\u{1F504} Debug: Check ${checkName} will reuse session from parent ${parentCheckName}: ${parentSessionId}`
                );
              }
            } else {
              if (debug) {
                log2(
                  `\u26A0\uFE0F Warning: Check ${checkName} requires session reuse but parent ${parentCheckName} session not found`
                );
              }
            }
          }
          let currentSessionId = void 0;
          if (!sessionInfo?.reuseSession) {
            const timestamp = (/* @__PURE__ */ new Date()).toISOString();
            currentSessionId = `visor-${timestamp.replace(/[:.]/g, "-")}-${checkName}`;
            sessionIds.set(checkName, currentSessionId);
            if (debug) {
              log2(`\u{1F195} Debug: Check ${checkName} will create new session: ${currentSessionId}`);
            }
            providerConfig.sessionId = currentSessionId;
          }
          let finalResult;
          if (isForEachDependent && forEachParentName) {
            if (!Array.isArray(forEachItems)) {
              forEachItems = [];
            }
            if (!Array.isArray(forEachItems)) {
              this.recordSkip(checkName, "dependency_failed");
              return {
                checkName,
                error: null,
                result: { issues: [] },
                skipped: true
              };
            }
            this.recordForEachPreview(checkName, forEachItems);
            if (forEachItems.length === 0) {
              if (debug) {
                log2(
                  `\u{1F504} Debug: Skipping check "${checkName}" - forEach check "${forEachParentName}" returned 0 items`
                );
              }
              logger.info(`  forEach: no items from "${forEachParentName}", skipping check...`);
              this.recordSkip(checkName, "dependency_failed");
              finalResult = {
                issues: [],
                output: []
              };
              finalResult.isForEach = true;
              finalResult.forEachItems = [];
            } else {
              if (debug) {
                console.log(
                  `\u{1F504} Debug: Check "${checkName}" depends on forEach check "${forEachParentName}", executing ${forEachItems.length} times`
                );
              }
              const __itemCount = Array.isArray(forEachItems) ? forEachItems.length : 0;
              logger.info(
                `  forEach: processing ${__itemCount} items from "${forEachParentName}"...`
              );
              const allIssues = [];
              const allOutputs = new Array(forEachItems.length);
              const aggregatedContents = [];
              const perItemResults = new Array(
                forEachItems.length
              );
              const inlineAgg = /* @__PURE__ */ new Map();
              const execInlineDescendants = async (parentName, itemIndex, baseDeps) => {
                const children = (childrenByParent.get(parentName) || []).filter((child) => {
                  const deps = dependencies[child] || [];
                  return deps.length === 1 && deps[0] === parentName;
                });
                for (const childName of children) {
                  const childCfg = config.checks[childName];
                  const childProviderType = childCfg.type || "ai";
                  const childProv = this.providerRegistry.getProviderOrThrow(childProviderType);
                  this.setProviderWebhookContext(childProv);
                  const childProviderConfig = {
                    type: childProviderType,
                    prompt: childCfg.prompt,
                    exec: childCfg.exec,
                    focus: childCfg.focus || this.mapCheckNameToFocus(childName),
                    schema: childCfg.schema,
                    group: childCfg.group,
                    checkName: childName,
                    eventContext: prInfo.eventContext,
                    transform: childCfg.transform,
                    transform_js: childCfg.transform_js,
                    env: childCfg.env,
                    forEach: childCfg.forEach,
                    ai: {
                      timeout: timeout || 6e5,
                      debug,
                      ...childCfg.ai || {}
                    }
                  };
                  const childDepResults = /* @__PURE__ */ new Map();
                  const childAllDeps = DependencyResolver.getAllDependencies(
                    childName,
                    dependencyGraph.nodes
                  );
                  for (const dep of childAllDeps) {
                    const baseRes = baseDeps.get(dep);
                    if (baseRes) {
                      childDepResults.set(dep, baseRes);
                      continue;
                    }
                    const globalRes = results.get(dep);
                    if (!globalRes) continue;
                    if (globalRes && (globalRes.isForEach || Array.isArray(globalRes.forEachItemResults) || Array.isArray(globalRes.output))) {
                      if (Array.isArray(globalRes.forEachItemResults) && globalRes.forEachItemResults[itemIndex]) {
                        childDepResults.set(dep, globalRes.forEachItemResults[itemIndex]);
                      } else if (Array.isArray(globalRes.output) && globalRes.output[itemIndex] !== void 0) {
                        childDepResults.set(dep, {
                          issues: [],
                          output: globalRes.output[itemIndex]
                        });
                      } else {
                        childDepResults.set(dep, globalRes);
                      }
                    } else {
                      childDepResults.set(dep, globalRes);
                    }
                  }
                  const parentItemRes = childDepResults.get(parentName);
                  if (parentItemRes) {
                    try {
                      const pout = parentItemRes.output;
                      if (pout && typeof pout === "object" && pout.error === true) {
                        continue;
                      }
                    } catch {
                    }
                    const fatal = (parentItemRes.issues || []).some((issue) => {
                      const id = issue.ruleId || "";
                      const sev = issue.severity || "error";
                      return sev === "error" || sev === "critical" || id === "command/execution_error" || id.endsWith("/command/execution_error") || id === "command/timeout" || id.endsWith("/command/timeout") || id === "command/transform_js_error" || id.endsWith("/command/transform_js_error") || id === "command/transform_error" || id.endsWith("/command/transform_error") || id.endsWith("/forEach/iteration_error") || id === "forEach/undefined_output" || id.endsWith("/forEach/undefined_output") || id.endsWith("_fail_if") || id.endsWith("/global_fail_if");
                    });
                    if (fatal) {
                      continue;
                    }
                  }
                  if (childCfg.if) {
                    const condResults = new Map(results);
                    for (const [k, v] of childDepResults) condResults.set(k, v);
                    const shouldRunChild = await this.evaluateCheckCondition(
                      childName,
                      childCfg.if,
                      prInfo,
                      condResults,
                      debug
                    );
                    if (!shouldRunChild) {
                      continue;
                    }
                  }
                  const childIterStart = this.recordIterationStart(childName);
                  const childItemRes = await this.executeWithRouting(
                    childName,
                    childCfg,
                    childProv,
                    childProviderConfig,
                    prInfo,
                    childDepResults,
                    sessionInfo,
                    config,
                    dependencyGraph,
                    debug,
                    results,
                    { index: itemIndex, total: forEachItems.length, parent: parentName }
                  );
                  if (config && (config.fail_if || childCfg.fail_if)) {
                    const fRes = await this.evaluateFailureConditions(
                      childName,
                      childItemRes,
                      config
                    );
                    if (fRes.length > 0) {
                      const fIssues = fRes.filter((f) => f.failed).map((f) => ({
                        file: "system",
                        line: 0,
                        ruleId: f.conditionName,
                        message: f.message || `Failure condition met: ${f.expression}`,
                        severity: f.severity || "error",
                        category: "logic"
                      }));
                      childItemRes.issues = [...childItemRes.issues || [], ...fIssues];
                    }
                  }
                  if (!inlineAgg.has(childName)) {
                    inlineAgg.set(childName, {
                      issues: [],
                      outputs: new Array(forEachItems.length),
                      contents: [],
                      perItemResults: new Array(forEachItems.length)
                    });
                  }
                  const agg = inlineAgg.get(childName);
                  if (childItemRes.issues) agg.issues.push(...childItemRes.issues);
                  const out = childItemRes.output;
                  agg.outputs[itemIndex] = out;
                  agg.perItemResults[itemIndex] = childItemRes;
                  const c = childItemRes.content;
                  if (typeof c === "string" && c.trim()) agg.contents.push(c.trim());
                  const childHadFatal = this.hasFatal(childItemRes.issues || []);
                  this.recordIterationComplete(
                    childName,
                    childIterStart,
                    !childHadFatal,
                    childItemRes.issues || [],
                    childItemRes.output
                  );
                  const nextBase = new Map(baseDeps);
                  nextBase.set(childName, childItemRes);
                  await execInlineDescendants(childName, itemIndex, nextBase);
                }
              };
              const itemTasks = forEachItems.map((item, itemIndex) => async () => {
                const forEachDependencyResults = /* @__PURE__ */ new Map();
                for (const [depName, depResult] of dependencyResults) {
                  if (forEachParents.includes(depName)) {
                    const depForEachResult = depResult;
                    if (Array.isArray(depForEachResult.forEachItemResults) && depForEachResult.forEachItemResults[itemIndex]) {
                      forEachDependencyResults.set(
                        depName,
                        depForEachResult.forEachItemResults[itemIndex]
                      );
                      const rawResult = {
                        issues: [],
                        output: depForEachResult.output
                      };
                      forEachDependencyResults.set(`${depName}-raw`, rawResult);
                    } else if (Array.isArray(depForEachResult.output) && depForEachResult.output[itemIndex] !== void 0) {
                      const modifiedResult = {
                        issues: [],
                        output: depForEachResult.output[itemIndex]
                      };
                      forEachDependencyResults.set(depName, modifiedResult);
                      const rawResult = {
                        issues: [],
                        output: depForEachResult.output
                      };
                      forEachDependencyResults.set(`${depName}-raw`, rawResult);
                    } else {
                      forEachDependencyResults.set(depName, depResult);
                    }
                  } else {
                    forEachDependencyResults.set(depName, depResult);
                  }
                }
                if ((checkConfig.depends_on || []).length > 0) {
                  const directDeps2 = checkConfig.depends_on || [];
                  for (const depId of directDeps2) {
                    if (!forEachParents.includes(depId)) continue;
                    const depItemRes = forEachDependencyResults.get(depId);
                    if (!depItemRes) continue;
                    const wasSkippedDep = (depItemRes.issues || []).some(
                      (i) => (i.ruleId || "").endsWith("/__skipped")
                    );
                    let hasFatalDepFailure = (depItemRes.issues || []).some((issue) => {
                      const id = issue.ruleId || "";
                      return id === "command/execution_error" || id.endsWith("/command/execution_error") || id === "command/timeout" || id.endsWith("/command/timeout") || id === "command/transform_js_error" || id.endsWith("/command/transform_js_error") || id === "command/transform_error" || id.endsWith("/command/transform_error") || id.endsWith("/forEach/iteration_error") || id === "forEach/undefined_output" || id.endsWith("/forEach/undefined_output") || id.endsWith("_fail_if") || id.endsWith("/global_fail_if");
                    });
                    if (!hasFatalDepFailure && config && (config.fail_if || config.checks[depId]?.fail_if)) {
                      try {
                        const depFailures = await this.evaluateFailureConditions(
                          depId,
                          depItemRes,
                          config
                        );
                        hasFatalDepFailure = depFailures.some((f) => f.failed);
                      } catch {
                      }
                    }
                    const depAgg = dependencyResults.get(depId);
                    const maskFatal = !!depAgg?.forEachFatalMask && depAgg.forEachFatalMask[itemIndex] === true;
                    if (wasSkippedDep || hasFatalDepFailure || maskFatal) {
                      if (debug) {
                        log2(
                          `\u{1F504} Debug: Skipping item ${itemIndex + 1}/${forEachItems.length} for check "${checkName}" due to failed dependency '${depId}'`
                        );
                      }
                      return {
                        index: itemIndex,
                        itemResult: { issues: [] },
                        skipped: true
                      };
                    }
                  }
                }
                if (checkConfig.if) {
                  const conditionResults = new Map(results);
                  for (const [depName, depResult] of forEachDependencyResults) {
                    conditionResults.set(depName, depResult);
                  }
                  const shouldRun = await this.evaluateCheckCondition(
                    checkName,
                    checkConfig.if,
                    prInfo,
                    conditionResults,
                    debug
                  );
                  if (!shouldRun) {
                    if (debug) {
                      log2(
                        `\u{1F504} Debug: Skipping forEach item ${itemIndex + 1} for check "${checkName}" (if condition evaluated to false)`
                      );
                    }
                    return {
                      index: itemIndex,
                      itemResult: { issues: [] },
                      skipped: true
                    };
                  }
                }
                if (debug) {
                  log2(
                    `\u{1F504} Debug: Executing check "${checkName}" for item ${itemIndex + 1}/${forEachItems.length}`
                  );
                }
                const iterationStart = this.recordIterationStart(checkName);
                const itemResult = await this.executeWithRouting(
                  checkName,
                  checkConfig,
                  provider,
                  providerConfig,
                  prInfo,
                  forEachDependencyResults,
                  sessionInfo,
                  config,
                  dependencyGraph,
                  debug,
                  results,
                  /*foreachContext*/
                  {
                    index: itemIndex,
                    total: forEachItems.length,
                    parent: forEachParentName
                  }
                );
                if (config && (config.fail_if || checkConfig.fail_if)) {
                  const itemFailures = await this.evaluateFailureConditions(
                    checkName,
                    itemResult,
                    config
                  );
                  if (itemFailures.length > 0) {
                    const failureIssues = itemFailures.filter((f) => f.failed).map((f) => ({
                      file: "system",
                      line: 0,
                      ruleId: f.conditionName,
                      message: f.message || `Failure condition met: ${f.expression}`,
                      severity: f.severity || "error",
                      category: "logic"
                    }));
                    itemResult.issues = [...itemResult.issues || [], ...failureIssues];
                  }
                }
                const hadFatalError = (itemResult.issues || []).some((issue) => {
                  const id = issue.ruleId || "";
                  return id === "command/execution_error" || id.endsWith("/command/execution_error") || id === "command/transform_js_error" || id.endsWith("/command/transform_js_error") || id === "command/transform_error" || id.endsWith("/command/transform_error") || id === "forEach/undefined_output" || id.endsWith("/forEach/undefined_output");
                });
                const iterationDuration = (Date.now() - iterationStart) / 1e3;
                this.recordIterationComplete(
                  checkName,
                  iterationStart,
                  !hadFatalError,
                  // Success if no fatal errors
                  itemResult.issues || [],
                  itemResult.output
                );
                const descendantSet = (() => {
                  const visited = /* @__PURE__ */ new Set();
                  const stack = [checkName];
                  while (stack.length) {
                    const p = stack.pop();
                    const kids = childrenByParent.get(p) || [];
                    for (const k of kids) {
                      if (!visited.has(k)) {
                        visited.add(k);
                        stack.push(k);
                      }
                    }
                  }
                  return visited;
                })();
                const perItemDone = /* @__PURE__ */ new Set([...forEachParents, checkName]);
                const perItemDepMap = /* @__PURE__ */ new Map();
                for (const [k, v] of forEachDependencyResults) perItemDepMap.set(k, v);
                perItemDepMap.set(checkName, itemResult);
                const isFatal = (r) => {
                  if (!r) return true;
                  return this.hasFatal(r.issues || []);
                };
                while (true) {
                  let progressed = false;
                  for (const node of descendantSet) {
                    if (perItemDone.has(node)) continue;
                    const nodeCfg = config.checks[node];
                    if (!nodeCfg) continue;
                    const deps = dependencies[node] || [];
                    let ready = true;
                    const childDepsMap = /* @__PURE__ */ new Map();
                    for (const d of deps) {
                      const perItemRes = perItemDepMap.get(d);
                      if (perItemRes) {
                        if (isFatal(perItemRes)) {
                          ready = false;
                          break;
                        }
                        childDepsMap.set(d, perItemRes);
                        continue;
                      }
                      const agg2 = results.get(d);
                      if (agg2 && (agg2.isForEach || Array.isArray(agg2.forEachItemResults))) {
                        const r = agg2.forEachItemResults && agg2.forEachItemResults[itemIndex] || void 0;
                        const maskFatal = !!agg2.forEachFatalMask && agg2.forEachFatalMask[itemIndex] === true;
                        if (!r || maskFatal || isFatal(r)) {
                          ready = false;
                          break;
                        }
                        childDepsMap.set(d, r);
                        continue;
                      }
                      if (!agg2 || isFatal(agg2)) {
                        ready = false;
                        break;
                      }
                      childDepsMap.set(d, agg2);
                    }
                    if (!ready) continue;
                    if (nodeCfg.if) {
                      const condResults = new Map(results);
                      for (const [k, v] of childDepsMap) condResults.set(k, v);
                      const shouldRun = await this.evaluateCheckCondition(
                        node,
                        nodeCfg.if,
                        prInfo,
                        condResults,
                        debug
                      );
                      if (!shouldRun) {
                        perItemDone.add(node);
                        progressed = true;
                        continue;
                      }
                    }
                    const nodeProvType = nodeCfg.type || "ai";
                    const nodeProv = this.providerRegistry.getProviderOrThrow(nodeProvType);
                    this.setProviderWebhookContext(nodeProv);
                    const nodeProviderConfig = {
                      type: nodeProvType,
                      prompt: nodeCfg.prompt,
                      exec: nodeCfg.exec,
                      focus: nodeCfg.focus || this.mapCheckNameToFocus(node),
                      schema: nodeCfg.schema,
                      group: nodeCfg.group,
                      checkName: node,
                      eventContext: prInfo.eventContext,
                      transform: nodeCfg.transform,
                      transform_js: nodeCfg.transform_js,
                      env: nodeCfg.env,
                      forEach: nodeCfg.forEach,
                      ai: { timeout: timeout || 6e5, debug, ...nodeCfg.ai || {} }
                    };
                    const iterStart = this.recordIterationStart(node);
                    const execDepMap = new Map(childDepsMap);
                    const nodeAllDeps = DependencyResolver.getAllDependencies(
                      node,
                      dependencyGraph.nodes
                    );
                    for (const dep of nodeAllDeps) {
                      if (execDepMap.has(dep)) continue;
                      const perItemRes = perItemDepMap.get(dep);
                      if (perItemRes) {
                        execDepMap.set(dep, perItemRes);
                        continue;
                      }
                      const agg2 = results.get(dep);
                      if (!agg2) continue;
                      if (agg2 && (agg2.isForEach || Array.isArray(agg2.forEachItemResults) || Array.isArray(agg2.output))) {
                        if (Array.isArray(agg2.forEachItemResults) && agg2.forEachItemResults[itemIndex]) {
                          execDepMap.set(dep, agg2.forEachItemResults[itemIndex]);
                        } else if (Array.isArray(agg2.output) && agg2.output[itemIndex] !== void 0) {
                          execDepMap.set(dep, {
                            issues: [],
                            output: agg2.output[itemIndex]
                          });
                        } else {
                          execDepMap.set(dep, agg2);
                        }
                      } else {
                        execDepMap.set(dep, agg2);
                      }
                    }
                    const nodeItemRes = await this.executeWithRouting(
                      node,
                      nodeCfg,
                      nodeProv,
                      nodeProviderConfig,
                      prInfo,
                      execDepMap,
                      sessionInfo,
                      config,
                      dependencyGraph,
                      debug,
                      results,
                      { index: itemIndex, total: forEachItems.length, parent: forEachParentName }
                    );
                    if (config && (config.fail_if || nodeCfg.fail_if)) {
                      const fRes = await this.evaluateFailureConditions(node, nodeItemRes, config);
                      if (fRes.length > 0) {
                        const fIssues = fRes.filter((f) => f.failed).map((f) => ({
                          file: "system",
                          line: 0,
                          ruleId: f.conditionName,
                          message: f.message || `Failure condition met: ${f.expression}`,
                          severity: f.severity || "error",
                          category: "logic"
                        }));
                        nodeItemRes.issues = [...nodeItemRes.issues || [], ...fIssues];
                      }
                    }
                    const hadFatal = isFatal(nodeItemRes);
                    this.recordIterationComplete(
                      node,
                      iterStart,
                      !hadFatal,
                      nodeItemRes.issues || [],
                      nodeItemRes.output
                    );
                    if (!inlineAgg.has(node))
                      inlineAgg.set(node, {
                        issues: [],
                        outputs: [],
                        contents: [],
                        perItemResults: []
                      });
                    const agg = inlineAgg.get(node);
                    if (nodeItemRes.issues) agg.issues.push(...nodeItemRes.issues);
                    const nout = nodeItemRes.output;
                    if (nout !== void 0) agg.outputs.push(nout);
                    agg.perItemResults.push(nodeItemRes);
                    const ncontent = nodeItemRes.content;
                    if (typeof ncontent === "string" && ncontent.trim())
                      agg.contents.push(ncontent.trim());
                    perItemDepMap.set(node, nodeItemRes);
                    perItemDone.add(node);
                    progressed = true;
                  }
                  if (!progressed) break;
                }
                logger.info(
                  `  \u2714 ${itemIndex + 1}/${forEachItems.length} (${iterationDuration.toFixed(1)}s)`
                );
                perItemResults[itemIndex] = itemResult;
                return { index: itemIndex, itemResult };
              });
              const directForEachParents = (checkConfig.depends_on || []).filter((dep) => {
                const r = results.get(dep);
                return !!r && (r.isForEach || Array.isArray(r.forEachItemResults) || Array.isArray(r.forEachItems));
              });
              if (directForEachParents.length > 0) {
                logger.debug(
                  `  forEach: direct parents for "${checkName}": ${directForEachParents.join(", ")}`
                );
              }
              const isIndexFatalForParent = async (parent, idx) => {
                const agg = results.get(parent);
                if (!agg) return false;
                if (agg.forEachFatalMask && agg.forEachFatalMask[idx] === true) return true;
                const r = agg.forEachItemResults && agg.forEachItemResults[idx] || void 0;
                if (!r) return false;
                const hadFatalByIssues = this.hasFatal(r.issues || []);
                if (hadFatalByIssues) return true;
                try {
                  if (config && (config.fail_if || config.checks[parent]?.fail_if)) {
                    let rForEval = r;
                    const rawOut = r?.output;
                    if (typeof rawOut === "string") {
                      const parseTail = (text) => {
                        try {
                          const lines = text.split("\n");
                          for (let i = lines.length - 1; i >= 0; i--) {
                            const t = lines[i].trim();
                            if (t.startsWith("{") || t.startsWith("[")) {
                              const candidate = lines.slice(i).join("\n").trim();
                              if (candidate.startsWith("{") && candidate.endsWith("}") || candidate.startsWith("[") && candidate.endsWith("]")) {
                                return JSON.parse(candidate);
                              }
                            }
                          }
                        } catch {
                        }
                        try {
                          return JSON.parse(text);
                        } catch {
                          return null;
                        }
                      };
                      const parsed = parseTail(rawOut);
                      if (parsed && typeof parsed === "object") {
                        rForEval = { ...r, output: parsed };
                      }
                    }
                    const failures = await this.evaluateFailureConditions(parent, rForEval, config);
                    if (failures.some((f) => f.failed)) {
                    }
                    if (failures.some((f) => f.failed)) return true;
                  }
                } catch {
                }
                return false;
              };
              const runnableIndices = [];
              for (let idx = 0; idx < forEachItems.length; idx++) {
                let ok = true;
                for (const p of directForEachParents) {
                  if (await isIndexFatalForParent(p, idx)) {
                    ok = false;
                    break;
                  }
                }
                if (ok && typeof itemTasks[idx] === "function") runnableIndices.push(idx);
              }
              if (runnableIndices.length === 0) {
                this.recordSkip(checkName, "dependency_failed");
                logger.info(`\u23ED  Skipped (dependency failed: no runnable items)`);
                return {
                  checkName,
                  error: null,
                  result: { issues: [] },
                  skipped: true
                };
              }
              const forEachConcurrency = Math.max(
                1,
                Math.min(runnableIndices.length, effectiveMaxParallelism)
              );
              if (debug && forEachConcurrency > 1) {
                log2(
                  `\u{1F504} Debug: Limiting forEach concurrency for check "${checkName}" to ${forEachConcurrency}`
                );
              }
              const scheduledTasks = runnableIndices.map((i) => itemTasks[i]).filter((fn) => typeof fn === "function");
              const forEachResults = await this.executeWithLimitedParallelism(
                scheduledTasks,
                forEachConcurrency,
                false
              );
              let processedCount = 0;
              for (const result of forEachResults) {
                if (result.status === "rejected") {
                  const error = result.reason;
                  const errorMessage = error instanceof Error ? error.message : String(error);
                  allIssues.push({
                    ruleId: `${checkName}/forEach/iteration_error`,
                    severity: "error",
                    category: "logic",
                    message: `forEach iteration failed: ${errorMessage}`,
                    file: "",
                    line: 0
                  });
                  if (debug) {
                    log2(
                      `\u{1F504} Debug: forEach iteration for check "${checkName}" failed: ${errorMessage}`
                    );
                  }
                  continue;
                }
                if (result.value.skipped) {
                  continue;
                }
                const { index: finishedIndex, itemResult } = result.value;
                processedCount++;
                if (itemResult.issues) {
                  allIssues.push(...itemResult.issues);
                }
                const resultWithOutput = itemResult;
                allOutputs[finishedIndex] = resultWithOutput.output;
                const itemContent = resultWithOutput.content;
                if (typeof itemContent === "string" && itemContent.trim()) {
                  aggregatedContents.push(itemContent.trim());
                } else {
                  const outStr = typeof resultWithOutput.output === "string" ? resultWithOutput.output.trim() : "";
                  if (outStr) aggregatedContents.push(outStr);
                }
              }
              if (processedCount === 0) {
                this.recordSkip(checkName, "dependency_failed");
                logger.info(`\u23ED  Skipped (dependency failed for all items)`);
                return {
                  checkName,
                  error: null,
                  result: { issues: [] },
                  skipped: true
                };
              }
              const finalOutput = allOutputs.length > 0 ? allOutputs : void 0;
              finalResult = {
                issues: allIssues,
                ...finalOutput !== void 0 ? { output: finalOutput } : {}
              };
              finalResult.isForEach = true;
              finalResult.forEachItems = allOutputs;
              finalResult.forEachItemResults = perItemResults;
              try {
                const mask = finalResult.forEachItemResults ? await Promise.all(
                  Array.from({ length: forEachItems.length }, async (_, idx) => {
                    const r = finalResult.forEachItemResults[idx];
                    if (!r) return false;
                    let hadFatal = this.hasFatal(r.issues || []);
                    try {
                      const ids = (r.issues || []).map((i) => i.ruleId).join(",");
                      logger.debug(
                        `  forEach: item ${idx + 1}/${forEachItems.length} issues=${(r.issues || []).length} ids=[${ids}]`
                      );
                    } catch {
                    }
                    if (!hadFatal && config && (config.fail_if || checkConfig.fail_if)) {
                      try {
                        const failures = await this.evaluateFailureConditions(
                          checkName,
                          r,
                          config
                        );
                        hadFatal = failures.some((f) => f.failed);
                      } catch {
                      }
                    }
                    return hadFatal;
                  })
                ) : [];
                finalResult.forEachFatalMask = mask;
                logger.debug(
                  `  forEach: mask for "${checkName}" \u2192 fatals=${mask.filter(Boolean).length}/${mask.length}`
                );
              } catch {
              }
              if (aggregatedContents.length > 0) {
                finalResult.content = aggregatedContents.join("\n");
              }
              for (const [childName, agg] of inlineAgg.entries()) {
                const childCfg = config.checks[childName];
                const childEnrichedIssues = (agg.issues || []).map((issue) => ({
                  ...issue,
                  checkName: childName,
                  ruleId: `${childName}/${issue.ruleId}`,
                  group: childCfg.group,
                  schema: typeof childCfg.schema === "object" ? "custom" : childCfg.schema,
                  template: childCfg.template,
                  timestamp: Date.now()
                }));
                const childFinal = {
                  issues: childEnrichedIssues,
                  ...agg.outputs.length > 0 ? { output: agg.outputs } : {},
                  isForEach: true,
                  forEachItems: agg.outputs,
                  forEachItemResults: agg.perItemResults,
                  ...agg.contents.length > 0 ? { content: agg.contents.join("\n") } : {}
                };
                try {
                  const mask = Array.from(
                    { length: agg.perItemResults.length },
                    (_, idx) => {
                      const r = agg.perItemResults[idx];
                      if (!r) return false;
                      const hadFatal = (r.issues || []).some((issue) => {
                        const id = issue.ruleId || "";
                        return issue.severity === "error" || issue.severity === "critical" || id === "command/execution_error" || id.endsWith("/command/execution_error") || id === "command/timeout" || id.endsWith("/command/timeout") || id === "command/transform_js_error" || id.endsWith("/command/transform_js_error") || id === "command/transform_error" || id.endsWith("/command/transform_error") || id.endsWith("/forEach/iteration_error") || id === "forEach/undefined_output" || id.endsWith("/forEach/undefined_output") || id.endsWith("_fail_if") || id.endsWith("/global_fail_if");
                      });
                      return hadFatal;
                    }
                  );
                  childFinal.forEachFatalMask = mask;
                } catch {
                }
                results.set(childName, childFinal);
              }
              if (debug && process.env.VISOR_OUTPUT_FORMAT !== "json" && process.env.VISOR_OUTPUT_FORMAT !== "sarif") {
                console.log(
                  `\u{1F504} Debug: Completed forEach execution for check "${checkName}", total issues: ${allIssues.length}`
                );
              }
            }
          } else {
            if (checkConfig.if) {
              const shouldRun = await this.evaluateCheckCondition(
                checkName,
                checkConfig.if,
                prInfo,
                results,
                debug
              );
              if (!shouldRun) {
                this.recordSkip(checkName, "if_condition", checkConfig.if);
                logger.info(`\u23ED  Skipped (if: ${this.truncate(checkConfig.if, 40)})`);
                return {
                  checkName,
                  error: null,
                  result: {
                    issues: []
                  },
                  skipped: true
                };
              }
            }
            finalResult = await this.executeWithRouting(
              checkName,
              checkConfig,
              provider,
              providerConfig,
              prInfo,
              dependencyResults,
              sessionInfo,
              config,
              dependencyGraph,
              debug,
              results
            );
            if (config && (config.fail_if || checkConfig.fail_if)) {
              const failureResults = await this.evaluateFailureConditions(
                checkName,
                finalResult,
                config
              );
              if (failureResults.length > 0) {
                const failureIssues = failureResults.filter((f) => f.failed).map((f) => ({
                  file: "system",
                  line: 0,
                  ruleId: f.conditionName,
                  message: f.message || `Failure condition met: ${f.expression}`,
                  severity: f.severity || "error",
                  category: "logic"
                }));
                finalResult.issues = [...finalResult.issues || [], ...failureIssues];
              }
            }
            const hadFatalError = (finalResult.issues || []).some((issue) => {
              const id = issue.ruleId || "";
              return id === "command/execution_error" || id.endsWith("/command/execution_error") || id === "command/timeout" || id.endsWith("/command/timeout") || id === "command/transform_js_error" || id.endsWith("/command/transform_js_error") || id === "command/transform_error" || id.endsWith("/command/transform_error") || id === "forEach/undefined_output" || id.endsWith("/forEach/undefined_output");
            });
            this.recordIterationComplete(
              checkName,
              checkStartTime,
              !hadFatalError,
              // Success if no fatal errors
              finalResult.issues || [],
              finalResult.output
            );
            if (checkConfig.forEach) {
              try {
                const finalResultWithOutput = finalResult;
                const outputPreview = JSON.stringify(finalResultWithOutput.output)?.slice(0, 200) || "(empty)";
                logger.debug(`\u{1F527} Debug: Check "${checkName}" provider returned: ${outputPreview}`);
              } catch {
              }
            }
            if (debug) {
              log2(
                `\u{1F527} Debug: Completed check: ${checkName}, issues found: ${(finalResult.issues || []).length}`
              );
            }
            if (finalResult.sessionId) {
              sessionIds.set(checkName, finalResult.sessionId);
              if (debug) {
                log2(`\u{1F527} Debug: Tracked cloned session for cleanup: ${finalResult.sessionId}`);
              }
            }
          }
          const enrichedIssues = (finalResult.issues || []).map((issue) => ({
            ...issue,
            checkName,
            ruleId: `${checkName}/${issue.ruleId}`,
            group: checkConfig.group,
            schema: typeof checkConfig.schema === "object" ? "custom" : checkConfig.schema,
            template: checkConfig.template,
            timestamp: Date.now()
          }));
          const enrichedResult = {
            ...finalResult,
            issues: enrichedIssues
          };
          const checkDuration = ((Date.now() - checkStartTime) / 1e3).toFixed(1);
          const issueCount = enrichedIssues.length;
          const checkStats = this.executionStats.get(checkName);
          if (checkStats && checkStats.totalRuns > 1) {
            if (issueCount > 0) {
              logger.success(
                `Check complete: ${checkName} (${checkDuration}s) - ${checkStats.totalRuns} runs, ${issueCount} issue${issueCount === 1 ? "" : "s"}`
              );
            } else {
              logger.success(
                `Check complete: ${checkName} (${checkDuration}s) - ${checkStats.totalRuns} runs`
              );
            }
          } else if (checkStats && checkStats.outputsProduced && checkStats.outputsProduced > 0) {
            logger.success(
              `Check complete: ${checkName} (${checkDuration}s) - ${checkStats.outputsProduced} items`
            );
          } else if (issueCount > 0) {
            logger.success(
              `Check complete: ${checkName} (${checkDuration}s) - ${issueCount} issue${issueCount === 1 ? "" : "s"} found`
            );
          } else {
            logger.success(`Check complete: ${checkName} (${checkDuration}s)`);
          }
          return {
            checkName,
            error: null,
            result: enrichedResult
          };
        } catch (error) {
          const errorMessage = error instanceof Error ? `${error.message}
${error.stack || ""}` : String(error);
          const checkDuration = ((Date.now() - checkStartTime) / 1e3).toFixed(1);
          this.recordError(checkName, error instanceof Error ? error : new Error(String(error)));
          this.recordIterationComplete(checkName, checkStartTime, false, [], void 0);
          logger.error(`\u2716 Check failed: ${checkName} (${checkDuration}s) - ${errorMessage}`);
          if (debug) {
            log2(`\u{1F527} Debug: Error in check ${checkName}: ${errorMessage}`);
          }
          return {
            checkName,
            error: errorMessage,
            result: null
          };
        }
      });
      const levelResults = await this.executeWithLimitedParallelism(
        levelTaskFunctions,
        actualParallelism,
        effectiveFailFast
      );
      const levelChecksList = executionGroup.parallel.filter((name) => !results.has(name));
      for (let i = 0; i < levelResults.length; i++) {
        const checkName = levelChecksList[i];
        const result = levelResults[i];
        const checkConfig = config.checks[checkName];
        if (result.status === "fulfilled" && result.value.result && !result.value.error) {
          if (result.value.skipped) {
            if (debug) {
              log2(`\u{1F527} Debug: Storing skip marker for skipped check "${checkName}"`);
            }
            results.set(checkName, {
              issues: [
                {
                  ruleId: `${checkName}/__skipped`,
                  severity: "info",
                  category: "logic",
                  message: "Check was skipped",
                  file: "",
                  line: 0
                }
              ]
            });
            continue;
          }
          const reviewResult = result.value.result;
          const reviewSummaryWithOutput = reviewResult;
          if (checkConfig?.forEach && (!reviewResult.issues || reviewResult.issues.length === 0)) {
            const validation2 = this.validateAndNormalizeForEachOutput(
              checkName,
              reviewSummaryWithOutput.output,
              checkConfig.group
            );
            if (!validation2.isValid) {
              results.set(
                checkName,
                validation2.error.issues ? { issues: validation2.error.issues } : {}
              );
              continue;
            }
            const normalizedOutput = validation2.normalizedOutput;
            logger.debug(
              `\u{1F527} Debug: Raw output for forEach check ${checkName}: ${Array.isArray(reviewSummaryWithOutput.output) ? `array(${reviewSummaryWithOutput.output.length})` : typeof reviewSummaryWithOutput.output}`
            );
            try {
              const preview = JSON.stringify(normalizedOutput);
              logger.debug(
                `\u{1F527} Debug: Check "${checkName}" forEach output: ${preview?.slice(0, 200) || "(empty)"}`
              );
            } catch {
            }
            reviewSummaryWithOutput.forEachItems = normalizedOutput;
            reviewSummaryWithOutput.isForEach = true;
          }
          results.set(checkName, reviewResult);
        } else {
          const errorSummary = {
            issues: [
              {
                file: "system",
                line: 0,
                endLine: void 0,
                ruleId: `${checkName}/error`,
                message: result.status === "fulfilled" ? result.value.error || "Unknown error" : result.reason instanceof Error ? result.reason.message : String(result.reason),
                severity: "error",
                category: "logic",
                suggestion: void 0,
                replacement: void 0
              }
            ]
          };
          results.set(checkName, errorSummary);
          if (effectiveFailFast) {
            if (debug) {
              log2(`\u{1F6D1} Check "${checkName}" failed and fail-fast is enabled - stopping execution`);
            }
            shouldStopExecution = true;
            break;
          }
        }
      }
      if (effectiveFailFast && !shouldStopExecution) {
        for (let i = 0; i < levelResults.length; i++) {
          const checkName = executionGroup.parallel[i];
          const result = levelResults[i];
          if (result.status === "fulfilled" && result.value.result && !result.value.error) {
            const hasFailuresToReport = (result.value.result.issues || []).some(
              (issue) => issue.severity === "error" || issue.severity === "critical"
            );
            if (hasFailuresToReport) {
              if (debug) {
                log2(
                  `\u{1F6D1} Check "${checkName}" found critical/high issues and fail-fast is enabled - stopping execution`
                );
              }
              shouldStopExecution = true;
              break;
            }
          }
        }
      }
    }
    if (debug) {
      if (shouldStopExecution) {
        log2(
          `\u{1F6D1} Execution stopped early due to fail-fast after processing ${results.size} of ${checks.length} checks`
        );
      } else {
        log2(`\u2705 Dependency-aware execution completed successfully for all ${results.size} checks`);
      }
    }
    if (sessionIds.size > 0 && debug) {
      log2(`\u{1F9F9} Cleaning up ${sessionIds.size} AI sessions...`);
      for (const [checkName, sessionId] of sessionIds) {
        try {
          sessionRegistry.unregisterSession(sessionId);
          log2(`\u{1F5D1}\uFE0F Cleaned up session for check ${checkName}: ${sessionId}`);
        } catch (error) {
          log2(`\u26A0\uFE0F Failed to cleanup session for check ${checkName}: ${error}`);
        }
      }
    }
    const executionStatistics = this.buildExecutionStatistics();
    if (logFn === console.log) {
      this.logExecutionSummary(executionStatistics);
    }
    if (shouldStopExecution) {
      logger.info("");
      logger.warn(`\u26A0\uFE0F  Execution stopped early due to fail-fast`);
    }
    return this.aggregateDependencyAwareResults(
      results,
      dependencyGraph,
      debug,
      shouldStopExecution
    );
  }
  /**
   * Execute multiple checks in parallel using controlled parallelism (legacy method)
   */
  async executeParallelChecks(prInfo, checks, timeout, config, logFn, debug, maxParallelism, failFast) {
    const log2 = logFn || console.error;
    log2(`\u{1F527} Debug: Starting parallel execution of ${checks.length} checks`);
    if (!config?.checks) {
      throw new Error("Config with check definitions required for parallel execution");
    }
    const effectiveMaxParallelism = maxParallelism ?? config.max_parallelism ?? 3;
    const effectiveFailFast = failFast ?? config.fail_fast ?? false;
    log2(`\u{1F527} Debug: Using max parallelism: ${effectiveMaxParallelism}`);
    log2(`\u{1F527} Debug: Using fail-fast: ${effectiveFailFast}`);
    const provider = this.providerRegistry.getProviderOrThrow("ai");
    this.setProviderWebhookContext(provider);
    const checkTaskFunctions = checks.map((checkName) => async () => {
      const checkConfig = config.checks[checkName];
      if (!checkConfig) {
        log2(`\u{1F527} Debug: No config found for check: ${checkName}`);
        return {
          checkName,
          error: `No configuration found for check: ${checkName}`,
          result: null
        };
      }
      try {
        console.error(
          `\u{1F527} Debug: Starting check: ${checkName} with prompt type: ${typeof checkConfig.prompt}`
        );
        if (checkConfig.if) {
          const override = this.routingEventOverride;
          const eventName = override ? override.startsWith("pr_") ? "pull_request" : override === "issue_comment" ? "issue_comment" : override.startsWith("issue_") ? "issues" : "manual" : "issue_comment";
          const commenterAssoc = prInfo?.eventContext?.comment?.author_association || prInfo?.eventContext?.comment?.authorAssociation || prInfo.authorAssociation;
          const shouldRun = await this.failureEvaluator.evaluateIfCondition(
            checkName,
            checkConfig.if,
            {
              branch: prInfo.head,
              baseBranch: prInfo.base,
              filesChanged: prInfo.files.map((f) => f.filename),
              event: eventName,
              // honor routing override if present
              environment: getSafeEnvironmentVariables(),
              previousResults: /* @__PURE__ */ new Map(),
              // No previous results in parallel execution
              authorAssociation: commenterAssoc
            }
          );
          if (!shouldRun) {
            console.error(
              `\u{1F527} Debug: Skipping check '${checkName}' - if condition evaluated to false`
            );
            return {
              checkName,
              error: null,
              result: {
                issues: []
              }
            };
          }
        }
        const providerConfig = {
          type: "ai",
          prompt: checkConfig.prompt,
          focus: checkConfig.focus || this.mapCheckNameToFocus(checkName),
          schema: checkConfig.schema,
          group: checkConfig.group,
          eventContext: prInfo.eventContext,
          // Pass event context for templates
          ai: {
            timeout: timeout || 6e5,
            debug,
            // Pass debug flag to AI provider
            ...checkConfig.ai || {}
          }
        };
        const result = await provider.execute(prInfo, providerConfig);
        console.error(
          `\u{1F527} Debug: Completed check: ${checkName}, issues found: ${(result.issues || []).length}`
        );
        const enrichedIssues = (result.issues || []).map((issue) => ({
          ...issue,
          ruleId: `${checkName}/${issue.ruleId}`,
          group: checkConfig.group,
          schema: typeof checkConfig.schema === "object" ? "custom" : checkConfig.schema,
          template: checkConfig.template,
          timestamp: Date.now()
        }));
        const enrichedResult = {
          ...result,
          issues: enrichedIssues
        };
        return {
          checkName,
          error: null,
          result: enrichedResult
        };
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        log2(`\u{1F527} Debug: Error in check ${checkName}: ${errorMessage}`);
        return {
          checkName,
          error: errorMessage,
          result: null
        };
      }
    });
    log2(
      `\u{1F527} Debug: Executing ${checkTaskFunctions.length} checks with max parallelism: ${effectiveMaxParallelism}`
    );
    const results = await this.executeWithLimitedParallelism(
      checkTaskFunctions,
      effectiveMaxParallelism,
      effectiveFailFast
    );
    const completedChecks = results.filter(
      (r) => r.status === "fulfilled" || r.status === "rejected"
    ).length;
    const stoppedEarly = completedChecks < checks.length;
    if (stoppedEarly && effectiveFailFast) {
      log2(
        `\u{1F6D1} Parallel execution stopped early due to fail-fast after processing ${completedChecks} of ${checks.length} checks`
      );
    } else {
      log2(`\u2705 Parallel execution completed for all ${completedChecks} checks`);
    }
    return this.aggregateParallelResults(results, checks, debug, stoppedEarly);
  }
  /**
   * Execute a single configured check
   */
  async executeSingleConfiguredCheck(prInfo, checkName, timeout, config, _logFn) {
    if (!config?.checks?.[checkName]) {
      throw new Error(`No configuration found for check: ${checkName}`);
    }
    const checkConfig = config.checks[checkName];
    const provider = this.providerRegistry.getProviderOrThrow("ai");
    this.setProviderWebhookContext(provider);
    const providerConfig = {
      type: "ai",
      prompt: checkConfig.prompt,
      focus: checkConfig.focus || this.mapCheckNameToFocus(checkName),
      schema: checkConfig.schema,
      group: checkConfig.group,
      eventContext: prInfo.eventContext,
      // Pass event context for templates
      ai: {
        timeout: timeout || 6e5,
        ...checkConfig.ai || {}
      },
      // Inherit global AI provider and model settings
      ai_provider: checkConfig.ai_provider || config.ai_provider,
      ai_model: checkConfig.ai_model || config.ai_model
    };
    const result = await provider.execute(prInfo, providerConfig);
    const prefixedIssues = (result.issues || []).map((issue) => ({
      ...issue,
      ruleId: `${checkName}/${issue.ruleId}`,
      group: checkConfig.group,
      schema: typeof checkConfig.schema === "object" ? "custom" : checkConfig.schema,
      timestamp: Date.now()
    }));
    return {
      ...result,
      issues: prefixedIssues
    };
  }
  /**
   * Map check name to focus for AI provider
   * This is a fallback when focus is not explicitly configured
   */
  mapCheckNameToFocus(checkName) {
    const focusMap = {
      security: "security",
      performance: "performance",
      style: "style",
      architecture: "architecture"
    };
    return focusMap[checkName] || "all";
  }
  /**
   * Aggregate results from dependency-aware check execution
   */
  aggregateDependencyAwareResults(results, dependencyGraph, debug, stoppedEarly) {
    const aggregatedIssues = [];
    const debugInfo = [];
    const contentMap = {};
    const outputsMap = {};
    const stats = DependencyResolver.getExecutionStats(dependencyGraph);
    const executionInfo = [
      stoppedEarly ? `\u{1F6D1} Dependency-aware execution stopped early (fail-fast):` : `\u{1F50D} Dependency-aware execution completed:`,
      `  - ${results.size} of ${stats.totalChecks} checks processed`,
      `  - Execution levels: ${stats.parallelLevels}`,
      `  - Maximum parallelism: ${stats.maxParallelism}`,
      `  - Average parallelism: ${stats.averageParallelism.toFixed(1)}`,
      `  - Checks with dependencies: ${stats.checksWithDependencies}`,
      stoppedEarly ? `  - Stopped early due to fail-fast behavior` : ``
    ].filter(Boolean);
    debugInfo.push(...executionInfo);
    for (const executionGroup of dependencyGraph.executionOrder) {
      for (const checkName of executionGroup.parallel) {
        const result = results.get(checkName);
        if (!result) {
          debugInfo.push(`\u274C Check "${checkName}" had no result`);
          continue;
        }
        const hasErrors = (result.issues || []).some(
          (issue) => issue.ruleId?.includes("/error") || issue.ruleId?.includes("/promise-error")
        );
        if (hasErrors) {
          debugInfo.push(`\u274C Check "${checkName}" failed with errors`);
        } else {
          debugInfo.push(
            `\u2705 Check "${checkName}" completed: ${(result.issues || []).length} issues found (level ${executionGroup.level})`
          );
        }
        const nonInternalIssues = (result.issues || []).filter(
          (issue) => !issue.ruleId?.endsWith("/__skipped")
        );
        aggregatedIssues.push(...nonInternalIssues);
        const resultSummary = result;
        const resultContent = resultSummary.content;
        if (typeof resultContent === "string" && resultContent.trim()) {
          contentMap[checkName] = resultContent.trim();
        }
        if (resultSummary.output !== void 0) {
          outputsMap[checkName] = resultSummary.output;
        }
      }
    }
    if (debug) {
      console.error(
        `\u{1F527} Debug: Aggregated ${aggregatedIssues.length} issues from ${results.size} dependency-aware checks`
      );
    }
    const suppressionEnabled = this.config?.output?.suppressionEnabled !== false;
    const issueFilter = new IssueFilter(suppressionEnabled);
    const filteredIssues = issueFilter.filterIssues(aggregatedIssues, this.workingDirectory);
    let aggregatedDebug;
    if (debug) {
      const debugResults = Array.from(results.entries()).filter(([_, result]) => result.debug);
      if (debugResults.length > 0) {
        const [, firstResult] = debugResults[0];
        const firstDebug = firstResult.debug;
        const totalProcessingTime = debugResults.reduce((sum, [_, result]) => {
          return sum + (result.debug.processingTime || 0);
        }, 0);
        aggregatedDebug = {
          provider: firstDebug.provider,
          model: firstDebug.model,
          apiKeySource: firstDebug.apiKeySource,
          processingTime: totalProcessingTime,
          prompt: debugResults.map(([checkName, result]) => `[${checkName}]
${result.debug.prompt}`).join("\n\n"),
          rawResponse: debugResults.map(([checkName, result]) => `[${checkName}]
${result.debug.rawResponse}`).join("\n\n"),
          promptLength: debugResults.reduce(
            (sum, [_, result]) => sum + (result.debug.promptLength || 0),
            0
          ),
          responseLength: debugResults.reduce(
            (sum, [_, result]) => sum + (result.debug.responseLength || 0),
            0
          ),
          jsonParseSuccess: debugResults.every(([_, result]) => result.debug.jsonParseSuccess),
          errors: debugResults.flatMap(
            ([checkName, result]) => (result.debug.errors || []).map((error) => `[${checkName}] ${error}`)
          ),
          timestamp: (/* @__PURE__ */ new Date()).toISOString(),
          totalApiCalls: debugResults.length,
          apiCallDetails: debugResults.map(([checkName, result]) => ({
            checkName,
            provider: result.debug.provider,
            model: result.debug.model,
            processingTime: result.debug.processingTime,
            success: result.debug.jsonParseSuccess
          }))
        };
      }
    }
    const summary = {
      issues: filteredIssues,
      debug: aggregatedDebug
    };
    if (Object.keys(contentMap).length > 0) {
      summary.__contents = contentMap;
    }
    if (Object.keys(outputsMap).length > 0) {
      summary.__outputs = outputsMap;
    }
    return summary;
  }
  /**
   * Aggregate results from parallel check execution (legacy method)
   */
  aggregateParallelResults(results, checkNames, debug, _stoppedEarly) {
    const aggregatedIssues = [];
    const debugInfo = [];
    results.forEach((result, index) => {
      const checkName = checkNames[index];
      if (result.status === "fulfilled") {
        const checkResult = result.value;
        if (checkResult.error) {
          logger.debug(`\u{1F527} Debug: Check ${checkName} failed: ${checkResult.error}`);
          debugInfo.push(`\u274C Check "${checkName}" failed: ${checkResult.error}`);
          const isCriticalError = checkResult.error.includes("API rate limit") || checkResult.error.includes("403") || checkResult.error.includes("401") || checkResult.error.includes("authentication") || checkResult.error.includes("API key");
          aggregatedIssues.push({
            file: "system",
            line: 0,
            endLine: void 0,
            ruleId: `${checkName}/error`,
            message: `Check "${checkName}" failed: ${checkResult.error}`,
            severity: isCriticalError ? "critical" : "error",
            category: "logic",
            suggestion: isCriticalError ? "Please check your API credentials and rate limits" : void 0,
            replacement: void 0
          });
        } else if (checkResult.result) {
          logger.debug(
            `\u{1F527} Debug: Check ${checkName} succeeded with ${(checkResult.result.issues || []).length} issues`
          );
          debugInfo.push(
            `\u2705 Check "${checkName}" completed: ${(checkResult.result.issues || []).length} issues found`
          );
          aggregatedIssues.push(...checkResult.result.issues || []);
        }
      } else {
        const errorMessage = result.reason instanceof Error ? result.reason.message : String(result.reason);
        logger.debug(`\u{1F527} Debug: Check ${checkName} promise rejected: ${errorMessage}`);
        debugInfo.push(`\u274C Check "${checkName}" promise rejected: ${errorMessage}`);
        const isCriticalError = errorMessage.includes("API rate limit") || errorMessage.includes("403") || errorMessage.includes("401") || errorMessage.includes("authentication") || errorMessage.includes("API key");
        aggregatedIssues.push({
          file: "system",
          line: 0,
          endLine: void 0,
          ruleId: `${checkName}/promise-error`,
          message: `Check "${checkName}" execution failed: ${errorMessage}`,
          severity: isCriticalError ? "critical" : "error",
          category: "logic",
          suggestion: isCriticalError ? "Please check your API credentials and rate limits" : void 0,
          replacement: void 0
        });
      }
    });
    if (debug) {
      console.error(
        `\u{1F527} Debug: Aggregated ${aggregatedIssues.length} issues from ${results.length} checks`
      );
    }
    const suppressionEnabled = this.config?.output?.suppressionEnabled !== false;
    const issueFilter = new IssueFilter(suppressionEnabled);
    const filteredIssues = issueFilter.filterIssues(aggregatedIssues, this.workingDirectory);
    let aggregatedDebug;
    if (debug) {
      const debugResults = results.map((result, index) => ({
        result,
        checkName: checkNames[index]
      })).filter(({ result }) => result.status === "fulfilled" && result.value?.result?.debug);
      if (debugResults.length > 0) {
        const firstResult = debugResults[0].result;
        if (firstResult.status === "fulfilled") {
          const firstDebug = firstResult.value.result.debug;
          const totalProcessingTime = debugResults.reduce((sum, { result }) => {
            if (result.status === "fulfilled") {
              return sum + (result.value.result.debug.processingTime || 0);
            }
            return sum;
          }, 0);
          aggregatedDebug = {
            // Use first result as template for provider/model info
            provider: firstDebug.provider,
            model: firstDebug.model,
            apiKeySource: firstDebug.apiKeySource,
            // Aggregate processing time from all checks
            processingTime: totalProcessingTime,
            // Combine prompts with check names
            prompt: debugResults.map(({ checkName, result }) => {
              if (result.status === "fulfilled") {
                return `[${checkName}]
${result.value.result.debug.prompt}`;
              }
              return `[${checkName}] Error: Promise was rejected`;
            }).join("\n\n"),
            // Combine responses
            rawResponse: debugResults.map(({ checkName, result }) => {
              if (result.status === "fulfilled") {
                return `[${checkName}]
${result.value.result.debug.rawResponse}`;
              }
              return `[${checkName}] Error: Promise was rejected`;
            }).join("\n\n"),
            promptLength: debugResults.reduce((sum, { result }) => {
              if (result.status === "fulfilled") {
                return sum + (result.value.result.debug.promptLength || 0);
              }
              return sum;
            }, 0),
            responseLength: debugResults.reduce((sum, { result }) => {
              if (result.status === "fulfilled") {
                return sum + (result.value.result.debug.responseLength || 0);
              }
              return sum;
            }, 0),
            jsonParseSuccess: debugResults.every(({ result }) => {
              if (result.status === "fulfilled") {
                return result.value.result.debug.jsonParseSuccess;
              }
              return false;
            }),
            errors: debugResults.flatMap(({ result, checkName }) => {
              if (result.status === "fulfilled") {
                return (result.value.result.debug.errors || []).map(
                  (error) => `[${checkName}] ${error}`
                );
              }
              return [`[${checkName}] Promise was rejected`];
            }),
            timestamp: (/* @__PURE__ */ new Date()).toISOString(),
            // Add additional debug information for parallel execution
            totalApiCalls: debugResults.length,
            apiCallDetails: debugResults.map(({ checkName, result }) => {
              if (result.status === "fulfilled") {
                return {
                  checkName,
                  provider: result.value.result.debug.provider,
                  model: result.value.result.debug.model,
                  processingTime: result.value.result.debug.processingTime,
                  success: result.value.result.debug.jsonParseSuccess
                };
              }
              return {
                checkName,
                provider: "unknown",
                model: "unknown",
                processingTime: 0,
                success: false
              };
            })
          };
        }
      }
    }
    return {
      issues: filteredIssues,
      debug: aggregatedDebug
    };
  }
  /**
   * Get available check types
   */
  static getAvailableCheckTypes() {
    const registry = CheckProviderRegistry.getInstance();
    const providerTypes = registry.getAvailableProviders();
    const standardTypes = ["security", "performance", "style", "architecture", "all"];
    return [.../* @__PURE__ */ new Set([...providerTypes, ...standardTypes])];
  }
  /**
   * Validate check types
   */
  static validateCheckTypes(checks) {
    const availableChecks = _CheckExecutionEngine.getAvailableCheckTypes();
    const valid = [];
    const invalid = [];
    for (const check of checks) {
      if (availableChecks.includes(check)) {
        valid.push(check);
      } else {
        invalid.push(check);
      }
    }
    return { valid, invalid };
  }
  /**
   * List available providers with their status
   */
  async listProviders() {
    return await this.providerRegistry.listProviders();
  }
  /**
   * Create a mock Octokit instance for local analysis
   */
  createMockOctokit() {
    const mockGet = async () => ({
      data: {
        number: 0,
        title: "Local Analysis",
        body: "Local repository analysis",
        user: { login: "local-user" },
        base: { ref: "main" },
        head: { ref: "HEAD" }
      }
    });
    const mockListFiles = async () => ({
      data: []
    });
    const mockListComments = async () => ({
      data: []
    });
    const mockCreateComment = async () => ({
      data: { id: 1 }
    });
    return {
      rest: {
        pulls: {
          get: mockGet,
          listFiles: mockListFiles
        },
        issues: {
          listComments: mockListComments,
          createComment: mockCreateComment
        }
      },
      request: async () => ({ data: {} }),
      graphql: async () => ({}),
      log: {
        debug: () => {
        },
        info: () => {
        },
        warn: () => {
        },
        error: () => {
        }
      },
      hook: {
        before: () => {
        },
        after: () => {
        },
        error: () => {
        },
        wrap: () => {
        }
      },
      auth: async () => ({ token: "mock-token" })
    };
  }
  /**
   * Create an error result
   */
  createErrorResult(repositoryInfo, errorMessage, startTime, timestamp, checksExecuted) {
    const executionTime = Date.now() - startTime;
    return {
      repositoryInfo,
      reviewSummary: {
        issues: [
          {
            file: "system",
            line: 0,
            endLine: void 0,
            ruleId: "system/error",
            message: errorMessage,
            severity: "error",
            category: "logic",
            suggestion: void 0,
            replacement: void 0
          }
        ]
      },
      executionTime,
      timestamp,
      checksExecuted
    };
  }
  /**
   * Check if a task result should trigger fail-fast behavior
   */
  isFailFastCandidate(value) {
    if (typeof value !== "object" || value === null) {
      return false;
    }
    const candidate = value;
    if (candidate.error !== void 0 && typeof candidate.error !== "string") {
      return false;
    }
    if (candidate.result !== void 0) {
      if (typeof candidate.result !== "object" || candidate.result === null) {
        return false;
      }
      const issues = candidate.result.issues;
      if (issues !== void 0 && !Array.isArray(issues)) {
        return false;
      }
    }
    return true;
  }
  shouldFailFast(result) {
    if (!this.isFailFastCandidate(result)) {
      return false;
    }
    if (result.error) {
      return true;
    }
    const issues = result.result?.issues;
    if (Array.isArray(issues)) {
      return issues.some((issue) => issue?.severity === "error" || issue?.severity === "critical");
    }
    return false;
  }
  /**
   * Check if the working directory is a valid git repository
   */
  async isGitRepository() {
    try {
      const repositoryInfo = await this.gitAnalyzer.analyzeRepository();
      return repositoryInfo.isGitRepository;
    } catch {
      return false;
    }
  }
  /**
   * Evaluate failure conditions for a check result
   */
  async evaluateFailureConditions(checkName, reviewSummary, config, prInfo) {
    if (!config) {
      return [];
    }
    const checkConfig = config.checks[checkName];
    const checkSchema = typeof checkConfig?.schema === "object" ? "custom" : checkConfig?.schema || "";
    const checkGroup = checkConfig?.group || "";
    const globalFailIf = config.fail_if;
    const checkFailIf = checkConfig?.fail_if;
    if (globalFailIf || checkFailIf) {
      const results = [];
      if (globalFailIf) {
        const failed = await this.failureEvaluator.evaluateSimpleCondition(
          checkName,
          checkSchema,
          checkGroup,
          reviewSummary,
          globalFailIf
        );
        if (failed) {
          logger.warn(`\u26A0\uFE0F  Check "${checkName}" - global fail_if condition met: ${globalFailIf}`);
          results.push({
            conditionName: "global_fail_if",
            expression: globalFailIf,
            failed: true,
            severity: "error",
            message: "Global failure condition met",
            haltExecution: false
          });
        } else {
          logger.debug(`\u2713 Check "${checkName}" - global fail_if condition passed`);
        }
      }
      if (checkFailIf) {
        const failed = await this.failureEvaluator.evaluateSimpleCondition(
          checkName,
          checkSchema,
          checkGroup,
          reviewSummary,
          checkFailIf
        );
        if (failed) {
          logger.warn(`\u26A0\uFE0F  Check "${checkName}" - fail_if condition met: ${checkFailIf}`);
          results.push({
            conditionName: `${checkName}_fail_if`,
            expression: checkFailIf,
            failed: true,
            severity: "error",
            message: `Check ${checkName} failure condition met`,
            haltExecution: false
          });
        } else {
          logger.debug(`\u2713 Check "${checkName}" - fail_if condition passed`);
        }
      }
      return results;
    }
    const globalConditions = config.failure_conditions;
    const checkConditions = checkConfig?.failure_conditions;
    return await this.failureEvaluator.evaluateConditions(
      checkName,
      checkSchema,
      checkGroup,
      reviewSummary,
      globalConditions,
      checkConditions,
      void 0,
      // previousOutputs
      prInfo?.authorAssociation
    );
  }
  /**
   * Get repository status summary
   */
  async getRepositoryStatus() {
    try {
      const repositoryInfo = await this.gitAnalyzer.analyzeRepository();
      return {
        isGitRepository: repositoryInfo.isGitRepository,
        hasChanges: repositoryInfo.files.length > 0,
        branch: repositoryInfo.head,
        filesChanged: repositoryInfo.files.length
      };
    } catch {
      return {
        isGitRepository: false,
        hasChanges: false,
        branch: "unknown",
        filesChanged: 0
      };
    }
  }
  /**
   * Initialize GitHub check runs for each configured check
   */
  async initializeGitHubChecks(options, logFn) {
    if (!options.githubChecks?.octokit || !options.githubChecks.owner || !options.githubChecks.repo || !options.githubChecks.headSha) {
      logFn("\u26A0\uFE0F GitHub checks enabled but missing required parameters");
      return;
    }
    try {
      this.githubCheckService = new GitHubCheckService(options.githubChecks.octokit);
      this.checkRunMap = /* @__PURE__ */ new Map();
      this.githubContext = {
        owner: options.githubChecks.owner,
        repo: options.githubChecks.repo
      };
      logFn(`\u{1F50D} Creating GitHub check runs for ${options.checks.length} checks...`);
      for (const checkName of options.checks) {
        try {
          const checkRunOptions = {
            owner: options.githubChecks.owner,
            repo: options.githubChecks.repo,
            head_sha: options.githubChecks.headSha,
            name: `Visor: ${checkName}`,
            external_id: `visor-${checkName}-${options.githubChecks.headSha.substring(0, 7)}`
          };
          const checkRun = await this.githubCheckService.createCheckRun(checkRunOptions, {
            title: `${checkName} Analysis`,
            summary: `Running ${checkName} check using AI-powered analysis...`
          });
          this.checkRunMap.set(checkName, checkRun);
          logFn(`\u2705 Created check run for ${checkName}: ${checkRun.url}`);
        } catch (error) {
          logFn(`\u274C Failed to create check run for ${checkName}: ${error}`);
        }
      }
    } catch (error) {
      if (error instanceof Error && (error.message.includes("403") || error.message.includes("checks:write"))) {
        logFn(
          "\u26A0\uFE0F GitHub checks API not available - insufficient permissions. Check runs will be skipped."
        );
        logFn('\u{1F4A1} To enable check runs, ensure your GitHub token has "checks:write" permission.');
        this.githubCheckService = void 0;
        this.checkRunMap = void 0;
      } else {
        logFn(`\u274C Failed to initialize GitHub check runs: ${error}`);
        this.githubCheckService = void 0;
        this.checkRunMap = void 0;
      }
    }
  }
  /**
   * Update GitHub check runs to in-progress status
   */
  async updateGitHubChecksInProgress(options) {
    if (!this.githubCheckService || !this.checkRunMap || !options.githubChecks?.owner || !options.githubChecks.repo) {
      return;
    }
    for (const [checkName, checkRun] of this.checkRunMap) {
      try {
        await this.githubCheckService.updateCheckRunInProgress(
          options.githubChecks.owner,
          options.githubChecks.repo,
          checkRun.id,
          {
            title: `Analyzing with ${checkName}...`,
            summary: `AI-powered analysis is in progress for ${checkName} check.`
          }
        );
        console.log(`\u{1F504} Updated ${checkName} check to in-progress status`);
      } catch (error) {
        console.error(`\u274C Failed to update ${checkName} check to in-progress: ${error}`);
      }
    }
  }
  /**
   * Complete GitHub check runs with results
   */
  async completeGitHubChecksWithResults(reviewSummary, options, prInfo) {
    if (!this.githubCheckService || !this.checkRunMap || !options.githubChecks?.owner || !options.githubChecks.repo) {
      return;
    }
    const issuesByCheck = /* @__PURE__ */ new Map();
    for (const checkName of this.checkRunMap.keys()) {
      issuesByCheck.set(checkName, []);
    }
    for (const issue of reviewSummary.issues || []) {
      if (issue.checkName && issuesByCheck.has(issue.checkName)) {
        issuesByCheck.get(issue.checkName).push(issue);
      }
    }
    console.log(`\u{1F3C1} Completing ${this.checkRunMap.size} GitHub check runs...`);
    for (const [checkName, checkRun] of this.checkRunMap) {
      try {
        const checkIssues = issuesByCheck.get(checkName) || [];
        const failureResults = await this.evaluateFailureConditions(
          checkName,
          { issues: checkIssues },
          options.config
        );
        const execErrorIssue = checkIssues.find((i) => i.ruleId?.startsWith("command/"));
        await this.githubCheckService.completeCheckRun(
          options.githubChecks.owner,
          options.githubChecks.repo,
          checkRun.id,
          checkName,
          failureResults,
          checkIssues,
          execErrorIssue ? execErrorIssue.message : void 0,
          // executionError
          prInfo.files.map((f) => f.filename),
          // filesChangedInCommit
          options.githubChecks.prNumber,
          // prNumber
          options.githubChecks.headSha
          // currentCommitSha
        );
        console.log(`\u2705 Completed ${checkName} check with ${checkIssues.length} issues`);
      } catch (error) {
        console.error(`\u274C Failed to complete ${checkName} check: ${error}`);
        try {
          await this.githubCheckService.completeCheckRun(
            options.githubChecks.owner,
            options.githubChecks.repo,
            checkRun.id,
            checkName,
            [],
            [],
            error instanceof Error ? error.message : "Unknown error occurred"
          );
        } catch (finalError) {
          console.error(`\u274C Failed to mark ${checkName} check as failed: ${finalError}`);
        }
      }
    }
  }
  /**
   * Complete GitHub check runs with error status
   */
  async completeGitHubChecksWithError(errorMessage) {
    if (!this.githubCheckService || !this.checkRunMap || !this.githubContext) {
      return;
    }
    console.log(`\u274C Completing ${this.checkRunMap.size} GitHub check runs with error...`);
    for (const [checkName, checkRun] of this.checkRunMap) {
      try {
        await this.githubCheckService.completeCheckRun(
          this.githubContext.owner,
          this.githubContext.repo,
          checkRun.id,
          checkName,
          [],
          [],
          errorMessage
        );
        console.log(`\u274C Completed ${checkName} check with error: ${errorMessage}`);
      } catch (error) {
        console.error(`\u274C Failed to complete ${checkName} check with error: ${error}`);
      }
    }
  }
  /**
   * Filter checks based on their event triggers to prevent execution of checks
   * that shouldn't run for the current event type
   */
  filterChecksByEvent(checks, config, prInfo, logFn, debug) {
    if (!config?.checks) {
      return checks;
    }
    const prInfoWithEvent = prInfo;
    const hasEventContext = prInfoWithEvent && "eventType" in prInfoWithEvent && prInfoWithEvent.eventType;
    if (hasEventContext) {
      const currentEvent = prInfoWithEvent.eventType;
      if (debug) {
        logFn?.(`\u{1F527} Debug: GitHub Action context, current event: ${currentEvent}`);
      }
      const filteredChecks = [];
      for (const checkName of checks) {
        const checkConfig = config.checks[checkName];
        if (!checkConfig) {
          filteredChecks.push(checkName);
          continue;
        }
        const eventTriggers = checkConfig.on || [];
        if (eventTriggers.length === 0) {
          filteredChecks.push(checkName);
          if (debug) {
            logFn?.(`\u{1F527} Debug: Check '${checkName}' has no event triggers, including`);
          }
        } else if (eventTriggers.includes(currentEvent)) {
          filteredChecks.push(checkName);
          if (debug) {
            logFn?.(`\u{1F527} Debug: Check '${checkName}' matches event '${currentEvent}', including`);
          }
        } else {
          if (debug) {
            logFn?.(
              `\u{1F527} Debug: Check '${checkName}' does not match event '${currentEvent}' (triggers: ${JSON.stringify(eventTriggers)}), skipping`
            );
          }
        }
      }
      return filteredChecks;
    } else {
      if (debug) {
        logFn?.(`\u{1F527} Debug: CLI/Test context, using conservative filtering`);
      }
      const filteredChecks = [];
      for (const checkName of checks) {
        const checkConfig = config.checks[checkName];
        if (!checkConfig) {
          filteredChecks.push(checkName);
          continue;
        }
        const eventTriggers = checkConfig.on || [];
        if (eventTriggers.length === 1 && eventTriggers[0] === "manual") {
          if (debug) {
            logFn?.(`\u{1F527} Debug: Check '${checkName}' is manual-only, skipping`);
          }
        } else {
          filteredChecks.push(checkName);
          if (debug) {
            logFn?.(
              `\u{1F527} Debug: Check '${checkName}' included (triggers: ${JSON.stringify(eventTriggers)})`
            );
          }
        }
      }
      return filteredChecks;
    }
  }
  /**
   * Determine the current event type from PR info
   */
  getCurrentEventType(prInfo) {
    if (!prInfo) {
      return "pr_opened";
    }
    return "pr_updated";
  }
  /**
   * Initialize execution statistics for a check
   */
  initializeCheckStats(checkName) {
    this.executionStats.set(checkName, {
      checkName,
      totalRuns: 0,
      successfulRuns: 0,
      failedRuns: 0,
      skipped: false,
      totalDuration: 0,
      issuesFound: 0,
      issuesBySeverity: {
        critical: 0,
        error: 0,
        warning: 0,
        info: 0
      },
      perIterationDuration: []
    });
  }
  /**
   * Record the start of a check iteration
   * Returns the start timestamp for duration tracking
   */
  recordIterationStart(_checkName) {
    return Date.now();
  }
  /**
   * Record completion of a check iteration
   */
  recordIterationComplete(checkName, startTime, success, issues, output) {
    const stats = this.executionStats.get(checkName);
    if (!stats) return;
    const duration = Date.now() - startTime;
    stats.totalRuns++;
    if (success) {
      stats.successfulRuns++;
    } else {
      stats.failedRuns++;
    }
    stats.totalDuration += duration;
    stats.perIterationDuration.push(duration);
    for (const issue of issues) {
      stats.issuesFound++;
      if (issue.severity === "critical") stats.issuesBySeverity.critical++;
      else if (issue.severity === "error") stats.issuesBySeverity.error++;
      else if (issue.severity === "warning") stats.issuesBySeverity.warning++;
      else if (issue.severity === "info") stats.issuesBySeverity.info++;
    }
    if (output !== void 0) {
      stats.outputsProduced = (stats.outputsProduced || 0) + 1;
    }
  }
  /**
   * Record that a check was skipped
   */
  recordSkip(checkName, reason, condition) {
    const stats = this.executionStats.get(checkName);
    if (!stats) return;
    stats.skipped = true;
    stats.skipReason = reason;
    if (condition) {
      stats.skipCondition = condition;
    }
  }
  /**
   * Record forEach preview items
   */
  recordForEachPreview(checkName, items) {
    const stats = this.executionStats.get(checkName);
    if (!stats) return;
    if (!Array.isArray(items) || items.length === 0) return;
    const preview = items.slice(0, 3).map((item) => {
      let str;
      if (typeof item === "string") {
        str = item;
      } else if (item === void 0 || item === null) {
        str = "(empty)";
      } else {
        try {
          const j = JSON.stringify(item);
          str = typeof j === "string" ? j : String(item);
        } catch {
          str = String(item);
        }
      }
      return str.length > 50 ? str.substring(0, 47) + "..." : str;
    });
    if (items.length > 3) {
      preview.push(`...${items.length - 3} more`);
    }
    stats.forEachPreview = preview;
  }
  /**
   * Record an error for a check
   */
  recordError(checkName, error) {
    const stats = this.executionStats.get(checkName);
    if (!stats) return;
    stats.errorMessage = error instanceof Error ? error.message : String(error);
  }
  /**
   * Build the final execution statistics object
   */
  buildExecutionStatistics() {
    const checks = Array.from(this.executionStats.values());
    const totalExecutions = checks.reduce((sum, s) => sum + s.totalRuns, 0);
    const successfulExecutions = checks.reduce((sum, s) => sum + s.successfulRuns, 0);
    const failedExecutions = checks.reduce((sum, s) => sum + s.failedRuns, 0);
    const skippedChecks = checks.filter((s) => s.skipped).length;
    const totalDuration = checks.reduce((sum, s) => sum + s.totalDuration, 0);
    return {
      totalChecksConfigured: checks.length,
      totalExecutions,
      successfulExecutions,
      failedExecutions,
      skippedChecks,
      totalDuration,
      checks
    };
  }
  // Generic fatality helpers to avoid duplication
  isFatalRule(id, severity) {
    const sev = (severity || "").toLowerCase();
    return sev === "error" || sev === "critical" || id === "command/execution_error" || id.endsWith("/command/execution_error") || id === "command/timeout" || id.endsWith("/command/timeout") || id === "command/transform_js_error" || id.endsWith("/command/transform_js_error") || id === "command/transform_error" || id.endsWith("/command/transform_error") || id.endsWith("/forEach/iteration_error") || id === "forEach/undefined_output" || id.endsWith("/forEach/undefined_output") || id.endsWith("_fail_if") || id.endsWith("/global_fail_if");
  }
  hasFatal(issues) {
    if (!issues || issues.length === 0) return false;
    return issues.some((i) => this.isFatalRule(i.ruleId || "", i.severity));
  }
  async failIfTriggered(checkName, result, config) {
    if (!config) return false;
    const failures = await this.evaluateFailureConditions(checkName, result, config);
    return failures.some((f) => f.failed);
  }
  /**
   * Truncate a string to max length with ellipsis
   */
  truncate(str, maxLen) {
    if (str.length <= maxLen) return str;
    return str.substring(0, maxLen - 3) + "...";
  }
  /**
   * Format the Status column for execution summary table
   */
  formatStatusColumn(stats) {
    if (stats.skipped) {
      if (stats.skipReason === "if_condition") return "\u23ED if";
      if (stats.skipReason === "fail_fast") return "\u23ED ff";
      if (stats.skipReason === "dependency_failed") return "\u23ED dep";
      return "\u23ED";
    }
    if (stats.totalRuns === 0) return "-";
    const symbol = stats.failedRuns === 0 ? "\u2714" : stats.successfulRuns === 0 ? "\u2716" : "\u2714/\u2716";
    if (stats.totalRuns > 1) {
      if (stats.failedRuns > 0 && stats.successfulRuns > 0) {
        return `${symbol} ${stats.successfulRuns}/${stats.totalRuns}`;
      } else {
        return `${symbol} \xD7${stats.totalRuns}`;
      }
    }
    return symbol;
  }
  /**
   * Format the Details column for execution summary table
   */
  formatDetailsColumn(stats) {
    const parts = [];
    if (stats.outputsProduced && stats.outputsProduced > 0) {
      parts.push(`\u2192${stats.outputsProduced}`);
    }
    if (stats.issuesBySeverity.critical > 0) {
      parts.push(`${stats.issuesBySeverity.critical}\u{1F534}`);
    }
    if (stats.issuesBySeverity.warning > 0) {
      parts.push(`${stats.issuesBySeverity.warning}\u26A0\uFE0F`);
    }
    if (stats.issuesBySeverity.info > 0 && stats.issuesBySeverity.critical === 0 && stats.issuesBySeverity.warning === 0) {
      parts.push(`${stats.issuesBySeverity.info}\u{1F4A1}`);
    }
    if (stats.errorMessage) {
      parts.push(this.truncate(stats.errorMessage, 20));
    } else if (stats.skipCondition) {
      parts.push(this.truncate(stats.skipCondition, 20));
    }
    return parts.join(" ");
  }
  /**
   * Log the execution summary table
   */
  logExecutionSummary(stats) {
    const totalIssues = stats.checks.reduce((sum, s) => sum + s.issuesFound, 0);
    const criticalIssues = stats.checks.reduce((sum, s) => sum + s.issuesBySeverity.critical, 0);
    const warningIssues = stats.checks.reduce((sum, s) => sum + s.issuesBySeverity.warning, 0);
    const durationSec = (stats.totalDuration / 1e3).toFixed(1);
    const summaryTable = new (__require("cli-table3"))({
      style: {
        head: [],
        border: []
      },
      colWidths: [41]
    });
    summaryTable.push(
      [`Execution Complete (${durationSec}s)`],
      [`Checks: ${stats.totalChecksConfigured} configured \u2192 ${stats.totalExecutions} executions`],
      [
        `Status: ${stats.successfulExecutions} \u2714 \u2502 ${stats.failedExecutions} \u2716 \u2502 ${stats.skippedChecks} \u23ED`
      ]
    );
    if (totalIssues > 0) {
      let issuesLine = `Issues: ${totalIssues} total`;
      if (criticalIssues > 0) issuesLine += ` (${criticalIssues} \u{1F534}`;
      if (warningIssues > 0) issuesLine += `${criticalIssues > 0 ? " " : " ("}${warningIssues} \u26A0\uFE0F)`;
      else if (criticalIssues > 0) issuesLine += ")";
      summaryTable.push([issuesLine]);
    }
    logger.info("");
    logger.info(summaryTable.toString());
    logger.info("");
    logger.info("Check Details:");
    const detailsTable = new (__require("cli-table3"))({
      head: ["Check", "Duration", "Status", "Details"],
      colWidths: [21, 10, 10, 21],
      style: {
        head: ["cyan"],
        border: ["grey"]
      }
    });
    for (const checkStats of stats.checks) {
      const duration = checkStats.skipped ? "-" : `${(checkStats.totalDuration / 1e3).toFixed(1)}s`;
      const status = this.formatStatusColumn(checkStats);
      const details = this.formatDetailsColumn(checkStats);
      detailsTable.push([checkStats.checkName, duration, status, details]);
    }
    logger.info(detailsTable.toString());
    logger.info("");
    logger.info(
      "Legend: \u2714=success \u2502 \u2716=failed \u2502 \u23ED=skipped \u2502 \xD7N=iterations \u2502 \u2192N=outputs \u2502 N\u{1F534}=critical \u2502 N\u26A0\uFE0F=warnings"
    );
  }
};

export {
  logger,
  init_logger,
  CheckExecutionEngine
};
//# sourceMappingURL=chunk-YFBI3P7Z.mjs.map