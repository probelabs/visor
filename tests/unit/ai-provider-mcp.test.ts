import { AICheckProvider } from '../../src/providers/ai-check-provider';

describe('AICheckProvider MCP Support', () => {
  let provider: AICheckProvider;

  beforeEach(() => {
    provider = new AICheckProvider();
  });

  describe('validateConfig', () => {
    it('should validate basic AI configuration without MCP', async () => {
      const config = {
        type: 'ai',
        prompt: 'Test prompt',
        ai: {
          provider: 'anthropic',
          model: 'claude-3-sonnet',
        },
      };

      const result = await provider.validateConfig(config);
      expect(result).toBe(true);
    });

    it('should validate AI configuration with valid MCP servers', async () => {
      const config = {
        type: 'ai',
        prompt: 'Test prompt with MCP tools',
        ai: {
          provider: 'anthropic',
          mcpServers: {
            probe: {
              command: 'npx',
              args: ['-y', '@probelabs/probe@latest', 'mcp'],
            },
            filesystem: {
              command: 'npx',
              args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp'],
              env: {
                DEBUG: 'true',
              },
            },
          },
        },
      };

      const result = await provider.validateConfig(config);
      expect(result).toBe(true);
    });

    it('should reject AI configuration with invalid MCP server (missing command)', async () => {
      const config = {
        type: 'ai',
        prompt: 'Test prompt',
        ai: {
          provider: 'anthropic',
          mcpServers: {
            invalid: {
              args: ['some', 'args'],
            },
          },
        },
      };

      const result = await provider.validateConfig(config);
      expect(result).toBe(false);
    });

    it('should reject AI configuration with invalid MCP server (non-array args)', async () => {
      const config = {
        type: 'ai',
        prompt: 'Test prompt',
        ai: {
          provider: 'anthropic',
          mcpServers: {
            invalid: {
              command: 'npx',
              args: 'invalid-args',
            },
          },
        },
      };

      const result = await provider.validateConfig(config);
      expect(result).toBe(false);
    });

    it('should reject AI configuration with non-object mcpServers', async () => {
      const config = {
        type: 'ai',
        prompt: 'Test prompt',
        ai: {
          provider: 'anthropic',
          mcpServers: 'invalid',
        },
      };

      const result = await provider.validateConfig(config);
      expect(result).toBe(false);
    });

    it('should validate check-level MCP servers configuration', async () => {
      const config = {
        type: 'ai',
        prompt: 'Test prompt with check-level MCP',
        ai_mcp_servers: {
          probe: {
            command: 'npx',
            args: ['-y', '@probelabs/probe@latest', 'mcp'],
          },
        },
      };

      const result = await provider.validateConfig(config);
      expect(result).toBe(true);
    });

    it('should reject invalid check-level MCP servers', async () => {
      const config = {
        type: 'ai',
        prompt: 'Test prompt',
        ai_mcp_servers: {
          invalid: {
            args: ['some', 'args'], // Missing command
          },
        },
      };

      const result = await provider.validateConfig(config);
      expect(result).toBe(false);
    });
  });

  describe('getSupportedConfigKeys', () => {
    it('should include MCP-related configuration keys', () => {
      const keys = provider.getSupportedConfigKeys();
      expect(keys).toContain('ai.mcpServers');
      expect(keys).toContain('ai_mcp_servers');
    });
  });
});
