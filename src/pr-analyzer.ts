import { Octokit } from '@octokit/rest';

export interface PRDiff {
  filename: string;
  additions: number;
  deletions: number;
  changes: number;
  patch?: string;
  status: 'added' | 'removed' | 'modified' | 'renamed';
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
}

export class PRAnalyzer {
  constructor(private octokit: Octokit) {}

  async fetchPRDiff(owner: string, repo: string, prNumber: number): Promise<PRInfo> {
    const [prData, filesData] = await Promise.all([
      this.octokit.rest.pulls.get({
        owner,
        repo,
        pull_number: prNumber,
      }),
      this.octokit.rest.pulls.listFiles({
        owner,
        repo,
        pull_number: prNumber,
      }),
    ]);

    const pr = prData.data;
    const files = filesData.data;

    return {
      number: pr.number,
      title: pr.title,
      body: pr.body || '',
      author: pr.user?.login || 'unknown',
      base: pr.base.ref,
      head: pr.head.ref,
      files: files.map(file => ({
        filename: file.filename,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        patch: file.patch,
        status: file.status as 'added' | 'removed' | 'modified' | 'renamed',
      })),
      totalAdditions: files.reduce((sum, file) => sum + file.additions, 0),
      totalDeletions: files.reduce((sum, file) => sum + file.deletions, 0),
    };
  }

  async fetchPRComments(owner: string, repo: string, prNumber: number) {
    const { data: comments } = await this.octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: prNumber,
    });

    return comments.map(comment => ({
      id: comment.id,
      author: comment.user?.login || 'unknown',
      body: comment.body || '',
      createdAt: comment.created_at,
      updatedAt: comment.updated_at,
    }));
  }
}
