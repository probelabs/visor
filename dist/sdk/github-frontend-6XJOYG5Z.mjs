import {
  failure_condition_evaluator_exports,
  init_failure_condition_evaluator
} from "./chunk-OZJ263FM.mjs";
import "./chunk-CNX7V5JK.mjs";
import "./chunk-ZYAUYXSW.mjs";
import "./chunk-S2RUE2RG.mjs";
import "./chunk-YSN4G6CI.mjs";
import "./chunk-37ZSCMFC.mjs";
import {
  init_logger,
  logger
} from "./chunk-VMPLF6FT.mjs";
import {
  __esm,
  __export,
  __toCommonJS
} from "./chunk-WMJKH4XE.mjs";

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
var init_footer = __esm({
  "src/footer.ts"() {
    "use strict";
  }
});

// src/github-check-service.ts
var github_check_service_exports = {};
__export(github_check_service_exports, {
  GitHubCheckService: () => GitHubCheckService
});
var GitHubCheckService;
var init_github_check_service = __esm({
  "src/github-check-service.ts"() {
    "use strict";
    init_footer();
    GitHubCheckService = class {
      octokit;
      maxAnnotations = 50;
      // GitHub API limit
      constructor(octokit) {
        this.octokit = octokit;
      }
      /**
       * Create a new check run in queued status
       * M4: Includes engine_mode metadata in summary
       */
      async createCheckRun(options, summary) {
        try {
          const enhancedSummary = summary && options.engine_mode ? {
            ...summary,
            summary: `${summary.summary}

_Engine: ${options.engine_mode}_`
          } : summary;
          const response = await this.octokit.rest.checks.create({
            owner: options.owner,
            repo: options.repo,
            name: options.name,
            head_sha: options.head_sha,
            status: "queued",
            details_url: options.details_url,
            external_id: options.external_id,
            output: enhancedSummary ? {
              title: enhancedSummary.title,
              summary: enhancedSummary.summary,
              text: enhancedSummary.text
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
            sections.push("### Failed Conditions");
            failedConditions.forEach((condition) => {
              sections.push(
                `- **${condition.conditionName}**: ${condition.message || condition.expression}`
              );
              if (condition.severity) {
                const icon = this.getSeverityEmoji(condition.severity);
                sections.push(`  - Severity: ${icon} ${condition.severity}`);
              }
            });
            sections.push("");
          }
          if (passedConditions.length > 0) {
            sections.push("### Passed Conditions");
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
          sections.push("## Issues by Category");
          Object.entries(issuesByCategory).forEach(([category, issues]) => {
            if (issues.length > 0) {
              sections.push(
                `### ${category.charAt(0).toUpperCase() + category.slice(1)} (${issues.length})`
              );
              const displayIssues = issues.slice(0, 5);
              displayIssues.forEach((issue) => {
                const severityIcon = this.getSeverityEmoji(issue.severity);
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
       * Get emoji for issue severity (allowed; step/category emojis are removed)
       */
      getSeverityEmoji(severity) {
        const iconMap = {
          critical: "\u{1F6A8}",
          error: "\u274C",
          warning: "\u26A0\uFE0F",
          info: "\u2139\uFE0F"
        };
        return iconMap[String(severity || "").toLowerCase()] || "";
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
  }
});

// src/github-comments.ts
var github_comments_exports = {};
__export(github_comments_exports, {
  CommentManager: () => CommentManager
});
import { v4 as uuidv4 } from "uuid";
var CommentManager;
var init_github_comments = __esm({
  "src/github-comments.ts"() {
    "use strict";
    init_logger();
    init_footer();
    CommentManager = class {
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
  }
});

// src/frontends/github-frontend.ts
init_logger();
var GitHubFrontend = class {
  name = "github";
  subs = [];
  checkRunIds = /* @__PURE__ */ new Map();
  revision = 0;
  cachedCommentId;
  // legacy single-thread id (kept for compatibility)
  // Group → (checkId → SectionState)
  stepStatusByGroup = /* @__PURE__ */ new Map();
  // Debounce/coalescing state
  debounceMs = 400;
  maxWaitMs = 2e3;
  _timer = null;
  _lastFlush = 0;
  _pendingIds = /* @__PURE__ */ new Set();
  start(ctx) {
    const log = ctx.logger;
    const bus = ctx.eventBus;
    const octokit = ctx.octokit;
    const repo = ctx.run.repo;
    const pr = ctx.run.pr;
    const headSha = ctx.run.headSha;
    const canPostComments = !!(octokit && repo && pr);
    const canPostChecks = !!(octokit && repo && pr && headSha);
    const svc = canPostChecks ? new (init_github_check_service(), __toCommonJS(github_check_service_exports)).GitHubCheckService(octokit) : null;
    const CommentManager2 = (init_github_comments(), __toCommonJS(github_comments_exports)).CommentManager;
    const comments = canPostComments ? new CommentManager2(octokit) : null;
    const threadKey = repo && pr && headSha ? `${repo.owner}/${repo.name}#${pr}@${(headSha || "").substring(0, 7)}` : ctx.run.runId;
    this.cachedCommentId = `visor-thread-${threadKey}`;
    this.subs.push(
      bus.on("CheckScheduled", async (env) => {
        const ev = env && env.payload || env;
        try {
          if (!canPostChecks || !svc) return;
          if (this.checkRunIds.has(ev.checkId)) return;
          const group = this.getGroupForCheck(ctx, ev.checkId);
          this.upsertSectionState(group, ev.checkId, {
            status: "queued",
            lastUpdated: (/* @__PURE__ */ new Date()).toISOString()
          });
          const res = await svc.createCheckRun(
            {
              owner: repo.owner,
              repo: repo.name,
              head_sha: headSha,
              name: `Visor: ${ev.checkId}`,
              external_id: `visor:${ctx.run.runId}:${ev.checkId}`,
              engine_mode: "state-machine"
            },
            { title: `${ev.checkId}`, summary: "Queued" }
          );
          this.checkRunIds.set(ev.checkId, res.id);
        } catch (e) {
          log.warn(
            `[github-frontend] createCheckRun failed for ${ev.checkId}: ${e instanceof Error ? e.message : e}`
          );
        }
      })
    );
    this.subs.push(
      bus.on("CheckCompleted", async (env) => {
        const ev = env && env.payload || env;
        try {
          if (canPostChecks && svc && this.checkRunIds.has(ev.checkId)) {
            const id = this.checkRunIds.get(ev.checkId);
            const issues = Array.isArray(ev.result?.issues) ? ev.result.issues : [];
            const failureResults = await this.evaluateFailureResults(ctx, ev.checkId, ev.result);
            await svc.completeCheckRun(
              repo.owner,
              repo.name,
              id,
              ev.checkId,
              failureResults,
              issues,
              void 0,
              void 0,
              pr,
              headSha
            );
          }
          if (canPostComments && comments) {
            const count = Array.isArray(ev.result?.issues) ? ev.result.issues.length : 0;
            const failureResults = await this.evaluateFailureResults(ctx, ev.checkId, ev.result);
            const failed = Array.isArray(failureResults) ? failureResults.some((r) => r && r.failed) : false;
            const group = this.getGroupForCheck(ctx, ev.checkId);
            this.upsertSectionState(group, ev.checkId, {
              status: "completed",
              conclusion: failed ? "failure" : "success",
              issues: count,
              lastUpdated: (/* @__PURE__ */ new Date()).toISOString(),
              content: ev?.result?.content
            });
            await this.updateGroupedComment(ctx, comments, group, ev.checkId);
          }
        } catch (e) {
          log.warn(
            `[github-frontend] handle CheckCompleted failed: ${e instanceof Error ? e.message : e}`
          );
        }
      })
    );
    this.subs.push(
      bus.on("CheckErrored", async (env) => {
        const ev = env && env.payload || env;
        try {
          if (canPostChecks && svc && this.checkRunIds.has(ev.checkId)) {
            const id = this.checkRunIds.get(ev.checkId);
            await svc.completeCheckRun(
              repo.owner,
              repo.name,
              id,
              ev.checkId,
              [],
              [],
              ev.error?.message || "Execution error",
              void 0,
              pr,
              headSha
            );
          }
          if (canPostComments && comments) {
            const group = this.getGroupForCheck(ctx, ev.checkId);
            this.upsertSectionState(group, ev.checkId, {
              status: "errored",
              conclusion: "failure",
              issues: 0,
              lastUpdated: (/* @__PURE__ */ new Date()).toISOString(),
              error: ev.error?.message || "Execution error"
            });
            await this.updateGroupedComment(ctx, comments, group, ev.checkId);
          }
        } catch (e) {
          log.warn(
            `[github-frontend] handle CheckErrored failed: ${e instanceof Error ? e.message : e}`
          );
        }
      })
    );
    this.subs.push(
      bus.on("StateTransition", async (env) => {
        const ev = env && env.payload || env;
        try {
          if (ev.to === "Completed" || ev.to === "Error") {
            if (canPostComments && comments) {
              for (const group of this.stepStatusByGroup.keys()) {
                await this.updateGroupedComment(ctx, comments, group);
              }
            }
          }
        } catch (e) {
          log.warn(
            `[github-frontend] handle StateTransition failed: ${e instanceof Error ? e.message : e}`
          );
        }
      })
    );
  }
  stop() {
    for (const s of this.subs) s.unsubscribe();
    this.subs = [];
  }
  async buildFullBody(ctx, group) {
    const header = this.renderThreadHeader(ctx, group);
    const sections = this.renderSections(ctx, group);
    return `${header}

${sections}

<!-- visor:thread-end key="${this.threadKeyFor(ctx)}" -->`;
  }
  threadKeyFor(ctx) {
    const r = ctx.run;
    return r.repo && r.pr && r.headSha ? `${r.repo.owner}/${r.repo.name}#${r.pr}@${(r.headSha || "").substring(0, 7)}` : r.runId;
  }
  renderThreadHeader(ctx, group) {
    const header = {
      key: this.threadKeyFor(ctx),
      runId: ctx.run.runId,
      workflowId: ctx.run.workflowId,
      revision: this.revision,
      group,
      generatedAt: (/* @__PURE__ */ new Date()).toISOString()
    };
    return `<!-- visor:thread=${JSON.stringify(header)} -->`;
  }
  renderSections(ctx, group) {
    const lines = [];
    const groupMap = this.stepStatusByGroup.get(group) || /* @__PURE__ */ new Map();
    for (const [checkId, st] of groupMap.entries()) {
      const start = `<!-- visor:section=${JSON.stringify({ id: checkId, revision: this.revision })} -->`;
      const end = `<!-- visor:section-end id="${checkId}" -->`;
      const body = st.content && st.content.toString().trim().length > 0 ? st.content.toString().trim() : "";
      lines.push(`${start}
${body}
${end}`);
    }
    return lines.join("\\n\\n");
  }
  async updateGroupedComment(ctx, comments, group, changedIds) {
    try {
      if (!ctx.run.repo || !ctx.run.pr) return;
      const config = ctx.config;
      const prCommentEnabled = config?.output?.pr_comment?.enabled !== false;
      if (!prCommentEnabled) {
        logger.debug(
          `[github-frontend] PR comments disabled in config, skipping comment for group: ${group}`
        );
        return;
      }
      this.revision++;
      const mergedBody = await this.mergeIntoExistingBody(ctx, comments, group, changedIds);
      await comments.updateOrCreateComment(
        ctx.run.repo.owner,
        ctx.run.repo.name,
        ctx.run.pr,
        mergedBody,
        {
          commentId: this.commentIdForGroup(ctx, group),
          triggeredBy: this.deriveTriggeredBy(ctx),
          commitSha: ctx.run.headSha
        }
      );
    } catch (e) {
      logger.debug(
        `[github-frontend] updateGroupedComment failed: ${e instanceof Error ? e.message : e}`
      );
    }
  }
  deriveTriggeredBy(ctx) {
    const ev = ctx.run.event || "";
    const actor = ctx.run.actor;
    const commentEvents = /* @__PURE__ */ new Set([
      "issue_comment",
      "issue_comment_created",
      "pr_comment",
      "comment",
      "pull_request_review_comment"
    ]);
    if (commentEvents.has(ev) && actor) return actor;
    if (ev) return ev;
    return actor || "unknown";
  }
  async mergeIntoExistingBody(ctx, comments, group, changedIds) {
    const repo = ctx.run.repo;
    const pr = ctx.run.pr;
    const existing = await comments.findVisorComment(
      repo.owner,
      repo.name,
      pr,
      this.commentIdForGroup(ctx, group)
    );
    if (!existing || !existing.body) return this.buildFullBody(ctx, group);
    const body = String(existing.body);
    const doc = this.parseSections(body);
    doc.header = {
      ...doc.header || {},
      key: this.threadKeyFor(ctx),
      revision: this.revision,
      group
    };
    if (changedIds) {
      const ids = Array.isArray(changedIds) ? changedIds : [changedIds];
      const fresh = this.renderSections(ctx, group);
      for (const id of ids) {
        const block = this.extractSectionById(fresh, id);
        if (block) doc.sections.set(id, block);
      }
    } else {
      const fresh = this.renderSections(ctx, group);
      const map = this.stepStatusByGroup.get(group) || /* @__PURE__ */ new Map();
      for (const [checkId] of map.entries()) {
        if (!doc.sections.has(checkId)) {
          const block = this.extractSectionById(fresh, checkId);
          if (block) doc.sections.set(checkId, block);
        }
      }
    }
    return this.serializeSections(doc);
  }
  parseSections(body) {
    const sections = /* @__PURE__ */ new Map();
    const headerRe = /<!--\s*visor:thread=(\{[\s\S]*?\})\s*-->/m;
    const startRe = /<!--\s*visor:section=(\{[\s\S]*?\})\s*-->/g;
    const endRe = /<!--\s*visor:section-end\s+id=\"([^\"]+)\"\s*-->/g;
    const safePick = (obj, allowed) => {
      if (!obj || typeof obj !== "object" || Array.isArray(obj)) return void 0;
      const out = /* @__PURE__ */ Object.create(null);
      for (const [k, t] of Object.entries(allowed)) {
        if (Object.prototype.hasOwnProperty.call(obj, k)) {
          const v = obj[k];
          if (t === "string" && typeof v === "string") out[k] = v;
          else if (t === "number" && typeof v === "number" && Number.isFinite(v)) out[k] = v;
        }
      }
      return out;
    };
    const safeParse = (text) => {
      try {
        return JSON.parse(text);
      } catch {
        return void 0;
      }
    };
    let header;
    try {
      const h = headerRe.exec(body);
      if (h) {
        const parsed = safeParse(h[1]);
        const picked = safePick(parsed, {
          key: "string",
          runId: "string",
          workflowId: "string",
          revision: "number",
          group: "string",
          generatedAt: "string"
        });
        header = picked;
      }
    } catch {
    }
    let cursor = 0;
    while (true) {
      const s = startRe.exec(body);
      if (!s) break;
      const metaRaw = safeParse(s[1]);
      const meta = safePick(metaRaw, { id: "string", revision: "number" }) || { id: "" };
      const startIdx = startRe.lastIndex;
      endRe.lastIndex = startIdx;
      const e = endRe.exec(body);
      if (!e) break;
      const id = typeof meta.id === "string" && meta.id ? String(meta.id) : String(e[1]);
      const content = body.substring(startIdx, e.index).trim();
      const block = `<!-- visor:section=${JSON.stringify(meta)} -->
${content}
<!-- visor:section-end id="${id}" -->`;
      sections.set(id, block);
      cursor = endRe.lastIndex;
      startRe.lastIndex = cursor;
    }
    return { header, sections };
  }
  serializeSections(doc) {
    const header = `<!-- visor:thread=${JSON.stringify({ ...doc.header || {}, generatedAt: (/* @__PURE__ */ new Date()).toISOString() })} -->`;
    const blocks = Array.from(doc.sections.values()).join("\n\n");
    const key = doc.header && doc.header.key || "";
    return `${header}

${blocks}

<!-- visor:thread-end key="${key}" -->`;
  }
  extractSectionById(rendered, id) {
    const rx = new RegExp(
      `<!--\\s*visor:section=(\\{[\\s\\S]*?\\})\\s*-->[\\s\\S]*?<!--\\s*visor:section-end\\s+id=\\"${this.escapeRegExp(id)}\\"\\s*-->`,
      "m"
    );
    const m = rx.exec(rendered);
    return m ? m[0] : void 0;
  }
  escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&");
  }
  getGroupForCheck(ctx, checkId) {
    try {
      const cfg = ctx.config || {};
      const g = cfg?.checks?.[checkId]?.group || cfg?.steps?.[checkId]?.group;
      if (typeof g === "string" && g.trim().length > 0) return g;
    } catch {
    }
    return "review";
  }
  upsertSectionState(group, checkId, patch) {
    let groupMap = this.stepStatusByGroup.get(group);
    if (!groupMap) {
      groupMap = /* @__PURE__ */ new Map();
      this.stepStatusByGroup.set(group, groupMap);
    }
    const prev = groupMap.get(checkId) || { status: "queued", lastUpdated: (/* @__PURE__ */ new Date()).toISOString() };
    groupMap.set(checkId, { ...prev, ...patch });
  }
  commentIdForGroup(ctx, group) {
    const r = ctx.run;
    const base = r.repo && r.pr ? `${r.repo.owner}/${r.repo.name}#${r.pr}` : r.runId;
    return `visor-thread-${group}-${base}`;
  }
  /**
   * Compute failure condition results for a completed check so Check Runs map to the
   * correct GitHub conclusion. This mirrors the engine's evaluation for fail_if.
   */
  async evaluateFailureResults(ctx, checkId, result) {
    try {
      const config = ctx.config || {};
      const checks = config && config.checks || {};
      const checkCfg = checks[checkId] || {};
      const checkSchema = typeof checkCfg.schema === "string" ? checkCfg.schema : "code-review";
      const checkGroup = checkCfg.group || "default";
      const { FailureConditionEvaluator } = (init_failure_condition_evaluator(), __toCommonJS(failure_condition_evaluator_exports));
      const evaluator = new FailureConditionEvaluator();
      const reviewSummary = { issues: Array.isArray(result?.issues) ? result.issues : [] };
      const failures = [];
      if (config.fail_if) {
        const failed = await evaluator.evaluateSimpleCondition(
          checkId,
          checkSchema,
          checkGroup,
          reviewSummary,
          config.fail_if
        );
        failures.push({
          conditionName: "global_fail_if",
          failed,
          expression: config.fail_if,
          severity: "error",
          haltExecution: false
        });
      }
      if (checkCfg.fail_if) {
        const failed = await evaluator.evaluateSimpleCondition(
          checkId,
          checkSchema,
          checkGroup,
          reviewSummary,
          checkCfg.fail_if
        );
        failures.push({
          conditionName: `${checkId}_fail_if`,
          failed,
          expression: checkCfg.fail_if,
          severity: "error",
          haltExecution: false
        });
      }
      return failures;
    } catch {
      return [];
    }
  }
  // Debounce helpers
  scheduleUpdate(ctx, comments, group, id) {
    if (id) this._pendingIds.add(id);
    const now = Date.now();
    const since = now - this._lastFlush;
    const remaining = this.maxWaitMs - since;
    if (this._timer) clearTimeout(this._timer);
    const wait = Math.max(0, Math.min(this.debounceMs, remaining));
    this._timer = setTimeout(async () => {
      const ids = Array.from(this._pendingIds);
      this._pendingIds.clear();
      this._timer = null;
      await this.updateGroupedComment(ctx, comments, group, ids.length > 0 ? ids : void 0);
      this._lastFlush = Date.now();
    }, wait);
  }
  async flushNow(ctx, comments, group) {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    const ids = Array.from(this._pendingIds);
    this._pendingIds.clear();
    await this.updateGroupedComment(ctx, comments, group, ids.length > 0 ? ids : void 0);
    this._lastFlush = Date.now();
  }
};
export {
  GitHubFrontend
};
//# sourceMappingURL=github-frontend-6XJOYG5Z.mjs.map