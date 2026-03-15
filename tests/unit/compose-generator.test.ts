import { generateComposeFile } from '../../src/sandbox/compose-generator';
import { ProjectServiceConfig } from '../../src/sandbox/types';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { join } from 'path';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';

describe('generateComposeFile', () => {
  let outputDir: string;

  beforeEach(() => {
    outputDir = mkdtempSync(join(tmpdir(), 'visor-compose-test-'));
  });

  afterEach(() => {
    rmSync(outputDir, { recursive: true, force: true });
  });

  const baseOptions = {
    projectId: 'tyk',
    sessionId: 'abcdef1234567890',
    workspacePath: '/tmp/workspace/tyk',
    visorDistPath: '/opt/visor/dist',
    outputDir: '',
  };

  it('should generate a valid compose file with redis service', async () => {
    const services: Record<string, ProjectServiceConfig> = {
      redis: { image: 'redis:7-alpine' },
    };

    const result = await generateComposeFile({
      ...baseOptions,
      outputDir,
      services,
    });

    expect(result.projectName).toBe('visor-tyk-abcdef12');
    expect(result.serviceName).toBe('workspace');
    expect(result.serviceEndpoints).toEqual({
      redis: { host: 'redis', port: 6379 },
    });

    // Verify file was written
    expect(fs.existsSync(result.filePath)).toBe(true);

    // Parse and validate compose content
    const content = fs.readFileSync(result.filePath, 'utf8');
    const doc = yaml.load(content) as any;

    expect(doc.name).toBe('visor-tyk-abcdef12');
    expect(doc.services.redis.image).toBe('redis:7-alpine');
    expect(doc.services.workspace.image).toBe('ubuntu:22.04');
    expect(doc.services.workspace.command).toBe('sleep infinity');
    expect(doc.services.workspace.depends_on).toEqual(['redis']);
    expect(doc.services.workspace.volumes).toContain('/tmp/workspace/tyk:/workspace');
    expect(doc.services.workspace.volumes).toContain('/opt/visor/dist:/opt/visor:ro');
  });

  it('should use sandbox image when workspaceSandbox is provided', async () => {
    const services: Record<string, ProjectServiceConfig> = {
      redis: { image: 'redis:7-alpine' },
    };

    const result = await generateComposeFile({
      ...baseOptions,
      outputDir,
      services,
      workspaceSandbox: { image: 'golang:1.22-bookworm', workdir: '/go/src' },
    });

    const content = fs.readFileSync(result.filePath, 'utf8');
    const doc = yaml.load(content) as any;

    expect(doc.services.workspace.image).toBe('golang:1.22-bookworm');
    expect(doc.services.workspace.working_dir).toBe('/go/src');
  });

  it('should handle multiple services with healthchecks', async () => {
    const services: Record<string, ProjectServiceConfig> = {
      redis: { image: 'redis:7-alpine' },
      postgres: {
        image: 'postgres:15',
        environment: { POSTGRES_PASSWORD: 'test' },
        healthcheck: {
          test: ['CMD-SHELL', 'pg_isready -U postgres'],
          interval: '5s',
          timeout: '3s',
          retries: 5,
        },
      },
    };

    const result = await generateComposeFile({
      ...baseOptions,
      outputDir,
      services,
    });

    expect(result.serviceEndpoints).toEqual({
      redis: { host: 'redis', port: 6379 },
      postgres: { host: 'postgres', port: 5432 },
    });

    const content = fs.readFileSync(result.filePath, 'utf8');
    const doc = yaml.load(content) as any;

    expect(doc.services.postgres.environment).toEqual({ POSTGRES_PASSWORD: 'test' });
    expect(doc.services.postgres.healthcheck.test).toEqual(['CMD-SHELL', 'pg_isready -U postgres']);
    expect(doc.services.postgres.healthcheck.retries).toBe(5);
    expect(doc.services.workspace.depends_on).toEqual(['redis', 'postgres']);
  });

  it('should use explicit ports over inferred defaults', async () => {
    const services: Record<string, ProjectServiceConfig> = {
      cache: { image: 'redis:7-alpine', ports: [6380] },
    };

    const result = await generateComposeFile({
      ...baseOptions,
      outputDir,
      services,
    });

    // Should use explicit port 6380, not inferred 6379
    expect(result.serviceEndpoints).toEqual({
      cache: { host: 'cache', port: 6380 },
    });
  });

  it('should infer port from image name when service name is custom', async () => {
    const services: Record<string, ProjectServiceConfig> = {
      'my-cache': { image: 'redis:7-alpine' },
    };

    const result = await generateComposeFile({
      ...baseOptions,
      outputDir,
      services,
    });

    expect(result.serviceEndpoints).toEqual({
      'my-cache': { host: 'my-cache', port: 6379 },
    });
  });

  it('should handle service with no known port', async () => {
    const services: Record<string, ProjectServiceConfig> = {
      custom: { image: 'myorg/custom-service:latest' },
    };

    const result = await generateComposeFile({
      ...baseOptions,
      outputDir,
      services,
    });

    // No port inferred for unknown service
    expect(result.serviceEndpoints).toEqual({});
  });

  it('should create output directory if it does not exist', async () => {
    const nestedDir = join(outputDir, 'nested', 'deep');

    const result = await generateComposeFile({
      ...baseOptions,
      outputDir: nestedDir,
      services: { redis: { image: 'redis:7-alpine' } },
    });

    expect(fs.existsSync(result.filePath)).toBe(true);
  });

  it('should handle volumes in service config', async () => {
    const services: Record<string, ProjectServiceConfig> = {
      postgres: {
        image: 'postgres:15',
        volumes: ['pgdata:/var/lib/postgresql/data'],
      },
    };

    const result = await generateComposeFile({
      ...baseOptions,
      outputDir,
      services,
    });

    const content = fs.readFileSync(result.filePath, 'utf8');
    const doc = yaml.load(content) as any;

    expect(doc.services.postgres.volumes).toEqual(['pgdata:/var/lib/postgresql/data']);
  });
});
