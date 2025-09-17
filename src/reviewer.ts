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

// Legacy interface - ONLY for GitHub integration compatibility
export interface ReviewComment {
  file: string;
  line: number;
  message: string;
  severity: 'info' | 'warning' | 'error' | 'critical';
  category: 'security' | 'performance' | 'style' | 'logic' | 'documentation';
  suggestion?: string;
  replacement?: string;
  ruleId?: string;
}

export interface ReviewSummary {
  issues?: ReviewIssue[];
  suggestions?: string[];
  debug?: AIDebugInfo;
}

// Helper functions for GitHub checks - ONLY for structured schemas that have issues
// These are the ONLY acceptable hardcoded schema dependencies, and only for GitHub integration
export function calculateTotalIssues(issues?: ReviewIssue[]): number {
  return (issues || []).length;
}

export function calculateCriticalIssues(issues?: ReviewIssue[]): number {
  return (issues || []).filter(i => i.severity === 'critical').length;
}

// Legacy converter - ONLY for GitHub integration compatibility
export function convertIssuesToComments(issues: ReviewIssue[]): ReviewComment[] {
  return issues.map(issue => ({
    file: issue.file,
    line: issue.line,
    message: issue.message,
    severity: issue.severity,
    category: issue.category,
    suggestion: issue.suggestion,
    replacement: issue.replacement,
    ruleId: issue.ruleId,
  }));
}

export interface ReviewOptions {
  focus?: 'security' | 'performance' | 'style' | 'all';
  format?: 'table' | 'json' | 'markdown' | 'sarif';
  debug?: boolean;
  config?: import('./types/config').VisorConfig;
  checks?: string[];
  parallelExecution?: boolean;
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

    if (config && checks && checks.length > 0) {
      const { CheckExecutionEngine } = await import('./check-execution-engine');
      const engine = new CheckExecutionEngine();
      const reviewSummary = await engine['executeReviewChecks'](
        prInfo,
        checks,
        undefined,
        config,
        undefined,
        debug
      );
      return reviewSummary;
    }

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
    // Group issues and suggestions by their group property
    const groupedResults = this.groupResultsByGroup(summary);

    // Post separate comments for each group
    for (const [groupName, groupSummary] of Object.entries(groupedResults)) {
      const comment = await this.formatReviewCommentWithVisorFormat(groupSummary, options, {
        owner,
        repo,
        prNumber,
        commitSha: options.commitSha,
      });

      const commentId = options.commentId
        ? `${options.commentId}-${groupName}`
        : `visor-review-${groupName}`;

      await this.commentManager.updateOrCreateComment(owner, repo, prNumber, comment, {
        commentId,
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
    comment += `## 🔍 Code Analysis Results\n\n`;

    const templateContent = await this.renderWithSchemaTemplate(summary, githubContext);
    comment += templateContent;

    if (summary.debug) {
      comment += '\n\n' + this.formatDebugSection(summary.debug);
      comment += '\n\n';
    }

    comment += `\n---\n*Powered by [Visor](https://probelabs.com/visor) from [Probelabs](https://probelabs.com)*`;
    return comment;
  }

  private async renderWithSchemaTemplate(
    summary: ReviewSummary,
    githubContext?: { owner: string; repo: string; prNumber: number; commitSha?: string }
  ): Promise<string> {
    const renderedSections: string[] = [];

    // Render structured issues if present
    if (summary.issues && (summary.issues || []).length > 0) {
      const issues = Array.isArray(summary.issues) ? summary.issues : [];
      const issuesByCheck = this.groupIssuesByCheck(issues);

      for (const [checkName, checkIssues] of Object.entries(issuesByCheck)) {
        const checkSchema = checkIssues[0]?.schema;
        const customTemplate = checkIssues[0]?.template;

        // Handle plain schema - render raw content directly
        if (checkSchema === 'plain') {
          const rawContent = checkIssues[0]?.message || '';
          if (rawContent) {
            renderedSections.push(rawContent);
          }
        } else {
          // Use the specified schema template, default to 'code-review' if no schema
          const schemaToUse = checkSchema || 'code-review';
          const renderedSection = await this.renderSingleCheckTemplate(
            checkName,
            checkIssues,
            schemaToUse,
            customTemplate,
            githubContext
          );
          renderedSections.push(renderedSection);
        }
      }
    }

    // Also render suggestions if present (typically no-schema/plain responses from AI)
    if (summary.suggestions && (summary.suggestions || []).length > 0) {
      const suggestionsContent = Array.isArray(summary.suggestions)
        ? summary.suggestions.join('\n\n')
        : String(summary.suggestions);

      if (suggestionsContent.trim()) {
        renderedSections.push(suggestionsContent);
      }
    }

    // Return all rendered sections or empty string if none
    return renderedSections.join('\n\n');
  }

  private generateGitHubDiffHash(filePath: string): string {
    return crypto.createHash('sha256').update(filePath).digest('hex');
  }

  private enhanceIssuesWithGitHubLinks(
    issues: ReviewIssue[],
    githubContext?: { owner: string; repo: string; prNumber: number; commitSha?: string }
  ): Array<ReviewIssue & { githubUrl?: string; fileHash?: string }> {
    if (!githubContext) {
      return issues;
    }

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
      trimTagLeft: false,
      trimTagRight: false,
      trimOutputLeft: false,
      trimOutputRight: false,
      greedy: false,
    });

    let templateContent: string;
    if (customTemplate) {
      templateContent = await this.loadCustomTemplate(customTemplate);
    } else {
      const sanitizedSchema = schema.replace(/[^a-zA-Z0-9-]/g, '');
      if (!sanitizedSchema) {
        throw new Error('Invalid schema name');
      }
      const templatePath = path.join(__dirname, `../output/${sanitizedSchema}/template.liquid`);
      templateContent = await fs.readFile(templatePath, 'utf-8');
    }

    const enhancedIssues = this.enhanceIssuesWithGitHubLinks(issues, githubContext);
    const templateData = {
      issues: enhancedIssues,
      checkName: checkName,
      github: githubContext,
    };

    const rendered = await liquid.parseAndRender(templateContent, templateData);
    return rendered.trim();
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

  private groupResultsByGroup(summary: ReviewSummary): Record<string, ReviewSummary> {
    const grouped: Record<string, ReviewSummary> = {};

    // Group issues by their group property (issues from same group go together)
    if (summary.issues && summary.issues.length > 0) {
      for (const issue of summary.issues) {
        const groupName = issue.group || 'review'; // Default to 'review' to match config
        if (!grouped[groupName]) {
          grouped[groupName] = { issues: [], suggestions: [] };
        }
        grouped[groupName].issues!.push(issue);
      }
    }

    // Group suggestions by checking if they have group prefixes like "[checkName] content"
    if (summary.suggestions && summary.suggestions.length > 0) {
      for (const suggestion of summary.suggestions) {
        // Check if suggestion has a group prefix like "[overview] content"
        const groupMatch = suggestion.match(/^\[([^\]]+)\]\s*(.*)/s);
        if (groupMatch) {
          const checkName = groupMatch[1];
          const content = groupMatch[2];

          // Map check name to group name - overview check has group 'overview'
          const groupName = checkName === 'overview' ? 'overview' : 'review';

          if (!grouped[groupName]) {
            grouped[groupName] = { issues: [], suggestions: [] };
          }
          grouped[groupName].suggestions!.push(content);
        } else {
          // No group prefix, put in default review group
          const groupName = 'review';
          if (!grouped[groupName]) {
            grouped[groupName] = { issues: [], suggestions: [] };
          }
          grouped[groupName].suggestions!.push(suggestion);
        }
      }
    }

    // Include debug info in all groups (if present)
    if (summary.debug) {
      for (const groupSummary of Object.values(grouped)) {
        groupSummary.debug = summary.debug;
      }
    }

    // If no groups were created, create a default one
    if (Object.keys(grouped).length === 0) {
      grouped['review'] = { issues: [], suggestions: [] };
    }

    return grouped;
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

    if (fullDebugContent.length > 60000) {
      const artifactPath = this.saveDebugArtifact(debug);
      formattedContent.push('');
      formattedContent.push('### Debug Details');
      formattedContent.push('⚠️ Debug information is too large for GitHub comments.');
      if (artifactPath) {
        formattedContent.push(
          `📁 **Full debug information saved to artifact:** \`${artifactPath}\``
        );
        formattedContent.push('');
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
      false
    );
  }

  private saveDebugArtifact(debug: AIDebugInfo): string | null {
    try {
      const fs = require('fs');
      const path = require('path');
      const debugDir = path.join(process.cwd(), 'debug-artifacts');
      if (!fs.existsSync(debugDir)) {
        fs.mkdirSync(debugDir, { recursive: true });
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
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
        '```',
        debug.prompt,
        '```',
        ``,
        `## Raw AI Response`,
        ``,
        '```json',
        debug.rawResponse,
        '```',
      ].join('\n');

      fs.writeFileSync(filepath, content, 'utf8');
      return filename;
    } catch (error) {
      console.error('Failed to save debug artifact:', error);
      return null;
    }
  }

  private async loadCustomTemplate(config: CustomTemplateConfig): Promise<string> {
    if (config.content) {
      return config.content;
    } else if (config.file) {
      // Security validation for file paths - normalize and check for traversal
      const normalizedPath = path.normalize(config.file);
      if (
        normalizedPath.includes('..') ||
        normalizedPath.startsWith('../') ||
        normalizedPath.includes('/../')
      ) {
        throw new Error('path traversal detected');
      }

      if (!config.file.endsWith('.liquid')) {
        throw new Error('must have .liquid extension');
      }

      try {
        return await fs.readFile(config.file, 'utf-8');
      } catch (error) {
        throw new Error(`Failed to load custom template: ${(error as Error).message}`);
      }
    } else {
      throw new Error('Custom template must specify either "file" or "content"');
    }
  }
}
