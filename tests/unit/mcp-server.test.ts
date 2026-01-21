import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

// Import the functions and constants we're testing
import {
  resolveWorkflowPath,
  formatResults,
  executeWorkflow,
  executeFixedWorkflow,
  DEFAULT_WORKFLOWS,
  SERVER_INFO,
  RUN_WORKFLOW_DESCRIPTION,
  RunWorkflowSchema,
  FixedWorkflowSchema,
} from '../../src/mcp-server';

// Mock the sdk module
jest.mock('../../src/sdk', () => ({
  runChecks: jest.fn(),
}));

import { runChecks } from '../../src/sdk';
const mockRunChecks = runChecks as jest.MockedFunction<typeof runChecks>;

describe('MCP Server', () => {
  describe('Constants and Metadata', () => {
    it('should export DEFAULT_WORKFLOWS with expected values', () => {
      expect(DEFAULT_WORKFLOWS).toContain('code-review');
      expect(DEFAULT_WORKFLOWS).toContain('visor');
      expect(DEFAULT_WORKFLOWS).toContain('task-refinement');
      expect(DEFAULT_WORKFLOWS).toContain('code-refiner');
      expect(DEFAULT_WORKFLOWS.length).toBe(4);
    });

    it('should export SERVER_INFO with name and version', () => {
      expect(SERVER_INFO.name).toBe('visor');
      expect(SERVER_INFO.version).toBe('1.0.0');
      expect(SERVER_INFO.description).toBeTruthy();
      expect(SERVER_INFO.description).toContain('AI-powered');
    });

    it('should export RUN_WORKFLOW_DESCRIPTION', () => {
      expect(RUN_WORKFLOW_DESCRIPTION).toBeTruthy();
      expect(RUN_WORKFLOW_DESCRIPTION).toContain('Visor workflow');
      expect(RUN_WORKFLOW_DESCRIPTION).toContain('code review');
    });

    it('should export RunWorkflowSchema with expected shape', () => {
      expect(RunWorkflowSchema).toBeDefined();
      expect(RunWorkflowSchema.shape.workflow).toBeDefined();
      expect(RunWorkflowSchema.shape.message).toBeDefined();
      expect(RunWorkflowSchema.shape.checks).toBeDefined();
      expect(RunWorkflowSchema.shape.format).toBeDefined();
    });

    it('should export FixedWorkflowSchema without workflow parameter', () => {
      expect(FixedWorkflowSchema).toBeDefined();
      expect((FixedWorkflowSchema.shape as any).workflow).toBeUndefined();
      expect(FixedWorkflowSchema.shape.message).toBeDefined();
      expect(FixedWorkflowSchema.shape.checks).toBeDefined();
      expect(FixedWorkflowSchema.shape.format).toBeDefined();
    });
  });

  describe('RunWorkflowSchema validation', () => {
    it('should accept valid workflow with all parameters', () => {
      const result = RunWorkflowSchema.safeParse({
        workflow: 'code-review',
        message: 'Test message',
        checks: ['check1', 'check2'],
        format: 'json',
      });
      expect(result.success).toBe(true);
    });

    it('should accept workflow with only required parameter', () => {
      const result = RunWorkflowSchema.safeParse({
        workflow: 'code-review',
      });
      expect(result.success).toBe(true);
    });

    it('should reject missing workflow parameter', () => {
      const result = RunWorkflowSchema.safeParse({});
      expect(result.success).toBe(false);
    });

    it('should accept all valid format values', () => {
      for (const format of ['json', 'markdown', 'table']) {
        const result = RunWorkflowSchema.safeParse({
          workflow: 'test',
          format,
        });
        expect(result.success).toBe(true);
      }
    });

    it('should reject invalid format value', () => {
      const result = RunWorkflowSchema.safeParse({
        workflow: 'test',
        format: 'invalid',
      });
      expect(result.success).toBe(false);
    });

    it('should default format to json', () => {
      const result = RunWorkflowSchema.parse({
        workflow: 'test',
      });
      expect(result.format).toBe('json');
    });
  });

  describe('resolveWorkflowPath', () => {
    let tempDir: string;

    beforeEach(() => {
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-mcp-test-'));
    });

    afterEach(() => {
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    describe('absolute paths', () => {
      it('should return absolute path if file exists', () => {
        const testFile = path.join(tempDir, 'test-workflow.yaml');
        fs.writeFileSync(testFile, 'version: "1.0"');

        const result = resolveWorkflowPath(testFile);
        expect(result).toBe(testFile);
      });

      it('should throw error if absolute path file does not exist', () => {
        const nonExistent = path.join(tempDir, 'non-existent.yaml');
        expect(() => resolveWorkflowPath(nonExistent)).toThrow('Workflow file not found');
      });
    });

    describe('relative paths with extension', () => {
      it('should resolve relative .yaml path from cwd', () => {
        const originalCwd = process.cwd();
        const testFile = path.join(tempDir, 'relative-test.yaml');
        fs.writeFileSync(testFile, 'version: "1.0"');

        try {
          process.chdir(tempDir);
          const result = resolveWorkflowPath('./relative-test.yaml');
          expect(result).toBe(testFile);
        } finally {
          process.chdir(originalCwd);
        }
      });

      it('should resolve relative .yml path from cwd', () => {
        const originalCwd = process.cwd();
        const testFile = path.join(tempDir, 'relative-test.yml');
        fs.writeFileSync(testFile, 'version: "1.0"');

        try {
          process.chdir(tempDir);
          const result = resolveWorkflowPath('./relative-test.yml');
          expect(result).toBe(testFile);
        } finally {
          process.chdir(originalCwd);
        }
      });

      it('should throw error if relative path file does not exist', () => {
        const originalCwd = process.cwd();

        try {
          process.chdir(tempDir);
          expect(() => resolveWorkflowPath('./non-existent.yaml')).toThrow(
            'Workflow file not found'
          );
        } finally {
          process.chdir(originalCwd);
        }
      });
    });

    describe('default workflow names', () => {
      it('should find default workflow in defaults/ directory', () => {
        // This test relies on the actual defaults/ directory in the project
        const originalCwd = process.cwd();
        const projectRoot = path.resolve(__dirname, '../..');

        try {
          process.chdir(projectRoot);
          // code-review.yaml should exist in defaults/
          const result = resolveWorkflowPath('code-review');
          expect(result).toContain('code-review.yaml');
          expect(fs.existsSync(result)).toBe(true);
        } finally {
          process.chdir(originalCwd);
        }
      });

      it('should throw helpful error for unknown workflow name', () => {
        const originalCwd = process.cwd();

        try {
          process.chdir(tempDir);
          expect(() => resolveWorkflowPath('unknown-workflow')).toThrow(
            'Workflow "unknown-workflow" not found'
          );
          expect(() => resolveWorkflowPath('unknown-workflow')).toThrow(
            'Available default workflows'
          );
        } finally {
          process.chdir(originalCwd);
        }
      });
    });
  });

  describe('formatResults', () => {
    describe('JSON format', () => {
      it('should format results as pretty-printed JSON', () => {
        const results = {
          'test-check': {
            issues: [{ severity: 'error', message: 'Test error' }],
          },
        };

        const output = formatResults(results, 'json');
        expect(output).toBe(JSON.stringify(results, null, 2));
      });

      it('should handle empty results', () => {
        const results = {};
        const output = formatResults(results, 'json');
        expect(output).toBe('{}');
      });

      it('should handle complex nested structures', () => {
        const results = {
          check1: { issues: [], output: { nested: { deep: true } } },
          check2: { issues: [{ severity: 'warning', message: 'Warning' }] },
        };

        const output = formatResults(results, 'json');
        const parsed = JSON.parse(output);
        expect(parsed).toEqual(results);
      });
    });

    describe('Markdown format', () => {
      it('should format results with markdown headers', () => {
        const results = {
          'security-check': {
            issues: [{ severity: 'critical', message: 'Critical issue' }],
          },
        };

        const output = formatResults(results, 'markdown');
        expect(output).toContain('# Visor Workflow Results');
        expect(output).toContain('## security-check');
      });

      it('should use correct severity icons', () => {
        const results = {
          check: {
            issues: [
              { severity: 'critical', message: 'Critical' },
              { severity: 'error', message: 'Error' },
              { severity: 'warning', message: 'Warning' },
              { severity: 'info', message: 'Info' },
            ],
          },
        };

        const output = formatResults(results, 'markdown');
        expect(output).toContain('🔴'); // critical
        expect(output).toContain('🟠'); // error
        expect(output).toContain('🟡'); // warning
        expect(output).toContain('🔵'); // info
      });

      it('should show "No issues found" for empty issues array', () => {
        const results = {
          check: { issues: [] },
        };

        const output = formatResults(results, 'markdown');
        expect(output).toContain('_No issues found._');
      });

      it('should format non-issue results as JSON code block', () => {
        const results = {
          check: { output: { custom: 'data' } },
        };

        const output = formatResults(results, 'markdown');
        expect(output).toContain('```json');
        expect(output).toContain('"custom"');
      });

      it('should handle missing message in issue', () => {
        const results = {
          check: {
            issues: [{ severity: 'warning' }],
          },
        };

        const output = formatResults(results, 'markdown');
        expect(output).toContain('No message');
      });

      it('should handle missing severity in issue', () => {
        const results = {
          check: {
            issues: [{ message: 'Test' }],
          },
        };

        const output = formatResults(results, 'markdown');
        expect(output).toContain('🔵'); // defaults to info
        expect(output).toContain('**info**');
      });
    });

    describe('Table format', () => {
      it('should format results as text table', () => {
        const results = {
          'test-check': {
            issues: [{ severity: 'error', message: 'Test error' }],
          },
        };

        const output = formatResults(results, 'table');
        expect(output).toContain('Visor Workflow Results');
        expect(output).toContain('Check: test-check');
        expect(output).toContain('[ERROR');
      });

      it('should show "No issues found" for empty issues array', () => {
        const results = {
          check: { issues: [] },
        };

        const output = formatResults(results, 'table');
        expect(output).toContain('No issues found');
      });

      it('should format severity in uppercase', () => {
        const results = {
          check: {
            issues: [
              { severity: 'critical', message: 'Critical' },
              { severity: 'warning', message: 'Warning' },
            ],
          },
        };

        const output = formatResults(results, 'table');
        expect(output).toContain('[CRITICAL');
        expect(output).toContain('[WARNING');
      });

      it('should handle non-issue results', () => {
        const results = {
          check: { output: 'custom output' },
        };

        const output = formatResults(results, 'table');
        expect(output).toContain('custom output');
      });
    });
  });

  describe('executeWorkflow', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should call runChecks with resolved workflow path', async () => {
      const originalCwd = process.cwd();
      const projectRoot = path.resolve(__dirname, '../..');

      try {
        process.chdir(projectRoot);

        mockRunChecks.mockResolvedValue({
          repositoryInfo: { isGitRepository: true },
          reviewSummary: { issues: [] },
        } as any);

        await executeWorkflow({ workflow: 'code-review' });

        expect(mockRunChecks).toHaveBeenCalledTimes(1);
        const callArgs = mockRunChecks.mock.calls[0][0];
        expect(callArgs?.configPath).toContain('code-review.yaml');
      } finally {
        process.chdir(originalCwd);
      }
    });

    it('should pass message to execution context', async () => {
      const originalCwd = process.cwd();
      const projectRoot = path.resolve(__dirname, '../..');

      try {
        process.chdir(projectRoot);

        mockRunChecks.mockResolvedValue({} as any);

        await executeWorkflow({
          workflow: 'code-review',
          message: 'Test human input',
        });

        const callArgs = mockRunChecks.mock.calls[0][0];
        expect(callArgs?.executionContext?.cliMessage).toBe('Test human input');
      } finally {
        process.chdir(originalCwd);
      }
    });

    it('should pass checks array to runChecks', async () => {
      const originalCwd = process.cwd();
      const projectRoot = path.resolve(__dirname, '../..');

      try {
        process.chdir(projectRoot);

        mockRunChecks.mockResolvedValue({} as any);

        await executeWorkflow({
          workflow: 'code-review',
          checks: ['security', 'performance'],
        });

        const callArgs = mockRunChecks.mock.calls[0][0];
        expect(callArgs?.checks).toEqual(['security', 'performance']);
      } finally {
        process.chdir(originalCwd);
      }
    });

    it('should pass format to output options', async () => {
      const originalCwd = process.cwd();
      const projectRoot = path.resolve(__dirname, '../..');

      try {
        process.chdir(projectRoot);

        mockRunChecks.mockResolvedValue({} as any);

        await executeWorkflow({
          workflow: 'code-review',
          format: 'markdown',
        });

        const callArgs = mockRunChecks.mock.calls[0][0];
        expect(callArgs?.output?.format).toBe('markdown');
      } finally {
        process.chdir(originalCwd);
      }
    });

    it('should return formatted content on success', async () => {
      const originalCwd = process.cwd();
      const projectRoot = path.resolve(__dirname, '../..');

      try {
        process.chdir(projectRoot);

        const mockResult = {
          check1: { issues: [{ severity: 'info', message: 'Test' }] },
        };
        mockRunChecks.mockResolvedValue(mockResult as any);

        const result = await executeWorkflow({
          workflow: 'code-review',
          format: 'json',
        });

        expect(result.isError).toBeUndefined();
        expect(result.content).toHaveLength(1);
        expect(result.content[0].type).toBe('text');
        expect(JSON.parse(result.content[0].text)).toEqual(mockResult);
      } finally {
        process.chdir(originalCwd);
      }
    });

    it('should return error content when runChecks fails', async () => {
      const originalCwd = process.cwd();
      const projectRoot = path.resolve(__dirname, '../..');

      try {
        process.chdir(projectRoot);

        mockRunChecks.mockRejectedValue(new Error('Execution failed'));

        const result = await executeWorkflow({
          workflow: 'code-review',
        });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Error executing workflow');
        expect(result.content[0].text).toContain('Execution failed');
      } finally {
        process.chdir(originalCwd);
      }
    });

    it('should return error content when workflow not found', async () => {
      const result = await executeWorkflow({
        workflow: 'non-existent-workflow',
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain('Error executing workflow');
      expect(result.content[0].text).toContain('not found');
    });

    it('should handle non-Error exceptions', async () => {
      const originalCwd = process.cwd();
      const projectRoot = path.resolve(__dirname, '../..');

      try {
        process.chdir(projectRoot);

        mockRunChecks.mockRejectedValue('String error');

        const result = await executeWorkflow({
          workflow: 'code-review',
        });

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('String error');
      } finally {
        process.chdir(originalCwd);
      }
    });

    it('should default format to json when not provided', async () => {
      const originalCwd = process.cwd();
      const projectRoot = path.resolve(__dirname, '../..');

      try {
        process.chdir(projectRoot);

        mockRunChecks.mockResolvedValue({ test: true } as any);

        const result = await executeWorkflow({
          workflow: 'code-review',
        });

        // Should be valid JSON
        expect(() => JSON.parse(result.content[0].text)).not.toThrow();
      } finally {
        process.chdir(originalCwd);
      }
    });
  });

  describe('FixedWorkflowSchema validation', () => {
    it('should accept valid arguments without workflow', () => {
      const result = FixedWorkflowSchema.safeParse({
        message: 'Test message',
        checks: ['check1', 'check2'],
        format: 'json',
      });
      expect(result.success).toBe(true);
    });

    it('should accept empty object (all optional)', () => {
      const result = FixedWorkflowSchema.safeParse({});
      expect(result.success).toBe(true);
    });

    it('should default format to json', () => {
      const result = FixedWorkflowSchema.parse({});
      expect(result.format).toBe('json');
    });

    it('should reject invalid format value', () => {
      const result = FixedWorkflowSchema.safeParse({
        format: 'invalid',
      });
      expect(result.success).toBe(false);
    });
  });

  describe('executeFixedWorkflow', () => {
    beforeEach(() => {
      jest.clearAllMocks();
    });

    it('should call runChecks with the fixed workflow path', async () => {
      const originalCwd = process.cwd();
      const projectRoot = path.resolve(__dirname, '../..');
      const fixedWorkflowPath = path.join(projectRoot, 'defaults', 'code-review.yaml');

      try {
        process.chdir(projectRoot);

        mockRunChecks.mockResolvedValue({} as any);

        await executeFixedWorkflow({}, fixedWorkflowPath);

        expect(mockRunChecks).toHaveBeenCalledTimes(1);
        const callArgs = mockRunChecks.mock.calls[0][0];
        expect(callArgs?.configPath).toBe(fixedWorkflowPath);
      } finally {
        process.chdir(originalCwd);
      }
    });

    it('should pass message to execution context', async () => {
      const originalCwd = process.cwd();
      const projectRoot = path.resolve(__dirname, '../..');
      const fixedWorkflowPath = path.join(projectRoot, 'defaults', 'code-review.yaml');

      try {
        process.chdir(projectRoot);

        mockRunChecks.mockResolvedValue({} as any);

        await executeFixedWorkflow({ message: 'Fixed workflow message' }, fixedWorkflowPath);

        const callArgs = mockRunChecks.mock.calls[0][0];
        expect(callArgs?.executionContext?.cliMessage).toBe('Fixed workflow message');
      } finally {
        process.chdir(originalCwd);
      }
    });

    it('should pass checks array to runChecks', async () => {
      const originalCwd = process.cwd();
      const projectRoot = path.resolve(__dirname, '../..');
      const fixedWorkflowPath = path.join(projectRoot, 'defaults', 'code-review.yaml');

      try {
        process.chdir(projectRoot);

        mockRunChecks.mockResolvedValue({} as any);

        await executeFixedWorkflow({ checks: ['security'] }, fixedWorkflowPath);

        const callArgs = mockRunChecks.mock.calls[0][0];
        expect(callArgs?.checks).toEqual(['security']);
      } finally {
        process.chdir(originalCwd);
      }
    });

    it('should return formatted content on success', async () => {
      const originalCwd = process.cwd();
      const projectRoot = path.resolve(__dirname, '../..');
      const fixedWorkflowPath = path.join(projectRoot, 'defaults', 'code-review.yaml');

      try {
        process.chdir(projectRoot);

        const mockResult = {
          check1: { issues: [{ severity: 'warning', message: 'Test warning' }] },
        };
        mockRunChecks.mockResolvedValue(mockResult as any);

        const result = await executeFixedWorkflow({ format: 'json' }, fixedWorkflowPath);

        expect(result.isError).toBeUndefined();
        expect(result.content).toHaveLength(1);
        expect(JSON.parse(result.content[0].text)).toEqual(mockResult);
      } finally {
        process.chdir(originalCwd);
      }
    });

    it('should return error content when runChecks fails', async () => {
      const originalCwd = process.cwd();
      const projectRoot = path.resolve(__dirname, '../..');
      const fixedWorkflowPath = path.join(projectRoot, 'defaults', 'code-review.yaml');

      try {
        process.chdir(projectRoot);

        mockRunChecks.mockRejectedValue(new Error('Fixed workflow execution failed'));

        const result = await executeFixedWorkflow({}, fixedWorkflowPath);

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain('Error executing workflow');
        expect(result.content[0].text).toContain('Fixed workflow execution failed');
      } finally {
        process.chdir(originalCwd);
      }
    });

    it('should use markdown format when specified', async () => {
      const originalCwd = process.cwd();
      const projectRoot = path.resolve(__dirname, '../..');
      const fixedWorkflowPath = path.join(projectRoot, 'defaults', 'code-review.yaml');

      try {
        process.chdir(projectRoot);

        mockRunChecks.mockResolvedValue({
          'test-check': { issues: [{ severity: 'info', message: 'Test' }] },
        } as any);

        const result = await executeFixedWorkflow({ format: 'markdown' }, fixedWorkflowPath);

        expect(result.content[0].text).toContain('# Visor Workflow Results');
        expect(result.content[0].text).toContain('## test-check');
      } finally {
        process.chdir(originalCwd);
      }
    });
  });
});
