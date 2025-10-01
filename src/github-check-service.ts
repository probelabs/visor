/**
 * GitHub Check Service for creating and managing check runs based on failure conditions
 */

import { Octokit } from '@octokit/rest';
import { FailureConditionResult } from './types/config';
import { ReviewIssue } from './reviewer';

export interface CheckRunOptions {
  owner: string;
  repo: string;
  head_sha: string;
  name: string;
  details_url?: string;
  external_id?: string;
}

export interface CheckRunAnnotation {
  path: string;
  start_line: number;
  end_line: number;
  annotation_level: 'notice' | 'warning' | 'failure';
  message: string;
  title?: string;
  raw_details?: string;
}

export interface CheckRunSummary {
  title: string;
  summary: string;
  text?: string;
}

export type CheckRunStatus = 'queued' | 'in_progress' | 'completed';
export type CheckRunConclusion =
  | 'success'
  | 'failure'
  | 'neutral'
  | 'cancelled'
  | 'timed_out'
  | 'action_required';

/**
 * Service for managing GitHub Check Runs based on Visor failure conditions
 */
export class GitHubCheckService {
  private octokit: Octokit;
  private maxAnnotations = 50; // GitHub API limit

  constructor(octokit: Octokit) {
    this.octokit = octokit;
  }

  /**
   * Create a new check run in queued status
   */
  async createCheckRun(
    options: CheckRunOptions,
    summary?: CheckRunSummary
  ): Promise<{ id: number; url: string }> {
    try {
      const response = await this.octokit.rest.checks.create({
        owner: options.owner,
        repo: options.repo,
        name: options.name,
        head_sha: options.head_sha,
        status: 'queued',
        details_url: options.details_url,
        external_id: options.external_id,
        output: summary
          ? {
              title: summary.title,
              summary: summary.summary,
              text: summary.text,
            }
          : undefined,
      });

      return {
        id: response.data.id,
        url: response.data.html_url || '',
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
  async updateCheckRunInProgress(
    owner: string,
    repo: string,
    check_run_id: number,
    summary?: CheckRunSummary
  ): Promise<void> {
    try {
      await this.octokit.rest.checks.update({
        owner,
        repo,
        check_run_id,
        status: 'in_progress',
        output: summary
          ? {
              title: summary.title,
              summary: summary.summary,
              text: summary.text,
            }
          : undefined,
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
  async completeCheckRun(
    owner: string,
    repo: string,
    check_run_id: number,
    checkName: string,
    failureResults: FailureConditionResult[],
    reviewIssues: ReviewIssue[] = [],
    executionError?: string,
    filesChangedInCommit?: string[],
    prNumber?: number,
    currentCommitSha?: string
  ): Promise<void> {
    try {
      // Clear old annotations from previous commits in the PR
      if (prNumber && currentCommitSha) {
        await this.clearOldAnnotations(owner, repo, prNumber, checkName, currentCommitSha);
      }

      const { conclusion, summary } = this.determineCheckRunConclusion(
        checkName,
        failureResults,
        reviewIssues,
        executionError
      );

      // Filter annotations to only include files changed in this commit
      // This prevents old annotations from previous commits showing up in the Files tab
      let filteredIssues = reviewIssues;
      if (filesChangedInCommit && filesChangedInCommit.length > 0) {
        filteredIssues = reviewIssues.filter(issue =>
          filesChangedInCommit.some(changedFile => issue.file === changedFile)
        );
      }

      const annotations = this.convertIssuesToAnnotations(filteredIssues);

      await this.octokit.rest.checks.update({
        owner,
        repo,
        check_run_id,
        status: 'completed',
        conclusion,
        completed_at: new Date().toISOString(),
        output: {
          title: summary.title,
          summary: summary.summary,
          text: summary.text,
          annotations: annotations.slice(0, this.maxAnnotations), // GitHub limit
        },
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
  private determineCheckRunConclusion(
    checkName: string,
    failureResults: FailureConditionResult[],
    reviewIssues: ReviewIssue[],
    executionError?: string
  ): { conclusion: CheckRunConclusion; summary: CheckRunSummary } {
    // Handle execution errors first
    if (executionError) {
      return {
        conclusion: 'failure',
        summary: {
          title: '❌ Check Execution Failed',
          summary: `The ${checkName} check failed to execute properly.`,
          text: `**Error:** ${executionError}\n\nPlease check your configuration and try again.`,
        },
      };
    }

    // Check if any fail_if conditions were met
    const failedConditions = failureResults.filter(result => result.failed);

    // Count issues by severity (for informational display only)
    const criticalIssues = reviewIssues.filter(issue => issue.severity === 'critical').length;
    const errorIssues = reviewIssues.filter(issue => issue.severity === 'error').length;
    const warningIssues = reviewIssues.filter(issue => issue.severity === 'warning').length;
    const totalIssues = reviewIssues.length;

    // Determine conclusion ONLY based on fail_if evaluation results
    // The presence of issues (critical, error, warning) does NOT affect the conclusion
    // Only the fail_if condition determines pass/fail status
    let conclusion: CheckRunConclusion;
    let title: string;
    let summaryText: string;
    let details: string;

    if (failedConditions.length > 0) {
      // Check fails if fail_if condition is met
      conclusion = 'failure';
      title = '🚨 Check Failed';
      summaryText = `${checkName} check failed because fail_if condition was met.`;

      details = this.formatCheckDetails(failureResults, reviewIssues, {
        failedConditions: failedConditions.length,
        warningConditions: 0,
        criticalIssues,
        errorIssues,
        warningIssues,
        totalIssues,
      });
    } else {
      // No fail_if conditions met - check passes regardless of issues found
      conclusion = 'success';

      // Adjust the title and summary based on issues found, but conclusion remains success
      if (criticalIssues > 0 || errorIssues > 0) {
        title = '✅ Check Passed (Issues Found)';
        summaryText = `${checkName} check passed. Found ${criticalIssues} critical and ${errorIssues} error issues, but fail_if condition was not met.`;
      } else if (warningIssues > 0) {
        title = '✅ Check Passed (Warnings Found)';
        summaryText = `${checkName} check passed. Found ${warningIssues} warning${warningIssues === 1 ? '' : 's'}, but fail_if condition was not met.`;
      } else {
        title = '✅ Check Passed';
        summaryText = `${checkName} check completed successfully with no issues found.`;
      }

      details = this.formatCheckDetails(failureResults, reviewIssues, {
        failedConditions: 0,
        warningConditions: 0,
        criticalIssues,
        errorIssues,
        warningIssues,
        totalIssues,
      });
    }

    return {
      conclusion,
      summary: {
        title,
        summary: summaryText,
        text: details,
      },
    };
  }

  /**
   * Format detailed check results for the check run summary
   */
  private formatCheckDetails(
    failureResults: FailureConditionResult[],
    reviewIssues: ReviewIssue[],
    counts: {
      failedConditions: number;
      warningConditions: number;
      criticalIssues: number;
      errorIssues: number;
      warningIssues: number;
      totalIssues: number;
    }
  ): string {
    const sections: string[] = [];

    // Summary section
    sections.push('## 📊 Summary');
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
    sections.push('');

    // Failure conditions section
    if (failureResults.length > 0) {
      sections.push('## 🔍 Failure Condition Results');

      const failedConditions = failureResults.filter(result => result.failed);
      const passedConditions = failureResults.filter(result => !result.failed);

      if (failedConditions.length > 0) {
        sections.push('### ❌ Failed Conditions');
        failedConditions.forEach(condition => {
          sections.push(
            `- **${condition.conditionName}**: ${condition.message || condition.expression}`
          );
          if (condition.severity === 'error') {
            sections.push(`  - ⚠️ **Severity:** Error`);
          }
        });
        sections.push('');
      }

      if (passedConditions.length > 0) {
        sections.push('### ✅ Passed Conditions');
        passedConditions.forEach(condition => {
          sections.push(
            `- **${condition.conditionName}**: ${condition.message || 'Condition passed'}`
          );
        });
        sections.push('');
      }
    }

    // Issues by category section
    if (reviewIssues.length > 0) {
      const issuesByCategory = this.groupIssuesByCategory(reviewIssues);
      sections.push('## 🐛 Issues by Category');

      Object.entries(issuesByCategory).forEach(([category, issues]) => {
        if (issues.length > 0) {
          sections.push(
            `### ${this.getCategoryEmoji(category)} ${category.charAt(0).toUpperCase() + category.slice(1)} (${issues.length})`
          );

          // Show only first 5 issues per category to keep the summary concise
          const displayIssues = issues.slice(0, 5);
          displayIssues.forEach(issue => {
            const severityIcon = this.getSeverityIcon(issue.severity);
            sections.push(`- ${severityIcon} **${issue.file}:${issue.line}** - ${issue.message}`);
          });

          if (issues.length > 5) {
            sections.push(`- *...and ${issues.length - 5} more ${category} issues*`);
          }
          sections.push('');
        }
      });
    }

    // Footer
    sections.push('');
    sections.push('---');
    sections.push('');
    sections.push(
      '*Generated by [Visor](https://github.com/probelabs/visor) - AI-powered code review*'
    );

    return sections.join('\n');
  }

  /**
   * Convert review issues to GitHub check run annotations
   */
  private convertIssuesToAnnotations(reviewIssues: ReviewIssue[]): CheckRunAnnotation[] {
    return reviewIssues
      .slice(0, this.maxAnnotations) // Respect GitHub's annotation limit
      .map(issue => ({
        path: issue.file,
        start_line: issue.line,
        end_line: issue.endLine || issue.line,
        annotation_level: this.mapSeverityToAnnotationLevel(issue.severity),
        message: issue.message,
        title: `${issue.category} Issue`,
        raw_details: issue.suggestion || undefined,
      }));
  }

  /**
   * Map Visor issue severity to GitHub annotation level
   */
  private mapSeverityToAnnotationLevel(severity: string): 'notice' | 'warning' | 'failure' {
    switch (severity) {
      case 'critical':
      case 'error':
        return 'failure';
      case 'warning':
        return 'warning';
      case 'info':
      default:
        return 'notice';
    }
  }

  /**
   * Group issues by category
   */
  private groupIssuesByCategory(issues: ReviewIssue[]): Record<string, ReviewIssue[]> {
    const grouped: Record<string, ReviewIssue[]> = {};

    issues.forEach(issue => {
      const category = issue.category || 'general';
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
  private getCategoryEmoji(category: string): string {
    const emojiMap: Record<string, string> = {
      security: '🔐',
      performance: '⚡',
      style: '🎨',
      logic: '🧠',
      architecture: '🏗️',
      documentation: '📚',
      general: '📝',
    };
    return emojiMap[category.toLowerCase()] || '📝';
  }

  /**
   * Get icon for issue severity
   */
  private getSeverityIcon(severity: string): string {
    const iconMap: Record<string, string> = {
      critical: '🚨',
      error: '❌',
      warning: '⚠️',
      info: 'ℹ️',
    };
    return iconMap[severity.toLowerCase()] || 'ℹ️';
  }

  /**
   * Create multiple check runs for different checks with failure condition support
   */
  async createMultipleCheckRuns(
    options: CheckRunOptions,
    checkResults: Array<{
      checkName: string;
      failureResults: FailureConditionResult[];
      reviewIssues: ReviewIssue[];
      executionError?: string;
    }>
  ): Promise<Array<{ checkName: string; id: number; url: string }>> {
    const results: Array<{ checkName: string; id: number; url: string }> = [];

    for (const checkResult of checkResults) {
      try {
        // Create check run
        const checkRun = await this.createCheckRun({
          ...options,
          name: `Visor: ${checkResult.checkName}`,
          external_id: `visor-${checkResult.checkName}-${options.head_sha.substring(0, 7)}`,
        });

        // Update to in progress
        await this.updateCheckRunInProgress(options.owner, options.repo, checkRun.id, {
          title: `Running ${checkResult.checkName} check...`,
          summary: `Analyzing code with ${checkResult.checkName} check using AI.`,
        });

        // Complete with results
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
          url: checkRun.url,
        });
      } catch (error) {
        console.error(`Failed to create check run for ${checkResult.checkName}:`, error);
        // Continue with other checks even if one fails
      }
    }

    return results;
  }

  /**
   * Get check runs for a specific commit
   */
  async getCheckRuns(
    owner: string,
    repo: string,
    ref: string
  ): Promise<Array<{ id: number; name: string; status: string; conclusion: string | null }>> {
    try {
      const response = await this.octokit.rest.checks.listForRef({
        owner,
        repo,
        ref,
        filter: 'all',
      });

      return response.data.check_runs
        .filter(check => check.name.startsWith('Visor:'))
        .map(check => ({
          id: check.id,
          name: check.name,
          status: check.status,
          conclusion: check.conclusion,
        }));
    } catch (error) {
      throw new Error(
        `Failed to get check runs: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Get check runs for all commits in a PR to clear old annotations
   */
  async getCheckRunsForPR(
    owner: string,
    repo: string,
    prNumber: number,
    checkName: string
  ): Promise<Array<{ id: number; head_sha: string }>> {
    try {
      // Get PR commits
      const commitsResponse = await this.octokit.rest.pulls.listCommits({
        owner,
        repo,
        pull_number: prNumber,
        per_page: 100,
      });

      const checkRuns: Array<{ id: number; head_sha: string }> = [];

      // Get check runs for each commit
      for (const commit of commitsResponse.data) {
        try {
          const checksResponse = await this.octokit.rest.checks.listForRef({
            owner,
            repo,
            ref: commit.sha,
            check_name: `Visor: ${checkName}`,
          });

          for (const check of checksResponse.data.check_runs) {
            checkRuns.push({
              id: check.id,
              head_sha: commit.sha,
            });
          }
        } catch (error) {
          // Continue if we can't get checks for a specific commit
          console.debug(`Could not get checks for commit ${commit.sha}:`, error);
        }
      }

      return checkRuns;
    } catch (error) {
      throw new Error(
        `Failed to get PR check runs: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  /**
   * Clear annotations from old check runs in the PR (except current commit)
   */
  async clearOldAnnotations(
    owner: string,
    repo: string,
    prNumber: number,
    checkName: string,
    currentCommitSha: string
  ): Promise<void> {
    try {
      const oldCheckRuns = await this.getCheckRunsForPR(owner, repo, prNumber, checkName);

      // Filter to only old commits (not the current one)
      const oldRuns = oldCheckRuns.filter(run => run.head_sha !== currentCommitSha);

      // Update each old check run to have empty annotations
      for (const run of oldRuns) {
        try {
          await this.octokit.rest.checks.update({
            owner,
            repo,
            check_run_id: run.id,
            output: {
              title: 'Outdated',
              summary: 'This check has been superseded by a newer commit.',
              annotations: [], // Clear annotations
            },
          });
        } catch (error) {
          console.debug(`Could not clear annotations for check run ${run.id}:`, error);
        }
      }
    } catch (error) {
      // Don't fail the whole check if we can't clear old annotations
      console.warn('Failed to clear old annotations:', error);
    }
  }
}
