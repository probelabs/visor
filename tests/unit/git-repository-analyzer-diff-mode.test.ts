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
  flags: { analyzeBranchDiff?: boolean; uncommitted?: boolean; outputFile?: string },
  hasCodeReviewSchema = true
): Promise<{ info: GitRepositoryInfo; log: string }> {
  const { enableBranchDiff, diffMode } = resolveLocalDiffSelection({
    analyzeBranchDiff: flags.analyzeBranchDiff,
    uncommitted: flags.uncommitted,
    hasCodeReviewSchema,
  });
  return capture(() =>
    new GitRepositoryAnalyzer(repo).analyzeRepository(true, enableBranchDiff, {
      diffMode,
      includeUntracked: true,
      outputFile: flags.outputFile,
    })
  );
}

async function capture(
  run: () => Promise<GitRepositoryInfo>
): Promise<{ info: GitRepositoryInfo; log: string }> {
  const lines: string[] = [];
  const spy = jest.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  });
  try {
    const info = await run();
    return { info, log: lines.join('\n') };
  } finally {
    spy.mockRestore();
  }
}

function patchText(info: GitRepositoryInfo): string {
  return info.files.map(f => `${f.patch || ''}${f.content || ''}`).join('\n');
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
    expect(log).toContain('auto: tracked uncommitted changes present');
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
    expect(log).toContain('auto: no tracked uncommitted changes on a feature branch');
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
    // Only the untracked file is left out; tracked edits are still in the branch diff.
    expect(log).toContain('Not including 1 untracked file(s)');
    expect(log).not.toContain('Ignoring');
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

  it("never reviews Visor's own untracked run traces or a root output/ dir", async () => {
    fs.mkdirSync(path.join(repo, 'output', 'traces'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'output', 'traces', 'run-1.ndjson'), '{}\n');
    fs.writeFileSync(path.join(repo, 'output', 'review.md'), 'previous --output-file\n');
    fs.mkdirSync(path.join(repo, 'docs', 'output'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'docs', 'output', 'notes.md'), 'mine\n');
    const { info, log } = await review(repo, { uncommitted: true });
    expect(names(info)).toEqual(['docs/output/notes.md']);
    expect(log).toContain('1 Visor state/output');
    expect(log).toContain('1 dependency/build/output dir');
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

/**
 * Round-2 review repros (PR #607): Visor-owned files, untracked-only dirt, secrets and
 * binaries, and the legacy boolean `enableBranchDiff` contract.
 */
describe('round-2 review repros (real git)', () => {
  let repo: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'visor-diff-mode-r2-')));
    git(repo, 'init', '--quiet', '-b', 'main');
    git(repo, 'config', 'user.email', 'visor-test@example.invalid');
    git(repo, 'config', 'user.name', 'Visor test');
    commitFile(repo, 'base.txt', 'base\n');
    delete process.env.VISOR_TRACE_DIR;
    delete process.env.VISOR_FALLBACK_TRACE_FILE;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    fs.rmSync(repo, { recursive: true, force: true });
  });

  function cleanFeatureBranch(): void {
    git(repo, 'checkout', '--quiet', '-b', 'feat/x');
    commitFile(repo, 'committed.txt', 'committed on the branch\n');
  }

  function plantVisorSnapshot(): void {
    fs.mkdirSync(path.join(repo, '.visor'), { recursive: true });
    fs.writeFileSync(path.join(repo, '.visor', 'config.db'), 'api_key: sk-secret\n');
    fs.writeFileSync(path.join(repo, '.visor', 'config.db-wal'), 'api_key: sk-secret\n');
  }

  it('P0: .visor/config.db (+wal) on a clean feature branch keeps the branch diff', async () => {
    cleanFeatureBranch();
    plantVisorSnapshot();
    const { info } = await review(repo, {});
    expect(info.diffSource).toBe('branch');
    expect(names(info)).toEqual(['committed.txt']);
    expect(patchText(info)).not.toContain('sk-secret');
  });

  it('P0: .visor/ on a clean main is still "no changes", even with --uncommitted', async () => {
    plantVisorSnapshot();
    expect((await review(repo, {})).info.files).toEqual([]);
    const { info } = await review(repo, { uncommitted: true });
    expect(info.files).toEqual([]);
  });

  it('P0: Visor-owned paths are dropped even when they are tracked', async () => {
    plantVisorSnapshot();
    git(repo, 'add', '.visor');
    git(repo, 'commit', '--quiet', '-m', 'oops, committed visor state');
    fs.writeFileSync(path.join(repo, '.visor', 'config.db'), 'api_key: sk-changed\n');
    cleanFeatureBranch();
    const { info } = await review(repo, {});
    expect(info.diffSource).toBe('branch');
    expect(names(info)).toEqual(['committed.txt']);
  });

  it('P0: the fallback trace file dir is Visor-owned, but never the repo root', async () => {
    fs.mkdirSync(path.join(repo, 'e2e-traces'));
    fs.writeFileSync(path.join(repo, 'e2e-traces', 'fallback.ndjson'), '{}\n');
    fs.writeFileSync(path.join(repo, 'mine.txt'), 'mine\n');
    process.env.VISOR_FALLBACK_TRACE_FILE = path.join(repo, 'e2e-traces', 'fallback.ndjson');
    expect(names((await review(repo, { uncommitted: true })).info)).toEqual(['mine.txt']);
    process.env.VISOR_FALLBACK_TRACE_FILE = 'root-fallback.ndjson';
    fs.writeFileSync(path.join(repo, 'root-fallback.ndjson'), '{}\n');
    expect(names((await review(repo, { uncommitted: true })).info)).toEqual([
      'e2e-traces/fallback.ndjson',
      'mine.txt',
    ]);
  });

  it("P0: this run's --output-file is never reviewed", async () => {
    fs.writeFileSync(path.join(repo, 'review.md'), 'last run output\n');
    fs.writeFileSync(path.join(repo, 'mine.txt'), 'mine\n');
    const { info } = await review(repo, { uncommitted: true, outputFile: 'review.md' });
    expect(names(info)).toEqual(['mine.txt']);
  });

  it('P1: untracked-only dirt does not turn off the auto branch-diff fallback', async () => {
    cleanFeatureBranch();
    fs.writeFileSync(path.join(repo, 'notes.txt'), 'scratch\n');
    const { info, log } = await review(repo, {});
    expect(info.diffSource).toBe('branch');
    expect(names(info)).toEqual(['committed.txt']);
    expect(log).toContain('auto: no tracked uncommitted changes');
  });

  it('P1: an untracked .env neither replaces the branch diff nor reaches the prompt', async () => {
    cleanFeatureBranch();
    fs.writeFileSync(path.join(repo, '.env'), 'OPENAI_API_KEY=sk-live-secret\n');
    const auto = await review(repo, {});
    expect(auto.info.diffSource).toBe('branch');
    expect(names(auto.info)).toEqual(['committed.txt']);
    const forced = await review(repo, { uncommitted: true });
    expect(forced.info.files).toEqual([]);
    expect(patchText(forced.info)).not.toContain('sk-live-secret');
    expect(forced.log).toContain('1 secret-looking name');
  });

  it('P1: secret names, NUL binaries, big files and dependency dirs are skipped; real work stays', async () => {
    fs.writeFileSync(path.join(repo, 'base.txt'), 'base\nedited\n');
    const untracked: Record<string, string | Buffer> = {
      '.env.local': 'TOKEN=x\n',
      'server.pem': '-----BEGIN PRIVATE KEY-----\n',
      'deploy.key': 'k\n',
      id_rsa: 'k\n',
      'credentials.json': '{}\n',
      'blob.bin': Buffer.from([0x50, 0x4b, 0x00, 0x01]),
      'big.txt': 'x'.repeat(2 * 1024 * 1024),
      'vendor/lib.js': 'vendored\n',
      '.venv/lib/site.py': 'x = 1\n',
      'target/debug/out.txt': 'x\n',
      'pkg/__pycache__/m.pyc': 'x\n',
      'src/new.ts': 'export const x = 1;\n',
    };
    for (const [name, body] of Object.entries(untracked)) {
      fs.mkdirSync(path.dirname(path.join(repo, name)), { recursive: true });
      fs.writeFileSync(path.join(repo, name), body);
    }
    const { info } = await review(repo, {});
    expect(info.diffSource).toBe('uncommitted');
    expect(names(info)).toEqual(['base.txt', 'src/new.ts']);
  });

  it('P1: analyzeRepository(_, true) without diffMode still forces the branch diff', async () => {
    cleanFeatureBranch();
    fs.writeFileSync(path.join(repo, 'base.txt'), 'base\nedited\n');
    fs.writeFileSync(path.join(repo, 'notes.txt'), 'scratch\n');
    const { info } = await capture(() =>
      new GitRepositoryAnalyzer(repo).analyzeRepository(true, true)
    );
    expect(info.diffSource).toBe('branch');
    expect(names(info)).toEqual(['base.txt', 'committed.txt']);
  });

  it('P1: default callers (SDK/bots/scheduler) keep the tracked-only file set', async () => {
    cleanFeatureBranch();
    fs.writeFileSync(path.join(repo, 'base.txt'), 'base\nedited\n');
    fs.writeFileSync(path.join(repo, 'notes.txt'), 'scratch\n');
    plantVisorSnapshot();
    const dirty = await capture(() => new GitRepositoryAnalyzer(repo).analyzeRepository());
    expect(names(dirty.info)).toEqual(['base.txt']);
    git(repo, 'checkout', '--quiet', '--', 'base.txt');
    const untrackedOnly = await capture(() => new GitRepositoryAnalyzer(repo).analyzeRepository());
    expect(untrackedOnly.info.files).toEqual([]);
  });

  it('P2: --analyze-branch-diff reports only the untracked files it leaves out', async () => {
    cleanFeatureBranch();
    fs.writeFileSync(path.join(repo, 'base.txt'), 'base\nedited\n');
    fs.writeFileSync(path.join(repo, 'notes.txt'), 'scratch\n');
    const { info, log } = await review(repo, { analyzeBranchDiff: true });
    expect(names(info)).toEqual(['base.txt', 'committed.txt']);
    expect(log).toContain('Not including 1 untracked file(s)');
    expect(log).not.toMatch(/Ignoring \d+ uncommitted/);
  });

  it('P3: --uncommitted with --debug-server is rejected instead of silently dropped', () => {
    expect(() => new CLI().parseArgs(['node', 'visor', '--uncommitted', '--debug-server'])).toThrow(
      /--uncommitted cannot be used with --debug-server/
    );
    expect(() =>
      resolveLocalDiffSelection({ uncommitted: true, debugServer: true, hasCodeReviewSchema: true })
    ).toThrow(/--debug-server/);
  });
});

/**
 * Round-3 review (PR #607): an uncommitted review must show the real uncommitted delta
 * (vs HEAD) for every tracked change, not `git diff` (worktree vs index), which is empty
 * for anything already staged, for deletions and for renames.
 */
describe('uncommitted patches are diffed against HEAD (real git)', () => {
  let repo: string;

  beforeEach(() => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'visor-diff-mode-r3-')));
    git(repo, 'init', '--quiet', '-b', 'main');
    git(repo, 'config', 'user.email', 'visor-test@example.invalid');
    git(repo, 'config', 'user.name', 'Visor test');
    commitFile(repo, 'base.txt', 'line one\nline two\nline three\n');
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  const write = (name: string, body: string) => fs.writeFileSync(path.join(repo, name), body);

  interface Scenario {
    name: string;
    act: () => void;
    filename: string;
    status: 'added' | 'removed' | 'modified' | 'renamed';
    patchHas: string[];
    additions: number;
    deletions: number;
  }

  const scenarios: Scenario[] = [
    {
      name: 'staged edit',
      act: () => {
        write('base.txt', 'line one\nline two\nline three\nstaged-edit\n');
        git(repo, 'add', 'base.txt');
      },
      filename: 'base.txt',
      status: 'modified',
      patchHas: ['+staged-edit'],
      additions: 1,
      deletions: 0,
    },
    {
      name: 'unstaged edit',
      act: () => write('base.txt', 'line one\nline 2\nline three\n'),
      filename: 'base.txt',
      status: 'modified',
      patchHas: ['-line two', '+line 2'],
      additions: 1,
      deletions: 1,
    },
    {
      name: 'staged + unstaged edit of the same file',
      act: () => {
        write('base.txt', 'line one\nline two\nline three\nstaged-hunk\n');
        git(repo, 'add', 'base.txt');
        write('base.txt', 'line one\nline two\nline three\nstaged-hunk\nunstaged-hunk\n');
      },
      filename: 'base.txt',
      status: 'modified',
      patchHas: ['+staged-hunk', '+unstaged-hunk'],
      additions: 2,
      deletions: 0,
    },
    {
      name: 'git rm',
      act: () => git(repo, 'rm', '--quiet', 'base.txt'),
      filename: 'base.txt',
      status: 'removed',
      patchHas: ['deleted file mode', '-line one', '-line two', '-line three'],
      additions: 0,
      deletions: 3,
    },
    {
      name: 'unstaged delete (rm without git)',
      act: () => fs.unlinkSync(path.join(repo, 'base.txt')),
      filename: 'base.txt',
      status: 'removed',
      patchHas: ['-line one', '-line three'],
      additions: 0,
      deletions: 3,
    },
    {
      name: 'git mv without content change',
      act: () => git(repo, 'mv', 'base.txt', 'renamed.txt'),
      filename: 'renamed.txt',
      status: 'renamed',
      patchHas: ['rename from base.txt', 'rename to renamed.txt'],
      additions: 0,
      deletions: 0,
    },
    {
      name: 'git mv with a content change',
      act: () => {
        git(repo, 'mv', 'base.txt', 'renamed.txt');
        write('renamed.txt', 'line one\nline two\nline three\nafter-rename\n');
      },
      filename: 'renamed.txt',
      status: 'renamed',
      patchHas: ['rename from base.txt', 'rename to renamed.txt', '+after-rename'],
      additions: 1,
      deletions: 0,
    },
    {
      name: 'newly staged file',
      act: () => {
        write('new.txt', 'brand new\n');
        git(repo, 'add', 'new.txt');
      },
      filename: 'new.txt',
      status: 'added',
      patchHas: ['new file mode', '+brand new'],
      additions: 1,
      deletions: 0,
    },
    {
      name: 'newly staged file edited again (AM)',
      act: () => {
        write('new.txt', 'brand new\n');
        git(repo, 'add', 'new.txt');
        write('new.txt', 'brand new\nedited after add\n');
      },
      filename: 'new.txt',
      status: 'added',
      patchHas: ['+brand new', '+edited after add'],
      additions: 2,
      deletions: 0,
    },
  ];

  function expectRealPatch(info: GitRepositoryInfo, sc: Scenario): void {
    expect(info.diffSource).toBe('uncommitted');
    // Exactly one entry for the path (no AM / RM duplicates).
    expect(info.files.map(f => f.filename)).toEqual([sc.filename]);
    const file = info.files[0];
    expect(file.status).toBe(sc.status);
    expect(file.patch).toBeTruthy();
    for (const fragment of sc.patchHas) expect(file.patch).toContain(fragment);
    expect(file.additions).toBe(sc.additions);
    expect(file.deletions).toBe(sc.deletions);
    // ...and it reaches what checks see as the PR diff.
    const pr = new GitRepositoryAnalyzer(repo).toPRInfo(info, true);
    for (const fragment of sc.patchHas) expect(pr.fullDiff).toContain(fragment);
  }

  describe.each(scenarios.map(sc => [sc.name, sc] as const))('%s', (_name, sc) => {
    it('on a code-review feature branch (auto) shows the real patch, not the branch diff', async () => {
      git(repo, 'checkout', '--quiet', '-b', 'feat/x');
      commitFile(repo, 'committed.txt', 'committed on the branch\n');
      sc.act();
      const { info } = await review(repo, {});
      expectRealPatch(info, sc);
    });

    it('with --uncommitted shows the real patch', async () => {
      git(repo, 'checkout', '--quiet', '-b', 'feat/x');
      sc.act();
      const { info } = await review(repo, { uncommitted: true });
      expectRealPatch(info, sc);
    });

    it('on main via the default analyzeRepository() (SDK/bots) shows the real patch', async () => {
      sc.act();
      const { info } = await capture(() => new GitRepositoryAnalyzer(repo).analyzeRepository());
      expectRealPatch(info, sc);
    });
  });

  it('a repo with no commits keeps the disk-read path for staged files', async () => {
    const fresh = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'visor-diff-mode-r3-0-')));
    try {
      git(fresh, 'init', '--quiet', '-b', 'main');
      fs.writeFileSync(path.join(fresh, 'first.txt'), 'first\n');
      git(fresh, 'add', 'first.txt');
      const { info } = await capture(() => new GitRepositoryAnalyzer(fresh).analyzeRepository());
      expect(info.files).toHaveLength(1);
      expect(info.files[0]).toMatchObject({
        filename: 'first.txt',
        status: 'added',
        patch: 'first\n',
      });
    } finally {
      fs.rmSync(fresh, { recursive: true, force: true });
    }
  });

  it('titles describe the reviewed set', async () => {
    write('base.txt', 'changed\n');
    git(repo, 'add', 'base.txt');
    write('new.txt', 'n\n');
    git(repo, 'add', 'new.txt');
    write('new.txt', 'n\nn2\n');
    expect((await review(repo, {})).info.title).toBe('Local Analysis: main (1 added, 1 modified)');
    git(repo, 'commit', '--quiet', '-am', 'commit');
    git(repo, 'checkout', '--quiet', '-b', 'feat/x');
    commitFile(repo, 'committed.txt', 'c\n');
    fs.mkdirSync(path.join(repo, '.visor'));
    write('.visor/config.db', 'x');
    expect((await review(repo, {})).info.title).toBe(
      'Local Analysis: feat/x (1 file(s) changed vs main)'
    );
  });
});

describe('round-3 residuals (real git)', () => {
  let repo: string;
  const savedEnv = { ...process.env };

  beforeEach(() => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'visor-diff-mode-r3r-')));
    git(repo, 'init', '--quiet', '-b', 'main');
    git(repo, 'config', 'user.email', 'visor-test@example.invalid');
    git(repo, 'config', 'user.name', 'Visor test');
    commitFile(repo, 'base.txt', 'base\n');
    delete process.env.VISOR_FALLBACK_TRACE_FILE;
  });

  afterEach(() => {
    process.env = { ...savedEnv };
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('auto branch fallback says which untracked files it leaves out', async () => {
    git(repo, 'checkout', '--quiet', '-b', 'feat/x');
    commitFile(repo, 'committed.txt', 'c\n');
    fs.writeFileSync(path.join(repo, 'notes.txt'), 'scratch\n');
    const { info, log } = await review(repo, {});
    expect(info.diffSource).toBe('branch');
    expect(log).toContain('Not including 1 untracked file(s)');
  });

  it('more secret-looking untracked names stay out of the prompt', async () => {
    fs.writeFileSync(path.join(repo, 'base.txt'), 'base\nedited\n');
    for (const name of ['.envrc', '.netrc', '.npmrc', '.pypirc', '.git-credentials']) {
      fs.writeFileSync(path.join(repo, name), 'export OPENAI_API_KEY=sk-envrc\n');
    }
    fs.mkdirSync(path.join(repo, '.aws'));
    fs.writeFileSync(path.join(repo, '.aws', 'credentials'), 'aws_secret_access_key=sk-aws\n');
    const { info } = await review(repo, {});
    expect(names(info)).toEqual(['base.txt']);
    expect(patchText(info)).not.toMatch(/sk-envrc|sk-aws/);
  });

  it('a fallback trace file in src/ drops only trace files, not the whole dir', async () => {
    fs.mkdirSync(path.join(repo, 'src'));
    fs.writeFileSync(path.join(repo, 'src', 'trace.ndjson'), '{}\n');
    fs.writeFileSync(path.join(repo, 'src', 'other-run.ndjson'), '{}\n');
    fs.writeFileSync(path.join(repo, 'src', 'feature.ts'), 'export {};\n');
    process.env.VISOR_FALLBACK_TRACE_FILE = path.join(repo, 'src', 'trace.ndjson');
    const { info } = await review(repo, { uncommitted: true });
    expect(names(info)).toEqual(['src/feature.ts']);
  });

  it('an untracked file of exactly 1MB is skipped (no empty-patch entry)', async () => {
    fs.writeFileSync(path.join(repo, 'exact.txt'), 'x'.repeat(1024 * 1024));
    fs.writeFileSync(path.join(repo, 'small.txt'), 'x\n');
    const { info } = await review(repo, { uncommitted: true });
    expect(names(info)).toEqual(['small.txt']);
  });
});
