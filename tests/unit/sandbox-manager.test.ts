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

// Mock the compose generator to avoid real filesystem writes in unit tests
jest.mock('../../src/sandbox/compose-generator', () => ({
  generateComposeFile: jest.fn().mockResolvedValue({
    filePath: '/tmp/mock-compose/docker-compose-test-project.yml',
    projectName: 'visor-test-project-abcdef12',
    serviceName: 'workspace',
    serviceEndpoints: {
      redis: { host: 'redis', port: 6379 },
    },
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
    'go-env': {
      image: 'golang:1.22-bookworm',
      network: true,
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

  // =========================================================================
  // Project Services Lifecycle
  // =========================================================================
  describe('startProjectServices', () => {
    it('should start project services and return environment', async () => {
      const env = await manager.startProjectServices(
        'tyk',
        { redis: { image: 'redis:7-alpine' } },
        'go-env',
        'session-1234567890',
        '/tmp/workspace/tyk'
      );

      expect(env.projectId).toBe('tyk');
      expect(env.projectName).toBe('visor-test-project-abcdef12');
      expect(env.serviceName).toBe('workspace');
      expect(env.started).toBe(true);
      expect(env.serviceEndpoints).toEqual({
        redis: { host: 'redis', port: 6379 },
      });
    });

    it('should return existing environment if already started', async () => {
      const first = await manager.startProjectServices(
        'tyk',
        { redis: { image: 'redis:7-alpine' } },
        undefined,
        'session-1234567890',
        '/tmp/workspace/tyk'
      );

      const second = await manager.startProjectServices(
        'tyk',
        { redis: { image: 'redis:7-alpine' } },
        undefined,
        'session-1234567890',
        '/tmp/workspace/tyk'
      );

      expect(first).toBe(second);
    });

    it('should register compose sandbox as instance for exec', async () => {
      await manager.startProjectServices(
        'myproject',
        { redis: { image: 'redis:7-alpine' } },
        undefined,
        'session-abc',
        '/tmp/workspace/myproject'
      );

      // The instance should be accessible via exec
      const result = await manager.exec('project-myproject', {
        command: 'echo hello',
        env: {},
        timeoutMs: 10000,
        maxBuffer: 1024,
      });
      expect(result.exitCode).toBe(0);
    });

    it('should pass sandbox config to compose generator when sandbox name provided', async () => {
      const { generateComposeFile } = require('../../src/sandbox/compose-generator');

      await manager.startProjectServices(
        'tyk',
        { redis: { image: 'redis:7-alpine' } },
        'go-env',
        'session-123',
        '/tmp/workspace/tyk'
      );

      expect(generateComposeFile).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: 'tyk',
          workspaceSandbox: sandboxDefs['go-env'],
        })
      );
    });
  });

  describe('stopProjectServices', () => {
    it('should stop running project services', async () => {
      await manager.startProjectServices(
        'tyk',
        { redis: { image: 'redis:7-alpine' } },
        undefined,
        'session-123',
        '/tmp/workspace/tyk'
      );

      expect(manager.getProjectEnvironment('tyk')).toBeDefined();

      await manager.stopProjectServices('tyk');

      expect(manager.getProjectEnvironment('tyk')).toBeUndefined();
    });

    it('should be a no-op for unknown project', async () => {
      // Should not throw
      await manager.stopProjectServices('nonexistent');
    });

    it('should be a no-op for already stopped project', async () => {
      await manager.startProjectServices(
        'tyk',
        { redis: { image: 'redis:7-alpine' } },
        undefined,
        'session-123',
        '/tmp/workspace/tyk'
      );
      await manager.stopProjectServices('tyk');

      // Second stop should be no-op
      await manager.stopProjectServices('tyk');
    });
  });

  describe('getProjectEnvironment', () => {
    it('should return undefined for unknown project', () => {
      expect(manager.getProjectEnvironment('unknown')).toBeUndefined();
    });

    it('should return environment after starting services', async () => {
      await manager.startProjectServices(
        'tyk',
        { redis: { image: 'redis:7-alpine' } },
        undefined,
        'session-123',
        '/tmp/workspace/tyk'
      );

      const env = manager.getProjectEnvironment('tyk');
      expect(env).toBeDefined();
      expect(env!.projectId).toBe('tyk');
      expect(env!.started).toBe(true);
      expect(env!.serviceEndpoints.redis).toEqual({ host: 'redis', port: 6379 });
    });
  });

  describe('stopAll with project services', () => {
    it('should stop project services and regular instances together', async () => {
      // Start a regular sandbox
      await manager.getOrStart('node-env');

      // Start project services
      await manager.startProjectServices(
        'tyk',
        { redis: { image: 'redis:7-alpine' } },
        undefined,
        'session-123',
        '/tmp/workspace/tyk'
      );

      expect(manager.getProjectEnvironment('tyk')).toBeDefined();

      await manager.stopAll();

      // Both should be cleaned up
      expect(manager.getProjectEnvironment('tyk')).toBeUndefined();

      // Regular sandbox should be recreatable
      const instance = await manager.getOrStart('node-env');
      expect(instance).toBeDefined();
    });

    it('should handle stopAll with multiple project environments', async () => {
      await manager.startProjectServices(
        'project-a',
        { redis: { image: 'redis:7-alpine' } },
        undefined,
        'session-1',
        '/tmp/workspace/a'
      );
      await manager.startProjectServices(
        'project-b',
        { postgres: { image: 'postgres:15' } },
        undefined,
        'session-2',
        '/tmp/workspace/b'
      );

      expect(manager.getProjectEnvironment('project-a')).toBeDefined();
      expect(manager.getProjectEnvironment('project-b')).toBeDefined();

      await manager.stopAll();

      expect(manager.getProjectEnvironment('project-a')).toBeUndefined();
      expect(manager.getProjectEnvironment('project-b')).toBeUndefined();
    });
  });
});
