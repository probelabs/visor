/**
 * Unit tests for the toolkit-expander utility.
 */

import { isToolkitReference, expandToolkit } from '../../src/utils/toolkit-expander';

describe('toolkit-expander', () => {
  describe('isToolkitReference', () => {
    it('returns true for objects with a toolkit string key', () => {
      expect(isToolkitReference({ toolkit: 'path/to/file.yaml' })).toBe(true);
    });

    it('returns true for toolkit with additional keys', () => {
      expect(isToolkitReference({ toolkit: 'file.yaml', tag: 'v1' })).toBe(true);
    });

    it('returns false for null', () => {
      expect(isToolkitReference(null)).toBe(false);
    });

    it('returns false for arrays', () => {
      expect(isToolkitReference([{ toolkit: 'file.yaml' }])).toBe(false);
    });

    it('returns false for non-string toolkit', () => {
      expect(isToolkitReference({ toolkit: 42 })).toBe(false);
    });

    it('returns false for objects without toolkit key', () => {
      expect(isToolkitReference({ workflow: 'wf' })).toBe(false);
    });
  });

  describe('expandToolkit', () => {
    it('expands tools from a config with tools key', () => {
      const config = {
        tools: {
          search: { workflow: 'search-wf' },
          analyze: { workflow: 'analyze-wf' },
        },
      };
      const result = expandToolkit(config);
      expect(result).toEqual({
        search: { workflow: 'search-wf' },
        analyze: { workflow: 'analyze-wf' },
      });
    });

    it('expands from flat config without tools wrapper', () => {
      const config = {
        search: { workflow: 'search-wf' },
        analyze: { workflow: 'analyze-wf' },
      };
      // When there is a `tools` key it uses it; otherwise falls back to the whole object.
      // Here there's no `tools` key so it uses the config itself.
      const result = expandToolkit(config);
      expect(result).toEqual({
        search: { workflow: 'search-wf' },
        analyze: { workflow: 'analyze-wf' },
      });
    });

    it('applies overrides to each tool definition', () => {
      const config = {
        tools: {
          'tool-a': { workflow: 'wf-a', description: 'A' },
          'tool-b': { workflow: 'wf-b', description: 'B' },
        },
      };
      const result = expandToolkit(config, { tag: 'custom' });
      expect(result['tool-a']).toEqual({ workflow: 'wf-a', description: 'A', tag: 'custom' });
      expect(result['tool-b']).toEqual({ workflow: 'wf-b', description: 'B', tag: 'custom' });
    });

    it('override wins over tool-level property', () => {
      const config = {
        tools: {
          t1: { workflow: 'wf1', tag: 'original' },
        },
      };
      const result = expandToolkit(config, { tag: 'override' });
      expect((result['t1'] as any).tag).toBe('override');
    });

    it('passes through non-object tool definitions without overrides', () => {
      const config = {
        tools: {
          simple: 'just-a-string',
        },
      };
      const result = expandToolkit(config);
      expect(result['simple']).toBe('just-a-string');
    });

    it('does not apply overrides to non-object tool definitions', () => {
      const config = {
        tools: {
          simple: 'just-a-string',
        },
      };
      const result = expandToolkit(config, { tag: 'v1' });
      expect(result['simple']).toBe('just-a-string');
    });

    it('throws for invalid tools section (string)', () => {
      expect(() => expandToolkit('not-an-object' as any)).toThrow(/valid tools section/);
    });

    it('throws for invalid tools section (array)', () => {
      expect(() => expandToolkit({ tools: ['a', 'b'] } as any)).toThrow(/valid tools section/);
    });

    it('returns empty object for empty tools', () => {
      const result = expandToolkit({ tools: {} });
      expect(result).toEqual({});
    });
  });
});
