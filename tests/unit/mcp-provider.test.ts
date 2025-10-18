import { McpCheckProvider } from '../../src/providers/mcp-check-provider';

describe('MCP Check Provider', () => {
  let provider: McpCheckProvider;

  beforeEach(() => {
    provider = new McpCheckProvider();
  });

  describe('basic properties', () => {
    it('should have correct name', () => {
      expect(provider.getName()).toBe('mcp');
    });

    it('should have correct description', () => {
      const description = provider.getDescription();
      expect(description).toContain('stdio');
      expect(description).toContain('SSE');
      expect(description).toContain('Streamable HTTP');
    });

    it('should be available', async () => {
      const available = await provider.isAvailable();
      expect(available).toBe(true);
    });

    it('should list requirements', () => {
      const requirements = provider.getRequirements();
      expect(requirements).toContain('MCP method name specified');
      expect(requirements.some(r => r.includes('Transport configuration'))).toBe(true);
    });

    it('should list supported config keys', () => {
      const keys = provider.getSupportedConfigKeys();
      expect(keys).toContain('type');
      expect(keys).toContain('transport');
      expect(keys).toContain('command');
      expect(keys).toContain('url');
      expect(keys).toContain('method');
      expect(keys).toContain('methodArgs');
      expect(keys).toContain('headers');
      expect(keys).toContain('sessionId');
      expect(keys).toContain('transform');
      expect(keys).toContain('transform_js');
    });
  });

  describe('validateConfig', () => {
    describe('stdio transport', () => {
      it('should validate valid stdio config', async () => {
        const config = {
          type: 'mcp',
          transport: 'stdio',
          command: 'npx',
          args: ['-y', '@probelabs/probe', 'mcp'],
          method: 'search_code',
          methodArgs: {
            query: 'test',
          },
        };

        const result = await provider.validateConfig(config);
        expect(result).toBe(true);
      });

      it('should reject stdio config without command', async () => {
        const config = {
          type: 'mcp',
          transport: 'stdio',
          method: 'search_code',
        };

        const result = await provider.validateConfig(config);
        expect(result).toBe(false);
      });

      it('should reject stdio config without method', async () => {
        const config = {
          type: 'mcp',
          transport: 'stdio',
          command: 'npx',
        };

        const result = await provider.validateConfig(config);
        expect(result).toBe(false);
      });
    });

    describe('sse transport', () => {
      it('should validate valid sse config', async () => {
        const config = {
          type: 'mcp',
          transport: 'sse',
          url: 'https://mcp-server.example.com',
          method: 'search_code',
          headers: {
            Authorization: 'Bearer token',
          },
        };

        const result = await provider.validateConfig(config);
        expect(result).toBe(true);
      });

      it('should reject sse config without url', async () => {
        const config = {
          type: 'mcp',
          transport: 'sse',
          method: 'search_code',
        };

        const result = await provider.validateConfig(config);
        expect(result).toBe(false);
      });
    });

    describe('http transport', () => {
      it('should validate valid http config', async () => {
        const config = {
          type: 'mcp',
          transport: 'http',
          url: 'https://mcp-server.example.com/mcp',
          method: 'search_code',
          headers: {
            Authorization: 'Bearer token',
          },
          sessionId: 'session-123',
        };

        const result = await provider.validateConfig(config);
        expect(result).toBe(true);
      });

      it('should reject http config without url', async () => {
        const config = {
          type: 'mcp',
          transport: 'http',
          method: 'search_code',
        };

        const result = await provider.validateConfig(config);
        expect(result).toBe(false);
      });

      it('should validate http config without optional sessionId', async () => {
        const config = {
          type: 'mcp',
          transport: 'http',
          url: 'https://mcp-server.example.com/mcp',
          method: 'search_code',
        };

        const result = await provider.validateConfig(config);
        expect(result).toBe(true);
      });
    });

    describe('invalid transport', () => {
      it('should reject invalid transport type', async () => {
        const config = {
          type: 'mcp',
          transport: 'invalid',
          method: 'search_code',
        };

        const result = await provider.validateConfig(config);
        expect(result).toBe(false);
      });
    });

    describe('default transport', () => {
      it('should default to stdio when transport not specified', async () => {
        const config = {
          type: 'mcp',
          command: 'npx',
          method: 'search_code',
        };

        const result = await provider.validateConfig(config);
        expect(result).toBe(true);
      });
    });
  });

  describe('execute with mock data', () => {
    it('should handle timeout configuration', async () => {
      const config = {
        type: 'mcp',
        transport: 'stdio',
        command: 'echo',
        args: ['test'],
        method: 'search_code',
        timeout: 1, // 1 second
      };

      // This test just verifies the config is accepted
      // Actual execution would require a real MCP server
      await expect(provider.validateConfig(config)).resolves.toBe(true);
    });

    it('should accept transform configuration', async () => {
      const config = {
        type: 'mcp',
        transport: 'stdio',
        command: 'npx',
        method: 'search_code',
        transform: '{{ output | json }}',
      };

      await expect(provider.validateConfig(config)).resolves.toBe(true);
    });

    it('should accept transform_js configuration', async () => {
      const config = {
        type: 'mcp',
        transport: 'stdio',
        command: 'npx',
        method: 'search_code',
        transform_js: 'output.results',
      };

      await expect(provider.validateConfig(config)).resolves.toBe(true);
    });

    it('should accept argsTransform configuration', async () => {
      const config = {
        type: 'mcp',
        transport: 'stdio',
        command: 'npx',
        method: 'search_code',
        argsTransform: '{ "query": "{{ pr.title }}" }',
      };

      await expect(provider.validateConfig(config)).resolves.toBe(true);
    });

    it('should accept env variables for stdio', async () => {
      const config = {
        type: 'mcp',
        transport: 'stdio',
        command: 'npx',
        method: 'search_code',
        env: {
          API_KEY: 'test-key',
          DEBUG: 'true',
        },
      };

      await expect(provider.validateConfig(config)).resolves.toBe(true);
    });

    it('should accept working directory for stdio', async () => {
      const config = {
        type: 'mcp',
        transport: 'stdio',
        command: 'npx',
        method: 'search_code',
        workingDirectory: '/tmp/test',
      };

      await expect(provider.validateConfig(config)).resolves.toBe(true);
    });
  });
});
