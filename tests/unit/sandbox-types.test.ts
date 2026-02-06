import type {
  SandboxConfig,
  SandboxCacheConfig,
  CheckRunPayload,
  CheckRunResult,
} from '../../src/sandbox/types';

describe('Sandbox Types', () => {
  it('should create valid SandboxConfig with image mode', () => {
    const config: SandboxConfig = {
      image: 'node:20-alpine',
      workdir: '/workspace',
      env_passthrough: ['GITHUB_*', 'CI'],
      network: true,
      read_only: false,
    };

    expect(config.image).toBe('node:20-alpine');
    expect(config.workdir).toBe('/workspace');
    expect(config.network).toBe(true);
  });

  it('should create valid SandboxConfig with dockerfile mode', () => {
    const config: SandboxConfig = {
      dockerfile: './Dockerfile.ci',
      workdir: '/workspace',
    };

    expect(config.dockerfile).toBe('./Dockerfile.ci');
  });

  it('should create valid SandboxConfig with inline dockerfile', () => {
    const config: SandboxConfig = {
      dockerfile_inline: 'FROM node:20\nRUN npm install -g eslint',
    };

    expect(config.dockerfile_inline).toContain('FROM node:20');
  });

  it('should create valid SandboxConfig with compose mode', () => {
    const config: SandboxConfig = {
      compose: './docker-compose.test.yml',
      service: 'app',
      workdir: '/workspace',
    };

    expect(config.compose).toBe('./docker-compose.test.yml');
    expect(config.service).toBe('app');
  });

  it('should create valid cache config', () => {
    const cache: SandboxCacheConfig = {
      prefix: '{{ branch }}',
      fallback_prefix: 'main',
      paths: ['/go/pkg/mod', '/root/.cache/go-build'],
      ttl: '7d',
      max_scopes: 10,
    };

    expect(cache.paths).toHaveLength(2);
    expect(cache.ttl).toBe('7d');
  });

  it('should create valid CheckRunPayload', () => {
    const payload: CheckRunPayload = {
      check: {
        type: 'command',
        exec: 'eslint src/',
      },
      prInfo: {
        number: 42,
        title: 'Fix bug',
        body: 'Description',
        author: 'user',
        base: 'main',
        head: 'feature',
        files: [
          {
            filename: 'src/index.ts',
            status: 'modified',
            additions: 10,
            deletions: 5,
            changes: 15,
          },
        ],
        totalAdditions: 10,
        totalDeletions: 5,
      },
    };

    expect(payload.check.type).toBe('command');
    expect(payload.prInfo.number).toBe(42);
    expect(payload.prInfo.files).toHaveLength(1);
  });

  it('should create valid CheckRunResult', () => {
    const result: CheckRunResult = {
      issues: [
        {
          file: 'src/index.ts',
          line: 10,
          ruleId: 'no-unused-vars',
          message: 'Variable is unused',
          severity: 'warning',
          category: 'style',
        },
      ],
      output: { someData: true },
      content: 'Review complete',
    };

    expect(result.issues).toHaveLength(1);
    expect(result.output).toEqual({ someData: true });
  });
});
