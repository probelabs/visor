/**
 * Local CLI review: which change set is reviewed — uncommitted work vs the branch diff.
 *
 * Only an EXPLICIT --analyze-branch-diff forces the branch diff over uncommitted
 * changes. When branch diff is merely auto-enabled (code-review schema), uncommitted
 * changes win and the branch diff is only the clean-tree fallback. --uncommitted
 * always reviews the working tree (staged, unstaged and untracked files).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  GitRepositoryAnalyzer,
  resolveLocalDiffSelection,
  type GitRepositoryInfo,
} from '../../src/git-repository-analyzer';
import { CLI } from '../../src/cli';

// tests/setup.ts stubs child_process.spawn globally; simple-git needs the real one here.
jest.mock('child_process', () => jest.requireActual('child_process'));

jest.setTimeout(30_000);

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
}

function commitFile(repo: string, name: string, content: string): void {
  fs.writeFileSync(path.join(repo, name), content);
  git(repo, 'add', name);
  git(repo, 'commit', '--quiet', '-m', `add ${name}`);
}

function names(info: GitRepositoryInfo): string[] {
  return info.files.map(f => f.filename).sort();
}

/** Run the analyzer the way cli-main does for the given flags. */
async function review(
  repo: string,
  flags: { analyzeBranchDiff?: boolean; uncommitted?: boolean },
  hasCodeReviewSchema = true
): Promise<{ info: GitRepositoryInfo; log: string }> {
  const { enableBranchDiff, diffMode } = resolveLocalDiffSelection({
    ...flags,
    hasCodeReviewSchema,
  });
  const lines: string[] = [];
  const spy = jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  try {
    const info = await new GitRepositoryAnalyzer(repo).analyzeRepository(true, enableBranchDiff, {
      diffMode,
    });
    return { info, log: lines.join('\n') };
  } finally {
    spy.mockRestore();
  }
}

describe('local review diff selection (real git)', () => {
  let repo: string;

  beforeEach(() => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'visor-diff-mode-')));
    git(repo, 'init', '--quiet', '-b', 'main');
    git(repo, 'config', 'user.email', 'visor-test@example.invalid');
    git(repo, 'config', 'user.name', 'Visor test');
    commitFile(repo, 'base.txt', 'base\n');
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  function featureBranchWithWork(): void {
    git(repo, 'checkout', '--quiet', '-b', 'feat/x');
    commitFile(repo, 'committed.txt', 'committed on the branch\n');
    // Uncommitted work: one unstaged edit, one staged new file, one untracked file.
    fs.writeFileSync(path.join(repo, 'base.txt'), 'base\nedited\n');
    fs.writeFileSync(path.join(repo, 'staged.txt'), 'staged\n');
    git(repo, 'add', 'staged.txt');
    fs.writeFileSync(path.join(repo, 'untracked.txt'), 'untracked\n');
  }

  it('feature branch + uncommitted changes, branch diff auto-enabled -> reviews the uncommitted changes', async () => {
    featureBranchWithWork();
    const { info, log } = await review(repo, {});
    expect(info.diffSource).toBe('uncommitted');
    expect(names(info)).toEqual(['base.txt', 'staged.txt', 'untracked.txt']);
    expect(log).toContain('auto: uncommitted changes present');
    expect(log).not.toContain('forced by --analyze-branch-diff');
    expect(log).not.toContain('Ignoring');
  });

  it('feature branch + clean working tree, branch diff auto-enabled -> falls back to the branch diff', async () => {
    git(repo, 'checkout', '--quiet', '-b', 'feat/x');
    commitFile(repo, 'committed.txt', 'committed on the branch\n');
    const { info, log } = await review(repo, {});
    expect(info.diffSource).toBe('branch');
    expect(info.base).toBe('main');
    expect(names(info)).toEqual(['committed.txt']);
    expect(log).toContain('auto: clean working tree on a feature branch');
    expect(log).not.toContain('forced by --analyze-branch-diff');
  });

  it('feature branch + uncommitted, no code-review schema -> reviews the uncommitted changes', async () => {
    featureBranchWithWork();
    const { info } = await review(repo, {}, false);
    expect(info.diffSource).toBe('uncommitted');
    expect(names(info)).toEqual(['base.txt', 'staged.txt', 'untracked.txt']);
  });

  it('explicit --analyze-branch-diff -> reviews the branch diff even with uncommitted changes', async () => {
    featureBranchWithWork();
    const { info, log } = await review(repo, { analyzeBranchDiff: true });
    expect(info.diffSource).toBe('branch');
    // `git diff <base>` compares against the working tree, so tracked edits ride along;
    // untracked files are not part of a branch diff.
    expect(names(info)).toEqual(['base.txt', 'committed.txt', 'staged.txt']);
    expect(log).toContain('forced by --analyze-branch-diff');
    expect(log).toContain('Ignoring 3 uncommitted file(s)');
  });

  it('explicit --analyze-branch-diff on a clean feature branch says it was forced', async () => {
    git(repo, 'checkout', '--quiet', '-b', 'feat/x');
    commitFile(repo, 'committed.txt', 'committed on the branch\n');
    const { info, log } = await review(repo, { analyzeBranchDiff: true }, false);
    expect(info.diffSource).toBe('branch');
    expect(names(info)).toEqual(['committed.txt']);
    expect(log).toContain('forced by --analyze-branch-diff');
  });

  it('--uncommitted on a feature branch -> only the uncommitted changes, untracked included', async () => {
    featureBranchWithWork();
    const { info, log } = await review(repo, { uncommitted: true });
    expect(info.diffSource).toBe('uncommitted');
    expect(names(info)).toEqual(['base.txt', 'staged.txt', 'untracked.txt']);
    expect(info.files.find(f => f.filename === 'untracked.txt')).toMatchObject({
      status: 'added',
      patch: 'untracked\n',
    });
    expect(log).toContain('forced by --uncommitted');
  });

  it('--uncommitted on a clean feature branch -> nothing to review (no branch-diff fallback)', async () => {
    git(repo, 'checkout', '--quiet', '-b', 'feat/x');
    commitFile(repo, 'committed.txt', 'committed on the branch\n');
    const { info, log } = await review(repo, { uncommitted: true });
    expect(info.diffSource).toBe('uncommitted');
    expect(info.files).toEqual([]);
    expect(log).toContain('No uncommitted changes to analyze');
  });

  it('--uncommitted on main -> only the uncommitted changes, untracked included', async () => {
    fs.writeFileSync(path.join(repo, 'base.txt'), 'base\nedited on main\n');
    fs.writeFileSync(path.join(repo, 'new-on-main.txt'), 'new\n');
    const { info, log } = await review(repo, { uncommitted: true });
    expect(info.head).toBe('main');
    expect(info.diffSource).toBe('uncommitted');
    expect(names(info)).toEqual(['base.txt', 'new-on-main.txt']);
    expect(log).toContain('forced by --uncommitted');
  });

  it("never reviews Visor's own untracked run traces", async () => {
    fs.mkdirSync(path.join(repo, 'output', 'traces'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'output', 'traces', 'run-1.ndjson'), '{}\n');
    fs.writeFileSync(path.join(repo, 'output', 'notes.md'), 'mine\n');
    const { info, log } = await review(repo, { uncommitted: true });
    expect(names(info)).toEqual(['output/notes.md']);
    expect(log).toContain('Skipping 1 untracked Visor trace file(s) in output/traces');
  });

  it('leaves .gitignore-d untracked files out', async () => {
    fs.writeFileSync(path.join(repo, '.gitignore'), 'ignored.log\n');
    fs.writeFileSync(path.join(repo, 'ignored.log'), 'noise\n');
    const { info } = await review(repo, { uncommitted: true });
    expect(names(info)).toEqual(['.gitignore']);
  });
});

describe('resolveLocalDiffSelection', () => {
  it('maps flags to analyzer inputs', () => {
    expect(resolveLocalDiffSelection({ hasCodeReviewSchema: true })).toEqual({
      enableBranchDiff: true,
      diffMode: 'auto',
    });
    expect(resolveLocalDiffSelection({ hasCodeReviewSchema: false })).toEqual({
      enableBranchDiff: false,
      diffMode: 'auto',
    });
    expect(
      resolveLocalDiffSelection({ analyzeBranchDiff: true, hasCodeReviewSchema: false })
    ).toEqual({ enableBranchDiff: true, diffMode: 'branch' });
    expect(resolveLocalDiffSelection({ uncommitted: true, hasCodeReviewSchema: true })).toEqual({
      enableBranchDiff: false,
      diffMode: 'uncommitted',
    });
    expect(
      resolveLocalDiffSelection({
        analyzeBranchDiff: true,
        hasCodeReviewSchema: true,
        debugServer: true,
      })
    ).toEqual({ enableBranchDiff: false, diffMode: 'auto' });
  });

  it('rejects --uncommitted together with --analyze-branch-diff', () => {
    expect(() =>
      resolveLocalDiffSelection({
        analyzeBranchDiff: true,
        uncommitted: true,
        hasCodeReviewSchema: true,
      })
    ).toThrow(/mutually exclusive/);
  });
});

describe('CLI parsing of --uncommitted / --analyze-branch-diff', () => {
  it('parses --uncommitted', () => {
    const opts = new CLI().parseArgs(['node', 'visor', '--uncommitted']);
    expect(opts.uncommitted).toBe(true);
    expect(opts.analyzeBranchDiff).toBeFalsy();
  });

  it('defaults --uncommitted to false', () => {
    expect(new CLI().parseArgs(['node', 'visor']).uncommitted).toBe(false);
  });

  it('errors out when both flags are given', () => {
    expect(() =>
      new CLI().parseArgs(['node', 'visor', '--uncommitted', '--analyze-branch-diff'])
    ).toThrow(/--uncommitted and --analyze-branch-diff are mutually exclusive/);
  });

  it('documents both flags in --help', () => {
    const help = new CLI().getHelpText();
    expect(help).toContain('--uncommitted');
    expect(help).toContain('--analyze-branch-diff');
  });
});
