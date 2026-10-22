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

// Untracked files above this size are not reviewed (same 1MB cap analyzeFileChange uses).
const MAX_UNTRACKED_FILE_SIZE = 1024 * 1024;
// Dependency/build dirs (at any depth) whose untracked files are never review input,
// on top of FileExclusionHelper's defaults (node_modules/, dist/, build/, ...).
const UNTRACKED_EXCLUDED_DIRS = new Set(['vendor', '.venv', 'venv', 'target', '__pycache__']);
// Untracked files with these names are never read into a prompt.
const SECRET_FILE_NAMES = new Set([
  'id_rsa',
  'id_dsa',
  'id_ecdsa',
  'id_ed25519',
  'credentials.json',
]);

interface WorkingTreeEntry {
  file: string;
  status: 'added' | 'removed' | 'modified' | 'renamed';
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
  /** Which change set `files` holds: the working tree vs HEAD, or the branch vs its base. */
  diffSource?: 'uncommitted' | 'branch';
}

/**
 * How a local (CLI) run picks the change set to review.
 * - `auto`: review tracked uncommitted changes when there are any (untracked files
 *   ride along when `includeUntracked`, but never decide the mode); on a feature
 *   branch with no tracked uncommitted changes, fall back to the branch diff when
 *   branch diff is enabled (e.g. auto-enabled for code-review schemas).
 * - `branch`: explicit `--analyze-branch-diff` — on a feature branch, always review
 *   the diff vs the base branch, even when there are uncommitted changes.
 * - `uncommitted`: explicit `--uncommitted` — always review only the uncommitted
 *   changes (staged, unstaged and untracked), on any branch.
 */
export type LocalDiffMode = 'auto' | 'branch' | 'uncommitted';

export interface AnalyzeRepositoryOptions {
  baseBranch?: string;
  /**
   * Defaults to 'branch' when `enableBranchDiff` is true (the historical "force the
   * branch diff" meaning of that argument) and 'auto' otherwise.
   */
  diffMode?: LocalDiffMode;
  /**
   * Review untracked files alongside tracked uncommitted edits (always on for
   * 'uncommitted'). Off by default so SDK/bot/scheduler callers keep their file set.
   */
  includeUntracked?: boolean;
  /** This run's --output-file; never reviewed as a change. */
  outputFile?: string;
}

/**
 * Map CLI flags to the analyzer's inputs. `--analyze-branch-diff` is the only thing that
 * forces the branch diff over uncommitted changes; a code-review schema merely enables it
 * as the clean-tree fallback; `--uncommitted` always reviews only the working tree.
 */
export function resolveLocalDiffSelection(opts: {
  analyzeBranchDiff?: boolean;
  uncommitted?: boolean;
  hasCodeReviewSchema: boolean;
  debugServer?: boolean;
}): { enableBranchDiff: boolean; diffMode: LocalDiffMode } {
  if (opts.analyzeBranchDiff && opts.uncommitted) {
    throw new Error('--uncommitted and --analyze-branch-diff are mutually exclusive');
  }
  if (opts.debugServer && opts.uncommitted) {
    throw new Error('--uncommitted cannot be used with --debug-server (it skips diff analysis)');
  }
  // Skip git diff analysis when the debug server is active (not needed for debugging).
  if (opts.debugServer) return { enableBranchDiff: false, diffMode: 'auto' };
  if (opts.uncommitted) return { enableBranchDiff: false, diffMode: 'uncommitted' };
  if (opts.analyzeBranchDiff) return { enableBranchDiff: true, diffMode: 'branch' };
  return { enableBranchDiff: opts.hasCodeReviewSchema, diffMode: 'auto' };
}

export interface PrContextOverrides {
  prTitle?: string;
  prBody?: string;
  prBodyFile?: string;
}

/**
 * Apply user-supplied PR title/description (CLI `--pr-title`, `--pr-body`,
 * `--pr-body-file`) on top of the generated local-analysis values, so a local
 * run sees the same `pr.title` / `pr.description` a GitHub-mode run would.
 */
export function applyPrContextOverrides(
  info: GitRepositoryInfo,
  overrides: PrContextOverrides
): GitRepositoryInfo {
  if (overrides.prBody !== undefined && overrides.prBodyFile !== undefined) {
    throw new Error('--pr-body and --pr-body-file are mutually exclusive');
  }
  let body = overrides.prBody;
  if (overrides.prBodyFile !== undefined) {
    try {
      body = fs.readFileSync(overrides.prBodyFile, 'utf8');
    } catch (error) {
      throw new Error(
        `Cannot read --pr-body-file ${overrides.prBodyFile}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  return {
    ...info,
    title: overrides.prTitle !== undefined ? overrides.prTitle : info.title,
    body: body !== undefined ? body : info.body,
  };
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
    enableBranchDiff: boolean = false,
    options: AnalyzeRepositoryOptions = {}
  ): Promise<GitRepositoryInfo> {
    // Check if we're in a git repository
    const isRepo = await this.isGitRepository();
    if (!isRepo) {
      return this.createEmptyRepositoryInfo('Not a git repository');
    }

    try {
      // Get current branch and status
      const explicitBase = options.baseBranch?.trim() || undefined;
      const [status, currentBranch, baseBranch] = await Promise.all([
        this.git.status(),
        this.getCurrentBranch(),
        explicitBase ? Promise.resolve(explicitBase) : this.getBaseBranch(),
      ]);

      // Determine if we're on a feature branch. With an explicit base, any other
      // branch (even one named main/master) is diffed against it.
      const isFeatureBranch =
        currentBranch !== baseBranch &&
        (explicitBase !== undefined || (currentBranch !== 'main' && currentBranch !== 'master'));

      // Pick the change set.
      // - 'branch' (explicit --analyze-branch-diff, or a legacy `enableBranchDiff=true`
      //   caller with no diffMode): on a feature branch, always the branch diff.
      // - 'auto': tracked uncommitted edits win; on a feature branch with no tracked edits
      //   the branch diff is the fallback when enabled (code-review schema). Untracked
      //   files ride along with tracked edits but never decide the mode on their own.
      // - 'uncommitted' (--uncommitted): the working tree only, untracked files included.
      const diffMode: LocalDiffMode = options.diffMode ?? (enableBranchDiff ? 'branch' : 'auto');
      const forceBranchDiff = diffMode === 'branch';
      const branchDiffAllowed = diffMode !== 'uncommitted' && (enableBranchDiff || forceBranchDiff);
      const includeUntracked = diffMode === 'uncommitted' || options.includeUntracked === true;

      let tracked: WorkingTreeEntry[] = [];
      let untracked: WorkingTreeEntry[] = [];
      try {
        ({ tracked, untracked } = await this.listWorkingTreeChanges(
          includeUntracked,
          options.outputFile
        ));
      } catch (error) {
        console.error('Error getting uncommitted changes:', error);
      }

      const useBranchDiff =
        isFeatureBranch &&
        includeContext &&
        branchDiffAllowed &&
        (forceBranchDiff || tracked.length === 0);

      let files: GitFileChange[] = [];
      let diffSource: 'uncommitted' | 'branch' = 'uncommitted';
      let untrackedReviewed = 0;
      if (useBranchDiff) {
        console.error(`📊 Feature branch detected: ${currentBranch}`);
        if (forceBranchDiff && untracked.length > 0) {
          console.error(
            `⚠️  Not including ${untracked.length} untracked file(s): a branch diff covers tracked files only (tracked uncommitted edits stay in it)`
          );
        }
        console.error(
          `📂 Analyzing diff vs ${baseBranch} (${forceBranchDiff ? 'forced by --analyze-branch-diff' : 'auto: no tracked uncommitted changes on a feature branch'})`
        );
        files = await this.getBranchDiff(baseBranch, includeContext, options.outputFile);
        diffSource = 'branch';
      } else if (tracked.length > 0 || diffMode === 'uncommitted') {
        const entries = [...tracked, ...untracked];
        untrackedReviewed = untracked.length;
        files = await this.analyzeWorkingTreeEntries(entries, includeContext);
        let reason = '';
        if (diffMode === 'uncommitted') {
          reason = ' (forced by --uncommitted)';
        } else if (isFeatureBranch && includeContext && branchDiffAllowed) {
          reason =
            ' (auto: tracked uncommitted changes present; pass --analyze-branch-diff to review the branch diff instead)';
        }
        if (files.length > 0) {
          const breakdown =
            untracked.length > 0
              ? `: ${tracked.length} tracked, ${untracked.length} untracked`
              : '';
          console.error(
            `📝 Analyzing uncommitted changes (${files.length} files${breakdown})${reason}`
          );
        } else {
          console.error('📝 No uncommitted changes to analyze (--uncommitted)');
        }
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
        title: this.generateTitle(status, currentBranch, untrackedReviewed),
        body: this.generateDescription(status, lastCommit),
        author,
        base: baseBranch,
        head: currentBranch,
        files,
        totalAdditions: files.reduce((sum, file) => sum + file.additions, 0),
        totalDeletions: files.reduce((sum, file) => sum + file.deletions, 0),
        isGitRepository: true,
        workingDirectory: this.cwd,
        diffSource,
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

  /**
   * Paths Visor itself writes into the working directory before (or while) it analyzes
   * it: its state dir `.visor/` (config snapshot DB + WAL, schedules, tasks, worktrees,
   * snapshots), run traces (VISOR_TRACE_DIR, default `output/traces`), the fallback trace
   * file, and this run's `--output-file`. They are never review input, whether or not the
   * user's .gitignore covers them.
   */
  private visorOwnedMatcher(outputFile?: string): (file: string) => boolean {
    const cwd = path.resolve(this.cwd);
    const dirs: string[] = [];
    const files: string[] = [];
    const addDir = (dir: string | undefined) => {
      if (!dir) return;
      const abs = path.resolve(cwd, dir);
      // Never let a dir that is the repo root (or above it) swallow the whole tree.
      if (abs === cwd || cwd.startsWith(abs + path.sep)) return;
      dirs.push(abs);
    };
    addDir('.visor');
    addDir(process.env.VISOR_SNAPSHOT_DIR);
    addDir(process.env.VISOR_WORKTREE_PATH);
    addDir(process.env.VISOR_TRACE_DIR || path.join('output', 'traces'));
    const fallbackTrace = process.env.VISOR_FALLBACK_TRACE_FILE;
    if (fallbackTrace) {
      files.push(path.resolve(cwd, fallbackTrace));
      addDir(path.dirname(fallbackTrace));
    }
    if (outputFile) files.push(path.resolve(cwd, outputFile));
    return (file: string) => {
      const abs = path.resolve(cwd, file);
      return files.includes(abs) || dirs.some(dir => abs === dir || abs.startsWith(dir + path.sep));
    };
  }

  /**
   * Why an untracked file must not be read into a review (or count as uncommitted work),
   * or null when it may. Untracked files have never been looked at by git, so on top of
   * .gitignore + FileExclusionHelper they also skip dependency/build dirs, a root
   * `output/` dir (`--output-file` targets), secret-looking names, binaries and big files.
   */
  private untrackedSkipReason(file: string): string | null {
    const segments = file.split('/');
    const dirSegments = segments.slice(0, -1);
    const base = segments[segments.length - 1];
    if (
      dirSegments.some(seg => UNTRACKED_EXCLUDED_DIRS.has(seg)) ||
      (segments.length > 1 && segments[0] === 'output')
    ) {
      return 'dependency/build/output dir';
    }
    if (
      base === '.env' ||
      base.startsWith('.env.') ||
      base.endsWith('.pem') ||
      base.endsWith('.key') ||
      SECRET_FILE_NAMES.has(base)
    ) {
      return 'secret-looking name';
    }
    try {
      const filePath = path.join(this.cwd, file);
      const stats = fs.lstatSync(filePath);
      if (!stats.isFile()) return 'not a regular file';
      if (stats.size > MAX_UNTRACKED_FILE_SIZE) return 'too large';
      const fd = fs.openSync(filePath, 'r');
      try {
        const head = Buffer.alloc(Math.min(stats.size, 8000));
        fs.readSync(fd, head, 0, head.length, 0);
        if (head.includes(0)) return 'binary';
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      return 'unreadable';
    }
    return null;
  }

  /**
   * List the working-tree changes, split into tracked (staged/unstaged edits, deletes,
   * renames, staged new files) and untracked files. Visor-owned paths are dropped from
   * both; untracked files are additionally screened by untrackedSkipReason().
   */
  private async listWorkingTreeChanges(
    includeUntracked: boolean,
    outputFile?: string
  ): Promise<{ tracked: WorkingTreeEntry[]; untracked: WorkingTreeEntry[] }> {
    const status = await this.git.status();
    const isVisorOwned = this.visorOwnedMatcher(outputFile);
    const skipped = new Map<string, number>();
    const skip = (reason: string) => skipped.set(reason, (skipped.get(reason) || 0) + 1);
    const keep = (file: string): boolean => {
      if (isVisorOwned(file)) {
        skip('Visor state/output');
        return false;
      }
      // FileExclusionHelper uses .gitignore patterns + common build-artifact dirs
      if (this.fileExclusionHelper.shouldExcludeFile(file)) {
        console.error(`⏭️  Skipping excluded file: ${file}`);
        return false;
      }
      return true;
    };

    const tracked: WorkingTreeEntry[] = [
      ...status.created.map(f => ({ file: f, status: 'added' as const })),
      ...status.deleted.map(f => ({ file: f, status: 'removed' as const })),
      ...status.modified.map(f => ({ file: f, status: 'modified' as const })),
      ...status.renamed.map(f => ({
        file: typeof f === 'string' ? f : f.to || f.from,
        status: 'renamed' as const,
      })),
    ].filter(entry => keep(entry.file));

    const untracked: WorkingTreeEntry[] = [];
    if (includeUntracked) {
      for (const file of status.not_added || []) {
        if (!keep(file)) continue;
        const reason = this.untrackedSkipReason(file);
        if (reason) {
          skip(reason);
          continue;
        }
        untracked.push({ file, status: 'added' });
      }
    }

    if (skipped.size > 0) {
      const total = [...skipped.values()].reduce((a, b) => a + b, 0);
      const detail = [...skipped.entries()].map(([reason, n]) => `${n} ${reason}`).join(', ');
      console.error(`⏭️  Not reviewing ${total} working-tree file(s): ${detail}`);
    }
    return { tracked, untracked };
  }

  private async analyzeWorkingTreeEntries(
    entries: WorkingTreeEntry[],
    includeContext: boolean
  ): Promise<GitFileChange[]> {
    const changes: GitFileChange[] = [];
    for (const { file, status } of entries) {
      const filePath = path.join(this.cwd, file);
      changes.push(await this.analyzeFileChange(file, status, filePath, includeContext));
    }
    return changes;
  }

  /**
   * Get diff between current branch and base branch (for feature branch analysis)
   */
  /**
   * Resolve the base branch ref to a revision that exists locally.
   * In CI (shallow clones), the local branch may not exist, so we try:
   *   1. The branch name as-is (e.g. "main")
   *   2. The remote-tracking ref (e.g. "origin/main")
   *   3. Fetch from origin then retry
   */
  private async resolveBaseBranchRef(baseBranch: string): Promise<string> {
    // 1. Try the branch name directly
    try {
      await this.git.revparse([baseBranch]);
      return baseBranch;
    } catch {
      // Not available locally
    }

    // 2. Try origin/<baseBranch>
    const remoteBranch = `origin/${baseBranch}`;
    try {
      await this.git.revparse([remoteBranch]);
      return remoteBranch;
    } catch {
      // Not available either
    }

    // 3. Fetch from origin and retry
    try {
      await this.git.fetch(['origin', baseBranch]);
      // After fetching, origin/<baseBranch> should exist
      await this.git.revparse([remoteBranch]);
      return remoteBranch;
    } catch {
      // Fetch failed — fall back to the original name and let the caller handle the error
      return baseBranch;
    }
  }

  private async getBranchDiff(
    baseBranch: string,
    includeContext: boolean = true,
    outputFile?: string
  ): Promise<GitFileChange[]> {
    try {
      // Resolve the base branch to an available local ref (handles CI shallow clones)
      const resolvedBase = await this.resolveBaseBranchRef(baseBranch);
      if (resolvedBase !== baseBranch) {
        console.error(`📎 Resolved base branch: ${baseBranch} → ${resolvedBase}`);
      }

      // Get the list of changed files between base and current branch
      const diffSummary = await this.git.diffSummary([resolvedBase]);
      const changes: GitFileChange[] = [];

      if (!diffSummary || !diffSummary.files) {
        return [];
      }

      const isVisorOwned = this.visorOwnedMatcher(outputFile);
      for (const file of diffSummary.files) {
        if (isVisorOwned(file.file)) {
          console.error(`⏭️  Skipping Visor state/output file: ${file.file}`);
          continue;
        }
        // Skip files that should be excluded from analysis
        // FileExclusionHelper uses .gitignore patterns, which is sufficient
        if (this.fileExclusionHelper.shouldExcludeFile(file.file)) {
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
            const rawPatch = await this.git.diff([resolvedBase, '--', file.file]);
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

  private generateTitle(
    status: import('simple-git').StatusResult,
    branch: string,
    untrackedReviewed: number = 0
  ): string {
    if (status.files.length === 0) {
      return `Local Analysis: ${branch} (No changes)`;
    }

    const changeTypes = [];
    if (status.created.length > 0) changeTypes.push(`${status.created.length} added`);
    if (status.modified.length > 0) changeTypes.push(`${status.modified.length} modified`);
    if (status.deleted.length > 0) changeTypes.push(`${status.deleted.length} deleted`);
    if (status.renamed.length > 0) changeTypes.push(`${status.renamed.length} renamed`);
    if (untrackedReviewed > 0) changeTypes.push(`${untrackedReviewed} untracked`);

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
