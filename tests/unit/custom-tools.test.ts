import { CustomToolExecutor } from '../../src/providers/custom-tool-executor';
import { CustomToolDefinition } from '../../src/types/config';

describe('CustomToolExecutor', () => {
  let executor: CustomToolExecutor;

  beforeEach(() => {
    executor = new CustomToolExecutor();
  });

  describe('tool registration', () => {
    it('should register a custom tool', () => {
      const tool: CustomToolDefinition = {
        name: 'test-tool',
        description: 'A test tool',
        exec: 'echo "hello"',
      };

      executor.registerTool(tool);
      const registeredTool = executor.getTool('test-tool');

      expect(registeredTool).toBeDefined();
      expect(registeredTool?.name).toBe('test-tool');
      expect(registeredTool?.description).toBe('A test tool');
    });

    it('should register multiple tools', () => {
      const tools: Record<string, CustomToolDefinition> = {
        tool1: {
          name: 'tool1',
          exec: 'echo "tool1"',
        },
        tool2: {
          name: 'tool2',
          exec: 'echo "tool2"',
        },
      };

      executor.registerTools(tools);

      expect(executor.getTools()).toHaveLength(2);
      expect(executor.getTool('tool1')).toBeDefined();
      expect(executor.getTool('tool2')).toBeDefined();
    });

    it('should throw error when registering tool without name', () => {
      const tool: CustomToolDefinition = {
        name: '',
        exec: 'echo "test"',
      };

      expect(() => executor.registerTool(tool)).toThrow('Tool must have a name');
    });
  });

  describe('input validation', () => {
    it('should validate required fields', async () => {
      const tool: CustomToolDefinition = {
        name: 'validate-tool',
        exec: 'echo "test"',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            age: { type: 'number' },
          },
          required: ['name'],
        },
      };

      executor.registerTool(tool);

      // Missing required field should throw
      await expect(executor.execute('validate-tool', { age: 25 }, {})).rejects.toThrow(
        "Input validation failed for tool 'validate-tool': must have required property 'name'"
      );

      // With required field should work
      await expect(
        executor.execute('validate-tool', { name: 'John', age: 25 }, {})
      ).resolves.toBeDefined();
    });

    it('should reject unknown properties when additionalProperties is false', async () => {
      const tool: CustomToolDefinition = {
        name: 'strict-tool',
        exec: 'echo "test"',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
          },
          additionalProperties: false,
        },
      };

      executor.registerTool(tool);

      await expect(
        executor.execute('strict-tool', { name: 'John', extra: 'field' }, {})
      ).rejects.toThrow('Input validation failed');
    });

    it('should validate data types according to JSON Schema', async () => {
      const tool: CustomToolDefinition = {
        name: 'typed-tool',
        exec: 'echo "test"',
        inputSchema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            age: { type: 'number' },
            active: { type: 'boolean' },
            tags: {
              type: 'array',
              items: { type: 'string' },
            },
          },
          required: ['name', 'age'],
        },
      };

      executor.registerTool(tool);

      // Invalid: age is string instead of number
      await expect(executor.execute('typed-tool', { name: 'John', age: '25' }, {})).rejects.toThrow(
        'Input validation failed'
      );

      // Invalid: active is string instead of boolean
      await expect(
        executor.execute('typed-tool', { name: 'John', age: 25, active: 'yes' }, {})
      ).rejects.toThrow('Input validation failed');

      // Invalid: tags contains numbers instead of strings
      await expect(
        executor.execute('typed-tool', { name: 'John', age: 25, tags: [1, 2, 3] }, {})
      ).rejects.toThrow('Input validation failed');

      // Valid: all types are correct
      await expect(
        executor.execute(
          'typed-tool',
          { name: 'John', age: 25, active: true, tags: ['a', 'b'] },
          {}
        )
      ).resolves.toBeDefined();
    });
  });

  describe('tool execution', () => {
    it('should execute a simple command', async () => {
      const tool: CustomToolDefinition = {
        name: 'echo-tool',
        exec: 'echo "Hello World"',
      };

      executor.registerTool(tool);
      const result = await executor.execute('echo-tool', {}, {});

      expect(result).toContain('Hello World');
    });

    it('should pass arguments via Liquid templates', async () => {
      const tool: CustomToolDefinition = {
        name: 'greet-tool',
        exec: 'echo "Hello {{ args.name }}"',
      };

      executor.registerTool(tool);
      const result = await executor.execute('greet-tool', { name: 'Alice' }, {});

      expect(result).toContain('Hello Alice');
    });

    it('should handle stdin input', async () => {
      const tool: CustomToolDefinition = {
        name: 'cat-tool',
        exec: 'cat',
        stdin: 'Input from stdin: {{ args.message }}',
      };

      executor.registerTool(tool);
      const result = await executor.execute('cat-tool', { message: 'test message' }, {});

      expect(result).toContain('Input from stdin: test message');
    });

    it('should parse JSON output when requested', async () => {
      const tool: CustomToolDefinition = {
        name: 'json-tool',
        exec: 'echo \'{"status": "success", "count": 42}\'',
        parseJson: true,
      };

      executor.registerTool(tool);
      const result = await executor.execute('json-tool', {}, {});

      expect(result).toEqual({ status: 'success', count: 42 });
    });

    it('should apply Liquid transform to output', async () => {
      const tool: CustomToolDefinition = {
        name: 'transform-tool',
        exec: 'echo "raw output"',
        transform: '{ "processed": "{{ output | strip }}" }',
        parseJson: true,
      };

      executor.registerTool(tool);
      const result = await executor.execute('transform-tool', {}, {});

      expect(result).toEqual({ processed: 'raw output' });
    });

    it('should apply JavaScript transform to output', async () => {
      const tool: CustomToolDefinition = {
        name: 'js-transform-tool',
        exec: 'echo "10"',
        transform_js: 'return parseInt(output.trim()) * 2;',
      };

      executor.registerTool(tool);
      const result = await executor.execute('js-transform-tool', {}, {});

      expect(result).toBe(20);
    });

    it('should handle command timeout', async () => {
      const tool: CustomToolDefinition = {
        name: 'slow-tool',
        exec: 'sleep 5',
        timeout: 100, // 100ms timeout
      };

      executor.registerTool(tool);

      // The command should throw a timeout error
      await expect(executor.execute('slow-tool', {}, {})).rejects.toThrow(
        'Command timed out after 100ms'
      );
    });

    it('should throw error for non-existent tool', async () => {
      await expect(executor.execute('non-existent', {}, {})).rejects.toThrow(
        'Tool not found: non-existent'
      );
    });
  });

  describe('context usage', () => {
    it('should provide PR context to tools', async () => {
      const tool: CustomToolDefinition = {
        name: 'pr-tool',
        exec: 'echo "PR #{{ pr.number }}: {{ pr.title }}"',
      };

      executor.registerTool(tool);
      const result = await executor.execute(
        'pr-tool',
        {},
        {
          pr: {
            number: 123,
            title: 'Add new feature',
            author: 'john',
            branch: 'feature/test',
            base: 'main',
          },
        }
      );

      expect(result).toContain('PR #123: Add new feature');
    });

    it('should provide file list to tools', async () => {
      const tool: CustomToolDefinition = {
        name: 'file-tool',
        exec: 'echo "Files: {{ files | size }}"',
      };

      executor.registerTool(tool);
      const result = await executor.execute(
        'file-tool',
        {},
        {
          files: ['file1.js', 'file2.ts', 'file3.py'],
        }
      );

      expect(result).toContain('Files: 3');
    });

    it('should provide outputs from previous checks', async () => {
      const tool: CustomToolDefinition = {
        name: 'output-tool',
        exec: 'echo "Previous result: {{ outputs.check1 }}"',
      };

      executor.registerTool(tool);
      const result = await executor.execute(
        'output-tool',
        {},
        {
          outputs: {
            check1: 'success',
            check2: 'pending',
          },
        }
      );

      expect(result).toContain('Previous result: success');
    });
  });

  describe('MCP tool conversion', () => {
    it('should convert custom tools to MCP tool format', () => {
      const tools: Record<string, CustomToolDefinition> = {
        tool1: {
          name: 'tool1',
          description: 'First tool',
          exec: 'echo "tool1"',
          inputSchema: {
            type: 'object',
            properties: {
              param: { type: 'string' },
            },
          },
        },
        tool2: {
          name: 'tool2',
          description: 'Second tool',
          exec: 'echo "tool2"',
        },
      };

      executor.registerTools(tools);
      const mcpTools = executor.toMcpTools();

      expect(mcpTools).toHaveLength(2);
      expect(mcpTools[0].name).toBe('tool1');
      expect(mcpTools[0].description).toBe('First tool');
      expect(mcpTools[0].inputSchema).toBeDefined();
      expect(mcpTools[0].handler).toBeDefined();

      expect(mcpTools[1].name).toBe('tool2');
      expect(mcpTools[1].description).toBe('Second tool');
    });

    it('should execute through MCP tool handler', async () => {
      const tool: CustomToolDefinition = {
        name: 'handler-tool',
        exec: 'echo "Result: {{ args.value }}"',
      };

      executor.registerTool(tool);
      const mcpTools = executor.toMcpTools();
      const handler = mcpTools[0].handler;

      const result = await handler({ value: 'test' });
      expect(result).toContain('Result: test');
    });
  });
});
