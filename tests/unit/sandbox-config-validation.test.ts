import { ConfigManager } from '../../src/config';
import { VisorConfig } from '../../src/types/config';
import * as path from 'path';
import * as fs from 'fs';

describe('Sandbox Config Validation', () => {
  let configManager: ConfigManager;

  beforeEach(() => {
    configManager = new ConfigManager();
  });

  const writeAndLoad = async (config: VisorConfig): Promise<VisorConfig> => {
    const tempFile = path.join(__dirname, `test-sandbox-config-${Date.now()}.yaml`);
    fs.writeFileSync(tempFile, JSON.stringify(config));
    try {
      return await configManager.loadConfig(tempFile);
    } finally {
      fs.unlinkSync(tempFile);
    }
  };

  it('should accept valid sandbox with image mode', async () => {
    const config: VisorConfig = {
      version: '1.0',
      sandboxes: {
        'node-env': {
          image: 'node:20-alpine',
        },
      },
      sandbox: 'node-env',
      checks: {
        lint: {
          type: 'command',
          exec: 'eslint src/',
        },
      },
      output: {
        pr_comment: { format: 'table', group_by: 'check', collapse: false },
      },
    };

    const result = await writeAndLoad(config);
    expect(result.sandboxes).toBeDefined();
    expect(result.sandbox).toBe('node-env');
  });

  it('should accept check-level sandbox override', async () => {
    const config: VisorConfig = {
      version: '1.0',
      sandboxes: {
        'node-env': { image: 'node:20-alpine' },
        'go-env': { image: 'golang:1.22' },
      },
      sandbox: 'node-env',
      checks: {
        lint: {
          type: 'command',
          exec: 'eslint src/',
        },
        'go-test': {
          type: 'command',
          exec: 'go test ./...',
          sandbox: 'go-env',
        },
      },
      output: {
        pr_comment: { format: 'table', group_by: 'check', collapse: false },
      },
    };

    const result = await writeAndLoad(config);
    expect(result.checks['go-test'].sandbox).toBe('go-env');
  });

  it('should reject sandbox with no mode', async () => {
    const config: VisorConfig = {
      version: '1.0',
      sandboxes: {
        'empty-env': {
          workdir: '/workspace',
        },
      },
      checks: {
        lint: {
          type: 'command',
          exec: 'echo test',
        },
      },
      output: {
        pr_comment: { format: 'table', group_by: 'check', collapse: false },
      },
    };

    await expect(writeAndLoad(config)).rejects.toThrow('must specify one of');
  });

  it('should reject sandbox with multiple modes', async () => {
    const config: VisorConfig = {
      version: '1.0',
      sandboxes: {
        'multi-mode': {
          image: 'node:20',
          compose: './docker-compose.yml',
          service: 'app',
        },
      },
      checks: {
        lint: {
          type: 'command',
          exec: 'echo test',
        },
      },
      output: {
        pr_comment: { format: 'table', group_by: 'check', collapse: false },
      },
    };

    await expect(writeAndLoad(config)).rejects.toThrow('multiple modes');
  });

  it('should reject compose mode without service', async () => {
    const config: VisorConfig = {
      version: '1.0',
      sandboxes: {
        'compose-env': {
          compose: './docker-compose.yml',
        },
      },
      checks: {
        lint: {
          type: 'command',
          exec: 'echo test',
        },
      },
      output: {
        pr_comment: { format: 'table', group_by: 'check', collapse: false },
      },
    };

    await expect(writeAndLoad(config)).rejects.toThrow("missing required 'service' field");
  });

  it('should reject reference to undefined sandbox', async () => {
    const config: VisorConfig = {
      version: '1.0',
      sandboxes: {
        'node-env': { image: 'node:20' },
      },
      sandbox: 'nonexistent',
      checks: {
        lint: {
          type: 'command',
          exec: 'echo test',
        },
      },
      output: {
        pr_comment: { format: 'table', group_by: 'check', collapse: false },
      },
    };

    await expect(writeAndLoad(config)).rejects.toThrow('not found in sandboxes');
  });

  it('should reject check-level reference to undefined sandbox', async () => {
    const config: VisorConfig = {
      version: '1.0',
      sandboxes: {
        'node-env': { image: 'node:20' },
      },
      checks: {
        lint: {
          type: 'command',
          exec: 'echo test',
          sandbox: 'nonexistent',
        },
      },
      output: {
        pr_comment: { format: 'table', group_by: 'check', collapse: false },
      },
    };

    await expect(writeAndLoad(config)).rejects.toThrow('not defined');
  });

  it('should reject top-level sandbox when no sandboxes defined', async () => {
    const config: VisorConfig = {
      version: '1.0',
      sandbox: 'node-env',
      checks: {
        lint: {
          type: 'command',
          exec: 'echo test',
        },
      },
      output: {
        pr_comment: { format: 'table', group_by: 'check', collapse: false },
      },
    };

    await expect(writeAndLoad(config)).rejects.toThrow('no sandboxes are defined');
  });

  it('should reject non-absolute cache paths', async () => {
    const config: VisorConfig = {
      version: '1.0',
      sandboxes: {
        'go-env': {
          image: 'golang:1.22',
          cache: {
            paths: ['relative/path', '/absolute/path'],
          },
        },
      },
      checks: {
        lint: {
          type: 'command',
          exec: 'echo test',
        },
      },
      output: {
        pr_comment: { format: 'table', group_by: 'check', collapse: false },
      },
    };

    await expect(writeAndLoad(config)).rejects.toThrow('must be absolute');
  });

  it('should accept valid bind_paths', async () => {
    const config: VisorConfig = {
      version: '1.0',
      sandboxes: {
        'node-env': {
          image: 'node:20-alpine',
          bind_paths: [
            { host: '/home/user/.gitconfig' },
            { host: '~/.ssh', container: '/root/.ssh', read_only: true },
            { host: '/opt/tools', container: '/tools', read_only: false },
          ],
        },
      },
      sandbox: 'node-env',
      checks: {
        lint: { type: 'command', exec: 'echo test' },
      },
      output: {
        pr_comment: { format: 'table', group_by: 'check', collapse: false },
      },
    };

    const result = await writeAndLoad(config);
    expect(result.sandboxes!['node-env'].bind_paths).toHaveLength(3);
  });

  it('should reject bind_paths with path traversal in host', async () => {
    const config: VisorConfig = {
      version: '1.0',
      sandboxes: {
        'node-env': {
          image: 'node:20-alpine',
          bind_paths: [{ host: '/home/user/../etc/shadow' }],
        },
      },
      checks: {
        lint: { type: 'command', exec: 'echo test' },
      },
      output: {
        pr_comment: { format: 'table', group_by: 'check', collapse: false },
      },
    };

    await expect(writeAndLoad(config)).rejects.toThrow('path traversal');
  });

  it('should reject bind_paths with non-absolute container path', async () => {
    const config: VisorConfig = {
      version: '1.0',
      sandboxes: {
        'node-env': {
          image: 'node:20-alpine',
          bind_paths: [{ host: '/home/user/.gitconfig', container: 'relative/path' }],
        },
      },
      checks: {
        lint: { type: 'command', exec: 'echo test' },
      },
      output: {
        pr_comment: { format: 'table', group_by: 'check', collapse: false },
      },
    };

    await expect(writeAndLoad(config)).rejects.toThrow('absolute path');
  });

  it('should accept workdir: "host"', async () => {
    const config: VisorConfig = {
      version: '1.0',
      sandboxes: {
        'node-env': {
          image: 'node:20-alpine',
          workdir: 'host',
        },
      },
      sandbox: 'node-env',
      checks: {
        lint: { type: 'command', exec: 'echo test' },
      },
      output: {
        pr_comment: { format: 'table', group_by: 'check', collapse: false },
      },
    };

    const result = await writeAndLoad(config);
    expect(result.sandboxes!['node-env'].workdir).toBe('host');
  });

  it('should accept visor_path for native engines', async () => {
    const config: VisorConfig = {
      version: '1.0',
      sandboxes: {
        'bwrap-env': {
          engine: 'bubblewrap',
          visor_path: '/custom/visor',
        },
      },
      sandbox: 'bwrap-env',
      checks: {
        lint: { type: 'command', exec: 'echo test' },
      },
      output: {
        pr_comment: { format: 'table', group_by: 'check', collapse: false },
      },
    };

    const result = await writeAndLoad(config);
    expect(result.sandboxes!['bwrap-env'].visor_path).toBe('/custom/visor');
  });

  it('should accept bind_paths for native engines', async () => {
    const config: VisorConfig = {
      version: '1.0',
      sandboxes: {
        'bwrap-env': {
          engine: 'bubblewrap',
          bind_paths: [{ host: '/home/user/.gitconfig' }],
        },
      },
      sandbox: 'bwrap-env',
      checks: {
        lint: { type: 'command', exec: 'echo test' },
      },
      output: {
        pr_comment: { format: 'table', group_by: 'check', collapse: false },
      },
    };

    const result = await writeAndLoad(config);
    expect(result.sandboxes!['bwrap-env'].bind_paths).toHaveLength(1);
  });

  it('should accept config without any sandbox (backward compatible)', async () => {
    const config: VisorConfig = {
      version: '1.0',
      checks: {
        lint: {
          type: 'command',
          exec: 'echo test',
        },
      },
      output: {
        pr_comment: { format: 'table', group_by: 'check', collapse: false },
      },
    };

    const result = await writeAndLoad(config);
    expect(result.sandboxes).toBeUndefined();
    expect(result.sandbox).toBeUndefined();
  });
});
