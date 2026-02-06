import { SandboxManager } from '../../src/sandbox/sandbox-manager';
import { SandboxConfig } from '../../src/sandbox/types';

// Mock Docker sandbox implementations
jest.mock('../../src/sandbox/docker-image-sandbox', () => ({
  DockerImageSandbox: jest.fn().mockImplementation(function (
    this: any,
    name: string,
    config: SandboxConfig
  ) {
    this.name = name;
    this.config = config;
    this.start = jest.fn().mockResolvedValue(undefined);
    this.stop = jest.fn().mockResolvedValue(undefined);
    this.exec = jest.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
  }),
}));

jest.mock('../../src/sandbox/docker-compose-sandbox', () => ({
  DockerComposeSandbox: jest.fn().mockImplementation(function (
    this: any,
    name: string,
    config: SandboxConfig
  ) {
    this.name = name;
    this.config = config;
    this.start = jest.fn().mockResolvedValue(undefined);
    this.stop = jest.fn().mockResolvedValue(undefined);
    this.exec = jest.fn().mockResolvedValue({ stdout: '', stderr: '', exitCode: 0 });
  }),
}));

jest.mock('../../src/sandbox/cache-volume-manager', () => ({
  CacheVolumeManager: jest.fn().mockImplementation(function (this: any) {
    this.resolveVolumes = jest.fn().mockResolvedValue([]);
    this.evictExpired = jest.fn().mockResolvedValue(undefined);
  }),
}));

describe('SandboxManager', () => {
  const sandboxDefs: Record<string, SandboxConfig> = {
    'node-env': {
      image: 'node:20-alpine',
      workdir: '/workspace',
    },
    'custom-env': {
      dockerfile_inline: 'FROM node:20\nRUN npm install -g eslint',
    },
    'compose-env': {
      compose: './docker-compose.yml',
      service: 'app',
    },
  };

  let manager: SandboxManager;

  beforeEach(() => {
    manager = new SandboxManager(sandboxDefs, '/repo', 'main');
  });

  describe('resolveSandbox', () => {
    it('should return check-level sandbox if specified', () => {
      const result = manager.resolveSandbox('node-env', 'custom-env');
      expect(result).toBe('node-env');
    });

    it('should fall back to workspace default', () => {
      const result = manager.resolveSandbox(undefined, 'custom-env');
      expect(result).toBe('custom-env');
    });

    it('should return null if no sandbox configured', () => {
      const result = manager.resolveSandbox(undefined, undefined);
      expect(result).toBeNull();
    });

    it('should throw for undefined sandbox name', () => {
      expect(() => manager.resolveSandbox('nonexistent', undefined)).toThrow(
        "Sandbox 'nonexistent' is not defined"
      );
    });
  });

  describe('getOrStart', () => {
    it('should create and start an image sandbox', async () => {
      const instance = await manager.getOrStart('node-env');
      expect(instance.name).toBe('node-env');
    });

    it('should reuse existing sandbox instance', async () => {
      const first = await manager.getOrStart('node-env');
      const second = await manager.getOrStart('node-env');
      expect(first).toBe(second);
    });

    it('should create compose sandbox for compose config', async () => {
      const instance = await manager.getOrStart('compose-env');
      expect(instance.name).toBe('compose-env');
    });

    it('should throw for undefined sandbox', async () => {
      await expect(manager.getOrStart('nonexistent')).rejects.toThrow(
        "Sandbox 'nonexistent' is not defined"
      );
    });
  });

  describe('exec', () => {
    it('should execute command in sandbox', async () => {
      const result = await manager.exec('node-env', {
        command: 'echo hello',
        env: {},
        timeoutMs: 10000,
        maxBuffer: 1024,
      });

      expect(result.exitCode).toBe(0);
    });
  });

  describe('stopAll', () => {
    it('should stop all running instances', async () => {
      await manager.getOrStart('node-env');
      await manager.getOrStart('custom-env');

      await manager.stopAll();

      // After stopAll, starting again should create new instances
      const instance = await manager.getOrStart('node-env');
      expect(instance).toBeDefined();
    });
  });
});
