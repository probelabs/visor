import { MemoryCheckProvider } from '../../src/providers/memory-check-provider';
import { MemoryStore } from '../../src/memory-store';
import { CheckProviderConfig } from '../../src/providers/check-provider.interface';
import { PRInfo } from '../../src/pr-analyzer';
import { ReviewSummary } from '../../src/reviewer';

// Extended type for tests
type MemoryReviewSummary = ReviewSummary & { output?: unknown; error?: string };

describe('MemoryCheckProvider', () => {
  let provider: MemoryCheckProvider;
  let mockPRInfo: PRInfo;

  beforeEach(() => {
    provider = new MemoryCheckProvider();
    MemoryStore.resetInstance();

    mockPRInfo = {
      number: 123,
      title: 'Test PR',
      body: 'Test description',
      author: 'testuser',
      base: 'main',
      head: 'feature',
      totalAdditions: 10,
      totalDeletions: 5,
      files: [],
    };
  });

  describe('Provider Metadata', () => {
    it('should have correct name', () => {
      expect(provider.getName()).toBe('memory');
    });

    it('should have description', () => {
      expect(provider.getDescription()).toContain('Memory');
    });

    it('should be always available', async () => {
      expect(await provider.isAvailable()).toBe(true);
    });

    it('should have no external requirements', () => {
      const reqs = provider.getRequirements();
      expect(reqs[0]).toContain('No external dependencies');
    });

    it('should list supported config keys', () => {
      const keys = provider.getSupportedConfigKeys();
      expect(keys).toContain('operation');
      expect(keys).toContain('key');
      expect(keys).toContain('value');
      expect(keys).toContain('value_js');
      expect(keys).toContain('namespace');
    });
  });

  describe('Configuration Validation', () => {
    it('should validate correct get config', async () => {
      const config: CheckProviderConfig = {
        type: 'memory',
        operation: 'get',
        key: 'test-key',
      };
      expect(await provider.validateConfig(config)).toBe(true);
    });

    it('should validate correct set config', async () => {
      const config: CheckProviderConfig = {
        type: 'memory',
        operation: 'set',
        key: 'test-key',
        value: 'test-value',
      };
      expect(await provider.validateConfig(config)).toBe(true);
    });

    it('should validate set with value_js', async () => {
      const config: CheckProviderConfig = {
        type: 'memory',
        operation: 'set',
        key: 'counter',
        value_js: '1 + 1',
      };
      expect(await provider.validateConfig(config)).toBe(true);
    });

    it('should validate append config', async () => {
      const config: CheckProviderConfig = {
        type: 'memory',
        operation: 'append',
        key: 'items',
        value: 'item1',
      };
      expect(await provider.validateConfig(config)).toBe(true);
    });

    it('should validate increment config', async () => {
      const config: CheckProviderConfig = {
        type: 'memory',
        operation: 'increment',
        key: 'counter',
      };
      expect(await provider.validateConfig(config)).toBe(true);
    });

    it('should validate increment config with value', async () => {
      const config: CheckProviderConfig = {
        type: 'memory',
        operation: 'increment',
        key: 'counter',
        value: 5,
      };
      expect(await provider.validateConfig(config)).toBe(true);
    });

    it('should reject increment without key', async () => {
      const config: CheckProviderConfig = {
        type: 'memory',
        operation: 'increment',
      };
      expect(await provider.validateConfig(config)).toBe(false);
    });

    it('should validate delete config', async () => {
      const config: CheckProviderConfig = {
        type: 'memory',
        operation: 'delete',
        key: 'test-key',
      };
      expect(await provider.validateConfig(config)).toBe(true);
    });

    it('should validate clear config', async () => {
      const config: CheckProviderConfig = {
        type: 'memory',
        operation: 'clear',
      };
      expect(await provider.validateConfig(config)).toBe(true);
    });

    it('should validate list config', async () => {
      const config: CheckProviderConfig = {
        type: 'memory',
        operation: 'list',
      };
      expect(await provider.validateConfig(config)).toBe(true);
    });

    it('should reject missing type', async () => {
      const config = {
        operation: 'get',
        key: 'test',
      };
      expect(await provider.validateConfig(config)).toBe(false);
    });

    it('should reject wrong type', async () => {
      const config: CheckProviderConfig = {
        type: 'command',
        operation: 'get',
        key: 'test',
      };
      expect(await provider.validateConfig(config)).toBe(false);
    });

    it('should reject missing operation', async () => {
      const config: CheckProviderConfig = {
        type: 'memory',
        key: 'test',
      };
      expect(await provider.validateConfig(config)).toBe(false);
    });

    it('should reject invalid operation', async () => {
      const config: CheckProviderConfig = {
        type: 'memory',
        operation: 'invalid' as any,
        key: 'test',
      };
      expect(await provider.validateConfig(config)).toBe(false);
    });

    it('should reject get without key', async () => {
      const config: CheckProviderConfig = {
        type: 'memory',
        operation: 'get',
      };
      expect(await provider.validateConfig(config)).toBe(false);
    });

    it('should reject set without value or value_js', async () => {
      const config: CheckProviderConfig = {
        type: 'memory',
        operation: 'set',
        key: 'test',
      };
      expect(await provider.validateConfig(config)).toBe(false);
    });
  });

  describe('Get Operation', () => {
    it('should get existing value', async () => {
      const store = MemoryStore.getInstance({ storage: 'memory' });
      await store.initialize();
      await store.set('test-key', 'test-value');

      const config: CheckProviderConfig = {
        type: 'memory',
        operation: 'get',
        key: 'test-key',
      };

      const result = await provider.execute(mockPRInfo, config);
      expect((result as MemoryReviewSummary).output).toBe('test-value');
      expect(result.issues).toEqual([]);
    });

    it('should return undefined for non-existent key', async () => {
      const store = MemoryStore.getInstance({ storage: 'memory' });
      await store.initialize();

      const config: CheckProviderConfig = {
        type: 'memory',
        operation: 'get',
        key: 'not-exists',
      };

      const result = await provider.execute(mockPRInfo, config);
      expect((result as MemoryReviewSummary).output).toBeUndefined();
    });

    it('should get value from specific namespace', async () => {
      const store = MemoryStore.getInstance({ storage: 'memory' });
      await store.initialize();
      await store.set('key', 'prod-value', 'production');

      const config: CheckProviderConfig = {
        type: 'memory',
        operation: 'get',
        key: 'key',
        namespace: 'production',
      };

      const result = await provider.execute(mockPRInfo, config);
      expect((result as MemoryReviewSummary).output).toBe('prod-value');
    });
  });

  describe('Set Operation', () => {
    it('should set value', async () => {
      const store = MemoryStore.getInstance({ storage: 'memory' });
      await store.initialize();

      const config: CheckProviderConfig = {
        type: 'memory',
        operation: 'set',
        key: 'test-key',
        value: 'test-value',
      };

      const result = await provider.execute(mockPRInfo, config);
      expect((result as MemoryReviewSummary).output).toBe('test-value');
      expect(store.get('test-key')).toBe('test-value');
    });

    it('should set value with value_js', async () => {
      const store = MemoryStore.getInstance({ storage: 'memory' });
      await store.initialize();

      const config: CheckProviderConfig = {
        type: 'memory',
        operation: 'set',
        key: 'computed',
        value_js: '5 + 10',
      };

      const result = await provider.execute(mockPRInfo, config);
      expect((result as MemoryReviewSummary).output).toBe(15);
      expect(store.get('computed')).toBe(15);
    });

    it('should override existing value', async () => {
      const store = MemoryStore.getInstance({ storage: 'memory' });
      await store.initialize();
      await store.set('key', 'old-value');

      const config: CheckProviderConfig = {
        type: 'memory',
        operation: 'set',
        key: 'key',
        value: 'new-value',
      };

      await provider.execute(mockPRInfo, config);
      expect(store.get('key')).toBe('new-value');
    });

    it('should set value in specific namespace', async () => {
      const store = MemoryStore.getInstance({ storage: 'memory' });
      await store.initialize();

      const config: CheckProviderConfig = {
        type: 'memory',
        operation: 'set',
        key: 'key',
        value: 'prod-value',
        namespace: 'production',
      };

      await provider.execute(mockPRInfo, config);
      expect(store.get('key', 'production')).toBe('prod-value');
    });

    it('should handle different value types', async () => {
      const store = MemoryStore.getInstance({ storage: 'memory' });
      await store.initialize();

      const types = [
        { key: 'string', value: 'text' },
        { key: 'number', value: 42 },
        { key: 'boolean', value: true },
        { key: 'object', value: { a: 1 } },
        { key: 'array', value: [1, 2, 3] },
      ];

      for (const { key, value } of types) {
        const config: CheckProviderConfig = {
          type: 'memory',
          operation: 'set',
          key,
          value,
        };
        await provider.execute(mockPRInfo, config);
        expect(store.get(key)).toEqual(value);
      }
    });
  });

  describe('Append Operation', () => {
    it('should append to new key', async () => {
      const store = MemoryStore.getInstance({ storage: 'memory' });
      await store.initialize();

      const config: CheckProviderConfig = {
        type: 'memory',
        operation: 'append',
        key: 'items',
        value: 'item1',
      };

      const result = await provider.execute(mockPRInfo, config);
      expect((result as MemoryReviewSummary).output).toEqual(['item1']);
      expect(store.get('items')).toEqual(['item1']);
    });

    it('should append to existing array', async () => {
      const store = MemoryStore.getInstance({ storage: 'memory' });
      await store.initialize();
      await store.set('items', ['item1']);

      const config: CheckProviderConfig = {
        type: 'memory',
        operation: 'append',
        key: 'items',
        value: 'item2',
      };

      const result = await provider.execute(mockPRInfo, config);
      expect((result as MemoryReviewSummary).output).toEqual(['item1', 'item2']);
    });

    it('should append multiple times', async () => {
      const store = MemoryStore.getInstance({ storage: 'memory' });
      await store.initialize();

      for (let i = 1; i <= 3; i++) {
        const config: CheckProviderConfig = {
          type: 'memory',
          operation: 'append',
          key: 'counter',
          value: i,
        };
        await provider.execute(mockPRInfo, config);
      }

      expect(store.get('counter')).toEqual([1, 2, 3]);
    });
  });

  describe('Increment Operation', () => {
    it('should increment new key to 1', async () => {
      const store = MemoryStore.getInstance({ storage: 'memory' });
      await store.initialize();

      const config: CheckProviderConfig = {
        type: 'memory',
        operation: 'increment',
        key: 'counter',
      };

      const result = await provider.execute(mockPRInfo, config);
      expect((result as MemoryReviewSummary).output).toBe(1);
      expect(store.get('counter')).toBe(1);
    });

    it('should increment existing number', async () => {
      const store = MemoryStore.getInstance({ storage: 'memory' });
      await store.initialize();
      await store.set('counter', 5);

      const config: CheckProviderConfig = {
        type: 'memory',
        operation: 'increment',
        key: 'counter',
      };

      const result = await provider.execute(mockPRInfo, config);
      expect((result as MemoryReviewSummary).output).toBe(6);
      expect(store.get('counter')).toBe(6);
    });

    it('should increment by custom amount', async () => {
      const store = MemoryStore.getInstance({ storage: 'memory' });
      await store.initialize();
      await store.set('counter', 10);

      const config: CheckProviderConfig = {
        type: 'memory',
        operation: 'increment',
        key: 'counter',
        value: 5,
      };

      const result = await provider.execute(mockPRInfo, config);
      expect((result as MemoryReviewSummary).output).toBe(15);
      expect(store.get('counter')).toBe(15);
    });

    it('should increment by negative amount (decrement)', async () => {
      const store = MemoryStore.getInstance({ storage: 'memory' });
      await store.initialize();
      await store.set('counter', 10);

      const config: CheckProviderConfig = {
        type: 'memory',
        operation: 'increment',
        key: 'counter',
        value: -3,
      };

      const result = await provider.execute(mockPRInfo, config);
      expect((result as MemoryReviewSummary).output).toBe(7);
      expect(store.get('counter')).toBe(7);
    });

    it('should increment with value_js', async () => {
      const store = MemoryStore.getInstance({ storage: 'memory' });
      await store.initialize();
      await store.set('counter', 100);

      const config: CheckProviderConfig = {
        type: 'memory',
        operation: 'increment',
        key: 'counter',
        value_js: 'pr.number',
      };

      const result = await provider.execute(mockPRInfo, config);
      expect((result as MemoryReviewSummary).output).toBe(223); // 100 + 123
      expect(store.get('counter')).toBe(223);
    });

    it('should fail on non-numeric value', async () => {
      const store = MemoryStore.getInstance({ storage: 'memory' });
      await store.initialize();
      await store.set('counter', 'not a number');

      const config: CheckProviderConfig = {
        type: 'memory',
        operation: 'increment',
        key: 'counter',
      };

      const result = await provider.execute(mockPRInfo, config);
      expect((result as MemoryReviewSummary).error).toContain('Cannot increment non-numeric value');
    });

    it('should fail with non-numeric amount', async () => {
      const store = MemoryStore.getInstance({ storage: 'memory' });
      await store.initialize();

      const config: CheckProviderConfig = {
        type: 'memory',
        operation: 'increment',
        key: 'counter',
        value: 'not a number',
      };

      const result = await provider.execute(mockPRInfo, config);
      expect((result as MemoryReviewSummary).error).toContain('Increment amount must be a number');
    });
  });

  describe('Delete Operation', () => {
    it('should delete existing key', async () => {
      const store = MemoryStore.getInstance({ storage: 'memory' });
      await store.initialize();
      await store.set('test-key', 'value');

      const config: CheckProviderConfig = {
        type: 'memory',
        operation: 'delete',
        key: 'test-key',
      };

      const result = await provider.execute(mockPRInfo, config);
      expect((result as MemoryReviewSummary).output).toBe(true);
      expect(store.has('test-key')).toBe(false);
    });

    it('should return false for non-existent key', async () => {
      const store = MemoryStore.getInstance({ storage: 'memory' });
      await store.initialize();

      const config: CheckProviderConfig = {
        type: 'memory',
        operation: 'delete',
        key: 'not-exists',
      };

      const result = await provider.execute(mockPRInfo, config);
      expect((result as MemoryReviewSummary).output).toBe(false);
    });
  });

  describe('Clear Operation', () => {
    it('should clear all keys', async () => {
      const store = MemoryStore.getInstance({ storage: 'memory' });
      await store.initialize();
      await store.set('key1', 'value1');
      await store.set('key2', 'value2');

      const config: CheckProviderConfig = {
        type: 'memory',
        operation: 'clear',
      };

      await provider.execute(mockPRInfo, config);
      expect(store.list()).toHaveLength(0);
    });

    it('should clear specific namespace', async () => {
      const store = MemoryStore.getInstance({ storage: 'memory' });
      await store.initialize();
      await store.set('key', 'default', 'default');
      await store.set('key', 'prod', 'production');

      const config: CheckProviderConfig = {
        type: 'memory',
        operation: 'clear',
        namespace: 'production',
      };

      await provider.execute(mockPRInfo, config);
      expect(store.has('key', 'production')).toBe(false);
      expect(store.has('key', 'default')).toBe(true);
    });
  });

  describe('List Operation', () => {
    it('should list all keys', async () => {
      const store = MemoryStore.getInstance({ storage: 'memory' });
      await store.initialize();
      await store.set('key1', 'value1');
      await store.set('key2', 'value2');
      await store.set('key3', 'value3');

      const config: CheckProviderConfig = {
        type: 'memory',
        operation: 'list',
      };

      const result = await provider.execute(mockPRInfo, config);
      expect((result as MemoryReviewSummary).output).toEqual(['key1', 'key2', 'key3']);
    });

    it('should list keys in specific namespace', async () => {
      const store = MemoryStore.getInstance({ storage: 'memory' });
      await store.initialize();
      await store.set('key1', 'v1', 'default');
      await store.set('key2', 'v2', 'production');

      const config: CheckProviderConfig = {
        type: 'memory',
        operation: 'list',
        namespace: 'production',
      };

      const result = await provider.execute(mockPRInfo, config);
      expect((result as MemoryReviewSummary).output).toEqual(['key2']);
    });
  });

  describe('Value Computation with Context', () => {
    it('should access PR info in value_js', async () => {
      const store = MemoryStore.getInstance({ storage: 'memory' });
      await store.initialize();

      const config: CheckProviderConfig = {
        type: 'memory',
        operation: 'set',
        key: 'pr_number',
        value_js: 'pr.number',
      };

      const result = await provider.execute(mockPRInfo, config);
      expect((result as MemoryReviewSummary).output).toBe(123);
    });

    it('should access dependency outputs in value_js', async () => {
      const store = MemoryStore.getInstance({ storage: 'memory' });
      await store.initialize();

      const dependencies = new Map<string, ReviewSummary>();
      dependencies.set('previous', {
        issues: [],
        output: 42,
      } as any);

      const config: CheckProviderConfig = {
        type: 'memory',
        operation: 'set',
        key: 'incremented',
        value_js: 'outputs["previous"] + 1',
      };

      const result = await provider.execute(mockPRInfo, config, dependencies);
      expect((result as MemoryReviewSummary).output).toBe(43);
    });

    it('should access memory in value_js', async () => {
      const store = MemoryStore.getInstance({ storage: 'memory' });
      await store.initialize();
      await store.set('counter', 5);

      const config: CheckProviderConfig = {
        type: 'memory',
        operation: 'set',
        key: 'counter',
        value_js: 'memory.get("counter") + 1',
      };

      await provider.execute(mockPRInfo, config);
      expect(store.get('counter')).toBe(6);
    });

    it('should use transform template', async () => {
      const store = MemoryStore.getInstance({ storage: 'memory' });
      await store.initialize();

      const config: CheckProviderConfig = {
        type: 'memory',
        operation: 'set',
        key: 'message',
        value: 'test',
        transform: 'PR #{{ pr.number }}: {{ value }}',
      };

      const result = await provider.execute(mockPRInfo, config);
      expect((result as MemoryReviewSummary).output).toBe('PR #123: test');
    });

    it('should use transform_js', async () => {
      const store = MemoryStore.getInstance({ storage: 'memory' });
      await store.initialize();

      const config: CheckProviderConfig = {
        type: 'memory',
        operation: 'set',
        key: 'upper',
        value: 'hello',
        transform_js: 'value.toUpperCase()',
      };

      const result = await provider.execute(mockPRInfo, config);
      expect((result as MemoryReviewSummary).output).toBe('HELLO');
    });

    it('should chain value_js and transform_js', async () => {
      const store = MemoryStore.getInstance({ storage: 'memory' });
      await store.initialize();

      const config: CheckProviderConfig = {
        type: 'memory',
        operation: 'set',
        key: 'result',
        value_js: '5 * 2',
        transform_js: 'value + 10',
      };

      const result = await provider.execute(mockPRInfo, config);
      expect((result as MemoryReviewSummary).output).toBe(20);
    });
  });

  describe('Error Handling', () => {
    it('should handle invalid value_js', async () => {
      const store = MemoryStore.getInstance({ storage: 'memory' });
      await store.initialize();

      const config: CheckProviderConfig = {
        type: 'memory',
        operation: 'set',
        key: 'test',
        value_js: 'this will throw error()',
      };

      const result = await provider.execute(mockPRInfo, config);
      expect((result as MemoryReviewSummary).error).toBeDefined();
      expect((result as MemoryReviewSummary).error).toContain('Failed to evaluate');
    });

    it('should handle invalid transform_js', async () => {
      const store = MemoryStore.getInstance({ storage: 'memory' });
      await store.initialize();

      const config: CheckProviderConfig = {
        type: 'memory',
        operation: 'set',
        key: 'test',
        value: 'test',
        transform_js: 'this will throw error()',
      };

      const result = await provider.execute(mockPRInfo, config);
      expect((result as MemoryReviewSummary).error).toBeDefined();
    });
  });

  describe('Integration with Memory Store', () => {
    it('should work with memory store lifecycle', async () => {
      const store = MemoryStore.getInstance({ storage: 'memory', namespace: 'test' });
      await store.initialize();

      // Set via provider
      const setConfig: CheckProviderConfig = {
        type: 'memory',
        operation: 'set',
        key: 'counter',
        value: 0,
      };
      await provider.execute(mockPRInfo, setConfig);

      // Increment via provider
      for (let i = 1; i <= 5; i++) {
        const incConfig: CheckProviderConfig = {
          type: 'memory',
          operation: 'set',
          key: 'counter',
          value_js: 'memory.get("counter") + 1',
        };
        await provider.execute(mockPRInfo, incConfig);
      }

      // Get via provider
      const getConfig: CheckProviderConfig = {
        type: 'memory',
        operation: 'get',
        key: 'counter',
      };
      const result = await provider.execute(mockPRInfo, getConfig);

      expect((result as MemoryReviewSummary).output).toBe(5);
      expect(store.get('counter')).toBe(5);
    });
  });
});
