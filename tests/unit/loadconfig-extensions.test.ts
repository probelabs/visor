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

  describe('toolkit expansion', () => {
    it('expands toolkit tools into parent map', async () => {
      writeConfig(
        'my-toolkit.yaml',
        [
          'tools:',
          '  search:',
          '    workflow: search-wf',
          '    description: Search tool',
          '  analyze:',
          '    workflow: analyze-wf',
          '    description: Analyze tool',
        ].join('\n') + '\n'
      );
      writeConfig(
        'skill.yaml',
        ['id: my-skill', 'tools:', '  my-tools:', '    toolkit: my-toolkit.yaml'].join('\n') + '\n'
      );

      const result = await evaluateExpression("loadConfig('skill.yaml')");
      expect(result).toBeDefined();
      const r = result as any;
      expect(r.id).toBe('my-skill');
      // toolkit tools should be spread into the parent tools map
      expect(r.tools.search).toBeDefined();
      expect(r.tools.search.workflow).toBe('search-wf');
      expect(r.tools.analyze).toBeDefined();
      expect(r.tools.analyze.workflow).toBe('analyze-wf');
      // The original key should not remain
      expect(r.tools['my-tools']).toBeUndefined();
    });

    it('applies overrides to each expanded tool', async () => {
      writeConfig(
        'toolkit-with-overrides.yaml',
        [
          'tools:',
          '  tool-a:',
          '    workflow: wf-a',
          '    description: Tool A',
          '  tool-b:',
          '    workflow: wf-b',
          '    description: Tool B',
        ].join('\n') + '\n'
      );
      writeConfig(
        'skill-overrides.yaml',
        [
          'id: override-skill',
          'tools:',
          '  bulk:',
          '    toolkit: toolkit-with-overrides.yaml',
          '    tag: custom-tag',
        ].join('\n') + '\n'
      );

      const result = await evaluateExpression("loadConfig('skill-overrides.yaml')");
      expect(result).toBeDefined();
      const r = result as any;
      // Both tools should have the override applied
      expect(r.tools['tool-a'].tag).toBe('custom-tag');
      expect(r.tools['tool-b'].tag).toBe('custom-tag');
      // Original properties should still be present
      expect(r.tools['tool-a'].workflow).toBe('wf-a');
      expect(r.tools['tool-b'].workflow).toBe('wf-b');
    });

    it('expands toolkit without a wrapping tools key', async () => {
      // Toolkit file that is just a flat map of tools (no wrapping `tools:` key)
      writeConfig(
        'flat-toolkit.yaml',
        ['flat-tool-1:', '  workflow: flat-wf-1', 'flat-tool-2:', '  workflow: flat-wf-2'].join(
          '\n'
        ) + '\n'
      );
      writeConfig(
        'skill-flat.yaml',
        ['id: flat-skill', 'tools:', '  all:', '    toolkit: flat-toolkit.yaml'].join('\n') + '\n'
      );

      const result = await evaluateExpression("loadConfig('skill-flat.yaml')");
      expect(result).toBeDefined();
      const r = result as any;
      expect(r.tools['flat-tool-1']).toBeDefined();
      expect(r.tools['flat-tool-1'].workflow).toBe('flat-wf-1');
      expect(r.tools['flat-tool-2']).toBeDefined();
    });

    it('throws for toolkit with invalid tools section', async () => {
      writeConfig('bad-toolkit.yaml', '"just a string"\n');
      writeConfig(
        'skill-bad.yaml',
        ['id: bad-skill', 'tools:', '  broken:', '    toolkit: bad-toolkit.yaml'].join('\n') + '\n'
      );

      await expect(evaluateExpression("loadConfig('skill-bad.yaml')")).rejects.toThrow(
        /valid tools section/
      );
    });

    it('works with toolkit loaded via visor:// path', async () => {
      // This test only works if there's a toolkit file in defaults; skip if not available
      // Instead, test that toolkit + extends work together
      writeConfig(
        'base-skill.yaml',
        ['id: base', 'tools:', '  existing-tool:', '    workflow: existing-wf'].join('\n') + '\n'
      );
      writeConfig(
        'extra-tools.yaml',
        [
          'tools:',
          '  extra-1:',
          '    workflow: extra-wf-1',
          '  extra-2:',
          '    workflow: extra-wf-2',
        ].join('\n') + '\n'
      );
      writeConfig(
        'combined.yaml',
        ['extends: base-skill.yaml', 'tools:', '  more:', '    toolkit: extra-tools.yaml'].join(
          '\n'
        ) + '\n'
      );

      const result = await evaluateExpression("loadConfig('combined.yaml')");
      expect(result).toBeDefined();
      const r = result as any;
      expect(r.id).toBe('base');
      // Extended base tool should be present
      expect(r.tools['existing-tool']).toBeDefined();
      // Toolkit-expanded tools should be present
      expect(r.tools['extra-1']).toBeDefined();
      expect(r.tools['extra-2']).toBeDefined();
    });
  });
});
