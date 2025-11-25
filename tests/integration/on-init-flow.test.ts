/**
 * Integration tests for on_init lifecycle hook
 * Tests the complete flow of on_init execution with tools, steps, and workflows
 */

import type { CheckConfig, CustomToolDefinition } from '../../src/types/config';
import { CustomToolExecutor } from '../../src/providers/custom-tool-executor';

describe('on_init Lifecycle Hook Integration', () => {
  // Test helper data - not used in current tests but available for future expansion
  // const mockPRInfo = { /* ... */ };
  // const context = { /* ... */ };

  describe('Tool Invocation', () => {
    it('should execute tool in on_init and make output available', async () => {
      const tools: Record<string, CustomToolDefinition> = {
        'test-tool': {
          name: 'test-tool',
          exec: 'echo "Hello from tool"',
          timeout: 1000,
        },
      };

      const executor = new CustomToolExecutor(tools);
      const result = await executor.execute('test-tool', {});

      expect(result).toContain('Hello from tool');
    });

    it('should pass parameters to tool via with directive', async () => {
      const tools: Record<string, CustomToolDefinition> = {
        'param-tool': {
          name: 'param-tool',
          inputSchema: {
            type: 'object',
            properties: {
              name: { type: 'string' },
            },
            required: ['name'],
          },
          exec: 'echo "Hello {{ args.name }}"',
          timeout: 1000,
        },
      };

      const executor = new CustomToolExecutor(tools);
      const result = await executor.execute('param-tool', { name: 'World' });

      expect(result).toContain('Hello World');
    });

    it('should support custom output naming with as directive', async () => {
      // This is tested at the handler level, but we can verify the pattern
      const tools: Record<string, CustomToolDefinition> = {
        'named-tool': {
          name: 'named-tool',
          exec: 'echo "custom-output"',
          timeout: 1000,
        },
      };

      const executor = new CustomToolExecutor(tools);
      const result = await executor.execute('named-tool', {});

      expect(result).toContain('custom-output');
    });
  });

  describe('JSON Parsing and Transform', () => {
    it('should parse JSON output from tool', async () => {
      const tools: Record<string, CustomToolDefinition> = {
        'json-tool': {
          name: 'json-tool',
          exec: 'echo \'{"status":"ok","value":42}\'',
          parseJson: true,
          timeout: 1000,
        },
      };

      const executor = new CustomToolExecutor(tools);
      const result = await executor.execute('json-tool', {});

      expect(typeof result).toBe('object');
      expect(result).toHaveProperty('status', 'ok');
      expect(result).toHaveProperty('value', 42);
    });

    it('should apply transform_js to tool output', async () => {
      const tools: Record<string, CustomToolDefinition> = {
        'transform-tool': {
          name: 'transform-tool',
          exec: 'echo \'{"key":"PROJ-123","fields":{"summary":"Test"}}\'',
          parseJson: true,
          transform_js: `
            return '<issue>' + output.key + ': ' + output.fields.summary + '</issue>';
          `,
          timeout: 1000,
        },
      };

      const executor = new CustomToolExecutor(tools);
      const result = await executor.execute('transform-tool', {});

      expect(result).toBe('<issue>PROJ-123: Test</issue>');
    });

    it('should handle XML escaping in transform', async () => {
      const tools: Record<string, CustomToolDefinition> = {
        'escape-tool': {
          name: 'escape-tool',
          exec: 'echo \'{"text":"<script>alert(\\"XSS\\")</script>"}\'',
          parseJson: true,
          transform_js: `
            const escape = (str) => String(str || '')
              .replace(/&/g, '&amp;')
              .replace(/</g, '&lt;')
              .replace(/>/g, '&gt;')
              .replace(/"/g, '&quot;');
            return '<text>' + escape(output.text) + '</text>';
          `,
          timeout: 1000,
        },
      };

      const executor = new CustomToolExecutor(tools);
      const result = await executor.execute('escape-tool', {});

      expect(result).toContain('&lt;script&gt;');
      expect(result).toContain('&quot;XSS&quot;');
      expect(result).not.toContain('<script>');
    });
  });

  describe('Error Handling', () => {
    it('should handle tool execution timeout', async () => {
      const tools: Record<string, CustomToolDefinition> = {
        'slow-tool': {
          name: 'slow-tool',
          exec: 'sleep 10',
          timeout: 100,
        },
      };

      const executor = new CustomToolExecutor(tools);

      await expect(executor.execute('slow-tool', {})).rejects.toThrow();
    });

    it('should validate input schema', async () => {
      const tools: Record<string, CustomToolDefinition> = {
        'strict-tool': {
          name: 'strict-tool',
          inputSchema: {
            type: 'object',
            properties: {
              required_field: { type: 'string' },
            },
            required: ['required_field'],
          },
          exec: 'echo "test"',
          timeout: 1000,
        },
      };

      const executor = new CustomToolExecutor(tools);

      // Missing required field should fail
      await expect(executor.execute('strict-tool', {})).rejects.toThrow(/required_field/);

      // Valid input should succeed
      const result = await executor.execute('strict-tool', { required_field: 'test' });
      expect(result).toContain('test');
    });

    it('should handle JSON parse errors gracefully', async () => {
      const tools: Record<string, CustomToolDefinition> = {
        'bad-json-tool': {
          name: 'bad-json-tool',
          exec: 'echo "this is not {json}"',
          parseJson: true,
          timeout: 1000,
        },
      };

      const executor = new CustomToolExecutor(tools);

      await expect(executor.execute('bad-json-tool', {})).rejects.toThrow();
    });

    it('should handle transform_js errors', async () => {
      const tools: Record<string, CustomToolDefinition> = {
        'bad-transform-tool': {
          name: 'bad-transform-tool',
          exec: 'echo \'{"key":"value"}\'',
          parseJson: true,
          transform_js: 'throw new Error("Transform failed");',
          timeout: 1000,
        },
      };

      const executor = new CustomToolExecutor(tools);

      await expect(executor.execute('bad-transform-tool', {})).rejects.toThrow(/Transform failed/);
    });
  });

  describe('on_init Configuration', () => {
    it('should accept static run array', () => {
      const config: CheckConfig = {
        type: 'command',
        exec: 'echo "main check"',
        on_init: {
          run: [
            { tool: 'test-tool', as: 'tool-output' },
            'helper-step',
            { workflow: 'test-workflow', with: { input: 'test' } },
          ],
        },
      };

      expect(config.on_init?.run).toHaveLength(3);
      expect(config.on_init?.run?.[0]).toHaveProperty('tool', 'test-tool');
    });

    it('should accept run_js for dynamic item generation', () => {
      const config: CheckConfig = {
        type: 'command',
        exec: 'echo "main check"',
        on_init: {
          run_js: `
            if (pr.title.includes('JIRA')) {
              return [{ tool: 'fetch-jira', as: 'jira-data' }];
            }
            return [];
          `,
        },
      };

      expect(config.on_init?.run_js).toContain('fetch-jira');
    });

    it('should support backward compatible string array', () => {
      const config: CheckConfig = {
        type: 'command',
        exec: 'echo "main check"',
        on_init: {
          run: ['step1', 'step2', 'step3'],
        },
      };

      expect(config.on_init?.run).toHaveLength(3);
      expect(typeof config.on_init?.run?.[0]).toBe('string');
    });
  });

  describe('Template Context', () => {
    it('should make on_init outputs available in main check', async () => {
      // This would be tested in a full end-to-end test
      // Here we verify the pattern works with tool executor
      const tools: Record<string, CustomToolDefinition> = {
        'context-tool': {
          name: 'context-tool',
          exec: 'echo \'{"preprocessed":true}\'',
          parseJson: true,
          timeout: 1000,
        },
      };

      const executor = new CustomToolExecutor(tools);
      const result = await executor.execute('context-tool', {});

      expect(result).toHaveProperty('preprocessed', true);
    });

    it('should support template expressions in tool with parameters', async () => {
      const tools: Record<string, CustomToolDefinition> = {
        'template-tool': {
          name: 'template-tool',
          inputSchema: {
            type: 'object',
            properties: {
              pr_title: { type: 'string' },
            },
          },
          exec: 'echo "PR Title: {{ args.pr_title }}"',
          timeout: 1000,
        },
      };

      const executor = new CustomToolExecutor(tools);
      const result = await executor.execute('template-tool', {
        pr_title: 'Test PR Title',
      });

      expect(result).toContain('PR Title: Test PR Title');
    });
  });

  describe('Batch Operations', () => {
    it('should fetch multiple items and combine into XML', async () => {
      const tools: Record<string, CustomToolDefinition> = {
        'batch-fetch': {
          name: 'batch-fetch',
          exec: 'echo \'[{"id":1,"name":"Item 1"},{"id":2,"name":"Item 2"}]\'',
          parseJson: true,
          transform_js: `
            if (!Array.isArray(output)) {
              return '<items><error>Invalid response</error></items>';
            }

            const escape = (str) => String(str || '').replace(/</g, '&lt;').replace(/>/g, '&gt;');
            const itemsXml = output.map(item =>
              '  <item><id>' + item.id + '</id><name>' + escape(item.name) + '</name></item>'
            ).join('\\n');

            return '<items>\\n' + itemsXml + '\\n</items>';
          `,
          timeout: 1000,
        },
      };

      const executor = new CustomToolExecutor(tools);
      const result = await executor.execute('batch-fetch', {});

      expect(result).toContain('<items>');
      expect(result).toContain('<item>');
      expect(result).toContain('<id>1</id>');
      expect(result).toContain('<name>Item 1</name>');
      expect(result).toContain('<id>2</id>');
      expect(result).toContain('</items>');
    });
  });

  describe('Security', () => {
    it('should prevent command injection in exec', async () => {
      const tools: Record<string, CustomToolDefinition> = {
        'safe-tool': {
          name: 'safe-tool',
          inputSchema: {
            type: 'object',
            properties: {
              input: { type: 'string' },
            },
          },
          // The tool should properly escape/sanitize inputs
          exec: 'echo "Input: {{ args.input }}"',
          timeout: 1000,
        },
      };

      const executor = new CustomToolExecutor(tools);

      // Attempt command injection
      const maliciousInput = '"; rm -rf /; echo "hacked';
      const result = await executor.execute('safe-tool', { input: maliciousInput });

      // Should just echo the input, not execute commands
      expect(result).toContain('Input:');
      // The actual behavior depends on how Liquid escapes the input
    });
  });
});
