import {
  workflowInputsToJsonSchema,
  createWorkflowToolDefinition,
  isWorkflowTool,
  isWorkflowToolReference,
  WorkflowToolDefinition,
} from '../../../src/providers/workflow-tool-executor';
import type { WorkflowInputParam, WorkflowDefinition } from '../../../src/types/workflow';
import type { CustomToolDefinition } from '../../../src/types/config';

describe('workflow-tool-executor', () => {
  describe('workflowInputsToJsonSchema', () => {
    it('should return empty schema for undefined inputs', () => {
      const schema = workflowInputsToJsonSchema(undefined);
      expect(schema).toEqual({
        type: 'object',
        properties: {},
        required: [],
      });
    });

    it('should return empty schema for empty inputs array', () => {
      const schema = workflowInputsToJsonSchema([]);
      expect(schema).toEqual({
        type: 'object',
        properties: {},
        required: [],
      });
    });

    it('should convert simple string input', () => {
      const inputs: WorkflowInputParam[] = [
        { name: 'query', description: 'Search query', schema: { type: 'string' } },
      ];
      const schema = workflowInputsToJsonSchema(inputs);
      expect(schema).toEqual({
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query',
          },
        },
        required: ['query'],
      });
    });

    it('should handle input with number type and constraints', () => {
      const inputs: WorkflowInputParam[] = [
        {
          name: 'count',
          schema: {
            type: 'number',
            minimum: 1,
            maximum: 100,
          },
        },
      ];
      const schema = workflowInputsToJsonSchema(inputs);
      expect(schema?.properties).toEqual({
        count: {
          type: 'number',
          minimum: 1,
          maximum: 100,
        },
      });
      expect(schema?.required).toEqual(['count']);
    });

    it('should handle input with enum', () => {
      const inputs: WorkflowInputParam[] = [
        {
          name: 'status',
          schema: {
            type: 'string',
            enum: ['pending', 'active', 'done'],
          },
        },
      ];
      const schema = workflowInputsToJsonSchema(inputs);
      expect(schema?.properties).toEqual({
        status: {
          type: 'string',
          enum: ['pending', 'active', 'done'],
        },
      });
    });

    it('should handle input with default value (not required)', () => {
      const inputs: WorkflowInputParam[] = [
        {
          name: 'limit',
          default: 10,
          schema: { type: 'number' },
        },
      ];
      const schema = workflowInputsToJsonSchema(inputs);
      expect(schema?.properties).toEqual({
        limit: {
          type: 'number',
          default: 10,
        },
      });
      // Input with default is not required
      expect(schema?.required).toBeUndefined();
    });

    it('should handle explicitly optional input', () => {
      const inputs: WorkflowInputParam[] = [
        {
          name: 'optional_field',
          required: false,
          schema: { type: 'string' },
        },
      ];
      const schema = workflowInputsToJsonSchema(inputs);
      expect(schema?.required).toBeUndefined();
    });

    it('should handle complex nested schema', () => {
      const inputs: WorkflowInputParam[] = [
        {
          name: 'config',
          schema: {
            type: 'object',
            properties: {
              enabled: { type: 'boolean' },
              options: { type: 'array', items: { type: 'string' } },
            },
          },
        },
      ];
      const schema = workflowInputsToJsonSchema(inputs);
      expect(schema?.properties).toEqual({
        config: {
          type: 'object',
          properties: {
            enabled: { type: 'boolean' },
            options: { type: 'array', items: { type: 'string' } },
          },
        },
      });
    });

    it('should prefer schema description over input description', () => {
      const inputs: WorkflowInputParam[] = [
        {
          name: 'field',
          description: 'Input level description',
          schema: {
            type: 'string',
            description: 'Schema level description',
          },
        },
      ];
      const schema = workflowInputsToJsonSchema(inputs);
      const props = schema?.properties as Record<string, { description?: string }> | undefined;
      expect(props?.field.description).toBe('Schema level description');
    });

    it('should use input description when schema has none', () => {
      const inputs: WorkflowInputParam[] = [
        {
          name: 'field',
          description: 'Input level description',
          schema: { type: 'string' },
        },
      ];
      const schema = workflowInputsToJsonSchema(inputs);
      const props = schema?.properties as Record<string, { description?: string }> | undefined;
      expect(props?.field.description).toBe('Input level description');
    });
  });

  describe('createWorkflowToolDefinition', () => {
    it('should create tool definition from workflow', () => {
      const workflow: WorkflowDefinition = {
        id: 'test-workflow',
        name: 'Test Workflow',
        description: 'A test workflow',
        inputs: [{ name: 'query', description: 'Search query', schema: { type: 'string' } }],
        steps: {},
      };

      const tool = createWorkflowToolDefinition(workflow);

      expect(tool.name).toBe('test-workflow');
      expect(tool.description).toBe('A test workflow');
      expect(tool.__isWorkflowTool).toBe(true);
      expect(tool.__workflowId).toBe('test-workflow');
      expect(tool.inputSchema?.properties).toHaveProperty('query');
    });

    it('should use default description when workflow has none', () => {
      const workflow: WorkflowDefinition = {
        id: 'my-workflow',
        name: 'My Workflow',
        steps: {},
      };

      const tool = createWorkflowToolDefinition(workflow);
      expect(tool.description).toBe('Execute the My Workflow workflow');
    });

    it('should remove pre-filled args from schema', () => {
      const workflow: WorkflowDefinition = {
        id: 'parameterized-workflow',
        name: 'Parameterized',
        inputs: [
          { name: 'fixed_param', schema: { type: 'string' } },
          { name: 'user_param', schema: { type: 'string' } },
        ],
        steps: {},
      };

      const argsOverrides = { fixed_param: 'preset-value' };
      const tool = createWorkflowToolDefinition(workflow, argsOverrides);

      expect(tool.inputSchema?.properties).not.toHaveProperty('fixed_param');
      expect(tool.inputSchema?.properties).toHaveProperty('user_param');
      expect(tool.__argsOverrides).toEqual(argsOverrides);
    });

    it('should remove pre-filled args from required array', () => {
      const workflow: WorkflowDefinition = {
        id: 'required-params-workflow',
        name: 'Required Params',
        inputs: [
          { name: 'required1', schema: { type: 'string' } },
          { name: 'required2', schema: { type: 'string' } },
        ],
        steps: {},
      };

      const argsOverrides = { required1: 'value' };
      const tool = createWorkflowToolDefinition(workflow, argsOverrides);

      expect(tool.inputSchema?.required).toEqual(['required2']);
    });

    it('should not mutate the original workflow when using argsOverrides', () => {
      const workflow: WorkflowDefinition = {
        id: 'mutation-test-workflow',
        name: 'Mutation Test',
        inputs: [
          { name: 'param1', schema: { type: 'string' } },
          { name: 'param2', schema: { type: 'string' } },
        ],
        steps: {},
      };

      // Create first tool with overrides
      const tool1 = createWorkflowToolDefinition(workflow, { param1: 'value1' });

      // Create second tool with different overrides
      const tool2 = createWorkflowToolDefinition(workflow, { param2: 'value2' });

      // Verify tool1 doesn't have param1 but has param2
      expect(tool1.inputSchema?.properties).not.toHaveProperty('param1');
      expect(tool1.inputSchema?.properties).toHaveProperty('param2');

      // Verify tool2 doesn't have param2 but has param1
      expect(tool2.inputSchema?.properties).toHaveProperty('param1');
      expect(tool2.inputSchema?.properties).not.toHaveProperty('param2');

      // Verify the original workflow still has both inputs
      expect(workflow.inputs).toHaveLength(2);
      expect(workflow.inputs?.[0].name).toBe('param1');
      expect(workflow.inputs?.[1].name).toBe('param2');
    });
  });

  describe('isWorkflowTool', () => {
    it('should return true for workflow tool', () => {
      const workflowTool: WorkflowToolDefinition = {
        name: 'test',
        description: 'test',
        inputSchema: { type: 'object', properties: {} },
        exec: '',
        __isWorkflowTool: true,
        __workflowId: 'test-workflow',
      };
      expect(isWorkflowTool(workflowTool)).toBe(true);
    });

    it('should return false for regular tool', () => {
      const regularTool: CustomToolDefinition = {
        name: 'test',
        description: 'test',
        inputSchema: { type: 'object', properties: {} },
        exec: 'echo hello',
      };
      expect(isWorkflowTool(regularTool)).toBe(false);
    });

    it('should return false for tool with __isWorkflowTool=false', () => {
      const tool = {
        name: 'test',
        description: 'test',
        inputSchema: { type: 'object', properties: {} },
        exec: '',
        __isWorkflowTool: false,
      };
      expect(isWorkflowTool(tool as CustomToolDefinition)).toBe(false);
    });
  });

  describe('isWorkflowToolReference', () => {
    it('should return true for workflow reference object', () => {
      expect(isWorkflowToolReference({ workflow: 'my-workflow' })).toBe(true);
    });

    it('should return true for workflow reference with args', () => {
      expect(isWorkflowToolReference({ workflow: 'my-workflow', args: { foo: 'bar' } })).toBe(true);
    });

    it('should return false for string', () => {
      expect(isWorkflowToolReference('my-workflow')).toBe(false);
    });

    it('should return false for null', () => {
      expect(isWorkflowToolReference(null as any)).toBe(false);
    });

    it('should return false for object without workflow property', () => {
      expect(isWorkflowToolReference({ name: 'not-a-workflow' } as any)).toBe(false);
    });
  });
});
