import { DockerComposeSandbox } from '../../src/sandbox/docker-compose-sandbox';
import { SandboxConfig } from '../../src/sandbox/types';

// Mock child_process.execFile
jest.mock('child_process', () => ({
  execFile: jest.fn(),
}));

jest.mock('crypto', () => ({
  ...jest.requireActual('crypto'),
  randomUUID: jest.fn(() => 'test-uuid-1234-5678'),
}));

describe('DockerComposeSandbox', () => {
  describe('constructor', () => {
    it('should create a compose sandbox with correct config', () => {
      const config: SandboxConfig = {
        compose: './docker-compose.test.yml',
        service: 'app',
        workdir: '/workspace',
      };

      const sandbox = new DockerComposeSandbox('integration', config);

      expect(sandbox.name).toBe('integration');
      expect(sandbox.config.compose).toBe('./docker-compose.test.yml');
      expect(sandbox.config.service).toBe('app');
    });
  });

  describe('validation', () => {
    it('should require compose file', async () => {
      const config: SandboxConfig = {
        service: 'app',
      };

      const sandbox = new DockerComposeSandbox('test', config);

      await expect(sandbox.start()).rejects.toThrow('no compose file');
    });

    it('should require service name', async () => {
      const config: SandboxConfig = {
        compose: './docker-compose.yml',
      };

      const sandbox = new DockerComposeSandbox('test', config);

      await expect(sandbox.start()).rejects.toThrow("requires a 'service' field");
    });
  });

  describe('exec validation', () => {
    it('should throw if not started', async () => {
      const config: SandboxConfig = {
        compose: './docker-compose.yml',
        service: 'app',
      };

      const sandbox = new DockerComposeSandbox('test', config);

      await expect(
        sandbox.exec({
          command: 'echo test',
          env: {},
          timeoutMs: 10000,
          maxBuffer: 1024,
        })
      ).rejects.toThrow('not started');
    });
  });
});
