import { Octokit } from '@octokit/rest';

export interface PRFile {
  filename: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  status: 'added' | 'removed' | 'modified' | 'renamed';
}

export interface PRDiff {
  filename: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  status: 'added' | 'removed' | 'modified' | 'renamed';
}

export interface PRComment {
  id: number;
  author: string;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface PRInfo {
  number: number;
  title: string;
  body: string;
  author: string;
  base: string;
  head: string;
  files: PRDiff[];
  totalAdditions: number;
  totalDeletions: number;
  eventType?: import('./types/config').EventTrigger;
  fullDiff?: string;
  commitDiff?: string;
  isIncremental?: boolean; // Flag to indicate if this was intended as incremental analysis
  isIssue?: boolean; // Flag to indicate this is an issue, not a PR
  eventContext?: Record<string, unknown>; // GitHub event context for templates
  comments?: PRComment[]; // Comments added dynamically
}

interface NetworkError {
  code?: string;
  message?: string;
  status?: number;
}

export class PRAnalyzer {
  constructor(
    private octokit: Octokit,
    private maxRetries: number = 3
  ) {}

  /**
   * Fetch commit diff for incremental analysis
   */
  async fetchCommitDiff(owner: string, repo: string, commitSha: string): Promise<string> {
    try {
      const { data: commit } = await this.withRetry(() =>
        this.octokit.rest.repos.getCommit({
          owner,
          repo,
          ref: commitSha,
        })
      );

      // Extract patches from all files in the commit
      const patches =
        commit.files
          ?.filter(file => file.patch)
          .map(file => `--- ${file.filename}\n${file.patch}`)
          .join('\n\n') || '';

      return patches;
    } catch (error) {
      const { logger } = require('./logger');
      logger.warn(`Failed to fetch commit diff for ${commitSha}: ${error instanceof Error ? error.message : String(error)}`);
      return '';
    }
  }

  /**
   * Generate unified diff for all PR files
   */
  private generateFullDiff(files: PRDiff[]): string {
    return files
      .filter(file => file.patch)
      .map(file => `--- ${file.filename}\n${file.patch}`)
      .join('\n\n');
  }

  async fetchPRDiff(
    owner: string,
    repo: string,
    prNumber: number,
    commitSha?: string,
    eventType?: import('./types/config').EventTrigger
  ): Promise<PRInfo> {
    const [prData, filesData] = await Promise.all([
      this.withRetry(() =>
        this.octokit.rest.pulls.get({
          owner,
          repo,
          pull_number: prNumber,
        })
      ),
      this.withRetry(() =>
        this.octokit.rest.pulls.listFiles({
          owner,
          repo,
          pull_number: prNumber,
        })
      ),
    ]);

    const pr = prData?.data;
    const files = filesData?.data || [];

    // Handle missing or malformed PR data gracefully
    if (!pr) {
      throw new Error('Invalid or missing pull request data');
    }

    // Validate critical fields and provide defaults for missing data
    const title = typeof pr.title === 'string' ? pr.title : pr.title ? String(pr.title) : 'MISSING';
    const body = typeof pr.body === 'string' ? pr.body : pr.body ? String(pr.body) : '';
    const author =
      pr.user && typeof pr.user === 'object' && pr.user.login
        ? typeof pr.user.login === 'string'
          ? pr.user.login
          : String(pr.user.login)
        : 'unknown';
    const base =
      pr.base && typeof pr.base === 'object' && pr.base.ref
        ? typeof pr.base.ref === 'string'
          ? pr.base.ref
          : String(pr.base.ref)
        : 'main';
    const head =
      pr.head && typeof pr.head === 'object' && pr.head.ref
        ? typeof pr.head.ref === 'string'
          ? pr.head.ref
          : String(pr.head.ref)
        : 'feature';

    // Filter out malformed files and handle invalid data types
    const validFiles = files
      ? files
          .filter(file => file && typeof file === 'object' && file.filename)
          .map(file => ({
            filename:
              typeof file.filename === 'string'
                ? file.filename
                : String(file.filename || 'unknown'),
            additions: typeof file.additions === 'number' ? Math.max(0, file.additions) : 0,
            deletions: typeof file.deletions === 'number' ? Math.max(0, file.deletions) : 0,
            changes: typeof file.changes === 'number' ? Math.max(0, file.changes) : 0,
            patch: typeof file.patch === 'string' ? file.patch : undefined,
            status: (['added', 'removed', 'modified', 'renamed'].includes(file.status)
              ? file.status
              : 'modified') as 'added' | 'removed' | 'modified' | 'renamed',
          }))
          .filter(file => file.filename.length > 0) // Remove files with empty names
      : [];

    const prInfo: PRInfo = {
      number: typeof pr.number === 'number' ? pr.number : parseInt(String(pr.number || 1), 10),
      title,
      body,
      author,
      base,
      head,
      files: validFiles,
      totalAdditions: validFiles.reduce((sum, file) => sum + file.additions, 0),
      totalDeletions: validFiles.reduce((sum, file) => sum + file.deletions, 0),
      fullDiff: this.generateFullDiff(validFiles),
      eventType,
    };

    // Fetch comment history for better context
    try {
      const { logger } = require('./logger');
      logger.info(`Fetching comment history for PR #${prInfo.number}`);
      const comments = await this.fetchPRComments(owner, repo, prInfo.number);
      (prInfo as PRInfo & { comments: PRComment[] }).comments = comments;
      logger.info(`Retrieved ${comments.length} comments`);
    } catch (error) {
      const { logger } = require('./logger');
      logger.warn(`Could not fetch comments: ${error instanceof Error ? error.message : 'Unknown error'}`);
      (prInfo as PRInfo & { comments: PRComment[] }).comments = [];
    }

    // Add commit diff for incremental analysis
    if (commitSha) {
      const { logger } = require('./logger');
      logger.info(`Fetching incremental diff for commit: ${commitSha}`);
      prInfo.commitDiff = await this.fetchCommitDiff(owner, repo, commitSha);
      prInfo.isIncremental = true;
      if (!prInfo.commitDiff || prInfo.commitDiff.length === 0) {
        const { logger } = require('./logger');
        logger.warn(`No commit diff retrieved for ${commitSha}, will use full diff as fallback`);
      } else {
        const { logger } = require('./logger');
        logger.info(`Incremental diff retrieved (${prInfo.commitDiff.length} chars)`);
      }
    } else {
      prInfo.isIncremental = false;
    }

    return prInfo;
  }

  async fetchPRComments(owner: string, repo: string, prNumber: number) {
    const { data: comments } = await this.withRetry(() =>
      this.octokit.rest.issues.listComments({
        owner,
        repo,
        issue_number: prNumber,
      })
    );

    return comments.map(comment => ({
      id: comment.id,
      author: comment.user?.login || 'unknown',
      body: comment.body || '',
      createdAt: comment.created_at,
      updatedAt: comment.updated_at,
    }));
  }

  private async withRetry<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: Error = new Error('Unknown error');

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (error) {
        // Preserve the original error object if possible
        if (error instanceof Error) {
          lastError = error;
        } else if (typeof error === 'object' && error !== null) {
          // For objects like {code: 'ETIMEDOUT', message: 'Network timeout'}
          const errorObj = error as NetworkError;
          const message = errorObj.message || errorObj.code || 'Unknown error';
          lastError = new Error(String(message));
          // Preserve important properties
          Object.assign(lastError, error);
        } else {
          lastError = new Error(String(error));
        }

        // Don't retry on the last attempt
        if (attempt === this.maxRetries) {
          break;
        }

        // Check if this is a retryable error
        if (this.isRetryableError(error)) {
          const delay = Math.min(1000 * Math.pow(2, attempt), 5000); // Exponential backoff, max 5s
          await new Promise(resolve => setTimeout(resolve, delay));
        } else {
          // Non-retryable error, fail immediately with original error
          throw error;
        }
      }
    }

    throw lastError;
  }

  private isRetryableError(error: unknown): boolean {
    // Retry on network timeouts, connection errors, and temporary server errors
    const retryableErrors = ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'];
    const retryableStatuses = [408, 429, 500, 502, 503, 504];

    // Type guard for error objects
    if (typeof error !== 'object' || error === null) {
      return false;
    }

    const err = error as NetworkError & { response?: { status?: number } };

    return (
      (err.code !== undefined && retryableErrors.includes(err.code)) ||
      (err.status !== undefined && retryableStatuses.includes(err.status)) ||
      (err.response?.status !== undefined && retryableStatuses.includes(err.response.status))
    );
  }
}
