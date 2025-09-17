import { describe, it, expect, beforeEach, jest } from '@jest/globals';
import { ToolCheckProvider } from '../../src/providers/tool-check-provider';
import { CheckProviderConfig } from '../../src/providers/check-provider.interface';
import { PRInfo } from '../../src/pr-analyzer';

// Mock child_process
jest.mock('child_process');

describe('ToolCheckProvider - Liquid Templates', () => {
  let provider: ToolCheckProvider;

  beforeEach(() => {
    provider = new ToolCheckProvider();
  });

  describe('Liquid Template Support', () => {
    it('should render simple templates in exec command', async () => {
      const config: CheckProviderConfig = {
        type: 'tool',
        exec: 'echo "PR: {{ pr.title }}"',
      };

      const prInfo: PRInfo = {
        number: 123,
        title: 'Fix bug in authentication',
        body: 'This fixes the login issue',
        author: 'test-user',
        base: 'main',
        head: 'fix/auth-bug',
        files: [],
        totalAdditions: 10,
        totalDeletions: 5,
      };

      // Mock spawn to capture the command
      const mockSpawn = require('child_process').spawn;
      const mockChild = {
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        stdin: { write: jest.fn(), end: jest.fn() },
        on: jest.fn((event: string, callback: (code: number) => void) => {
          if (event === 'close') {
            callback(0);
          }
        }),
      };
      mockSpawn.mockReturnValue(mockChild);

      await provider.execute(prInfo, config);

      expect(mockSpawn).toHaveBeenCalledWith(
        'echo',
        ['PR: Fix bug in authentication'],
        expect.any(Object)
      );
    });

    it('should handle file lists in templates', async () => {
      const config: CheckProviderConfig = {
        type: 'tool',
        exec: 'eslint {{ filenames | join: " " }}',
      };

      const prInfo: PRInfo = {
        number: 123,
        title: 'Test PR',
        body: 'Test description',
        author: 'test-user',
        base: 'main',
        head: 'feature/test',
        files: [
          {
            filename: 'src/test1.js',
            status: 'modified',
            additions: 5,
            deletions: 2,
            changes: 7,
            patch: '',
          },
          {
            filename: 'src/test2.js',
            status: 'added',
            additions: 10,
            deletions: 0,
            changes: 10,
            patch: '',
          },
        ],
        totalAdditions: 15,
        totalDeletions: 2,
      };

      const mockSpawn = require('child_process').spawn;
      const mockChild = {
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        stdin: { write: jest.fn(), end: jest.fn() },
        on: jest.fn((event: string, callback: (code: number) => void) => {
          if (event === 'close') {
            callback(0);
          }
        }),
      };
      mockSpawn.mockReturnValue(mockChild);

      await provider.execute(prInfo, config);

      expect(mockSpawn).toHaveBeenCalledWith(
        'eslint',
        ['src/test1.js', 'src/test2.js'],
        expect.any(Object)
      );
    });

    it('should support conditional execution with templates', async () => {
      const config: CheckProviderConfig = {
        type: 'tool',
        exec: `{% if files.size > 5 %}
                echo "Too many files"
              {% else %}
                eslint {{ filenames | join: " " }}
              {% endif %}`,
      };

      const prInfo: PRInfo = {
        number: 123,
        title: 'Test PR',
        body: 'Test description',
        author: 'test-user',
        base: 'main',
        head: 'feature/test',
        files: [
          {
            filename: 'test.js',
            status: 'modified',
            additions: 5,
            deletions: 2,
            changes: 7,
            patch: '',
          },
        ],
        totalAdditions: 5,
        totalDeletions: 2,
      };

      const mockSpawn = require('child_process').spawn;
      const mockChild = {
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        stdin: { write: jest.fn(), end: jest.fn() },
        on: jest.fn((event: string, callback: (code: number) => void) => {
          if (event === 'close') {
            callback(0);
          }
        }),
      };
      mockSpawn.mockReturnValue(mockChild);

      await provider.execute(prInfo, config);

      expect(mockSpawn).toHaveBeenCalledWith('eslint', ['test.js'], expect.any(Object));
    });

    it('should support stdin templates', async () => {
      const config: CheckProviderConfig = {
        type: 'tool',
        exec: 'python3 analyze.py',
        stdin: `{
          "pr_number": {{ pr.number }},
          "title": "{{ pr.title }}",
          "files": {{ filenames | jsonify }}
        }`,
      };

      const prInfo: PRInfo = {
        number: 123,
        title: 'Test PR',
        body: 'Test description',
        author: 'test-user',
        base: 'main',
        head: 'feature/test',
        files: [
          {
            filename: 'test.js',
            status: 'modified',
            additions: 5,
            deletions: 2,
            changes: 7,
            patch: '',
          },
        ],
        totalAdditions: 5,
        totalDeletions: 2,
      };

      const mockSpawn = require('child_process').spawn;
      const mockChild = {
        stdout: { on: jest.fn() },
        stderr: { on: jest.fn() },
        stdin: { write: jest.fn(), end: jest.fn() },
        on: jest.fn((event: string, callback: (code: number) => void) => {
          if (event === 'close') {
            callback(0);
          }
        }),
      };
      mockSpawn.mockReturnValue(mockChild);

      await provider.execute(prInfo, config);

      expect(mockChild.stdin.write).toHaveBeenCalledWith(
        expect.stringContaining('"pr_number": 123')
      );
      expect(mockChild.stdin.write).toHaveBeenCalledWith(
        expect.stringContaining('"title": "Test PR"')
      );
      expect(mockChild.stdin.write).toHaveBeenCalledWith(expect.stringContaining('["test.js"]'));
    });
  });

  describe('getSupportedConfigKeys', () => {
    it('should include new keys including stdin', () => {
      const keys = provider.getSupportedConfigKeys();
      expect(keys).toContain('exec');
      expect(keys).toContain('stdin');
      expect(keys).toContain('command');
      expect(keys).not.toContain('args'); // Deprecated
    });
  });
});
