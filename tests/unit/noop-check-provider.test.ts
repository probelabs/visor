import { describe, it, expect } from '@jest/globals';
import { NoopCheckProvider } from '../../src/providers/noop-check-provider';
import { CheckProviderConfig } from '../../src/providers/check-provider.interface';
import { PRInfo } from '../../src/pr-analyzer';

describe('NoopCheckProvider', () => {
  let provider: NoopCheckProvider;

  beforeEach(() => {
    provider = new NoopCheckProvider();
  });

  describe('getName', () => {
    it('should return "noop"', () => {
      expect(provider.getName()).toBe('noop');
    });
  });

  describe('getDescription', () => {
    it('should return appropriate description', () => {
      const description = provider.getDescription();
      expect(description).toContain('No-operation');
      expect(description).toContain('command orchestration');
    });
  });

  describe('validateConfig', () => {
    it('should validate valid noop config', async () => {
      const config: CheckProviderConfig = {
        type: 'noop',
        command: '/review',
        depends_on: ['security', 'performance'],
      };

      const isValid = await provider.validateConfig(config);
      expect(isValid).toBe(true);
    });

    it('should reject non-noop type', async () => {
      const config: CheckProviderConfig = {
        type: 'ai',
      };

      const isValid = await provider.validateConfig(config);
      expect(isValid).toBe(false);
    });

    it('should reject null config', async () => {
      const isValid = await provider.validateConfig(null);
      expect(isValid).toBe(false);
    });

    it('should reject non-object config', async () => {
      const isValid = await provider.validateConfig('invalid');
      expect(isValid).toBe(false);
    });
  });

  describe('execute', () => {
    it('should return empty issues and suggestions', async () => {
      const config: CheckProviderConfig = {
        type: 'noop',
      };

      const prInfo: PRInfo = {
        number: 123,
        title: 'Test PR',
        body: 'Test description',
        author: 'test-user',
        base: 'main',
        head: 'feature/test',
        files: [],
        totalAdditions: 0,
        totalDeletions: 0,
      };

      const result = await provider.execute(prInfo, config);

      expect(result.issues).toEqual([]);
      expect(result.suggestions).toEqual([]);
    });

    it('should handle dependency results', async () => {
      const config: CheckProviderConfig = {
        type: 'noop',
      };

      const prInfo: PRInfo = {
        number: 123,
        title: 'Test PR',
        body: 'Test description',
        author: 'test-user',
        base: 'main',
        head: 'feature/test',
        files: [],
        totalAdditions: 0,
        totalDeletions: 0,
      };

      const dependencyResults = new Map();
      dependencyResults.set('security', {
        issues: [
          { severity: 'error', message: 'Test issue', file: 'test.js', line: 1, ruleId: 'test' },
        ],
        suggestions: ['Fix security issue'],
      });

      const result = await provider.execute(prInfo, config, dependencyResults);

      // Noop provider should ignore dependency results
      expect(result.issues).toEqual([]);
      expect(result.suggestions).toEqual([]);
    });
  });

  describe('getSupportedConfigKeys', () => {
    it('should return expected config keys', () => {
      const keys = provider.getSupportedConfigKeys();
      expect(keys).toContain('type');
      expect(keys).toContain('command');
      expect(keys).toContain('depends_on');
      expect(keys).toContain('on');
      expect(keys).toContain('if');
      expect(keys).toContain('group');
    });
  });

  describe('isAvailable', () => {
    it('should always be available', async () => {
      const isAvailable = await provider.isAvailable();
      expect(isAvailable).toBe(true);
    });
  });

  describe('getRequirements', () => {
    it('should return requirements', () => {
      const requirements = provider.getRequirements();
      expect(requirements).toContain('No external dependencies required');
      expect(requirements.length).toBeGreaterThan(0);
    });
  });
});
