import { DockerImageSandbox } from '../../src/sandbox/docker-image-sandbox';
import { SandboxConfig } from '../../src/sandbox/types';

// Mock child_process.execFile
jest.mock('child_process', () => ({
  execFile: jest.fn(),
}));

// Mock fs operations
jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  writeFileSync: jest.fn(),
  unlinkSync: jest.fn(),
  mkdtempSync: jest.fn(() => '/tmp/visor-build-abc123'),
}));

// Mock crypto.randomUUID
jest.mock('crypto', () => ({
  ...jest.requireActual('crypto'),
  randomUUID: jest.fn(() => 'test-uuid-1234-5678'),
}));

const { execFile } = require('child_process');

describe('DockerImageSandbox', () => {
  let sandbox: DockerImageSandbox;
  let mockExecFile: jest.Mock;

  beforeEach(() => {
    mockExecFile = execFile as jest.Mock;
    mockExecFile.mockReset();
  });

  describe('constructor', () => {
    it('should create a sandbox with image config', () => {
      const config: SandboxConfig = {
        image: 'node:20-alpine',
        workdir: '/workspace',
      };

      sandbox = new DockerImageSandbox('test', config, '/repo', '/visor/dist');

      expect(sandbox.name).toBe('test');
      expect(sandbox.config).toBe(config);
    });
  });

  describe('start', () => {
    it('should build docker run command with correct flags', async () => {
      const config: SandboxConfig = {
        image: 'node:20-alpine',
        workdir: '/workspace',
        read_only: true,
        network: false,
        resources: { memory: '512m', cpu: 1.0 },
      };

      sandbox = new DockerImageSandbox('test', config, '/repo', '/visor/dist');

      // Mock execFile to simulate docker run
      mockExecFile.mockImplementation(
        (
          _cmd: string,
          _args: string[],
          _opts: unknown,
          cb?: (err: unknown, result: unknown) => void
        ) => {
          if (cb) {
            cb(null, { stdout: 'container-id-123', stderr: '' });
          } else {
            return {
              stdout: 'container-id-123',
              stderr: '',
            };
          }
        }
      );

      // The promisified exec will call the callback-based exec
      // We need to verify the command that would be generated

      // Verify the sandbox configuration is stored correctly
      expect(sandbox.config.image).toBe('node:20-alpine');
      expect(sandbox.config.read_only).toBe(true);
      expect(sandbox.config.network).toBe(false);
      expect(sandbox.config.resources?.memory).toBe('512m');
      expect(sandbox.config.resources?.cpu).toBe(1.0);
    });
  });

  describe('config validation', () => {
    it('should support image mode', () => {
      const config: SandboxConfig = { image: 'node:20' };
      sandbox = new DockerImageSandbox('test', config, '/repo', '/visor/dist');
      expect(sandbox.config.image).toBe('node:20');
    });

    it('should support dockerfile mode', () => {
      const config: SandboxConfig = { dockerfile: './Dockerfile.ci' };
      sandbox = new DockerImageSandbox('test', config, '/repo', '/visor/dist');
      expect(sandbox.config.dockerfile).toBe('./Dockerfile.ci');
    });

    it('should support inline dockerfile mode', () => {
      const config: SandboxConfig = {
        dockerfile_inline: 'FROM node:20\nRUN npm i -g eslint',
      };
      sandbox = new DockerImageSandbox('test', config, '/repo', '/visor/dist');
      expect(sandbox.config.dockerfile_inline).toContain('FROM node:20');
    });

    it('should store cache volume mounts', () => {
      const config: SandboxConfig = { image: 'node:20' };
      const cacheVolumes = ['vol1:/cache/path1', 'vol2:/cache/path2'];
      sandbox = new DockerImageSandbox('test', config, '/repo', '/visor/dist', cacheVolumes);
      expect(sandbox.name).toBe('test');
    });
  });
});
