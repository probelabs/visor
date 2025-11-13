/**
 * Unit tests for WorkflowCheckProvider
 */

import { WorkflowCheckProvider } from '../../src/providers/workflow-check-provider';
import { WorkflowRegistry } from '../../src/workflow-registry';
import { WorkflowExecutor } from '../../src/workflow-executor';
import { WorkflowDefinition } from '../../src/types/workflow';
import { PRInfo } from '../../src/pr-analyzer';
import { CheckProviderConfig } from '../../src/providers/check-provider.interface';

// Mock dependencies
jest.mock('../../src/workflow-registry');
jest.mock('../../src/workflow-executor');
jest.mock('../../src/logger', () => ({
  logger: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

describe('WorkflowCheckProvider', () => {
  let provider: WorkflowCheckProvider;
  let mockRegistry: jest.Mocked<WorkflowRegistry>;
  let mockExecutor: jest.Mocked<WorkflowExecutor>;

  const sampleWorkflow: WorkflowDefinition = {
    id: 'test-workflow',
    name: 'Test Workflow',
    inputs: [
      {
        name: 'threshold',
        schema: { type: 'number' },
        default: 80,
      },
      {
        name: 'language',
        schema: { type: 'string' },
        required: true,
      },
    ],
    outputs: [
      {
        name: 'score',
        value_js: 'steps.analyze.output.score',
      },
      {
        name: 'passed',
        value_js: 'steps.analyze.output.score > inputs.threshold',
      },
    ],
    steps: {
      analyze: {
        type: 'ai',
        prompt: 'Analyze {{ inputs.language }} code',
      },
    },
  };

  const samplePRInfo: PRInfo = {
    number: 123,
    title: 'Test PR',
    body: 'Test description',
    author: 'test-author',
    base: 'main',
    head: 'feature',
    files: [
      {
        filename: 'test.ts',
        additions: 5,
        deletions: 2,
        changes: 7,
        status: 'modified',
      },
    ],
    totalAdditions: 10,
    totalDeletions: 5,
  };

  beforeEach(() => {
    // Create mock instances
    mockRegistry = {
      getInstance: jest.fn(),
      get: jest.fn(),
      has: jest.fn(),
      register: jest.fn(),
      validateInputs: jest.fn(),
      validateWorkflow: jest.fn(),
      list: jest.fn(),
      getMetadata: jest.fn(),
      unregister: jest.fn(),
      clear: jest.fn(),
      import: jest.fn(),
      importMany: jest.fn(),
    } as any;

    mockExecutor = {
      execute: jest.fn(),
    } as any;

    // Setup singleton mock
    (WorkflowRegistry.getInstance as jest.Mock).mockReturnValue(mockRegistry);
    (WorkflowExecutor as jest.Mock).mockImplementation(() => mockExecutor);

    provider = new WorkflowCheckProvider();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getName and getDescription', () => {
    it('should return correct name and description', () => {
      expect(provider.getName()).toBe('workflow');
      expect(provider.getDescription()).toBe('Executes reusable workflow definitions as checks');
    });
  });

  describe('validateConfig', () => {
    it('should validate config with workflow field', async () => {
      const config: CheckProviderConfig = {
        type: 'workflow',
        workflow: 'test-workflow',
      };

      mockRegistry.has.mockReturnValue(true);

      const result = await provider.validateConfig(config);
      expect(result).toBe(true);
    });

    it('should reject config without workflow field', async () => {
      const config: CheckProviderConfig = {
        type: 'workflow',
      };

      const result = await provider.validateConfig(config);
      expect(result).toBe(false);
    });

    it('should reject config with non-existent workflow', async () => {
      const config: CheckProviderConfig = {
        type: 'workflow',
        workflow: 'non-existent',
      };

      mockRegistry.has.mockReturnValue(false);

      const result = await provider.validateConfig(config);
      expect(result).toBe(false);
    });
  });

  describe('execute', () => {
    it('should execute workflow with basic inputs', async () => {
      const config: CheckProviderConfig = {
        type: 'workflow',
        workflow: 'test-workflow',
        workflow_inputs: {
          threshold: 90,
          language: 'typescript',
        },
      };

      mockRegistry.get.mockReturnValue(sampleWorkflow);
      mockRegistry.validateInputs.mockReturnValue({ valid: true });
      mockExecutor.execute.mockResolvedValue({
        success: true,
        score: 95,
        confidence: 'high',
        issues: [],
        comments: [],
        output: { score: 95, passed: true },
        status: 'completed',
        duration: 1000,
      });

      const result = await provider.execute(samplePRInfo, config);

      expect(mockRegistry.get).toHaveBeenCalledWith('test-workflow');
      expect(mockRegistry.validateInputs).toHaveBeenCalledWith(
        sampleWorkflow,
        expect.objectContaining({
          threshold: 90,
          language: 'typescript',
        })
      );
      expect(mockExecutor.execute).toHaveBeenCalled();
      expect((result as any).score).toBe(95);
      expect((result as any).output).toEqual({ score: 95, passed: true });
    });

    it('should use default input values', async () => {
      const config: CheckProviderConfig = {
        type: 'workflow',
        workflow: 'test-workflow',
        workflow_inputs: {
          language: 'javascript', // Only provide required param
        },
      };

      mockRegistry.get.mockReturnValue(sampleWorkflow);
      mockRegistry.validateInputs.mockReturnValue({ valid: true });
      mockExecutor.execute.mockResolvedValue({
        success: true,
        output: { score: 85 },
        status: 'completed',
      });

      await provider.execute(samplePRInfo, config);

      // Check that the executor was called with defaults
      const executorCall = mockExecutor.execute.mock.calls[0];
      expect(executorCall[1].inputs).toEqual({
        threshold: 80, // Default value
        language: 'javascript',
      });
    });

    it('should process Liquid templates in inputs', async () => {
      const config: CheckProviderConfig = {
        type: 'workflow',
        workflow: 'test-workflow',
        workflow_inputs: {
          language: '{% if pr.files[0].filename contains ".ts" %}typescript{% else %}javascript{% endif %}',
          threshold: 85,
        },
      };

      mockRegistry.get.mockReturnValue(sampleWorkflow);
      mockRegistry.validateInputs.mockReturnValue({ valid: true });
      mockExecutor.execute.mockResolvedValue({
        success: true,
        output: {},
        status: 'completed',
      });

      await provider.execute(samplePRInfo, config);

      const executorCall = mockExecutor.execute.mock.calls[0];
      expect(executorCall[1].inputs.language).toBe('typescript'); // test.ts contains .ts
    });

    it('should handle workflow overrides', async () => {
      const config: CheckProviderConfig = {
        type: 'workflow',
        workflow: 'test-workflow',
        workflow_inputs: {
          language: 'python',
          threshold: 70,
        },
        workflow_overrides: {
          analyze: {
            prompt: 'Custom prompt for analysis',
            timeout: 120,
          },
        },
      };

      mockRegistry.get.mockReturnValue(sampleWorkflow);
      mockRegistry.validateInputs.mockReturnValue({ valid: true });
      mockExecutor.execute.mockResolvedValue({
        success: true,
        output: {},
        status: 'completed',
      });

      await provider.execute(samplePRInfo, config);

      // Check that modified workflow was passed to executor
      const executorCall = mockExecutor.execute.mock.calls[0];
      const modifiedWorkflow = executorCall[0];
      expect(modifiedWorkflow.steps.analyze.prompt).toBe('Custom prompt for analysis');
      expect(modifiedWorkflow.steps.analyze.timeout).toBe(120);
    });

    it('should map workflow outputs', async () => {
      const config: CheckProviderConfig = {
        type: 'workflow',
        workflow: 'test-workflow',
        workflow_inputs: {
          language: 'go',
          threshold: 80,
        },
        output_mapping: {
          quality_score: 'score',
          is_passing: 'passed',
        },
      };

      mockRegistry.get.mockReturnValue(sampleWorkflow);
      mockRegistry.validateInputs.mockReturnValue({ valid: true });
      mockExecutor.execute.mockResolvedValue({
        success: true,
        output: { score: 92, passed: true, details: 'test' },
        status: 'completed',
      });

      const result = await provider.execute(samplePRInfo, config);

      expect((result as any).output).toEqual({
        quality_score: 92,
        is_passing: true,
      });
    });

    it('should handle nested output paths in mapping', async () => {
      const config: CheckProviderConfig = {
        type: 'workflow',
        workflow: 'test-workflow',
        workflow_inputs: {
          language: 'java',
          threshold: 75,
        },
        output_mapping: {
          nested_value: 'result.data.value',
        },
      };

      mockRegistry.get.mockReturnValue(sampleWorkflow);
      mockRegistry.validateInputs.mockReturnValue({ valid: true });
      mockExecutor.execute.mockResolvedValue({
        success: true,
        output: {
          result: {
            data: {
              value: 'nested-test',
            },
          },
        },
        status: 'completed',
      });

      const result = await provider.execute(samplePRInfo, config);

      expect((result as any).output).toEqual({
        nested_value: 'nested-test',
      });
    });

    it('should throw error for invalid inputs', async () => {
      const config: CheckProviderConfig = {
        type: 'workflow',
        workflow: 'test-workflow',
        workflow_inputs: {
          // Missing required 'language' param
          threshold: 90,
        },
      };

      mockRegistry.get.mockReturnValue(sampleWorkflow);
      mockRegistry.validateInputs.mockReturnValue({
        valid: false,
        errors: [{ path: 'inputs.language', message: 'Required input is missing' }],
      });

      await expect(provider.execute(samplePRInfo, config)).rejects.toThrow(
        'Invalid workflow inputs'
      );
    });

    it('should throw error when workflow not found', async () => {
      const config: CheckProviderConfig = {
        type: 'workflow',
        workflow: 'non-existent',
        workflow_inputs: {},
      };

      mockRegistry.get.mockReturnValue(undefined);

      await expect(provider.execute(samplePRInfo, config)).rejects.toThrow(
        "Workflow 'non-existent' not found"
      );
    });

    it('should pass workflow inputs to executor', async () => {
      const config: CheckProviderConfig = {
        type: 'workflow',
        workflow: 'test-workflow',
        workflow_inputs: {
          language: 'python',
          threshold: 85,
        },
      };

      mockRegistry.get.mockReturnValue(sampleWorkflow);
      mockRegistry.validateInputs.mockReturnValue({ valid: true });
      mockExecutor.execute.mockResolvedValue({
        success: true,
        output: {},
        status: 'completed',
      });

      await provider.execute(samplePRInfo, config);

      const executorCall = mockExecutor.execute.mock.calls[0];
      expect(executorCall[1].inputs.language).toBe('python');
      expect(executorCall[1].inputs.threshold).toBe(85);
    });

    it('should format workflow results correctly', async () => {
      const config: CheckProviderConfig = {
        type: 'workflow',
        workflow: 'test-workflow',
        workflow_inputs: {
          language: 'rust',
          threshold: 85,
        },
      };

      mockRegistry.get.mockReturnValue(sampleWorkflow);
      mockRegistry.validateInputs.mockReturnValue({ valid: true });
      mockExecutor.execute.mockResolvedValue({
        success: true,
        score: 88,
        issues: [{ severity: 'warning' }, { severity: 'info' }],
        output: { score: 88, passed: true },
        status: 'completed',
        duration: 1500,
        stepSummaries: [
          { stepId: 'analyze', status: 'success', issues: [{ severity: 'warning' }] },
        ],
      });

      const result = await provider.execute(samplePRInfo, config);

      expect((result as any).content).toContain('Workflow: Test Workflow');
      expect((result as any).content).toContain('Score: 88');
      expect((result as any).content).toContain('Issues Found: 2');
      expect((result as any).content).toContain('Duration: 1500ms');
      expect((result as any).content).toContain('analyze: success');
    });
  });

  describe('getSupportedConfigKeys', () => {
    it('should return supported config keys', () => {
      const keys = provider.getSupportedConfigKeys();
      expect(keys).toContain('workflow');
      expect(keys).toContain('args');
      expect(keys).toContain('overrides');
      expect(keys).toContain('output_mapping');
      expect(keys).toContain('timeout');
      expect(keys).toContain('env');
      expect(keys).toContain('checkName');
    });
  });

  describe('isAvailable and getRequirements', () => {
    it('should always be available', async () => {
      const available = await provider.isAvailable();
      expect(available).toBe(true);
    });

    it('should have no requirements', () => {
      const requirements = provider.getRequirements();
      expect(requirements).toEqual([]);
    });
  });
});