import { McpCheckProvider } from '../../src/providers/mcp-check-provider';
import { EnvironmentResolver } from '../../src/utils/env-resolver';

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
      expect(description).toContain('HTTP');
      expect(description).toContain('custom');
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

    describe('custom transport', () => {
      it('should accept custom transport with method', async () => {
        const config = {
          type: 'mcp',
          transport: 'custom',
          method: 'my-custom-tool',
        };

        const result = await provider.validateConfig(config);
        expect(result).toBe(true);
      });

      it('should reject custom transport without method', async () => {
        const config = {
          type: 'mcp',
          transport: 'custom',
        };

        const result = await provider.validateConfig(config);
        expect(result).toBe(false);
      });

      it('should accept custom transport with methodArgs', async () => {
        const config = {
          type: 'mcp',
          transport: 'custom',
          method: 'my-custom-tool',
          methodArgs: {
            param1: 'value1',
            param2: 123,
          },
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

  describe('header environment variable resolution', () => {
    beforeEach(() => {
      // Set up test environment variables
      process.env.TEST_API_KEY = 'test-key-123';
      process.env.TEST_TOKEN = 'test-token-456';
    });

    afterEach(() => {
      // Clean up test environment variables
      delete process.env.TEST_API_KEY;
      delete process.env.TEST_TOKEN;
    });

    it('should resolve shell-style environment variables in headers', () => {
      const headers = {
        Authorization: 'Bearer ${TEST_API_KEY}',
        'X-Custom': '${TEST_TOKEN}',
      };

      const resolved = EnvironmentResolver.resolveHeaders(headers);

      expect(resolved.Authorization).toBe('Bearer test-key-123');
      expect(resolved['X-Custom']).toBe('test-token-456');
    });

    it('should resolve simple shell-style environment variables in headers', () => {
      const headers = {
        Authorization: 'Bearer $TEST_API_KEY',
      };

      const resolved = EnvironmentResolver.resolveHeaders(headers);

      expect(resolved.Authorization).toBe('Bearer test-key-123');
    });

    it('should resolve GitHub Actions-style environment variables in headers', () => {
      const headers = {
        Authorization: 'Bearer ${{ env.TEST_API_KEY }}',
      };

      const resolved = EnvironmentResolver.resolveHeaders(headers);

      expect(resolved.Authorization).toBe('Bearer test-key-123');
    });

    it('should handle mixed environment variable syntaxes in headers', () => {
      const headers = {
        'X-Key1': '${TEST_API_KEY}',
        'X-Key2': '$TEST_TOKEN',
        'X-Key3': '${{ env.TEST_API_KEY }}',
      };

      const resolved = EnvironmentResolver.resolveHeaders(headers);

      expect(resolved['X-Key1']).toBe('test-key-123');
      expect(resolved['X-Key2']).toBe('test-token-456');
      expect(resolved['X-Key3']).toBe('test-key-123');
    });

    it('should leave unresolved variables as-is when environment variable is missing', () => {
      const headers = {
        Authorization: 'Bearer ${NONEXISTENT_VAR}',
      };

      const resolved = EnvironmentResolver.resolveHeaders(headers);

      expect(resolved.Authorization).toBe('Bearer ${NONEXISTENT_VAR}');
    });

    it('should handle headers without environment variables', () => {
      const headers = {
        'Content-Type': 'application/json',
        'X-Static': 'static-value',
      };

      const resolved = EnvironmentResolver.resolveHeaders(headers);

      expect(resolved['Content-Type']).toBe('application/json');
      expect(resolved['X-Static']).toBe('static-value');
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
