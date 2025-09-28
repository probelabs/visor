import { createExtendedLiquid } from '../../src/liquid-extensions';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

describe('Liquid Extensions', () => {
  let tempDir: string;

  beforeEach(async () => {
    // Create a temporary directory for test files
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'visor-test-'));

    // Change to temp directory for tests
    process.chdir(tempDir);
  });

  afterEach(async () => {
    // Clean up temp directory
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe('readfile tag', () => {
    it('should read file content successfully', async () => {
      const liquid = createExtendedLiquid();

      // Create a test file
      const testContent = 'Hello from test file!';
      await fs.writeFile('test.txt', testContent);

      const template = '{% readfile "test.txt" %}';
      const result = await liquid.parseAndRender(template);

      expect(result).toBe(testContent);
    });

    it('should read file using variable path', async () => {
      const liquid = createExtendedLiquid();

      // Create a test file
      const testContent = 'Variable path content';
      await fs.writeFile('variable.txt', testContent);

      const template = '{% readfile filename %}';
      const context = { filename: 'variable.txt' };
      const result = await liquid.parseAndRender(template, context);

      expect(result).toBe(testContent);
    });

    it('should handle nested path correctly', async () => {
      const liquid = createExtendedLiquid();

      // Create nested directory and file
      await fs.mkdir('nested', { recursive: true });
      const testContent = 'Nested file content';
      await fs.writeFile('nested/deep.txt', testContent);

      const template = '{% readfile "nested/deep.txt" %}';
      const result = await liquid.parseAndRender(template);

      expect(result).toBe(testContent);
    });

    it('should handle non-existent file gracefully', async () => {
      const liquid = createExtendedLiquid();

      const template = '{% readfile "non-existent.txt" %}';
      const result = await liquid.parseAndRender(template);

      expect(result).toContain('[Error reading file:');
      expect(result).toContain('ENOENT');
    });

    it('should prevent directory traversal attacks', async () => {
      const liquid = createExtendedLiquid();

      // Try to read a file outside project directory
      const template = '{% readfile "../../../etc/passwd" %}';
      const result = await liquid.parseAndRender(template);

      expect(result).toBe('[Error: File path escapes project directory]');
    });

    it('should prevent absolute path access', async () => {
      const liquid = createExtendedLiquid();

      const template = '{% readfile "/etc/passwd" %}';
      const result = await liquid.parseAndRender(template);

      expect(result).toBe('[Error: File path escapes project directory]');
    });

    it('should handle empty path gracefully', async () => {
      const liquid = createExtendedLiquid();

      const template = '{% readfile "" %}';
      const result = await liquid.parseAndRender(template);

      expect(result).toBe('[Error: Invalid file path]');
    });

    it('should handle null/undefined path gracefully', async () => {
      const liquid = createExtendedLiquid();

      const template = '{% readfile nullvar %}';
      const context = { nullvar: null };
      const result = await liquid.parseAndRender(template, context);

      expect(result).toBe('[Error: Invalid file path]');
    });

    it('should read multi-line files correctly', async () => {
      const liquid = createExtendedLiquid();

      const testContent = `Line 1
Line 2
Line 3

Line 5 with special chars: !@#$%^&*()`;
      await fs.writeFile('multiline.txt', testContent);

      const template = '{% readfile "multiline.txt" %}';
      const result = await liquid.parseAndRender(template);

      expect(result).toBe(testContent);
    });

    it('should handle UTF-8 content correctly', async () => {
      const liquid = createExtendedLiquid();

      const testContent = 'Unicode: 你好世界 🌍 émojis 🎉';
      await fs.writeFile('unicode.txt', testContent);

      const template = '{% readfile "unicode.txt" %}';
      const result = await liquid.parseAndRender(template);

      expect(result).toBe(testContent);
    });

    it('should work within liquid loops', async () => {
      const liquid = createExtendedLiquid();

      // Create multiple files
      await fs.writeFile('file1.txt', 'Content 1');
      await fs.writeFile('file2.txt', 'Content 2');

      const template = `{% for file in files %}
File: {{ file }}
Content: {% readfile file %}
---
{% endfor %}`;

      const context = { files: ['file1.txt', 'file2.txt'] };
      const result = await liquid.parseAndRender(template, context);

      expect(result).toContain('Content 1');
      expect(result).toContain('Content 2');
    });

    it('should work with liquid conditionals', async () => {
      const liquid = createExtendedLiquid();

      await fs.writeFile('exists.txt', 'File exists!');

      const template = `{% if includeFile %}
Content: {% readfile "exists.txt" %}
{% else %}
No file included
{% endif %}`;

      const result1 = await liquid.parseAndRender(template, { includeFile: true });
      expect(result1.trim()).toContain('File exists!');

      const result2 = await liquid.parseAndRender(template, { includeFile: false });
      expect(result2.trim()).toContain('No file included');
    });

    it('should handle permission errors gracefully', async () => {
      const liquid = createExtendedLiquid();

      // Create a file and make it unreadable (Unix-like systems)
      if (process.platform !== 'win32') {
        await fs.writeFile('no-read.txt', 'secret');
        await fs.chmod('no-read.txt', 0o000);

        const template = '{% readfile "no-read.txt" %}';
        const result = await liquid.parseAndRender(template);

        expect(result).toContain('[Error reading file:');

        // Clean up: restore permissions before deletion
        await fs.chmod('no-read.txt', 0o644);
      }
    });
  });

  describe('createExtendedLiquid', () => {
    it('should preserve custom options', () => {
      const liquid = createExtendedLiquid({
        cache: true,
        strictFilters: true,
        strictVariables: true,
      });

      // The liquid instance should be created with the custom options
      // This is harder to test directly, but we can verify it doesn't throw
      expect(liquid).toBeDefined();
    });

    it('should work with default options', () => {
      const liquid = createExtendedLiquid();
      expect(liquid).toBeDefined();
    });
  });

  describe('parse_json filter', () => {
    it('should parse valid JSON strings', async () => {
      const liquid = createExtendedLiquid();

      const template = '{{ jsonString | parse_json | json }}';
      const context = { jsonString: '{"name": "test", "value": 42}' };
      const result = await liquid.parseAndRender(template, context);

      const parsed = JSON.parse(result);
      expect(parsed.name).toBe('test');
      expect(parsed.value).toBe(42);
    });

    it('should handle arrays in JSON', async () => {
      const liquid = createExtendedLiquid();

      const template = '{% assign data = jsonString | parse_json %}{{ data[0].name }}';
      const context = { jsonString: '[{"name": "first"}, {"name": "second"}]' };
      const result = await liquid.parseAndRender(template, context);

      expect(result).toBe('first');
    });

    it('should return original string for invalid JSON', async () => {
      const liquid = createExtendedLiquid();

      const template = '{{ invalidJson | parse_json }}';
      const context = { invalidJson: 'not valid json' };
      const result = await liquid.parseAndRender(template, context);

      expect(result).toBe('not valid json');
    });

    it('should work with readfile tag', async () => {
      const liquid = createExtendedLiquid();

      // Create a JSON file
      const jsonData = { version: '1.0.0', features: ['a', 'b', 'c'] };
      await fs.writeFile('test.json', JSON.stringify(jsonData));

      const template = `{% capture json %}{% readfile "test.json" %}{% endcapture %}{% assign data = json | parse_json %}Version: {{ data.version }}, Features: {{ data.features | join: ", " }}`;
      const result = await liquid.parseAndRender(template);

      expect(result).toBe('Version: 1.0.0, Features: a, b, c');
    });

    it('should handle nested JSON objects', async () => {
      const liquid = createExtendedLiquid();

      const template = '{% assign data = jsonString | parse_json %}{{ data.nested.deep.value }}';
      const context = {
        jsonString: '{"nested": {"deep": {"value": "found it!"}}}',
      };
      const result = await liquid.parseAndRender(template, context);

      expect(result).toBe('found it!');
    });
  });

  describe('to_json filter', () => {
    it('should serialize objects to JSON', async () => {
      const liquid = createExtendedLiquid();

      const template = '{{ obj | to_json }}';
      const context = { obj: { name: 'test', value: 42 } };
      const result = await liquid.parseAndRender(template, context);

      const parsed = JSON.parse(result);
      expect(parsed.name).toBe('test');
      expect(parsed.value).toBe(42);
    });

    it('should handle circular references gracefully', async () => {
      const liquid = createExtendedLiquid();

      const obj: any = { name: 'test' };
      obj.circular = obj; // Create circular reference

      const template = '{{ obj | to_json }}';
      const context = { obj };
      const result = await liquid.parseAndRender(template, context);

      expect(result).toBe('[Error: Unable to serialize to JSON]');
    });
  });
});
