import { SeatbeltSandbox } from '../../src/sandbox/seatbelt-sandbox';
import { SandboxConfig } from '../../src/sandbox/types';

// Mock child_process.execFile
jest.mock('child_process', () => ({
  execFile: jest.fn(),
}));

// Mock fs.realpathSync so constructor doesn't fail on non-existent paths
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  realpathSync: jest.fn((p: string) => p),
}));

const { execFile } = require('child_process');

describe('SeatbeltSandbox', () => {
  let mockExecFile: jest.Mock;

  beforeEach(() => {
    mockExecFile = execFile as jest.Mock;
    mockExecFile.mockReset();
  });

  describe('constructor', () => {
    it('should create a sandbox with seatbelt config', () => {
      const config: SandboxConfig = {
        engine: 'seatbelt',
      };

      const sandbox = new SeatbeltSandbox('test', config, '/repo', '/dist/visor');

      expect(sandbox.name).toBe('test');
      expect(sandbox.config).toBe(config);
      expect(sandbox.config.engine).toBe('seatbelt');
    });
  });

  describe('exec', () => {
    it('should build correct sandbox-exec args with default config', async () => {
      const config: SandboxConfig = { engine: 'seatbelt' };
      const sandbox = new SeatbeltSandbox('test', config, '/repo', '/dist/visor');

      mockExecFile.mockImplementation(
        (
          _cmd: string,
          _args: string[],
          _opts: unknown,
          cb?: (err: unknown, result: unknown) => void
        ) => {
          if (cb) {
            cb(null, { stdout: 'hello', stderr: '' });
          }
        }
      );

      const result = await sandbox.exec({
        command: 'echo hello',
        env: { PATH: '/usr/bin:/bin', HOME: '/tmp' },
        timeoutMs: 30000,
        maxBuffer: 1024 * 1024,
      });

      expect(result.stdout).toBe('hello');
      expect(result.exitCode).toBe(0);

      // Verify sandbox-exec was called
      expect(mockExecFile).toHaveBeenCalledTimes(1);
      const [cmd, args, opts] = mockExecFile.mock.calls[0];
      expect(cmd).toBe('sandbox-exec');

      // Should have -p flag with SBPL profile
      expect(args[0]).toBe('-p');
      const profile = args[1];
      expect(profile).toContain('(version 1)');
      expect(profile).toContain('(deny default)');

      // Should have env -i to clear environment
      expect(args[2]).toBe('/usr/bin/env');
      expect(args[3]).toBe('-i');

      // Should pass env vars as KEY=VAL args
      expect(args).toContain('PATH=/usr/bin:/bin');
      expect(args).toContain('HOME=/tmp');

      // Should end with /bin/sh -c <command>
      const shIdx = args.indexOf('/bin/sh');
      expect(shIdx).toBeGreaterThan(-1);
      expect(args[shIdx + 1]).toBe('-c');
      expect(args[shIdx + 2]).toBe('echo hello');

      // Should set cwd to repoPath
      expect(opts.cwd).toBe('/repo');
    });

    it('should include file-read rule for visor dist path', async () => {
      const config: SandboxConfig = { engine: 'seatbelt' };
      const sandbox = new SeatbeltSandbox('test', config, '/repo', '/dist/visor');

      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
          if (cb) cb(null, { stdout: '', stderr: '' });
        }
      );

      await sandbox.exec({
        command: 'ls',
        env: {},
        timeoutMs: 5000,
        maxBuffer: 1024,
      });

      const profile: string = mockExecFile.mock.calls[0][1][1];
      expect(profile).toContain('(allow file-read* (subpath "/dist/visor"))');
    });

    it('should include file-write rule for workspace when not read_only', async () => {
      const config: SandboxConfig = { engine: 'seatbelt' };
      const sandbox = new SeatbeltSandbox('test', config, '/repo', '/dist/visor');

      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
          if (cb) cb(null, { stdout: '', stderr: '' });
        }
      );

      await sandbox.exec({
        command: 'ls',
        env: {},
        timeoutMs: 5000,
        maxBuffer: 1024,
      });

      const profile: string = mockExecFile.mock.calls[0][1][1];
      expect(profile).toContain('(allow file-write* (subpath "/repo"))');
    });

    it('should NOT include file-write rule for workspace when read_only', async () => {
      const config: SandboxConfig = { engine: 'seatbelt', read_only: true };
      const sandbox = new SeatbeltSandbox('test', config, '/repo', '/dist/visor');

      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
          if (cb) cb(null, { stdout: '', stderr: '' });
        }
      );

      await sandbox.exec({
        command: 'ls',
        env: {},
        timeoutMs: 5000,
        maxBuffer: 1024,
      });

      const profile: string = mockExecFile.mock.calls[0][1][1];
      expect(profile).toContain('(allow file-read* (subpath "/repo"))');
      expect(profile).not.toContain('(allow file-write* (subpath "/repo"))');
    });

    it('should include network rule when network is not false', async () => {
      const config: SandboxConfig = { engine: 'seatbelt', network: true };
      const sandbox = new SeatbeltSandbox('test', config, '/repo', '/dist/visor');

      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
          if (cb) cb(null, { stdout: '', stderr: '' });
        }
      );

      await sandbox.exec({
        command: 'ls',
        env: {},
        timeoutMs: 5000,
        maxBuffer: 1024,
      });

      const profile: string = mockExecFile.mock.calls[0][1][1];
      expect(profile).toContain('(allow network*)');
    });

    it('should NOT include network rule when network is false', async () => {
      const config: SandboxConfig = { engine: 'seatbelt', network: false };
      const sandbox = new SeatbeltSandbox('test', config, '/repo', '/dist/visor');

      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
          if (cb) cb(null, { stdout: '', stderr: '' });
        }
      );

      await sandbox.exec({
        command: 'ls',
        env: {},
        timeoutMs: 5000,
        maxBuffer: 1024,
      });

      const profile: string = mockExecFile.mock.calls[0][1][1];
      expect(profile).not.toContain('(allow network*)');
    });

    it('should include system path read access in profile', async () => {
      const config: SandboxConfig = { engine: 'seatbelt' };
      const sandbox = new SeatbeltSandbox('test', config, '/repo', '/dist/visor');

      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
          if (cb) cb(null, { stdout: '', stderr: '' });
        }
      );

      await sandbox.exec({
        command: 'ls',
        env: {},
        timeoutMs: 5000,
        maxBuffer: 1024,
      });

      const profile: string = mockExecFile.mock.calls[0][1][1];
      expect(profile).toContain('(literal "/")');
      expect(profile).toContain('(subpath "/usr")');
      expect(profile).toContain('(subpath "/bin")');
      expect(profile).toContain('(subpath "/sbin")');
      expect(profile).toContain('(subpath "/Library")');
      expect(profile).toContain('(subpath "/System")');
      expect(profile).toContain('(subpath "/private")');
      expect(profile).toContain('(subpath "/var")');
      expect(profile).toContain('(subpath "/etc")');
      expect(profile).toContain('(allow process-exec)');
      expect(profile).toContain('(allow process-fork)');
      expect(profile).toContain('(allow sysctl-read)');
      expect(profile).toContain('(allow mach-lookup)');
      expect(profile).toContain('(allow signal)');
    });

    it('should reject invalid env var names', async () => {
      const config: SandboxConfig = { engine: 'seatbelt' };
      const sandbox = new SeatbeltSandbox('test', config, '/repo', '/dist/visor');

      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
          if (cb) cb(null, { stdout: '', stderr: '' });
        }
      );

      await expect(
        sandbox.exec({
          command: 'ls',
          env: { 'INVALID-NAME': 'value' },
          timeoutMs: 5000,
          maxBuffer: 1024,
        })
      ).rejects.toThrow('Invalid environment variable name');
    });

    it('should handle non-zero exit codes', async () => {
      const config: SandboxConfig = { engine: 'seatbelt' };
      const sandbox = new SeatbeltSandbox('test', config, '/repo', '/dist/visor');

      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
          if (cb) {
            const err = new Error('Command failed') as any;
            err.code = 1;
            err.stdout = 'partial output';
            err.stderr = 'error message';
            cb(err, null);
          }
        }
      );

      const result = await sandbox.exec({
        command: 'exit 1',
        env: {},
        timeoutMs: 5000,
        maxBuffer: 1024,
      });

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe('partial output');
      expect(result.stderr).toBe('error message');
    });

    it('should pass timeout and maxBuffer to execFile', async () => {
      const config: SandboxConfig = { engine: 'seatbelt' };
      const sandbox = new SeatbeltSandbox('test', config, '/repo', '/dist/visor');

      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
          if (cb) cb(null, { stdout: '', stderr: '' });
        }
      );

      await sandbox.exec({
        command: 'ls',
        env: {},
        timeoutMs: 60000,
        maxBuffer: 10 * 1024 * 1024,
      });

      const opts = mockExecFile.mock.calls[0][2];
      expect(opts.timeout).toBe(60000);
      expect(opts.maxBuffer).toBe(10 * 1024 * 1024);
    });

    it('should escape paths with special characters in SBPL profile', async () => {
      const config: SandboxConfig = { engine: 'seatbelt' };
      const sandbox = new SeatbeltSandbox('test', config, '/repo/path with spaces', '/dist/visor');

      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
          if (cb) cb(null, { stdout: '', stderr: '' });
        }
      );

      await sandbox.exec({
        command: 'ls',
        env: {},
        timeoutMs: 5000,
        maxBuffer: 1024,
      });

      const profile: string = mockExecFile.mock.calls[0][1][1];
      expect(profile).toContain('(subpath "/repo/path with spaces")');
    });

    it('should escape quotes in repo path', async () => {
      const config: SandboxConfig = { engine: 'seatbelt' };
      const sandbox = new SeatbeltSandbox('test', config, '/repo/path"with"quotes', '/dist/visor');

      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
          if (cb) cb(null, { stdout: '', stderr: '' });
        }
      );

      await sandbox.exec({
        command: 'ls',
        env: {},
        timeoutMs: 5000,
        maxBuffer: 1024,
      });

      const profile: string = mockExecFile.mock.calls[0][1][1];
      expect(profile).toContain('(subpath "/repo/path\\"with\\"quotes")');
    });
  });

  describe('stop', () => {
    it('should be a no-op (sandbox-exec processes are ephemeral)', async () => {
      const config: SandboxConfig = { engine: 'seatbelt' };
      const sandbox = new SeatbeltSandbox('test', config, '/repo', '/dist/visor');

      // Should not throw
      await sandbox.stop();

      // execFile should not be called
      expect(mockExecFile).not.toHaveBeenCalled();
    });
  });

  describe('isAvailable', () => {
    it('should return true when sandbox-exec binary exists', async () => {
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
          if (cb) cb(null, { stdout: '/usr/bin/sandbox-exec', stderr: '' });
        }
      );

      const available = await SeatbeltSandbox.isAvailable();
      expect(available).toBe(true);
    });

    it('should return false when sandbox-exec binary does not exist', async () => {
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
          if (cb) cb(new Error('not found'), null);
        }
      );

      const available = await SeatbeltSandbox.isAvailable();
      expect(available).toBe(false);
    });
  });
});
