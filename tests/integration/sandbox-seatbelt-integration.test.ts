/**
 * Seatbelt Sandbox Integration Tests
 *
 * These tests exercise real macOS sandbox-exec processes via SandboxManager
 * and SeatbeltSandbox. They are automatically skipped when sandbox-exec is
 * not available (Linux, Windows, or other non-macOS systems).
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Detect sandbox-exec availability (macOS only)
let hasSandboxExec = false;
try {
  execSync('which sandbox-exec', { stdio: 'ignore', timeout: 5000 });
  hasSandboxExec = true;
} catch {}

const describeIfSeatbelt = hasSandboxExec ? describe : describe.skip;

jest.setTimeout(30000);

describeIfSeatbelt('Seatbelt Sandbox Integration', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-seatbelt-'));

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

  function getSeatbeltSandbox(name: string, config: any, repoPath: string) {
    const { SeatbeltSandbox } = require('../../src/sandbox/seatbelt-sandbox');
    return new SeatbeltSandbox(
      name,
      config,
      repoPath
    ) as import('../../src/sandbox/seatbelt-sandbox').SeatbeltSandbox;
  }

  // ──────────────────────────────────────────────────────────────
  // SeatbeltSandbox direct tests
  // ──────────────────────────────────────────────────────────────

  describe('SeatbeltSandbox.isAvailable()', () => {
    it('should return true on this system', async () => {
      const { SeatbeltSandbox } = require('../../src/sandbox/seatbelt-sandbox');
      const available = await SeatbeltSandbox.isAvailable();
      expect(available).toBe(true);
    });
  });

  describe('basic execution', () => {
    it('should run a command and return output', async () => {
      const sandbox = getSeatbeltSandbox('test', { engine: 'seatbelt' }, tmpDir);

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
      const sandbox = getSeatbeltSandbox('test', { engine: 'seatbelt' }, tmpDir);

      const result = await sandbox.exec({
        command: 'exit 42',
        env: { PATH: '/usr/bin:/bin' },
        timeoutMs: 10000,
        maxBuffer: 1024 * 1024,
      });

      expect(result.exitCode).toBe(42);
    });
  });

  describe('filesystem access', () => {
    it('should have access to repo directory', async () => {
      const sandbox = getSeatbeltSandbox('test', { engine: 'seatbelt' }, tmpDir);

      const result = await sandbox.exec({
        command: 'cat README.md',
        env: { PATH: '/usr/bin:/bin' },
        timeoutMs: 10000,
        maxBuffer: 1024 * 1024,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('# Test');
    });

    it('should be able to write to repo when not read_only', async () => {
      const sandbox = getSeatbeltSandbox('test', { engine: 'seatbelt' }, tmpDir);

      const result = await sandbox.exec({
        command: 'echo "new content" > newfile.txt && cat newfile.txt',
        env: { PATH: '/usr/bin:/bin' },
        timeoutMs: 10000,
        maxBuffer: 1024 * 1024,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('new content');

      // Verify file exists on host
      expect(fs.existsSync(path.join(tmpDir, 'newfile.txt'))).toBe(true);
    });

    it('should NOT be able to write to repo when read_only', async () => {
      const sandbox = getSeatbeltSandbox('test', { engine: 'seatbelt', read_only: true }, tmpDir);

      const result = await sandbox.exec({
        command: 'touch should-fail.txt 2>&1; echo "exit:$?"',
        env: { PATH: '/usr/bin:/bin' },
        timeoutMs: 10000,
        maxBuffer: 1024 * 1024,
      });

      // The touch command should fail due to sandbox restriction
      expect(result.stdout).toContain('exit:1');
      expect(fs.existsSync(path.join(tmpDir, 'should-fail.txt'))).toBe(false);
    });
  });

  describe('environment isolation', () => {
    it('should only see explicitly passed env vars', async () => {
      const sandbox = getSeatbeltSandbox('test', { engine: 'seatbelt' }, tmpDir);

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

  // ──────────────────────────────────────────────────────────────
  // SandboxManager integration
  // ──────────────────────────────────────────────────────────────

  describe('SandboxManager routing', () => {
    it('should route to seatbelt when engine is seatbelt', async () => {
      const manager = getSandboxManager({ mac: { engine: 'seatbelt' } }, tmpDir);

      const result = await manager.exec('mac', {
        command: 'echo from-seatbelt',
        env: { PATH: '/usr/bin:/bin' },
        timeoutMs: 10000,
        maxBuffer: 1024 * 1024,
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('from-seatbelt');

      await manager.stopAll();
    });

    it('should resolve sandbox name correctly', () => {
      const manager = getSandboxManager({ mac: { engine: 'seatbelt' } }, tmpDir);

      expect(manager.resolveSandbox('mac', undefined)).toBe('mac');
      expect(manager.resolveSandbox(undefined, 'mac')).toBe('mac');
      expect(manager.resolveSandbox(undefined, undefined)).toBeNull();
    });
  });
});
