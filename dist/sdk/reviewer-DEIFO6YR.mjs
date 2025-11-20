import {
  AIReviewService,
  init_ai_review_service
} from "./chunk-6G33VHM7.mjs";
import {
  init_logger,
  logger
} from "./chunk-RH4HH6SI.mjs";
import "./chunk-OOZITMRU.mjs";
import "./chunk-6Y4YTKCF.mjs";
import {
  __require
} from "./chunk-WMJKH4XE.mjs";

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
      const title = this.formatGroupTitle(groupKey, totalScore, totalIssues);
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
    return new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
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
  // Emoji helper removed: plain titles are used in group headers
  /**
   * Format group title with score and issue count
   */
  formatGroupTitle(groupKey, score, issuesFound) {
    const formattedScore = Math.round(score);
    return `${groupKey} Review (Score: ${formattedScore}/100)${issuesFound > 0 ? ` - ${issuesFound} issues found` : ""}`;
  }
};

// src/reviewer.ts
init_ai_review_service();
function convertReviewSummaryToGroupedResults(reviewSummary, checkName = "test-check", groupName = "default") {
  let content = "";
  if (reviewSummary.issues && reviewSummary.issues.length > 0) {
    content += `## Issues Found (${reviewSummary.issues.length})

`;
    reviewSummary.issues.forEach((issue) => {
      content += `- **${issue.severity.toUpperCase()}**: ${issue.message} (${issue.file}:${issue.line})
`;
    });
    content += "\n";
  }
  if (!content) {
    content = "No issues found.";
  }
  const checkResult = {
    checkName,
    content: content.trim(),
    group: groupName,
    debug: reviewSummary.debug,
    issues: reviewSummary.issues
    // Include structured issues
  };
  const groupedResults = {};
  groupedResults[groupName] = [checkResult];
  return groupedResults;
}
function calculateTotalIssues(issues) {
  return (issues || []).length;
}
function calculateCriticalIssues(issues) {
  return (issues || []).filter((i) => i.severity === "critical").length;
}
function convertIssuesToComments(issues) {
  return issues.map((issue) => ({
    file: issue.file,
    line: issue.line,
    message: issue.message,
    severity: issue.severity,
    category: issue.category,
    suggestion: issue.suggestion,
    replacement: issue.replacement,
    ruleId: issue.ruleId
  }));
}
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
      const { StateMachineExecutionEngine } = await import("./state-machine-execution-engine-JFSQFGIW.mjs");
      const engine = new StateMachineExecutionEngine();
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
        const fs = __require("fs").promises;
        const path = __require("path");
        const sanitizedSchemaName = schema.replace(/[^a-zA-Z0-9-]/g, "");
        if (!sanitizedSchemaName || sanitizedSchemaName !== schema) {
          return false;
        }
        const candidatePaths = [
          path.join(__dirname, "output", sanitizedSchemaName, "schema.json"),
          path.join(process.cwd(), "output", sanitizedSchemaName, "schema.json")
        ];
        for (const schemaPath of candidatePaths) {
          try {
            const schemaContent = await fs.readFile(schemaPath, "utf-8");
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
      const manager = options.octokitOverride ? new CommentManager(options.octokitOverride) : this.commentManager;
      await manager.updateOrCreateComment(owner, repo, prNumber, comment, {
        commentId,
        triggeredBy: options.triggeredBy || "unknown",
        allowConcurrentUpdates: false,
        commitSha: options.commitSha
      });
    }
  }
  async formatGroupComment(checkResults, _options, _githubContext) {
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
      const fs = __require("fs");
      const path = __require("path");
      const debugDir = path.join(process.cwd(), "debug-artifacts");
      if (!fs.existsSync(debugDir)) {
        fs.mkdirSync(debugDir, { recursive: true });
      }
      const timestamp = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-");
      const filename = `visor-debug-${timestamp}.md`;
      const filepath = path.join(debugDir, filename);
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
      fs.writeFileSync(filepath, content, "utf8");
      return filename;
    } catch (error) {
      console.error("Failed to save debug artifact:", error);
      return null;
    }
  }
};
export {
  PRReviewer,
  calculateCriticalIssues,
  calculateTotalIssues,
  convertIssuesToComments,
  convertReviewSummaryToGroupedResults
};
//# sourceMappingURL=reviewer-DEIFO6YR.mjs.map