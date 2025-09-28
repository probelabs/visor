import { LogCheckProvider } from '../../../src/providers/log-check-provider';
import type { CheckProviderConfig } from '../../../src/providers/check-provider.interface';
import type { PRInfo } from '../../../src/pr-analyzer';
import type { ReviewSummary } from '../../../src/reviewer';

// Mock liquidjs and liquid-extensions
jest.mock('liquidjs', () => ({
  Liquid: jest.fn().mockImplementation(() => ({
    parseAndRender: jest.fn().mockImplementation((template: string, context: any) => {
      // Simple template replacement for tests
      let rendered = template;
      if (context) {
        rendered = template
          .replace(/\{\{\s*pr\.number\s*\}\}/g, context.pr?.number || '')
          .replace(/\{\{\s*pr\.author\s*\}\}/g, context.pr?.author || '')
          .replace(/\{\{\s*pr\.title\s*\}\}/g, context.pr?.title || '')
          .replace(/\{\{\s*files\s*\|\s*size\s*\}\}/g, context.files?.length || '0');
      }
      return Promise.resolve(rendered);
    }),
  })),
}));

jest.mock('../../../src/liquid-extensions', () => ({
  createExtendedLiquid: jest.fn().mockImplementation(() => ({
    parseAndRender: jest.fn().mockImplementation((template: string, context: any) => {
      // Simple template replacement for tests
      let rendered = template;
      if (context) {
        rendered = template
          .replace(/\{\{\s*pr\.number\s*\}\}/g, context.pr?.number || '')
          .replace(/\{\{\s*pr\.author\s*\}\}/g, context.pr?.author || '')
          .replace(/\{\{\s*pr\.title\s*\}\}/g, context.pr?.title || '')
          .replace(/\{\{\s*files\s*\|\s*size\s*\}\}/g, context.files?.length || '0')
          .replace(/\{\{\s*fileCount\s*\}\}/g, context.fileCount || '0')
          .replace(/\{\{\s*dependencyCount\s*\}\}/g, context.dependencyCount || '0');
      }
      return Promise.resolve(rendered);
    }),
  })),
}));

describe('LogCheckProvider', () => {
  let provider: LogCheckProvider;

  beforeEach(() => {
    provider = new LogCheckProvider();
  });

  describe('basic provider properties', () => {
    it('should have correct name', () => {
      expect(provider.getName()).toBe('log');
    });

    it('should have correct description', () => {
      expect(provider.getDescription()).toBe(
        'Output debugging and logging information for troubleshooting check workflows'
      );
    });

    it('should always be available', async () => {
      expect(await provider.isAvailable()).toBe(true);
    });

    it('should return correct requirements', () => {
      const requirements = provider.getRequirements();
      expect(requirements).toContain('No external dependencies required');
      expect(requirements).toContain('Used for debugging and logging check execution flow');
    });

    it('should return supported config keys', () => {
      const keys = provider.getSupportedConfigKeys();
      expect(keys).toContain('type');
      expect(keys).toContain('message');
      expect(keys).toContain('level');
      expect(keys).toContain('include_pr_context');
      expect(keys).toContain('include_dependencies');
      expect(keys).toContain('include_metadata');
      expect(keys).toContain('group');
    });
  });

  describe('config validation', () => {
    it('should validate correct config', async () => {
      const config: CheckProviderConfig = {
        type: 'log',
        message: 'Test log message',
        level: 'info',
      };

      expect(await provider.validateConfig(config)).toBe(true);
    });

    it('should reject config with wrong type', async () => {
      const config = {
        type: 'ai',
        message: 'Test message',
      };

      expect(await provider.validateConfig(config)).toBe(false);
    });

    it('should reject config without message', async () => {
      const config = {
        type: 'log',
      };

      expect(await provider.validateConfig(config)).toBe(false);
    });

    it('should reject config with invalid log level', async () => {
      const config = {
        type: 'log',
        message: 'Test message',
        level: 'invalid',
      };

      expect(await provider.validateConfig(config)).toBe(false);
    });

    it('should accept config with valid log levels', async () => {
      for (const level of ['debug', 'info', 'warn', 'error']) {
        const config = {
          type: 'log',
          message: 'Test message',
          level,
        };

        expect(await provider.validateConfig(config)).toBe(true);
      }
    });
  });

  describe('execution', () => {
    const mockPRInfo: PRInfo = {
      number: 123,
      title: 'Test PR',
      body: 'Test body',
      author: 'testuser',
      base: 'main',
      head: 'feature',
      totalAdditions: 10,
      totalDeletions: 5,
      files: [
        {
          filename: 'test.js',
          status: 'modified',
          additions: 10,
          deletions: 5,
          changes: 15,
          patch: 'mock patch',
        },
      ],
    };

    it('should execute basic log message', async () => {
      const config: CheckProviderConfig = {
        type: 'log',
        message: 'Simple test message',
        level: 'info',
      };

      const result = await provider.execute(mockPRInfo, config);

      expect(result.issues).toEqual([]);
      expect((result as any).logOutput).toBeDefined();
      expect((result as any).logOutput).toContain('ℹ️ **INFO**: Simple test message');
    });

    it('should render liquid templates', async () => {
      const config: CheckProviderConfig = {
        type: 'log',
        message: 'PR #{{ pr.number }} by {{ pr.author }}',
        level: 'info',
      };

      const result = await provider.execute(mockPRInfo, config);

      expect((result as any).logOutput).toContain('PR #123 by testuser');
    });

    it('should include PR context when enabled', async () => {
      const config: CheckProviderConfig = {
        type: 'log',
        message: 'Test',
        level: 'info',
        include_pr_context: true,
      };

      const result = await provider.execute(mockPRInfo, config);

      const output = (result as any).logOutput;
      expect(output).toContain('PR Context');
      expect(output).toContain('PR #123');
      expect(output).toContain('testuser');
    });

    it('should include metadata when enabled', async () => {
      const config: CheckProviderConfig = {
        type: 'log',
        message: 'Test',
        level: 'info',
        include_metadata: true,
      };

      const result = await provider.execute(mockPRInfo, config);

      const output = (result as any).logOutput;
      expect(output).toContain('Execution Metadata');
      expect(output).toContain('Timestamp');
      expect(output).toContain('Node Version');
    });

    it('should include dependencies when provided', async () => {
      const mockDeps = new Map<string, ReviewSummary>();
      mockDeps.set('security-check', {
        issues: [
          {
            file: 'test.js',
            line: 1,
            ruleId: 'security/test',
            message: 'Security issue',
            severity: 'error',
            category: 'security',
          },
        ],
      });

      const config: CheckProviderConfig = {
        type: 'log',
        message: 'Test with deps',
        level: 'info',
        include_dependencies: true,
      };

      const result = await provider.execute(mockPRInfo, config, mockDeps);

      const output = (result as any).logOutput;
      expect(output).toContain('Dependency Results');
      expect(output).toContain('security-check');
      expect(output).toContain('1 issues');
      expect(output).toContain('0 suggestions');
    });

    it('should support different log levels with correct emojis', async () => {
      const levels = [
        { level: 'debug', emoji: '🐛' },
        { level: 'info', emoji: 'ℹ️' },
        { level: 'warn', emoji: '⚠️' },
        { level: 'error', emoji: '❌' },
      ];

      for (const { level, emoji } of levels) {
        const config: CheckProviderConfig = {
          type: 'log',
          message: 'Test message',
          level: level as 'debug' | 'info' | 'warn' | 'error',
        };

        const result = await provider.execute(mockPRInfo, config);
        expect((result as any).logOutput).toContain(`${emoji} **${level.toUpperCase()}**`);
      }
    });

    it('should access file context in templates', async () => {
      const config: CheckProviderConfig = {
        type: 'log',
        message: 'Analyzing {{ fileCount }} files',
        level: 'info',
      };

      const result = await provider.execute(mockPRInfo, config);

      expect((result as any).logOutput).toContain('Analyzing 1 files');
    });

    it('should access dependency data in templates', async () => {
      const mockDeps = new Map<string, ReviewSummary>();
      mockDeps.set('test-check', {
        issues: [],
      });

      const config: CheckProviderConfig = {
        type: 'log',
        message: 'Dependency count: {{ dependencyCount }}',
        level: 'info',
        include_dependencies: true,
      };

      const result = await provider.execute(mockPRInfo, config, mockDeps);

      expect((result as any).logOutput).toContain('Dependency count: 1');
    });
  });
});
