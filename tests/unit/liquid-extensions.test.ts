import { createExtendedLiquid } from '../../src/liquid-extensions';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

// Helper function to safely change directory for a test
async function withTempDir<T>(tempDir: string, fn: () => Promise<T> | T): Promise<T> {
  const savedCwd = process.cwd();
  try {
    process.chdir(tempDir);
    return await fn();
  } finally {
    // Always restore the original directory
    try {
      process.chdir(savedCwd);
    } catch {
      // If restoration fails, at least try to go to a valid directory
      process.chdir(os.tmpdir());
    }
  }
}

describe('Liquid Extensions', () => {
  let tempDir: string;

  beforeEach(async () => {
    // Create a temporary directory for test files
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'visor-test-'));
  });

  afterEach(async () => {
    // Make sure we're not in the temp directory before deleting it
    if (process.cwd().startsWith(tempDir)) {
      process.chdir(os.tmpdir());
    }

    // Clean up temp directory
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {
        // Ignore errors during cleanup
      });
    }
  });

  describe('readfile tag', () => {
    it('should read file content successfully', async () => {
      const liquid = createExtendedLiquid();

      // Create a test file in temp directory
      const testFile = path.join(tempDir, 'test.txt');
      const testContent = 'Hello from test file!';
      await fs.writeFile(testFile, testContent);

      await withTempDir(tempDir, async () => {
        const template = '{% readfile "test.txt" %}';
        const result = await liquid.parseAndRender(template);
        expect(result).toBe(testContent);
      });
    });

    it('should read file using variable path', async () => {
      const liquid = createExtendedLiquid();

      // Create a test file
      const testFile = path.join(tempDir, 'variable.txt');
      const testContent = 'Variable path content';
      await fs.writeFile(testFile, testContent);

      await withTempDir(tempDir, async () => {
        const template = '{% readfile filename %}';
        const context = { filename: 'variable.txt' };
        const result = await liquid.parseAndRender(template, context);
        expect(result).toBe(testContent);
      });
    });

    it('should handle nested path correctly', async () => {
      const liquid = createExtendedLiquid();

      // Create nested directory and file
      const nestedDir = path.join(tempDir, 'nested');
      await fs.mkdir(nestedDir, { recursive: true });
      const testFile = path.join(nestedDir, 'deep.txt');
      const testContent = 'Nested file content';
      await fs.writeFile(testFile, testContent);

      await withTempDir(tempDir, async () => {
        const template = '{% readfile "nested/deep.txt" %}';
        const result = await liquid.parseAndRender(template);
        expect(result).toBe(testContent);
      });
    });

    it('should handle non-existent file gracefully', async () => {
      const liquid = createExtendedLiquid();

      await withTempDir(tempDir, async () => {
        const template = '{% readfile "non-existent.txt" %}';
        const result = await liquid.parseAndRender(template);
        expect(result).toContain('[Error reading file:');
        expect(result).toContain('ENOENT');
      });
    });

    it('should prevent directory traversal attacks', async () => {
      const liquid = createExtendedLiquid();

      await withTempDir(tempDir, async () => {
        const template = '{% readfile "../../../etc/passwd" %}';
        const result = await liquid.parseAndRender(template);
        expect(result).toBe('[Error: File path escapes project directory]');
      });
    });

    it('should prevent absolute path access', async () => {
      const liquid = createExtendedLiquid();

      await withTempDir(tempDir, async () => {
        const template = '{% readfile "/etc/passwd" %}';
        const result = await liquid.parseAndRender(template);
        expect(result).toBe('[Error: File path escapes project directory]');
      });
    });

    it('should handle empty path gracefully', async () => {
      const liquid = createExtendedLiquid();

      await withTempDir(tempDir, async () => {
        const template = '{% readfile "" %}';
        const result = await liquid.parseAndRender(template);
        expect(result).toBe('[Error: Invalid file path]');
      });
    });

    it('should handle null/undefined path gracefully', async () => {
      const liquid = createExtendedLiquid();

      await withTempDir(tempDir, async () => {
        const template = '{% readfile nullvar %}';
        const context = { nullvar: null };
        const result = await liquid.parseAndRender(template, context);
        expect(result).toBe('[Error: Invalid file path]');
      });
    });

    it('should read multi-line files correctly', async () => {
      const liquid = createExtendedLiquid();

      const testContent = `Line 1
Line 2
Line 3

Line 5 with special chars: !@#$%^&*()`;
      const testFile = path.join(tempDir, 'multiline.txt');
      await fs.writeFile(testFile, testContent);

      await withTempDir(tempDir, async () => {
        const template = '{% readfile "multiline.txt" %}';
        const result = await liquid.parseAndRender(template);
        expect(result).toBe(testContent);
      });
    });

    it('should handle UTF-8 content correctly', async () => {
      const liquid = createExtendedLiquid();

      const testContent = 'Unicode: 你好世界 🌍 émojis 🎉';
      const testFile = path.join(tempDir, 'unicode.txt');
      await fs.writeFile(testFile, testContent);

      await withTempDir(tempDir, async () => {
        const template = '{% readfile "unicode.txt" %}';
        const result = await liquid.parseAndRender(template);
        expect(result).toBe(testContent);
      });
    });

    it('should work within liquid loops', async () => {
      const liquid = createExtendedLiquid();

      // Create multiple files
      await fs.writeFile(path.join(tempDir, 'file1.txt'), 'Content 1');
      await fs.writeFile(path.join(tempDir, 'file2.txt'), 'Content 2');

      await withTempDir(tempDir, async () => {
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
    });

    it('should work with liquid conditionals', async () => {
      const liquid = createExtendedLiquid();

      await fs.writeFile(path.join(tempDir, 'exists.txt'), 'File exists!');

      await withTempDir(tempDir, async () => {
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
    });

    it('should handle permission errors gracefully', async () => {
      const liquid = createExtendedLiquid();

      // Create a file and make it unreadable (Unix-like systems)
      if (process.platform !== 'win32') {
        const testFile = path.join(tempDir, 'no-read.txt');
        await fs.writeFile(testFile, 'secret');
        await fs.chmod(testFile, 0o000);

        await withTempDir(tempDir, async () => {
          const template = '{% readfile "no-read.txt" %}';
          const result = await liquid.parseAndRender(template);
          expect(result).toContain('[Error reading file:');
        });

        // Clean up: restore permissions before deletion
        await fs.chmod(testFile, 0o644);
      }
    });

    describe('auto-indent for YAML literal blocks', () => {
      it('should auto-indent multiline content to match template position', async () => {
        const liquid = createExtendedLiquid();
        const yaml = require('js-yaml');

        // Create a multiline file that would break YAML without proper indentation
        const multilineContent = '## Title\n\nThis is line 2.\nThis is line 3.';
        await fs.writeFile(path.join(tempDir, 'multiline.md'), multilineContent);

        await withTempDir(tempDir, async () => {
          // Template with readfile inside a YAML literal block
          // The readfile tag is at column 4 (after 4 spaces)
          const template = `skills:
  - id: test
    knowledge: |
      {% readfile "multiline.md" %}
`;

          const result = liquid.parseAndRenderSync(template);

          // Verify YAML parses successfully
          let parsed;
          expect(() => {
            parsed = yaml.load(result);
          }).not.toThrow();

          // Verify the content is correct (YAML strips the indentation)
          expect(parsed.skills[0].knowledge).toContain('## Title');
          expect(parsed.skills[0].knowledge).toContain('This is line 2.');
          expect(parsed.skills[0].knowledge).toContain('This is line 3.');
        });
      });

      it('should handle content that would break YAML without auto-indent', async () => {
        const liquid = createExtendedLiquid();
        const yaml = require('js-yaml');

        // Create content with lines starting at column 0 - this would break YAML
        // if not properly indented
        const breakingContent =
          'First line\nSecond line starts at column 0\n- List item\n  nested: value';
        await fs.writeFile(path.join(tempDir, 'breaking.txt'), breakingContent);

        await withTempDir(tempDir, async () => {
          const template = `config:
  data: |
    {% readfile "breaking.txt" %}
`;

          const result = liquid.parseAndRenderSync(template);

          // This should NOT throw - the auto-indent should make it valid YAML
          let parsed;
          expect(() => {
            parsed = yaml.load(result);
          }).not.toThrow();

          // Verify content is preserved
          expect(parsed.config.data).toContain('First line');
          expect(parsed.config.data).toContain('Second line starts at column 0');
          expect(parsed.config.data).toContain('- List item');
        });
      });

      it('should work with nested YAML structures', async () => {
        const liquid = createExtendedLiquid();
        const yaml = require('js-yaml');

        const nestedContent =
          'Documentation content\n\nWith multiple paragraphs.\n\nAnd more text.';
        await fs.writeFile(path.join(tempDir, 'nested.md'), nestedContent);

        await withTempDir(tempDir, async () => {
          const template = `root:
  level1:
    level2:
      level3:
        content: |
          {% readfile "nested.md" %}
`;

          const result = liquid.parseAndRenderSync(template);

          let parsed;
          expect(() => {
            parsed = yaml.load(result);
          }).not.toThrow();

          expect(parsed.root.level1.level2.level3.content).toContain('Documentation content');
          expect(parsed.root.level1.level2.level3.content).toContain('multiple paragraphs');
        });
      });

      it('should handle empty lines in content correctly', async () => {
        const liquid = createExtendedLiquid();
        const yaml = require('js-yaml');

        // Content with multiple empty lines
        const contentWithEmptyLines = 'Start\n\n\n\nMiddle\n\nEnd';
        await fs.writeFile(path.join(tempDir, 'empty-lines.txt'), contentWithEmptyLines);

        await withTempDir(tempDir, async () => {
          const template = `test:
  value: |
    {% readfile "empty-lines.txt" %}
`;

          const result = liquid.parseAndRenderSync(template);

          let parsed;
          expect(() => {
            parsed = yaml.load(result);
          }).not.toThrow();

          expect(parsed.test.value).toContain('Start');
          expect(parsed.test.value).toContain('Middle');
          expect(parsed.test.value).toContain('End');
        });
      });

      it('should allow manual indent override', async () => {
        const liquid = createExtendedLiquid();
        const yaml = require('js-yaml');

        const content = 'Line 1\nLine 2\nLine 3';
        await fs.writeFile(path.join(tempDir, 'manual.txt'), content);

        await withTempDir(tempDir, async () => {
          // Use manual indent: 8 override
          const template = `test:
  value: |
        {% readfile "manual.txt" indent: 8 %}
`;

          const result = liquid.parseAndRenderSync(template);

          let parsed;
          expect(() => {
            parsed = yaml.load(result);
          }).not.toThrow();

          expect(parsed.test.value).toContain('Line 1');
          expect(parsed.test.value).toContain('Line 2');
        });
      });

      it('should work with parseAndRenderSync (loadConfig scenario)', async () => {
        const liquid = createExtendedLiquid();
        const yaml = require('js-yaml');

        // Simulate a skills.yaml with readfile
        const skillKnowledge =
          '## Skill Documentation\n\nUse this skill when...\n\n- Point 1\n- Point 2';
        await fs.writeFile(path.join(tempDir, 'skill-docs.md'), skillKnowledge);

        await withTempDir(tempDir, async () => {
          const template = `# Skills Configuration
- id: my-skill
  description: A test skill
  knowledge: |
    {% readfile "skill-docs.md" %}

- id: another-skill
  description: Another skill
`;

          // Use parseAndRenderSync like loadConfig does
          const result = liquid.parseAndRenderSync(template, { basePath: tempDir });

          let parsed;
          expect(() => {
            parsed = yaml.load(result);
          }).not.toThrow();

          expect(Array.isArray(parsed)).toBe(true);
          expect(parsed[0].id).toBe('my-skill');
          expect(parsed[0].knowledge).toContain('## Skill Documentation');
          expect(parsed[0].knowledge).toContain('- Point 1');
          expect(parsed[1].id).toBe('another-skill');
        });
      });
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
      const jsonFile = path.join(tempDir, 'test.json');
      await fs.writeFile(jsonFile, JSON.stringify(jsonData));

      await withTempDir(tempDir, async () => {
        const template = `{% capture json %}{% readfile "test.json" %}{% endcapture %}{% assign data = json | parse_json %}Version: {{ data.version }}, Features: {{ data.features | join: ", " }}`;
        const result = await liquid.parseAndRender(template);
        expect(result).toBe('Version: 1.0.0, Features: a, b, c');
      });
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

  describe('safe_label filter', () => {
    it('should preserve spaces in label names', async () => {
      const liquid = createExtendedLiquid();

      const template = '{{ label | safe_label }}';
      const context = { label: 'good first issue' };
      const result = await liquid.parseAndRender(template, context);

      expect(result).toBe('good first issue');
    });

    it('should preserve hyphens in label names', async () => {
      const liquid = createExtendedLiquid();

      const template = '{{ label | safe_label }}';
      const context = { label: 'needs-review' };
      const result = await liquid.parseAndRender(template, context);

      expect(result).toBe('needs-review');
    });

    it('should preserve colons and slashes in label names', async () => {
      const liquid = createExtendedLiquid();

      const template = '{{ label | safe_label }}';
      const context = { label: 'review/effort:high' };
      const result = await liquid.parseAndRender(template, context);

      expect(result).toBe('review/effort:high');
    });

    it('should remove special characters but keep spaces', async () => {
      const liquid = createExtendedLiquid();

      const template = '{{ label | safe_label }}';
      const context = { label: 'needs review!' };
      const result = await liquid.parseAndRender(template, context);

      expect(result).toBe('needs review');
    });

    it('should trim leading and trailing whitespace', async () => {
      const liquid = createExtendedLiquid();

      const template = '{{ label | safe_label }}';
      const context = { label: '  good first issue  ' };
      const result = await liquid.parseAndRender(template, context);

      expect(result).toBe('good first issue');
    });

    it('should handle empty/null values', async () => {
      const liquid = createExtendedLiquid();

      const template = '{{ label | safe_label }}';
      const result1 = await liquid.parseAndRender(template, { label: '' });
      const result2 = await liquid.parseAndRender(template, { label: null });

      expect(result1).toBe('');
      expect(result2).toBe('');
    });

    it('should collapse repeated slashes', async () => {
      const liquid = createExtendedLiquid();

      const template = '{{ label | safe_label }}';
      const context = { label: 'review//effort///high' };
      const result = await liquid.parseAndRender(template, context);

      expect(result).toBe('review/effort/high');
    });
  });
});
