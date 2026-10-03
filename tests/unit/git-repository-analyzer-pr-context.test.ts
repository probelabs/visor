/**
 * CLI-mode PR context: --pr-title / --pr-body / --pr-body-file / --base-branch.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import {
  GitRepositoryAnalyzer,
  applyPrContextOverrides,
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

const baseInfo: GitRepositoryInfo = {
  title: 'Local Analysis: feature (No changes)',
  body: 'Analysis of local git repository working directory.',
  author: 'someone',
  base: 'main',
  head: 'feature',
  files: [],
  totalAdditions: 0,
  totalDeletions: 0,
  isGitRepository: true,
  workingDirectory: '/tmp',
};

describe('applyPrContextOverrides', () => {
  it('keeps generated values when nothing is supplied', () => {
    expect(applyPrContextOverrides(baseInfo, {})).toEqual(baseInfo);
  });

  it('overrides title and body from inline values', () => {
    const out = applyPrContextOverrides(baseInfo, { prTitle: 'Fix X', prBody: 'Because Y' });
    expect(out.title).toBe('Fix X');
    expect(out.body).toBe('Because Y');
    expect(out.files).toBe(baseInfo.files);
  });

  it('reads the body verbatim from --pr-body-file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-pr-body-'));
    try {
      const file = path.join(dir, 'body.md');
      fs.writeFileSync(file, '## Summary\n\nMultiline <b>body</b>\n');
      const out = applyPrContextOverrides(baseInfo, { prBodyFile: file });
      expect(out.body).toBe('## Summary\n\nMultiline <b>body</b>\n');
      expect(out.title).toBe(baseInfo.title);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects --pr-body together with --pr-body-file, and unreadable files', () => {
    expect(() => applyPrContextOverrides(baseInfo, { prBody: 'a', prBodyFile: '/x' })).toThrow(
      /mutually exclusive/
    );
    expect(() =>
      applyPrContextOverrides(baseInfo, { prBodyFile: '/nonexistent/visor/body.md' })
    ).toThrow(/Cannot read --pr-body-file/);
  });

  it('flows into PRInfo (what prompts see as pr.title / pr.description)', () => {
    const analyzer = new GitRepositoryAnalyzer(os.tmpdir());
    const pr = analyzer.toPRInfo(
      applyPrContextOverrides(baseInfo, { prTitle: 'T', prBody: 'B' }),
      false
    );
    expect(pr.title).toBe('T');
    expect(pr.body).toBe('B');
  });
});

describe('GitRepositoryAnalyzer --base-branch (real git)', () => {
  let repo: string;

  beforeEach(() => {
    repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'visor-base-branch-')));
    git(repo, 'init', '--quiet', '-b', 'main');
    git(repo, 'config', 'user.email', 'visor-test@example.invalid');
    git(repo, 'config', 'user.name', 'Visor test');
    commitFile(repo, 'base.txt', 'base\n');
    git(repo, 'checkout', '--quiet', '-b', 'release');
    commitFile(repo, 'release-only.txt', 'release\n');
    git(repo, 'checkout', '--quiet', '-b', 'feature');
    commitFile(repo, 'feature.txt', 'feature\n');
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  it('defaults to main and includes commits that are only on the release branch', async () => {
    const info = await new GitRepositoryAnalyzer(repo).analyzeRepository(true, true);
    expect(info.base).toBe('main');
    expect(info.files.map(f => f.filename).sort()).toEqual(['feature.txt', 'release-only.txt']);
  });

  it('diffs against the explicit base branch when given', async () => {
    const info = await new GitRepositoryAnalyzer(repo).analyzeRepository(true, true, {
      baseBranch: 'release',
    });
    expect(info.base).toBe('release');
    expect(info.head).toBe('feature');
    expect(info.files.map(f => f.filename)).toEqual(['feature.txt']);
  });

  it('treats a head branch named main as a feature branch when a base is explicit', async () => {
    git(repo, 'checkout', '--quiet', 'main');
    commitFile(repo, 'hotfix.txt', 'hotfix\n');
    const info = await new GitRepositoryAnalyzer(repo).analyzeRepository(true, true, {
      baseBranch: 'release',
    });
    expect(info.head).toBe('main');
    expect(info.files.map(f => f.filename)).toContain('hotfix.txt');
  });
});

describe('CLI parsing of PR context flags', () => {
  it('parses --pr-title, --pr-body-file and --base-branch', () => {
    const opts = new CLI().parseArgs([
      'node',
      'visor',
      '--pr-title',
      'Fix the thing',
      '--pr-body-file',
      '/tmp/body.md',
      '--base-branch',
      'release/1.2',
    ]);
    expect(opts.prTitle).toBe('Fix the thing');
    expect(opts.prBodyFile).toBe('/tmp/body.md');
    expect(opts.prBody).toBeUndefined();
    expect(opts.baseBranch).toBe('release/1.2');
  });

  it('lists the new flags in help', () => {
    const help = new CLI().getHelpText();
    for (const flag of ['--pr-title', '--pr-body', '--pr-body-file', '--base-branch']) {
      expect(help).toContain(flag);
    }
  });
});
