/**
 * Tests for loadConfig extensions: visor:// paths, recursive expressions, and extends
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { WorkflowCheckProvider } from '../../src/providers/workflow-check-provider';

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

describe('loadConfig extensions', () => {
  let provider: WorkflowCheckProvider;
  let tmpDir: string;

  beforeEach(() => {
    provider = new WorkflowCheckProvider();

    // Create temp directory for test configs
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'visor-loadconfig-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeConfig(name: string, content: string): string {
    const filePath = path.join(tmpDir, name);
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(filePath, content, 'utf-8');
    return filePath;
  }

  // Call prepareInputs with an expression that gets evaluated via loadConfig
  async function evaluateExpression(expression: string): Promise<unknown> {
    const workflow = {
      id: 'test-wf',
      name: 'Test',
      inputs: [{ name: 'result', schema: { type: 'object' } }],
      outputs: [],
      steps: {
        noop: { type: 'noop' },
      },
    };

    const config = {
      workflow: 'test-wf',
      basePath: tmpDir,
      args: {
        result: { expression },
      },
    } as any;

    const prInfo = {
      owner: 'test',
      repo: 'test',
      pullNumber: 1,
      title: 'test',
      body: '',
      baseBranch: 'main',
      headBranch: 'test',
      files: [],
      diff: { additions: 0, deletions: 0, changes: 0 },
    } as any;

    const prepareInputs = (provider as any).prepareInputs.bind(provider);
    const inputs = await prepareInputs(workflow, config, prInfo);
    return inputs.result;
  }

  describe('visor:// path support', () => {
    it('loads config from visor:// path (defaults directory)', async () => {
      const result = await evaluateExpression("loadConfig('visor://skills/code-explorer.yaml')");
      expect(result).toBeDefined();
      expect((result as any).id).toBe('code-explorer');
      expect((result as any).tools).toBeDefined();
      expect((result as any).tools['code-explorer']).toBeDefined();
    });

    it('rejects visor:// path traversal', async () => {
      await expect(evaluateExpression("loadConfig('visor://../../etc/passwd')")).rejects.toThrow(
        /escapes defaults directory/
      );
    });
  });

  describe('recursive expression resolution', () => {
    it('resolves { expression: "..." } in loaded config', async () => {
      writeConfig('inner.yaml', 'value: 42\n');
      writeConfig('outer.yaml', 'nested:\n  expression: "loadConfig(\'inner.yaml\')"\n');

      const result = await evaluateExpression("loadConfig('outer.yaml')");
      expect(result).toBeDefined();
      expect((result as any).nested).toEqual({ value: 42 });
    });

    it('resolves nested expressions in arrays', async () => {
      writeConfig('item.yaml', 'name: test-item\n');
      writeConfig(
        'list.yaml',
        'items:\n  - expression: "loadConfig(\'item.yaml\')"\n  - plain: value\n'
      );

      const result = await evaluateExpression("loadConfig('list.yaml')");
      expect(result).toBeDefined();
      const items = (result as any).items;
      expect(items).toHaveLength(2);
      expect(items[0]).toEqual({ name: 'test-item' });
      expect(items[1]).toEqual({ plain: 'value' });
    });

    it('prevents infinite recursion with depth limit', async () => {
      writeConfig('recursive.yaml', 'loop:\n  expression: "loadConfig(\'recursive.yaml\')"\n');

      await expect(evaluateExpression("loadConfig('recursive.yaml')")).rejects.toThrow(/depth/i);
    });
  });

  describe('extends support', () => {
    it('merges base config with override via extends', async () => {
      writeConfig(
        'base.yaml',
        [
          'id: base-skill',
          'description: Base description',
          'knowledge: base knowledge',
          'tools:',
          '  tool1:',
          '    workflow: wf1',
          '    inputs:',
          '      key1: val1',
        ].join('\n') + '\n'
      );
      writeConfig(
        'override.yaml',
        [
          'extends: base.yaml',
          'knowledge: override knowledge',
          'tools:',
          '  tool1:',
          '    inputs:',
          '      key2: val2',
        ].join('\n') + '\n'
      );

      const result = await evaluateExpression("loadConfig('override.yaml')");
      expect(result).toBeDefined();
      const r = result as any;
      expect(r.id).toBe('base-skill');
      expect(r.description).toBe('Base description');
      expect(r.knowledge).toBe('override knowledge');
      expect(r.tools.tool1.workflow).toBe('wf1');
      expect(r.tools.tool1.inputs.key1).toBe('val1');
      expect(r.tools.tool1.inputs.key2).toBe('val2');
    });

    it('extends with visor:// base path', async () => {
      writeConfig(
        'my-skill.yaml',
        'extends: "visor://skills/code-explorer.yaml"\nknowledge: custom knowledge\n'
      );

      const result = await evaluateExpression("loadConfig('my-skill.yaml')");
      expect(result).toBeDefined();
      const r = result as any;
      expect(r.id).toBe('code-explorer');
      expect(r.knowledge).toBe('custom knowledge');
      expect(r.tools['code-explorer']).toBeDefined();
    });

    it('extends removes the extends field from result', async () => {
      writeConfig('base2.yaml', 'id: base\n');
      writeConfig('child.yaml', 'extends: base2.yaml\nextra: true\n');

      const result = await evaluateExpression("loadConfig('child.yaml')");
      expect(result).toBeDefined();
      expect((result as any).extends).toBeUndefined();
      expect((result as any).id).toBe('base');
      expect((result as any).extra).toBe(true);
    });

    it('extends with expression in tool inputs', async () => {
      writeConfig('projects.yaml', 'projects:\n  - id: proj1\n    repo: org/proj1\n');
      writeConfig(
        'skill-with-expr.yaml',
        [
          'extends: "visor://skills/code-explorer.yaml"',
          'tools:',
          '  code-explorer:',
          '    inputs:',
          '      expression: "loadConfig(\'projects.yaml\')"',
        ].join('\n') + '\n'
      );

      const result = await evaluateExpression("loadConfig('skill-with-expr.yaml')");
      expect(result).toBeDefined();
      const r = result as any;
      expect(r.id).toBe('code-explorer');
      expect(r.tools['code-explorer'].inputs.projects).toBeDefined();
      expect(r.tools['code-explorer'].inputs.projects[0].id).toBe('proj1');
    });
  });
});
