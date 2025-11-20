import {
  init_logger,
  logger
} from "./chunk-RH4HH6SI.mjs";
import {
  init_tracer_init,
  initializeTracer
} from "./chunk-OOZITMRU.mjs";
import {
  SessionRegistry,
  init_session_registry
} from "./chunk-6Y4YTKCF.mjs";
import {
  __esm,
  __require
} from "./chunk-WMJKH4XE.mjs";

// src/utils/diff-processor.ts
import { extract } from "@probelabs/probe";
import * as path from "path";
async function processDiffWithOutline(diffContent) {
  if (!diffContent || diffContent.trim().length === 0) {
    return diffContent;
  }
  try {
    const originalProbePath = process.env.PROBE_PATH;
    const fs = __require("fs");
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
      if (fs.existsSync(candidatePath)) {
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
var init_diff_processor = __esm({
  "src/utils/diff-processor.ts"() {
    "use strict";
  }
});

// src/ai-review-service.ts
import { ProbeAgent } from "@probelabs/probe";
function log(...args) {
  logger.debug(args.join(" "));
}
var AIReviewService;
var init_ai_review_service = __esm({
  "src/ai-review-service.ts"() {
    "use strict";
    init_session_registry();
    init_logger();
    init_tracer_init();
    init_diff_processor();
    AIReviewService = class {
      config;
      sessionRegistry;
      constructor(config = {}) {
        this.config = {
          timeout: 6e5,
          // Increased timeout to 10 minutes for AI responses
          ...config
        };
        this.sessionRegistry = SessionRegistry.getInstance();
        if (typeof this.config.debug === "undefined") {
          try {
            if (process.env.VISOR_PROVIDER_DEBUG === "true" || process.env.VISOR_DEBUG === "true") {
              this.config.debug = true;
            }
          } catch {
          }
        }
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
        const prompt = await this.buildCustomPrompt(prInfo, customPrompt, schema, {
          skipPRContext: this.config?.skip_code_context === true
        });
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
            let historicalComments = triggeringComment2 ? issueComments.filter((c) => c.id !== triggeringComment2.id) : issueComments;
            if (isCodeReviewSchema) {
              historicalComments = historicalComments.filter(
                (c) => !c.body || !c.body.includes("visor-comment-id:pr-review-")
              );
            }
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
        try {
          const firstFile = (prInfo.files || [])[0];
          if (firstFile && firstFile.filename) {
            context += `
  <raw_diff_header>
${this.escapeXml(`diff --git a/${firstFile.filename} b/${firstFile.filename}`)}
  </raw_diff_header>`;
          }
        } catch {
        }
        if (prInfo.body) {
          context += `
  <!-- Full pull request description provided by the author -->
  <description>
${this.escapeXml(prInfo.body)}
  </description>`;
        }
        if (includeCodeContext) {
          if (prInfo.fullDiff) {
            const processedFullDiff = await processDiffWithOutline(prInfo.fullDiff);
            context += `
  <!-- Complete unified diff showing all changes in the pull request (processed with outline-diff) -->
  <full_diff>
${this.escapeXml(processedFullDiff)}
  </full_diff>`;
          }
          if (prInfo.isIncremental) {
            if (prInfo.commitDiff && prInfo.commitDiff.length > 0) {
              const processedCommitDiff = await processDiffWithOutline(prInfo.commitDiff);
              context += `
  <!-- Diff of only the latest commit for incremental analysis (processed with outline-diff) -->
  <commit_diff>
${this.escapeXml(processedCommitDiff)}
  </commit_diff>`;
            } else {
              const processedFallbackDiff = prInfo.fullDiff ? await processDiffWithOutline(prInfo.fullDiff) : "";
              context += `
  <!-- Commit diff could not be retrieved - falling back to full diff analysis (processed with outline-diff) -->
  <commit_diff>
${this.escapeXml(processedFallbackDiff)}
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
          let historicalComments = triggeringComment ? prComments.filter((c) => c.id !== triggeringComment.id) : prComments;
          if (isCodeReviewSchema) {
            historicalComments = historicalComments.filter(
              (c) => !c.body || !c.body.includes("visor-comment-id:pr-review-")
            );
          }
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
              const fs = __require("fs");
              const path2 = __require("path");
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
              const debugArtifactsDir = process.env.VISOR_DEBUG_ARTIFACTS || path2.join(process.cwd(), "debug-artifacts");
              if (!fs.existsSync(debugArtifactsDir)) {
                fs.mkdirSync(debugArtifactsDir, { recursive: true });
              }
              const debugFile = path2.join(
                debugArtifactsDir,
                `prompt-${_checkName || "unknown"}-${timestamp}.json`
              );
              fs.writeFileSync(debugFile, debugJson, "utf-8");
              const readableFile = path2.join(
                debugArtifactsDir,
                `prompt-${_checkName || "unknown"}-${timestamp}.txt`
              );
              fs.writeFileSync(readableFile, readableVersion, "utf-8");
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
              const fs = __require("fs");
              const path2 = __require("path");
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
              const debugArtifactsDir = process.env.VISOR_DEBUG_ARTIFACTS || path2.join(process.cwd(), "debug-artifacts");
              const sessionBase = path2.join(
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
              fs.writeFileSync(sessionBase + ".json", JSON.stringify(sessionData, null, 2), "utf-8");
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
              fs.writeFileSync(sessionBase + ".summary.txt", readable, "utf-8");
              log(`\u{1F4BE} Complete session history saved:`);
              log(`   - Contains ALL ${fullHistory.length} messages (prompts + responses)`);
            } catch (error) {
              log(`\u26A0\uFE0F Could not save complete session history: ${error}`);
            }
          }
          if (process.env.VISOR_DEBUG_AI_SESSIONS === "true") {
            try {
              const fs = __require("fs");
              const path2 = __require("path");
              const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
              const debugArtifactsDir = process.env.VISOR_DEBUG_ARTIFACTS || path2.join(process.cwd(), "debug-artifacts");
              const responseFile = path2.join(
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
              fs.writeFileSync(responseFile, responseContent, "utf-8");
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
                  const fs = __require("fs");
                  if (fs.existsSync(agentAny._traceFilePath)) {
                    const stats = fs.statSync(agentAny._traceFilePath);
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
          const explicitPromptType = (process.env.VISOR_PROMPT_TYPE || "").trim();
          const options = {
            sessionId,
            // Prefer config promptType, then env override, else fallback to code-review when schema is set
            promptType: this.config.promptType && this.config.promptType.trim() ? this.config.promptType.trim() : explicitPromptType ? explicitPromptType : schema === "code-review" ? "code-review-template" : void 0,
            allowEdit: false,
            // We don't want the agent to modify files
            debug: this.config.debug || false,
            // Map systemPrompt to Probe customPrompt until SDK exposes a first-class field
            customPrompt: this.config.systemPrompt || this.config.customPrompt
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
          if (this.config.retry) {
            options.retry = this.config.retry;
          }
          if (this.config.fallback) {
            options.fallback = this.config.fallback;
          }
          if (this.config.allowEdit !== void 0) {
            options.allowEdit = this.config.allowEdit;
          }
          if (this.config.allowedTools !== void 0) {
            options.allowedTools = this.config.allowedTools;
          }
          if (this.config.disableTools !== void 0) {
            options.disableTools = this.config.disableTools;
          }
          if (this.config.allowBash !== void 0) {
            options.allowBash = this.config.allowBash;
          }
          if (this.config.bashConfig !== void 0) {
            options.bashConfig = this.config.bashConfig;
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
              const fs = __require("fs");
              const path2 = __require("path");
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
              const promptFile = path2.join(tempDir, `visor-prompt-${timestamp}.txt`);
              fs.writeFileSync(promptFile, prompt, "utf-8");
              log(`
\u{1F4BE} Prompt saved to: ${promptFile}`);
              const debugArtifactsDir = process.env.VISOR_DEBUG_ARTIFACTS || path2.join(process.cwd(), "debug-artifacts");
              try {
                const base = path2.join(
                  debugArtifactsDir,
                  `prompt-${_checkName || "unknown"}-${timestamp}`
                );
                fs.writeFileSync(base + ".json", debugJson, "utf-8");
                fs.writeFileSync(base + ".summary.txt", readableVersion, "utf-8");
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
              const fs = __require("fs");
              const path2 = __require("path");
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
              const debugArtifactsDir = process.env.VISOR_DEBUG_ARTIFACTS || path2.join(process.cwd(), "debug-artifacts");
              const sessionBase = path2.join(
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
              fs.writeFileSync(sessionBase + ".json", JSON.stringify(sessionData, null, 2), "utf-8");
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
              fs.writeFileSync(sessionBase + ".summary.txt", readable, "utf-8");
              log(`\u{1F4BE} Complete session history saved:`);
              log(`   - Contains ALL ${fullHistory.length} messages (prompts + responses)`);
            } catch (error) {
              log(`\u26A0\uFE0F Could not save complete session history: ${error}`);
            }
          }
          if (process.env.VISOR_DEBUG_AI_SESSIONS === "true") {
            try {
              const fs = __require("fs");
              const path2 = __require("path");
              const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
              const debugArtifactsDir = process.env.VISOR_DEBUG_ARTIFACTS || path2.join(process.cwd(), "debug-artifacts");
              const responseFile = path2.join(
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
              fs.writeFileSync(responseFile, responseContent, "utf-8");
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
                  const fs = __require("fs");
                  if (fs.existsSync(traceFilePath)) {
                    const stats = fs.statSync(traceFilePath);
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
        const fs = __require("fs").promises;
        const path2 = __require("path");
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
        if ((schema.startsWith("./") || schema.includes(".json")) && !path2.isAbsolute(schema)) {
          if (schema.includes("..") || schema.includes("\0")) {
            throw new Error("Invalid schema path: path traversal not allowed");
          }
          try {
            const schemaPath = path2.resolve(process.cwd(), schema);
            log(`\u{1F4CB} Loading custom schema from file: ${schemaPath}`);
            const schemaContent = await fs.readFile(schemaPath, "utf-8");
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
          path2.join(__dirname, "output", sanitizedSchemaName, "schema.json"),
          // Historical fallback when src/output was inadvertently bundled as output1/
          path2.join(__dirname, "output1", sanitizedSchemaName, "schema.json"),
          // Local dev (repo root)
          path2.join(process.cwd(), "output", sanitizedSchemaName, "schema.json")
        ];
        for (const schemaPath of candidatePaths) {
          try {
            const schemaContent = await fs.readFile(schemaPath, "utf-8");
            return schemaContent.trim();
          } catch {
          }
        }
        const distPath = path2.join(__dirname, "output", sanitizedSchemaName, "schema.json");
        const distAltPath = path2.join(__dirname, "output1", sanitizedSchemaName, "schema.json");
        const cwdPath = path2.join(process.cwd(), "output", sanitizedSchemaName, "schema.json");
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
        await new Promise((resolve) => setTimeout(resolve, 500));
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
  }
});

export {
  AIReviewService,
  init_ai_review_service
};
//# sourceMappingURL=chunk-6G33VHM7.mjs.map