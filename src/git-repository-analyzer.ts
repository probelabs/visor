import { simpleGit, SimpleGit, type DefaultLogFields, type ListLogLine } from 'simple-git';
import * as path from 'path';
import * as fs from 'fs';
import { PRInfo, PRDiff } from './pr-analyzer';
import { FileExclusionHelper } from './utils/file-exclusion';

export interface GitFileChange {
  filename: string;
  status: 'added' | 'removed' | 'modified' | 'renamed';
  additions: number;
  deletions: number;
  changes: number;
  content?: string;
  patch?: string;
  truncated?: boolean;
}

// Maximum patch size in bytes (50KB) - helps prevent token limit issues
const MAX_PATCH_SIZE = 50 * 1024;

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
  private fileExclusionHelper: FileExclusionHelper;

  constructor(workingDirectory: string = process.cwd()) {
    this.cwd = workingDirectory;
    this.git = simpleGit(workingDirectory);
    this.fileExclusionHelper = new FileExclusionHelper(workingDirectory);
  }

  /**
   * Analyze the current git repository state and return data compatible with PRInfo interface
   */
  async analyzeRepository(
    includeContext: boolean = true,
    enableBranchDiff: boolean = false
  ): Promise<GitRepositoryInfo> {
    // Check if we're in a git repository
    const isRepo = await this.isGitRepository();
    if (!isRepo) {
      return this.createEmptyRepositoryInfo('Not a git repository');
    }

    try {
      // Get current branch and status
      const [status, currentBranch, baseBranch] = await Promise.all([
        this.git.status(),
        this.getCurrentBranch(),
        this.getBaseBranch(),
      ]);

      // Determine if we're on a feature branch
      const isFeatureBranch =
        currentBranch !== baseBranch && currentBranch !== 'main' && currentBranch !== 'master';

      // Get uncommitted changes first
      let uncommittedFiles = await this.getUncommittedChanges(includeContext);

      // If branch diff is explicitly enabled, use branch diff (ignoring uncommitted changes)
      // Otherwise, if on a feature branch with no uncommitted changes AND branch diff is enabled, get diff vs base branch
      if (isFeatureBranch && includeContext && enableBranchDiff) {
        if (uncommittedFiles.length > 0) {
          console.error(`📊 Feature branch detected: ${currentBranch}`);
          console.error(
            `⚠️  Ignoring ${uncommittedFiles.length} uncommitted file(s) due to --analyze-branch-diff flag`
          );
        } else {
          console.error(`📊 Feature branch detected: ${currentBranch}`);
        }
        console.error(
          `📂 Analyzing diff vs ${baseBranch} (${uncommittedFiles.length > 0 ? 'forced by --analyze-branch-diff' : 'auto-enabled for code-review schemas'})`
        );
        uncommittedFiles = await this.getBranchDiff(baseBranch, includeContext);
      } else if (uncommittedFiles.length > 0) {
        console.error(`📝 Analyzing uncommitted changes (${uncommittedFiles.length} files)`);
      }

      // Get recent commit info (handle repos with no commits)
      let lastCommit: (ListLogLine & DefaultLogFields) | null = null;
      try {
        const recentCommits = await this.git.log({ maxCount: 1 });
        lastCommit = recentCommits.latest;
      } catch {
        // Repository has no commits yet - this is OK
        console.error('📝 Repository has no commits yet, analyzing uncommitted changes');
      }

      // Get author from git config if no commits exist
      let author = lastCommit?.author_name;
      if (!author) {
        try {
          // Read ONLY repository-local config to avoid leaking global user identity into tests
          const [userName, userEmail] = await Promise.all([
            this.git.raw(['config', '--local', 'user.name']).catch(() => null),
            this.git.raw(['config', '--local', 'user.email']).catch(() => null),
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
        base: baseBranch,
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

  /**
   * Check if a file should be excluded from analysis using git check-ignore
   * This supplements the FileExclusionHelper with git-specific checks
   */
  private async shouldExcludeFileGit(filename: string): Promise<boolean> {
    try {
      const result = await this.git.raw(['check-ignore', filename]);
      return result.trim().length > 0;
    } catch {
      // If check-ignore returns non-zero exit code, the file is not ignored
      return false;
    }
  }

  /**
   * Truncate a patch if it exceeds MAX_PATCH_SIZE
   */
  private truncatePatch(patch: string, filename: string): { patch: string; truncated: boolean } {
    const patchSize = Buffer.byteLength(patch, 'utf8');

    if (patchSize <= MAX_PATCH_SIZE) {
      return { patch, truncated: false };
    }

    // Truncate to MAX_PATCH_SIZE and add a notice
    const truncated = patch.substring(0, MAX_PATCH_SIZE);
    const truncatedPatch = `${truncated}\n\n... [TRUNCATED: Diff too large (${(patchSize / 1024).toFixed(1)}KB), showing first ${(MAX_PATCH_SIZE / 1024).toFixed(0)}KB] ...`;

    console.error(
      `⚠️  Truncated diff for ${filename} (${(patchSize / 1024).toFixed(1)}KB → ${(MAX_PATCH_SIZE / 1024).toFixed(0)}KB)`
    );

    return { patch: truncatedPatch, truncated: true };
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
        // Skip files that should be excluded from analysis
        if (this.fileExclusionHelper.shouldExcludeFile(file) || (await this.shouldExcludeFileGit(file))) {
          console.error(`⏭️  Skipping excluded file: ${file}`);
          continue;
        }

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

  /**
   * Get diff between current branch and base branch (for feature branch analysis)
   */
  private async getBranchDiff(
    baseBranch: string,
    includeContext: boolean = true
  ): Promise<GitFileChange[]> {
    try {
      // Get the list of changed files between base and current branch
      const diffSummary = await this.git.diffSummary([baseBranch]);
      const changes: GitFileChange[] = [];

      if (!diffSummary || !diffSummary.files) {
        return [];
      }

      for (const file of diffSummary.files) {
        // Skip files that should be excluded from analysis
        if (this.fileExclusionHelper.shouldExcludeFile(file.file) || (await this.shouldExcludeFileGit(file.file))) {
          console.error(`⏭️  Skipping excluded file: ${file.file}`);
          continue;
        }

        // Handle different file types (binary files don't have insertions/deletions)
        const isBinary = 'binary' in file && file.binary;
        const insertions = 'insertions' in file ? file.insertions : 0;
        const deletions = 'deletions' in file ? file.deletions : 0;
        const fileChanges = 'changes' in file ? file.changes : 0;

        // Determine status based on insertions/deletions
        let status: 'added' | 'removed' | 'modified' | 'renamed';
        if (isBinary) {
          status = 'modified';
        } else if (insertions > 0 && deletions === 0) {
          status = 'added';
        } else if (insertions === 0 && deletions > 0) {
          status = 'removed';
        } else {
          status = 'modified';
        }

        // Get the actual diff patch if needed
        let patch: string | undefined;
        let truncated = false;
        if (includeContext && !isBinary) {
          try {
            const rawPatch = await this.git.diff([baseBranch, '--', file.file]);
            if (rawPatch) {
              const result = this.truncatePatch(rawPatch, file.file);
              patch = result.patch;
              truncated = result.truncated;
            }
          } catch {
            // Ignore diff errors for specific files
          }
        }

        const fileChange: GitFileChange = {
          filename: file.file,
          additions: insertions,
          deletions: deletions,
          changes: fileChanges,
          status,
          patch,
          truncated,
        };

        changes.push(fileChange);
      }

      return changes;
    } catch (error) {
      console.error('Error getting branch diff:', error);
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
    let truncated = false;

    try {
      // Get diff for the file if it exists and is not binary
      if (includeContext && status !== 'added' && fs.existsSync(filePath)) {
        const diff = await this.git.diff(['--', filename]).catch(() => '');
        if (diff) {
          const result = this.truncatePatch(diff, filename);
          patch = result.patch;
          truncated = result.truncated;
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
              const result = this.truncatePatch(content, filename);
              patch = result.patch; // For new files, the entire content is the "patch"
              truncated = result.truncated;
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
      truncated,
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
