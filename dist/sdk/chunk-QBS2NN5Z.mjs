import {
  init_tracer_init,
  initializeTracer
} from "./chunk-OOZITMRU.mjs";
import {
  MemoryStore,
  createExtendedLiquid,
  createPermissionHelpers,
  detectLocalMode,
  init_logger,
  logger,
  logger_exports,
  resolveAssociationFromEvent
} from "./chunk-AN5E5XGX.mjs";
import {
  addEvent,
  addFailIfTriggered,
  context,
  emitNdjsonFallback,
  emitNdjsonSpanWithEvents,
  fallback_ndjson_exports,
  init_fallback_ndjson,
  trace,
  withActiveSpan
} from "./chunk-U7X54EMV.mjs";
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
              const { initializeTracer: initializeTracer2 } = await import("./tracer-init-WP4X46IF.mjs");
              const tracerResult = await initializeTracer2(newSessionId, checkName);
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
          process.exitCode = 0;
        });
        process.on("SIGTERM", () => {
          cleanupAndExit("SIGTERM");
          process.exitCode = 0;
        });
        this.exitHandlerRegistered = true;
      }
    };
  }
});

// src/test-runner/recorders/global-recorder.ts
var global_recorder_exports = {};
__export(global_recorder_exports, {
  getGlobalRecorder: () => getGlobalRecorder,
  setGlobalRecorder: () => setGlobalRecorder
});
function setGlobalRecorder(r) {
  __rec = r;
}
function getGlobalRecorder() {
  return __rec;
}
var __rec;
var init_global_recorder = __esm({
  "src/test-runner/recorders/global-recorder.ts"() {
    "use strict";
    __rec = null;
  }
});

// src/utils/env-exposure.ts
var env_exposure_exports = {};
__export(env_exposure_exports, {
  buildSandboxEnv: () => buildSandboxEnv
});
function buildSandboxEnv(input) {
  const denyDefaults = [
    "GITHUB_TOKEN",
    "INPUT_GITHUB-TOKEN",
    "ACTIONS_RUNTIME_TOKEN",
    "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AZURE_CLIENT_SECRET",
    "GOOGLE_APPLICATION_CREDENTIALS",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "HUGGINGFACE_API_KEY",
    "CLAUDE_CODE_API_KEY",
    "PROBE_API_KEY"
  ];
  const denyExtra = (input.VISOR_DENY_ENV || "").split(",").map((s) => s.trim()).filter(Boolean);
  const deny = Array.from(/* @__PURE__ */ new Set([...denyDefaults, ...denyExtra]));
  const allowSpec = (input.VISOR_ALLOW_ENV || "*").trim();
  const denyMatch = (key) => {
    for (const pat of deny) {
      if (!pat) continue;
      if (pat.endsWith("*")) {
        const prefix = pat.slice(0, -1);
        if (key.startsWith(prefix)) return true;
      } else if (key === pat) {
        return true;
      }
    }
    if (/(_TOKEN|_SECRET|_PASSWORD|_PRIVATE_KEY)$/i.test(key)) return true;
    return false;
  };
  const out = {};
  if (allowSpec !== "*") {
    const allow = allowSpec.split(",").map((s) => s.trim()).filter(Boolean);
    for (const key of allow) {
      const val = input[key];
      if (key && val !== void 0 && !denyMatch(key)) out[key] = String(val);
    }
    return out;
  }
  for (const [k, v] of Object.entries(input)) {
    if (v === void 0 || v === null) continue;
    if (denyMatch(k)) continue;
    out[k] = String(v);
  }
  return out;
}
var init_env_exposure = __esm({
  "src/utils/env-exposure.ts"() {
    "use strict";
  }
});

// src/github-comments.ts
init_logger();
import { v4 as uuidv4 } from "uuid";

// src/footer.ts
function generateFooter(options = {}) {
  const { includeMetadata, includeSeparator = true } = options;
  const parts = [];
  if (includeSeparator) {
    parts.push("---");
    parts.push("");
  }
  parts.push(
    "*Powered by [Visor](https://probelabs.com/visor) from [Probelabs](https://probelabs.com)*"
  );
  if (includeMetadata) {
    const { lastUpdated, triggeredBy, commitSha } = includeMetadata;
    const commitInfo = commitSha ? ` | Commit: ${commitSha.substring(0, 7)}` : "";
    parts.push("");
    parts.push(`*Last updated: ${lastUpdated} | Triggered by: ${triggeredBy}${commitInfo}*`);
  }
  parts.push("");
  parts.push("\u{1F4A1} **TIP:** You can chat with Visor using `/visor ask <your question>`");
  return parts.join("\n");
}

// src/github-comments.ts
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
        logger.info(
          `\u2705 Successfully updated comment (ID: ${commentId}, GitHub ID: ${existingComment.id}) on PR #${prNumber} in ${owner}/${repo}`
        );
        return updatedComment.data;
      } else {
        const newComment = await this.octokit.rest.issues.createComment({
          owner,
          repo,
          issue_number: prNumber,
          body: formattedContent
        });
        logger.info(
          `\u2705 Successfully created comment (ID: ${commentId}, GitHub ID: ${newComment.data.id}) on PR #${prNumber} in ${owner}/${repo}`
        );
        return newComment.data;
      }
    });
  }
  /**
   * Format comment content with metadata markers
   */
  formatCommentWithMetadata(content, metadata) {
    const { commentId, lastUpdated, triggeredBy, commitSha } = metadata;
    const footer = generateFooter({
      includeMetadata: {
        lastUpdated,
        triggeredBy,
        commitSha
      }
    });
    return `<!-- visor-comment-id:${commentId} -->
${content}

${footer}
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
          const computed = this.retryConfig.baseDelay * Math.pow(this.retryConfig.backoffFactor, attempt);
          const delay = computed > this.retryConfig.maxDelay ? Math.max(0, this.retryConfig.maxDelay - 1) : computed;
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
    return new Promise((resolve4) => {
      const t = setTimeout(resolve4, ms);
      if (typeof t.unref === "function") {
        try {
          t.unref();
        } catch {
        }
      }
    });
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
init_tracer_init();
import { ProbeAgent } from "@probelabs/probe";

// src/utils/diff-processor.ts
import { extract } from "@probelabs/probe";
import * as path from "path";
async function processDiffWithOutline(diffContent) {
  if (!diffContent || diffContent.trim().length === 0) {
    return diffContent;
  }
  try {
    const originalProbePath = process.env.PROBE_PATH;
    const fs7 = __require("fs");
    const possiblePaths = [
      // Relative to current working directory (most common in production)
      path.join(process.cwd(), "node_modules/@probelabs/probe/bin/probe-binary"),
      // Relative to __dirname (for unbundled development)
      path.join(__dirname, "../..", "node_modules/@probelabs/probe/bin/probe-binary"),
      // Relative to dist directory (for bundled CLI)
      path.join(__dirname, "node_modules/@probelabs/probe/bin/probe-binary")
    ];
    let probeBinaryPath;
    for (const candidatePath of possiblePaths) {
      if (fs7.existsSync(candidatePath)) {
        probeBinaryPath = candidatePath;
        break;
      }
    }
    if (!probeBinaryPath) {
      if (process.env.DEBUG === "1" || process.env.VERBOSE === "1") {
        console.error("Probe binary not found. Tried:", possiblePaths);
      }
      return diffContent;
    }
    process.env.PROBE_PATH = probeBinaryPath;
    const extractPromise = extract({
      content: diffContent,
      format: "outline-diff",
      allowTests: true
      // Allow test files and test code blocks in extraction results
    });
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error("Extract timeout after 30s")), 3e4);
    });
    const result = await Promise.race([extractPromise, timeoutPromise]);
    if (originalProbePath !== void 0) {
      process.env.PROBE_PATH = originalProbePath;
    } else {
      delete process.env.PROBE_PATH;
    }
    return typeof result === "string" ? result : JSON.stringify(result);
  } catch (error) {
    if (process.env.DEBUG === "1" || process.env.VERBOSE === "1") {
      console.error("Failed to process diff with outline-diff format:", error);
    }
    return diffContent;
  }
}

// src/ai-review-service.ts
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
    const providerExplicit = typeof this.config.provider === "string" && this.config.provider.length > 0;
    if (!providerExplicit) {
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
    }
    if (!this.config.model && process.env.MODEL_NAME) {
      this.config.model = process.env.MODEL_NAME;
    }
  }
  // NOTE: per request, no additional redaction/encryption helpers are used.
  /**
   * Execute AI review using probe agent
   */
  async executeReview(prInfo, customPrompt, schema, checkName, sessionId) {
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
        try {
          if (this.config.provider === "google" && process.env.GOOGLE_API_KEY) {
            this.config.apiKey = process.env.GOOGLE_API_KEY;
          } else if (this.config.provider === "anthropic" && process.env.ANTHROPIC_API_KEY) {
            this.config.apiKey = process.env.ANTHROPIC_API_KEY;
          } else if (this.config.provider === "openai" && process.env.OPENAI_API_KEY) {
            this.config.apiKey = process.env.OPENAI_API_KEY;
          } else if (this.config.provider === "claude-code" && process.env.CLAUDE_CODE_API_KEY) {
            this.config.apiKey = process.env.CLAUDE_CODE_API_KEY;
          }
        } catch {
        }
      }
      if (!this.config.apiKey) {
        const errorMessage = "No API key configured. Please set GOOGLE_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY environment variable, or configure AWS credentials for Bedrock (AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY).";
        if (debugInfo) {
          debugInfo.errors = [errorMessage];
          debugInfo.rawResponse = "API call attempted in debug without API key (test mode)";
        } else {
          throw new Error(errorMessage);
        }
      }
    }
    try {
      const call = this.callProbeAgent(prompt, schema, debugInfo, checkName, sessionId);
      const timeoutMs = Math.max(0, this.config.timeout || 0);
      const { response, effectiveSchema } = timeoutMs > 0 ? await this.withTimeout(call, timeoutMs, "AI review") : await call;
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
    if (!this.config.apiKey) {
      try {
        if (this.config.provider === "google" && process.env.GOOGLE_API_KEY) {
          this.config.apiKey = process.env.GOOGLE_API_KEY;
        } else if (this.config.provider === "anthropic" && process.env.ANTHROPIC_API_KEY) {
          this.config.apiKey = process.env.ANTHROPIC_API_KEY;
        } else if (this.config.provider === "openai" && process.env.OPENAI_API_KEY) {
          this.config.apiKey = process.env.OPENAI_API_KEY;
        } else if (this.config.provider === "claude-code" && process.env.CLAUDE_CODE_API_KEY) {
          this.config.apiKey = process.env.CLAUDE_CODE_API_KEY;
        }
      } catch {
      }
    }
    const existingAgent = this.sessionRegistry.getSession(parentSessionId);
    if (!existingAgent) {
      throw new Error(
        `Session not found for reuse: ${parentSessionId}. Ensure the parent check completed successfully.`
      );
    }
    const prompt = await this.buildCustomPrompt(prInfo, customPrompt, schema, {
      skipPRContext: true
    });
    let agentToUse;
    let currentSessionId;
    if (sessionMode === "clone") {
      currentSessionId = `${checkName}-session-${Date.now()}`;
      log(
        `\u{1F4CB} Cloning AI session ${parentSessionId} \u2192 ${currentSessionId} for ${checkName} check...`
      );
      const clonedAgent = await this.sessionRegistry.cloneSession(
        parentSessionId,
        currentSessionId,
        checkName
        // Pass checkName for tracing
      );
      if (!clonedAgent) {
        throw new Error(`Failed to clone session ${parentSessionId}`);
      }
      agentToUse = clonedAgent;
    } else {
      log(`\u{1F504} Appending to AI session ${parentSessionId} (shared history)...`);
      agentToUse = existingAgent;
      currentSessionId = parentSessionId;
    }
    log(`\u{1F527} Debug: Raw schema parameter: ${JSON.stringify(schema)} (type: ${typeof schema})`);
    log(`\u{1F4CB} Schema for this check: ${schema || "none (no schema)"}`);
    if (sessionMode === "clone") {
      log(`\u2705 Cloned agent will use NEW schema (${schema}) - parent schema does not persist`);
      log(`\u{1F504} Clone operation ensures fresh agent with copied history but new configuration`);
    } else {
      log(`\u{1F504} Append mode - using existing agent instance with shared history and configuration`);
    }
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
      const call = this.callProbeAgentWithExistingSession(
        agentToUse,
        prompt,
        schema,
        debugInfo,
        checkName
      );
      const timeoutMs = Math.max(0, this.config.timeout || 0);
      const { response, effectiveSchema } = timeoutMs > 0 ? await this.withTimeout(call, timeoutMs, "AI review (session)") : await call;
      const processingTime = Date.now() - startTime;
      if (debugInfo) {
        debugInfo.rawResponse = response;
        debugInfo.responseLength = response.length;
        debugInfo.processingTime = processingTime;
      }
      const result = this.parseAIResponse(response, debugInfo, effectiveSchema);
      try {
        result.sessionId = currentSessionId;
      } catch {
      }
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
   * Promise timeout helper that rejects after ms if unresolved
   */
  async withTimeout(p, ms, label = "operation") {
    let timer;
    try {
      const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      });
      return await Promise.race([p, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
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
  async buildCustomPrompt(prInfo, customInstructions, schema, options) {
    const skipPRContext = options?.skipPRContext === true;
    const isCodeReviewSchema = schema === "code-review";
    const prContext = skipPRContext ? "" : await this.formatPRContext(prInfo, isCodeReviewSchema);
    const isIssue = prInfo.isIssue === true;
    if (isIssue) {
      if (skipPRContext) {
        return `<instructions>
${customInstructions}
</instructions>`;
      }
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
      if (skipPRContext) {
        return `<instructions>
${customInstructions}
</instructions>

<reminder>
  <rule>The code context and diff were provided in the previous message</rule>
  <rule>Focus on the new analysis instructions above</rule>
  <rule>Only analyze code that appears with + (additions) or - (deletions) in the diff sections</rule>
  <rule>STRICT OUTPUT POLICY: Report only actual problems, risks, or deficiencies</rule>
  <rule>SEVERITY ASSIGNMENT: Assign severity ONLY to problems introduced or left unresolved by this change</rule>
</reminder>`;
      }
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
    if (skipPRContext) {
      return `<instructions>
${customInstructions}
</instructions>`;
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
  async formatPRContext(prInfo, isCodeReviewSchema) {
    const prContextInfo = prInfo;
    const isIssue = prContextInfo.isIssue === true;
    const isPRContext = prContextInfo.isPRContext === true;
    const includeCodeContext = isPRContext || prContextInfo.includeCodeContext !== false;
    if (isPRContext) {
      log("\u{1F50D} Including full code diffs in AI context (PR mode)");
    } else if (!includeCodeContext) {
      log("\u{1F4CA} Including only file summary in AI context (no diffs)");
    } else {
      log("\u{1F50D} Including code diffs in AI context");
    }
    if (isIssue) {
      let context3 = `<issue>
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
        context3 += `
  <!-- Full issue description and body text provided by the issue author -->
  <description>
${this.escapeXml(prInfo.body)}
  </description>`;
      }
      const eventContext = prInfo;
      const labels = eventContext.eventContext?.issue?.labels;
      if (labels && labels.length > 0) {
        context3 += `
  <!-- Applied labels for issue categorization and organization -->
  <labels>`;
        labels.forEach((label) => {
          const labelName = typeof label === "string" ? label : label.name || "unknown";
          context3 += `
    <label>${this.escapeXml(labelName)}</label>`;
        });
        context3 += `
  </labels>`;
      }
      const assignees = prInfo.eventContext?.issue?.assignees;
      if (assignees && assignees.length > 0) {
        context3 += `
  <!-- Users assigned to work on this issue -->
  <assignees>`;
        assignees.forEach((assignee) => {
          const assigneeName = typeof assignee === "string" ? assignee : assignee.login || "unknown";
          context3 += `
    <assignee>${this.escapeXml(assigneeName)}</assignee>`;
        });
        context3 += `
  </assignees>`;
      }
      const milestone = prInfo.eventContext?.issue?.milestone;
      if (milestone) {
        context3 += `
  <!-- Associated project milestone information -->
  <milestone>
    <title>${this.escapeXml(milestone.title || "")}</title>
    <state>${milestone.state || "open"}</state>
    <due_on>${milestone.due_on || ""}</due_on>
  </milestone>`;
      }
      const triggeringComment2 = prInfo.eventContext?.comment;
      if (triggeringComment2) {
        context3 += `
  <!-- The comment that triggered this analysis -->
  <triggering_comment>
    <author>${this.escapeXml(triggeringComment2.user?.login || "unknown")}</author>
    <created_at>${triggeringComment2.created_at || ""}</created_at>
    <body>${this.escapeXml(triggeringComment2.body || "")}</body>
  </triggering_comment>`;
      }
      const issueComments = prInfo.comments;
      if (issueComments && issueComments.length > 0) {
        let historicalComments = triggeringComment2 ? issueComments.filter((c) => c.id !== triggeringComment2.id) : issueComments;
        if (isCodeReviewSchema) {
          historicalComments = historicalComments.filter(
            (c) => !c.body || !c.body.includes("visor-comment-id:pr-review-")
          );
        }
        if (historicalComments.length > 0) {
          context3 += `
  <!-- Previous comments in chronological order (excluding triggering comment) -->
  <comment_history>`;
          historicalComments.forEach((comment) => {
            context3 += `
    <comment>
      <author>${this.escapeXml(comment.author || "unknown")}</author>
      <created_at>${comment.createdAt || ""}</created_at>
      <body>${this.escapeXml(comment.body || "")}</body>
    </comment>`;
          });
          context3 += `
  </comment_history>`;
        }
      }
      context3 += `
</issue>`;
      return context3;
    }
    let context2 = `<pull_request>
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
    try {
      const firstFile = (prInfo.files || [])[0];
      if (firstFile && firstFile.filename) {
        context2 += `
  <raw_diff_header>
${this.escapeXml(`diff --git a/${firstFile.filename} b/${firstFile.filename}`)}
  </raw_diff_header>`;
      }
    } catch {
    }
    if (prInfo.body) {
      context2 += `
  <!-- Full pull request description provided by the author -->
  <description>
${this.escapeXml(prInfo.body)}
  </description>`;
    }
    if (includeCodeContext) {
      if (prInfo.fullDiff) {
        const processedFullDiff = await processDiffWithOutline(prInfo.fullDiff);
        context2 += `
  <!-- Complete unified diff showing all changes in the pull request (processed with outline-diff) -->
  <full_diff>
${this.escapeXml(processedFullDiff)}
  </full_diff>`;
      }
      if (prInfo.isIncremental) {
        if (prInfo.commitDiff && prInfo.commitDiff.length > 0) {
          const processedCommitDiff = await processDiffWithOutline(prInfo.commitDiff);
          context2 += `
  <!-- Diff of only the latest commit for incremental analysis (processed with outline-diff) -->
  <commit_diff>
${this.escapeXml(processedCommitDiff)}
  </commit_diff>`;
        } else {
          const processedFallbackDiff = prInfo.fullDiff ? await processDiffWithOutline(prInfo.fullDiff) : "";
          context2 += `
  <!-- Commit diff could not be retrieved - falling back to full diff analysis (processed with outline-diff) -->
  <commit_diff>
${this.escapeXml(processedFallbackDiff)}
  </commit_diff>`;
        }
      }
    } else {
      context2 += `
  <!-- Code diffs excluded to reduce token usage (no code-review schema detected or disabled by flag) -->`;
    }
    if (prInfo.files.length > 0) {
      context2 += `
  <!-- Summary of all files changed with statistics -->
  <files_summary>`;
      prInfo.files.forEach((file) => {
        context2 += `
    <file>
      <filename>${this.escapeXml(file.filename)}</filename>
      <status>${file.status}</status>
      <additions>${file.additions}</additions>
      <deletions>${file.deletions}</deletions>
    </file>`;
      });
      context2 += `
  </files_summary>`;
    }
    const triggeringComment = prInfo.eventContext?.comment;
    if (triggeringComment) {
      context2 += `
  <!-- The comment that triggered this analysis -->
  <triggering_comment>
    <author>${this.escapeXml(triggeringComment.user?.login || "unknown")}</author>
    <created_at>${triggeringComment.created_at || ""}</created_at>
    <body>${this.escapeXml(triggeringComment.body || "")}</body>
  </triggering_comment>`;
    }
    const prComments = prInfo.comments;
    if (prComments && prComments.length > 0) {
      let historicalComments = triggeringComment ? prComments.filter((c) => c.id !== triggeringComment.id) : prComments;
      if (isCodeReviewSchema) {
        historicalComments = historicalComments.filter(
          (c) => !c.body || !c.body.includes("visor-comment-id:pr-review-")
        );
      }
      if (historicalComments.length > 0) {
        context2 += `
  <!-- Previous PR comments in chronological order (excluding triggering comment) -->
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
</pull_request>`;
    return context2;
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
      const response = await this.generateMockResponse(prompt, _checkName, schema);
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
      if (process.env.VISOR_DEBUG_AI_SESSIONS === "true") {
        try {
          const fs7 = __require("fs");
          const path9 = __require("path");
          const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
          const provider = this.config.provider || "auto";
          const model = this.config.model || "default";
          let conversationHistory = [];
          try {
            const agentAny2 = agent;
            if (agentAny2.history) {
              conversationHistory = agentAny2.history;
            } else if (agentAny2.messages) {
              conversationHistory = agentAny2.messages;
            } else if (agentAny2._messages) {
              conversationHistory = agentAny2._messages;
            }
          } catch {
          }
          const debugData = {
            timestamp,
            checkName: _checkName || "unknown",
            provider,
            model,
            schema: effectiveSchema,
            schemaOptions: schemaOptions || "none",
            sessionInfo: {
              isSessionReuse: true,
              historyMessageCount: conversationHistory.length
            },
            currentPromptLength: prompt.length,
            currentPrompt: prompt,
            conversationHistory
          };
          const debugJson = JSON.stringify(debugData, null, 2);
          let readableVersion = `=============================================================
`;
          readableVersion += `VISOR DEBUG REPORT - SESSION REUSE
`;
          readableVersion += `=============================================================
`;
          readableVersion += `Timestamp: ${timestamp}
`;
          readableVersion += `Check Name: ${_checkName || "unknown"}
`;
          readableVersion += `Provider: ${provider}
`;
          readableVersion += `Model: ${model}
`;
          readableVersion += `Schema: ${effectiveSchema}
`;
          readableVersion += `Schema Options: ${schemaOptions ? "provided" : "none"}
`;
          readableVersion += `History Messages: ${conversationHistory.length}
`;
          readableVersion += `=============================================================

`;
          if (schemaOptions) {
            readableVersion += `
${"=".repeat(60)}
`;
            readableVersion += `SCHEMA CONFIGURATION
`;
            readableVersion += `${"=".repeat(60)}
`;
            readableVersion += JSON.stringify(schemaOptions, null, 2);
            readableVersion += `
`;
          }
          if (conversationHistory.length > 0) {
            readableVersion += `
${"=".repeat(60)}
`;
            readableVersion += `CONVERSATION HISTORY (${conversationHistory.length} messages)
`;
            readableVersion += `${"=".repeat(60)}
`;
            conversationHistory.forEach((msg, index) => {
              readableVersion += `
${"-".repeat(60)}
`;
              readableVersion += `MESSAGE #${index + 1}
`;
              readableVersion += `Role: ${msg.role || "unknown"}
`;
              if (msg.content) {
                const contentStr = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content, null, 2);
                readableVersion += `Length: ${contentStr.length} characters
`;
                readableVersion += `${"-".repeat(60)}
`;
                readableVersion += `${contentStr}
`;
              }
            });
          }
          readableVersion += `
${"=".repeat(60)}
`;
          readableVersion += `CURRENT PROMPT (NEW MESSAGE)
`;
          readableVersion += `${"=".repeat(60)}
`;
          readableVersion += `Length: ${prompt.length} characters
`;
          readableVersion += `${"-".repeat(60)}
`;
          readableVersion += `${prompt}
`;
          readableVersion += `
${"=".repeat(60)}
`;
          readableVersion += `END OF DEBUG REPORT
`;
          readableVersion += `${"=".repeat(60)}
`;
          const debugArtifactsDir = process.env.VISOR_DEBUG_ARTIFACTS || path9.join(process.cwd(), "debug-artifacts");
          if (!fs7.existsSync(debugArtifactsDir)) {
            fs7.mkdirSync(debugArtifactsDir, { recursive: true });
          }
          const debugFile = path9.join(
            debugArtifactsDir,
            `prompt-${_checkName || "unknown"}-${timestamp}.json`
          );
          fs7.writeFileSync(debugFile, debugJson, "utf-8");
          const readableFile = path9.join(
            debugArtifactsDir,
            `prompt-${_checkName || "unknown"}-${timestamp}.txt`
          );
          fs7.writeFileSync(readableFile, readableVersion, "utf-8");
          log(`
\u{1F4BE} Full debug info saved to:`);
          log(`   JSON: ${debugFile}`);
          log(`   TXT:  ${readableFile}`);
          log(`   - Includes: full conversation history, schema, current prompt`);
        } catch (error) {
          log(`\u26A0\uFE0F Could not save debug file: ${error}`);
        }
      }
      const agentAny = agent;
      let response;
      if (agentAny.tracer && typeof agentAny.tracer.withSpan === "function") {
        response = await agentAny.tracer.withSpan(
          "visor.ai_check_reuse",
          async () => {
            return await agent.answer(prompt, void 0, schemaOptions);
          },
          {
            "check.name": _checkName || "unknown",
            "check.mode": "session_reuse",
            "prompt.length": prompt.length,
            "schema.type": effectiveSchema || "none"
          }
        );
      } else {
        response = schemaOptions ? await agent.answer(prompt, void 0, schemaOptions) : await agent.answer(prompt);
      }
      log("\u2705 ProbeAgent session reuse completed successfully");
      log(`\u{1F4E4} Response length: ${response.length} characters`);
      if (process.env.VISOR_DEBUG_AI_SESSIONS === "true") {
        try {
          const fs7 = __require("fs");
          const path9 = __require("path");
          const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
          const agentAny2 = agent;
          let fullHistory = [];
          if (agentAny2.history) {
            fullHistory = agentAny2.history;
          } else if (agentAny2.messages) {
            fullHistory = agentAny2.messages;
          } else if (agentAny2._messages) {
            fullHistory = agentAny2._messages;
          }
          const debugArtifactsDir = process.env.VISOR_DEBUG_ARTIFACTS || path9.join(process.cwd(), "debug-artifacts");
          const sessionBase = path9.join(
            debugArtifactsDir,
            `session-${_checkName || "unknown"}-${timestamp}`
          );
          const sessionData = {
            timestamp,
            checkName: _checkName || "unknown",
            provider: this.config.provider || "auto",
            model: this.config.model || "default",
            schema: effectiveSchema,
            totalMessages: fullHistory.length
          };
          fs7.writeFileSync(sessionBase + ".json", JSON.stringify(sessionData, null, 2), "utf-8");
          let readable = `=============================================================
`;
          readable += `COMPLETE AI SESSION HISTORY (AFTER RESPONSE)
`;
          readable += `=============================================================
`;
          readable += `Timestamp: ${timestamp}
`;
          readable += `Check: ${_checkName || "unknown"}
`;
          readable += `Total Messages: ${fullHistory.length}
`;
          readable += `=============================================================

`;
          fullHistory.forEach((msg, idx) => {
            const role = msg.role || "unknown";
            const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content, null, 2);
            readable += `
${"=".repeat(60)}
MESSAGE ${idx + 1}/${fullHistory.length}
Role: ${role}
${"=".repeat(60)}
`;
            readable += content + "\n";
          });
          fs7.writeFileSync(sessionBase + ".summary.txt", readable, "utf-8");
          log(`\u{1F4BE} Complete session history saved:`);
          log(`   - Contains ALL ${fullHistory.length} messages (prompts + responses)`);
        } catch (error) {
          log(`\u26A0\uFE0F Could not save complete session history: ${error}`);
        }
      }
      if (process.env.VISOR_DEBUG_AI_SESSIONS === "true") {
        try {
          const fs7 = __require("fs");
          const path9 = __require("path");
          const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
          const debugArtifactsDir = process.env.VISOR_DEBUG_ARTIFACTS || path9.join(process.cwd(), "debug-artifacts");
          const responseFile = path9.join(
            debugArtifactsDir,
            `response-${_checkName || "unknown"}-${timestamp}.txt`
          );
          let responseContent = `=============================================================
`;
          responseContent += `VISOR AI RESPONSE - SESSION REUSE
`;
          responseContent += `=============================================================
`;
          responseContent += `Timestamp: ${timestamp}
`;
          responseContent += `Check Name: ${_checkName || "unknown"}
`;
          responseContent += `Response Length: ${response.length} characters
`;
          responseContent += `=============================================================

`;
          responseContent += `${"=".repeat(60)}
`;
          responseContent += `AI RESPONSE
`;
          responseContent += `${"=".repeat(60)}
`;
          responseContent += response;
          responseContent += `
${"=".repeat(60)}
`;
          responseContent += `END OF RESPONSE
`;
          responseContent += `${"=".repeat(60)}
`;
          fs7.writeFileSync(responseFile, responseContent, "utf-8");
          log(`\u{1F4BE} Response saved to: ${responseFile}`);
        } catch (error) {
          log(`\u26A0\uFE0F Could not save response file: ${error}`);
        }
      }
      if (agentAny._traceFilePath && agentAny._telemetryConfig) {
        try {
          if (agentAny.tracer && typeof agentAny.tracer.flush === "function") {
            await agentAny.tracer.flush();
            log(`\u{1F504} Flushed tracer spans for cloned session`);
          }
          if (agentAny._telemetryConfig && typeof agentAny._telemetryConfig.shutdown === "function") {
            await agentAny._telemetryConfig.shutdown();
            log(`\u{1F4CA} OpenTelemetry trace saved to: ${agentAny._traceFilePath}`);
            if (process.env.GITHUB_ACTIONS) {
              const fs7 = __require("fs");
              if (fs7.existsSync(agentAny._traceFilePath)) {
                const stats = fs7.statSync(agentAny._traceFilePath);
                console.log(
                  `::notice title=AI Trace Saved::${agentAny._traceFilePath} (${stats.size} bytes)`
                );
              }
            }
          } else if (agentAny.tracer && typeof agentAny.tracer.shutdown === "function") {
            await agentAny.tracer.shutdown();
            log(`\u{1F4CA} Trace saved to: ${agentAny._traceFilePath}`);
          }
        } catch (exportError) {
          logger.warn(`\u26A0\uFE0F  Warning: Failed to export trace for cloned session: ${exportError}`);
        }
      }
      return { response, effectiveSchema };
    } catch (error) {
      logger.error(
        `\u274C ProbeAgent session reuse failed: ${error instanceof Error ? error.message : "Unknown error"}`
      );
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
      const inJest = !!process.env.JEST_WORKER_ID;
      log("\u{1F3AD} Using mock AI model/provider");
      if (!inJest) {
        const response = await this.generateMockResponse(prompt, _checkName, schema);
        return { response, effectiveSchema: typeof schema === "object" ? "custom" : schema };
      }
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
      let traceFilePath = "";
      let telemetryConfig = null;
      if (this.config.debug) {
        const tracerResult = await initializeTracer(sessionId, _checkName);
        if (tracerResult) {
          options.tracer = tracerResult.tracer;
          telemetryConfig = tracerResult.telemetryConfig;
          traceFilePath = tracerResult.filePath;
        }
      }
      if (this.config.mcpServers && Object.keys(this.config.mcpServers).length > 0) {
        options.enableMcp = true;
        options.mcpConfig = { mcpServers: this.config.mcpServers };
      }
      if (this.config.enableDelegate !== void 0) {
        options.enableDelegate = this.config.enableDelegate;
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
      if (process.env.VISOR_DEBUG_AI_SESSIONS === "true") {
        try {
          const fs7 = __require("fs");
          const path9 = __require("path");
          const os = __require("os");
          const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
          const debugData = {
            timestamp,
            checkName: _checkName || "unknown",
            provider,
            model,
            schema: effectiveSchema,
            schemaOptions: schemaOptions || "none",
            sessionInfo: {
              isSessionReuse: false,
              isNewSession: true
            },
            promptLength: prompt.length,
            prompt
          };
          const debugJson = JSON.stringify(debugData, null, 2);
          let readableVersion = `=============================================================
`;
          readableVersion += `VISOR DEBUG REPORT - NEW SESSION
`;
          readableVersion += `=============================================================
`;
          readableVersion += `Timestamp: ${timestamp}
`;
          readableVersion += `Check Name: ${_checkName || "unknown"}
`;
          readableVersion += `Provider: ${provider}
`;
          readableVersion += `Model: ${model}
`;
          readableVersion += `Schema: ${effectiveSchema}
`;
          readableVersion += `Schema Options: ${schemaOptions ? "provided" : "none"}
`;
          readableVersion += `Session Type: New Session (no history)
`;
          readableVersion += `=============================================================

`;
          if (schemaOptions) {
            readableVersion += `
${"=".repeat(60)}
`;
            readableVersion += `SCHEMA CONFIGURATION
`;
            readableVersion += `${"=".repeat(60)}
`;
            readableVersion += JSON.stringify(schemaOptions, null, 2);
            readableVersion += `
`;
          }
          readableVersion += `
${"=".repeat(60)}
`;
          readableVersion += `PROMPT
`;
          readableVersion += `${"=".repeat(60)}
`;
          readableVersion += `Length: ${prompt.length} characters
`;
          readableVersion += `${"-".repeat(60)}
`;
          readableVersion += `${prompt}
`;
          readableVersion += `
${"=".repeat(60)}
`;
          readableVersion += `END OF DEBUG REPORT
`;
          readableVersion += `${"=".repeat(60)}
`;
          const tempDir = os.tmpdir();
          const promptFile = path9.join(tempDir, `visor-prompt-${timestamp}.txt`);
          fs7.writeFileSync(promptFile, prompt, "utf-8");
          log(`
\u{1F4BE} Prompt saved to: ${promptFile}`);
          const debugArtifactsDir = process.env.VISOR_DEBUG_ARTIFACTS || path9.join(process.cwd(), "debug-artifacts");
          try {
            const base = path9.join(
              debugArtifactsDir,
              `prompt-${_checkName || "unknown"}-${timestamp}`
            );
            fs7.writeFileSync(base + ".json", debugJson, "utf-8");
            fs7.writeFileSync(base + ".summary.txt", readableVersion, "utf-8");
            log(`
\u{1F4BE} Full debug info saved to directory: ${debugArtifactsDir}`);
          } catch {
          }
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
      }
      let response;
      const tracer = options.tracer;
      if (tracer && typeof tracer.withSpan === "function") {
        response = await tracer.withSpan(
          "visor.ai_check",
          async () => {
            return await agent.answer(prompt, void 0, schemaOptions);
          },
          {
            "check.name": _checkName || "unknown",
            "check.session_id": sessionId,
            "prompt.length": prompt.length,
            "schema.type": effectiveSchema || "none"
          }
        );
      } else {
        response = schemaOptions ? await agent.answer(prompt, void 0, schemaOptions) : await agent.answer(prompt);
      }
      log("\u2705 ProbeAgent completed successfully");
      log(`\u{1F4E4} Response length: ${response.length} characters`);
      if (process.env.VISOR_DEBUG_AI_SESSIONS === "true") {
        try {
          const fs7 = __require("fs");
          const path9 = __require("path");
          const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
          const agentAny = agent;
          let fullHistory = [];
          if (agentAny.history) {
            fullHistory = agentAny.history;
          } else if (agentAny.messages) {
            fullHistory = agentAny.messages;
          } else if (agentAny._messages) {
            fullHistory = agentAny._messages;
          }
          const debugArtifactsDir = process.env.VISOR_DEBUG_ARTIFACTS || path9.join(process.cwd(), "debug-artifacts");
          const sessionBase = path9.join(
            debugArtifactsDir,
            `session-${_checkName || "unknown"}-${timestamp}`
          );
          const sessionData = {
            timestamp,
            checkName: _checkName || "unknown",
            provider: this.config.provider || "auto",
            model: this.config.model || "default",
            schema: effectiveSchema,
            totalMessages: fullHistory.length
          };
          fs7.writeFileSync(sessionBase + ".json", JSON.stringify(sessionData, null, 2), "utf-8");
          let readable = `=============================================================
`;
          readable += `COMPLETE AI SESSION HISTORY (AFTER RESPONSE)
`;
          readable += `=============================================================
`;
          readable += `Timestamp: ${timestamp}
`;
          readable += `Check: ${_checkName || "unknown"}
`;
          readable += `Total Messages: ${fullHistory.length}
`;
          readable += `=============================================================

`;
          fullHistory.forEach((msg, idx) => {
            const role = msg.role || "unknown";
            const content = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content, null, 2);
            readable += `
${"=".repeat(60)}
MESSAGE ${idx + 1}/${fullHistory.length}
Role: ${role}
${"=".repeat(60)}
`;
            readable += content + "\n";
          });
          fs7.writeFileSync(sessionBase + ".summary.txt", readable, "utf-8");
          log(`\u{1F4BE} Complete session history saved:`);
          log(`   - Contains ALL ${fullHistory.length} messages (prompts + responses)`);
        } catch (error) {
          log(`\u26A0\uFE0F Could not save complete session history: ${error}`);
        }
      }
      if (process.env.VISOR_DEBUG_AI_SESSIONS === "true") {
        try {
          const fs7 = __require("fs");
          const path9 = __require("path");
          const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
          const debugArtifactsDir = process.env.VISOR_DEBUG_ARTIFACTS || path9.join(process.cwd(), "debug-artifacts");
          const responseFile = path9.join(
            debugArtifactsDir,
            `response-${_checkName || "unknown"}-${timestamp}.txt`
          );
          let responseContent = `=============================================================
`;
          responseContent += `VISOR AI RESPONSE - NEW SESSION
`;
          responseContent += `=============================================================
`;
          responseContent += `Timestamp: ${timestamp}
`;
          responseContent += `Check Name: ${_checkName || "unknown"}
`;
          responseContent += `Response Length: ${response.length} characters
`;
          responseContent += `=============================================================

`;
          responseContent += `${"=".repeat(60)}
`;
          responseContent += `AI RESPONSE
`;
          responseContent += `${"=".repeat(60)}
`;
          responseContent += response;
          responseContent += `
${"=".repeat(60)}
`;
          responseContent += `END OF RESPONSE
`;
          responseContent += `${"=".repeat(60)}
`;
          fs7.writeFileSync(responseFile, responseContent, "utf-8");
          log(`\u{1F4BE} Response saved to: ${responseFile}`);
        } catch (error) {
          log(`\u26A0\uFE0F Could not save response file: ${error}`);
        }
      }
      if (traceFilePath && telemetryConfig) {
        try {
          const telemetry = telemetryConfig;
          const tracerWithMethods = tracer;
          if (tracerWithMethods && typeof tracerWithMethods.flush === "function") {
            await tracerWithMethods.flush();
            log(`\u{1F504} Flushed tracer spans`);
          }
          if (telemetry && typeof telemetry.shutdown === "function") {
            await telemetry.shutdown();
            log(`\u{1F4CA} OpenTelemetry trace saved to: ${traceFilePath}`);
            if (process.env.GITHUB_ACTIONS) {
              const fs7 = __require("fs");
              if (fs7.existsSync(traceFilePath)) {
                const stats = fs7.statSync(traceFilePath);
                console.log(
                  `::notice title=AI Trace Saved::OpenTelemetry trace file size: ${stats.size} bytes`
                );
              }
            }
          } else if (tracerWithMethods && typeof tracerWithMethods.shutdown === "function") {
            await tracerWithMethods.shutdown();
            log(`\u{1F4CA} Trace saved to: ${traceFilePath}`);
          }
        } catch (exportError) {
          logger.warn(`\u26A0\uFE0F  Warning: Failed to export trace: ${exportError}`);
        }
      }
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
    const fs7 = __require("fs").promises;
    const path9 = __require("path");
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
    if ((schema.startsWith("./") || schema.includes(".json")) && !path9.isAbsolute(schema)) {
      if (schema.includes("..") || schema.includes("\0")) {
        throw new Error("Invalid schema path: path traversal not allowed");
      }
      try {
        const schemaPath = path9.resolve(process.cwd(), schema);
        log(`\u{1F4CB} Loading custom schema from file: ${schemaPath}`);
        const schemaContent = await fs7.readFile(schemaPath, "utf-8");
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
    const candidatePaths = [
      // GitHub Action bundle location
      path9.join(__dirname, "output", sanitizedSchemaName, "schema.json"),
      // Historical fallback when src/output was inadvertently bundled as output1/
      path9.join(__dirname, "output1", sanitizedSchemaName, "schema.json"),
      // Local dev (repo root)
      path9.join(process.cwd(), "output", sanitizedSchemaName, "schema.json")
    ];
    for (const schemaPath of candidatePaths) {
      try {
        const schemaContent = await fs7.readFile(schemaPath, "utf-8");
        return schemaContent.trim();
      } catch {
      }
    }
    const distPath = path9.join(__dirname, "output", sanitizedSchemaName, "schema.json");
    const distAltPath = path9.join(__dirname, "output1", sanitizedSchemaName, "schema.json");
    const cwdPath = path9.join(process.cwd(), "output", sanitizedSchemaName, "schema.json");
    throw new Error(
      `Failed to load schema '${sanitizedSchemaName}'. Tried: ${distPath}, ${distAltPath}, and ${cwdPath}. Ensure build copies 'output/' into dist (build:cli), or provide a custom schema file/path.`
    );
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
      const looksLikeTextOutput = reviewData && typeof reviewData === "object" && typeof reviewData.text === "string" && String(reviewData.text).trim().length > 0;
      const isCustomSchema = _schema === "custom" || _schema && (_schema.startsWith("./") || _schema.endsWith(".json")) || _schema && _schema !== "code-review" && !_schema.includes("output/") || !_schema && looksLikeTextOutput;
      const _debugSchemaLogging = this.config.debug === true || process.env.VISOR_DEBUG_AI_SESSIONS === "true";
      if (_debugSchemaLogging) {
        const details = {
          schema: _schema,
          isCustomSchema,
          isCustomLiteral: _schema === "custom",
          startsWithDotSlash: typeof _schema === "string" ? _schema.startsWith("./") : false,
          endsWithJson: typeof _schema === "string" ? _schema.endsWith(".json") : false,
          notCodeReview: _schema !== "code-review",
          noOutputPrefix: typeof _schema === "string" ? !_schema.includes("output/") : false
        };
        try {
          log(`\u{1F50D} Schema detection: ${JSON.stringify(details)}`);
        } catch {
          log(
            `\u{1F50D} Schema detection: _schema="${String(_schema)}", isCustomSchema=${isCustomSchema}`
          );
        }
      }
      if (isCustomSchema) {
        log("\u{1F4CB} Custom schema detected - preserving all fields from parsed JSON");
        log(`\u{1F4CA} Schema: ${_schema}`);
        try {
          log(`\u{1F4CA} Custom schema keys: ${Object.keys(reviewData).join(", ")}`);
        } catch {
        }
        const out = reviewData && typeof reviewData === "object" ? reviewData : {};
        const hasText = typeof out.text === "string" && String(out.text).trim().length > 0;
        if (!hasText) {
          let fallbackText = "";
          try {
            if (Array.isArray(reviewData?.issues) && reviewData.issues.length > 0) {
              fallbackText = reviewData.issues.map((i) => i && (i.message || i.text || i.response)).filter((s) => typeof s === "string" && s.trim().length > 0).join("\n");
            }
          } catch {
          }
          if (!fallbackText && typeof response === "string" && response.trim()) {
            fallbackText = response.trim().slice(0, 6e4);
          }
          if (fallbackText) {
            out.text = fallbackText;
          }
        }
        const result2 = {
          // Keep issues empty for custom-schema rendering; consumers read from output.*
          issues: [],
          output: out
        };
        log(
          "\u2705 Successfully created ReviewSummary with custom schema output (with fallback text when needed)"
        );
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
      const detailed = this.config.debug === true || process.env.VISOR_DEBUG_AI_SESSIONS === "true";
      const message = error instanceof Error ? error.message : String(error);
      if (detailed) {
        logger.debug(`\u274C Failed to parse AI response: ${message}`);
        logger.debug("\u{1F4C4} FULL RAW RESPONSE:");
        logger.debug("=".repeat(80));
        logger.debug(response);
        logger.debug("=".repeat(80));
        logger.debug(`\u{1F4CF} Response length: ${response.length} characters`);
        if (error instanceof SyntaxError) {
          logger.debug("\u{1F50D} JSON parsing error - the response may not be valid JSON");
          logger.debug(`\u{1F50D} Error details: ${error.message}`);
          const errorMatch = error.message.match(/position (\d+)/);
          if (errorMatch) {
            const position = parseInt(errorMatch[1]);
            logger.debug(`\u{1F50D} Error at position ${position}:`);
            const start = Math.max(0, position - 50);
            const end = Math.min(response.length, position + 50);
            logger.debug(`\u{1F50D} Context: "${response.substring(start, end)}"`);
            logger.debug(`\u{1F50D} Response beginning: "${response.substring(0, 100)}"`);
          }
          if (response.includes("I cannot")) {
            logger.debug("\u{1F50D} Response appears to be a refusal/explanation rather than JSON");
          }
          if (response.includes("```")) {
            logger.debug("\u{1F50D} Response appears to contain markdown code blocks");
          }
          if (response.startsWith("<")) {
            logger.debug("\u{1F50D} Response appears to start with XML/HTML");
          }
        }
      } else {
        logger.error(`\u274C Failed to parse AI response: ${message}`);
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
  async generateMockResponse(_prompt, _checkName, _schema) {
    await new Promise((resolve4) => setTimeout(resolve4, 500));
    const name = (_checkName || "").toLowerCase();
    if (name.includes("extract-facts")) {
      const arr = Array.from({ length: 6 }, (_, i) => ({
        id: `fact-${i + 1}`,
        category: "Feature",
        claim: `claim-${i + 1}`,
        verifiable: true,
        refs: [{ path: "src/check-execution-engine.ts", lines: "6400-6460" }]
      }));
      return JSON.stringify(arr);
    }
    if (name.includes("validate-fact")) {
      const idMatch = _prompt.match(/Fact ID:\s*([\w\-]+)/i);
      const claimMatch = _prompt.match(/\*\*Claim:\*\*\s*(.+)/i);
      const attemptMatch = _prompt.match(/Attempt:\s*(\d+)/i);
      const factId = idMatch ? idMatch[1] : "fact-1";
      const claim = claimMatch ? claimMatch[1].trim() : "unknown-claim";
      const n = Number(factId.split("-")[1] || "0");
      const attempt = attemptMatch ? Number(attemptMatch[1]) : 0;
      const isValid = attempt >= 1 ? true : !(n >= 1 && n <= 3);
      return JSON.stringify({
        fact_id: factId,
        claim,
        is_valid: isValid,
        confidence: "high",
        evidence: isValid ? "verified" : "not found",
        correction: isValid ? null : `correct ${claim}`
      });
    }
    if (name.includes("issue-assistant") || name.includes("comment-assistant")) {
      const text = "### Assistant Reply";
      const intent = name.includes("issue") ? "issue_triage" : "comment_reply";
      return JSON.stringify({ text, intent });
    }
    const mockResponse = { content: JSON.stringify({ issues: [], summary: { totalIssues: 0 } }) };
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
      const { CheckExecutionEngine: CheckExecutionEngine2 } = await import("./check-execution-engine-PRFTZJ77.mjs");
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
  /**
   * Helper to check if a schema is comment-generating
   * Comment-generating schemas include:
   * - Built-in schemas: code-review, overview, plain, text
   * - Custom schemas with a "text" field in properties
   */
  async isCommentGeneratingSchema(schema) {
    try {
      if (typeof schema === "string") {
        if (["code-review", "overview", "plain", "text"].includes(schema)) {
          return true;
        }
        const fs7 = __require("fs").promises;
        const path9 = __require("path");
        const sanitizedSchemaName = schema.replace(/[^a-zA-Z0-9-]/g, "");
        if (!sanitizedSchemaName || sanitizedSchemaName !== schema) {
          return false;
        }
        const candidatePaths = [
          path9.join(__dirname, "output", sanitizedSchemaName, "schema.json"),
          path9.join(process.cwd(), "output", sanitizedSchemaName, "schema.json")
        ];
        for (const schemaPath of candidatePaths) {
          try {
            const schemaContent = await fs7.readFile(schemaPath, "utf-8");
            const schemaObj = JSON.parse(schemaContent);
            const properties = schemaObj.properties;
            return !!(properties && "text" in properties);
          } catch {
          }
        }
        return false;
      } else {
        const properties = schema.properties;
        return !!(properties && "text" in properties);
      }
    } catch {
      return false;
    }
  }
  /**
   * Filter check results to only include those that should post GitHub comments
   */
  async filterCommentGeneratingChecks(checkResults, config) {
    const filtered = [];
    for (const r of checkResults) {
      const cfg = config.checks?.[r.checkName];
      const type = cfg?.type || "ai";
      const schema = cfg?.schema;
      let shouldPostComment = false;
      const isAICheck = type === "ai" || type === "claude-code";
      if (!schema || schema === "") {
        shouldPostComment = isAICheck;
      } else {
        shouldPostComment = await this.isCommentGeneratingSchema(schema);
      }
      if (shouldPostComment) {
        filtered.push(r);
      }
    }
    return filtered;
  }
  async postReviewComment(owner, repo, prNumber, groupedResults, options = {}) {
    for (const [groupName, checkResults] of Object.entries(groupedResults)) {
      let filteredResults = options.config ? await this.filterCommentGeneratingChecks(checkResults, options.config) : checkResults;
      if (groupName === "github-output" && filteredResults && filteredResults.length > 1) {
        const byName = /* @__PURE__ */ new Map();
        for (const cr of filteredResults) byName.set(cr.checkName, cr);
        let collapsed = Array.from(byName.values());
        const hasVerified = collapsed.some((r) => r.checkName === "post-verified-response");
        if (hasVerified) {
          collapsed = collapsed.filter((r) => r.checkName !== "post-unverified-warning");
        }
        filteredResults = collapsed;
      }
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
    const normalize2 = (s) => s.replace(/\\n/g, "\n");
    const checkContents = checkResults.map((result) => {
      const trimmed = result.content?.trim();
      if (trimmed) return normalize2(trimmed);
      const out = result.output;
      if (out) {
        if (typeof out === "string" && out.trim()) return normalize2(out.trim());
        if (typeof out === "object") {
          const txt = out.text || out.response || out.message;
          if (typeof txt === "string" && txt.trim()) return normalize2(txt.trim());
        }
      }
      return "";
    }).filter((content) => content && content.trim());
    const debugInfo = checkResults.find((result) => result.debug)?.debug;
    if (checkContents.length === 0 && !debugInfo) {
      return "";
    }
    let comment = "";
    comment += `## \u{1F50D} Code Analysis Results

`;
    comment += checkContents.join("\n\n");
    if (debugInfo) {
      comment += "\n\n" + this.formatDebugSection(debugInfo);
      comment += "\n\n";
    }
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
      const fs7 = __require("fs");
      const path9 = __require("path");
      const debugDir = path9.join(process.cwd(), "debug-artifacts");
      if (!fs7.existsSync(debugDir)) {
        fs7.mkdirSync(debugDir, { recursive: true });
      }
      const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
      const filename = `visor-debug-${timestamp}.md`;
      const filepath = path9.join(debugDir, filename);
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
      fs7.writeFileSync(filepath, content, "utf8");
      return filename;
    } catch (error) {
      console.error("Failed to save debug artifact:", error);
      return null;
    }
  }
};

// src/git-repository-analyzer.ts
import { simpleGit } from "simple-git";
import * as path3 from "path";
import * as fs2 from "fs";

// src/utils/file-exclusion.ts
import ignore from "ignore";
import * as fs from "fs";
import * as path2 from "path";
var DEFAULT_EXCLUSION_PATTERNS = [
  "dist/",
  "build/",
  ".next/",
  "out/",
  "node_modules/",
  "coverage/",
  ".turbo/",
  "bundled/"
];
var FileExclusionHelper = class {
  gitignore = null;
  workingDirectory;
  /**
   * @param workingDirectory - Directory to search for .gitignore
   * @param additionalPatterns - Additional patterns to include (optional, defaults to common build artifacts)
   */
  constructor(workingDirectory = process.cwd(), additionalPatterns = DEFAULT_EXCLUSION_PATTERNS) {
    const normalizedPath = path2.resolve(workingDirectory);
    if (normalizedPath.includes("\0")) {
      throw new Error("Invalid workingDirectory: contains null bytes");
    }
    this.workingDirectory = normalizedPath;
    this.loadGitignore(additionalPatterns);
  }
  /**
   * Load .gitignore patterns from the working directory (called once in constructor)
   * @param additionalPatterns - Additional patterns to add to gitignore rules
   */
  loadGitignore(additionalPatterns) {
    const gitignorePath = path2.resolve(this.workingDirectory, ".gitignore");
    const resolvedWorkingDir = path2.resolve(this.workingDirectory);
    try {
      const relativePath = path2.relative(resolvedWorkingDir, gitignorePath);
      if (relativePath.startsWith("..") || path2.isAbsolute(relativePath)) {
        throw new Error("Invalid gitignore path: path traversal detected");
      }
      if (relativePath !== ".gitignore") {
        throw new Error("Invalid gitignore path: must be .gitignore in working directory");
      }
      this.gitignore = ignore();
      if (additionalPatterns && additionalPatterns.length > 0) {
        this.gitignore.add(additionalPatterns);
      }
      if (fs.existsSync(gitignorePath)) {
        const rawContent = fs.readFileSync(gitignorePath, "utf8");
        const gitignoreContent = rawContent.replace(/[\r\n]+/g, "\n").replace(/[\x00-\x09\x0B-\x1F\x7F]/g, "").split("\n").filter((line) => line.length < 1e3).join("\n").trim();
        this.gitignore.add(gitignoreContent);
        if (process.env.VISOR_DEBUG === "true") {
          console.error("\u2705 Loaded .gitignore patterns for file filtering");
        }
      } else if (additionalPatterns && additionalPatterns.length > 0) {
        console.error("No .gitignore found, using default exclusion patterns");
        console.warn("No .gitignore found, using default exclusion patterns");
      }
    } catch (error) {
      console.warn("Failed to load .gitignore:", error instanceof Error ? error.message : error);
    }
  }
  /**
   * Check if a file should be excluded based on .gitignore patterns
   */
  shouldExcludeFile(filename) {
    if (this.gitignore) {
      return this.gitignore.ignores(filename);
    }
    return false;
  }
};

// src/git-repository-analyzer.ts
var MAX_PATCH_SIZE = 50 * 1024;
var GitRepositoryAnalyzer = class {
  git;
  cwd;
  fileExclusionHelper;
  constructor(workingDirectory = process.cwd()) {
    this.cwd = workingDirectory;
    this.git = simpleGit(workingDirectory);
    this.fileExclusionHelper = new FileExclusionHelper(workingDirectory);
  }
  /**
   * Analyze the current git repository state and return data compatible with PRInfo interface
   */
  async analyzeRepository(includeContext = true, enableBranchDiff = false) {
    const isRepo = await this.isGitRepository();
    if (!isRepo) {
      return this.createEmptyRepositoryInfo("Not a git repository");
    }
    try {
      const [status, currentBranch, baseBranch] = await Promise.all([
        this.git.status(),
        this.getCurrentBranch(),
        this.getBaseBranch()
      ]);
      const isFeatureBranch = currentBranch !== baseBranch && currentBranch !== "main" && currentBranch !== "master";
      let uncommittedFiles = await this.getUncommittedChanges(includeContext);
      if (isFeatureBranch && includeContext && enableBranchDiff) {
        if (uncommittedFiles.length > 0) {
          console.error(`\u{1F4CA} Feature branch detected: ${currentBranch}`);
          console.error(
            `\u26A0\uFE0F  Ignoring ${uncommittedFiles.length} uncommitted file(s) due to --analyze-branch-diff flag`
          );
        } else {
          console.error(`\u{1F4CA} Feature branch detected: ${currentBranch}`);
        }
        console.error(
          `\u{1F4C2} Analyzing diff vs ${baseBranch} (${uncommittedFiles.length > 0 ? "forced by --analyze-branch-diff" : "auto-enabled for code-review schemas"})`
        );
        uncommittedFiles = await this.getBranchDiff(baseBranch, includeContext);
      } else if (uncommittedFiles.length > 0) {
        console.error(`\u{1F4DD} Analyzing uncommitted changes (${uncommittedFiles.length} files)`);
      }
      let lastCommit = null;
      try {
        const recentCommits = await this.git.log({ maxCount: 1 });
        lastCommit = recentCommits.latest;
      } catch {
        console.error("\u{1F4DD} Repository has no commits yet, analyzing uncommitted changes");
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
        base: baseBranch,
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
  /**
   * Truncate a patch if it exceeds MAX_PATCH_SIZE
   */
  truncatePatch(patch, filename) {
    const patchSize = Buffer.byteLength(patch, "utf8");
    if (patchSize <= MAX_PATCH_SIZE) {
      return { patch, truncated: false };
    }
    const truncated = patch.substring(0, MAX_PATCH_SIZE);
    const truncatedPatch = `${truncated}

... [TRUNCATED: Diff too large (${(patchSize / 1024).toFixed(1)}KB), showing first ${(MAX_PATCH_SIZE / 1024).toFixed(0)}KB] ...`;
    console.error(
      `\u26A0\uFE0F  Truncated diff for ${filename} (${(patchSize / 1024).toFixed(1)}KB \u2192 ${(MAX_PATCH_SIZE / 1024).toFixed(0)}KB)`
    );
    return { patch: truncatedPatch, truncated: true };
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
        if (this.fileExclusionHelper.shouldExcludeFile(file)) {
          console.error(`\u23ED\uFE0F  Skipping excluded file: ${file}`);
          continue;
        }
        const filePath = path3.join(this.cwd, file);
        const fileChange = await this.analyzeFileChange(file, status2, filePath, includeContext);
        changes.push(fileChange);
      }
      return changes;
    } catch (error) {
      console.error("Error getting uncommitted changes:", error);
      return [];
    }
  }
  /**
   * Get diff between current branch and base branch (for feature branch analysis)
   */
  async getBranchDiff(baseBranch, includeContext = true) {
    try {
      const diffSummary = await this.git.diffSummary([baseBranch]);
      const changes = [];
      if (!diffSummary || !diffSummary.files) {
        return [];
      }
      for (const file of diffSummary.files) {
        if (this.fileExclusionHelper.shouldExcludeFile(file.file)) {
          console.error(`\u23ED\uFE0F  Skipping excluded file: ${file.file}`);
          continue;
        }
        const isBinary = "binary" in file && file.binary;
        const insertions = "insertions" in file ? file.insertions : 0;
        const deletions = "deletions" in file ? file.deletions : 0;
        const fileChanges = "changes" in file ? file.changes : 0;
        let status;
        if (isBinary) {
          status = "modified";
        } else if (insertions > 0 && deletions === 0) {
          status = "added";
        } else if (insertions === 0 && deletions > 0) {
          status = "removed";
        } else {
          status = "modified";
        }
        let patch;
        let truncated = false;
        if (includeContext && !isBinary) {
          try {
            const rawPatch = await this.git.diff([baseBranch, "--", file.file]);
            if (rawPatch) {
              const result = this.truncatePatch(rawPatch, file.file);
              patch = result.patch;
              truncated = result.truncated;
            }
          } catch {
          }
        }
        const fileChange = {
          filename: file.file,
          additions: insertions,
          deletions,
          changes: fileChanges,
          status,
          patch,
          truncated
        };
        changes.push(fileChange);
      }
      return changes;
    } catch (error) {
      console.error("Error getting branch diff:", error);
      return [];
    }
  }
  async analyzeFileChange(filename, status, filePath, includeContext = true) {
    let additions = 0;
    let deletions = 0;
    let patch;
    let content;
    let truncated = false;
    try {
      if (includeContext && status !== "added" && fs2.existsSync(filePath)) {
        const diff = await this.git.diff(["--", filename]).catch(() => "");
        if (diff) {
          const result = this.truncatePatch(diff, filename);
          patch = result.patch;
          truncated = result.truncated;
          const lines = diff.split("\n");
          additions = lines.filter((line) => line.startsWith("+")).length;
          deletions = lines.filter((line) => line.startsWith("-")).length;
        }
      } else if (status !== "added" && fs2.existsSync(filePath)) {
        const diff = await this.git.diff(["--", filename]).catch(() => "");
        if (diff) {
          const lines = diff.split("\n");
          additions = lines.filter((line) => line.startsWith("+")).length;
          deletions = lines.filter((line) => line.startsWith("-")).length;
        }
      }
      if (status === "added" && fs2.existsSync(filePath)) {
        try {
          const stats = fs2.statSync(filePath);
          if (stats.isFile() && stats.size < 1024 * 1024) {
            if (includeContext) {
              content = fs2.readFileSync(filePath, "utf8");
              const result = this.truncatePatch(content, filename);
              patch = result.patch;
              truncated = result.truncated;
            }
            const fileContent = includeContext ? content : fs2.readFileSync(filePath, "utf8");
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
      patch,
      truncated
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
import * as path4 from "path";
var PRAnalyzer = class {
  constructor(octokit, maxRetries = 3, workingDirectory = path4.resolve(process.cwd())) {
    this.octokit = octokit;
    this.maxRetries = maxRetries;
    this.fileExclusionHelper = new FileExclusionHelper(workingDirectory);
  }
  fileExclusionHelper;
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
    let skippedCount = 0;
    const validFiles = files ? files.filter((file) => file && typeof file === "object" && file.filename).filter((file) => {
      const filename = typeof file.filename === "string" ? file.filename : String(file.filename || "unknown");
      if (!filename || this.fileExclusionHelper.shouldExcludeFile(filename)) {
        skippedCount++;
        return false;
      }
      return true;
    }).map((file) => ({
      filename: typeof file.filename === "string" ? file.filename : String(file.filename || "unknown"),
      additions: typeof file.additions === "number" ? Math.max(0, file.additions) : 0,
      deletions: typeof file.deletions === "number" ? Math.max(0, file.deletions) : 0,
      changes: typeof file.changes === "number" ? Math.max(0, file.changes) : 0,
      patch: typeof file.patch === "string" ? file.patch : void 0,
      status: ["added", "removed", "modified", "renamed"].includes(file.status) ? file.status : "modified"
    })) : [];
    if (skippedCount > 0) {
      console.log(`\u23ED\uFE0F  Skipped ${skippedCount} excluded file(s)`);
    }
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
          await new Promise((resolve4) => setTimeout(resolve4, delay));
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
  /**
   * Resolves environment variables in HTTP headers
   * Each header value is processed through resolveValue to replace env var references
   */
  static resolveHeaders(headers) {
    const resolved = {};
    for (const [key, value] of Object.entries(headers)) {
      resolved[key] = String(this.resolveValue(value));
    }
    return resolved;
  }
  /**
   * Sanitizes headers for logging/telemetry by redacting sensitive values
   * Headers like Authorization, API keys, and cookies are replaced with [REDACTED]
   */
  static sanitizeHeaders(headers) {
    const sensitiveHeaders = ["authorization", "x-api-key", "cookie", "set-cookie"];
    const sanitized = {};
    for (const [key, value] of Object.entries(headers)) {
      if (sensitiveHeaders.includes(key.toLowerCase())) {
        sanitized[key] = "[REDACTED]";
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }
};

// src/issue-filter.ts
import * as fs3 from "fs";
import * as path5 from "path";
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
      const resolvedPath = path5.isAbsolute(filePath) ? filePath : path5.join(workingDir, filePath);
      if (!fs3.existsSync(resolvedPath)) {
        if (fs3.existsSync(filePath)) {
          const content2 = fs3.readFileSync(filePath, "utf8");
          const lines2 = content2.split("\n");
          this.fileCache.set(filePath, lines2);
          return lines2;
        }
        return null;
      }
      const content = fs3.readFileSync(resolvedPath, "utf8");
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
import fs4 from "fs/promises";
import path6 from "path";

// src/telemetry/state-capture.ts
var MAX_ATTRIBUTE_LENGTH = 1e4;
function safeSerialize(value, maxLength = MAX_ATTRIBUTE_LENGTH) {
  try {
    if (value === void 0 || value === null) return String(value);
    const seen = /* @__PURE__ */ new WeakSet();
    const json = JSON.stringify(value, (key, val) => {
      if (typeof val === "object" && val !== null) {
        if (seen.has(val)) return "[Circular]";
        seen.add(val);
      }
      if (typeof val === "string" && val.length > maxLength) {
        return val.substring(0, maxLength) + "...[truncated]";
      }
      return val;
    });
    if (json.length > maxLength) {
      return json.substring(0, maxLength) + "...[truncated]";
    }
    return json;
  } catch (err) {
    return `[Error serializing: ${err instanceof Error ? err.message : String(err)}]`;
  }
}
function captureCheckInputContext(span, context2) {
  try {
    const keys = Object.keys(context2);
    span.setAttribute("visor.check.input.keys", keys.join(","));
    span.setAttribute("visor.check.input.count", keys.length);
    span.setAttribute("visor.check.input.context", safeSerialize(context2));
    if (context2.pr) {
      span.setAttribute("visor.check.input.pr", safeSerialize(context2.pr, 1e3));
    }
    if (context2.outputs) {
      span.setAttribute("visor.check.input.outputs", safeSerialize(context2.outputs, 5e3));
    }
    if (context2.env) {
      span.setAttribute("visor.check.input.env_keys", Object.keys(context2.env).join(","));
    }
  } catch (err) {
    try {
      span.setAttribute("visor.check.input.error", String(err));
    } catch {
    }
  }
}
function captureCheckOutput(span, output) {
  try {
    span.setAttribute("visor.check.output.type", typeof output);
    if (Array.isArray(output)) {
      span.setAttribute("visor.check.output.length", output.length);
      const preview = output.slice(0, 10);
      span.setAttribute("visor.check.output.preview", safeSerialize(preview, 2e3));
    }
    span.setAttribute("visor.check.output", safeSerialize(output));
  } catch (err) {
    try {
      span.setAttribute("visor.check.output.error", String(err));
    } catch {
    }
  }
}
function captureTransformJS(span, code, input, output) {
  try {
    const codePreview = code.length > 2e3 ? code.substring(0, 2e3) + "...[truncated]" : code;
    span.setAttribute("visor.transform.code", codePreview);
    span.setAttribute("visor.transform.code.length", code.length);
    span.setAttribute("visor.transform.input", safeSerialize(input, 2e3));
    span.setAttribute("visor.transform.output", safeSerialize(output, 2e3));
  } catch (err) {
    span.setAttribute("visor.transform.error", String(err));
  }
}
function captureProviderCall(span, providerType, request, response) {
  try {
    span.setAttribute("visor.provider.type", providerType);
    if (request.model) span.setAttribute("visor.provider.request.model", String(request.model));
    if (request.prompt) {
      span.setAttribute("visor.provider.request.prompt.length", request.prompt.length);
      span.setAttribute("visor.provider.request.prompt.preview", request.prompt.substring(0, 500));
    }
    if (response.content) {
      span.setAttribute("visor.provider.response.length", response.content.length);
      span.setAttribute("visor.provider.response.preview", response.content.substring(0, 500));
    }
    if (response.tokens) {
      span.setAttribute("visor.provider.response.tokens", response.tokens);
    }
  } catch (err) {
    span.setAttribute("visor.provider.error", String(err));
  }
}

// src/providers/ai-check-provider.ts
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
  async processPrompt(promptConfig, prInfo, eventContext, dependencyResults, outputHistory) {
    let promptContent;
    if (await this.isFilePath(promptConfig)) {
      promptContent = await this.loadPromptFromFile(promptConfig);
    } else {
      promptContent = promptConfig;
    }
    return await this.renderPromptTemplate(
      promptContent,
      prInfo,
      eventContext,
      dependencyResults,
      outputHistory
    );
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
    const isAbsolutePath = path6.isAbsolute(str);
    const hasTypicalFileChars = /^[a-zA-Z0-9._\-\/\\:~]+$/.test(str);
    if (!(hasFileExtension || isRelativePath || isAbsolutePath || hasPathSeparators)) {
      return false;
    }
    if (!hasTypicalFileChars) {
      return false;
    }
    try {
      let resolvedPath;
      if (path6.isAbsolute(str)) {
        resolvedPath = path6.normalize(str);
      } else {
        resolvedPath = path6.resolve(process.cwd(), str);
      }
      const fs7 = __require("fs").promises;
      try {
        const stat = await fs7.stat(resolvedPath);
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
    if (path6.isAbsolute(promptPath)) {
      resolvedPath = promptPath;
    } else {
      resolvedPath = path6.resolve(process.cwd(), promptPath);
    }
    if (!path6.isAbsolute(promptPath)) {
      const normalizedPath = path6.normalize(resolvedPath);
      const currentDir = path6.resolve(process.cwd());
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
   * Render Liquid template in prompt with comprehensive event context
   */
  async renderPromptTemplate(promptContent, prInfo, eventContext, dependencyResults, outputHistory) {
    const outputsRaw = {};
    if (dependencyResults) {
      for (const [k, v] of dependencyResults.entries()) {
        if (typeof k !== "string") continue;
        if (k.endsWith("-raw")) {
          const name = k.slice(0, -4);
          const summary = v;
          outputsRaw[name] = summary.output !== void 0 ? summary.output : summary;
        }
      }
    }
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
      ) : {},
      // Alias for consistency with other providers
      outputs_history: (() => {
        const hist = {};
        if (outputHistory) {
          for (const [k, v] of outputHistory.entries()) hist[k] = v;
        }
        return hist;
      })(),
      // New: outputs_raw exposes aggregate values (e.g., full arrays for forEach parents)
      outputs_raw: outputsRaw
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
      if (config.ai.enableDelegate !== void 0) {
        aiConfig.enableDelegate = config.ai.enableDelegate;
      }
      if (config.ai.skip_code_context !== void 0) {
        aiConfig.skip_code_context = config.ai.skip_code_context;
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
    if (Object.keys(mcpServers).length > 0 && !config.ai?.disable_tools) {
      aiConfig.mcpServers = mcpServers;
      if (aiConfig.debug) {
        console.error(
          `\u{1F527} Debug: AI check MCP configured with ${Object.keys(mcpServers).length} servers`
        );
      }
    } else if (config.ai?.disable_tools && aiConfig.debug) {
      console.error(`\u{1F527} Debug: AI check has tools disabled - MCP servers will not be passed`);
    }
    const templateContext = {
      pr: {
        number: prInfo.number,
        title: prInfo.title,
        author: prInfo.author,
        branch: prInfo.head,
        base: prInfo.base
      },
      files: prInfo.files,
      outputs: _dependencyResults ? Object.fromEntries(
        Array.from(_dependencyResults.entries()).map(([checkName, result]) => [
          checkName,
          result.output !== void 0 ? result.output : result
        ])
      ) : {}
    };
    try {
      const span = trace.getSpan(context.active());
      if (span) {
        captureCheckInputContext(span, templateContext);
      }
    } catch {
    }
    try {
      const checkId = config.checkName || config.id || "unknown";
      const ctxJson = JSON.stringify(templateContext);
      const { emitNdjsonSpanWithEvents: emitNdjsonSpanWithEvents2 } = (init_fallback_ndjson(), __toCommonJS(fallback_ndjson_exports));
      emitNdjsonSpanWithEvents2(
        "visor.check",
        { "visor.check.id": checkId, "visor.check.input.context": ctxJson },
        []
      );
    } catch {
    }
    const eventContext = config.ai?.skip_code_context ? {} : config.eventContext;
    const processedPrompt = await this.processPrompt(
      customPrompt,
      prInfo,
      eventContext,
      _dependencyResults,
      config.__outputHistory
    );
    try {
      const stepName = config.checkName || "unknown";
      const serviceForCapture = new AIReviewService(aiConfig);
      const finalPrompt = await serviceForCapture.buildCustomPrompt(
        prInfo,
        processedPrompt,
        config.schema,
        { checkName: config.checkName }
      );
      sessionInfo?.hooks?.onPromptCaptured?.({
        step: String(stepName),
        provider: "ai",
        prompt: finalPrompt
      });
    } catch {
    }
    try {
      const stepName = config.checkName || "unknown";
      const mock = sessionInfo?.hooks?.mockForStep?.(String(stepName));
      if (mock !== void 0) {
        return { issues: [], output: mock };
      }
    } catch {
    }
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
      if (aiConfig.debug) {
        try {
          console.error(
            `\u{1F527} Debug: reuse_ai_session for ${config.checkName}: ${String(
              config.reuse_ai_session
            )}`
          );
        } catch {
        }
      }
      const reuseEnabled = config.reuse_ai_session === true || typeof config.reuse_ai_session === "string";
      if (sessionInfo?.reuseSession && sessionInfo.parentSessionId && reuseEnabled) {
        try {
          const { SessionRegistry: SessionRegistry2 } = (init_session_registry(), __toCommonJS(session_registry_exports));
          const reg = SessionRegistry2.getInstance();
          if (!reg.hasSession(sessionInfo.parentSessionId)) {
            if (aiConfig.debug || process.env.VISOR_DEBUG === "true") {
              console.warn(
                `\u26A0\uFE0F  Parent session ${sessionInfo.parentSessionId} not found; creating a new session for ${config.checkName}`
              );
            }
            const fresh = await service.executeReview(
              prInfo,
              processedPrompt,
              schema,
              config.checkName,
              config.sessionId
            );
            return {
              ...fresh,
              issues: new IssueFilter(config.suppressionEnabled !== false).filterIssues(
                fresh.issues || [],
                process.cwd()
              )
            };
          }
        } catch {
        }
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
      const finalResult = {
        ...result,
        issues: filteredIssues
      };
      try {
        const span = trace.getSpan(context.active());
        if (span) {
          captureProviderCall(
            span,
            "ai",
            {
              prompt: processedPrompt.substring(0, 500),
              // Preview only
              model: aiConfig.model
            },
            {
              content: JSON.stringify(finalResult).substring(0, 500),
              tokens: result.usage?.totalTokens
            }
          );
          const outputForSpan = finalResult.output ?? finalResult;
          captureCheckOutput(span, outputForSpan);
        }
      } catch {
      }
      try {
        const checkId = config.checkName || config.id || "unknown";
        const outJson = JSON.stringify(finalResult.output ?? finalResult);
        const { emitNdjsonSpanWithEvents: emitNdjsonSpanWithEvents2 } = (init_fallback_ndjson(), __toCommonJS(fallback_ndjson_exports));
        emitNdjsonSpanWithEvents2(
          "visor.check",
          { "visor.check.id": checkId, "visor.check.output": outJson },
          []
        );
      } catch {
      }
      return finalResult;
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
      "ai.enableDelegate",
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
    try {
      const span = trace.getSpan(context.active());
      if (span) {
        captureCheckInputContext(span, templateContext);
      }
    } catch {
    }
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
      const resolvedHeaders = EnvironmentResolver.resolveHeaders(headers);
      const response = await this.sendWebhookRequest(
        url,
        method,
        resolvedHeaders,
        payload,
        timeout
      );
      const result = this.parseWebhookResponse(response, url);
      const suppressionEnabled = config.suppressionEnabled !== false;
      const issueFilter = new IssueFilter(suppressionEnabled);
      const filteredIssues = issueFilter.filterIssues(result.issues || [], process.cwd());
      const finalResult = {
        ...result,
        issues: filteredIssues
      };
      try {
        const span = trace.getSpan(context.active());
        if (span) {
          const sanitizedHeaders = EnvironmentResolver.sanitizeHeaders(resolvedHeaders);
          captureProviderCall(
            span,
            "http",
            {
              url,
              method,
              headers: sanitizedHeaders,
              body: JSON.stringify(payload).substring(0, 500)
            },
            {
              content: JSON.stringify(response).substring(0, 500)
            }
          );
          const outputForSpan = finalResult.output ?? finalResult;
          captureCheckOutput(span, outputForSpan);
        }
      } catch {
      }
      return finalResult;
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
  async execute(prInfo, config, dependencyResults, context2) {
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
      const resolvedHeaders = EnvironmentResolver.resolveHeaders(headers);
      const stepName = config.checkName || "unknown";
      const mock = context2?.hooks?.mockForStep?.(String(stepName));
      const data = mock !== void 0 ? mock : await this.fetchData(renderedUrl, method, resolvedHeaders, requestBody, timeout);
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
      includeMetadata,
      config.__outputHistory
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
  buildTemplateContext(prInfo, dependencyResults, _includePrContext = true, _includeDependencies = true, includeMetadata = true, outputHistory) {
    const context2 = {};
    context2.pr = {
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
    context2.filenames = prInfo.files.map((f) => f.filename);
    context2.fileCount = prInfo.files.length;
    if (dependencyResults) {
      const dependencies = {};
      const outputs = {};
      const outputsRaw = {};
      const history = {};
      context2.dependencyCount = dependencyResults.size;
      for (const [checkName, result] of dependencyResults.entries()) {
        if (typeof checkName !== "string") continue;
        dependencies[checkName] = {
          issueCount: result.issues?.length || 0,
          suggestionCount: 0,
          issues: result.issues || []
        };
        const summary = result;
        if (typeof checkName === "string" && checkName.endsWith("-raw")) {
          const name = checkName.slice(0, -4);
          outputsRaw[name] = summary.output !== void 0 ? summary.output : summary;
        } else {
          outputs[checkName] = summary.output !== void 0 ? summary.output : summary;
        }
      }
      if (outputHistory) {
        for (const [checkName, historyArray] of outputHistory) {
          history[checkName] = historyArray;
        }
      }
      outputs.history = history;
      context2.dependencies = dependencies;
      context2.outputs = outputs;
      context2.outputs_history = history;
      context2.outputs_raw = outputsRaw;
    }
    if (includeMetadata) {
      context2.metadata = {
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        executionTime: Date.now(),
        nodeVersion: process.version,
        platform: process.platform,
        workingDirectory: process.cwd()
      };
    }
    return context2;
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

// src/utils/sandbox.ts
import Sandbox from "@nyariv/sandboxjs";
function createSecureSandbox() {
  const globals = {
    ...Sandbox.SAFE_GLOBALS,
    Math,
    JSON,
    // Provide console with limited surface. Calls are harmless in CI logs and
    // help with debugging value_js / transform_js expressions.
    console: {
      log: console.log,
      warn: console.warn,
      error: console.error
    }
  };
  const prototypeWhitelist = new Map(Sandbox.SAFE_PROTOTYPES);
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
    "join",
    "push",
    "pop",
    "shift",
    "unshift",
    "sort",
    "reverse",
    "flat",
    "flatMap"
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
    "replace",
    "match",
    "padStart",
    "padEnd"
  ]);
  prototypeWhitelist.set(String.prototype, stringMethods);
  const objectMethods = /* @__PURE__ */ new Set([
    "hasOwnProperty",
    "toString",
    "valueOf",
    "keys",
    "values"
  ]);
  prototypeWhitelist.set(Object.prototype, objectMethods);
  return new Sandbox({ globals, prototypeWhitelist });
}
function compileAndRun(sandbox, userCode, scope, opts = { injectLog: true, wrapFunction: true, logPrefix: "[sandbox]" }) {
  const inject = opts?.injectLog === true;
  let safePrefix = String(opts?.logPrefix ?? "[sandbox]");
  safePrefix = safePrefix.replace(/[\r\n\t\0]/g, "").replace(/[`$\\]/g, "").replace(/\$\{/g, "").slice(0, 64);
  const header = inject ? `const __lp = ${JSON.stringify(safePrefix)}; const log = (...a) => { try { console.log(__lp, ...a); } catch {} };
` : "";
  const body = opts.wrapFunction ? `const __fn = () => {
${userCode}
};
return __fn();
` : `${userCode}`;
  const code = `${header}${body}`;
  let exec;
  try {
    exec = sandbox.compile(code);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`sandbox_compile_error: ${msg}`);
  }
  let out;
  try {
    out = exec(scope);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`sandbox_execution_error: ${msg}`);
  }
  if (out && typeof out.run === "function") {
    try {
      return out.run();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(`sandbox_runner_error: ${msg}`);
    }
  }
  return out;
}

// src/providers/github-ops-provider.ts
init_logger();
var GitHubOpsProvider = class extends CheckProvider {
  sandbox;
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
  async execute(prInfo, config, dependencyResults) {
    const cfg = config;
    let octokit = config.eventContext?.octokit;
    if (process.env.VISOR_DEBUG === "true") {
      try {
        logger.debug(`[github-ops] pre-fallback octokit? ${!!octokit}`);
      } catch {
      }
    }
    if (!octokit) {
      try {
        const { getGlobalRecorder: getGlobalRecorder2 } = (init_global_recorder(), __toCommonJS(global_recorder_exports));
        const rec = getGlobalRecorder2 && getGlobalRecorder2();
        if (rec) octokit = rec;
      } catch {
      }
    }
    if (!octokit) {
      if (process.env.VISOR_DEBUG === "true") {
        try {
          console.error("[github-ops] missing octokit after fallback \u2014 returning issue");
        } catch {
        }
      }
      return {
        issues: [
          {
            file: "system",
            line: 0,
            ruleId: "github/missing_octokit",
            message: "No authenticated Octokit instance available in event context. GitHub operations require proper authentication context.",
            severity: "error",
            category: "logic"
          }
        ]
      };
    }
    const repoEnv = process.env.GITHUB_REPOSITORY || "";
    let owner = "";
    let repo = "";
    if (repoEnv.includes("/")) {
      [owner, repo] = repoEnv.split("/");
    } else {
      try {
        const ec = config.eventContext || {};
        owner = ec?.repository?.owner?.login || owner;
        repo = ec?.repository?.name || repo;
      } catch {
      }
    }
    try {
      if (process.env.VISOR_DEBUG === "true") {
        logger.info(
          `[github-ops] context octokit? ${!!octokit} repo=${owner}/${repo} pr#=${prInfo?.number}`
        );
      }
    } catch {
    }
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
    let valuesRaw = [];
    if (Array.isArray(cfg.values)) valuesRaw = cfg.values.map((v) => String(v));
    else if (typeof cfg.values === "string") valuesRaw = [cfg.values];
    else if (typeof cfg.value === "string") valuesRaw = [cfg.value];
    try {
      if (process.env.VISOR_DEBUG === "true") {
        logger.info(`[github-ops] op=${cfg.op} valuesRaw(before)=${JSON.stringify(valuesRaw)}`);
      }
    } catch {
    }
    const renderValues = async (arr) => {
      if (!arr || arr.length === 0) return [];
      const liq = createExtendedLiquid({
        cache: false,
        strictFilters: false,
        strictVariables: false
      });
      const outputs = {};
      if (dependencyResults) {
        for (const [name, result] of dependencyResults.entries()) {
          const summary = result;
          outputs[name] = summary.output !== void 0 ? summary.output : summary;
        }
      }
      try {
        const hist = config.__outputHistory;
        if (hist) {
          for (const [name, arr2] of hist.entries()) {
            if (!outputs[name] && Array.isArray(arr2) && arr2.length > 0) {
              outputs[name] = arr2[arr2.length - 1];
            }
          }
        }
      } catch {
      }
      const ctx = {
        pr: {
          number: prInfo.number,
          title: prInfo.title,
          author: prInfo.author,
          branch: prInfo.head,
          base: prInfo.base,
          authorAssociation: prInfo.authorAssociation
        },
        outputs
      };
      try {
        if (process.env.VISOR_DEBUG === "true") {
          logger.info(`[github-ops] deps keys=${Object.keys(outputs).join(", ")}`);
          const ov = outputs["overview"];
          if (ov) {
            logger.info(`[github-ops] outputs.overview.keys=${Object.keys(ov).join(",")}`);
            if (ov.tags) {
              logger.info(
                `[github-ops] outputs.overview.tags keys=${Object.keys(ov.tags).join(",")}`
              );
              try {
                logger.info(
                  `[github-ops] outputs.overview.tags['review-effort']=${String(ov.tags["review-effort"])}`
                );
              } catch {
              }
            }
          }
        }
      } catch {
      }
      const out = [];
      for (const item of arr) {
        if (typeof item === "string" && (item.includes("{{") || item.includes("{%"))) {
          try {
            const rendered = await liq.parseAndRender(item, ctx);
            out.push(rendered);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (process.env.VISOR_DEBUG === "true") {
              logger.warn(`[github-ops] liquid_render_error: ${msg}`);
            }
            return Promise.reject({
              issues: [
                {
                  file: "system",
                  line: 0,
                  ruleId: "github/liquid_render_error",
                  message: `Failed to render template: ${msg}`,
                  severity: "error",
                  category: "logic"
                }
              ]
            });
          }
        } else {
          out.push(String(item));
        }
      }
      return out;
    };
    let values = await renderValues(valuesRaw);
    if (cfg.value_js && cfg.value_js.trim()) {
      try {
        const sandbox = this.getSecureSandbox();
        const depOutputs = {};
        if (dependencyResults) {
          for (const [name, result] of dependencyResults.entries()) {
            const summary = result;
            depOutputs[name] = summary.output !== void 0 ? summary.output : summary;
          }
        }
        const res = compileAndRun(
          sandbox,
          cfg.value_js,
          { pr: prInfo, values, outputs: depOutputs },
          { injectLog: true, wrapFunction: true, logPrefix: "[github:value_js]" }
        );
        if (typeof res === "string") values = [res];
        else if (Array.isArray(res)) values = res.map((v) => String(v));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (process.env.VISOR_DEBUG === "true") {
          logger.warn(`[github-ops] value_js_error: ${msg}`);
        }
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
    if (values.length === 0 && dependencyResults && dependencyResults.size > 0) {
      try {
        const derived = [];
        for (const result of dependencyResults.values()) {
          const out = result?.output ?? result;
          const tags = out?.["tags"];
          if (tags && typeof tags === "object") {
            const label = tags["label"];
            const effort = tags["review-effort"];
            if (label != null) derived.push(String(label));
            if (effort !== void 0 && effort !== null)
              derived.push(`review/effort:${String(effort)}`);
          }
        }
        values = derived;
        if (process.env.VISOR_DEBUG === "true") {
          logger.info(`[github-ops] derived values from deps: ${JSON.stringify(values)}`);
        }
      } catch {
      }
    }
    values = values.map((v) => v.trim()).filter((v) => v.length > 0);
    values = Array.from(new Set(values));
    try {
      if (process.env.NODE_ENV === "test" || process.env.VISOR_DEBUG === "true") {
        logger.info(`[github-ops] ${cfg.op} resolved values: ${JSON.stringify(values)}`);
      }
    } catch {
    }
    try {
      switch (cfg.op) {
        case "labels.add": {
          if (values.length === 0) break;
          try {
            if (process.env.VISOR_OUTPUT_FORMAT !== "json")
              logger.step(`[github-ops] labels.add -> ${JSON.stringify(values)}`);
          } catch {
          }
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
      try {
        logger.error(`[github-ops] op_failed ${cfg.op}: ${msg}`);
      } catch {
      }
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
  /**
   * Create a secure sandbox for evaluating small expressions without access to process/env
   */
  getSecureSandbox() {
    if (this.sandbox) return this.sandbox;
    this.sandbox = createSecureSandbox();
    return this.sandbox;
  }
};

// src/providers/claude-code-check-provider.ts
import fs5 from "fs/promises";
import path7 from "path";

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
    const isAbsolutePath = path7.isAbsolute(str);
    const hasTypicalFileChars = /^[a-zA-Z0-9._\-\/\\:~]+$/.test(str);
    if (!(hasFileExtension || isRelativePath || isAbsolutePath || hasPathSeparators)) {
      return false;
    }
    if (!hasTypicalFileChars) {
      return false;
    }
    try {
      let resolvedPath;
      if (path7.isAbsolute(str)) {
        resolvedPath = path7.normalize(str);
      } else {
        resolvedPath = path7.resolve(process.cwd(), str);
      }
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
    if (path7.isAbsolute(promptPath)) {
      resolvedPath = promptPath;
    } else {
      resolvedPath = path7.resolve(process.cwd(), promptPath);
    }
    if (!path7.isAbsolute(promptPath)) {
      const normalizedPath = path7.normalize(resolvedPath);
      const currentDir = path7.resolve(process.cwd());
      if (!normalizedPath.startsWith(currentDir)) {
        throw new Error("Invalid prompt file path: path traversal detected");
      }
    }
    if (promptPath.includes("../..")) {
      throw new Error("Invalid prompt file path: path traversal detected");
    }
    try {
      const promptContent = await fs5.readFile(resolvedPath, "utf-8");
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
    return createSecureSandbox();
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
  async execute(prInfo, config, dependencyResults, context2) {
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
    const outputsObj = this.buildOutputContext(
      dependencyResults,
      config.__outputHistory
    );
    const outputsRaw = {};
    if (dependencyResults) {
      for (const [key, value] of dependencyResults.entries()) {
        if (typeof key !== "string") continue;
        if (key.endsWith("-raw")) {
          const name = key.slice(0, -4);
          const summary = value;
          outputsRaw[name] = summary.output !== void 0 ? summary.output : summary;
        }
      }
    }
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
      outputs: outputsObj,
      // Alias: outputs_history mirrors outputs.history for consistency
      outputs_history: outputsObj.history || {},
      // New: outputs_raw exposes aggregate values (e.g., full arrays for forEach parents)
      outputs_raw: outputsRaw,
      env: this.getSafeEnvironmentVariables()
    };
    logger.debug(
      `\u{1F527} Debug: Template outputs keys: ${Object.keys(templateContext.outputs || {}).join(", ")}`
    );
    try {
      const span = trace.getSpan(context.active());
      if (span) {
        captureCheckInputContext(span, templateContext);
      }
    } catch {
    }
    try {
      const checkId = config.checkName || config.id || "unknown";
      const ctxJson = JSON.stringify(templateContext);
      const { emitNdjsonSpanWithEvents: emitNdjsonSpanWithEvents2 } = (init_fallback_ndjson(), __toCommonJS(fallback_ndjson_exports));
      emitNdjsonSpanWithEvents2(
        "visor.check",
        { "visor.check.id": checkId, "visor.check.input.context": ctxJson },
        [{ name: "check.started" }, { name: "check.completed" }]
      );
    } catch {
    }
    try {
      const stepName = config.checkName || "unknown";
      const mock = context2?.hooks?.mockForStep?.(String(stepName));
      if (mock && typeof mock === "object") {
        const m = mock;
        let out = m.stdout ?? "";
        try {
          if (typeof out === "string" && (out.trim().startsWith("{") || out.trim().startsWith("["))) {
            out = JSON.parse(out);
          }
        } catch {
        }
        if (m.exit_code && m.exit_code !== 0) {
          return {
            issues: [
              {
                file: "command",
                line: 0,
                ruleId: "command/execution_error",
                message: `Mocked command exited with code ${m.exit_code}`,
                severity: "error",
                category: "logic"
              }
            ],
            // Also expose output for assertions
            output: out
          };
        }
        return { issues: [], output: out };
      }
    } catch {
    }
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
      const normalizeNodeEval = (cmd) => {
        const re = /^(?<prefix>\s*(?:\/usr\/bin\/env\s+)?node(?:\.exe)?\s+(?:-e|--eval)\s+)(['"])([\s\S]*?)\2(?<suffix>\s|$)/;
        const m = cmd.match(re);
        if (!m || !m.groups) return cmd;
        const prefix = m.groups.prefix;
        const quote = m[2];
        const code = m[3];
        const suffix = m.groups.suffix || "";
        if (!code.includes("\n")) return cmd;
        const escaped = code.replace(/\n/g, "\\n");
        return cmd.replace(re, `${prefix}${quote}${escaped}${quote}${suffix}`);
      };
      const safeCommand = normalizeNodeEval(renderedCommand);
      const { stdout, stderr } = await execAsync(safeCommand, {
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
            permissions: createPermissionHelpers(
              resolveAssociationFromEvent(prInfo.eventContext, prInfo.authorAssociation),
              detectLocalMode()
            )
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
            finalOutput = compileAndRun(
              this.sandbox,
              code,
              { scope: jsContext },
              { injectLog: false, wrapFunction: false }
            );
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
        const span = trace.getSpan(context.active());
        if (span) {
          captureCheckOutput(span, outputForDependents);
          if (transformJs && output !== finalOutput) {
            captureTransformJS(span, transformJs, output, finalOutput);
          }
        }
      } catch {
      }
      try {
        const checkId = config.checkName || config.id || "unknown";
        const outJson = JSON.stringify(result.output ?? result);
        const { emitNdjsonSpanWithEvents: emitNdjsonSpanWithEvents2 } = (init_fallback_ndjson(), __toCommonJS(fallback_ndjson_exports));
        emitNdjsonSpanWithEvents2(
          "visor.check",
          { "visor.check.id": checkId, "visor.check.output": outJson },
          [{ name: "check.started" }, { name: "check.completed" }]
        );
      } catch {
      }
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
  buildOutputContext(dependencyResults, outputHistory) {
    if (!dependencyResults) {
      return {};
    }
    const outputs = {};
    const history = {};
    for (const [checkName, result] of dependencyResults) {
      const summary = result;
      const value = summary.output !== void 0 ? summary.output : summary;
      outputs[checkName] = this.makeJsonSmart(value);
    }
    if (outputHistory) {
      for (const [checkName, historyArray] of outputHistory) {
        history[checkName] = historyArray.map((val) => this.makeJsonSmart(val));
      }
    }
    outputs.history = history;
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
    const allowedPrefixes = [];
    const { buildSandboxEnv: buildSandboxEnv2 } = (init_env_exposure(), __toCommonJS(env_exposure_exports));
    const merged = buildSandboxEnv2(process.env);
    for (const [key, value] of Object.entries(merged)) {
      safeVars[key] = String(value);
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
  async renderCommandTemplate(template, context2) {
    try {
      let tpl = template;
      if (tpl.includes("{{")) {
        tpl = tpl.replace(/\{\{([\s\S]*?)\}\}/g, (_m, inner) => {
          const fixed = String(inner).replace(/\[\"/g, "['").replace(/\"\]/g, "']");
          return `{{ ${fixed} }}`;
        });
      }
      let rendered = await this.liquid.parseAndRender(tpl, context2);
      if (/\{\{[\s\S]*?\}\}/.test(rendered)) {
        try {
          rendered = this.renderWithJsExpressions(rendered, context2);
        } catch {
        }
      }
      return rendered;
    } catch (error) {
      logger.debug(`\u{1F527} Debug: Liquid templating failed, trying JS-expression fallback: ${error}`);
      try {
        return this.renderWithJsExpressions(template, context2);
      } catch {
        return template;
      }
    }
  }
  renderWithJsExpressions(template, context2) {
    const scope = {
      pr: context2.pr,
      files: context2.files,
      outputs: context2.outputs,
      env: context2.env
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

// src/providers/memory-check-provider.ts
init_logger();
var MemoryCheckProvider = class extends CheckProvider {
  liquid;
  sandbox;
  constructor() {
    super();
    this.liquid = createExtendedLiquid({
      strictVariables: false,
      strictFilters: false
    });
  }
  /**
   * Create a secure sandbox for JavaScript execution
   */
  createSecureSandbox() {
    return createSecureSandbox();
  }
  getName() {
    return "memory";
  }
  getDescription() {
    return "Memory/state management provider for persistent key-value storage across checks";
  }
  async validateConfig(config) {
    if (!config || typeof config !== "object") {
      return false;
    }
    const cfg = config;
    if (cfg.type !== "memory") {
      return false;
    }
    if (!cfg.operation || typeof cfg.operation !== "string") {
      return false;
    }
    const operation = cfg.operation;
    const validOps = ["get", "set", "append", "increment", "delete", "clear", "list", "exec_js"];
    if (!validOps.includes(operation)) {
      return false;
    }
    if (["get", "set", "append", "increment", "delete"].includes(operation)) {
      if (!cfg.key || typeof cfg.key !== "string") {
        return false;
      }
    }
    if (["set", "append"].includes(operation)) {
      if (cfg.value === void 0 && !cfg.value_js) {
        return false;
      }
    }
    if (operation === "exec_js") {
      if (!cfg.memory_js || typeof cfg.memory_js !== "string") {
        return false;
      }
    }
    return true;
  }
  async execute(prInfo, config, dependencyResults, _sessionInfo) {
    const operation = config.operation;
    const key = config.key;
    const namespace = config.namespace;
    const memoryStore = MemoryStore.getInstance();
    const templateContext = this.buildTemplateContext(
      prInfo,
      dependencyResults,
      memoryStore,
      config.__outputHistory
    );
    let result;
    try {
      switch (operation) {
        case "get":
          result = await this.handleGet(memoryStore, key, namespace);
          break;
        case "set":
          result = await this.handleSet(memoryStore, key, config, namespace, templateContext);
          break;
        case "append":
          result = await this.handleAppend(memoryStore, key, config, namespace, templateContext);
          break;
        case "increment":
          result = await this.handleIncrement(
            memoryStore,
            key,
            config,
            namespace,
            templateContext
          );
          break;
        case "delete":
          result = await this.handleDelete(memoryStore, key, namespace);
          break;
        case "clear":
          result = await this.handleClear(memoryStore, namespace);
          break;
        case "list":
          result = await this.handleList(memoryStore, namespace);
          break;
        case "exec_js":
          result = await this.handleExecJs(memoryStore, config, templateContext);
          break;
        default:
          throw new Error(`Unknown memory operation: ${operation}`);
      }
      return {
        issues: [],
        output: result
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error in memory operation";
      logger.error(`Memory operation failed: ${errorMsg}`);
      return {
        issues: [],
        output: null,
        error: errorMsg
      };
    }
  }
  async handleGet(store, key, namespace) {
    const value = store.get(key, namespace);
    logger.debug(
      `Memory GET: ${namespace || store.getDefaultNamespace()}.${key} = ${JSON.stringify(value)}`
    );
    return value;
  }
  async handleSet(store, key, config, namespace, context2) {
    const value = await this.computeValue(config, context2);
    await store.set(key, value, namespace);
    logger.debug(
      `Memory SET: ${namespace || store.getDefaultNamespace()}.${key} = ${JSON.stringify(value)}`
    );
    return value;
  }
  async handleAppend(store, key, config, namespace, context2) {
    const value = await this.computeValue(config, context2);
    await store.append(key, value, namespace);
    const result = store.get(key, namespace);
    logger.debug(
      `Memory APPEND: ${namespace || store.getDefaultNamespace()}.${key} += ${JSON.stringify(value)} (now: ${JSON.stringify(result)})`
    );
    return result;
  }
  async handleIncrement(store, key, config, namespace, context2) {
    let amount = 1;
    if (config.value !== void 0 || config.value_js) {
      const computedValue = await this.computeValue(config, context2);
      if (typeof computedValue === "number") {
        amount = computedValue;
      } else {
        throw new Error(`Increment amount must be a number, got ${typeof computedValue}`);
      }
    }
    const result = await store.increment(key, amount, namespace);
    logger.debug(
      `Memory INCREMENT: ${namespace || store.getDefaultNamespace()}.${key} += ${amount} (now: ${result})`
    );
    return result;
  }
  async handleDelete(store, key, namespace) {
    const deleted = await store.delete(key, namespace);
    logger.debug(
      `Memory DELETE: ${namespace || store.getDefaultNamespace()}.${key} (deleted: ${deleted})`
    );
    return deleted;
  }
  async handleClear(store, namespace) {
    await store.clear(namespace);
    logger.debug(`Memory CLEAR: ${namespace ? `namespace ${namespace}` : "all namespaces"}`);
  }
  async handleList(store, namespace) {
    const keys = store.list(namespace);
    logger.debug(`Memory LIST: ${namespace || store.getDefaultNamespace()} (${keys.length} keys)`);
    return keys;
  }
  async handleExecJs(store, config, context2) {
    const script = config.memory_js;
    const pendingOps = [];
    const enhancedContext = {
      ...context2,
      memory: {
        get: (key, ns) => store.get(key, ns),
        set: (key, value, ns) => {
          const nsName = ns || store.getDefaultNamespace();
          if (!store["data"].has(nsName)) {
            store["data"].set(nsName, /* @__PURE__ */ new Map());
          }
          store["data"].get(nsName).set(key, value);
          pendingOps.push(async () => {
            if (store.getConfig().storage === "file" && store.getConfig().auto_save) {
              await store.save();
            }
          });
          return value;
        },
        append: (key, value, ns) => {
          const existing = store.get(key, ns);
          let newValue;
          if (existing === void 0) {
            newValue = [value];
          } else if (Array.isArray(existing)) {
            newValue = [...existing, value];
          } else {
            newValue = [existing, value];
          }
          const nsName = ns || store.getDefaultNamespace();
          if (!store["data"].has(nsName)) {
            store["data"].set(nsName, /* @__PURE__ */ new Map());
          }
          store["data"].get(nsName).set(key, newValue);
          pendingOps.push(async () => {
            if (store.getConfig().storage === "file" && store.getConfig().auto_save) {
              await store.save();
            }
          });
          return newValue;
        },
        increment: (key, amount = 1, ns) => {
          const existing = store.get(key, ns);
          let newValue;
          if (existing === void 0 || existing === null) {
            newValue = amount;
          } else if (typeof existing === "number") {
            newValue = existing + amount;
          } else {
            throw new Error(
              `Cannot increment non-numeric value at key '${key}' (type: ${typeof existing})`
            );
          }
          const nsName = ns || store.getDefaultNamespace();
          if (!store["data"].has(nsName)) {
            store["data"].set(nsName, /* @__PURE__ */ new Map());
          }
          store["data"].get(nsName).set(key, newValue);
          pendingOps.push(async () => {
            if (store.getConfig().storage === "file" && store.getConfig().auto_save) {
              await store.save();
            }
          });
          return newValue;
        },
        delete: (key, ns) => {
          const nsName = ns || store.getDefaultNamespace();
          const nsData = store["data"].get(nsName);
          const deleted = nsData?.delete(key) || false;
          if (deleted) {
            pendingOps.push(async () => {
              if (store.getConfig().storage === "file" && store.getConfig().auto_save) {
                await store.save();
              }
            });
          }
          return deleted;
        },
        clear: (ns) => {
          if (ns) {
            store["data"].delete(ns);
          } else {
            store["data"].clear();
          }
          pendingOps.push(async () => {
            if (store.getConfig().storage === "file" && store.getConfig().auto_save) {
              await store.save();
            }
          });
        },
        list: (ns) => store.list(ns),
        has: (key, ns) => store.has(key, ns),
        getAll: (ns) => store.getAll(ns),
        listNamespaces: () => store.listNamespaces()
      }
    };
    try {
      if (config.checkName === "aggregate-validations" || config.checkName === "aggregate") {
        if (process.env.VISOR_DEBUG === "true") {
          const hist = enhancedContext?.outputs?.history || {};
          const keys = Object.keys(hist);
          logger.debug(
            `[MemoryProvider] ${config.checkName}: history keys = [${keys.join(", ")}]`
          );
          const vf = hist["validate-fact"];
          logger.debug(
            `[MemoryProvider] ${config.checkName}: validate-fact history length = ${Array.isArray(vf) ? vf.length : "n/a"}`
          );
        }
      }
    } catch {
    }
    const result = this.evaluateJavaScriptBlock(script, enhancedContext);
    try {
      if (config.checkName === "aggregate-validations" && process.env.VISOR_DEBUG === "true") {
        const tv = store.get("total_validations", "fact-validation");
        const av = store.get("all_valid", "fact-validation");
        logger.debug(
          `[MemoryProvider] post-exec ${config.checkName} total_validations=${String(
            tv
          )} all_valid=${String(av)}`
        );
      }
    } catch {
    }
    if (pendingOps.length > 0 && store.getConfig().storage === "file" && store.getConfig().auto_save) {
      await store.save();
    }
    logger.debug(`Memory EXEC_JS: Executed custom script with ${pendingOps.length} operations`);
    return result;
  }
  /**
   * Compute value from config using value, value_js, transform, or transform_js
   */
  async computeValue(config, context2) {
    let value;
    if (config.value_js && typeof config.value_js === "string") {
      value = this.evaluateJavaScript(config.value_js, context2);
    } else {
      value = config.value;
    }
    if (config.transform && typeof config.transform === "string") {
      const rendered = await this.liquid.parseAndRender(config.transform, {
        ...context2,
        value
      });
      value = rendered;
    }
    if (config.transform_js && typeof config.transform_js === "string") {
      value = this.evaluateJavaScript(config.transform_js, { ...context2, value });
    }
    return value;
  }
  /**
   * Evaluate JavaScript expression in context using SandboxJS for secure execution
   */
  evaluateJavaScript(expression, context2) {
    if (!this.sandbox) {
      this.sandbox = this.createSecureSandbox();
    }
    try {
      const scope = { ...context2 };
      return compileAndRun(this.sandbox, `return (${expression});`, scope, {
        injectLog: true,
        wrapFunction: false,
        logPrefix: "[memory:value_js]"
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      throw new Error(`Failed to evaluate value_js: ${errorMsg}`);
    }
  }
  /**
   * Evaluate JavaScript block (multi-line script) using SandboxJS for secure execution
   * Unlike evaluateJavaScript, this supports full scripts with statements, not just expressions
   */
  evaluateJavaScriptBlock(script, context2) {
    if (!this.sandbox) {
      this.sandbox = this.createSecureSandbox();
    }
    try {
      const scope = { ...context2 };
      return compileAndRun(this.sandbox, script, scope, {
        injectLog: true,
        wrapFunction: false,
        logPrefix: "[memory:exec_js]"
      });
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      logger.error(`[memory-js] Script execution error: ${errorMsg}`);
      throw new Error(`Failed to execute memory_js: ${errorMsg}`);
    }
  }
  /**
   * Build template context for Liquid and JS evaluation
   */
  buildTemplateContext(prInfo, dependencyResults, memoryStore, outputHistory) {
    const context2 = {};
    context2.pr = {
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
    const outputs = {};
    const outputsRaw = {};
    const history = {};
    if (dependencyResults) {
      for (const [checkName, result] of dependencyResults.entries()) {
        if (typeof checkName !== "string") continue;
        const summary = result;
        if (typeof checkName === "string" && checkName.endsWith("-raw")) {
          const name = checkName.slice(0, -4);
          outputsRaw[name] = summary.output !== void 0 ? summary.output : summary;
        } else {
          outputs[checkName] = summary.output !== void 0 ? summary.output : summary;
        }
      }
    }
    if (outputHistory) {
      for (const [checkName, historyArray] of outputHistory) {
        history[checkName] = historyArray;
      }
    }
    outputs.history = history;
    context2.outputs = outputs;
    context2.outputs_history = history;
    context2.outputs_raw = outputsRaw;
    if (memoryStore) {
      context2.memory = {
        get: (key, ns) => memoryStore.get(key, ns),
        has: (key, ns) => memoryStore.has(key, ns),
        list: (ns) => memoryStore.list(ns),
        getAll: (ns) => memoryStore.getAll(ns),
        set: (key, value, ns) => {
          const nsName = ns || memoryStore.getDefaultNamespace();
          if (!memoryStore["data"].has(nsName)) {
            memoryStore["data"].set(nsName, /* @__PURE__ */ new Map());
          }
          memoryStore["data"].get(nsName).set(key, value);
          return true;
        },
        increment: (key, amount = 1, ns) => {
          const nsName = ns || memoryStore.getDefaultNamespace();
          const current = memoryStore.get(key, nsName);
          const numCurrent = typeof current === "number" ? current : 0;
          const newValue = numCurrent + amount;
          if (!memoryStore["data"].has(nsName)) {
            memoryStore["data"].set(nsName, /* @__PURE__ */ new Map());
          }
          memoryStore["data"].get(nsName).set(key, newValue);
          return newValue;
        }
      };
    }
    return context2;
  }
  getSupportedConfigKeys() {
    return [
      "type",
      "operation",
      "key",
      "value",
      "value_js",
      "memory_js",
      "transform",
      "transform_js",
      "namespace",
      "depends_on",
      "group",
      "command",
      "on",
      "if",
      "fail_if",
      "on_fail",
      "on_success"
    ];
  }
  async isAvailable() {
    return true;
  }
  getRequirements() {
    return [
      "No external dependencies required",
      "Used for state management and persistent storage across checks"
    ];
  }
};

// src/providers/mcp-check-provider.ts
init_logger();
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
var McpCheckProvider = class extends CheckProvider {
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
  /**
   * Create a secure sandbox for JavaScript execution
   * - Uses Sandbox.SAFE_GLOBALS which excludes: Function, eval, require, process, etc.
   * - Only allows explicitly whitelisted prototype methods
   * - No access to filesystem, network, or system resources
   */
  createSecureSandbox() {
    return createSecureSandbox();
  }
  getName() {
    return "mcp";
  }
  getDescription() {
    return "Call MCP tools directly using stdio, SSE, or Streamable HTTP transport";
  }
  async validateConfig(config) {
    if (!config || typeof config !== "object") {
      return false;
    }
    const cfg = config;
    if (!cfg.method || typeof cfg.method !== "string") {
      logger.error("MCP check requires a method name");
      return false;
    }
    const transport = cfg.transport || "stdio";
    if (transport === "stdio") {
      if (!cfg.command || typeof cfg.command !== "string") {
        logger.error("MCP stdio transport requires a command");
        return false;
      }
      if (/[;&|`$(){}[\]]/.test(cfg.command)) {
        logger.error("MCP stdio command contains potentially unsafe characters");
        return false;
      }
    } else if (transport === "sse" || transport === "http") {
      if (!cfg.url || typeof cfg.url !== "string") {
        logger.error(`MCP ${transport} transport requires a URL`);
        return false;
      }
      try {
        const parsedUrl = new URL(cfg.url);
        if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
          logger.error(
            `Invalid URL protocol for MCP ${transport} transport: ${parsedUrl.protocol}. Only http: and https: are allowed.`
          );
          return false;
        }
      } catch {
        logger.error(`Invalid URL format for MCP ${transport} transport: ${cfg.url}`);
        return false;
      }
    } else {
      logger.error(`Invalid MCP transport: ${transport}. Must be 'stdio', 'sse', or 'http'`);
      return false;
    }
    return true;
  }
  async execute(prInfo, config, dependencyResults) {
    const cfg = config;
    try {
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
      let methodArgs = cfg.methodArgs || {};
      if (cfg.argsTransform) {
        const rendered = await this.liquid.parseAndRender(cfg.argsTransform, templateContext);
        try {
          methodArgs = JSON.parse(rendered);
        } catch (error) {
          logger.error(`Failed to parse argsTransform as JSON: ${error}`);
          return {
            issues: [
              {
                file: "mcp",
                line: 0,
                ruleId: "mcp/args_transform_error",
                message: `Failed to parse argsTransform: ${error instanceof Error ? error.message : "Unknown error"}`,
                severity: "error",
                category: "logic"
              }
            ]
          };
        }
      }
      const result = await this.executeMcpMethod(cfg, methodArgs);
      let finalOutput = result;
      if (cfg.transform) {
        try {
          const transformContext = {
            ...templateContext,
            output: result
          };
          const rendered = await this.liquid.parseAndRender(cfg.transform, transformContext);
          try {
            finalOutput = JSON.parse(rendered.trim());
          } catch {
            finalOutput = rendered.trim();
          }
        } catch (error) {
          logger.error(`Failed to apply Liquid transform: ${error}`);
          return {
            issues: [
              {
                file: "mcp",
                line: 0,
                ruleId: "mcp/transform_error",
                message: `Failed to apply transform: ${error instanceof Error ? error.message : "Unknown error"}`,
                severity: "error",
                category: "logic"
              }
            ]
          };
        }
      }
      if (cfg.transform_js) {
        try {
          if (!this.sandbox) {
            this.sandbox = this.createSecureSandbox();
          }
          const scope = {
            output: finalOutput,
            pr: templateContext.pr,
            files: templateContext.files,
            outputs: templateContext.outputs,
            env: templateContext.env
          };
          finalOutput = compileAndRun(
            this.sandbox,
            `return (${cfg.transform_js});`,
            scope,
            { injectLog: true, wrapFunction: false, logPrefix: "[mcp:transform_js]" }
          );
        } catch (error) {
          logger.error(`Failed to apply JavaScript transform: ${error}`);
          return {
            issues: [
              {
                file: "mcp",
                line: 0,
                ruleId: "mcp/transform_js_error",
                message: `Failed to apply JavaScript transform: ${error instanceof Error ? error.message : "Unknown error"}`,
                severity: "error",
                category: "logic"
              }
            ]
          };
        }
      }
      const extracted = this.extractIssuesFromOutput(finalOutput);
      if (extracted) {
        return {
          issues: extracted.issues,
          ...extracted.remainingOutput ? { output: extracted.remainingOutput } : {}
        };
      }
      return {
        issues: [],
        ...finalOutput ? { output: finalOutput } : {}
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      logger.error(`MCP check failed: ${errorMessage}`);
      return {
        issues: [
          {
            file: "mcp",
            line: 0,
            ruleId: "mcp/execution_error",
            message: `MCP check failed: ${errorMessage}`,
            severity: "error",
            category: "logic"
          }
        ]
      };
    }
  }
  /**
   * Execute an MCP method using the configured transport
   */
  async executeMcpMethod(config, methodArgs) {
    const transport = config.transport || "stdio";
    const timeout = (config.timeout || 60) * 1e3;
    if (transport === "stdio") {
      return await this.executeStdioMethod(config, methodArgs, timeout);
    } else if (transport === "sse") {
      return await this.executeSseMethod(config, methodArgs, timeout);
    } else if (transport === "http") {
      return await this.executeHttpMethod(config, methodArgs, timeout);
    } else {
      throw new Error(`Unsupported transport: ${transport}`);
    }
  }
  /**
   * Generic method to execute MCP method with any transport
   */
  async executeWithTransport(transport, config, methodArgs, timeout, transportName) {
    const client = new Client(
      {
        name: "visor-mcp-client",
        version: "1.0.0"
      },
      {
        capabilities: {}
      }
    );
    try {
      let timeoutId;
      try {
        await Promise.race([
          client.connect(transport),
          new Promise((_, reject) => {
            timeoutId = setTimeout(() => reject(new Error("Connection timeout")), timeout);
          })
        ]);
      } finally {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
      }
      logger.debug(`Connected to MCP server via ${transportName}`);
      if (transport instanceof StreamableHTTPClientTransport && transport.sessionId) {
        logger.debug(`MCP Session ID: ${transport.sessionId}`);
      }
      try {
        const toolsResult = await client.listTools();
        logger.debug(`Available MCP tools: ${JSON.stringify(toolsResult?.tools || [])}`);
      } catch (error) {
        logger.debug(`Could not list MCP tools: ${error}`);
      }
      let callTimeoutId;
      try {
        const result = await Promise.race([
          client.callTool({
            name: config.method,
            arguments: methodArgs
          }),
          new Promise((_, reject) => {
            callTimeoutId = setTimeout(() => reject(new Error("Request timeout")), timeout);
          })
        ]);
        logger.debug(`MCP method result: ${JSON.stringify(result)}`);
        return result;
      } finally {
        if (callTimeoutId) {
          clearTimeout(callTimeoutId);
        }
      }
    } finally {
      try {
        await client.close();
      } catch (error) {
        logger.debug(`Error closing MCP client: ${error}`);
      }
    }
  }
  /**
   * Execute MCP method using stdio transport
   */
  async executeStdioMethod(config, methodArgs, timeout) {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: config.env,
      cwd: config.workingDirectory
    });
    return this.executeWithTransport(
      transport,
      config,
      methodArgs,
      timeout,
      `stdio: ${config.command}`
    );
  }
  /**
   * Execute MCP method using SSE transport
   */
  async executeSseMethod(config, methodArgs, timeout) {
    const requestInit = {};
    if (config.headers) {
      requestInit.headers = EnvironmentResolver.resolveHeaders(config.headers);
    }
    const transport = new SSEClientTransport(new URL(config.url), {
      requestInit
    });
    return this.executeWithTransport(transport, config, methodArgs, timeout, `SSE: ${config.url}`);
  }
  /**
   * Execute MCP method using Streamable HTTP transport
   */
  async executeHttpMethod(config, methodArgs, timeout) {
    const requestInit = {};
    if (config.headers) {
      requestInit.headers = EnvironmentResolver.resolveHeaders(config.headers);
    }
    const transport = new StreamableHTTPClientTransport(new URL(config.url), {
      requestInit,
      sessionId: config.sessionId
    });
    return this.executeWithTransport(
      transport,
      config,
      methodArgs,
      timeout,
      `Streamable HTTP: ${config.url}`
    );
  }
  /**
   * Build output context from dependency results
   */
  buildOutputContext(dependencyResults) {
    if (!dependencyResults) {
      return {};
    }
    const outputs = {};
    for (const [checkName, result] of dependencyResults) {
      const summary = result;
      outputs[checkName] = summary.output !== void 0 ? summary.output : summary;
    }
    return outputs;
  }
  /**
   * Get safe environment variables
   */
  getSafeEnvironmentVariables() {
    const safeVars = {};
    const allowedPrefixes = [];
    const { buildSandboxEnv: buildSandboxEnv2 } = (init_env_exposure(), __toCommonJS(env_exposure_exports));
    const merged = buildSandboxEnv2(process.env);
    for (const [key, value] of Object.entries(merged)) {
      safeVars[key] = String(value);
    }
    safeVars["PWD"] = process.cwd();
    return safeVars;
  }
  /**
   * Extract issues from MCP output
   */
  extractIssuesFromOutput(output) {
    if (output === null || output === void 0) {
      return null;
    }
    if (typeof output === "string") {
      try {
        const parsed = JSON.parse(output);
        return this.extractIssuesFromOutput(parsed);
      } catch {
        return null;
      }
    }
    if (Array.isArray(output)) {
      const issues = this.normalizeIssueArray(output);
      if (issues) {
        return { issues, remainingOutput: void 0 };
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
        return {
          issues,
          remainingOutput: Object.keys(remaining).length > 0 ? remaining : void 0
        };
      }
      const singleIssue = this.normalizeIssue(record);
      if (singleIssue) {
        return { issues: [singleIssue], remainingOutput: void 0 };
      }
    }
    return null;
  }
  /**
   * Normalize an array of issues
   */
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
  /**
   * Normalize a single issue
   */
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
    const ruleId = this.toTrimmedString(data.ruleId || data.rule || data.id || data.check) || "mcp";
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
  getSupportedConfigKeys() {
    return [
      "type",
      "transport",
      "command",
      "args",
      "env",
      "workingDirectory",
      "url",
      "headers",
      "sessionId",
      "method",
      "methodArgs",
      "argsTransform",
      "transform",
      "transform_js",
      "timeout",
      "depends_on",
      "on",
      "if",
      "group"
    ];
  }
  async isAvailable() {
    return true;
  }
  getRequirements() {
    return ["MCP method name specified", "Transport configuration (stdio: command, sse/http: url)"];
  }
};

// src/utils/interactive-prompt.ts
import * as readline from "readline";
var colors = {
  reset: "\x1B[0m",
  dim: "\x1B[2m",
  bold: "\x1B[1m",
  cyan: "\x1B[36m",
  green: "\x1B[32m",
  yellow: "\x1B[33m",
  gray: "\x1B[90m"
};
var supportsUnicode = process.env.LANG?.includes("UTF-8") || process.platform === "darwin";
var box = supportsUnicode ? {
  topLeft: "\u250C",
  topRight: "\u2510",
  bottomLeft: "\u2514",
  bottomRight: "\u2518",
  horizontal: "\u2500",
  vertical: "\u2502",
  leftT: "\u251C",
  rightT: "\u2524"
} : {
  topLeft: "+",
  topRight: "+",
  bottomLeft: "+",
  bottomRight: "+",
  horizontal: "-",
  vertical: "|",
  leftT: "+",
  rightT: "+"
};
function formatTime(ms) {
  const seconds = Math.ceil(ms / 1e3);
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}
function drawLine(char, width) {
  return char.repeat(width);
}
function wrapText(text, width) {
  const words = text.split(" ");
  const lines = [];
  let currentLine = "";
  for (const word of words) {
    if (currentLine.length + word.length + 1 <= width) {
      currentLine += (currentLine ? " " : "") + word;
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    }
  }
  if (currentLine) lines.push(currentLine);
  return lines;
}
function displayPromptUI(options, remainingMs) {
  const width = Math.min(process.stdout.columns || 80, 80) - 4;
  const icon = supportsUnicode ? "\u{1F4AC}" : ">";
  console.log("\n");
  console.log(`${box.topLeft}${drawLine(box.horizontal, width + 2)}${box.topRight}`);
  console.log(
    `${box.vertical} ${colors.bold}${icon} Human Input Required${colors.reset}${" ".repeat(
      width - 22
    )} ${box.vertical}`
  );
  console.log(`${box.leftT}${drawLine(box.horizontal, width + 2)}${box.rightT}`);
  console.log(`${box.vertical} ${" ".repeat(width)} ${box.vertical}`);
  const promptLines = wrapText(options.prompt, width - 2);
  for (const line of promptLines) {
    console.log(
      `${box.vertical} ${colors.cyan}${line}${colors.reset}${" ".repeat(
        width - line.length
      )} ${box.vertical}`
    );
  }
  console.log(`${box.vertical} ${" ".repeat(width)} ${box.vertical}`);
  const instruction = options.multiline ? "(Type your response, press Ctrl+D when done)" : "(Type your response and press Enter)";
  console.log(
    `${box.vertical} ${colors.dim}${instruction}${colors.reset}${" ".repeat(
      width - instruction.length
    )} ${box.vertical}`
  );
  if (options.placeholder && !options.multiline) {
    console.log(
      `${box.vertical} ${colors.dim}${options.placeholder}${colors.reset}${" ".repeat(
        width - options.placeholder.length
      )} ${box.vertical}`
    );
  }
  console.log(`${box.vertical} ${" ".repeat(width)} ${box.vertical}`);
  if (remainingMs !== void 0 && options.timeout) {
    const timeIcon = supportsUnicode ? "\u23F1 " : "Time: ";
    const timeStr = `${timeIcon} ${formatTime(remainingMs)} remaining`;
    console.log(
      `${box.vertical} ${colors.yellow}${timeStr}${colors.reset}${" ".repeat(
        width - timeStr.length
      )} ${box.vertical}`
    );
  }
  console.log(`${box.bottomLeft}${drawLine(box.horizontal, width + 2)}${box.bottomRight}`);
  console.log("");
  process.stdout.write(`${colors.green}>${colors.reset} `);
}
async function interactivePrompt(options) {
  return new Promise((resolve4, reject) => {
    let input = "";
    let timeoutId;
    let countdownInterval;
    let remainingMs = options.timeout;
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true
    });
    displayPromptUI(options, remainingMs);
    const cleanup = () => {
      if (timeoutId) clearTimeout(timeoutId);
      if (countdownInterval) clearInterval(countdownInterval);
      rl.close();
    };
    const finish = (value) => {
      cleanup();
      console.log("");
      resolve4(value);
    };
    if (options.timeout) {
      timeoutId = setTimeout(() => {
        cleanup();
        console.log(`
${colors.yellow}\u23F1  Timeout reached${colors.reset}`);
        if (options.defaultValue !== void 0) {
          console.log(
            `${colors.gray}Using default value: ${options.defaultValue}${colors.reset}
`
          );
          resolve4(options.defaultValue);
        } else {
          reject(new Error("Input timeout"));
        }
      }, options.timeout);
      if (remainingMs) {
        countdownInterval = setInterval(() => {
          remainingMs = remainingMs - 1e3;
          if (remainingMs <= 0) {
            if (countdownInterval) clearInterval(countdownInterval);
          }
        }, 1e3);
      }
    }
    if (options.multiline) {
      rl.on("line", (line) => {
        input += (input ? "\n" : "") + line;
      });
      rl.on("close", () => {
        cleanup();
        const trimmed = input.trim();
        if (!trimmed && !options.allowEmpty) {
          console.log(`${colors.yellow}\u26A0  Empty input not allowed${colors.reset}`);
          reject(new Error("Empty input not allowed"));
        } else {
          finish(trimmed);
        }
      });
    } else {
      rl.question("", (answer) => {
        const trimmed = answer.trim();
        if (!trimmed && !options.allowEmpty && !options.defaultValue) {
          cleanup();
          console.log(`${colors.yellow}\u26A0  Empty input not allowed${colors.reset}`);
          reject(new Error("Empty input not allowed"));
        } else {
          finish(trimmed || options.defaultValue || "");
        }
      });
    }
    rl.on("SIGINT", () => {
      cleanup();
      console.log("\n\n" + colors.yellow + "\u26A0  Cancelled by user" + colors.reset);
      reject(new Error("Cancelled by user"));
    });
  });
}
async function simplePrompt(prompt) {
  return new Promise((resolve4) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout
    });
    rl.question(`${prompt}
> `, (answer) => {
      rl.close();
      resolve4(answer.trim());
    });
  });
}

// src/utils/stdin-reader.ts
function isStdinAvailable() {
  return !process.stdin.isTTY;
}
async function readStdin(timeout, maxSize = 1024 * 1024) {
  return new Promise((resolve4, reject) => {
    let data = "";
    let timeoutId;
    if (timeout) {
      timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error(`Stdin read timeout after ${timeout}ms`));
      }, timeout);
    }
    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      process.stdin.removeListener("data", onData);
      process.stdin.removeListener("end", onEnd);
      process.stdin.removeListener("error", onError);
      process.stdin.pause();
    };
    const onData = (chunk) => {
      data += chunk.toString();
      if (data.length > maxSize) {
        cleanup();
        reject(new Error(`Input exceeds maximum size of ${maxSize} bytes`));
      }
    };
    const onEnd = () => {
      cleanup();
      resolve4(data.trim());
    };
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    process.stdin.on("error", onError);
    process.stdin.resume();
  });
}
async function tryReadStdin(timeout, maxSize = 1024 * 1024) {
  if (!isStdinAvailable()) {
    return null;
  }
  try {
    return await readStdin(timeout, maxSize);
  } catch {
    return null;
  }
}

// src/providers/human-input-check-provider.ts
import * as fs6 from "fs";
import * as path8 from "path";
var HumanInputCheckProvider = class _HumanInputCheckProvider extends CheckProvider {
  /**
   * @deprecated Use ExecutionContext.cliMessage instead
   * Kept for backward compatibility
   */
  static cliMessage;
  /**
   * @deprecated Use ExecutionContext.hooks instead
   * Kept for backward compatibility
   */
  static hooks = {};
  /**
   * Set the CLI message value (from --message argument)
   * @deprecated Use ExecutionContext.cliMessage instead
   */
  static setCLIMessage(message) {
    _HumanInputCheckProvider.cliMessage = message;
  }
  /**
   * Get the current CLI message value
   * @deprecated Use ExecutionContext.cliMessage instead
   */
  static getCLIMessage() {
    return _HumanInputCheckProvider.cliMessage;
  }
  /**
   * Set hooks for SDK mode
   * @deprecated Use ExecutionContext.hooks instead
   */
  static setHooks(hooks) {
    _HumanInputCheckProvider.hooks = hooks;
  }
  getName() {
    return "human-input";
  }
  getDescription() {
    return "Prompts for human input during workflow execution (CLI interactive or SDK hook)";
  }
  async validateConfig(config) {
    if (!config || typeof config !== "object") {
      return false;
    }
    const cfg = config;
    if (cfg.type !== "human-input") {
      return false;
    }
    if (!cfg.prompt || typeof cfg.prompt !== "string") {
      console.error('human-input check requires a "prompt" field');
      return false;
    }
    return true;
  }
  /**
   * Check if a string looks like a file path
   */
  looksLikePath(str) {
    return str.includes("/") || str.includes("\\");
  }
  /**
   * Sanitize user input to prevent injection attacks in dependent checks
   * Removes potentially dangerous characters while preserving useful input
   */
  sanitizeInput(input) {
    let sanitized = input.replace(/\0/g, "");
    sanitized = sanitized.replace(/[\x00-\x08\x0B-\x0C\x0E-\x1F\x7F]/g, "");
    const maxLength = 100 * 1024;
    if (sanitized.length > maxLength) {
      sanitized = sanitized.substring(0, maxLength);
    }
    return sanitized;
  }
  /**
   * Try to read message from file if it exists
   * Validates path to prevent directory traversal attacks
   */
  async tryReadFile(filePath) {
    try {
      const absolutePath = path8.isAbsolute(filePath) ? filePath : path8.resolve(process.cwd(), filePath);
      const normalizedPath = path8.normalize(absolutePath);
      const cwd = process.cwd();
      if (!normalizedPath.startsWith(cwd + path8.sep) && normalizedPath !== cwd) {
        return null;
      }
      try {
        await fs6.promises.access(normalizedPath, fs6.constants.R_OK);
        const stats = await fs6.promises.stat(normalizedPath);
        if (!stats.isFile()) {
          return null;
        }
        const content = await fs6.promises.readFile(normalizedPath, "utf-8");
        return content.trim();
      } catch {
        return null;
      }
    } catch {
    }
    return null;
  }
  /**
   * Get user input through various methods
   */
  async getUserInput(checkName, config, context2) {
    const prompt = config.prompt || "Please provide input:";
    const placeholder = config.placeholder || "Enter your response...";
    const allowEmpty = config.allow_empty ?? false;
    const multiline = config.multiline ?? false;
    const timeout = config.timeout ? config.timeout * 1e3 : void 0;
    const defaultValue = config.default;
    const cliMessage = context2?.cliMessage ?? _HumanInputCheckProvider.cliMessage;
    if (cliMessage !== void 0) {
      const message = cliMessage;
      if (this.looksLikePath(message)) {
        const fileContent = await this.tryReadFile(message);
        if (fileContent !== null) {
          return fileContent;
        }
      }
      return message;
    }
    if (process.env.VISOR_TEST_MODE !== "true") {
      const stdinInput = await tryReadStdin(timeout);
      if (stdinInput !== null && stdinInput.length > 0) {
        return stdinInput;
      }
    }
    const hooks = context2?.hooks ?? _HumanInputCheckProvider.hooks;
    if (hooks?.onHumanInput) {
      const request = {
        checkId: checkName,
        prompt,
        placeholder,
        allowEmpty,
        multiline,
        timeout,
        default: defaultValue
      };
      try {
        const result = await hooks.onHumanInput(request);
        return result;
      } catch (error) {
        throw new Error(
          `Hook onHumanInput failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    if (process.stdin.isTTY) {
      try {
        const result = await interactivePrompt({
          prompt,
          placeholder,
          multiline,
          timeout,
          defaultValue,
          allowEmpty
        });
        return result;
      } catch (error) {
        throw new Error(
          `Interactive prompt failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    try {
      const result = await simplePrompt(prompt);
      if (!result && !allowEmpty && !defaultValue) {
        throw new Error("Empty input not allowed");
      }
      return result || defaultValue || "";
    } catch (error) {
      throw new Error(
        `Simple prompt failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  async execute(_prInfo, config, _dependencyResults, context2) {
    const checkName = config.checkName || "human-input";
    try {
      const userInput = await this.getUserInput(checkName, config, context2);
      const sanitizedInput = this.sanitizeInput(userInput);
      return {
        issues: [],
        output: sanitizedInput
      };
    } catch (error) {
      return {
        issues: [
          {
            file: "",
            line: 0,
            ruleId: "human-input-error",
            message: `Failed to get user input: ${error instanceof Error ? error.message : String(error)}`,
            severity: "error",
            category: "logic"
          }
        ]
      };
    }
  }
  getSupportedConfigKeys() {
    return [
      "type",
      "prompt",
      "placeholder",
      "allow_empty",
      "multiline",
      "timeout",
      "default",
      "depends_on",
      "on",
      "if",
      "group"
    ];
  }
  async isAvailable() {
    return true;
  }
  getRequirements() {
    return [
      "No external dependencies required",
      "Works in CLI mode with --message argument, piped stdin, or interactive prompts",
      "SDK mode requires onHumanInput hook to be configured"
    ];
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
    this.register(new MemoryCheckProvider());
    this.register(new GitHubOpsProvider());
    this.register(new HumanInputCheckProvider());
    try {
      this.register(new ClaudeCodeCheckProvider());
    } catch (error) {
      console.error(
        `Warning: Failed to register ClaudeCodeCheckProvider: ${error instanceof Error ? error.message : "Unknown error"}`
      );
    }
    try {
      this.register(new McpCheckProvider());
    } catch (error) {
      console.error(
        `Warning: Failed to register McpCheckProvider: ${error instanceof Error ? error.message : "Unknown error"}`
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
var FailureConditionEvaluator = class _FailureConditionEvaluator {
  sandbox;
  constructor() {
  }
  /**
   * Create a secure sandbox with whitelisted functions and globals
   */
  createSecureSandbox() {
    return createSecureSandbox();
  }
  /**
   * Evaluate simple fail_if condition
   */
  async evaluateSimpleCondition(checkName, checkSchema, checkGroup, reviewSummary, expression, previousOutputs, authorAssociation) {
    const context2 = this.buildEvaluationContext(
      checkName,
      checkSchema,
      checkGroup,
      reviewSummary,
      previousOutputs,
      authorAssociation
    );
    try {
      try {
        const isObj = context2.output && typeof context2.output === "object";
        const keys = isObj ? Object.keys(context2.output).join(",") : typeof context2.output;
        let errorVal = void 0;
        if (isObj && context2.output.error !== void 0)
          errorVal = context2.output.error;
        (init_logger(), __toCommonJS(logger_exports)).logger.debug(
          `  fail_if: evaluating '${expression}' with output keys=${keys} error=${String(errorVal)}`
        );
      } catch {
      }
      const res = this.evaluateExpression(expression, context2);
      if (res === true) {
        try {
          addEvent("fail_if.triggered", {
            check: checkName,
            scope: "check",
            name: `${checkName}_fail_if`,
            expression,
            severity: "error"
          });
        } catch {
        }
        try {
          const { emitNdjsonSpanWithEvents: emitNdjsonSpanWithEvents2 } = (init_fallback_ndjson(), __toCommonJS(fallback_ndjson_exports));
          emitNdjsonSpanWithEvents2(
            "visor.fail_if",
            { check: checkName, scope: "check", name: `${checkName}_fail_if` },
            [
              {
                name: "fail_if.triggered",
                attrs: {
                  check: checkName,
                  scope: "check",
                  name: `${checkName}_fail_if`,
                  expression,
                  severity: "error"
                }
              }
            ]
          );
        } catch {
        }
      }
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
    const context2 = {
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
      return this.evaluateExpression(expression, context2);
    } catch (error) {
      console.warn(`Failed to evaluate if expression for check '${checkName}': ${error}`);
      return false;
    }
  }
  /**
   * Evaluate all failure conditions for a check result
   */
  async evaluateConditions(checkName, checkSchema, checkGroup, reviewSummary, globalConditions, checkConditions, previousOutputs, authorAssociation) {
    const context2 = this.buildEvaluationContext(
      checkName,
      checkSchema,
      checkGroup,
      reviewSummary,
      previousOutputs,
      authorAssociation
    );
    const results = [];
    if (globalConditions) {
      const globalResults = await this.evaluateConditionSet(globalConditions, context2, "global");
      results.push(...globalResults);
    }
    if (checkConditions) {
      const checkResults = await this.evaluateConditionSet(checkConditions, context2, "check");
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
            context2.output
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
  async evaluateConditionSet(conditions, context2, source) {
    const results = [];
    for (const [conditionName, condition] of Object.entries(conditions)) {
      try {
        addEvent("fail_if.evaluated", {
          check: context2.checkName,
          scope: source,
          name: conditionName,
          expression: this.extractExpression(condition)
        });
      } catch {
      }
      try {
        const { emitNdjsonSpanWithEvents: emitNdjsonSpanWithEvents2 } = (init_fallback_ndjson(), __toCommonJS(fallback_ndjson_exports));
        emitNdjsonSpanWithEvents2(
          "visor.fail_if",
          { check: context2.checkName || "unknown", scope: source, name: conditionName },
          [
            {
              name: "fail_if.evaluated",
              attrs: {
                check: context2.checkName,
                scope: source,
                name: conditionName,
                expression: this.extractExpression(condition)
              }
            }
          ]
        );
      } catch {
      }
      try {
        const result = await this.evaluateSingleCondition(conditionName, condition, context2);
        results.push(result);
        if (result.failed) {
          try {
            addEvent("fail_if.triggered", {
              check: context2.checkName,
              scope: source,
              name: conditionName,
              expression: result.expression,
              severity: result.severity,
              halt_execution: result.haltExecution
            });
          } catch {
          }
          try {
            addFailIfTriggered(context2.checkName || "unknown", source);
          } catch {
          }
        }
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
  async evaluateSingleCondition(conditionName, condition, context2) {
    const expression = this.extractExpression(condition);
    const config = this.extractConditionConfig(condition);
    try {
      const failed = this.evaluateExpression(expression, context2);
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
  evaluateExpression(condition, context2) {
    try {
      const normalize2 = (expr) => {
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
      const hasIssueWith = hasIssue;
      const hasFileWith = hasFileMatching;
      const permissionHelpers = createPermissionHelpers(
        context2.authorAssociation,
        detectLocalMode()
      );
      const hasMinPermission = permissionHelpers.hasMinPermission;
      const isOwner = permissionHelpers.isOwner;
      const isMember = permissionHelpers.isMember;
      const isCollaborator = permissionHelpers.isCollaborator;
      const isContributor = permissionHelpers.isContributor;
      const isFirstTimer = permissionHelpers.isFirstTimer;
      const output = context2.output || {};
      const issues = output.issues || [];
      const metadata = context2.metadata || {
        checkName: context2.checkName || "",
        schema: context2.schema || "",
        group: context2.group || "",
        criticalIssues: issues.filter((i) => i.severity === "critical").length,
        errorIssues: issues.filter((i) => i.severity === "error").length,
        warningIssues: issues.filter((i) => i.severity === "warning").length,
        infoIssues: issues.filter((i) => i.severity === "info").length,
        totalIssues: issues.length,
        hasChanges: context2.hasChanges || false
      };
      const criticalIssues = metadata.criticalIssues;
      const errorIssues = metadata.errorIssues;
      const totalIssues = metadata.totalIssues;
      const warningIssues = metadata.warningIssues;
      const infoIssues = metadata.infoIssues;
      const checkName = context2.checkName || "";
      const schema = context2.schema || "";
      const group = context2.group || "";
      const branch = context2.branch || "unknown";
      const baseBranch = context2.baseBranch || "main";
      const filesChanged = context2.filesChanged || [];
      const filesCount = context2.filesCount || 0;
      const event = context2.event || "manual";
      const env = context2.env || {};
      const outputs = context2.outputs || {};
      const debugData = context2.debug || null;
      const memoryStore = MemoryStore.getInstance();
      const memoryAccessor = {
        get: (key, ns) => memoryStore.get(key, ns),
        has: (key, ns) => memoryStore.has(key, ns),
        list: (ns) => memoryStore.list(ns),
        getAll: (ns) => memoryStore.getAll(ns)
      };
      const scope = {
        // Primary context variables
        output,
        outputs,
        debug: debugData,
        // Memory accessor for fail_if expressions
        memory: memoryAccessor,
        // Legacy compatibility variables
        issues,
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
        const normalizedExpr = normalize2(condition);
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
    const memoryStore = MemoryStore.getInstance();
    const context2 = {
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
      // Add memory accessor for fail_if expressions
      memory: {
        get: (key, ns) => memoryStore.get(key, ns),
        has: (key, ns) => memoryStore.has(key, ns),
        list: (ns) => memoryStore.list(ns),
        getAll: (ns) => memoryStore.getAll(ns)
      },
      // Add basic context info for failure conditions
      checkName,
      schema: checkSchema,
      group: checkGroup,
      authorAssociation
    };
    if (debug) {
      context2.debug = {
        errors: debug.errors || [],
        processingTime: debug.processingTime || 0,
        provider: debug.provider || "unknown",
        model: debug.model || "unknown"
      };
    }
    return context2;
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
    sections.push(generateFooter());
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

// src/snapshot-store.ts
var ExecutionJournal = class {
  commit = 0;
  entries = [];
  beginSnapshot() {
    return this.commit;
  }
  commitEntry(entry) {
    const committed = {
      sessionId: entry.sessionId,
      scope: entry.scope,
      checkId: entry.checkId,
      result: entry.result,
      event: entry.event,
      commitId: ++this.commit
    };
    this.entries.push(committed);
    return committed;
  }
  readVisible(sessionId, commitMax, event) {
    return this.entries.filter(
      (e) => e.sessionId === sessionId && e.commitId <= commitMax && (event ? e.event === event : true)
    );
  }
  // Lightweight helpers for debugging/metrics
  size() {
    return this.entries.length;
  }
};
var ContextView = class {
  constructor(journal, sessionId, snapshotId, scope, event) {
    this.journal = journal;
    this.sessionId = sessionId;
    this.snapshotId = snapshotId;
    this.scope = scope;
    this.event = event;
  }
  /** Return the nearest result for a check in this scope (exact item → ancestor → latest). */
  get(checkId) {
    const visible = this.journal.readVisible(this.sessionId, this.snapshotId, this.event).filter((e) => e.checkId === checkId);
    if (visible.length === 0) return void 0;
    const exact = visible.find((e) => this.sameScope(e.scope, this.scope));
    if (exact) return exact.result;
    let best;
    for (const e of visible) {
      const dist = this.ancestorDistance(e.scope, this.scope);
      if (dist >= 0 && (best === void 0 || dist < best.dist)) {
        best = { entry: e, dist };
      }
    }
    if (best) return best.entry.result;
    return visible[visible.length - 1]?.result;
  }
  /** Return an aggregate (raw) result – the shallowest scope for this check. */
  getRaw(checkId) {
    const visible = this.journal.readVisible(this.sessionId, this.snapshotId, this.event).filter((e) => e.checkId === checkId);
    if (visible.length === 0) return void 0;
    let shallow = visible[0];
    for (const e of visible) {
      if (e.scope.length < shallow.scope.length) shallow = e;
    }
    return shallow.result;
  }
  /** All results for a check up to this snapshot. */
  getHistory(checkId) {
    return this.journal.readVisible(this.sessionId, this.snapshotId, this.event).filter((e) => e.checkId === checkId).map((e) => e.result);
  }
  sameScope(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (a[i].check !== b[i].check || a[i].index !== b[i].index) return false;
    }
    return true;
  }
  // distance from ancestor to current; -1 if not ancestor
  ancestorDistance(ancestor, current) {
    if (ancestor.length > current.length) return -1;
    if (ancestor.length === 0 && current.length > 0) return -1;
    for (let i = 0; i < ancestor.length; i++) {
      if (ancestor[i].check !== current[i].check || ancestor[i].index !== current[i].index)
        return -1;
    }
    return current.length - ancestor.length;
  }
};

// src/check-execution-engine.ts
init_fallback_ndjson();
function getSafeEnvironmentVariables() {
  const { buildSandboxEnv: buildSandboxEnv2 } = (init_env_exposure(), __toCommonJS(env_exposure_exports));
  return buildSandboxEnv2(process.env);
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
  // Track history of all outputs for each check (useful for loops and goto)
  outputHistory = /* @__PURE__ */ new Map();
  // Track on_finish loop counts per forEach parent during a single execution run
  onFinishLoopCounts = /* @__PURE__ */ new Map();
  // Track how many times a forEach parent check has produced an array during this run ("waves")
  forEachWaveCounts = /* @__PURE__ */ new Map();
  // One-shot guards for post on_finish scheduling to avoid duplicate replies when
  // multiple signals (aggregator, memory, history) agree. Keyed by session + parent check.
  postOnFinishGuards = /* @__PURE__ */ new Set();
  // Snapshot+Scope journal (Phase 0: commit only, no behavior changes yet)
  journal = new ExecutionJournal();
  sessionId = `sess-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  // Event override to simulate alternate event (used during routing goto)
  routingEventOverride;
  // Execution context for providers (CLI message, hooks, etc.)
  executionContext;
  // Cached GitHub context for context elevation when running in Actions
  actionContext;
  constructor(workingDirectory, octokit) {
    this.workingDirectory = workingDirectory || process.cwd();
    this.gitAnalyzer = new GitRepositoryAnalyzer(this.workingDirectory);
    this.providerRegistry = CheckProviderRegistry.getInstance();
    this.failureEvaluator = new FailureConditionEvaluator();
    if (octokit) {
      const repoEnv = process.env.GITHUB_REPOSITORY || "";
      const [owner, repo] = repoEnv.split("/");
      if (owner && repo) {
        this.actionContext = { owner, repo, octokit };
      }
    }
    this.mockOctokit = this.createMockOctokit();
    const reviewerOctokit = octokit || this.mockOctokit;
    this.reviewer = new PRReviewer(reviewerOctokit);
  }
  sessionUUID() {
    return this.sessionId;
  }
  commitJournal(checkId, result, event, scopeOverride) {
    try {
      const scope = scopeOverride || [];
      this.journal.commitEntry({
        sessionId: this.sessionUUID(),
        scope,
        checkId,
        event,
        result
      });
    } catch {
    }
  }
  /** Build dependencyResults from a snapshot of all committed results, optionally overlaying provided results. */
  buildSnapshotDependencyResults(scope, overlay, event) {
    const snap = this.journal.beginSnapshot();
    const view = new ContextView(this.journal, this.sessionUUID(), snap, scope, event);
    const visible = /* @__PURE__ */ new Map();
    try {
      const entries = this.journal.readVisible(this.sessionUUID(), snap, event);
      const ids = Array.from(new Set(entries.map((e) => e.checkId)));
      for (const id of ids) {
        const v = view.get(id);
        if (v) visible.set(id, v);
        const raw = view.getRaw(id);
        if (raw) visible.set(`${id}-raw`, raw);
      }
      if (overlay) {
        for (const [k, v] of overlay.entries()) {
          if (typeof k === "string" && k) {
            visible.set(k, v);
          } else {
            try {
              (init_logger(), __toCommonJS(logger_exports)).logger.warn(
                `sanitize: dropping non-string overlay key type=${typeof k}`
              );
            } catch {
            }
          }
        }
      }
    } catch {
    }
    return visible;
  }
  /** Drop any non-string keys from a results-like map (root-cause guard). */
  sanitizeResultMapKeys(m) {
    const out = /* @__PURE__ */ new Map();
    if (!m) return out;
    for (const [k, v] of m.entries()) {
      if (typeof k === "string" && k) out.set(k, v);
      else {
        try {
          (init_logger(), __toCommonJS(logger_exports)).logger.warn(
            `sanitize: dropping non-string results key type=${typeof k}`
          );
        } catch {
        }
      }
    }
    return out;
  }
  /**
   * Enrich event context with authenticated octokit instance
   * @param eventContext - The event context to enrich
   * @returns Enriched event context with octokit if available
   */
  enrichEventContext(eventContext) {
    const baseContext = eventContext || {};
    const injected = this.actionContext?.octokit || baseContext.octokit;
    if (injected) {
      return { ...baseContext, octokit: injected };
    }
    return baseContext;
  }
  /**
   * Set execution context for providers (CLI message, hooks, etc.)
   * This allows passing state without using static properties
   */
  setExecutionContext(context2) {
    this.executionContext = context2;
  }
  /**
   * Lazily create a secure sandbox for routing JS (goto_js, run_js)
   */
  getRoutingSandbox() {
    if (this.routingSandbox) return this.routingSandbox;
    this.routingSandbox = createSecureSandbox();
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
    return new Promise((resolve4) => setTimeout(resolve4, ms));
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
   * Execute a single named check inline (used by routing logic and on_finish)
   * This is extracted from executeWithRouting to be reusable
   */
  async executeCheckInline(checkId, event, context2) {
    const {
      config,
      prInfo,
      resultsMap,
      dependencyResults,
      sessionInfo,
      debug,
      eventOverride,
      scope
    } = context2;
    const log2 = (msg) => (config?.output?.pr_comment ? console.error : console.log)(msg);
    const origin = context2.origin || "inline";
    const checkConfig = config?.checks?.[checkId];
    if (!checkConfig) {
      throw new Error(`on_finish referenced unknown check '${checkId}'`);
    }
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
    const allTargetDeps = getAllDepsFromConfig(checkId);
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
          await this.executeCheckInline(depId, event, context2);
        }
      }
    }
    const providerType = checkConfig.type || "ai";
    const provider = this.providerRegistry.getProviderOrThrow(providerType);
    this.setProviderWebhookContext(provider);
    const provCfg = {
      type: providerType,
      prompt: checkConfig.prompt,
      exec: checkConfig.exec,
      focus: checkConfig.focus || this.mapCheckNameToFocus(checkId),
      schema: checkConfig.schema,
      group: checkConfig.group,
      checkName: checkId,
      eventContext: this.enrichEventContext(prInfo.eventContext),
      transform: checkConfig.transform,
      transform_js: checkConfig.transform_js,
      env: checkConfig.env,
      forEach: checkConfig.forEach,
      // Pass output history for loop/goto scenarios
      __outputHistory: this.outputHistory,
      // Include provider-specific keys (e.g., op/values for github)
      ...checkConfig,
      ai: {
        ...checkConfig.ai || {},
        timeout: checkConfig.ai?.timeout || 6e5,
        debug: !!debug
      }
    };
    const depResults = this.buildSnapshotDependencyResults(
      scope || [],
      dependencyResults,
      eventOverride || prInfo.eventType
    );
    if (debug) {
      try {
        const depPreview = {};
        for (const [k, v] of depResults.entries()) {
          const out = v?.output;
          if (out !== void 0) depPreview[k] = out;
        }
        log2(`\u{1F527} Debug: inline exec '${checkId}' deps output: ${JSON.stringify(depPreview)}`);
      } catch {
      }
    }
    if (debug) {
      const execStr = provCfg.exec;
      if (execStr) log2(`\u{1F527} Debug: inline exec '${checkId}' command: ${execStr}`);
    }
    let prInfoForInline = prInfo;
    const prevEventOverride = this.routingEventOverride;
    if (eventOverride) {
      const elevated = await this.elevateContextToPullRequest(
        { ...prInfo, eventType: eventOverride },
        eventOverride,
        log2,
        debug
      );
      if (elevated) {
        prInfoForInline = elevated;
      } else {
        prInfoForInline = { ...prInfo, eventType: eventOverride };
      }
      this.routingEventOverride = eventOverride;
      const msg = `\u21AA goto_event: inline '${checkId}' with event=${eventOverride}${elevated ? " (elevated to PR context)" : ""}`;
      if (debug) log2(`\u{1F527} Debug: ${msg}`);
      try {
        (init_logger(), __toCommonJS(logger_exports)).logger.info(msg);
      } catch {
      }
    }
    let result;
    try {
      const __provStart = Date.now();
      const inlineContext = {
        ...sessionInfo,
        ...this.executionContext
      };
      result = await withActiveSpan(
        `visor.check.${checkId}`,
        { "visor.check.id": checkId, "visor.check.type": provCfg.type || "ai" },
        async () => provider.execute(prInfoForInline, provCfg, depResults, inlineContext)
      );
      this.recordProviderDuration(checkId, Date.now() - __provStart);
    } catch (error) {
      this.routingEventOverride = prevEventOverride;
      throw error;
    } finally {
      this.routingEventOverride = prevEventOverride;
    }
    const enrichedIssues = (result.issues || []).map((issue) => ({
      ...issue,
      checkName: checkId,
      ruleId: `${checkId}/${issue.ruleId}`,
      group: checkConfig.group,
      schema: typeof checkConfig.schema === "object" ? "custom" : checkConfig.schema,
      template: checkConfig.template,
      timestamp: Date.now()
    }));
    let enriched = { ...result, issues: enrichedIssues };
    const enrichedWithOutput = enriched;
    if (enrichedWithOutput.output !== void 0) {
      this.trackOutputHistory(checkId, enrichedWithOutput.output);
    }
    if (checkConfig.forEach && Array.isArray(enrichedWithOutput.output)) {
      const forEachItems = enrichedWithOutput.output;
      const wave = (this.forEachWaveCounts.get(checkId) || 0) + 1;
      this.forEachWaveCounts.set(checkId, wave);
      log2(
        `\u{1F504} forEach check '${checkId}' returned ${forEachItems.length} items - starting iteration (wave #${wave}, origin=${origin})`
      );
      if (debug) {
        log2(
          `\u{1F527} Debug: forEach item preview: ${JSON.stringify(forEachItems[0] || {}).substring(0, 200)}`
        );
      }
      const forEachResult = {
        ...enriched,
        forEachItems,
        forEachItemResults: forEachItems.map((item) => ({
          issues: [],
          output: item
        }))
      };
      enriched = forEachResult;
      try {
        resultsMap?.set(checkId, enriched);
      } catch {
      }
      this.commitJournal(
        checkId,
        enriched,
        prInfoForInline.eventType || prInfo.eventType,
        []
      );
      const maxLoops = config?.routing?.max_loops ?? 10;
      if (wave > maxLoops) {
        try {
          logger.warn(
            `\u26D4 forEach wave guard: '${checkId}' exceeded max_loops=${maxLoops} (wave #${wave}); skipping dependents and routing`
          );
        } catch {
        }
        resultsMap?.set(checkId, enriched);
        return enriched;
      }
      const dependentChecks = Object.keys(config?.checks || {}).filter((name) => {
        const cfg = config?.checks?.[name];
        return cfg?.depends_on?.includes(checkId);
      });
      try {
        if (dependentChecks.length > 0) {
          log2(
            `\u{1F504} forEach check '${checkId}' has ${dependentChecks.length} dependents: ${dependentChecks.join(", ")}`
          );
        } else {
          log2(`\u26A0\uFE0F  forEach check '${checkId}' has NO dependents - nothing to iterate`);
        }
      } catch {
      }
      for (const depCheckName of dependentChecks) {
        const depCheckConfig = config?.checks?.[depCheckName];
        if (!depCheckConfig) continue;
        if (forEachItems.length === 0) {
          if (debug) {
            log2(`\u{1F527} Debug: Skipping forEach dependent '${depCheckName}' - no items to iterate`);
          }
          resultsMap?.set(depCheckName, { issues: [] });
          continue;
        }
        try {
          const wave2 = this.forEachWaveCounts.get(checkId) || 1;
          log2(
            `\u{1F504} Executing forEach dependent '${depCheckName}' for ${forEachItems.length} items (wave #${wave2})`
          );
        } catch {
        }
        const depResults2 = [];
        for (let itemIndex = 0; itemIndex < forEachItems.length; itemIndex++) {
          const item = forEachItems[itemIndex];
          const wave2 = this.forEachWaveCounts.get(checkId) || 1;
          log2(
            `  \u{1F504} Iteration ${itemIndex + 1}/${forEachItems.length} f|| '${depCheckName}' (wave #${wave2})`
          );
          const itemScope = [{ check: checkId, index: itemIndex }];
          try {
            this.commitJournal(
              checkId,
              { issues: [], output: item },
              prInfoForInline.eventType || prInfo.eventType,
              itemScope
            );
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            logger.error(`Failed to commit per-item journal for ${checkId}: ${msg}`);
          }
          try {
            const depProviderType = depCheckConfig.type || "ai";
            const depProvider = this.providerRegistry.getProviderOrThrow(depProviderType);
            this.setProviderWebhookContext(depProvider);
            const snapshotDeps = this.buildSnapshotDependencyResults(
              itemScope,
              void 0,
              prInfoForInline.eventType || prInfo.eventType
            );
            const res = await this.runNamedCheck(depCheckName, itemScope, {
              origin: "foreach",
              config,
              dependencyGraph: context2.dependencyGraph,
              prInfo,
              resultsMap: resultsMap || /* @__PURE__ */ new Map(),
              debug: !!debug,
              eventOverride: prInfoForInline.eventType || prInfo.eventType,
              overlay: snapshotDeps
            });
            depResults2.push(res);
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            const errorIssue = {
              file: "",
              line: 0,
              ruleId: `${depCheckName}/forEach/iteration_error`,
              message: `forEach iteration ${itemIndex + 1} failed: ${errorMsg}`,
              severity: "error",
              category: "logic"
            };
            depResults2.push({
              issues: [errorIssue]
            });
          }
        }
        const aggregatedResult = {
          issues: depResults2.flatMap((r) => r.issues || [])
        };
        resultsMap?.set(depCheckName, aggregatedResult);
        if (debug) {
          log2(
            `\u{1F527} Debug: Completed forEach dependent '${depCheckName}' with ${depResults2.length} iterations`
          );
        }
      }
    }
    resultsMap?.set(checkId, enriched);
    const isForEachAggregate = checkConfig.forEach && Array.isArray(enrichedWithOutput.output);
    if (!isForEachAggregate) {
      this.commitJournal(
        checkId,
        enriched,
        prInfoForInline.eventType || prInfo.eventType,
        scope || []
      );
    }
    if (debug) log2(`\u{1F527} Debug: inline executed '${checkId}', issues: ${enrichedIssues.length}`);
    return enriched;
  }
  /**
   * Phase 3: Unified scheduling helper
   * Runs a named check in the current session/scope and records results.
   * Used by on_success/on_fail/on_finish routing and internal inline execution.
   */
  async runNamedCheck(target, scope, opts) {
    const {
      config,
      dependencyGraph,
      prInfo,
      resultsMap,
      debug,
      sessionInfo,
      eventOverride,
      overlay
    } = opts;
    try {
      if (debug && opts.origin === "on_finish") {
        console.error(`[runNamedCheck] origin=on_finish step=${target}`);
      }
    } catch {
    }
    try {
      const tcfg = opts.config.checks?.[target];
      if (tcfg && tcfg.if) {
        const gate = await this.shouldRunCheck(
          target,
          tcfg.if,
          opts.prInfo,
          opts.resultsMap || /* @__PURE__ */ new Map(),
          !!debug,
          opts.eventOverride,
          /* failSecure */
          true
        );
        if (!gate.shouldRun) {
          const skipped = {
            issues: [
              {
                file: "",
                line: 0,
                ruleId: `${target}/__skipped`,
                message: `Skipped by if condition: ${tcfg.if}`,
                severity: "info",
                category: "logic"
              }
            ]
          };
          try {
            this.recordSkip(target, "if_condition", tcfg.if);
            logger.info(`\u23ED  Skipped (if: ${this.truncate(tcfg.if, 40)})`);
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            logger.error(`Failed to record skip for ${target}: ${msg}`);
          }
          this.commitJournal(
            target,
            skipped,
            opts.eventOverride || opts.prInfo.eventType,
            scope || []
          );
          opts.resultsMap?.set(target, skipped);
          return skipped;
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to evaluate if condition for ${target}: ${msg}`);
      const skipped = {
        issues: [
          {
            file: "",
            line: 0,
            ruleId: `${target}/__skipped`,
            message: `Skipped due to condition evaluation error`,
            severity: "info",
            category: "logic"
          }
        ]
      };
      try {
        const cond = opts.config.checks?.[target]?.if || "";
        this.recordSkip(target, "if_condition", cond);
      } catch {
      }
      this.commitJournal(
        target,
        skipped,
        opts.eventOverride || opts.prInfo.eventType,
        scope || []
      );
      opts.resultsMap?.set(target, skipped);
      return skipped;
    }
    const depOverlay = overlay ? new Map(overlay) : new Map(resultsMap);
    const depOverlaySanitized = this.sanitizeResultMapKeys(depOverlay);
    const overlayForExec = eventOverride && eventOverride !== (prInfo.eventType || "manual") ? /* @__PURE__ */ new Map() : depOverlaySanitized;
    if (!this.executionStats.has(target)) this.initializeCheckStats(target);
    const startTs = this.recordIterationStart(target);
    try {
      const res = await this.executeCheckInline(
        target,
        eventOverride || prInfo.eventType || "manual",
        {
          config,
          dependencyGraph,
          prInfo,
          resultsMap,
          // Use snapshot-only deps when eventOverride is set
          dependencyResults: overlayForExec,
          sessionInfo,
          debug,
          eventOverride,
          scope,
          origin: opts.origin || "inline"
        }
      );
      const issues = (res.issues || []).map((i) => ({ ...i }));
      const success = !this.hasFatal(issues);
      const out = res.output;
      const isForEachParent = res?.isForEach === true || Array.isArray(res?.forEachItems) || Array.isArray(out);
      this.recordIterationComplete(
        target,
        startTs,
        success,
        issues,
        isForEachParent ? void 0 : out
      );
      return res;
    } catch (e) {
      this.recordIterationComplete(target, startTs, false, [], void 0);
      throw e;
    }
  }
  /**
   * Handle on_finish hooks for forEach checks after ALL dependents complete
   */
  async handleOnFinishHooks(config, dependencyGraph, results, prInfo, debug) {
    const log2 = (msg) => (config?.output?.pr_comment ? console.error : console.log)(msg);
    try {
      if (debug) console.error("[on_finish] handler invoked");
    } catch {
    }
    const forEachChecksWithOnFinish = this.collectForEachParentsWithOnFinish(config);
    try {
      logger.info(
        `\u{1F9ED} on_finish: discovered ${forEachChecksWithOnFinish.length} forEach parent(s) with hooks`
      );
    } catch {
    }
    if (forEachChecksWithOnFinish.length === 0) {
      return;
    }
    try {
      const anyParentRan = forEachChecksWithOnFinish.some(
        ({ checkName }) => results.has(checkName)
      );
      if (!anyParentRan) {
        if (debug) log2("\u{1F9ED} on_finish: no forEach parent executed in this run \u2014 skip");
        return;
      }
    } catch {
    }
    if (debug) {
      log2(`\u{1F3AF} Processing on_finish hooks for ${forEachChecksWithOnFinish.length} forEach check(s)`);
    }
    for (const { checkName, checkConfig, onFinish } of forEachChecksWithOnFinish) {
      try {
        const forEachResult = results.get(checkName);
        if (!forEachResult) {
          try {
            logger.info(`\u23ED on_finish: no result found for "${checkName}" \u2014 skip`);
          } catch {
          }
          continue;
        }
        const forEachItems = forEachResult.forEachItems || [];
        if (forEachItems.length === 0) {
          try {
            logger.info(`\u23ED on_finish: "${checkName}" produced 0 items \u2014 skip`);
          } catch {
          }
          continue;
        }
        const node = dependencyGraph.nodes.get(checkName);
        const dependents = node?.dependents || [];
        try {
          logger.info(`\u{1F50D} on_finish: "${checkName}" \u2192 ${dependents.length} dependent(s)`);
        } catch {
        }
        const allDependentsCompleted = dependents.every((dep) => results.has(dep));
        if (!allDependentsCompleted) {
          try {
            logger.warn(
              `\u26A0\uFE0F on_finish: some dependents of "${checkName}" have no results; proceeding with on_finish anyway`
            );
          } catch {
          }
        }
        logger.info(`\u25B6 on_finish: processing for "${checkName}"`);
        const { outputsForContext, outputsHistoryForContext } = this.buildOnFinishContext(results);
        const forEachStats = {
          total: forEachItems.length,
          successful: forEachResult.forEachItemResults ? forEachResult.forEachItemResults.filter(
            (r) => r && (!r.issues || r.issues.length === 0)
          ).length : forEachItems.length,
          failed: forEachResult.forEachItemResults ? forEachResult.forEachItemResults.filter((r) => r && r.issues && r.issues.length > 0).length : 0,
          items: forEachItems
        };
        const memoryStore = MemoryStore.getInstance(this.config?.memory);
        const memoryHelpers = {
          get: (key, ns) => memoryStore.get(key, ns),
          has: (key, ns) => memoryStore.has(key, ns),
          list: (ns) => memoryStore.list(ns),
          getAll: (ns) => {
            const keys = memoryStore.list(ns);
            const result = {};
            for (const key of keys) {
              result[key] = memoryStore.get(key, ns);
            }
            return result;
          },
          set: (key, value, ns) => {
            const nsName = ns || memoryStore.getDefaultNamespace();
            if (!memoryStore["data"].has(nsName)) {
              memoryStore["data"].set(nsName, /* @__PURE__ */ new Map());
            }
            memoryStore["data"].get(nsName).set(key, value);
          },
          increment: (key, amount, ns) => {
            const current = memoryStore.get(key, ns);
            const numCurrent = typeof current === "number" ? current : 0;
            const newValue = numCurrent + amount;
            const nsName = ns || memoryStore.getDefaultNamespace();
            if (!memoryStore["data"].has(nsName)) {
              memoryStore["data"].set(nsName, /* @__PURE__ */ new Map());
            }
            memoryStore["data"].get(nsName).set(key, newValue);
            return newValue;
          }
        };
        const outputsRawForContext = {};
        try {
          for (const [name, val] of Object.entries(outputsForContext)) {
            if (name === "history") continue;
            outputsRawForContext[name] = val;
          }
        } catch {
        }
        const outputsMergedForContext = {
          ...outputsForContext,
          history: outputsHistoryForContext
        };
        const onFinishContext = {
          step: { id: checkName, tags: checkConfig.tags || [], group: checkConfig.group },
          attempt: 1,
          loop: 0,
          outputs: outputsMergedForContext,
          // Provide explicit alias for templates that prefer snake_case
          outputs_history: outputsHistoryForContext,
          outputs_raw: outputsRawForContext,
          forEach: forEachStats,
          memory: memoryHelpers,
          pr: {
            number: prInfo.number,
            title: prInfo.title,
            author: prInfo.author,
            branch: prInfo.head,
            base: prInfo.base
          },
          files: prInfo.files,
          env: getSafeEnvironmentVariables(),
          event: { name: prInfo.eventType || "manual" }
        };
        try {
          const ns = "fact-validation";
          const attemptNow = Number(memoryStore.get("fact_validation_attempt", ns) || 0);
          const usedBudget = this.onFinishLoopCounts.get(checkName) || 0;
          const maxBudget = config?.routing?.max_loops ?? 10;
          logger.info(
            `\u{1F9ED} on_finish: check="${checkName}" items=${forEachItems.length} dependents=${dependents.length} attempt=${attemptNow} budget=${usedBudget}/${maxBudget}`
          );
          const vfHist = outputsHistoryForContext["validate-fact"] || [];
          if (vfHist.length) {
            logger.debug(`\u{1F9ED} on_finish: outputs.history['validate-fact'] length=${vfHist.length}`);
          }
        } catch {
        }
        let lastRunOutput = void 0;
        {
          const maxLoops = config?.routing?.max_loops ?? 10;
          let loopCount = 0;
          const runList = Array.from(new Set([...onFinish.run || []].filter(Boolean)));
          if (runList.length > 0) {
            logger.info(`\u25B6 on_finish.run: executing [${runList.join(", ")}] for "${checkName}"`);
          }
          try {
            for (const runCheckId of runList) {
              if (++loopCount > maxLoops) {
                throw new Error(
                  `Routing loop budget exceeded (max_loops=${maxLoops}) during on_finish run`
                );
              }
              if (debug) log2(`\u{1F527} Debug: on_finish.run executing check '${runCheckId}'`);
              logger.info(`  \u25B6 Executing on_finish check: ${runCheckId}`);
              const childCfgFull = (config?.checks || {})[runCheckId];
              if (!childCfgFull) throw new Error(`Unknown check in on_finish.run: ${runCheckId}`);
              const childProvType = childCfgFull.type || "ai";
              const childProvider = this.providerRegistry.getProviderOrThrow(childProvType);
              this.setProviderWebhookContext(childProvider);
              const depOverlayForChild = new Map(results);
              const __onFinishRes = await this.runNamedCheck(runCheckId, [], {
                origin: "on_finish",
                config,
                dependencyGraph,
                prInfo,
                resultsMap: results,
                debug,
                overlay: depOverlayForChild
              });
              try {
                lastRunOutput = __onFinishRes?.output;
              } catch {
              }
              try {
                results.set(runCheckId, __onFinishRes);
              } catch {
              }
              logger.info(`  \u2713 Completed on_finish check: ${runCheckId}`);
              try {
                const childCfg = (config?.checks || {})[runCheckId];
                const childOnSuccess = childCfg?.on_success;
                if (childOnSuccess) {
                  try {
                    logger.info(
                      `  \u21AA on_finish.run: '${runCheckId}' defines on_success; evaluating run_js`
                    );
                  } catch {
                  }
                  const evalChildRunJs = async (js) => {
                    if (!js) return [];
                    try {
                      const sandbox = this.getRoutingSandbox();
                      const scope = { ...onFinishContext, output: lastRunOutput };
                      const code = `
                        const step = scope.step; const attempt = scope.attempt; const loop = scope.loop; const outputs = scope.outputs; const outputs_history = scope.outputs_history; const outputs_raw = scope.outputs_raw; const forEach = scope.forEach; const memory = scope.memory; const pr = scope.pr; const files = scope.files; const env = scope.env; const event = scope.event; const output = scope.output; const log = (...a)=> console.log('\u{1F50D} Debug:',...a);
                        const __fn = () => {
${js}
};
                        const __res = __fn();
                        return Array.isArray(__res) ? __res.filter(x => typeof x === 'string' && x) : [];
                      `;
                      const exec = sandbox.compile(code);
                      const res = exec({ scope }).run();
                      return Array.isArray(res) ? res : [];
                    } catch (e) {
                      const msg = e instanceof Error ? e.message : String(e);
                      logger.error(
                        `\u2717 on_finish.run \u2192 child on_success.run_js failed for "${runCheckId}": ${msg}`
                      );
                      return [];
                    }
                  };
                  const childDynamicRun = await evalChildRunJs(childOnSuccess.run_js);
                  const childRunList = Array.from(
                    new Set([...childOnSuccess.run || [], ...childDynamicRun].filter(Boolean))
                  );
                  if (childRunList.length > 0) {
                    logger.info(
                      `  \u25B6 on_finish.run \u2192 scheduling child on_success [${childRunList.join(", ")}] after '${runCheckId}'`
                    );
                  } else {
                    try {
                      logger.info(
                        `  \u21AA on_finish.run: child on_success produced empty run list for '${runCheckId}'`
                      );
                    } catch {
                    }
                  }
                  for (const stepId of childRunList) {
                    await this.runNamedCheck(stepId, [], {
                      origin: "on_finish",
                      config,
                      dependencyGraph,
                      prInfo,
                      resultsMap: results,
                      sessionInfo: void 0,
                      debug,
                      overlay: new Map(results)
                    });
                  }
                }
              } catch {
              }
            }
            if (runList.length > 0) logger.info(`\u2713 on_finish.run: completed for "${checkName}"`);
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            logger.error(`\u2717 on_finish.run: failed for "${checkName}": ${errorMsg}`);
            if (error instanceof Error && error.stack) {
              logger.debug(`Stack trace: ${error.stack}`);
            }
            throw error;
          }
          const evalRunJs = async (js) => {
            if (!js) return [];
            try {
              const sandbox = this.getRoutingSandbox();
              const scope = onFinishContext;
              const code = `
                const step = scope.step; const attempt = scope.attempt; const loop = scope.loop; const outputs = scope.outputs; const outputs_history = scope.outputs_history; const outputs_raw = scope.outputs_raw; const forEach = scope.forEach; const memory = scope.memory; const pr = scope.pr; const files = scope.files; const env = scope.env; const event = scope.event; const log = (...a)=> console.log('\u{1F50D} Debug:',...a);
                const __fn = () => {
${js}
};
                const __res = __fn();
                return Array.isArray(__res) ? __res.filter(x => typeof x === 'string' && x) : [];
              `;
              const exec = sandbox.compile(code);
              const res = exec({ scope }).run();
              return Array.isArray(res) ? res : [];
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              logger.error(`\u2717 on_finish.run_js: evaluation failed for "${checkName}": ${msg}`);
              if (e instanceof Error && e.stack) logger.debug(`Stack trace: ${e.stack}`);
              return [];
            }
          };
          try {
            if (process.env.VISOR_DEBUG === "true" || debug) {
              const memDbg = MemoryStore.getInstance(this.config?.memory);
              const keys = memDbg.list("fact-validation");
              logger.info(
                `on_finish.run_js context (keys in fact-validation) = [${keys.join(", ")}]`
              );
            }
          } catch {
          }
          const dynamicRun = await evalRunJs(onFinish.run_js);
          const dynList = Array.from(new Set(dynamicRun.filter(Boolean)));
          if (dynList.length > 0) {
            logger.info(
              `\u25B6 on_finish.run_js: executing [${dynList.join(", ")}] for "${checkName}"`
            );
            for (const runCheckId of dynList) {
              if (++loopCount > maxLoops) {
                throw new Error(
                  `Routing loop budget exceeded (max_loops=${maxLoops}) during on_finish run_js`
                );
              }
              logger.info(`  \u25B6 Executing on_finish(run_js) check: ${runCheckId}`);
              const childCfgFull = (config?.checks || {})[runCheckId];
              if (!childCfgFull)
                throw new Error(`Unknown check in on_finish.run_js: ${runCheckId}`);
              const childProvType = childCfgFull.type || "ai";
              const childProvider = this.providerRegistry.getProviderOrThrow(childProvType);
              this.setProviderWebhookContext(childProvider);
              const depOverlayForChild = new Map(results);
              const childRes = await this.runNamedCheck(runCheckId, [], {
                origin: "on_finish",
                config,
                dependencyGraph,
                prInfo,
                resultsMap: results,
                debug,
                overlay: depOverlayForChild
              });
              try {
                results.set(runCheckId, childRes);
              } catch {
              }
              try {
                lastRunOutput = childRes?.output;
              } catch {
              }
              logger.info(`  \u2713 Completed on_finish(run_js) check: ${runCheckId}`);
            }
          }
        }
        try {
          const vfNow = this.outputHistory.get("validate-fact") || [];
          if (Array.isArray(vfNow) && forEachItems.length > 0 && vfNow.length >= forEachItems.length) {
            const lastWave = vfNow.slice(-forEachItems.length);
            const ok = lastWave.every(
              (v) => v && (v.is_valid === true || v.valid === true)
            );
            await MemoryStore.getInstance(this.config?.memory).set(
              "all_valid",
              ok,
              "fact-validation"
            );
            try {
              logger.info(
                `\u{1F9EE} on_finish: recomputed all_valid=${ok} from history for "${checkName}"`
              );
            } catch {
            }
          }
        } catch {
        }
        let gotoTarget = null;
        if (onFinish.goto_js) {
          logger.info(`\u25B6 on_finish.goto_js: evaluating for "${checkName}"`);
          try {
            const sandbox = this.getRoutingSandbox();
            const scope = onFinishContext;
            const code = `
              const step = scope.step; const attempt = scope.attempt; const loop = scope.loop; const outputs = scope.outputs; const outputs_history = scope.outputs_history; const outputs_raw = scope.outputs_raw; const forEach = scope.forEach; const memory = scope.memory; const pr = scope.pr; const files = scope.files; const env = scope.env; const event = scope.event; const log = (...a)=> console.log('\u{1F50D} Debug:',...a);
              const __fn = () => {
${onFinish.goto_js}
};
              const __res = __fn();
              return (typeof __res === 'string' && __res) ? __res : null;
            `;
            const exec = sandbox.compile(code);
            const result = exec({ scope }).run();
            gotoTarget = typeof result === "string" && result ? result : null;
            if (debug) {
              log2(`\u{1F527} Debug: on_finish.goto_js evaluated \u2192 ${this.redact(gotoTarget)}`);
            }
            logger.info(
              `\u2713 on_finish.goto_js: evaluated to '${gotoTarget || "null"}' for "${checkName}"`
            );
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            logger.warn(`\u26A0\uFE0F on_finish.goto_js: evaluation failed for "${checkName}": ${errorMsg}`);
            if (error instanceof Error && error.stack) {
              logger.debug(`Stack trace: ${error.stack}`);
            }
            if (onFinish.goto) {
              logger.info(`  \u26A0 Falling back to static goto: '${onFinish.goto}'`);
              gotoTarget = onFinish.goto;
            }
          }
        } else if (onFinish.goto) {
          gotoTarget = onFinish.goto;
          logger.info(`\u25B6 on_finish.goto: routing to '${gotoTarget}' for "${checkName}"`);
        }
        if (gotoTarget) {
          try {
            const memDbg = MemoryStore.getInstance(this.config?.memory);
            const dbgVal = memDbg.get("all_valid", "fact-validation");
            try {
              logger.info(`  \u{1F9EA} on_finish.goto: mem all_valid currently=${String(dbgVal)}`);
            } catch {
            }
          } catch {
          }
          try {
            const mem = MemoryStore.getInstance(this.config?.memory);
            const allValidMem = mem.get("all_valid", "fact-validation");
            const lro = lastRunOutput && typeof lastRunOutput === "object" ? lastRunOutput : void 0;
            const allValidOut = lro ? lro["all_valid"] === true || lro["allValid"] === true : false;
            try {
              logger.info(
                `  \u{1F512} on_finish.goto guard: gotoTarget=${String(gotoTarget)} allValidMem=${String(allValidMem)} allValidOut=${String(allValidOut)}`
              );
            } catch {
            }
            if (gotoTarget === checkName && (allValidMem === true || allValidOut === true)) {
              logger.info(`\u2713 on_finish.goto: skipping routing to '${gotoTarget}' (all_valid=true)`);
              gotoTarget = null;
            }
          } catch {
          }
          try {
            const __h = this.outputHistory.get("validate-fact");
            logger.info(
              `  \u{1F9EA} on_finish.goto: validate-fact history now len=${Array.isArray(__h) ? __h.length : 0}`
            );
          } catch {
          }
          try {
            if (gotoTarget === checkName) {
              const vfHistNow = this.outputHistory.get("validate-fact") || [];
              if (Array.isArray(vfHistNow) && forEachItems.length > 0) {
                const verdicts = vfHistNow.map((v) => v && typeof v === "object" ? v : void 0).filter(
                  (v) => v && (typeof v.is_valid === "boolean" || typeof v.valid === "boolean")
                ).map((v) => v.is_valid === true || v.valid === true);
                if (verdicts.length >= forEachItems.length) {
                  const lastVerdicts = verdicts.slice(-forEachItems.length);
                  const allTrue = lastVerdicts.every(Boolean);
                  if (allTrue) {
                    try {
                      logger.info(
                        `\u2713 on_finish.goto: history verdicts all valid; skipping routing to '${gotoTarget}'`
                      );
                    } catch {
                    }
                    gotoTarget = null;
                  }
                }
              }
            }
          } catch {
          }
          if (!gotoTarget) {
            try {
              logger.info(`\u2713 on_finish.goto: no routing needed for "${checkName}"`);
            } catch {
            }
            continue;
          }
          try {
            if (gotoTarget === checkName) {
              const vfHist = this.outputHistory.get("validate-fact");
              const arr = Array.isArray(vfHist) ? vfHist : [];
              const allOk = arr.length > 0 && arr.every((v) => v && v.is_valid === true);
              if (allOk) {
                logger.info(
                  `\u2713 on_finish.goto: validate-fact history all valid; skipping routing to '${gotoTarget}'`
                );
                continue;
              }
            }
          } catch {
          }
          const maxLoops = config?.routing?.max_loops ?? 10;
          const used = (this.onFinishLoopCounts.get(checkName) || 0) + 1;
          if (used > maxLoops) {
            logger.warn(
              `\u26A0\uFE0F on_finish: loop budget exceeded for "${checkName}" (max_loops=${maxLoops}); last goto='${gotoTarget}'. Skipping further routing.`
            );
            continue;
          }
          this.onFinishLoopCounts.set(checkName, used);
          logger.info(
            `\u25B6 on_finish: routing from "${checkName}" to "${gotoTarget}" (budget ${used}/${maxLoops})`
          );
          try {
            const tcfg = config.checks?.[gotoTarget];
            const mode = tcfg?.fanout === "map" ? "map" : tcfg?.reduce ? "reduce" : tcfg?.fanout || "default";
            const scheduleOnce = async (scopeForRun) => this.runNamedCheck(gotoTarget, scopeForRun, {
              origin: "on_finish",
              config,
              dependencyGraph,
              prInfo,
              resultsMap: results,
              sessionInfo: void 0,
              debug,
              eventOverride: onFinish.goto_event,
              overlay: new Map(results)
            });
            if (mode === "map" && forEachItems.length > 0) {
              for (let i = 0; i < forEachItems.length; i++) {
                const itemScope = [{ check: checkName, index: i }];
                await scheduleOnce(itemScope);
              }
            } else {
              await scheduleOnce([]);
            }
            logger.info(`  \u2713 Routed to: ${gotoTarget}`);
            logger.info(`  Event override: ${onFinish.goto_event || "(none)"}`);
          } catch (error) {
            const errorMsg = error instanceof Error ? error.message : String(error);
            logger.error(
              `\u2717 on_finish: routing failed for "${checkName}" \u2192 "${gotoTarget}": ${errorMsg}`
            );
            if (error instanceof Error && error.stack) {
              logger.debug(`Stack trace: ${error.stack}`);
            }
            throw error;
          }
        }
        logger.info(`\u2713 on_finish: completed for "${checkName}"`);
      } catch (error) {
        logger.error(`\u2717 on_finish: error for "${checkName}": ${error}`);
      }
    }
  }
  // Helper: find all forEach parents that define on_finish
  collectForEachParentsWithOnFinish(config) {
    const out = [];
    for (const [checkName, checkConfig] of Object.entries(config.checks || {})) {
      if (checkConfig.forEach && checkConfig.on_finish) {
        out.push({ checkName, checkConfig, onFinish: checkConfig.on_finish });
      }
    }
    return out;
  }
  // Helper: project results + history into plain objects for sandbox
  buildOnFinishContext(results) {
    const outputsForContext = {};
    for (const [name, result] of results.entries()) {
      const r = result;
      outputsForContext[name] = r.output !== void 0 ? r.output : r;
    }
    const outputsHistoryForContext = {};
    try {
      for (const [check, history] of this.outputHistory.entries()) {
        outputsHistoryForContext[check] = history;
      }
    } catch {
    }
    return { outputsForContext, outputsHistoryForContext };
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
    let currentRouteOutput = void 0;
    const evalRunJs = async (expr, error) => {
      if (!expr) return [];
      try {
        const sandbox = this.getRoutingSandbox();
        const eventObj = { name: prInfo.eventType || "manual" };
        const outHist = {};
        try {
          for (const [k, v] of this.outputHistory.entries()) outHist[k] = v;
        } catch {
        }
        const outRaw = {};
        try {
          for (const [k, v] of (dependencyResults || /* @__PURE__ */ new Map()).entries()) {
            if (typeof k !== "string") continue;
            if (k.endsWith("-raw")) {
              const name = k.slice(0, -4);
              const val = v?.output !== void 0 ? v.output : v;
              outRaw[name] = val;
            }
          }
        } catch {
        }
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
          outputs_history: outHist,
          outputs_raw: outRaw,
          output: currentRouteOutput,
          pr: {
            number: prInfo.number,
            title: prInfo.title,
            author: prInfo.author,
            branch: prInfo.head,
            base: prInfo.base
          },
          files: prInfo.files,
          env: getSafeEnvironmentVariables(),
          permissions: createPermissionHelpers(
            resolveAssociationFromEvent(prInfo.eventContext, prInfo.authorAssociation),
            detectLocalMode()
          ),
          event: eventObj
        };
        const prelude = `const step = scope.step; const attempt = scope.attempt; const loop = scope.loop; const error = scope.error; const foreach = scope.foreach; const outputs = scope.outputs; const outputs_history = scope.outputs_history; const outputs_raw = scope.outputs_raw; const output = scope.output; const pr = scope.pr; const files = scope.files; const env = scope.env; const event = scope.event; const hasMinPermission = scope.permissions.hasMinPermission; const isOwner = scope.permissions.isOwner; const isMember = scope.permissions.isMember; const isCollaborator = scope.permissions.isCollaborator; const isContributor = scope.permissions.isContributor; const isFirstTimer = scope.permissions.isFirstTimer;`;
        const code = `${prelude}
${expr}`;
        const result = compileAndRun(
          sandbox,
          code,
          { scope },
          { injectLog: false, wrapFunction: true }
        );
        const res = Array.isArray(result) ? result : result ? [result] : [];
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
        const eventObj = { name: prInfo.eventType || "manual" };
        const outHist = {};
        try {
          for (const [k, v] of this.outputHistory.entries()) outHist[k] = v;
        } catch {
        }
        const outRaw = {};
        try {
          for (const [k, v] of (dependencyResults || /* @__PURE__ */ new Map()).entries()) {
            if (typeof k !== "string") continue;
            if (k.endsWith("-raw")) {
              const name = k.slice(0, -4);
              const val = v?.output !== void 0 ? v.output : v;
              outRaw[name] = val;
            }
          }
        } catch {
        }
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
          outputs_history: outHist,
          outputs_raw: outRaw,
          output: currentRouteOutput,
          pr: {
            number: prInfo.number,
            title: prInfo.title,
            author: prInfo.author,
            branch: prInfo.head,
            base: prInfo.base
          },
          files: prInfo.files,
          env: getSafeEnvironmentVariables(),
          permissions: createPermissionHelpers(
            resolveAssociationFromEvent(prInfo.eventContext, prInfo.authorAssociation),
            detectLocalMode()
          ),
          event: eventObj
        };
        const prelude2 = `const step = scope.step; const attempt = scope.attempt; const loop = scope.loop; const error = scope.error; const foreach = scope.foreach; const outputs = scope.outputs; const outputs_history = scope.outputs_history; const outputs_raw = scope.outputs_raw; const output = scope.output; const pr = scope.pr; const files = scope.files; const env = scope.env; const event = scope.event; const hasMinPermission = scope.permissions.hasMinPermission; const isOwner = scope.permissions.isOwner; const isMember = scope.permissions.isMember; const isCollaborator = scope.permissions.isCollaborator; const isContributor = scope.permissions.isContributor; const isFirstTimer = scope.permissions.isFirstTimer;`;
        const code2 = `${prelude2}
${expr}`;
        const res = compileAndRun(
          sandbox,
          code2,
          { scope },
          { injectLog: false, wrapFunction: true }
        );
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
    while (true) {
      try {
        try {
          emitNdjsonFallback("visor.provider", {
            "visor.check.id": checkName,
            "visor.provider.type": providerConfig.type || "ai"
          });
        } catch {
        }
        const __provStart = Date.now();
        const context2 = {
          ...sessionInfo,
          ...this.executionContext
        };
        const res = await withActiveSpan(
          `visor.check.${checkName}`,
          {
            "visor.check.id": checkName,
            "visor.check.type": providerConfig.type || "ai",
            "visor.check.attempt": attempt
          },
          async () => provider.execute(prInfo, providerConfig, dependencyResults, context2)
        );
        this.recordProviderDuration(checkName, Date.now() - __provStart);
        try {
          const anyRes = res;
          currentRouteOutput = anyRes && typeof anyRes === "object" && "output" in anyRes ? anyRes.output : anyRes;
          if (checkName === "aggregate-validations" && (process.env.VISOR_DEBUG === "true" || debug)) {
            try {
              logger.info(
                "[aggregate-validations] route-output = " + JSON.stringify(currentRouteOutput)
              );
            } catch {
            }
          }
        } catch {
        }
        const hasSoftFailure = (res.issues || []).some(
          (i) => i.severity === "error" || i.severity === "critical"
        );
        if (hasSoftFailure && onFail) {
          if (debug)
            log2(
              `\u{1F527} Debug: Soft failure detected f|| '${checkName}' with ${(res.issues || []).length} issue(s)`
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
            try {
              (init_logger(), __toCommonJS(logger_exports)).logger.info(
                `\u25B6 on_fail.run: scheduling [${runList.join(", ")}] after '${checkName}'`
              );
            } catch {
            }
            loopCount++;
            if (loopCount > maxLoops) {
              throw new Error(
                `Routing loop budget exceeded (max_loops=${maxLoops}) during on_fail run`
              );
            }
            if (debug) log2(`\u{1F527} Debug: on_fail.run (soft) executing [${runList.join(", ")}]`);
            for (const stepId of runList) {
              const tcfg = config.checks?.[stepId];
              const mode2 = tcfg?.fanout === "map" ? "map" : tcfg?.reduce ? "reduce" : tcfg?.fanout || "default";
              const inItem = !!foreachContext;
              const items = checkConfig.forEach && Array.isArray(currentRouteOutput) ? currentRouteOutput : [];
              if (!inItem && mode2 === "map" && items.length > 0) {
                for (let i = 0; i < items.length; i++) {
                  const itemScope = [{ check: checkName, index: i }];
                  await this.runNamedCheck(stepId, itemScope, {
                    config,
                    dependencyGraph,
                    prInfo,
                    resultsMap: resultsMap || /* @__PURE__ */ new Map(),
                    debug: !!debug,
                    overlay: dependencyResults
                  });
                }
              } else {
                const scopeForRun = foreachContext ? [{ check: foreachContext.parent, index: foreachContext.index }] : [];
                await this.runNamedCheck(stepId, scopeForRun, {
                  config,
                  dependencyGraph,
                  prInfo,
                  resultsMap: resultsMap || /* @__PURE__ */ new Map(),
                  debug: !!debug,
                  overlay: dependencyResults
                });
              }
            }
          }
          let target = await evalGotoJs(onFail.goto_js, lastError);
          if (!target && onFail.goto) target = onFail.goto;
          if (debug) log2(`\u{1F527} Debug: on_fail.goto (soft) target = ${target}`);
          if (target) {
            try {
              (init_logger(), __toCommonJS(logger_exports)).logger.info(
                `\u21AA on_fail.goto: jumping to '${target}' from '${checkName}'`
              );
            } catch {
            }
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
              {
                const tcfg = config.checks?.[target];
                const mode2 = tcfg?.fanout === "map" ? "map" : tcfg?.reduce ? "reduce" : tcfg?.fanout || "default";
                const inItem = !!foreachContext;
                const items = checkConfig.forEach && Array.isArray(currentRouteOutput) ? currentRouteOutput : [];
                const scheduleOnce = async (scopeForRun) => this.runNamedCheck(target, scopeForRun, {
                  config,
                  dependencyGraph,
                  prInfo,
                  resultsMap: resultsMap || /* @__PURE__ */ new Map(),
                  debug: !!debug,
                  eventOverride: onFail.goto_event
                });
                if (!inItem && mode2 === "map" && items.length > 0) {
                  for (let i = 0; i < items.length; i++) {
                    const itemScope = [{ check: checkName, index: i }];
                    await scheduleOnce(itemScope);
                  }
                } else {
                  const scopeForRun = foreachContext ? [{ check: foreachContext.parent, index: foreachContext.index }] : [];
                  await scheduleOnce(scopeForRun);
                }
              }
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
        if (onSuccess) {
          const dynamicRun = await evalRunJs(onSuccess.run_js);
          const runList = [...onSuccess.run || [], ...dynamicRun].filter(Boolean);
          try {
            if (checkName === "aggregate-validations" && (process.env.VISOR_DEBUG === "true" || debug)) {
              logger.info(
                `on_success.run (aggregate-validations): dynamicRun=[${dynamicRun.join(", ")}] run=[${(onSuccess.run || []).join(", ")}]`
              );
            }
          } catch {
          }
          if (runList.length > 0) {
            try {
              (init_logger(), __toCommonJS(logger_exports)).logger.info(
                `\u25B6 on_success.run: scheduling [${Array.from(new Set(runList)).join(", ")}] after '${checkName}'`
              );
            } catch {
            }
            loopCount++;
            if (loopCount > maxLoops) {
              throw new Error(
                `Routing loop budget exceeded (max_loops=${maxLoops}) during on_success run`
              );
            }
            for (const stepId of Array.from(new Set(runList))) {
              try {
                const tcfg2 = (config.checks || {})[stepId];
                const tags = tcfg2?.tags || [];
                const isOneShot = Array.isArray(tags) && tags.includes("one_shot");
                if (isOneShot && (this.executionStats.get(stepId)?.totalRuns || 0) > 0) {
                  (init_logger(), __toCommonJS(logger_exports)).logger.info(
                    `\u23ED on_success.run: skipping one_shot '${stepId}' (already executed)`
                  );
                  continue;
                }
              } catch {
              }
              const tcfg = config.checks?.[stepId];
              const mode = tcfg?.fanout === "map" ? "map" : tcfg?.reduce ? "reduce" : tcfg?.fanout || "default";
              const inItem = !!foreachContext;
              const items = checkConfig.forEach && Array.isArray(currentRouteOutput) ? currentRouteOutput : [];
              if (!inItem && mode === "map" && items.length > 0) {
                for (let i = 0; i < items.length; i++) {
                  const itemScope = [{ check: checkName, index: i }];
                  await this.runNamedCheck(stepId, itemScope, {
                    config,
                    dependencyGraph,
                    prInfo,
                    resultsMap: resultsMap || /* @__PURE__ */ new Map(),
                    debug: !!debug,
                    overlay: dependencyResults
                  });
                }
              } else {
                const scopeForRun = foreachContext ? [{ check: foreachContext.parent, index: foreachContext.index }] : [];
                await this.runNamedCheck(stepId, scopeForRun, {
                  config,
                  dependencyGraph,
                  prInfo,
                  resultsMap: resultsMap || /* @__PURE__ */ new Map(),
                  debug: !!debug,
                  overlay: dependencyResults
                });
              }
            }
          } else {
            try {
              const assoc = resolveAssociationFromEvent(
                prInfo?.eventContext,
                prInfo.authorAssociation
              );
              const perms = createPermissionHelpers(assoc, detectLocalMode());
              const allowedMember = perms.hasMinPermission("MEMBER");
              let intent;
              try {
                intent = res?.output?.intent;
              } catch {
              }
              (init_logger(), __toCommonJS(logger_exports)).logger.info(
                `\u23ED on_success.run: none after '${checkName}' (event=${prInfo.eventType || "manual"}, intent=${intent || "n/a"}, assoc=${assoc || "unknown"}, memberOrHigher=${allowedMember})`
              );
            } catch {
            }
          }
          let target = await evalGotoJs(onSuccess.goto_js);
          if (!target && onSuccess.goto) target = onSuccess.goto;
          if (target) {
            try {
              (init_logger(), __toCommonJS(logger_exports)).logger.info(
                `\u21AA on_success.goto: jumping to '${target}' from '${checkName}'`
              );
            } catch {
            }
            if (!allAncestors.includes(target)) {
              const prevEventOverride2 = this.routingEventOverride;
              if (onSuccess.goto_event) {
                this.routingEventOverride = onSuccess.goto_event;
              }
              try {
                const cfgChecks = config?.checks || {};
                const forwardSet = /* @__PURE__ */ new Set();
                if (cfgChecks[target]) forwardSet.add(target);
                const dependsOn = (name, root) => {
                  const seen = /* @__PURE__ */ new Set();
                  const dfs = (n) => {
                    if (seen.has(n)) return false;
                    seen.add(n);
                    const deps = cfgChecks[n]?.depends_on || [];
                    if (deps.includes(root)) return true;
                    return deps.some((d) => dfs(d));
                  };
                  return dfs(name);
                };
                const ev = onSuccess.goto_event || prInfo.eventType || "issue_comment";
                for (const name of Object.keys(cfgChecks)) {
                  if (name === target) continue;
                  const onArr = cfgChecks[name]?.on;
                  const eventMatches = !onArr || Array.isArray(onArr) && onArr.includes(ev);
                  if (!eventMatches) continue;
                  if (dependsOn(name, target)) forwardSet.add(name);
                }
                const runTargetOnce = async (scopeForRun) => {
                  await this.runNamedCheck(target, scopeForRun, {
                    config,
                    dependencyGraph,
                    prInfo,
                    resultsMap: resultsMap || /* @__PURE__ */ new Map(),
                    debug: !!debug,
                    eventOverride: onSuccess.goto_event
                  });
                };
                const order = [];
                const inSet = (n) => forwardSet.has(n);
                const tempMarks = /* @__PURE__ */ new Set();
                const permMarks = /* @__PURE__ */ new Set();
                const stack = [];
                const visit = (n) => {
                  if (permMarks.has(n)) return;
                  if (tempMarks.has(n)) {
                    const idx = stack.indexOf(n);
                    const cyclePath = idx >= 0 ? [...stack.slice(idx), n] : [n];
                    throw new Error(
                      `Cycle detected in forward-run dependency subset: ${cyclePath.join(" -> ")}`
                    );
                  }
                  tempMarks.add(n);
                  stack.push(n);
                  const deps = (cfgChecks[n]?.depends_on || []).filter(inSet);
                  for (const d of deps) visit(d);
                  stack.pop();
                  tempMarks.delete(n);
                  permMarks.add(n);
                  order.push(n);
                };
                for (const n of forwardSet) visit(n);
                const tcfg = cfgChecks[target];
                const mode = tcfg?.fanout === "map" ? "map" : tcfg?.reduce ? "reduce" : tcfg?.fanout || "default";
                const items = checkConfig.forEach && Array.isArray(currentRouteOutput) ? currentRouteOutput : [];
                const runChainOnce = async (scopeForRun) => {
                  await runTargetOnce(scopeForRun);
                  const dependentsOnly = order.filter((n) => n !== target);
                  for (const stepId of dependentsOnly) {
                    await this.runNamedCheck(stepId, scopeForRun, {
                      config,
                      dependencyGraph,
                      prInfo,
                      resultsMap: resultsMap || /* @__PURE__ */ new Map(),
                      debug: !!debug,
                      eventOverride: onSuccess.goto_event
                    });
                  }
                };
                if (!foreachContext && mode === "map" && items.length > 0) {
                  for (let i = 0; i < items.length; i++) {
                    const itemScope = [{ check: checkName, index: i }];
                    await runChainOnce(itemScope);
                  }
                } else {
                  const scopeForRun = foreachContext ? [{ check: foreachContext.parent, index: foreachContext.index }] : [];
                  await runChainOnce(scopeForRun);
                }
              } finally {
                this.routingEventOverride = prevEventOverride2;
              }
            } else {
              loopCount++;
              if (loopCount > maxLoops) {
                throw new Error(
                  `Routing loop budget exceeded (max_loops=${maxLoops}) during on_success goto`
                );
              }
              {
                const tcfg = config.checks?.[target];
                const mode = tcfg?.fanout === "map" ? "map" : tcfg?.reduce ? "reduce" : tcfg?.fanout || "default";
                const items = checkConfig.forEach && Array.isArray(currentRouteOutput) ? currentRouteOutput : [];
                const scheduleOnce = async (scopeForRun) => this.runNamedCheck(target, scopeForRun, {
                  config,
                  dependencyGraph,
                  prInfo,
                  resultsMap: resultsMap || /* @__PURE__ */ new Map(),
                  debug: !!debug,
                  eventOverride: onSuccess.goto_event,
                  overlay: dependencyResults
                });
                if (!foreachContext && mode === "map" && items.length > 0) {
                  for (let i = 0; i < items.length; i++) {
                    const itemScope = [{ check: checkName, index: i }];
                    await scheduleOnce(itemScope);
                  }
                } else {
                  const scopeForRun = foreachContext ? [{ check: foreachContext.parent, index: foreachContext.index }] : [];
                  await scheduleOnce(scopeForRun);
                }
              }
            }
          }
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
          try {
            (init_logger(), __toCommonJS(logger_exports)).logger.info(
              `\u25B6 on_fail.run: scheduling [${runList.join(", ")}] after '${checkName}'`
            );
          } catch {
          }
          loopCount++;
          if (loopCount > maxLoops) {
            throw new Error(
              `Routing loop budget exceeded (max_loops=${maxLoops}) during on_fail run`
            );
          }
          if (debug) log2(`\u{1F527} Debug: on_fail.run executing [${runList.join(", ")}]`);
          for (const stepId of runList) {
            await this.runNamedCheck(stepId, [], {
              config,
              dependencyGraph,
              prInfo,
              resultsMap: resultsMap || /* @__PURE__ */ new Map(),
              debug: !!debug
            });
          }
        }
        let target = await evalGotoJs(onFail.goto_js, lastError);
        if (!target && onFail.goto) target = onFail.goto;
        if (target) {
          try {
            (init_logger(), __toCommonJS(logger_exports)).logger.info(
              `\u21AA on_fail.goto: jumping to '${target}' from '${checkName}'`
            );
          } catch {
          }
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
            await this.runNamedCheck(target, [], {
              config,
              dependencyGraph,
              prInfo,
              resultsMap: resultsMap || /* @__PURE__ */ new Map(),
              debug: !!debug,
              eventOverride: onFail.goto_event,
              overlay: dependencyResults
            });
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
    return checks.filter((checkName) => {
      const checkConfig = config?.checks?.[checkName];
      if (!checkConfig) {
        return true;
      }
      const checkTags = checkConfig.tags || [];
      if (!tagFilter || !tagFilter.include && !tagFilter.exclude) {
        if (process.env.VISOR_TEST_MODE === "true") return true;
        return checkTags.length === 0;
      }
      if (checkTags.length === 0) {
        return true;
      }
      if (tagFilter.exclude && tagFilter.exclude.length > 0) {
        const hasExcludedTag = tagFilter.exclude.some((tag) => checkTags.includes(tag));
        if (hasExcludedTag) return false;
      }
      if (tagFilter.include && tagFilter.include.length > 0) {
        const hasIncludedTag = tagFilter.include.some((tag) => checkTags.includes(tag));
        if (!hasIncludedTag) return false;
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
      if (options.config?.memory) {
        const memoryStore = MemoryStore.getInstance(options.config.memory);
        await memoryStore.initialize();
        logger.debug("Memory store initialized");
      }
      this.onFinishLoopCounts.clear();
      this.forEachWaveCounts.clear();
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
        failFast,
        config?.tag_filter
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
          eventContext: this.enrichEventContext(prInfo.eventContext),
          ai: timeout ? { timeout } : void 0
        };
        const __provStart = Date.now();
        const result = await provider.execute(prInfo, providerConfig);
        this.recordProviderDuration(checks[0], Date.now() - __provStart);
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
        eventContext: this.enrichEventContext(prInfo.eventContext),
        ai: timeout ? { timeout } : void 0,
        // Inherit global AI provider and model settings if config is available
        ai_provider: config?.ai_provider,
        ai_model: config?.ai_model
      };
      const __provStart2 = Date.now();
      const result = await provider.execute(prInfo, providerConfig);
      this.recordProviderDuration(checkName, Date.now() - __provStart2);
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
  async executeGroupedChecks(prInfo, checks, timeout, config, outputFormat, debug, maxParallelism, failFast, tagFilter, _pauseGate) {
    try {
      this["executionStats"].clear();
    } catch {
    }
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
      if (process.env.VISOR_DEBUG === "true") {
        const ev = prInfo?.eventType || "(unknown)";
        console.error(`[engine] final checks after filters (event=${ev}): [${checks.join(", ")}]`);
      }
    } catch {
    }
    if (!this.actionContext) {
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
    const hasRouting = checks.some((checkName) => {
      const c = config.checks[checkName];
      return Boolean(c?.on_success || c?.on_fail);
    });
    if (checks.length > 1 || hasDependencies || hasRouting) {
      try {
        if (process.env.VISOR_DEBUG === "true") {
          console.error(
            "[engine] grouped-dep path: checks=",
            checks.join(","),
            " hasDeps=",
            hasDependencies,
            " hasRouting=",
            hasRouting
          );
        }
      } catch {
      }
      if (debug) {
        logger.debug(
          `\u{1F527} Debug: Using grouped dependency-aware execution for ${checks.length} checks (has dependencies: ${hasDependencies}, has routing: ${hasRouting})`
        );
      }
      const execRes = await this.executeGroupedDependencyAwareChecks(
        prInfo,
        checks,
        timeout,
        config,
        logFn,
        debug,
        maxParallelism,
        failFast,
        tagFilter
      );
      try {
        if (process.env.VISOR_TEST_MODE === "true" && config?.output?.pr_comment) {
          let owner = this.actionContext?.owner;
          let repo = this.actionContext?.repo;
          if (!owner || !repo) {
            try {
              const anyInfo = prInfo;
              owner = anyInfo?.eventContext?.repository?.owner?.login || owner;
              repo = anyInfo?.eventContext?.repository?.name || repo;
            } catch {
            }
          }
          owner = owner || (process.env.GITHUB_REPOSITORY || "owner/repo").split("/")[0];
          repo = repo || (process.env.GITHUB_REPOSITORY || "owner/repo").split("/")[1];
          if (owner && repo && prInfo.number) {
            await this.reviewer.postReviewComment(owner, repo, prInfo.number, execRes.results, {
              config,
              triggeredBy: prInfo.eventType || "manual",
              commentId: "visor-review"
            });
          }
        }
      } catch {
      }
      return execRes;
    }
    if (checks.length === 1) {
      try {
        if (process.env.VISOR_DEBUG === "true")
          console.error("[engine] grouped-single path: check=", checks[0]);
      } catch {
      }
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
      try {
        if (process.env.VISOR_TEST_MODE === "true" && config?.output?.pr_comment) {
          let owner = this.actionContext?.owner;
          let repo = this.actionContext?.repo;
          if (!owner || !repo) {
            try {
              const anyInfo = prInfo;
              owner = anyInfo?.eventContext?.repository?.owner?.login || owner;
              repo = anyInfo?.eventContext?.repository?.name || repo;
            } catch {
            }
          }
          owner = owner || (process.env.GITHUB_REPOSITORY || "owner/repo").split("/")[0];
          repo = repo || (process.env.GITHUB_REPOSITORY || "owner/repo").split("/")[1];
          if (owner && repo && prInfo.number) {
            await this.reviewer.postReviewComment(owner, repo, prInfo.number, groupedResults, {
              config,
              triggeredBy: prInfo.eventType || "manual",
              commentId: "visor-review"
            });
          }
        }
      } catch {
      }
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
      eventContext: this.enrichEventContext(prInfo.eventContext),
      ai: {
        timeout: timeout || 6e5,
        debug,
        ...checkConfig.ai || {}
      },
      ai_provider: checkConfig.ai_provider || config.ai_provider,
      ai_model: checkConfig.ai_model || config.ai_model,
      // Pass claude_code config if present
      claude_code: checkConfig.claude_code,
      // Pass output history for loop/goto scenarios
      __outputHistory: this.outputHistory,
      // Pass any provider-specific config
      ...checkConfig
    };
    providerConfig.forEach = checkConfig.forEach;
    if (!this.executionStats.has(checkName)) this.initializeCheckStats(checkName);
    const __iterStart = this.recordIterationStart(checkName);
    const __provStart = Date.now();
    const result = await provider.execute(prInfo, providerConfig, void 0, this.executionContext);
    this.recordProviderDuration(checkName, Date.now() - __provStart);
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
    let group = checkConfig.group || "default";
    if (config?.output?.pr_comment?.group_by === "check" && !checkConfig.group) {
      group = checkName;
    }
    try {
      const out = result?.output;
      if (out !== void 0) this.trackOutputHistory(checkName, out);
    } catch {
    }
    const checkResult = {
      checkName,
      content,
      group,
      output: result.output,
      debug: result.debug,
      issues: result.issues
      // Include structured issues
    };
    try {
      const issuesArr = (result.issues || []).map((i) => ({ ...i }));
      const success = !this.hasFatal(issuesArr);
      const outputVal = result?.output;
      this.recordIterationComplete(checkName, __iterStart, success, issuesArr, outputVal);
    } catch {
    }
    return checkResult;
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
  async executeGroupedDependencyAwareChecks(prInfo, checks, timeout, config, logFn, debug, maxParallelism, failFast, tagFilter) {
    const reviewSummary = await this.executeDependencyAwareChecks(
      prInfo,
      checks,
      timeout,
      config,
      logFn,
      debug,
      maxParallelism,
      failFast,
      tagFilter || config?.tag_filter
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
    const allCheckNames = [];
    const seen = /* @__PURE__ */ new Set();
    const pushUnique = (n) => {
      if (!n) return;
      if (!seen.has(n)) {
        seen.add(n);
        allCheckNames.push(n);
      }
    };
    for (const n of checks) pushUnique(n);
    if (contentMap) for (const n of Object.keys(contentMap)) pushUnique(n);
    if (outputMap) for (const n of Object.keys(outputMap)) pushUnique(n);
    for (const issue of reviewSummary.issues || []) pushUnique(issue.checkName);
    if (Array.isArray(agg.__executed)) for (const n of agg.__executed) pushUnique(n);
    for (const checkName of allCheckNames) {
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
      let group = checkConfig.group || "default";
      if (config?.output?.pr_comment?.group_by === "check" && !checkConfig.group) {
        group = checkName;
      }
      const checkResult = {
        checkName,
        content,
        group,
        output: checkSummary.output,
        debug: reviewSummary.debug,
        issues: issuesForCheck
        // Include structured issues + rendering error if any
      };
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
    const path9 = await import("path");
    if (!templatePath || typeof templatePath !== "string" || templatePath.trim() === "") {
      throw new Error("Template path must be a non-empty string");
    }
    if (templatePath.includes("\0") || templatePath.includes("\0")) {
      throw new Error("Template path contains invalid characters");
    }
    if (!templatePath.endsWith(".liquid")) {
      throw new Error("Template file must have .liquid extension");
    }
    if (path9.isAbsolute(templatePath)) {
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
    const resolvedPath = path9.resolve(projectRoot, templatePath);
    const resolvedProjectRoot = path9.resolve(projectRoot);
    if (!resolvedPath || !resolvedProjectRoot || resolvedPath === "" || resolvedProjectRoot === "") {
      throw new Error(
        `Unable to resolve template path: projectRoot="${projectRoot}", templatePath="${templatePath}", resolvedPath="${resolvedPath}", resolvedProjectRoot="${resolvedProjectRoot}"`
      );
    }
    if (!resolvedPath.startsWith(resolvedProjectRoot + path9.sep) && resolvedPath !== resolvedProjectRoot) {
      throw new Error("Template path escapes project directory");
    }
    return resolvedPath;
  }
  /**
   * Unified helper to evaluate a check's `if` condition with optional fail-secure behavior.
   * Returns a struct indicating whether to run; when failSecure=true, any evaluation error
   * results in shouldRun=false with an error message.
   */
  async shouldRunCheck(checkName, condition, prInfo, results, debug, eventOverride, failSecure = false) {
    try {
      const eventName = eventOverride ? eventOverride.startsWith("pr_") ? "pull_request" : eventOverride === "issue_comment" ? "issue_comment" : eventOverride.startsWith("issue_") ? "issues" : "manual" : prInfo.eventType && prInfo.eventType.startsWith("pr_") ? "pull_request" : prInfo.eventType === "issue_comment" ? "issue_comment" : prInfo.eventType && prInfo.eventType.startsWith("issue_") ? "issues" : "manual";
      const commenterAssoc = resolveAssociationFromEvent(
        prInfo?.eventContext,
        prInfo.authorAssociation
      );
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
      return { shouldRun };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (failSecure) {
        try {
          logger.error(`Failed to evaluate if condition for ${checkName}: ${msg}`);
        } catch {
        }
        return { shouldRun: false, error: msg };
      }
      try {
        if (debug) logger.debug(`\u26A0\uFE0F Debug: if evaluation error for ${checkName}: ${msg}`);
      } catch {
      }
      return { shouldRun: true, error: msg };
    }
  }
  /**
   * Render check content using the appropriate template
   */
  async renderCheckContent(checkName, reviewSummary, checkConfig, _prInfo) {
    const directContent = reviewSummary.content;
    if (typeof directContent === "string" && directContent.trim()) {
      return directContent.trim();
    }
    const { createExtendedLiquid: createExtendedLiquid2 } = await import("./liquid-extensions-YVD5Q2NX.mjs");
    const fs7 = await import("fs/promises");
    const path9 = await import("path");
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
    let templateContent = "";
    let enrichAssistantContext = false;
    if (checkConfig.template) {
      if (checkConfig.template.content) {
        templateContent = checkConfig.template.content;
      } else if (checkConfig.template.file) {
        const validatedPath = await this.validateTemplatePath(checkConfig.template.file);
        templateContent = await fs7.readFile(validatedPath, "utf-8");
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
      const candidateTemplatePaths = [
        path9.join(__dirname, `output/${sanitizedSchema}/template.liquid`),
        path9.join(process.cwd(), `output/${sanitizedSchema}/template.liquid`)
      ];
      let foundTemplate;
      for (const p of candidateTemplatePaths) {
        try {
          templateContent = await fs7.readFile(p, "utf-8");
          foundTemplate = p;
          break;
        } catch {
        }
      }
      if (!foundTemplate) {
        const distPath = path9.join(__dirname, `output/${sanitizedSchema}/template.liquid`);
        const cwdPath = path9.join(process.cwd(), `output/${sanitizedSchema}/template.liquid`);
        throw new Error(
          `Template file not found for schema '${sanitizedSchema}'. Tried: ${distPath} and ${cwdPath}.`
        );
      }
      if (sanitizedSchema === "issue-assistant") {
        enrichAssistantContext = true;
      }
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
    if (enrichAssistantContext) {
      let authorAssociation;
      let eventName = "manual";
      let eventAction;
      try {
        const anyInfo = _prInfo;
        authorAssociation = resolveAssociationFromEvent(
          anyInfo?.eventContext,
          anyInfo?.authorAssociation
        );
        eventName = anyInfo?.eventContext?.event_name || anyInfo?.eventType || "manual";
        eventAction = anyInfo?.eventContext?.action;
      } catch {
      }
      templateData.authorAssociation = authorAssociation;
      templateData.event = { name: eventName, action: eventAction };
    }
    const { withPermissionsContext } = await import("./liquid-extensions-YVD5Q2NX.mjs");
    let authorAssociationForFilters;
    try {
      const anyInfo = _prInfo;
      authorAssociationForFilters = resolveAssociationFromEvent(
        anyInfo?.eventContext,
        anyInfo?.authorAssociation
      );
    } catch {
    }
    let rendered;
    if (typeof withPermissionsContext === "function") {
      rendered = await withPermissionsContext(
        { authorAssociation: authorAssociationForFilters },
        async () => await liquid.parseAndRender(templateContent, templateData)
      );
      if (rendered === void 0 || rendered === null) {
        rendered = await liquid.parseAndRender(templateContent, templateData);
      }
    } else {
      rendered = await liquid.parseAndRender(templateContent, templateData);
    }
    const finalRendered = rendered.trim();
    try {
      const { emitMermaidFromMarkdown } = await import("./mermaid-telemetry-SN6A2TKW.mjs");
      emitMermaidFromMarkdown(checkName, finalRendered, "content");
    } catch {
    }
    return finalRendered;
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
  async executeDependencyAwareChecks(prInfo, checks, timeout, config, logFn, debug, maxParallelism, failFast, tagFilter) {
    const log2 = logFn || console.error;
    try {
      if (process.env.VISOR_DEBUG === "true") {
        console.error("[engine] enter executeDependencyAwareChecks (dbg=", debug, ")");
        console.error("  [engine] root checks in (pre-expand): [", checks.join(", "), "]");
      }
    } catch {
    }
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
        if (debug) {
          try {
            log2(
              `\u{1F527} Debug: reuse_ai_session for '${checkName}' \u2192 ${String(
                checkConfig.reuse_ai_session
              )}`
            );
          } catch {
          }
        }
        if (checkConfig.reuse_ai_session === true || typeof checkConfig.reuse_ai_session === "string") {
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
    const expandWithTransitives = (rootChecks) => {
      if (!config?.checks) return rootChecks;
      const set = new Set(rootChecks);
      const allowByTags = (name) => {
        if (!tagFilter) return true;
        const cfg = config.checks?.[name];
        const tags = cfg && cfg.tags || [];
        if (tagFilter.exclude && tagFilter.exclude.some((t) => tags.includes(t))) return false;
        if (tagFilter.include && tagFilter.include.length > 0) {
          return tagFilter.include.some((t) => tags.includes(t));
        }
        return true;
      };
      const allowByEvent = (name) => {
        try {
          const cfg = config.checks?.[name];
          const triggers = cfg?.on || [];
          if (!triggers || triggers.length === 0) return true;
          const current = prInfo?.eventType || "manual";
          return triggers.includes(current);
        } catch {
          return true;
        }
      };
      const visit = (name) => {
        const cfg = config.checks[name];
        if (!cfg || !cfg.depends_on) return;
        for (const dep of cfg.depends_on) {
          if (!config.checks[dep]) continue;
          if (!allowByTags(dep)) continue;
          if (!allowByEvent(dep)) continue;
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
    try {
      if (process.env.VISOR_DEBUG === "true") {
        console.error("  [engine] checks after expandWithTransitives: [", checks.join(", "), "]");
      }
    } catch {
    }
    for (const checkName of checks) {
      const checkConfig = config.checks[checkName];
      dependencies[checkName] = checkConfig?.depends_on || [];
    }
    try {
      if (prInfo && prInfo.eventType) {
        const currentEv = prInfo.eventType || "manual";
        for (const [name, deps] of Object.entries(dependencies)) {
          const filtered = (deps || []).filter((dep) => {
            const cfg = config.checks?.[dep];
            if (!cfg) return false;
            const trig = cfg.on || [];
            if (!trig || Array.isArray(trig) && trig.length === 0) return true;
            return Array.isArray(trig) ? trig.includes(currentEv) : trig === currentEv;
          });
          dependencies[name] = filtered;
        }
      }
    } catch {
    }
    {
      const validation2 = DependencyResolver.validateDependencies(checks, dependencies);
      if (!validation2.valid) {
        return {
          issues: [
            {
              severity: "error",
              message: `Dependency validation failed: ${validation2.errors.join(", ")}`,
              file: "",
              line: 0,
              ruleId: "dependency-validation-error",
              category: "logic"
            }
          ]
        };
      }
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
      try {
        console.error(
          `  [engine] level ${executionGroup.level} parallel=[$${"{"}executionGroup.parallel.join(', '){'}'}]`
        );
      } catch {
      }
      const checksInLevel = executionGroup.parallel;
      const sessionReuseGroups = /* @__PURE__ */ new Map();
      checksInLevel.forEach((checkName) => {
        if (sessionReuseChecks.has(checkName)) {
          const parentCheckName = sessionProviders.get(checkName);
          if (parentCheckName) {
            if (!sessionReuseGroups.has(parentCheckName)) {
              sessionReuseGroups.set(parentCheckName, []);
            }
            sessionReuseGroups.get(parentCheckName).push(checkName);
          }
        }
      });
      const hasConflictingSessionReuse = Array.from(sessionReuseGroups.values()).some(
        (group) => group.length > 1
      );
      let actualParallelism = Math.min(effectiveMaxParallelism, executionGroup.parallel.length);
      if (hasConflictingSessionReuse) {
        actualParallelism = 1;
        if (debug) {
          const conflictingGroups = Array.from(sessionReuseGroups.entries()).filter(([_, checks2]) => checks2.length > 1).map(([parent, checks2]) => `${parent} -> [${checks2.join(", ")}]`).join("; ");
          log2(
            `\u{1F504} Debug: Level ${executionGroup.level} has session conflicts (${conflictingGroups}) - forcing sequential execution (parallelism: 1)`
          );
        }
      } else if (sessionReuseGroups.size > 0 && debug) {
        log2(
          `\u2705 Debug: Level ${executionGroup.level} has session reuse but no conflicts - allowing parallel execution`
        );
      }
      if (debug) {
        log2(
          `\u{1F527} Debug: Executing level ${executionGroup.level} with ${executionGroup.parallel.length} checks (parallelism: ${actualParallelism})`
        );
      }
      const levelChecks = executionGroup.parallel.filter((name) => !results.has(name));
      try {
        if (process.env.VISOR_DEBUG === "true") {
          console.error("  [engine] levelChecks = [", levelChecks.join(", "), "]");
        }
      } catch {
      }
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
          } else if (process.env.VISOR_DEBUG === "true") {
            try {
              console.log(`[engine] provider for ${checkName} -> ${providerType}`);
            } catch {
            }
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
            eventContext: this.enrichEventContext(prInfo.eventContext),
            transform: checkConfig.transform,
            transform_js: checkConfig.transform_js,
            // Important: pass through provider-level timeout from check config
            // (e.g., command/http_client providers expect seconds/ms here)
            timeout: checkConfig.timeout,
            level: extendedCheckConfig.level,
            message: extendedCheckConfig.message,
            env: checkConfig.env,
            forEach: checkConfig.forEach,
            // Provide output history so providers can access latest outputs for Liquid rendering
            __outputHistory: this.outputHistory,
            // Pass through any provider-specific keys (e.g., op/values for github provider)
            ...checkConfig,
            ai: {
              ...checkConfig.ai || {},
              timeout: timeout || 6e5,
              debug
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
                  hasFatalFailure = await this.failIfTriggered(depId, depRes, config, results);
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
              if (debug && process.env.VISOR_OUTPUT_FORMAT !== "json" && process.env.VISOR_OUTPUT_FORMAT !== "sarif") {
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
                    eventContext: this.enrichEventContext(prInfo.eventContext),
                    transform: childCfg.transform,
                    transform_js: childCfg.transform_js,
                    env: childCfg.env,
                    forEach: childCfg.forEach,
                    // Include provider-specific keys like op/values for non-AI providers
                    ...childCfg,
                    ai: {
                      ...childCfg.ai || {},
                      timeout: timeout || 6e5,
                      debug
                    }
                  };
                  try {
                    emitNdjsonSpanWithEvents("visor.check", { "visor.check.id": checkName }, [
                      { name: "check.started" },
                      { name: "check.completed" }
                    ]);
                  } catch {
                  }
                  const parentAgg = results.get(parentName);
                  const maskFatal = !!parentAgg?.forEachFatalMask && parentAgg.forEachFatalMask[itemIndex] === true;
                  if (maskFatal) {
                    continue;
                  }
                  if (childCfg.if) {
                    const itemScope2 = [{ check: parentName, index: itemIndex }];
                    const condResults = this.buildSnapshotDependencyResults(
                      itemScope2,
                      void 0,
                      prInfo.eventType
                    );
                    for (const [k, v] of baseDeps.entries()) condResults.set(k, v);
                    const gateChild = await this.shouldRunCheck(
                      childName,
                      childCfg.if,
                      prInfo,
                      condResults,
                      debug,
                      void 0,
                      /* failSecure */
                      true
                    );
                    if (!gateChild.shouldRun) {
                      continue;
                    }
                  }
                  const childIterStart = this.recordIterationStart(childName);
                  const itemScope = [{ check: parentName, index: itemIndex }];
                  const snapshotDeps = this.buildSnapshotDependencyResults(
                    itemScope,
                    void 0,
                    prInfo.eventType
                  );
                  for (const [k, v] of baseDeps.entries()) snapshotDeps.set(k, v);
                  const childItemRes = await this.executeWithRouting(
                    childName,
                    childCfg,
                    childProv,
                    childProviderConfig,
                    prInfo,
                    snapshotDeps,
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
                      config,
                      prInfo,
                      results
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
                try {
                  emitNdjsonSpanWithEvents(
                    "visor.foreach.item",
                    {
                      "visor.check.id": checkName,
                      "visor.foreach.index": itemIndex,
                      "visor.foreach.total": forEachItems.length
                    },
                    []
                  );
                } catch {
                }
                const itemScope = [{ check: forEachParentName, index: itemIndex }];
                const snapshotDeps = this.buildSnapshotDependencyResults(
                  itemScope,
                  void 0,
                  prInfo.eventType
                );
                if ((checkConfig.depends_on || []).length > 0) {
                  const directDeps2 = checkConfig.depends_on || [];
                  for (const depId of directDeps2) {
                    if (!forEachParents.includes(depId)) continue;
                    const depAgg = results.get(depId);
                    const maskFatal = !!depAgg?.forEachFatalMask && depAgg.forEachFatalMask[itemIndex] === true;
                    if (maskFatal) {
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
                  const gateItem = await this.shouldRunCheck(
                    checkName,
                    checkConfig.if,
                    prInfo,
                    snapshotDeps,
                    debug,
                    void 0,
                    /* failSecure */
                    true
                  );
                  if (!gateItem.shouldRun) {
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
                  snapshotDeps,
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
                    config,
                    prInfo,
                    results
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
                const itemOutput = itemResult.output;
                if (itemOutput !== void 0) {
                  this.trackOutputHistory(checkName, itemOutput);
                }
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
                    for (const d of deps) {
                      const perItemRes = perItemDepMap.get(d);
                      if (perItemRes) {
                        if (isFatal(perItemRes)) {
                          ready = false;
                          break;
                        }
                        continue;
                      }
                      if (perItemDone.has(d)) continue;
                      const agg2 = results.get(d);
                      if (!agg2) {
                        ready = false;
                        break;
                      }
                      if (agg2.isForEach || Array.isArray(agg2.forEachItemResults)) {
                        const maskFatal = !!agg2.forEachFatalMask && agg2.forEachFatalMask[itemIndex] === true;
                        if (maskFatal) {
                          ready = false;
                          break;
                        }
                      } else {
                        if (isFatal(agg2)) {
                          ready = false;
                          break;
                        }
                      }
                    }
                    if (!ready) continue;
                    if (nodeCfg.if) {
                      const itemScope3 = [{ check: forEachParentName, index: itemIndex }];
                      const condResults = this.buildSnapshotDependencyResults(
                        itemScope3,
                        void 0,
                        prInfo.eventType
                      );
                      for (const [k, v] of perItemDepMap.entries()) condResults.set(k, v);
                      const gateNode = await this.shouldRunCheck(
                        node,
                        nodeCfg.if,
                        prInfo,
                        condResults,
                        debug,
                        void 0,
                        /* failSecure */
                        true
                      );
                      if (!gateNode.shouldRun) {
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
                      eventContext: this.enrichEventContext(prInfo.eventContext),
                      transform: nodeCfg.transform,
                      transform_js: nodeCfg.transform_js,
                      env: nodeCfg.env,
                      forEach: nodeCfg.forEach,
                      ai: { timeout: timeout || 6e5, debug, ...nodeCfg.ai || {} }
                    };
                    const iterStart = this.recordIterationStart(node);
                    const itemScope2 = [{ check: forEachParentName, index: itemIndex }];
                    const execDepMap = this.buildSnapshotDependencyResults(
                      itemScope2,
                      void 0,
                      prInfo.eventType
                    );
                    for (const [k, v] of perItemDepMap.entries()) execDepMap.set(k, v);
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
                      const fRes = await this.evaluateFailureConditions(
                        node,
                        nodeItemRes,
                        config,
                        prInfo,
                        results
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
                    const failures = await this.evaluateFailureConditions(
                      parent,
                      rForEval,
                      config,
                      prInfo,
                      results
                    );
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
                          config,
                          prInfo,
                          results
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
              const gate = await this.shouldRunCheck(
                checkName,
                checkConfig.if,
                prInfo,
                results,
                debug,
                void 0,
                /* failSecure */
                true
              );
              if (!gate.shouldRun) {
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
            try {
              emitNdjsonSpanWithEvents("visor.check", { "visor.check.id": checkName }, [
                { name: "check.started" },
                { name: "check.completed" }
              ]);
            } catch {
            }
            if (config && (config.fail_if || checkConfig.fail_if)) {
              const failureResults = await this.evaluateFailureConditions(
                checkName,
                finalResult,
                config,
                prInfo,
                results
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
            const validation = this.validateAndNormalizeForEachOutput(
              checkName,
              reviewSummaryWithOutput.output,
              checkConfig.group
            );
            if (!validation.isValid) {
              results.set(
                checkName,
                validation.error.issues ? { issues: validation.error.issues } : {}
              );
              continue;
            }
            const normalizedOutput = validation.normalizedOutput;
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
            try {
              const st = this.executionStats.get(checkName);
              if (st) st.outputsProduced = normalizedOutput.length;
            } catch {
            }
          }
          try {
            emitNdjsonSpanWithEvents("visor.check", { "visor.check.id": checkName }, [
              { name: "check.started" },
              { name: "check.completed" }
            ]);
          } catch {
          }
          const reviewResultWithOutput = reviewResult;
          if (reviewResultWithOutput.output !== void 0) {
            this.trackOutputHistory(checkName, reviewResultWithOutput.output);
          }
          results.set(checkName, reviewResult);
          const agg = reviewResult;
          if (checkConfig?.forEach && (Array.isArray(agg.forEachItems) || Array.isArray(agg.output))) {
            this.commitJournal(checkName, agg, prInfo.eventType, []);
            const items = Array.isArray(agg.forEachItems) ? agg.forEachItems : Array.isArray(agg.output) ? agg.output : [];
            for (let i2 = 0; i2 < items.length; i2++) {
              const item = items[i2];
              try {
                this.commitJournal(
                  checkName,
                  { issues: [], output: item },
                  prInfo.eventType,
                  [{ check: checkName, index: i2 }]
                );
              } catch {
              }
            }
          } else {
            this.commitJournal(checkName, reviewResult, prInfo.eventType);
          }
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
          this.commitJournal(checkName, errorSummary, prInfo.eventType);
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
    if (!shouldStopExecution) {
      try {
        logger.info("\u{1F9ED} on_finish: invoking handleOnFinishHooks");
      } catch {
      }
      try {
        if (debug) console.error("[engine] calling handleOnFinishHooks");
      } catch {
      }
      await this.handleOnFinishHooks(config, dependencyGraph, results, prInfo, debug || false);
      try {
        for (const [parentName, cfg] of Object.entries(config.checks || {})) {
          const onf = cfg?.on_finish;
          if (!cfg?.forEach || !onf || !Array.isArray(onf.run) || onf.run.length === 0)
            continue;
          const parentRes = results.get(parentName);
          const count = (() => {
            try {
              if (!parentRes) return 0;
              if (Array.isArray(parentRes.forEachItems)) return parentRes.forEachItems.length;
              const out = parentRes?.output;
              return Array.isArray(out) ? out.length : 0;
            } catch {
              return 0;
            }
          })();
          if (count > 0) {
            for (const stepId of onf.run) {
              if (typeof stepId !== "string" || !stepId) continue;
              if (results.has(stepId)) continue;
              try {
                const h = this.outputHistory.get(stepId);
                if (Array.isArray(h) && h.length > 0) continue;
              } catch {
              }
              try {
                logger.info(
                  `\u25B6 on_finish.fallback: executing static run step '${stepId}' for parent '${parentName}'`
                );
              } catch {
              }
              try {
                if (debug)
                  console.error(`[on_finish.fallback] run '${stepId}' for '${parentName}'`);
              } catch {
              }
              await this.runNamedCheck(stepId, [], {
                origin: "on_finish",
                config,
                dependencyGraph,
                prInfo,
                resultsMap: results,
                debug: !!debug,
                overlay: new Map(results)
              });
            }
          }
        }
      } catch {
      }
    } else {
      try {
        logger.info("\u{1F9ED} on_finish: skipped due to shouldStopExecution");
      } catch {
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
    try {
      if (sessionIds.size > 0) {
        const { SessionRegistry: SessionRegistry2 } = (init_session_registry(), __toCommonJS(session_registry_exports));
        SessionRegistry2.getInstance().clearAllSessions();
      }
    } catch {
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
          const gate = await this.shouldRunCheck(
            checkName,
            checkConfig.if,
            prInfo,
            /* @__PURE__ */ new Map(),
            debug,
            this.routingEventOverride,
            /* failSecure */
            true
          );
          if (!gate.shouldRun) {
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
          eventContext: this.enrichEventContext(prInfo.eventContext),
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
      eventContext: this.enrichEventContext(prInfo.eventContext),
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
    const processed = /* @__PURE__ */ new Set();
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
        processed.add(checkName);
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
    for (const [checkName, result] of results.entries()) {
      if (processed.has(checkName)) continue;
      if (!result) continue;
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
      debugInfo.push(
        `\u2705 (dynamic) Check "${checkName}" included: ${(result.issues || []).length} issues found`
      );
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
    summary.__executed = Array.from(results.keys());
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
   * Get available check types from providers
   * Note: Check names are now config-driven. This returns provider types only.
   */
  static getAvailableCheckTypes() {
    const registry = CheckProviderRegistry.getInstance();
    return registry.getAvailableProviders();
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
  async evaluateFailureConditions(checkName, reviewSummary, config, prInfo, previousOutputs) {
    if (!config) {
      return [];
    }
    const checkConfig = config.checks[checkName];
    const checkSchema = typeof checkConfig?.schema === "object" ? "custom" : checkConfig?.schema || "";
    const checkGroup = checkConfig?.group || "";
    const outputsRecord = previousOutputs ? previousOutputs instanceof Map ? Object.fromEntries(previousOutputs.entries()) : previousOutputs : void 0;
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
          globalFailIf,
          outputsRecord
        );
        try {
          addEvent("fail_if.evaluated", {
            check: checkName,
            scope: "global",
            name: "global_fail_if",
            expression: globalFailIf
          });
        } catch {
        }
        if (failed) {
          try {
            addEvent("fail_if.triggered", {
              check: checkName,
              scope: "global",
              name: "global_fail_if",
              expression: globalFailIf,
              severity: "error"
            });
          } catch {
          }
          try {
            addFailIfTriggered(checkName, "global");
          } catch {
          }
          try {
            const { emitNdjsonSpanWithEvents: emitNdjsonSpanWithEvents2 } = (init_fallback_ndjson(), __toCommonJS(fallback_ndjson_exports));
            emitNdjsonSpanWithEvents2(
              "visor.fail_if",
              { check: checkName, scope: "global", name: "global_fail_if" },
              [
                {
                  name: "fail_if.triggered",
                  attrs: {
                    check: checkName,
                    scope: "global",
                    name: "global_fail_if",
                    expression: globalFailIf,
                    severity: "error"
                  }
                }
              ]
            );
          } catch {
          }
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
          checkFailIf,
          outputsRecord
        );
        try {
          addEvent("fail_if.evaluated", {
            check: checkName,
            scope: "check",
            name: `${checkName}_fail_if`,
            expression: checkFailIf
          });
        } catch {
        }
        try {
          const { emitNdjsonSpanWithEvents: emitNdjsonSpanWithEvents2 } = (init_fallback_ndjson(), __toCommonJS(fallback_ndjson_exports));
          emitNdjsonSpanWithEvents2(
            "visor.fail_if",
            { check: checkName, scope: "check", name: `${checkName}_fail_if` },
            [
              {
                name: "fail_if.evaluated",
                attrs: {
                  check: checkName,
                  scope: "check",
                  name: `${checkName}_fail_if`,
                  expression: checkFailIf
                }
              }
            ]
          );
        } catch {
        }
        if (failed) {
          try {
            addEvent("fail_if.triggered", {
              check: checkName,
              scope: "check",
              name: `${checkName}_fail_if`,
              expression: checkFailIf,
              severity: "error"
            });
          } catch {
          }
          try {
            addEvent("fail_if.evaluated", {
              check: checkName,
              scope: "check",
              name: `${checkName}_fail_if`,
              expression: checkFailIf
            });
          } catch {
          }
          try {
            addFailIfTriggered(checkName, "check");
          } catch {
          }
          try {
            const { emitNdjsonSpanWithEvents: emitNdjsonSpanWithEvents2 } = (init_fallback_ndjson(), __toCommonJS(fallback_ndjson_exports));
            emitNdjsonSpanWithEvents2(
              "visor.fail_if",
              { check: checkName, scope: "check", name: `${checkName}_fail_if` },
              [
                {
                  name: "fail_if.triggered",
                  attrs: {
                    check: checkName,
                    scope: "check",
                    name: `${checkName}_fail_if`,
                    expression: checkFailIf,
                    severity: "error"
                  }
                }
              ]
            );
          } catch {
          }
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
      try {
        const { emitNdjsonSpanWithEvents: emitNdjsonSpanWithEvents2 } = (init_fallback_ndjson(), __toCommonJS(fallback_ndjson_exports));
        const hadTriggered = results.some((r) => r.failed === true);
        emitNdjsonSpanWithEvents2(
          "visor.fail_if",
          {
            check: checkName,
            scope: hadTriggered ? checkFailIf ? "check" : "global" : checkFailIf ? "check" : "global"
          },
          [
            {
              name: "fail_if.evaluated",
              attrs: { check: checkName, scope: checkFailIf ? "check" : "global" }
            }
          ].concat(
            hadTriggered ? [
              {
                name: "fail_if.triggered",
                attrs: { check: checkName, scope: checkFailIf ? "check" : "global" }
              }
            ] : []
          )
        );
      } catch {
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
      providerDurationMs: 0,
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
   * Record provider/self execution time (in milliseconds) for a check
   */
  recordProviderDuration(checkName, ms) {
    const stats = this.executionStats.get(checkName);
    if (!stats) return;
    stats.providerDurationMs = (stats.providerDurationMs || 0) + Math.max(0, Math.floor(ms));
  }
  /**
   * Track output in history for loop/goto scenarios
   */
  trackOutputHistory(checkName, output) {
    if (output === void 0) return;
    if (!this.outputHistory.has(checkName)) {
      this.outputHistory.set(checkName, []);
    }
    this.outputHistory.get(checkName).push(output);
  }
  /**
   * Snapshot of output history per step for test assertions
   */
  getOutputHistorySnapshot() {
    const out = {};
    for (const [k, v] of this.outputHistory.entries()) {
      out[k] = Array.isArray(v) ? [...v] : [];
    }
    return out;
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
  async failIfTriggered(checkName, result, config, previousOutputs) {
    if (!config) return false;
    const failures = await this.evaluateFailureConditions(
      checkName,
      result,
      config,
      void 0,
      previousOutputs
    );
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
    const historyLen = (() => {
      try {
        return this.outputHistory.get(stats.checkName)?.length || 0;
      } catch {
        return 0;
      }
    })();
    const totalRuns = Math.max(stats.totalRuns || 0, historyLen);
    if (totalRuns === 0) return "-";
    const symbol = stats.failedRuns === 0 ? "\u2714" : stats.successfulRuns === 0 ? "\u2716" : "\u2714/\u2716";
    if (totalRuns > 1) {
      if (stats.failedRuns > 0 && stats.successfulRuns > 0) {
        return `${symbol} ${stats.successfulRuns}/${totalRuns}`;
      } else {
        return `${symbol} \xD7${totalRuns}`;
      }
    }
    return symbol;
  }
  /**
   * Format the Details column for execution summary table
   */
  formatDetailsColumn(stats, _isForEachParent) {
    const parts = [];
    if (typeof stats.providerDurationMs === "number" && stats.providerDurationMs > 0) {
      const selfSec = (stats.providerDurationMs / 1e3).toFixed(1);
      parts.unshift(`self:${selfSec}s`);
    }
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
      [`Checks Complete (${durationSec}s)`],
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
      colWidths: [21, 18, 10, 21],
      style: {
        head: ["cyan"],
        border: ["grey"]
      }
    });
    for (const checkStats of stats.checks) {
      const isForEachParent = !!this.config?.checks?.[checkStats.checkName]?.forEach;
      const selfMs = typeof checkStats.providerDurationMs === "number" && checkStats.providerDurationMs > 0 ? checkStats.providerDurationMs : checkStats.totalDuration;
      const duration = checkStats.skipped ? "-" : `${(selfMs / 1e3).toFixed(1)}s`;
      const status = this.formatStatusColumn(checkStats);
      const details = this.formatDetailsColumn(checkStats, isForEachParent);
      detailsTable.push([checkStats.checkName, duration, status, details]);
    }
    logger.info(detailsTable.toString());
    try {
      if (this.checkRunMap && this.checkRunMap.size > 0) {
        logger.info("");
        logger.info("\u23F3 Finalizing GitHub check runs...");
      }
    } catch {
    }
    logger.info("");
    logger.info(
      "Legend: \u2714=success \u2502 \u2716=failed \u2502 \u23ED=skipped \u2502 \xD7N=iterations \u2502 \u2192N=outputs \u2502 N\u{1F534}=critical \u2502 N\u26A0\uFE0F=warnings"
    );
  }
};

export {
  CheckExecutionEngine
};
//# sourceMappingURL=chunk-QBS2NN5Z.mjs.map