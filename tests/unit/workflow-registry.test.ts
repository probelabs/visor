/**
 * Unit tests for WorkflowRegistry
 */

import { WorkflowRegistry } from '../../src/workflow-registry';
import { WorkflowDefinition } from '../../src/types/workflow';
import * as fs from 'fs';
import * as yaml from 'js-yaml';

// Mock fs and fetch
jest.mock('fs', () => ({
  promises: {
    readFile: jest.fn(),
  },
}));

global.fetch = jest.fn();

describe('WorkflowRegistry', () => {
  let registry: WorkflowRegistry;

  beforeEach(() => {
    // Get a fresh instance for each test
    (WorkflowRegistry as any).instance = undefined;
    registry = WorkflowRegistry.getInstance();
  });

  afterEach(() => {
    registry.clear();
    jest.clearAllMocks();
  });

  describe('singleton pattern', () => {
    it('should return the same instance', () => {
      const instance1 = WorkflowRegistry.getInstance();
      const instance2 = WorkflowRegistry.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe('register', () => {
    it('should register a valid workflow', () => {
      const workflow: WorkflowDefinition = {
        id: 'test-workflow',
        name: 'Test Workflow',
        steps: {
          step1: {
            type: 'ai',
            prompt: 'Test prompt',
          },
        },
      };

      const result = registry.register(workflow);
      expect(result.valid).toBe(true);
      expect(registry.has('test-workflow')).toBe(true);
    });

    it('should reject workflow without ID', () => {
      const workflow = {
        name: 'Test Workflow',
        steps: {
          step1: {
            type: 'ai',
            prompt: 'Test prompt',
          },
        },
      } as any;

      const result = registry.register(workflow);
      expect(result.valid).toBe(false);
      expect(result.errors?.[0].message).toContain('ID is required');
    });

    it('should reject workflow without steps', () => {
      const workflow: WorkflowDefinition = {
        id: 'test-workflow',
        name: 'Test Workflow',
        steps: {},
      };

      const result = registry.register(workflow);
      expect(result.valid).toBe(false);
      expect(result.errors?.[0].message).toContain('at least one step');
    });

    it('should reject duplicate workflow ID without override', () => {
      const workflow: WorkflowDefinition = {
        id: 'test-workflow',
        name: 'Test Workflow',
        steps: {
          step1: {
            type: 'ai',
            prompt: 'Test prompt',
          },
        },
      };

      registry.register(workflow);
      const result = registry.register(workflow);

      expect(result.valid).toBe(false);
      expect(result.errors?.[0].message).toContain('already exists');
    });

    it('should allow override with flag', () => {
      const workflow: WorkflowDefinition = {
        id: 'test-workflow',
        name: 'Test Workflow',
        steps: {
          step1: {
            type: 'ai',
            prompt: 'Test prompt',
          },
        },
      };

      registry.register(workflow);
      const result = registry.register(workflow, 'inline', { override: true });

      expect(result.valid).toBe(true);
    });
  });

  describe('validateWorkflow', () => {
    it('should validate input parameters', () => {
      const workflow: WorkflowDefinition = {
        id: 'test-workflow',
        name: 'Test Workflow',
        inputs: [
          {
            name: 'param1',
            schema: { type: 'string' },
          },
          {
            name: '', // Invalid: empty name
            schema: { type: 'number' },
          },
        ],
        steps: {
          step1: {
            type: 'ai',
            prompt: 'Test',
          },
        },
      };

      const result = registry.validateWorkflow(workflow);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          path: 'inputs[1].name',
          message: expect.stringContaining('name is required'),
        })
      );
    });

    it('should validate output parameters', () => {
      const workflow: WorkflowDefinition = {
        id: 'test-workflow',
        name: 'Test Workflow',
        outputs: [
          {
            name: 'output1',
            // Missing both value and value_js
          },
        ],
        steps: {
          step1: {
            type: 'ai',
            prompt: 'Test',
          },
        },
      };

      const result = registry.validateWorkflow(workflow);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          path: 'outputs[0]',
          message: expect.stringContaining('value or value_js'),
        })
      );
    });

    it('should detect circular dependencies', () => {
      const workflow: WorkflowDefinition = {
        id: 'test-workflow',
        name: 'Test Workflow',
        steps: {
          step1: {
            type: 'ai',
            prompt: 'Test',
            depends_on: ['step3'],
          },
          step2: {
            type: 'ai',
            prompt: 'Test',
            depends_on: ['step1'],
          },
          step3: {
            type: 'ai',
            prompt: 'Test',
            depends_on: ['step2'],
          },
        },
      };

      const result = registry.validateWorkflow(workflow);
      expect(result.valid).toBe(false);
      expect(result.errors?.[0].message).toContain('Circular dependencies');
    });

    it('should validate step dependencies exist', () => {
      const workflow: WorkflowDefinition = {
        id: 'test-workflow',
        name: 'Test Workflow',
        steps: {
          step1: {
            type: 'ai',
            prompt: 'Test',
            depends_on: ['non-existent-step'],
          },
        },
      };

      const result = registry.validateWorkflow(workflow);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          path: 'steps.step1.depends_on',
          message: expect.stringContaining('non-existent step'),
        })
      );
    });

    it('should validate input mappings', () => {
      const workflow: WorkflowDefinition = {
        id: 'test-workflow',
        name: 'Test Workflow',
        inputs: [
          {
            name: 'valid_param',
            schema: { type: 'string' },
          },
        ],
        steps: {
          step1: {
            type: 'ai',
            prompt: 'Test',
            inputs: {
              mapping1: {
                source: 'param',
                value: 'invalid_param', // Non-existent parameter
              },
            },
          },
        },
      };

      const result = registry.validateWorkflow(workflow);
      expect(result.valid).toBe(false);
      expect(result.errors).toContainEqual(
        expect.objectContaining({
          path: 'steps.step1.inputs.mapping1',
          message: expect.stringContaining('non-existent parameter'),
        })
      );
    });
  });

  describe('validateInputs', () => {
    it('should validate required inputs', () => {
      const workflow: WorkflowDefinition = {
        id: 'test-workflow',
        name: 'Test Workflow',
        inputs: [
          {
            name: 'required_param',
            schema: { type: 'string' },
            required: true,
          },
          {
            name: 'optional_param',
            schema: { type: 'number' },
            required: false,
          },
        ],
        steps: {
          step1: {
            type: 'ai',
            prompt: 'Test',
          },
        },
      };

      const result = registry.validateInputs(workflow, {
        optional_param: 42,
      });

      expect(result.valid).toBe(false);
      expect(result.errors?.[0].message).toContain("Required input 'required_param'");
    });

    it('should use defaults for missing optional inputs', () => {
      const workflow: WorkflowDefinition = {
        id: 'test-workflow',
        name: 'Test Workflow',
        inputs: [
          {
            name: 'param_with_default',
            schema: { type: 'string' },
            default: 'default_value',
          },
        ],
        steps: {
          step1: {
            type: 'ai',
            prompt: 'Test',
          },
        },
      };

      const result = registry.validateInputs(workflow, {});
      expect(result.valid).toBe(true);
    });

    it('should validate input schemas', () => {
      const workflow: WorkflowDefinition = {
        id: 'test-workflow',
        name: 'Test Workflow',
        inputs: [
          {
            name: 'number_param',
            schema: {
              type: 'number',
              minimum: 0,
              maximum: 100,
            },
          },
        ],
        steps: {
          step1: {
            type: 'ai',
            prompt: 'Test',
          },
        },
      };

      const result = registry.validateInputs(workflow, {
        number_param: 150, // Out of range
      });

      expect(result.valid).toBe(false);
      expect(result.errors?.[0].message).toContain('must be <= 100');
    });
  });

  describe('import', () => {
    it('should import workflow from YAML file', async () => {
      const workflowYaml = `
id: imported-workflow
name: Imported Workflow
steps:
  step1:
    type: ai
    prompt: Test prompt
`;

      (fs.promises.readFile as jest.Mock).mockResolvedValue(workflowYaml);

      const results = await registry.import('./workflow.yaml');

      expect(results).toHaveLength(1);
      expect(results[0].valid).toBe(true);
      expect(registry.has('imported-workflow')).toBe(true);
    });

    it('should import workflow from JSON file', async () => {
      const workflowJson = JSON.stringify({
        id: 'json-workflow',
        name: 'JSON Workflow',
        steps: {
          step1: {
            type: 'ai',
            prompt: 'Test prompt',
          },
        },
      });

      (fs.promises.readFile as jest.Mock).mockResolvedValue(workflowJson);

      const results = await registry.import('./workflow.json');

      expect(results).toHaveLength(1);
      expect(results[0].valid).toBe(true);
      expect(registry.has('json-workflow')).toBe(true);
    });

    it('should import workflow from URL', async () => {
      const workflowData = {
        id: 'remote-workflow',
        name: 'Remote Workflow',
        steps: {
          step1: {
            type: 'ai',
            prompt: 'Test prompt',
          },
        },
      };

      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        text: async () => JSON.stringify(workflowData),
      });

      const results = await registry.import('https://example.com/workflow.json');

      expect(results).toHaveLength(1);
      expect(results[0].valid).toBe(true);
      expect(registry.has('remote-workflow')).toBe(true);
    });

    it('should handle import errors', async () => {
      (fs.promises.readFile as jest.Mock).mockRejectedValue(new Error('File not found'));

      const results = await registry.import('./non-existent.yaml');

      expect(results).toHaveLength(1);
      expect(results[0].valid).toBe(false);
      expect(results[0].errors?.[0].message).toContain('Failed to import');
    });

    it('should import multiple workflows from array', async () => {
      const workflowsYaml = yaml.dump([
        {
          id: 'workflow1',
          name: 'Workflow 1',
          steps: { step1: { type: 'ai', prompt: 'Test' } },
        },
        {
          id: 'workflow2',
          name: 'Workflow 2',
          steps: { step1: { type: 'ai', prompt: 'Test' } },
        },
      ]);

      (fs.promises.readFile as jest.Mock).mockResolvedValue(workflowsYaml);

      const results = await registry.import('./workflows.yaml');

      expect(results).toHaveLength(2);
      expect(results[0].valid).toBe(true);
      expect(results[1].valid).toBe(true);
      expect(registry.has('workflow1')).toBe(true);
      expect(registry.has('workflow2')).toBe(true);
    });
  });

  describe('get and metadata', () => {
    it('should track usage statistics', () => {
      const workflow: WorkflowDefinition = {
        id: 'test-workflow',
        name: 'Test Workflow',
        steps: {
          step1: {
            type: 'ai',
            prompt: 'Test',
          },
        },
      };

      registry.register(workflow);

      // Get workflow multiple times
      registry.get('test-workflow');
      registry.get('test-workflow');
      registry.get('test-workflow');

      const metadata = registry.getMetadata('test-workflow');
      expect(metadata?.usage?.count).toBe(3);
      expect(metadata?.usage?.lastUsed).toBeDefined();
    });

    it('should return undefined for non-existent workflow', () => {
      const workflow = registry.get('non-existent');
      expect(workflow).toBeUndefined();
    });
  });

  describe('list and unregister', () => {
    it('should list all workflows', () => {
      const workflow1: WorkflowDefinition = {
        id: 'workflow1',
        name: 'Workflow 1',
        steps: { step1: { type: 'ai', prompt: 'Test' } },
      };

      const workflow2: WorkflowDefinition = {
        id: 'workflow2',
        name: 'Workflow 2',
        steps: { step1: { type: 'ai', prompt: 'Test' } },
      };

      registry.register(workflow1);
      registry.register(workflow2);

      const list = registry.list();
      expect(list).toHaveLength(2);
      expect(list.map((w) => w.id)).toContain('workflow1');
      expect(list.map((w) => w.id)).toContain('workflow2');
    });

    it('should unregister workflow', () => {
      const workflow: WorkflowDefinition = {
        id: 'test-workflow',
        name: 'Test Workflow',
        steps: { step1: { type: 'ai', prompt: 'Test' } },
      };

      registry.register(workflow);
      expect(registry.has('test-workflow')).toBe(true);

      const result = registry.unregister('test-workflow');
      expect(result).toBe(true);
      expect(registry.has('test-workflow')).toBe(false);
    });

    it('should clear all workflows', () => {
      const workflow: WorkflowDefinition = {
        id: 'test-workflow',
        name: 'Test Workflow',
        steps: { step1: { type: 'ai', prompt: 'Test' } },
      };

      registry.register(workflow);
      expect(registry.list()).toHaveLength(1);

      registry.clear();
      expect(registry.list()).toHaveLength(0);
    });
  });
});