import { Octokit } from '@octokit/rest';
import { PRInfo } from './pr-analyzer';
import { CommentManager } from './github-comments';
import { AIReviewService, AIDebugInfo } from './ai-review-service';
import { Liquid } from 'liquidjs';
import fs from 'fs/promises';
import path from 'path';
import { CustomTemplateConfig } from './types/config';
import * as crypto from 'crypto';

export interface ReviewIssue {
  // Location
  file: string;
  line: number;
  endLine?: number;

  // Issue details
  ruleId: string;
  message: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
  category: 'security' | 'performance' | 'style' | 'logic' | 'documentation';

  // Group and schema for comment separation
  group?: string;
  schema?: string;
  // Timestamp when the issue was created (for ordering)
  timestamp?: number;
  // Custom template configuration
  template?: CustomTemplateConfig;

  // Optional enhancement
  suggestion?: string;
  replacement?: string;
}

// Keep old interface for backward compatibility during transition
export interface ReviewComment {
  file: string;
  line: number;
  message: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
  category: 'security' | 'performance' | 'style' | 'logic' | 'documentation';
  suggestion?: string;
  replacement?: string;
  ruleId?: string; // Added to preserve check information
}

export interface ReviewSummary {
  // Simplified - only raw data, calculations done elsewhere
  issues: ReviewIssue[];
  suggestions: string[];
  /** Debug information (only included when debug mode is enabled) */
  debug?: AIDebugInfo;
}

export interface ReviewOptions {
  focus?: 'security' | 'performance' | 'style' | 'all';
  format?: 'table' | 'json' | 'markdown' | 'sarif';
  debug?: boolean;
  config?: import('./types/config').VisorConfig;
  checks?: string[];
  parallelExecution?: boolean;
}

// Helper functions for calculating metrics from issues
export function calculateTotalIssues(issues: ReviewIssue[]): number {
  return issues.length;
}

export function calculateCriticalIssues(issues: ReviewIssue[]): number {
  return issues.filter(i => i.severity === 'critical').length;
}

export function convertIssuesToComments(issues: ReviewIssue[]): ReviewComment[] {
  return issues.map(issue => ({
    file: issue.file,
    line: issue.line,
    message: issue.message,
    severity: issue.severity,
    category: issue.category,
    suggestion: issue.suggestion,
    replacement: issue.replacement,
    ruleId: issue.ruleId, // Preserve ruleId for check-based grouping
  }));
}

export class PRReviewer {
  private commentManager: CommentManager;
  private aiReviewService: AIReviewService;

  constructor(private octokit: Octokit) {
    this.commentManager = new CommentManager(octokit);
    this.aiReviewService = new AIReviewService();
  }

  async reviewPR(
    owner: string,
    repo: string,
    prNumber: number,
    prInfo: PRInfo,
    options: ReviewOptions = {}
  ): Promise<ReviewSummary> {
    const { debug = false, config, checks } = options;

    // If we have a config and checks, use CheckExecutionEngine
    if (config && checks && checks.length > 0) {
      // Import CheckExecutionEngine dynamically to avoid circular dependencies
      const { CheckExecutionEngine } = await import('./check-execution-engine');
      const engine = new CheckExecutionEngine();

      // Execute checks using the engine
      const reviewSummary = await engine['executeReviewChecks'](
        prInfo,
        checks,
        undefined,
        config,
        undefined,
        debug
      );

      // Return all issues - no filtering needed
      return reviewSummary;
    }

    // No config provided - require configuration
    throw new Error(
      'No configuration provided. Please create a .visor.yaml file with check definitions. ' +
        'Built-in prompts have been removed - all checks must be explicitly configured.'
    );
  }

  async postReviewComment(
    owner: string,
    repo: string,
    prNumber: number,
    summary: ReviewSummary,
    options: ReviewOptions & { commentId?: string; triggeredBy?: string; commitSha?: string } = {}
  ): Promise<void> {
    // Group issues by their group property
    const issuesByGroup = this.groupIssuesByGroup(summary.issues);

    // If no groups or only one group, still use consistent group-based comment IDs
    if (Object.keys(issuesByGroup).length <= 1) {
      const comment = await this.formatReviewCommentWithVisorFormat(summary, options, {
        owner,
        repo,
        prNumber,
        commitSha: options.commitSha,
      });

      // Use consistent group-based comment ID even for single group
      const baseCommentId = options.commentId || 'visor-review';
      const groupName = Object.keys(issuesByGroup)[0] || 'default';
      const consistentCommentId = `${baseCommentId}-${groupName}`;

      await this.commentManager.updateOrCreateComment(owner, repo, prNumber, comment, {
        commentId: consistentCommentId,
        triggeredBy: options.triggeredBy || 'unknown',
        allowConcurrentUpdates: false,
        commitSha: options.commitSha,
      });
      return;
    }

    // Sort groups by the earliest timestamp of issues in each group
    // This ensures comments are posted in the order checks completed
    const sortedGroups = Object.entries(issuesByGroup).sort(
      ([_aName, aIssues], [_bName, bIssues]) => {
        // Find the earliest timestamp in each group
        const aEarliest = Math.min(...aIssues.map(i => i.timestamp || Infinity));
        const bEarliest = Math.min(...bIssues.map(i => i.timestamp || Infinity));
        return aEarliest - bEarliest;
      }
    );

    // Create separate comments for each group
    for (const [groupName, groupIssues] of sortedGroups) {
      const groupSummary: ReviewSummary = {
        ...summary,
        issues: groupIssues,
      };

      // Use group name in comment ID to create separate comments
      // Always include the group name suffix to ensure uniqueness
      const baseCommentId = options.commentId || 'visor-review';
      const groupCommentId = `${baseCommentId}-${groupName}`;

      const comment = await this.formatReviewCommentWithVisorFormat(groupSummary, options, {
        owner,
        repo,
        prNumber,
        commitSha: options.commitSha,
      });

      await this.commentManager.updateOrCreateComment(owner, repo, prNumber, comment, {
        commentId: groupCommentId,
        triggeredBy: options.triggeredBy || 'unknown',
        allowConcurrentUpdates: false,
        commitSha: options.commitSha,
      });
    }
  }

  private async formatReviewCommentWithVisorFormat(
    summary: ReviewSummary,
    _options: ReviewOptions,
    githubContext?: { owner: string; repo: string; prNumber: number; commitSha?: string }
  ): Promise<string> {
    let comment = '';

    // Simple header - let templates handle the content logic
    comment += `## 🔍 Code Analysis Results\n\n`;

    // Use template system for all content generation
    const templateContent = await this.renderWithSchemaTemplate(summary, githubContext);
    comment += templateContent;

    // Add debug section if available
    if (summary.debug) {
      comment += '\n\n' + this.formatDebugSection(summary.debug);
      comment += '\n\n';
    }

    // Simple footer
    comment += `\n---\n*Powered by [Visor](https://probelabs.com/visor) from [Probelabs](https://probelabs.com)*`;

    return comment;
  }

  private async renderWithSchemaTemplate(
    summary: ReviewSummary,
    githubContext?: { owner: string; repo: string; prNumber: number; commitSha?: string }
  ): Promise<string> {
    try {
      // If we have plain text suggestions (no schema/failed schema), render them directly
      if (summary.issues.length === 0 && summary.suggestions.length > 0) {
        return summary.suggestions.join('\n\n');
      }

      // If we have issues, use templates to render them
      if (summary.issues.length > 0) {
        const issuesByCheck = this.groupIssuesByCheck(summary.issues);
        const renderedSections: string[] = [];

        for (const [checkName, checkIssues] of Object.entries(issuesByCheck)) {
          const checkSchema = checkIssues[0]?.schema || 'code-review';
          const customTemplate = checkIssues[0]?.template;
          const renderedSection = await this.renderSingleCheckTemplate(
            checkName,
            checkIssues,
            checkSchema,
            customTemplate,
            githubContext
          );
          renderedSections.push(renderedSection);
        }

        return renderedSections.join('\n\n');
      }

      // No issues, no suggestions - let template handle this
      return await this.renderSingleCheckTemplate(
        'review',
        [],
        'code-review',
        undefined,
        githubContext
      );
    } catch (error) {
      console.warn(
        'Failed to render with schema-template system, falling back to old system:',
        error
      );
      // Fallback to old system if template fails
      const comments = convertIssuesToComments(summary.issues);
      return this.formatIssuesTable(comments);
    }
  }

  private generateGitHubDiffHash(filePath: string): string {
    // GitHub uses SHA256 hash of the file path for diff anchors
    return crypto.createHash('sha256').update(filePath).digest('hex');
  }

  private enhanceIssuesWithGitHubLinks(
    issues: ReviewIssue[],
    githubContext?: { owner: string; repo: string; prNumber: number; commitSha?: string }
  ): Array<ReviewIssue & { githubUrl?: string; fileHash?: string }> {
    if (!githubContext) {
      return issues;
    }

    // Use commit SHA for permalink format that auto-expands
    // If no commit SHA provided, fall back to PR files view
    const baseUrl = githubContext.commitSha
      ? `https://github.com/${githubContext.owner}/${githubContext.repo}/blob/${githubContext.commitSha}`
      : `https://github.com/${githubContext.owner}/${githubContext.repo}/pull/${githubContext.prNumber}/files`;

    return issues.map(issue => ({
      ...issue,
      githubUrl:
        githubContext.commitSha && issue.line
          ? `${baseUrl}/${issue.file}#L${issue.line}${issue.endLine && issue.endLine !== issue.line ? `-L${issue.endLine}` : ''}`
          : baseUrl,
      fileHash: this.generateGitHubDiffHash(issue.file),
    }));
  }

  private async renderSingleCheckTemplate(
    checkName: string,
    issues: ReviewIssue[],
    schema: string,
    customTemplate?: CustomTemplateConfig,
    githubContext?: { owner: string; repo: string; prNumber: number; commitSha?: string }
  ): Promise<string> {
    const liquid = new Liquid({
      // Configure Liquid to handle whitespace better
      trimTagLeft: false, // Don't auto-trim left side of tags
      trimTagRight: false, // Don't auto-trim right side of tags
      trimOutputLeft: false, // Don't auto-trim left side of output
      trimOutputRight: false, // Don't auto-trim right side of output
      greedy: false, // Don't be greedy with whitespace trimming
    });

    // Load template content based on configuration
    let templateContent: string;

    if (customTemplate) {
      templateContent = await this.loadCustomTemplate(customTemplate);
    } else {
      // Sanitize schema name to prevent path traversal attacks
      const sanitizedSchema = schema.replace(/[^a-zA-Z0-9-]/g, '');
      if (!sanitizedSchema) {
        throw new Error('Invalid schema name');
      }

      // Load the appropriate template based on schema
      const templatePath = path.join(__dirname, `../output/${sanitizedSchema}/template.liquid`);
      templateContent = await fs.readFile(templatePath, 'utf-8');
    }

    // Enhance issues with GitHub links if context is available
    const enhancedIssues = this.enhanceIssuesWithGitHubLinks(issues, githubContext);

    // Pass enhanced issues with GitHub links
    const templateData = {
      issues: enhancedIssues,
      checkName: checkName,
      github: githubContext,
    };

    // Render with Liquid template and trim extra whitespace at the start/end
    const rendered = await liquid.parseAndRender(templateContent, templateData);
    return rendered.trim();
  }

  private groupIssuesByCheck(issues: ReviewIssue[]): Record<string, ReviewIssue[]> {
    const grouped: Record<string, ReviewIssue[]> = {};

    for (const issue of issues) {
      const checkName = this.extractCheckNameFromRuleId(issue.ruleId || 'uncategorized');

      if (!grouped[checkName]) {
        grouped[checkName] = [];
      }

      grouped[checkName].push(issue);
    }

    return grouped;
  }

  private extractCheckNameFromRuleId(ruleId: string): string {
    if (ruleId && ruleId.includes('/')) {
      return ruleId.split('/')[0];
    }
    return 'uncategorized';
  }

  private groupIssuesByGroup(issues: ReviewIssue[]): Record<string, ReviewIssue[]> {
    const grouped: Record<string, ReviewIssue[]> = {};

    for (const issue of issues) {
      const groupName = issue.group || 'default';

      if (!grouped[groupName]) {
        grouped[groupName] = [];
      }

      grouped[groupName].push(issue);
    }

    return grouped;
  }

  private formatReviewComment(summary: ReviewSummary, options: ReviewOptions): string {
    const { format = 'table' } = options;

    // Calculate metrics from issues
    const totalIssues = calculateTotalIssues(summary.issues);
    const criticalIssues = calculateCriticalIssues(summary.issues);
    const comments = convertIssuesToComments(summary.issues);

    let comment = `## 🤖 AI Code Review\n\n`;
    comment += `**Issues Found:** ${totalIssues} (${criticalIssues} critical)\n\n`;

    if (summary.suggestions.length > 0) {
      comment += `### 💡 Suggestions\n`;
      for (const suggestion of summary.suggestions) {
        comment += `- ${suggestion}\n`;
      }
      comment += '\n';
    }

    if (comments.length > 0) {
      comment += `### 🔍 Code Issues\n`;
      for (const reviewComment of comments) {
        const emoji =
          reviewComment.severity === 'error'
            ? '❌'
            : reviewComment.severity === 'warning'
              ? '⚠️'
              : 'ℹ️';
        comment += `${emoji} **${reviewComment.file}:${reviewComment.line}** (${reviewComment.category})\n`;
        comment += `   ${reviewComment.message}\n\n`;
      }
    }

    if (format === 'table' && totalIssues > 5) {
      comment += `*Showing top 5 issues. Use \`/review --format=markdown\` for complete analysis.*\n\n`;
    }

    // Add debug section if debug information is available
    if (summary.debug) {
      comment += '\n\n' + this.formatDebugSection(summary.debug);
      comment += '\n\n';
    }

    comment += `\n---\n`;
    comment += `*Powered by [Visor](https://probelabs.com/visor) from [Probelabs](https://probelabs.com)*`;

    return comment;
  }

  private groupCommentsByCategory(comments: ReviewComment[]): Record<string, ReviewComment[]> {
    const grouped: Record<string, ReviewComment[]> = {
      security: [],
      performance: [],
      style: [],
      logic: [],
      documentation: [],
    };

    for (const comment of comments) {
      if (!grouped[comment.category]) {
        grouped[comment.category] = [];
      }
      grouped[comment.category].push(comment);
    }

    return grouped;
  }

  private groupCommentsByCheck(comments: ReviewComment[]): Record<string, ReviewComment[]> {
    const grouped: Record<string, ReviewComment[]> = {};

    for (const comment of comments) {
      // Extract check name from ruleId prefix (e.g., "security/sql-injection" -> "security")
      let checkName = 'uncategorized';

      if (comment.ruleId && comment.ruleId.includes('/')) {
        const parts = comment.ruleId.split('/');
        checkName = parts[0];
      }

      if (!grouped[checkName]) {
        grouped[checkName] = [];
      }
      grouped[checkName].push(comment);
    }

    return grouped;
  }

  private formatDebugSection(debug: AIDebugInfo): string {
    const formattedContent = [
      `**Provider:** ${debug.provider}`,
      `**Model:** ${debug.model}`,
      `**API Key Source:** ${debug.apiKeySource}`,
      `**Processing Time:** ${debug.processingTime}ms`,
      `**Timestamp:** ${debug.timestamp}`,
      `**Prompt Length:** ${debug.promptLength} characters`,
      `**Response Length:** ${debug.responseLength} characters`,
      `**JSON Parse Success:** ${debug.jsonParseSuccess ? '✅' : '❌'}`,
    ];

    if (debug.errors && debug.errors.length > 0) {
      formattedContent.push('', '### Errors');
      debug.errors.forEach(error => {
        formattedContent.push(`- ${error}`);
      });
    }

    // Check if debug content would be too large for GitHub comment
    const fullDebugContent = [
      ...formattedContent,
      '',
      '### AI Prompt',
      '```',
      debug.prompt,
      '```',
      '',
      '### Raw AI Response',
      '```json',
      debug.rawResponse,
      '```',
    ].join('\n');

    // GitHub comment limit is 65536 characters, leave some buffer
    if (fullDebugContent.length > 60000) {
      // Save debug info to artifact and provide link
      const artifactPath = this.saveDebugArtifact(debug);

      formattedContent.push('');
      formattedContent.push('### Debug Details');
      formattedContent.push('⚠️ Debug information is too large for GitHub comments.');

      if (artifactPath) {
        formattedContent.push(
          `📁 **Full debug information saved to artifact:** \`${artifactPath}\``
        );
        formattedContent.push('');

        // Try to get GitHub context for artifact link
        const runId = process.env.GITHUB_RUN_ID;
        const repoUrl =
          process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY
            ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}`
            : null;

        if (runId && repoUrl) {
          formattedContent.push(
            `🔗 **Download Link:** [visor-debug-${process.env.GITHUB_RUN_NUMBER || runId}](${repoUrl}/actions/runs/${runId})`
          );
        }

        formattedContent.push(
          '💡 Go to the GitHub Action run above and download the debug artifact to view complete prompts and responses.'
        );
      } else {
        formattedContent.push('📝 **Prompt preview:** ' + debug.prompt.substring(0, 500) + '...');
        formattedContent.push(
          '📝 **Response preview:** ' + debug.rawResponse.substring(0, 500) + '...'
        );
      }
    } else {
      // Include full debug content if it fits
      formattedContent.push('');
      formattedContent.push('### AI Prompt');
      formattedContent.push('```');
      formattedContent.push(debug.prompt);
      formattedContent.push('```');
      formattedContent.push('');
      formattedContent.push('### Raw AI Response');
      formattedContent.push('```json');
      formattedContent.push(debug.rawResponse);
      formattedContent.push('```');
    }

    return this.commentManager.createCollapsibleSection(
      '🐛 Debug Information',
      formattedContent.join('\n'),
      false // Start collapsed
    );
  }

  private saveDebugArtifact(debug: AIDebugInfo): string | null {
    try {
      const fs = require('fs');
      const path = require('path');

      // Create debug directory if it doesn't exist
      const debugDir = path.join(process.cwd(), 'debug-artifacts');
      if (!fs.existsSync(debugDir)) {
        fs.mkdirSync(debugDir, { recursive: true });
      }

      // Create debug file with timestamp
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `visor-debug-${timestamp}.md`;
      const filePath = path.join(debugDir, filename);

      // Parse the combined prompts and responses to extract individual checks
      const markdownContent = this.formatDebugAsMarkdown(debug);

      fs.writeFileSync(filePath, markdownContent);

      return filename;
    } catch (error) {
      console.error(`❌ Failed to save debug artifact: ${error}`);
      return null;
    }
  }

  private formatDebugAsMarkdown(debug: AIDebugInfo): string {
    const lines = [
      '# Visor AI Debug Information',
      '',
      `**Generated:** ${debug.timestamp}`,
      `**Provider:** ${debug.provider}`,
      `**Model:** ${debug.model}`,
      `**API Key Source:** ${debug.apiKeySource}`,
      `**Schema Type:** ${debug.schemaName || 'default (code-review)'}`,
      `**Total Processing Time:** ${debug.processingTime}ms`,
      `**Total Prompt Length:** ${debug.promptLength} characters`,
      `**Total Response Length:** ${debug.responseLength} characters`,
      `**JSON Parse Success:** ${debug.jsonParseSuccess ? '✅' : '❌'}`,
      '',
    ];

    if (debug.errors && debug.errors.length > 0) {
      lines.push('## ❌ Errors');
      debug.errors.forEach(error => {
        lines.push(`- ${error}`);
      });
      lines.push('');
    }

    // Add schema information if available
    if (debug.schema) {
      lines.push('## 📋 Schema Options Passed to ProbeAgent');
      lines.push('```json');
      lines.push(debug.schema);
      lines.push('```');
      lines.push('');
    }

    // Parse combined prompt and response to extract individual checks
    const promptSections = this.parseCheckSections(debug.prompt);
    const responseSections = this.parseCheckSections(debug.rawResponse);

    lines.push('## 📊 Check Results Summary');
    lines.push('');
    promptSections.forEach(section => {
      const responseSection = responseSections.find(r => r.checkName === section.checkName);
      lines.push(`- **${section.checkName}**: ${responseSection ? 'Success' : 'Failed'}`);
    });
    lines.push('');

    // Add detailed information for each check
    promptSections.forEach((promptSection, index) => {
      const responseSection = responseSections.find(r => r.checkName === promptSection.checkName);

      lines.push(`## ${index + 1}. ${promptSection.checkName.toUpperCase()} Check`);
      lines.push('');

      lines.push('### 📝 AI Prompt');
      lines.push('');
      lines.push('```');
      lines.push(promptSection.content);
      lines.push('```');
      lines.push('');

      lines.push('### 🤖 AI Response');
      lines.push('');
      if (responseSection) {
        lines.push('```json');
        lines.push(responseSection.content);
        lines.push('```');
      } else {
        lines.push('❌ No response available for this check');
      }
      lines.push('');
      lines.push('---');
      lines.push('');
    });

    // Add raw unprocessed prompt and response at the end for complete transparency
    lines.push('## 📄 Raw Prompt (Complete)');
    lines.push('');
    lines.push('```');
    lines.push(debug.prompt);
    lines.push('```');
    lines.push('');

    lines.push('## 📄 Raw Response (Complete)');
    lines.push('');
    lines.push('```');
    lines.push(debug.rawResponse);
    lines.push('```');
    lines.push('');

    return lines.join('\n');
  }

  private parseCheckSections(combinedText: string): Array<{ checkName: string; content: string }> {
    const sections: Array<{ checkName: string; content: string }> = [];

    // Split by check sections like [security], [performance], etc.
    const parts = combinedText.split(/\[(\w+)\]\s*\n/);

    for (let i = 1; i < parts.length; i += 2) {
      const checkName = parts[i];
      const content = parts[i + 1]?.trim() || '';

      if (checkName && content) {
        sections.push({ checkName, content });
      }
    }

    return sections;
  }

  private formatIssuesTable(comments: ReviewComment[]): string {
    let content = `## 🔍 Code Analysis Results\n\n`;

    // Group comments by check (extracted from ruleId prefix)
    const groupedComments = this.groupCommentsByCheck(comments);

    // Create a table for each check that has issues
    for (const [checkName, checkComments] of Object.entries(groupedComments)) {
      if (checkComments.length === 0) continue;

      const checkTitle = checkName.charAt(0).toUpperCase() + checkName.slice(1);

      // Check heading
      content += `### ${checkTitle} Issues (${checkComments.length})\n\n`;

      // Start HTML table for this category
      content += `<table>\n`;
      content += `  <thead>\n`;
      content += `    <tr>\n`;
      content += `      <th>Severity</th>\n`;
      content += `      <th>File</th>\n`;
      content += `      <th>Line</th>\n`;
      content += `      <th>Issue</th>\n`;
      content += `    </tr>\n`;
      content += `  </thead>\n`;
      content += `  <tbody>\n`;

      // Sort comments within check by severity, then by file
      const sortedCheckComments = checkComments.sort((a, b) => {
        const severityOrder = { critical: 0, error: 1, warning: 2, info: 3 };
        const severityDiff = (severityOrder[a.severity] || 4) - (severityOrder[b.severity] || 4);
        if (severityDiff !== 0) return severityDiff;
        return a.file.localeCompare(b.file);
      });

      for (const comment of sortedCheckComments) {
        const severityEmoji =
          comment.severity === 'critical'
            ? '🔴'
            : comment.severity === 'error'
              ? '🔴'
              : comment.severity === 'warning'
                ? '🟡'
                : '🟢';
        const severityText = comment.severity.charAt(0).toUpperCase() + comment.severity.slice(1);

        // Build the issue description with suggestion/replacement if available
        // Wrap content in a div for better table layout control
        let issueContent = '';

        // Pass the message as-is - Liquid template will handle escaping
        issueContent += comment.message;

        if (comment.suggestion) {
          // Pass suggestion as-is - Liquid template will handle escaping
          issueContent += `\n<details><summary>💡 <strong>Suggestion</strong></summary>${comment.suggestion}</details>`;
        }

        if (comment.replacement) {
          // Extract language hint from file extension
          const fileExt = comment.file.split('.').pop()?.toLowerCase() || 'text';
          const languageHint = this.getLanguageHint(fileExt);
          // Pass replacement as-is - Liquid template will handle escaping
          issueContent += `\n<details><summary>🔧 <strong>Suggested Fix</strong></summary><pre><code class="language-${languageHint}">${comment.replacement}</code></pre></details>`;
        }

        // Wrap all content in a div for better table cell containment
        const issueDescription = `<div>${issueContent}</div>`;

        content += `    <tr>\n`;
        content += `      <td>${severityEmoji} ${severityText}</td>\n`;
        content += `      <td><code>${comment.file}</code></td>\n`;
        content += `      <td>${comment.line}</td>\n`;
        content += `      <td>${issueDescription}</td>\n`;
        content += `    </tr>\n`;
      }

      // Close HTML table for this category
      content += `  </tbody>\n`;
      content += `</table>\n\n`;

      // No hardcoded recommendations - all guidance comes from .visor.yaml prompts
    }

    return content;
  }

  private getLanguageHint(fileExtension: string): string {
    const langMap: Record<string, string> = {
      ts: 'typescript',
      tsx: 'typescript',
      js: 'javascript',
      jsx: 'javascript',
      py: 'python',
      java: 'java',
      kt: 'kotlin',
      swift: 'swift',
      go: 'go',
      rs: 'rust',
      cpp: 'cpp',
      c: 'c',
      cs: 'csharp',
      php: 'php',
      rb: 'ruby',
      scala: 'scala',
      sh: 'bash',
      bash: 'bash',
      zsh: 'bash',
      sql: 'sql',
      json: 'json',
      yaml: 'yaml',
      yml: 'yaml',
      xml: 'xml',
      html: 'html',
      css: 'css',
      scss: 'scss',
      sass: 'sass',
      md: 'markdown',
      dockerfile: 'dockerfile',
      tf: 'hcl',
    };

    return langMap[fileExtension] || fileExtension;
  }

  /**
   * Load custom template content from file or raw content
   */
  private async loadCustomTemplate(config: CustomTemplateConfig): Promise<string> {
    if (config.content) {
      // Auto-detect if content is actually a file path
      if (await this.isFilePath(config.content)) {
        return await this.loadTemplateFromFile(config.content);
      } else {
        // Use raw template content directly
        return config.content;
      }
    }

    if (config.file) {
      // Legacy explicit file property
      return await this.loadTemplateFromFile(config.file);
    }

    throw new Error('Custom template configuration must specify either "file" or "content"');
  }

  /**
   * Detect if a string is likely a file path and if the file exists
   */
  private async isFilePath(str: string): Promise<boolean> {
    // Quick checks to exclude obvious non-file-path content
    if (!str || str.trim() !== str || str.length > 512) {
      return false;
    }

    // Exclude strings that are clearly content (contain common content indicators)
    // But be more careful with paths that might contain common words as directory names
    if (
      /\s{2,}/.test(str) || // Multiple consecutive spaces
      /\n/.test(str) || // Contains newlines
      /^(please|analyze|review|check|find|identify|look|search)/i.test(str.trim()) || // Starts with command words
      str.split(' ').length > 8 // Too many words for a typical file path
    ) {
      return false;
    }

    // For strings with path separators, be more lenient about common words
    // as they might be legitimate directory names
    if (!/[\/\\]/.test(str)) {
      // Only apply strict English word filter to non-path strings
      if (/\b(the|and|or|but|for|with|by|from|in|on|at|as)\b/i.test(str)) {
        return false;
      }
    }

    // Positive indicators for file paths
    const hasFileExtension = /\.[a-zA-Z0-9]{1,10}$/i.test(str);
    const hasPathSeparators = /[\/\\]/.test(str);
    const isRelativePath = /^\.{1,2}\//.test(str);
    const isAbsolutePath = path.isAbsolute(str);
    const hasTypicalFileChars = /^[a-zA-Z0-9._\-\/\\:~]+$/.test(str);

    // Must have at least one strong indicator
    if (!(hasFileExtension || isRelativePath || isAbsolutePath || hasPathSeparators)) {
      return false;
    }

    // Must contain only typical file path characters
    if (!hasTypicalFileChars) {
      return false;
    }

    // Additional validation for suspected file paths
    try {
      // Try to resolve and check if file exists
      let resolvedPath: string;

      if (path.isAbsolute(str)) {
        resolvedPath = path.normalize(str);
      } else {
        // Resolve relative to current working directory
        resolvedPath = path.resolve(process.cwd(), str);
      }

      // Check if file exists
      try {
        const stat = await fs.stat(resolvedPath);
        return stat.isFile();
      } catch {
        // File doesn't exist, but might still be a valid file path format
        // Return true if it has strong file path indicators
        return hasFileExtension && (isRelativePath || isAbsolutePath || hasPathSeparators);
      }
    } catch {
      return false;
    }
  }

  /**
   * Safely load template from file with security checks
   */
  private async loadTemplateFromFile(templatePath: string): Promise<string> {
    // Resolve the path (handles both relative and absolute paths)
    let resolvedPath: string;

    if (path.isAbsolute(templatePath)) {
      // Absolute path - use as-is but validate it's not trying to escape expected directories
      resolvedPath = path.normalize(templatePath);
    } else {
      // Relative path - resolve relative to current working directory
      resolvedPath = path.resolve(process.cwd(), templatePath);
    }

    // Security: Normalize and check for path traversal attempts
    const normalizedPath = path.normalize(resolvedPath);

    // Security: For relative paths, ensure they don't escape the current directory
    if (!path.isAbsolute(templatePath)) {
      const currentDir = path.resolve(process.cwd());
      if (!normalizedPath.startsWith(currentDir)) {
        throw new Error('Invalid template file path: path traversal detected');
      }
    }

    // Security: Additional check for obvious path traversal patterns
    if (templatePath.includes('../..')) {
      throw new Error('Invalid template file path: path traversal detected');
    }

    // Security: Check file extension
    if (!normalizedPath.endsWith('.liquid')) {
      throw new Error('Invalid template file: must have .liquid extension');
    }

    try {
      const templateContent = await fs.readFile(normalizedPath, 'utf-8');
      return templateContent;
    } catch (error) {
      throw new Error(
        `Failed to load custom template from ${normalizedPath}: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`
      );
    }
  }
}
