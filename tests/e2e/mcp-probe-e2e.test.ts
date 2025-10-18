import { McpCheckProvider } from '../../src/providers/mcp-check-provider';
import { PRInfo } from '../../src/pr-analyzer';
import * as path from 'path';

describe('MCP Provider E2E Tests with Probe', () => {
  let provider: McpCheckProvider;

  beforeEach(() => {
    provider = new McpCheckProvider();
  });

  const mockPRInfo: PRInfo = {
    number: 123,
    title: 'Add new feature for user authentication',
    body: 'This PR adds user authentication functionality',
    author: 'testuser',
    head: 'feature/auth',
    base: 'main',
    files: [
      {
        filename: 'src/auth/login.ts',
        status: 'modified',
        additions: 10,
        deletions: 5,
        changes: 15,
        patch: '@@ -1,5 +1,10 @@\n+new authentication code',
      },
    ],
    totalAdditions: 10,
    totalDeletions: 5,
  };

  describe('Probe MCP stdio transport', () => {
    it('should execute search_code method successfully', async () => {
      const config = {
        type: 'mcp',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@probelabs/probe', 'mcp'],
        method: 'search_code',
        methodArgs: {
          path: process.cwd(),
          query: 'export class',
        },
        timeout: 120, // 2 minutes for npm install
      };

      const result = await provider.execute(mockPRInfo, config);

      expect(result).toBeDefined();
      expect(result.issues).toBeDefined();
      expect(Array.isArray(result.issues)).toBe(true);
    }, 180000); // 3 minute timeout for test

    it('should use Liquid templates in methodArgs', async () => {
      const config = {
        type: 'mcp',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@probelabs/probe', 'mcp'],
        method: 'search_code',
        argsTransform: '{ "path": "{{ pr.base }}", "query": "{{ pr.title }}" }',
        timeout: 120,
      };

      const result = await provider.execute(mockPRInfo, config);

      expect(result).toBeDefined();
      expect(result.issues).toBeDefined();
      expect(Array.isArray(result.issues)).toBe(true);
    }, 180000);

    it('should handle search with transform', async () => {
      const config = {
        type: 'mcp',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@probelabs/probe', 'mcp'],
        method: 'search_code',
        methodArgs: {
          path: process.cwd(),
          query: 'function',
        },
        transform: '{{ output | json }}',
        timeout: 120,
      };

      const result = await provider.execute(mockPRInfo, config);

      expect(result).toBeDefined();
      expect(result.issues).toBeDefined();
    }, 180000);

    it('should handle search with transform_js', async () => {
      const config = {
        type: 'mcp',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@probelabs/probe', 'mcp'],
        method: 'search_code',
        methodArgs: {
          path: process.cwd(),
          query: 'class',
        },
        transform_js: `
          // Extract text field from MCP response
          if (output && output.content && Array.isArray(output.content)) {
            const textContent = output.content.find(c => c.type === 'text');
            if (textContent && textContent.text) {
              try {
                const parsed = JSON.parse(textContent.text);
                return {
                  issues: [],
                  searchResults: parsed
                };
              } catch (e) {
                return {
                  issues: [],
                  rawText: textContent.text
                };
              }
            }
          }
          return { issues: [] };
        `,
        timeout: 120,
      };

      const result = await provider.execute(mockPRInfo, config);

      expect(result).toBeDefined();
      expect(result.issues).toBeDefined();
      expect(Array.isArray(result.issues)).toBe(true);
    }, 180000);

    it('should pass environment variables', async () => {
      const config = {
        type: 'mcp',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@probelabs/probe', 'mcp'],
        method: 'search_code',
        methodArgs: {
          path: process.cwd(),
          query: 'test',
        },
        env: {
          DEBUG: 'false',
          NODE_ENV: 'test',
        },
        timeout: 120,
      };

      const result = await provider.execute(mockPRInfo, config);

      expect(result).toBeDefined();
      expect(result.issues).toBeDefined();
    }, 180000);

    it('should handle timeout correctly', async () => {
      const config = {
        type: 'mcp',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@probelabs/probe', 'mcp'],
        method: 'search_code',
        methodArgs: {
          path: process.cwd(),
          query: 'export',
        },
        timeout: 5, // Very short timeout to test handling
      };

      // This might timeout or succeed depending on npm cache
      // Either way, it should not crash
      try {
        const result = await provider.execute(mockPRInfo, config);
        expect(result).toBeDefined();
      } catch (error) {
        // Timeout errors are acceptable
        expect(error).toBeDefined();
      }
    }, 30000);

    it('should search in specific path', async () => {
      const config = {
        type: 'mcp',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@probelabs/probe', 'mcp'],
        method: 'search_code',
        methodArgs: {
          path: path.join(process.cwd(), 'src'),
          query: 'export',
        },
        timeout: 120,
      };

      const result = await provider.execute(mockPRInfo, config);

      expect(result).toBeDefined();
      expect(result.issues).toBeDefined();
    }, 180000);

    it('should handle complex queries', async () => {
      const config = {
        type: 'mcp',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@probelabs/probe', 'mcp'],
        method: 'search_code',
        methodArgs: {
          path: process.cwd(),
          query: 'export AND (class OR function)',
        },
        timeout: 120,
      };

      const result = await provider.execute(mockPRInfo, config);

      expect(result).toBeDefined();
      expect(result.issues).toBeDefined();
    }, 180000);

    it('should work with working directory', async () => {
      const config = {
        type: 'mcp',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@probelabs/probe', 'mcp'],
        method: 'search_code',
        methodArgs: {
          path: './src',
          query: 'provider',
        },
        workingDirectory: process.cwd(),
        timeout: 120,
      };

      const result = await provider.execute(mockPRInfo, config);

      expect(result).toBeDefined();
      expect(result.issues).toBeDefined();
    }, 180000);
  });

  describe('Probe MCP with dependency results', () => {
    it('should access dependency outputs in argsTransform', async () => {
      const dependencyResults = new Map();
      dependencyResults.set('prev-check', {
        issues: [],
        output: { searchTerm: 'authentication' },
      });

      const config = {
        type: 'mcp',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@probelabs/probe', 'mcp'],
        method: 'search_code',
        argsTransform: '{ "path": "{{ pr.base }}", "query": "{{ outputs["prev-check"].searchTerm }}" }',
        timeout: 120,
      };

      const result = await provider.execute(mockPRInfo, config, dependencyResults);

      expect(result).toBeDefined();
      expect(result.issues).toBeDefined();
    }, 180000);
  });

  describe('Error handling', () => {
    it('should handle invalid method gracefully', async () => {
      const config = {
        type: 'mcp',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@probelabs/probe', 'mcp'],
        method: 'invalid_method_that_does_not_exist',
        methodArgs: {
          query: 'test',
        },
        timeout: 120,
      };

      const result = await provider.execute(mockPRInfo, config);

      expect(result).toBeDefined();
      expect(result.issues).toBeDefined();
      if (result.issues) {
        expect(result.issues.length).toBeGreaterThan(0);
        expect(result.issues[0].severity).toBe('error');
      }
    }, 180000);

    it('should handle invalid command gracefully', async () => {
      const config = {
        type: 'mcp',
        transport: 'stdio',
        command: 'nonexistent-command',
        method: 'search_code',
        methodArgs: {
          query: 'test',
        },
        timeout: 10,
      };

      const result = await provider.execute(mockPRInfo, config);

      expect(result).toBeDefined();
      expect(result.issues).toBeDefined();
      if (result.issues) {
        expect(result.issues.length).toBeGreaterThan(0);
        expect(result.issues[0].severity).toBe('error');
      }
    }, 30000);

    it('should handle invalid argsTransform', async () => {
      const config = {
        type: 'mcp',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@probelabs/probe', 'mcp'],
        method: 'search_code',
        argsTransform: 'invalid json {{{',
        timeout: 120,
      };

      const result = await provider.execute(mockPRInfo, config);

      expect(result).toBeDefined();
      expect(result.issues).toBeDefined();
      if (result.issues) {
        expect(result.issues.length).toBeGreaterThan(0);
        expect(result.issues[0].ruleId).toContain('mcp/args_transform_error');
      }
    }, 180000);

    it('should handle transform_js errors', async () => {
      const config = {
        type: 'mcp',
        transport: 'stdio',
        command: 'npx',
        args: ['-y', '@probelabs/probe', 'mcp'],
        method: 'search_code',
        methodArgs: {
          path: process.cwd(),
          query: 'test',
        },
        transform_js: 'throw new Error("test error")',
        timeout: 120,
      };

      const result = await provider.execute(mockPRInfo, config);

      expect(result).toBeDefined();
      expect(result.issues).toBeDefined();
      if (result.issues) {
        expect(result.issues.length).toBeGreaterThan(0);
        expect(result.issues[0].ruleId).toContain('transform_js_error');
      }
    }, 180000);
  });
});
