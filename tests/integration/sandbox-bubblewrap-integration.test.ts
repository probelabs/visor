/**
 * Bubblewrap Sandbox Integration Tests
 *
 * These tests exercise real bubblewrap (bwrap) processes via SandboxManager
 * and BubblewrapSandbox. They are automatically skipped when bwrap is not
 * available (macOS, Windows, CI without bwrap installed).
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Detect bubblewrap availability (Linux only)
let hasBwrap = false;
try {
  execSync('which bwrap', { stdio: 'ignore', timeout: 5000 });
  hasBwrap = true;
} catch {}

const describeIfBwrap = hasBwrap ? describe : describe.skip;

jest.setTimeout(30000);

describeIfBwrap('Bubblewrap Sandbox Integration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-bwrap-'));

    // Init a minimal git repo
    execSync('git init', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git config user.email "test@visor.dev"', { cwd: tmpDir, stdio: 'ignore' });
    execSync('git config user.name "Visor Test"', { cwd: tmpDir, stdio: 'ignore' });
    fs.writeFileSync(path.join(tmpDir, 'README.md'), '# Test\n');
    execSync('git add . && git commit -m "init"', { cwd: tmpDir, stdio: 'ignore' });
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {}
  });

  // ──────────────────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────────────────

  function getSandboxManager(defs: Record<string, any>, repoPath: string, branch = 'main') {
    const { SandboxManager } = require('../../src/sandbox/sandbox-manager');
    return new SandboxManager(
      defs,
      repoPath,
      branch
    ) as import('../../src/sandbox/sandbox-manager').SandboxManager;
  }

  function getBubblewrapSandbox(name: string, config: any, repoPath: string) {
    const { BubblewrapSandbox } = require('../../src/sandbox/bubblewrap-sandbox');
    return new BubblewrapSandbox(
      name,
      config,
      repoPath
    ) as import('../../src/sandbox/bubblewrap-sandbox').BubblewrapSandbox;
  }

  // ──────────────────────────────────────────────────────────────
  // BubblewrapSandbox direct tests
  // ──────────────────────────────────────────────────────────────

  describe('BubblewrapSandbox.isAvailable()', () => {
    it('should return true on this system', async () => {
      const { BubblewrapSandbox } = require('../../src/sandbox/bubblewrap-sandbox');
      const available = await BubblewrapSandbox.isAvailable();
      expect(available).toBe(true);
    });
  });

  describe('basic execution', () => {
    it('should run a command and return output', async () => {
      const sandbox = getBubblewrapSandbox('test', { engine: 'bubblewrap' }, tmpDir);

      const result = await sandbox.exec({
        command: 'echo hello world',
        env: { PATH: '/usr/bin:/bin' },
        timeoutMs: 10000,
        maxBuffer: 1024 * 1024,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('hello world');
    });

    it('should propagate exit codes', async () => {
      const sandbox = getBubblewrapSandbox('test', { engine: 'bubblewrap' }, tmpDir);

      const result = await sandbox.exec({
        command: 'exit 42',
        env: { PATH: '/usr/bin:/bin' },
        timeoutMs: 10000,
        maxBuffer: 1024 * 1024,
      });

      expect(result.exitCode).toBe(42);
    });
  });

  describe('filesystem isolation', () => {
    it('should have access to /workspace (repo directory)', async () => {
      const sandbox = getBubblewrapSandbox('test', { engine: 'bubblewrap' }, tmpDir);

      const result = await sandbox.exec({
        command: 'cat /workspace/README.md',
        env: { PATH: '/usr/bin:/bin' },
        timeoutMs: 10000,
        maxBuffer: 1024 * 1024,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('# Test');
    });

    it('should be able to write to /workspace when not read_only', async () => {
      const sandbox = getBubblewrapSandbox('test', { engine: 'bubblewrap' }, tmpDir);

      const result = await sandbox.exec({
        command: 'echo "new content" > /workspace/newfile.txt && cat /workspace/newfile.txt',
        env: { PATH: '/usr/bin:/bin' },
        timeoutMs: 10000,
        maxBuffer: 1024 * 1024,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('new content');

      // Verify file exists on host
      expect(fs.existsSync(path.join(tmpDir, 'newfile.txt'))).toBe(true);
    });

    it('should NOT be able to write to /workspace when read_only', async () => {
      const sandbox = getBubblewrapSandbox(
        'test',
        { engine: 'bubblewrap', read_only: true },
        tmpDir
      );

      const result = await sandbox.exec({
        command: 'touch /workspace/should-fail.txt',
        env: { PATH: '/usr/bin:/bin' },
        timeoutMs: 10000,
        maxBuffer: 1024 * 1024,
      });

      expect(result.exitCode).not.toBe(0);
      expect(fs.existsSync(path.join(tmpDir, 'should-fail.txt'))).toBe(false);
    });

    it('should NOT have access to host home directory', async () => {
      const sandbox = getBubblewrapSandbox('test', { engine: 'bubblewrap' }, tmpDir);
      const homeDir = os.homedir();

      const result = await sandbox.exec({
        command: `ls ${homeDir} 2>&1 || echo "ACCESS_DENIED"`,
        env: { PATH: '/usr/bin:/bin' },
        timeoutMs: 10000,
        maxBuffer: 1024 * 1024,
      });

      // Either the path doesn't exist in sandbox or permission is denied
      expect(result.stdout).toContain('ACCESS_DENIED');
    });
  });

  describe('environment isolation', () => {
    it('should only see explicitly passed env vars', async () => {
      const sandbox = getBubblewrapSandbox('test', { engine: 'bubblewrap' }, tmpDir);

      const result = await sandbox.exec({
        command: 'env | sort',
        env: { PATH: '/usr/bin:/bin', MY_VAR: 'my_value' },
        timeoutMs: 10000,
        maxBuffer: 1024 * 1024,
      });

      expect(result.exitCode).toBe(0);
      const lines = result.stdout.trim().split('\n');

      // Should contain our explicitly passed vars
      expect(lines).toContainEqual(expect.stringContaining('MY_VAR=my_value'));
      expect(lines).toContainEqual(expect.stringContaining('PATH=/usr/bin:/bin'));

      // Should NOT contain host env vars that weren't passed
      for (const line of lines) {
        expect(line).not.toMatch(/^HOME=/);
        expect(line).not.toMatch(/^USER=/);
        expect(line).not.toMatch(/^SHELL=/);
      }
    });
  });

  describe('network isolation', () => {
    it('should have network access when network is not false', async () => {
      const sandbox = getBubblewrapSandbox('test', { engine: 'bubblewrap', network: true }, tmpDir);

      // Check that loopback interface exists (basic network stack)
      const result = await sandbox.exec({
        command: 'ls /sys/class/net/ 2>/dev/null || echo "no-sysfs"',
        env: { PATH: '/usr/bin:/bin' },
        timeoutMs: 10000,
        maxBuffer: 1024 * 1024,
      });

      // Should succeed (network stack available)
      expect(result.exitCode).toBe(0);
    });
  });

  // ──────────────────────────────────────────────────────────────
  // SandboxManager integration
  // ──────────────────────────────────────────────────────────────

  describe('SandboxManager routing', () => {
    it('should route to bubblewrap when engine is bubblewrap', async () => {
      const manager = getSandboxManager({ bwrap: { engine: 'bubblewrap' } }, tmpDir);

      const result = await manager.exec('bwrap', {
        command: 'echo from-bwrap',
        env: { PATH: '/usr/bin:/bin' },
        timeoutMs: 10000,
        maxBuffer: 1024 * 1024,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('from-bwrap');

      await manager.stopAll();
    });

    it('should resolve sandbox name correctly', () => {
      const manager = getSandboxManager({ bwrap: { engine: 'bubblewrap' } }, tmpDir);

      // Check-level sandbox overrides workspace default
      expect(manager.resolveSandbox('bwrap', undefined)).toBe('bwrap');
      expect(manager.resolveSandbox(undefined, 'bwrap')).toBe('bwrap');
      expect(manager.resolveSandbox(undefined, undefined)).toBeNull();
    });

    it('should throw for unknown sandbox name', () => {
      const manager = getSandboxManager({ bwrap: { engine: 'bubblewrap' } }, tmpDir);

      expect(() => manager.resolveSandbox('nonexistent', undefined)).toThrow(
        "Sandbox 'nonexistent' is not defined"
      );
    });
  });
});
