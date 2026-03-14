/**
 * Unit tests for WorkflowRegistry
 */

import { WorkflowRegistry } from '../../src/workflow-registry';
import { WorkflowDefinition } from '../../src/types/workflow';
import * as fs from 'fs';
import * as path from 'path';
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

    it('should warn on array schema without items', () => {
      const workflow: WorkflowDefinition = {
        id: 'test-workflow',
        name: 'Test Workflow',
        inputs: [
          {
            name: 'projects',
            schema: { type: 'array' },
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
      expect(result.warnings).toContainEqual(
        expect.objectContaining({
          path: 'inputs[0].schema',
          message: expect.stringContaining('items'),
        })
      );
    });

    it('should not warn on array schema with items', () => {
      const workflow: WorkflowDefinition = {
        id: 'test-workflow',
        name: 'Test Workflow',
        inputs: [
          {
            name: 'projects',
            schema: { type: 'array', items: { type: 'string' } },
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
      const itemsWarnings = (result.warnings ?? []).filter(w => w.message.includes('items'));
      expect(itemsWarnings).toEqual([]);
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

    it('should recursively import nested workflow imports', async () => {
      const basePath = '/repo';
      const engineerPath = path.resolve(basePath, 'engineer.yaml');
      const tykPath = path.resolve(basePath, 'tyk-code-talk.yaml');
      const codeTalkPath = path.resolve(basePath, 'code-talk.yaml');

      const engineerYaml = yaml.dump({
        id: 'engineer',
        name: 'Engineer',
        imports: ['./tyk-code-talk.yaml'],
        steps: { step1: { type: 'ai', prompt: 'Test' } },
      });

      const tykYaml = yaml.dump({
        id: 'tyk-code-talk',
        name: 'Tyk Code Talk',
        imports: ['./code-talk.yaml'],
        steps: { step1: { type: 'ai', prompt: 'Test' } },
      });

      const codeTalkYaml = yaml.dump({
        id: 'code-talk',
        name: 'Code Talk',
        steps: { step1: { type: 'ai', prompt: 'Test' } },
      });

      (fs.promises.readFile as jest.Mock).mockImplementation((filePath: string) => {
        if (filePath === engineerPath) return Promise.resolve(engineerYaml);
        if (filePath === tykPath) return Promise.resolve(tykYaml);
        if (filePath === codeTalkPath) return Promise.resolve(codeTalkYaml);
        return Promise.reject(new Error(`Unexpected path: ${filePath}`));
      });

      const results = await registry.import('./engineer.yaml', { basePath });

      expect(results.filter(r => r.valid)).toHaveLength(3);
      expect(registry.has('engineer')).toBe(true);
      expect(registry.has('tyk-code-talk')).toBe(true);
      expect(registry.has('code-talk')).toBe(true);
    });
  });

  describe('extends resolution', () => {
    it('should merge tools from base file when workflow uses extends', async () => {
      const basePath = '/repo/workflows/slack';

      // Base file (api.yaml) with tools
      const apiYaml = yaml.dump({
        tools: {
          'slack-bot-api': {
            type: 'api',
            name: 'slack-bot-api',
            headers: { Authorization: 'Bearer ${SLACK_BOT_TOKEN}' },
            spec: {
              openapi: '3.0.0',
              info: { title: 'Slack Bot API', version: '1.0.0' },
              servers: [{ url: 'https://slack.com/api' }],
              paths: {
                '/files.info': {
                  get: {
                    operationId: 'files_info',
                    parameters: [
                      { name: 'file', in: 'query', required: true, schema: { type: 'string' } },
                    ],
                    responses: { '200': { description: 'OK' } },
                  },
                },
              },
            },
          },
        },
      });

      // Workflow file that extends api.yaml
      const workflowYaml = yaml.dump({
        extends: 'api.yaml',
        id: 'slack-download-file',
        name: 'Slack Download File',
        steps: {
          'parse-file-id': { type: 'script', content: 'return { file_id: inputs.file_id }' },
          'file-info': {
            type: 'mcp',
            transport: 'custom',
            method: 'files_info',
            depends_on: ['parse-file-id'],
          },
        },
      });

      const workflowPath = path.resolve(basePath, 'slack-download-file.yaml');
      const apiPath = path.resolve(basePath, 'api.yaml');

      (fs.promises.readFile as jest.Mock).mockImplementation((filePath: string) => {
        if (filePath === workflowPath) return Promise.resolve(workflowYaml);
        if (filePath === apiPath) return Promise.resolve(apiYaml);
        return Promise.reject(new Error(`Unexpected path: ${filePath}`));
      });

      const results = await registry.import('./slack-download-file.yaml', { basePath });

      expect(results).toHaveLength(1);
      expect(results[0].valid).toBe(true);
      expect(registry.has('slack-download-file')).toBe(true);

      const workflow = registry.get('slack-download-file');
      expect(workflow).toBeDefined();
      // Tools from api.yaml should be merged into the workflow
      expect((workflow as any).tools).toBeDefined();
      expect((workflow as any).tools['slack-bot-api']).toBeDefined();
      expect((workflow as any).tools['slack-bot-api'].type).toBe('api');
    });

    it('should let workflow fields override base fields', async () => {
      const basePath = '/repo';

      const baseYaml = yaml.dump({
        name: 'Base Name',
        description: 'Base description',
        tools: { tool1: { type: 'api', name: 'tool1' } },
      });

      const workflowYaml = yaml.dump({
        extends: 'base.yaml',
        id: 'override-test',
        name: 'Override Name',
        steps: { step1: { type: 'ai', prompt: 'Test' } },
      });

      (fs.promises.readFile as jest.Mock).mockImplementation((filePath: string) => {
        if (filePath === path.resolve(basePath, 'workflow.yaml'))
          return Promise.resolve(workflowYaml);
        if (filePath === path.resolve(basePath, 'base.yaml')) return Promise.resolve(baseYaml);
        return Promise.reject(new Error(`Unexpected path: ${filePath}`));
      });

      const results = await registry.import('./workflow.yaml', { basePath });

      expect(results).toHaveLength(1);
      expect(results[0].valid).toBe(true);

      const workflow = registry.get('override-test');
      // Workflow's own name should override base
      expect(workflow?.name).toBe('Override Name');
      // Base tools should still be present
      expect((workflow as any).tools).toBeDefined();
      expect((workflow as any).tools.tool1.type).toBe('api');
    });

    it('should still register workflow if extends file is not found', async () => {
      const basePath = '/repo';

      const workflowYaml = yaml.dump({
        extends: 'nonexistent.yaml',
        id: 'fallback-workflow',
        name: 'Fallback Workflow',
        steps: { step1: { type: 'ai', prompt: 'Test' } },
      });

      (fs.promises.readFile as jest.Mock).mockImplementation((filePath: string) => {
        if (filePath === path.resolve(basePath, 'workflow.yaml'))
          return Promise.resolve(workflowYaml);
        return Promise.reject(new Error('File not found'));
      });

      const results = await registry.import('./workflow.yaml', { basePath });

      // Should still register (falls back to raw workflow without extends)
      expect(results).toHaveLength(1);
      expect(results[0].valid).toBe(true);
      expect(registry.has('fallback-workflow')).toBe(true);
    });

    it('should deep-merge nested objects from extends', async () => {
      const basePath = '/repo';

      const baseYaml = yaml.dump({
        tools: {
          api1: { type: 'api', name: 'api1', headers: { 'X-Base': 'true' } },
          api2: { type: 'api', name: 'api2' },
        },
      });

      const workflowYaml = yaml.dump({
        extends: 'base.yaml',
        id: 'deep-merge-test',
        name: 'Deep Merge Test',
        tools: {
          api1: { headers: { 'X-Override': 'true' } },
          api3: { type: 'api', name: 'api3' },
        },
        steps: { step1: { type: 'ai', prompt: 'Test' } },
      });

      (fs.promises.readFile as jest.Mock).mockImplementation((filePath: string) => {
        if (filePath === path.resolve(basePath, 'workflow.yaml'))
          return Promise.resolve(workflowYaml);
        if (filePath === path.resolve(basePath, 'base.yaml')) return Promise.resolve(baseYaml);
        return Promise.reject(new Error(`Unexpected path: ${filePath}`));
      });

      const results = await registry.import('./workflow.yaml', { basePath });
      expect(results[0].valid).toBe(true);

      const workflow = registry.get('deep-merge-test');
      const tools = (workflow as any).tools;
      // api1 should be deep-merged (override headers win, base fields preserved)
      expect(tools.api1.type).toBe('api');
      expect(tools.api1.name).toBe('api1');
      expect(tools.api1.headers['X-Override']).toBe('true');
      // api2 from base should still be present
      expect(tools.api2).toBeDefined();
      expect(tools.api2.type).toBe('api');
      // api3 from workflow should be present
      expect(tools.api3).toBeDefined();
    });
  });

  describe('visor:// protocol', () => {
    it('should resolve visor:// URLs to package root', async () => {
      const workflowYaml = `
id: builtin-workflow
name: Built-in Workflow
steps:
  step1:
    type: ai
    prompt: Test prompt
`;
      (fs.promises.readFile as jest.Mock).mockResolvedValue(workflowYaml);

      const results = await registry.import('visor://assistant.yaml');

      expect(results).toHaveLength(1);
      expect(results[0].valid).toBe(true);
      expect(fs.promises.readFile).toHaveBeenCalledWith(
        expect.stringContaining(path.join('defaults', 'assistant.yaml')),
        'utf-8'
      );
    });

    it('should resolve visor-ee:// URLs for backward compatibility', async () => {
      const workflowYaml = `
id: legacy-workflow
name: Legacy Workflow
steps:
  step1:
    type: ai
    prompt: Test prompt
`;
      (fs.promises.readFile as jest.Mock).mockResolvedValue(workflowYaml);

      const results = await registry.import('visor-ee://workflows/assistant.yaml');

      expect(results).toHaveLength(1);
      expect(results[0].valid).toBe(true);
    });

    it('should reject visor:// paths that escape package root', async () => {
      const results = await registry.import('visor://../../etc/passwd');

      expect(results).toHaveLength(1);
      expect(results[0].valid).toBe(false);
      expect(results[0].errors?.[0].message).toContain('escapes defaults directory');
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
      expect(list.map(w => w.id)).toContain('workflow1');
      expect(list.map(w => w.id)).toContain('workflow2');
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
