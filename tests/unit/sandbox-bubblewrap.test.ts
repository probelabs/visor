import { BubblewrapSandbox } from '../../src/sandbox/bubblewrap-sandbox';
import { SandboxConfig } from '../../src/sandbox/types';

// Mock child_process.execFile
jest.mock('child_process', () => ({
  execFile: jest.fn(),
}));

// Mock fs.existsSync for /lib, /lib64, /etc/resolv.conf, /etc/ssl
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  existsSync: jest.fn((path: string) => {
    // Default: all system paths exist
    return ['/lib', '/lib64', '/etc/resolv.conf', '/etc/ssl'].includes(path);
  }),
}));

const { execFile } = require('child_process');
const { existsSync } = require('fs');

describe('BubblewrapSandbox', () => {
  let mockExecFile: jest.Mock;
  let mockExistsSync: jest.Mock;

  beforeEach(() => {
    mockExecFile = execFile as jest.Mock;
    mockExecFile.mockReset();
    mockExistsSync = existsSync as jest.Mock;
  });

  describe('constructor', () => {
    it('should create a sandbox with bubblewrap config', () => {
      const config: SandboxConfig = {
        engine: 'bubblewrap',
        workdir: '/workspace',
      };

      const sandbox = new BubblewrapSandbox('test', config, '/repo', '/dist/visor');

      expect(sandbox.name).toBe('test');
      expect(sandbox.config).toBe(config);
      expect(sandbox.config.engine).toBe('bubblewrap');
    });
  });

  describe('exec', () => {
    it('should build correct bwrap args with default config', async () => {
      const config: SandboxConfig = { engine: 'bubblewrap' };
      const sandbox = new BubblewrapSandbox('test', config, '/repo', '/dist/visor');

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

      // Verify bwrap was called with correct args
      expect(mockExecFile).toHaveBeenCalledTimes(1);
      const [cmd, args] = mockExecFile.mock.calls[0];
      expect(cmd).toBe('bwrap');

      // Should have system mounts
      expect(args).toContain('--ro-bind');
      expect(args.indexOf('/usr')).toBeGreaterThan(-1);
      expect(args.indexOf('/bin')).toBeGreaterThan(-1);

      // Should mount workspace
      expect(args).toContain('--bind');
      const bindIdx = args.lastIndexOf('--bind');
      expect(args[bindIdx + 1]).toBe('/repo');
      expect(args[bindIdx + 2]).toBe('/workspace');

      // Should mount visor dist as read-only
      const visorBindIdx = args.indexOf('/opt/visor');
      expect(visorBindIdx).toBeGreaterThan(-1);
      expect(args[visorBindIdx - 1]).toBe('/dist/visor');
      expect(args[visorBindIdx - 2]).toBe('--ro-bind');

      // Should have namespace isolation
      expect(args).toContain('--unshare-pid');
      expect(args).toContain('--new-session');
      expect(args).toContain('--die-with-parent');
      expect(args).toContain('--clearenv');

      // Should pass env vars
      expect(args).toContain('--setenv');
      const pathIdx = args.indexOf('PATH');
      expect(pathIdx).toBeGreaterThan(-1);
      expect(args[pathIdx + 1]).toBe('/usr/bin:/bin');

      // Should end with -- sh -c <command>
      const dashDashIdx = args.indexOf('--');
      expect(args[dashDashIdx + 1]).toBe('/bin/sh');
      expect(args[dashDashIdx + 2]).toBe('-c');
      expect(args[dashDashIdx + 3]).toBe('echo hello');
    });

    it('should use --ro-bind for read_only workspace', async () => {
      const config: SandboxConfig = { engine: 'bubblewrap', read_only: true };
      const sandbox = new BubblewrapSandbox('test', config, '/repo', '/dist/visor');

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

      const args: string[] = mockExecFile.mock.calls[0][1];

      // The workspace should be ro-bind, not bind
      // Find the mount for /workspace - it should be preceded by --ro-bind
      const workspaceIdx = args.indexOf('/workspace');
      expect(args[workspaceIdx - 2]).toBe('--ro-bind');
      expect(args[workspaceIdx - 1]).toBe('/repo');
    });

    it('should add --unshare-net when network is false', async () => {
      const config: SandboxConfig = { engine: 'bubblewrap', network: false };
      const sandbox = new BubblewrapSandbox('test', config, '/repo', '/dist/visor');

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

      const args: string[] = mockExecFile.mock.calls[0][1];
      expect(args).toContain('--unshare-net');
    });

    it('should NOT add --unshare-net when network is true or undefined', async () => {
      const config: SandboxConfig = { engine: 'bubblewrap', network: true };
      const sandbox = new BubblewrapSandbox('test', config, '/repo', '/dist/visor');

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

      const args: string[] = mockExecFile.mock.calls[0][1];
      expect(args).not.toContain('--unshare-net');
    });

    it('should use custom workdir', async () => {
      const config: SandboxConfig = { engine: 'bubblewrap', workdir: '/app' };
      const sandbox = new BubblewrapSandbox('test', config, '/repo', '/dist/visor');

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

      const args: string[] = mockExecFile.mock.calls[0][1];

      // Should mount at custom workdir
      const appIdx = args.indexOf('/app');
      expect(appIdx).toBeGreaterThan(-1);

      // Should chdir to custom workdir
      const chdirIdx = args.indexOf('--chdir');
      expect(args[chdirIdx + 1]).toBe('/app');
    });

    it('should reject invalid env var names', async () => {
      const config: SandboxConfig = { engine: 'bubblewrap' };
      const sandbox = new BubblewrapSandbox('test', config, '/repo', '/dist/visor');

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
      const config: SandboxConfig = { engine: 'bubblewrap' };
      const sandbox = new BubblewrapSandbox('test', config, '/repo', '/dist/visor');

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

    it('should skip /lib64 mount when it does not exist', async () => {
      mockExistsSync.mockImplementation((path: string) => {
        if (path === '/lib64') return false;
        return ['/lib', '/etc/resolv.conf', '/etc/ssl'].includes(path);
      });

      const config: SandboxConfig = { engine: 'bubblewrap' };
      const sandbox = new BubblewrapSandbox('test', config, '/repo', '/dist/visor');

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

      const args: string[] = mockExecFile.mock.calls[0][1];

      // /lib should be mounted but /lib64 should not
      expect(args).toContain('/lib');
      expect(args).not.toContain('/lib64');
    });

    it('should pass timeout and maxBuffer to execFile', async () => {
      const config: SandboxConfig = { engine: 'bubblewrap' };
      const sandbox = new BubblewrapSandbox('test', config, '/repo', '/dist/visor');

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
  });

  describe('stop', () => {
    it('should be a no-op (bubblewrap processes are ephemeral)', async () => {
      const config: SandboxConfig = { engine: 'bubblewrap' };
      const sandbox = new BubblewrapSandbox('test', config, '/repo', '/dist/visor');

      // Should not throw
      await sandbox.stop();

      // execFile should not be called
      expect(mockExecFile).not.toHaveBeenCalled();
    });
  });

  describe('isAvailable', () => {
    it('should return true when bwrap binary exists', async () => {
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
          if (cb) cb(null, { stdout: '/usr/bin/bwrap', stderr: '' });
        }
      );

      const available = await BubblewrapSandbox.isAvailable();
      expect(available).toBe(true);
    });

    it('should return false when bwrap binary does not exist', async () => {
      mockExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb?: Function) => {
          if (cb) cb(new Error('not found'), null);
        }
      );

      const available = await BubblewrapSandbox.isAvailable();
      expect(available).toBe(false);
    });
  });
});
