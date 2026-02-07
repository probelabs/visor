import { CacheVolumeManager } from '../../src/sandbox/cache-volume-manager';

// Mock child_process.execFile
jest.mock('child_process', () => ({
  execFile: jest.fn(),
}));

const { execFile } = require('child_process');

describe('CacheVolumeManager', () => {
  let manager: CacheVolumeManager;
  let mockExecFile: jest.Mock;

  beforeEach(() => {
    manager = new CacheVolumeManager();
    mockExecFile = execFile as jest.Mock;
    mockExecFile.mockReset();
  });

  describe('resolveVolumes', () => {
    it('should create volume names with sandbox name and path hash', async () => {
      // Mock volume doesn't exist + create succeeds
      mockExecFile.mockImplementation(
        (
          _cmd: string,
          args: string[],
          _opts: unknown,
          cb?: (err: unknown, result: unknown) => void
        ) => {
          if (args.includes('inspect')) {
            // Volume doesn't exist
            if (cb) cb(new Error('not found'), null);
          } else if (args.includes('create')) {
            if (cb) cb(null, { stdout: '', stderr: '' });
          }
        }
      );

      const volumes = await manager.resolveVolumes(
        'node-env',
        {
          paths: ['/root/.npm'],
        },
        'main'
      );

      expect(volumes).toHaveLength(1);
      expect(volumes[0].volumeName).toMatch(/^visor-cache-main-node-env-/);
      expect(volumes[0].mountSpec).toMatch(/^visor-cache-main-node-env-.*:\/root\/\.npm$/);
    });

    it('should sanitize branch names in prefix', async () => {
      mockExecFile.mockImplementation(
        (
          _cmd: string,
          args: string[],
          _opts: unknown,
          cb?: (err: unknown, result: unknown) => void
        ) => {
          if (args.includes('inspect')) {
            if (cb) cb(new Error('not found'), null);
          } else if (args.includes('create')) {
            if (cb) cb(null, { stdout: '', stderr: '' });
          }
        }
      );

      const volumes = await manager.resolveVolumes(
        'test-env',
        { paths: ['/cache'] },
        'feature/my-branch'
      );

      expect(volumes).toHaveLength(1);
      // Slash should be replaced with dash
      expect(volumes[0].volumeName).toMatch(/^visor-cache-feature-my-branch-test-env-/);
    });
  });

  describe('volume naming', () => {
    it('should produce deterministic volume names for the same path', async () => {
      mockExecFile.mockImplementation(
        (
          _cmd: string,
          args: string[],
          _opts: unknown,
          cb?: (err: unknown, result: unknown) => void
        ) => {
          if (args.includes('inspect')) {
            if (cb) cb(new Error('not found'), null);
          } else if (args.includes('create')) {
            if (cb) cb(null, { stdout: '', stderr: '' });
          }
        }
      );

      const volumes1 = await manager.resolveVolumes('env', { paths: ['/go/pkg/mod'] }, 'main');

      // Reset mock to allow re-creation
      mockExecFile.mockReset();
      mockExecFile.mockImplementation(
        (
          _cmd: string,
          args: string[],
          _opts: unknown,
          cb?: (err: unknown, result: unknown) => void
        ) => {
          if (args.includes('inspect')) {
            if (cb) cb(new Error('not found'), null);
          } else if (args.includes('create')) {
            if (cb) cb(null, { stdout: '', stderr: '' });
          }
        }
      );

      const manager2 = new CacheVolumeManager();
      const volumes2 = await manager2.resolveVolumes('env', { paths: ['/go/pkg/mod'] }, 'main');

      expect(volumes1[0].volumeName).toBe(volumes2[0].volumeName);
    });
  });
});
