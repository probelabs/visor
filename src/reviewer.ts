import { Octokit } from '@octokit/rest';
import { PRInfo } from './pr-analyzer';
import { CommentManager } from './github-comments';
import { AIReviewService, AIDebugInfo } from './ai-review-service';
import { Liquid } from 'liquidjs';
import fs from 'fs/promises';
import path from 'path';

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
    const { debug = false, config, checks, parallelExecution } = options;

    // If we have a config and checks, use CheckExecutionEngine
    if (config && checks && checks.length > 0) {
      const executionMode = checks.length > 1 && parallelExecution ? 'parallel' : 'sequential';
      console.error(
        `🔧 Debug: PRReviewer using CheckExecutionEngine for ${executionMode} execution of ${checks.length} check(s)`
      );

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
    console.error(
      `🔧 Debug: Found ${Object.keys(issuesByGroup).length} groups:`,
      Object.keys(issuesByGroup)
    );

    // If no groups or only one group, use the original single comment approach
    if (Object.keys(issuesByGroup).length <= 1) {
      console.error(`🔧 Debug: Using single comment approach`);
      const comment = await this.formatReviewCommentWithVisorFormat(summary, options);

      await this.commentManager.updateOrCreateComment(owner, repo, prNumber, comment, {
        commentId: options.commentId,
        triggeredBy: options.triggeredBy || 'unknown',
        allowConcurrentUpdates: false,
        commitSha: options.commitSha,
      });
      return;
    }

    // Create separate comments for each group
    console.error(
      `🔧 Debug: Creating separate comments for ${Object.keys(issuesByGroup).length} groups`
    );
    for (const [groupName, groupIssues] of Object.entries(issuesByGroup)) {
      const groupSummary: ReviewSummary = {
        ...summary,
        issues: groupIssues,
      };

      // Use group name in comment ID to create separate comments
      const groupCommentId = options.commentId
        ? `${options.commentId}-${groupName}`
        : `visor-${groupName}`;

      console.error(
        `🔧 Debug: Creating comment for group "${groupName}" with ID: ${groupCommentId}`
      );
      const comment = await this.formatReviewCommentWithVisorFormat(groupSummary, options);

      await this.commentManager.updateOrCreateComment(owner, repo, prNumber, comment, {
        commentId: groupCommentId,
        triggeredBy: options.triggeredBy || 'unknown',
        allowConcurrentUpdates: false,
        commitSha: options.commitSha,
      });

      // Add small delay to prevent potential race conditions with GitHub API
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  private async formatReviewCommentWithVisorFormat(
    summary: ReviewSummary,
    _options: ReviewOptions
  ): Promise<string> {
    const totalIssues = calculateTotalIssues(summary.issues);

    let comment = '';

    // Add main header
    if (totalIssues === 0) {
      comment += `## ✅ All Checks Passed\n\n**No issues found – changes LGTM.**\n\n`;
    } else {
      comment += `## 🔍 Code Analysis Results\n\n`;
      // Use new schema-template system for content generation
      const templateContent = await this.renderWithSchemaTemplate(summary);
      comment += templateContent;
    }

    // Add debug section if available
    if (summary.debug) {
      comment += this.formatDebugSection(summary.debug);
      comment += '\n\n';
    }

    // Simple footer
    comment += `---\n*Powered by [Visor](https://probelabs.com/visor) from [Probelabs](https://probelabs.com)*`;

    return comment;
  }

  private async renderWithSchemaTemplate(summary: ReviewSummary): Promise<string> {
    try {
      // Group issues by check name and render each check separately
      const issuesByCheck = this.groupIssuesByCheck(summary.issues);

      if (Object.keys(issuesByCheck).length === 0) {
        return 'No issues found in this group.';
      }

      const renderedSections: string[] = [];

      for (const [checkName, checkIssues] of Object.entries(issuesByCheck)) {
        const checkSchema = checkIssues[0]?.schema || 'code-review';
        const renderedSection = await this.renderSingleCheckTemplate(
          checkName,
          checkIssues,
          checkSchema
        );
        renderedSections.push(renderedSection);
      }

      // Combine all check sections with proper spacing
      return renderedSections.join('\n\n');
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

  private async renderSingleCheckTemplate(
    checkName: string,
    issues: ReviewIssue[],
    schema: string
  ): Promise<string> {
    const liquid = new Liquid();

    // Load the appropriate template based on schema
    const templatePath = path.join(__dirname, `../output/${schema}/template.liquid`);
    const templateContent = await fs.readFile(templatePath, 'utf-8');

    let templateData: any;

    if (schema === 'text') {
      // For text schema, pass the message content directly
      templateData = {
        content: issues.length > 0 ? issues[0].message : 'No content available',
        checkName: checkName,
      };
    } else {
      // For code-review schema, pass issues directly (no more checkName extraction needed)
      templateData = {
        issues: issues,
        checkName: checkName,
      };
    }

    // Render with Liquid template
    return await liquid.parseAndRender(templateContent, templateData);
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
      comment += this.formatDebugSection(summary.debug);
      comment += '\n\n';
    }

    comment += `---\n`;
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

      console.log(`🔧 Debug: Saved debug artifact to ${filePath}`);
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

        // Escape HTML in the main message to prevent HTML injection
        const escapedMessage = comment.message
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&#x27;');

        issueContent += escapedMessage;

        if (comment.suggestion) {
          // Escape HTML in the suggestion to prevent nested HTML rendering
          const escapedSuggestion = comment.suggestion
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#x27;');
          issueContent += `\n<details><summary>💡 <strong>Suggestion</strong></summary>${escapedSuggestion}</details>`;
        }

        if (comment.replacement) {
          // Extract language hint from file extension
          const fileExt = comment.file.split('.').pop()?.toLowerCase() || 'text';
          const languageHint = this.getLanguageHint(fileExt);
          // Escape HTML in the replacement code to prevent nested HTML rendering
          const escapedReplacement = comment.replacement
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#x27;');
          issueContent += `\n<details><summary>🔧 <strong>Suggested Fix</strong></summary><pre><code class="language-${languageHint}">${escapedReplacement}</code></pre></details>`;
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
}
