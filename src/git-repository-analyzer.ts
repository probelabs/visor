import { simpleGit, SimpleGit, type DefaultLogFields, type ListLogLine } from 'simple-git';
import * as path from 'path';
import * as fs from 'fs';
import { PRInfo, PRDiff } from './pr-analyzer';

export interface GitFileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified' | 'renamed';
  additions: number;
  deletions: number;
  changes: number;
  content?: string;
  patch?: string;
}

export interface GitRepositoryInfo {
  title: string;
  body: string;
  author: string;
  base: string;
  head: string;
  files: GitFileChange[];
  totalAdditions: number;
  totalDeletions: number;
  isGitRepository: boolean;
  workingDirectory: string;
}

export class GitRepositoryAnalyzer {
  private git: SimpleGit;
  private cwd: string;

  constructor(workingDirectory: string = process.cwd()) {
    this.cwd = workingDirectory;
    this.git = simpleGit(workingDirectory);
  }

  /**
   * Analyze the current git repository state and return data compatible with PRInfo interface
   */
  async analyzeRepository(includeContext: boolean = true): Promise<GitRepositoryInfo> {
    // Check if we're in a git repository
    const isRepo = await this.isGitRepository();
    if (!isRepo) {
      return this.createEmptyRepositoryInfo('Not a git repository');
    }

    try {
      // Get current branch and status
      const [status, currentBranch] = await Promise.all([
        this.git.status(),
        this.getCurrentBranch(),
      ]);

      // Get uncommitted changes
      const uncommittedFiles = await this.getUncommittedChanges(includeContext);

      // Get recent commit info (handle repos with no commits)
      let lastCommit: (ListLogLine & DefaultLogFields) | null = null;
      try {
        const recentCommits = await this.git.log({ maxCount: 1 });
        lastCommit = recentCommits.latest;
      } catch {
        // Repository has no commits yet - this is OK
        console.log('📝 Repository has no commits yet, analyzing uncommitted changes');
      }

      // Get author from git config if no commits exist
      let author = lastCommit?.author_name;
      if (!author) {
        try {
          const [userName, userEmail] = await Promise.all([
            this.git.raw(['config', 'user.name']).catch(() => null),
            this.git.raw(['config', 'user.email']).catch(() => null),
          ]);
          author = userName?.trim() || userEmail?.trim() || 'unknown';
        } catch {
          author = 'unknown';
        }
      }

      // Create repository info
      const repositoryInfo: GitRepositoryInfo = {
        title: this.generateTitle(status, currentBranch),
        body: this.generateDescription(status, lastCommit),
        author,
        base: await this.getBaseBranch(),
        head: currentBranch,
        files: uncommittedFiles,
        totalAdditions: uncommittedFiles.reduce((sum, file) => sum + file.additions, 0),
        totalDeletions: uncommittedFiles.reduce((sum, file) => sum + file.deletions, 0),
        isGitRepository: true,
        workingDirectory: this.cwd,
      };

      return repositoryInfo;
    } catch (error) {
      // Don't log the full error object to avoid confusing stack traces
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Error analyzing git repository:', errorMessage);
      return this.createEmptyRepositoryInfo('Error analyzing git repository');
    }
  }

  /**
   * Convert GitRepositoryInfo to PRInfo format for compatibility with existing PRReviewer
   */
  toPRInfo(repositoryInfo: GitRepositoryInfo, includeContext: boolean = true): PRInfo {
    const files = repositoryInfo.files.map(
      (file): PRDiff => ({
        filename: file.filename,
        additions: file.additions,
        deletions: file.deletions,
        changes: file.changes,
        patch: includeContext ? file.patch : undefined,
        status: file.status,
      })
    );

    // Generate fullDiff from patches if includeContext is true
    let fullDiff: string | undefined;
    if (includeContext) {
      fullDiff = files
        .filter(file => file.patch)
        .map(file => `--- ${file.filename}\n${file.patch}`)
        .join('\n\n');
    }

    return {
      number: 0, // Local analysis doesn't have PR number
      title: repositoryInfo.title,
      body: repositoryInfo.body,
      author: repositoryInfo.author,
      base: repositoryInfo.base,
      head: repositoryInfo.head,
      files,
      totalAdditions: repositoryInfo.totalAdditions,
      totalDeletions: repositoryInfo.totalDeletions,
      fullDiff,
    };
  }

  private async isGitRepository(): Promise<boolean> {
    try {
      await this.git.checkIsRepo();
      return true;
    } catch {
      return false;
    }
  }

  private async getCurrentBranch(): Promise<string> {
    try {
      const branchSummary = await this.git.branch();
      return branchSummary.current || 'unknown';
    } catch {
      return 'unknown';
    }
  }

  private async getBaseBranch(): Promise<string> {
    try {
      // Try to get the default branch from remote
      const branches = await this.git.branch(['-r']);
      const mainBranches = ['origin/main', 'origin/master', 'origin/develop'];

      for (const mainBranch of mainBranches) {
        if (branches.all.includes(mainBranch)) {
          return mainBranch.replace('origin/', '');
        }
      }

      // Fallback to main/master
      return 'main';
    } catch {
      return 'main';
    }
  }

  private async getRemoteInfo(): Promise<{ name: string; url: string } | null> {
    try {
      const remotes = await this.git.getRemotes(true);
      const origin = remotes.find(r => r.name === 'origin');
      return origin
        ? { name: origin.name, url: origin.refs.fetch || origin.refs.push || '' }
        : null;
    } catch {
      return null;
    }
  }

  private async getUncommittedChanges(includeContext: boolean = true): Promise<GitFileChange[]> {
    try {
      const status = await this.git.status();
      const changes: GitFileChange[] = [];

      // Process different types of changes
      const fileChanges = [
        ...status.created.map(f => ({ file: f, status: 'added' as const })),
        ...status.deleted.map(f => ({ file: f, status: 'removed' as const })),
        ...status.modified.map(f => ({ file: f, status: 'modified' as const })),
        ...status.renamed.map(f => ({
          file: typeof f === 'string' ? f : f.to || f.from,
          status: 'renamed' as const,
        })),
      ];

      for (const { file, status } of fileChanges) {
        const filePath = path.join(this.cwd, file);
        const fileChange = await this.analyzeFileChange(file, status, filePath, includeContext);
        changes.push(fileChange);
      }

      return changes;
    } catch (error) {
      console.error('Error getting uncommitted changes:', error);
      return [];
    }
  }

  private async analyzeFileChange(
    filename: string,
    status: 'added' | 'removed' | 'modified' | 'renamed',
    filePath: string,
    includeContext: boolean = true
  ): Promise<GitFileChange> {
    let additions = 0;
    let deletions = 0;
    let patch: string | undefined;
    let content: string | undefined;

    try {
      // Get diff for the file if it exists and is not binary
      if (includeContext && status !== 'added' && fs.existsSync(filePath)) {
        const diff = await this.git.diff(['--', filename]).catch(() => '');
        if (diff) {
          patch = diff;
          // Count additions and deletions from diff
          const lines = diff.split('\n');
          additions = lines.filter(line => line.startsWith('+')).length;
          deletions = lines.filter(line => line.startsWith('-')).length;
        }
      } else if (status !== 'added' && fs.existsSync(filePath)) {
        // If not including context, still count changes for statistics
        const diff = await this.git.diff(['--', filename]).catch(() => '');
        if (diff) {
          const lines = diff.split('\n');
          additions = lines.filter(line => line.startsWith('+')).length;
          deletions = lines.filter(line => line.startsWith('-')).length;
        }
      }

      // For added files
      if (status === 'added' && fs.existsSync(filePath)) {
        try {
          const stats = fs.statSync(filePath);
          if (stats.isFile() && stats.size < 1024 * 1024) {
            // Skip files larger than 1MB
            if (includeContext) {
              content = fs.readFileSync(filePath, 'utf8');
              patch = content; // For new files, the entire content is the "patch"
            }
            // Always count additions for statistics
            const fileContent = includeContext ? content : fs.readFileSync(filePath, 'utf8');
            additions = fileContent!.split('\n').length;
          }
        } catch {
          // Skip binary or unreadable files
        }
      }

      // For removed files, we can't easily count the lines without the previous version
      if (status === 'removed') {
        deletions = 1; // Placeholder - in real git we'd need the previous version
      }
    } catch (error) {
      console.error(`Error analyzing file change for ${filename}:`, error);
    }

    return {
      filename,
      status,
      additions,
      deletions,
      changes: additions + deletions,
      content,
      patch,
    };
  }

  private generateTitle(status: import('simple-git').StatusResult, branch: string): string {
    if (status.files.length === 0) {
      return `Local Analysis: ${branch} (No changes)`;
    }

    const changeTypes = [];
    if (status.created.length > 0) changeTypes.push(`${status.created.length} added`);
    if (status.modified.length > 0) changeTypes.push(`${status.modified.length} modified`);
    if (status.deleted.length > 0) changeTypes.push(`${status.deleted.length} deleted`);
    if (status.renamed.length > 0) changeTypes.push(`${status.renamed.length} renamed`);

    return `Local Analysis: ${branch} (${changeTypes.join(', ')})`;
  }

  private generateDescription(
    status: import('simple-git').StatusResult,
    lastCommit: import('simple-git').DefaultLogFields | null
  ): string {
    let description = `Analysis of local git repository working directory.\n\n`;

    if (lastCommit) {
      description += `**Last Commit:** ${lastCommit.message}\n`;
      description += `**Author:** ${lastCommit.author_name} <${lastCommit.author_email}>\n`;
      description += `**Date:** ${lastCommit.date}\n\n`;
    }

    if (status.files.length === 0) {
      description += `**Status:** Working directory is clean - no uncommitted changes found.\n`;
    } else {
      description += `**Changes Summary:**\n`;
      description += `- Files to be committed: ${status.staged.length}\n`;
      description += `- Modified files: ${status.modified.length}\n`;
      description += `- Untracked files: ${status.not_added.length}\n`;

      if (status.conflicted.length > 0) {
        description += `- Conflicted files: ${status.conflicted.length}\n`;
      }
    }

    return description;
  }

  private createEmptyRepositoryInfo(reason: string): GitRepositoryInfo {
    return {
      title: `Local Analysis: ${reason}`,
      body: `Unable to analyze repository: ${reason}`,
      author: 'system',
      base: 'main',
      head: 'HEAD',
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
      isGitRepository: false,
      workingDirectory: this.cwd,
    };
  }
}
