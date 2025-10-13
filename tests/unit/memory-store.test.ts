import { MemoryStore } from '../../src/memory-store';
import fs from 'fs/promises';
import path from 'path';

describe('MemoryStore', () => {
  let testDir: string;

  beforeEach(() => {
    // Reset singleton before each test
    MemoryStore.resetInstance();
    testDir = path.join(__dirname, '../fixtures/memory-test');
  });

  afterEach(async () => {
    // Clean up test files
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('Singleton', () => {
    it('should return the same instance', () => {
      const store1 = MemoryStore.getInstance();
      const store2 = MemoryStore.getInstance();
      expect(store1).toBe(store2);
    });

    it('should allow config on first getInstance', () => {
      const store = MemoryStore.getInstance({ namespace: 'test' });
      expect(store.getDefaultNamespace()).toBe('test');
    });
  });

  describe('In-Memory Storage', () => {
    it('should store and retrieve values', async () => {
      const store = MemoryStore.getInstance({ storage: 'memory' });
      await store.initialize();

      await store.set('key1', 'value1');
      expect(store.get('key1')).toBe('value1');
    });

    it('should handle different data types', async () => {
      const store = MemoryStore.getInstance({ storage: 'memory' });
      await store.initialize();

      await store.set('string', 'hello');
      await store.set('number', 42);
      await store.set('boolean', true);
      await store.set('object', { a: 1, b: 2 });
      await store.set('array', [1, 2, 3]);

      expect(store.get('string')).toBe('hello');
      expect(store.get('number')).toBe(42);
      expect(store.get('boolean')).toBe(true);
      expect(store.get('object')).toEqual({ a: 1, b: 2 });
      expect(store.get('array')).toEqual([1, 2, 3]);
    });

    it('should check if key exists', async () => {
      const store = MemoryStore.getInstance({ storage: 'memory' });
      await store.initialize();

      await store.set('exists', 'value');

      expect(store.has('exists')).toBe(true);
      expect(store.has('not-exists')).toBe(false);
    });

    it('should delete keys', async () => {
      const store = MemoryStore.getInstance({ storage: 'memory' });
      await store.initialize();

      await store.set('key1', 'value1');
      expect(store.has('key1')).toBe(true);

      const deleted = await store.delete('key1');
      expect(deleted).toBe(true);
      expect(store.has('key1')).toBe(false);
      expect(store.get('key1')).toBeUndefined();
    });

    it('should return false when deleting non-existent key', async () => {
      const store = MemoryStore.getInstance({ storage: 'memory' });
      await store.initialize();

      const deleted = await store.delete('not-exists');
      expect(deleted).toBe(false);
    });

    it('should list all keys in namespace', async () => {
      const store = MemoryStore.getInstance({ storage: 'memory' });
      await store.initialize();

      await store.set('key1', 'value1');
      await store.set('key2', 'value2');
      await store.set('key3', 'value3');

      const keys = store.list();
      expect(keys).toHaveLength(3);
      expect(keys).toContain('key1');
      expect(keys).toContain('key2');
      expect(keys).toContain('key3');
    });

    it('should clear all keys in namespace', async () => {
      const store = MemoryStore.getInstance({ storage: 'memory' });
      await store.initialize();

      await store.set('key1', 'value1');
      await store.set('key2', 'value2');

      await store.clear();

      expect(store.list()).toHaveLength(0);
      expect(store.has('key1')).toBe(false);
      expect(store.has('key2')).toBe(false);
    });
  });

  describe('Append Operation', () => {
    it('should create array on first append', async () => {
      const store = MemoryStore.getInstance({ storage: 'memory' });
      await store.initialize();

      await store.append('items', 'item1');

      const result = store.get('items');
      expect(Array.isArray(result)).toBe(true);
      expect(result).toEqual(['item1']);
    });

    it('should append to existing array', async () => {
      const store = MemoryStore.getInstance({ storage: 'memory' });
      await store.initialize();

      await store.append('items', 'item1');
      await store.append('items', 'item2');
      await store.append('items', 'item3');

      const result = store.get('items');
      expect(result).toEqual(['item1', 'item2', 'item3']);
    });

    it('should convert non-array to array on append', async () => {
      const store = MemoryStore.getInstance({ storage: 'memory' });
      await store.initialize();

      await store.set('value', 'single');
      await store.append('value', 'appended');

      const result = store.get('value');
      expect(result).toEqual(['single', 'appended']);
    });

    it('should handle appending different types', async () => {
      const store = MemoryStore.getInstance({ storage: 'memory' });
      await store.initialize();

      await store.append('mixed', 'string');
      await store.append('mixed', 42);
      await store.append('mixed', { a: 1 });

      const result = store.get('mixed');
      expect(result).toEqual(['string', 42, { a: 1 }]);
    });
  });

  describe('Namespaces', () => {
    it('should isolate data by namespace', async () => {
      const store = MemoryStore.getInstance({ storage: 'memory', namespace: 'default' });
      await store.initialize();

      await store.set('key', 'value-default');
      await store.set('key', 'value-prod', 'production');
      await store.set('key', 'value-stage', 'staging');

      expect(store.get('key')).toBe('value-default');
      expect(store.get('key', 'production')).toBe('value-prod');
      expect(store.get('key', 'staging')).toBe('value-stage');
    });

    it('should use default namespace when not specified', async () => {
      const store = MemoryStore.getInstance({ storage: 'memory', namespace: 'custom' });
      await store.initialize();

      await store.set('key', 'value');
      expect(store.get('key')).toBe('value');
      expect(store.get('key', 'custom')).toBe('value');
    });

    it('should list keys per namespace', async () => {
      const store = MemoryStore.getInstance({ storage: 'memory' });
      await store.initialize();

      await store.set('key1', 'v1');
      await store.set('key2', 'v2');
      await store.set('key1', 'v1-prod', 'production');

      expect(store.list()).toEqual(['key1', 'key2']);
      expect(store.list('production')).toEqual(['key1']);
    });

    it('should list all namespaces', async () => {
      const store = MemoryStore.getInstance({ storage: 'memory' });
      await store.initialize();

      await store.set('key', 'v1', 'ns1');
      await store.set('key', 'v2', 'ns2');
      await store.set('key', 'v3', 'ns3');

      const namespaces = store.listNamespaces();
      expect(namespaces).toHaveLength(3);
      expect(namespaces).toContain('ns1');
      expect(namespaces).toContain('ns2');
      expect(namespaces).toContain('ns3');
    });

    it('should clear specific namespace', async () => {
      const store = MemoryStore.getInstance({ storage: 'memory' });
      await store.initialize();

      await store.set('key', 'v1', 'ns1');
      await store.set('key', 'v2', 'ns2');

      await store.clear('ns1');

      expect(store.has('key', 'ns1')).toBe(false);
      expect(store.has('key', 'ns2')).toBe(true);
    });

    it('should get all data in namespace', async () => {
      const store = MemoryStore.getInstance({ storage: 'memory' });
      await store.initialize();

      await store.set('key1', 'value1');
      await store.set('key2', 42);
      await store.set('key3', true);

      const allData = store.getAll();
      expect(allData).toEqual({
        key1: 'value1',
        key2: 42,
        key3: true,
      });
    });
  });

  describe('File Persistence - JSON', () => {
    it('should save and load JSON data', async () => {
      const file = path.join(testDir, 'memory.json');
      const store1 = MemoryStore.getInstance({ storage: 'file', file, format: 'json' });
      await store1.initialize();

      await store1.set('key1', 'value1');
      await store1.set('key2', 42);
      await store1.set('key3', { nested: true });

      // Reset and load
      MemoryStore.resetInstance();
      const store2 = MemoryStore.getInstance({ storage: 'file', file, format: 'json' });
      await store2.initialize();

      expect(store2.get('key1')).toBe('value1');
      expect(store2.get('key2')).toBe(42);
      expect(store2.get('key3')).toEqual({ nested: true });
    });

    it('should handle arrays in JSON', async () => {
      const file = path.join(testDir, 'array.json');
      const store1 = MemoryStore.getInstance({ storage: 'file', file, format: 'json' });
      await store1.initialize();

      await store1.append('items', 'a');
      await store1.append('items', 'b');
      await store1.append('items', 'c');

      MemoryStore.resetInstance();
      const store2 = MemoryStore.getInstance({ storage: 'file', file, format: 'json' });
      await store2.initialize();

      expect(store2.get('items')).toEqual(['a', 'b', 'c']);
    });

    it('should handle multiple namespaces in JSON', async () => {
      const file = path.join(testDir, 'namespaces.json');
      const store1 = MemoryStore.getInstance({ storage: 'file', file, format: 'json' });
      await store1.initialize();

      await store1.set('key', 'default-value', 'default');
      await store1.set('key', 'prod-value', 'production');
      await store1.set('key', 'stage-value', 'staging');

      MemoryStore.resetInstance();
      const store2 = MemoryStore.getInstance({ storage: 'file', file, format: 'json' });
      await store2.initialize();

      expect(store2.get('key', 'default')).toBe('default-value');
      expect(store2.get('key', 'production')).toBe('prod-value');
      expect(store2.get('key', 'staging')).toBe('stage-value');
    });

    it('should not fail on missing file during load', async () => {
      const file = path.join(testDir, 'not-exists.json');
      const store = MemoryStore.getInstance({ storage: 'file', file, format: 'json' });

      await expect(store.initialize()).resolves.not.toThrow();
      expect(store.list()).toHaveLength(0);
    });

    it('should auto-save after set when configured', async () => {
      const file = path.join(testDir, 'auto-save.json');
      const store = MemoryStore.getInstance({
        storage: 'file',
        file,
        format: 'json',
        auto_save: true,
      });
      await store.initialize();

      await store.set('key', 'value');

      // File should exist
      const exists = await fs
        .access(file)
        .then(() => true)
        .catch(() => false);
      expect(exists).toBe(true);

      // Verify content
      const content = await fs.readFile(file, 'utf-8');
      const data = JSON.parse(content);
      expect(data.default.key).toBe('value');
    });
  });

  describe('File Persistence - CSV', () => {
    it('should save and load CSV data', async () => {
      const file = path.join(testDir, 'memory.csv');
      const store1 = MemoryStore.getInstance({ storage: 'file', file, format: 'csv' });
      await store1.initialize();

      await store1.set('string_key', 'value', 'default');
      await store1.set('number_key', 42, 'default');
      await store1.set('bool_key', true, 'default');

      MemoryStore.resetInstance();
      const store2 = MemoryStore.getInstance({ storage: 'file', file, format: 'csv' });
      await store2.initialize();

      expect(store2.get('string_key')).toBe('value');
      expect(store2.get('number_key')).toBe(42);
      expect(store2.get('bool_key')).toBe(true);
    });

    it('should handle arrays in CSV (multiple rows)', async () => {
      const file = path.join(testDir, 'array.csv');
      const store1 = MemoryStore.getInstance({ storage: 'file', file, format: 'csv' });
      await store1.initialize();

      await store1.append('items', 'a');
      await store1.append('items', 'b');
      await store1.append('items', 'c');

      MemoryStore.resetInstance();
      const store2 = MemoryStore.getInstance({ storage: 'file', file, format: 'csv' });
      await store2.initialize();

      const items = store2.get('items');
      expect(Array.isArray(items)).toBe(true);
      expect(items).toEqual(['a', 'b', 'c']);
    });

    it('should handle multiple namespaces in CSV', async () => {
      const file = path.join(testDir, 'namespaces.csv');
      const store1 = MemoryStore.getInstance({ storage: 'file', file, format: 'csv' });
      await store1.initialize();

      await store1.set('key', 'default-value', 'default');
      await store1.set('key', 'prod-value', 'production');

      MemoryStore.resetInstance();
      const store2 = MemoryStore.getInstance({ storage: 'file', file, format: 'csv' });
      await store2.initialize();

      expect(store2.get('key', 'default')).toBe('default-value');
      expect(store2.get('key', 'production')).toBe('prod-value');
    });

    it('should handle CSV values with commas and quotes', async () => {
      const file = path.join(testDir, 'special.csv');
      const store1 = MemoryStore.getInstance({ storage: 'file', file, format: 'csv' });
      await store1.initialize();

      await store1.set('comma', 'value,with,commas');
      await store1.set('quote', 'value"with"quotes');
      await store1.set('both', 'value,"with",both');

      MemoryStore.resetInstance();
      const store2 = MemoryStore.getInstance({ storage: 'file', file, format: 'csv' });
      await store2.initialize();

      expect(store2.get('comma')).toBe('value,with,commas');
      expect(store2.get('quote')).toBe('value"with"quotes');
      expect(store2.get('both')).toBe('value,"with",both');
    });

    it('should handle objects in CSV (serialized as JSON)', async () => {
      const file = path.join(testDir, 'objects.csv');
      const store1 = MemoryStore.getInstance({ storage: 'file', file, format: 'csv' });
      await store1.initialize();

      const obj = { a: 1, b: 'test', c: [1, 2, 3] };
      await store1.set('object', obj);

      MemoryStore.resetInstance();
      const store2 = MemoryStore.getInstance({ storage: 'file', file, format: 'csv' });
      await store2.initialize();

      expect(store2.get('object')).toEqual(obj);
    });
  });

  describe('Configuration', () => {
    it('should default to in-memory storage', () => {
      const store = MemoryStore.getInstance();
      const config = store.getConfig();
      expect(config.storage).toBe('memory');
    });

    it('should default namespace to "default"', () => {
      const store = MemoryStore.getInstance();
      expect(store.getDefaultNamespace()).toBe('default');
    });

    it('should respect custom namespace', () => {
      const store = MemoryStore.getInstance({ namespace: 'custom' });
      expect(store.getDefaultNamespace()).toBe('custom');
    });

    it('should default format to JSON', () => {
      const store = MemoryStore.getInstance({ storage: 'file' });
      const config = store.getConfig();
      expect(config.format).toBe('json');
    });

    it('should respect auto_load setting', () => {
      const store = MemoryStore.getInstance({ auto_load: false });
      const config = store.getConfig();
      expect(config.auto_load).toBe(false);
    });

    it('should respect auto_save setting', () => {
      const store = MemoryStore.getInstance({ auto_save: false });
      const config = store.getConfig();
      expect(config.auto_save).toBe(false);
    });
  });

  describe('Edge Cases', () => {
    it('should handle null and undefined values', async () => {
      const store = MemoryStore.getInstance({ storage: 'memory' });
      await store.initialize();

      await store.set('null', null);
      await store.set('undefined', undefined);

      expect(store.get('null')).toBeNull();
      expect(store.get('undefined')).toBeUndefined();
    });

    it('should handle empty strings', async () => {
      const store = MemoryStore.getInstance({ storage: 'memory' });
      await store.initialize();

      await store.set('empty', '');
      expect(store.get('empty')).toBe('');
    });

    it('should handle large arrays', async () => {
      const store = MemoryStore.getInstance({ storage: 'memory' });
      await store.initialize();

      for (let i = 0; i < 1000; i++) {
        await store.append('large', i);
      }

      const result = store.get('large') as number[];
      expect(result).toHaveLength(1000);
      expect(result[0]).toBe(0);
      expect(result[999]).toBe(999);
    });

    it('should handle deeply nested objects', async () => {
      const store = MemoryStore.getInstance({ storage: 'memory' });
      await store.initialize();

      const nested = {
        level1: {
          level2: {
            level3: {
              level4: {
                value: 'deep',
              },
            },
          },
        },
      };

      await store.set('nested', nested);
      expect(store.get('nested')).toEqual(nested);
    });
  });
});
