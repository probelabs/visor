import { Octokit } from '@octokit/rest';

export interface PRDetectionResult {
  prNumber: number | null;
  confidence: 'high' | 'medium' | 'low';
  source: 'direct' | 'api_query' | 'comment' | 'branch_search' | 'commit_search';
  details?: string;
}

export interface GitHubEventContext {
  event_name: string;
  repository?: {
    owner: { login: string };
    name: string;
  };
  event?: {
    pull_request?: { number: number; head?: { sha: string } };
    issue?: { number: number; pull_request?: { url: string } };
    comment?: { body: string; user: { login: string } };
    action?: string;
    commits?: Array<{ id: string; message: string }>;
    head_commit?: { id: string };
    ref?: string;
  };
  payload?: Record<string, unknown>;
}

/**
 * Robust PR detection utility that works across all GitHub event types
 */
export class PRDetector {
  private octokit: Octokit;
  private debug: boolean;

  constructor(octokit: Octokit, debug = false) {
    this.octokit = octokit;
    this.debug = debug;
  }

  private log(message: string, ...args: unknown[]): void {
    if (this.debug) {
      // Lazy import to avoid cycles
      import('./logger').then(({ logger }) => {
        logger.debug(`[PR Detector] ${message} ${args.map(a => String(a)).join(' ')}`);
      });
    }
  }

  /**
   * Detect PR number from GitHub context with comprehensive fallback strategies
   */
  public async detectPRNumber(
    context: GitHubEventContext,
    owner?: string,
    repo?: string
  ): Promise<PRDetectionResult> {
    const repoOwner = owner || context.repository?.owner.login;
    const repoName = repo || context.repository?.name;

    if (!repoOwner || !repoName) {
      this.log('Missing repository information');
      return {
        prNumber: null,
        confidence: 'low',
        source: 'direct',
        details: 'Missing repository owner or name',
      };
    }

    this.log(`Detecting PR for event: ${context.event_name} in ${repoOwner}/${repoName}`);

    try {
      // Strategy 1: Direct PR event detection
      const directResult = this.detectFromDirectPREvent(context);
      if (directResult.prNumber) {
        this.log(`Found PR via direct event: #${directResult.prNumber}`);
        return directResult;
      }

      // Strategy 2: Issue comment PR detection
      const commentResult = this.detectFromIssueComment(context);
      if (commentResult.prNumber) {
        this.log(`Found PR via issue comment: #${commentResult.prNumber}`);
        return commentResult;
      }

      // Strategy 3: Push event PR detection (query GitHub API)
      if (context.event_name === 'push') {
        const pushResult = await this.detectFromPushEvent(context, repoOwner, repoName);
        if (pushResult.prNumber) {
          this.log(`Found PR via push event API query: #${pushResult.prNumber}`);
          return pushResult;
        }
      }

      // Strategy 4: Branch-based PR search
      const branchResult = await this.detectFromBranch(context, repoOwner, repoName);
      if (branchResult.prNumber) {
        this.log(`Found PR via branch search: #${branchResult.prNumber}`);
        return branchResult;
      }

      // Strategy 5: Commit-based PR search
      const commitResult = await this.detectFromCommit(context, repoOwner, repoName);
      if (commitResult.prNumber) {
        this.log(`Found PR via commit search: #${commitResult.prNumber}`);
        return commitResult;
      }

      this.log('No PR found with any detection strategy');
      return {
        prNumber: null,
        confidence: 'low',
        source: 'direct',
        details: `No PR found for ${context.event_name} event`,
      };
    } catch (error) {
      this.log('Error during PR detection:', error);
      return {
        prNumber: null,
        confidence: 'low',
        source: 'direct',
        details: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Strategy 1: Detect PR from direct PR events
   */
  private detectFromDirectPREvent(context: GitHubEventContext): PRDetectionResult {
    const prNumber = context.event?.pull_request?.number;
    if (prNumber) {
      return {
        prNumber,
        confidence: 'high',
        source: 'direct',
        details: `Direct PR event: ${context.event_name}`,
      };
    }

    return { prNumber: null, confidence: 'low', source: 'direct' };
  }

  /**
   * Strategy 2: Detect PR from issue comment events
   */
  private detectFromIssueComment(context: GitHubEventContext): PRDetectionResult {
    if (context.event_name === 'issue_comment') {
      const issue = context.event?.issue;
      // Check if this issue is actually a PR (issues with pull_request key are PRs)
      if (issue?.pull_request && issue.number) {
        return {
          prNumber: issue.number,
          confidence: 'high',
          source: 'comment',
          details: 'Issue comment on PR',
        };
      }
    }

    return { prNumber: null, confidence: 'low', source: 'comment' };
  }

  /**
   * Strategy 3: Detect PR from push events by querying associated PRs
   */
  private async detectFromPushEvent(
    context: GitHubEventContext,
    owner: string,
    repo: string
  ): Promise<PRDetectionResult> {
    if (context.event_name !== 'push') {
      return { prNumber: null, confidence: 'low', source: 'api_query' };
    }

    const ref = context.event?.ref;
    const commits = context.event?.commits || [];
    const headCommit = context.event?.head_commit;

    // Extract branch name from ref (refs/heads/branch-name)
    const branchName = ref?.replace('refs/heads/', '');

    this.log(`Push event - Branch: ${branchName}, Commits: ${commits.length}`);

    // First, try to find PRs for the specific branch
    if (branchName && branchName !== 'main' && branchName !== 'master') {
      try {
        const prs = await this.octokit.rest.pulls.list({
          owner,
          repo,
          head: `${owner}:${branchName}`,
          state: 'open',
        });

        if (prs.data.length > 0) {
          return {
            prNumber: prs.data[0].number,
            confidence: 'high',
            source: 'api_query',
            details: `Found open PR for branch ${branchName}`,
          };
        }
      } catch (error) {
        this.log(`Error querying PRs for branch ${branchName}:`, error);
      }
    }

    // If head commit exists, search for PRs containing that commit
    if (headCommit?.id) {
      const commitResult = await this.searchPRsByCommit(owner, repo, headCommit.id);
      if (commitResult.prNumber) {
        return {
          ...commitResult,
          source: 'api_query',
          details: `Found PR containing head commit ${headCommit.id}`,
        };
      }
    }

    // If we have multiple commits, try the most recent ones
    if (commits.length > 0) {
      for (const commit of commits.slice(-3)) {
        // Check last 3 commits
        if (commit.id) {
          const commitResult = await this.searchPRsByCommit(owner, repo, commit.id);
          if (commitResult.prNumber) {
            return {
              ...commitResult,
              source: 'api_query',
              details: `Found PR containing commit ${commit.id}`,
            };
          }
        }
      }
    }

    return { prNumber: null, confidence: 'low', source: 'api_query' };
  }

  /**
   * Strategy 4: Detect PR by searching current branch
   */
  private async detectFromBranch(
    context: GitHubEventContext,
    owner: string,
    repo: string
  ): Promise<PRDetectionResult> {
    try {
      // Try to get current branch from various sources
      let branchName: string | null = null;

      // From push event ref
      if (context.event?.ref) {
        branchName = context.event.ref.replace('refs/heads/', '');
      }

      // Try to get current branch from environment (GitHub Actions sets this)
      if (!branchName && process.env.GITHUB_HEAD_REF) {
        branchName = process.env.GITHUB_HEAD_REF;
      }

      if (!branchName && process.env.GITHUB_REF_NAME) {
        branchName = process.env.GITHUB_REF_NAME;
      }

      if (!branchName) {
        this.log('No branch name found for branch-based search');
        return { prNumber: null, confidence: 'low', source: 'branch_search' };
      }

      this.log(`Searching for PRs on branch: ${branchName}`);

      // Search for open PRs from this branch
      const prs = await this.octokit.rest.pulls.list({
        owner,
        repo,
        head: `${owner}:${branchName}`,
        state: 'open',
      });

      if (prs.data.length > 0) {
        return {
          prNumber: prs.data[0].number,
          confidence: 'medium',
          source: 'branch_search',
          details: `Found open PR from branch ${branchName}`,
        };
      }

      // Also try searching closed PRs (recently merged)
      const closedPrs = await this.octokit.rest.pulls.list({
        owner,
        repo,
        head: `${owner}:${branchName}`,
        state: 'closed',
        sort: 'updated',
        direction: 'desc',
        per_page: 5,
      });

      if (closedPrs.data.length > 0) {
        const recentPr = closedPrs.data[0];
        return {
          prNumber: recentPr.number,
          confidence: 'medium',
          source: 'branch_search',
          details: `Found recently closed PR from branch ${branchName}`,
        };
      }

      return { prNumber: null, confidence: 'low', source: 'branch_search' };
    } catch (error) {
      this.log('Error in branch-based PR search:', error);
      return {
        prNumber: null,
        confidence: 'low',
        source: 'branch_search',
        details: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Strategy 5: Detect PR by searching for commits
   */
  private async detectFromCommit(
    context: GitHubEventContext,
    owner: string,
    repo: string
  ): Promise<PRDetectionResult> {
    // Try to get commit SHA from various sources
    let commitSha: string | null = null;

    if (context.event?.head_commit?.id) {
      commitSha = context.event.head_commit.id;
    } else if (process.env.GITHUB_SHA) {
      commitSha = process.env.GITHUB_SHA;
    }

    if (!commitSha) {
      this.log('No commit SHA found for commit-based search');
      return { prNumber: null, confidence: 'low', source: 'commit_search' };
    }

    this.log(`Searching for PRs containing commit: ${commitSha}`);

    return await this.searchPRsByCommit(owner, repo, commitSha);
  }

  /**
   * Search for PRs containing a specific commit
   */
  private async searchPRsByCommit(
    owner: string,
    repo: string,
    commitSha: string
  ): Promise<PRDetectionResult> {
    try {
      // GitHub's search API can find PRs containing specific commits
      const searchQuery = `repo:${owner}/${repo} type:pr ${commitSha}`;

      this.log(`Searching with query: ${searchQuery}`);

      const searchResults = await this.octokit.rest.search.issuesAndPullRequests({
        q: searchQuery,
        sort: 'updated',
        order: 'desc',
        per_page: 10,
      });

      if (searchResults.data.items.length > 0) {
        // Find the most recent PR that contains this commit
        for (const item of searchResults.data.items) {
          if (item.pull_request) {
            return {
              prNumber: item.number,
              confidence: 'medium',
              source: 'commit_search',
              details: `Found PR via commit search for ${commitSha}`,
            };
          }
        }
      }

      // Fallback: Get recent PRs and check if they contain the commit
      const recentPrs = await this.octokit.rest.pulls.list({
        owner,
        repo,
        state: 'all',
        sort: 'updated',
        direction: 'desc',
        per_page: 20,
      });

      for (const pr of recentPrs.data) {
        try {
          // Check if this PR contains the commit
          const commits = await this.octokit.rest.pulls.listCommits({
            owner,
            repo,
            pull_number: pr.number,
          });

          const hasCommit = commits.data.some(commit => commit.sha === commitSha);
          if (hasCommit) {
            return {
              prNumber: pr.number,
              confidence: 'high',
              source: 'commit_search',
              details: `Found PR containing commit ${commitSha}`,
            };
          }
        } catch (error) {
          // Continue to next PR if we can't check commits
          this.log(`Error checking commits for PR #${pr.number}:`, error);
          continue;
        }
      }

      return { prNumber: null, confidence: 'low', source: 'commit_search' };
    } catch (error) {
      this.log('Error in commit-based PR search:', error);
      return {
        prNumber: null,
        confidence: 'low',
        source: 'commit_search',
        details: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Get PR detection summary for debugging
   */
  public getDetectionStrategies(): string[] {
    return [
      '1. Direct PR event detection (pull_request events)',
      '2. Issue comment PR detection (issue_comment events on PRs)',
      '3. Push event PR detection (API queries for branch PRs)',
      '4. Branch-based PR search (current branch PRs)',
      '5. Commit-based PR search (PRs containing specific commits)',
    ];
  }
}
