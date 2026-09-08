import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync } from 'child_process';
import { pathToFileURL } from 'url';
import { WorktreeManager } from '../../src/utils/worktree-manager';

jest.setTimeout(30_000);

function createCommittedRepository(
  requestedRoot?: string
): { root: string; commit: string; cleanup: () => void } {
  const root = requestedRoot || fs.mkdtempSync(path.join(os.tmpdir(), 'visor-local-source-'));
  fs.mkdirSync(root, { recursive: true });
  execFileSync('git', ['init', '--quiet', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'visor-test@example.invalid']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Visor test']);
  fs.writeFileSync(path.join(root, 'proof-baseline.txt'), 'native baseline\n');
  execFileSync('git', ['-C', root, 'add', 'proof-baseline.txt']);
  execFileSync('git', ['-C', root, 'commit', '--quiet', '-m', 'native baseline']);
  const commit = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], {
    encoding: 'utf8',
  }).trim();

  return {
    root,
    commit,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

describe('WorktreeManager local sources and persistence', () => {
  let manager: WorktreeManager;
  let basePath: string;

  beforeEach(() => {
    manager = WorktreeManager.getInstance();
    basePath = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-managed-worktrees-'));
    manager.configure({
      enabled: true,
      base_path: basePath,
      cleanup_on_exit: true,
      max_age_hours: 24,
    });
  });

  afterEach(() => {
    fs.rmSync(basePath, { recursive: true, force: true });
  });

  it('checks out a committed absolute or file URL source without a network remote', async () => {
    const source = createCommittedRepository();
    try {
      const absoluteUrl = manager.getRepositoryUrl(source.root);
      const fileUrl = manager.getRepositoryUrl(pathToFileURL(source.root).toString());
      expect(absoluteUrl).toBe(fs.realpathSync(source.root));
      expect(fileUrl).toBe(fs.realpathSync(source.root));

      const worktree = await manager.createWorktree(
        source.root,
        fileUrl,
        'main',
        { sessionId: 'local-proof', persistWorktree: true }
      );

      expect(worktree.metadata.repository).toBe(fs.realpathSync(source.root));
      expect(worktree.metadata.commit).toBe(source.commit);
      expect(worktree.metadata.cleanup_on_exit).toBe(false);
      expect(fs.readFileSync(path.join(worktree.path, 'proof-baseline.txt'), 'utf8')).toBe(
        'native baseline\n'
      );

      await manager.removeWorktree(worktree.id);
    } finally {
      source.cleanup();
    }
  });

  it('separates explicit working directories for the same repo/ref/session', async () => {
    const source = createCommittedRepository();
    const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-rendered-targets-'));
    const targetA = path.join(targetRoot, 'component-a');
    const targetB = path.join(targetRoot, 'component-b');
    try {
      const repoUrl = manager.getRepositoryUrl(source.root);
      const first = await manager.createWorktree(source.root, repoUrl, 'main', {
        sessionId: 'same-session',
        workingDirectory: targetA,
      });
      const reused = await manager.createWorktree(source.root, repoUrl, 'main', {
        sessionId: 'same-session',
        workingDirectory: targetA,
      });
      const second = await manager.createWorktree(source.root, repoUrl, 'main', {
        sessionId: 'same-session',
        workingDirectory: targetB,
      });

      expect(first.id).not.toBe(second.id);
      expect(reused.id).toBe(first.id);
      expect(reused.path).toBe(first.path);
      expect(first.path).toBe(
        fs.realpathSync(path.dirname(targetA)) + path.sep + path.basename(targetA)
      );
      expect(second.path).toBe(
        fs.realpathSync(path.dirname(targetB)) + path.sep + path.basename(targetB)
      );
      expect(fs.existsSync(path.join(first.path, 'proof-baseline.txt'))).toBe(true);
      expect(fs.existsSync(path.join(second.path, 'proof-baseline.txt'))).toBe(true);

      await manager.removeWorktree(first.id);
      expect(fs.existsSync(second.path)).toBe(true);
      await manager.removeWorktree(second.id);
    } finally {
      fs.rmSync(targetRoot, { recursive: true, force: true });
      source.cleanup();
    }
  });

  it('rejects an unowned explicit directory without deleting its sentinel', async () => {
    const source = createCommittedRepository();
    const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-owned-target-'));
    const sentinel = path.join(targetRoot, 'do-not-delete.txt');
    fs.writeFileSync(sentinel, 'caller-owned\n');
    try {
      await expect(
        manager.createWorktree(source.root, manager.getRepositoryUrl(source.root), 'main', {
          workingDirectory: targetRoot,
        })
      ).rejects.toThrow(/without manager metadata/);
      expect(fs.readFileSync(sentinel, 'utf8')).toBe('caller-owned\n');

      fs.writeFileSync(
        `${targetRoot}.metadata.json`,
        JSON.stringify({
          worktree_id: 'not-this-worktree',
          worktree_path: targetRoot,
          repository: source.root,
          ref: 'main',
          bare_repo_path: path.join(basePath, 'repos', 'not-this-repo.git'),
        })
      );
      await expect(
        manager.createWorktree(source.root, manager.getRepositoryUrl(source.root), 'main', {
          workingDirectory: targetRoot,
        })
      ).rejects.toThrow(/mismatched manager metadata/);
      expect(fs.readFileSync(sentinel, 'utf8')).toBe('caller-owned\n');
    } finally {
      fs.rmSync(targetRoot, { recursive: true, force: true });
      fs.rmSync(`${targetRoot}.metadata.json`, { force: true });
      source.cleanup();
    }
  });

  it('uses bounded collision-resistant cache names for long local paths', async () => {
    const parentA = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-local-a-'));
    const parentB = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-local-b-'));
    const rootA = path.join(parentA, 'a'.repeat(180));
    const rootB = path.join(parentB, 'b'.repeat(180));
    const first = createCommittedRepository(rootA);
    const second = createCommittedRepository(rootB);
    try {
      await manager.createWorktree(first.root, manager.getRepositoryUrl(first.root), 'main');
      await manager.createWorktree(second.root, manager.getRepositoryUrl(second.root), 'main');
      const cacheNames = fs
        .readdirSync(path.join(basePath, 'repos'))
        .filter(name => name.endsWith('.git'));
      expect(cacheNames).toHaveLength(2);
      expect(new Set(cacheNames).size).toBe(2);
      expect(cacheNames.every(name => name.length < 128)).toBe(true);
    } finally {
      fs.rmSync(parentA, { recursive: true, force: true });
      fs.rmSync(parentB, { recursive: true, force: true });
      first.cleanup();
      second.cleanup();
    }
  });

  it('updates reused metadata and excludes persisted worktrees from stale cleanup', async () => {
    const source = createCommittedRepository();
    try {
      const repoUrl = manager.getRepositoryUrl(source.root);
      const first = await manager.createWorktree(source.root, repoUrl, 'main', {
        sessionId: 'persist-session',
      });
      const reused = await manager.createWorktree(source.root, repoUrl, 'main', {
        sessionId: 'persist-session',
        persistWorktree: true,
      });

      expect(reused.id).toBe(first.id);
      expect(reused.metadata.cleanup_on_exit).toBe(false);

      const metadataPath = `${reused.path}.metadata.json`;
      const metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
      metadata.created_at = new Date(0).toISOString();
      fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

      await manager.cleanupStaleWorktrees();
      expect(fs.existsSync(reused.path)).toBe(true);

      await manager.removeWorktree(reused.id);
    } finally {
      source.cleanup();
    }
  });
});
