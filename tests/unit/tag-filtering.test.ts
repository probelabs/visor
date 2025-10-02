import { CheckExecutionEngine } from '../../src/check-execution-engine';
import { VisorConfig, TagFilter, CheckConfig } from '../../src/types/config';

describe('Tag Filtering', () => {
  let engine: CheckExecutionEngine;

  beforeEach(() => {
    engine = new CheckExecutionEngine();
  });

  describe('filterChecksByTags', () => {
    const createConfig = (checks: Record<string, CheckConfig>): VisorConfig => ({
      version: '1.0',
      checks,
      output: {
        pr_comment: {
          format: 'table' as const,
          group_by: 'check' as const,
          collapse: false,
        },
      },
    });

    it('should exclude checks with tags when no tag filter is specified', () => {
      const config = createConfig({
        security: { type: 'ai', prompt: 'security check', tags: ['security', 'critical'] },
        performance: { type: 'ai', prompt: 'performance check', tags: ['performance', 'optional'] },
        style: { type: 'ai', prompt: 'style check', tags: ['style', 'fast'] },
      });

      const checks = ['security', 'performance', 'style'];
      // Access private method for testing
      const result = (
        engine as unknown as {
          filterChecksByTags: (
            checks: string[],
            config: VisorConfig,
            tagFilter: TagFilter | undefined
          ) => string[];
        }
      ).filterChecksByTags(checks, config, undefined);

      // All checks have tags, so they should be excluded when no tag filter is specified
      expect(result).toEqual([]);
    });

    it('should include checks without tags when no tag filter is specified', () => {
      const config = createConfig({
        security: { type: 'ai', prompt: 'security check', tags: ['security'] },
        untagged1: { type: 'ai', prompt: 'untagged check 1' },
        untagged2: { type: 'ai', prompt: 'untagged check 2' },
      });

      const checks = ['security', 'untagged1', 'untagged2'];
      const result = (
        engine as unknown as {
          filterChecksByTags: (
            checks: string[],
            config: VisorConfig,
            tagFilter: TagFilter | undefined
          ) => string[];
        }
      ).filterChecksByTags(checks, config, undefined);

      // Checks without tags should run, but checks with tags should be excluded
      expect(result).toEqual(['untagged1', 'untagged2']);
    });

    it('should filter checks by include tags', () => {
      const config = createConfig({
        security: { type: 'ai', prompt: 'security check', tags: ['security', 'critical'] },
        performance: { type: 'ai', prompt: 'performance check', tags: ['performance', 'optional'] },
        style: { type: 'ai', prompt: 'style check', tags: ['style', 'fast'] },
      });

      const tagFilter: TagFilter = { include: ['fast'] };
      const checks = ['security', 'performance', 'style'];
      const result = (
        engine as unknown as {
          filterChecksByTags: (
            checks: string[],
            config: VisorConfig,
            tagFilter: TagFilter | undefined
          ) => string[];
        }
      ).filterChecksByTags(checks, config, tagFilter);

      expect(result).toEqual(['style']);
    });

    it('should filter checks by exclude tags', () => {
      const config = createConfig({
        security: { type: 'ai', prompt: 'security check', tags: ['security', 'slow'] },
        performance: { type: 'ai', prompt: 'performance check', tags: ['performance', 'slow'] },
        style: { type: 'ai', prompt: 'style check', tags: ['style', 'fast'] },
      });

      const tagFilter: TagFilter = { exclude: ['slow'] };
      const checks = ['security', 'performance', 'style'];
      const result = (
        engine as unknown as {
          filterChecksByTags: (
            checks: string[],
            config: VisorConfig,
            tagFilter: TagFilter | undefined
          ) => string[];
        }
      ).filterChecksByTags(checks, config, tagFilter);

      expect(result).toEqual(['style']);
    });

    it('should handle both include and exclude tags', () => {
      const config = createConfig({
        security: { type: 'ai', prompt: 'security check', tags: ['local', 'security', 'critical'] },
        performance: { type: 'ai', prompt: 'performance check', tags: ['local', 'performance'] },
        remote: { type: 'ai', prompt: 'remote check', tags: ['remote', 'comprehensive'] },
        experimental: { type: 'ai', prompt: 'experimental check', tags: ['local', 'experimental'] },
      });

      const tagFilter: TagFilter = {
        include: ['local'],
        exclude: ['experimental'],
      };
      const checks = ['security', 'performance', 'remote', 'experimental'];
      const result = (
        engine as unknown as {
          filterChecksByTags: (
            checks: string[],
            config: VisorConfig,
            tagFilter: TagFilter | undefined
          ) => string[];
        }
      ).filterChecksByTags(checks, config, tagFilter);

      expect(result).toEqual(['security', 'performance']);
    });

    it('should include checks with no tags when tag filter is applied', () => {
      const config = createConfig({
        security: { type: 'ai', prompt: 'security check', tags: ['security'] },
        untagged: { type: 'ai', prompt: 'untagged check' }, // No tags
      });

      const tagFilter: TagFilter = { include: ['security'] };
      const checks = ['security', 'untagged'];
      const result = (
        engine as unknown as {
          filterChecksByTags: (
            checks: string[],
            config: VisorConfig,
            tagFilter: TagFilter | undefined
          ) => string[];
        }
      ).filterChecksByTags(checks, config, tagFilter);

      // untagged check should be included even when tag filter is applied (it has no tags to filter)
      expect(result).toEqual(['security', 'untagged']);
    });

    it('should exclude checks without configuration', () => {
      const config = createConfig({
        security: { type: 'ai', prompt: 'security check', tags: ['security'] },
      });

      const tagFilter: TagFilter = { include: ['security'] };
      const checks = ['security', 'non-existent'];
      const result = (
        engine as unknown as {
          filterChecksByTags: (
            checks: string[],
            config: VisorConfig,
            tagFilter: TagFilter | undefined
          ) => string[];
        }
      ).filterChecksByTags(checks, config, tagFilter);

      // non-existent check should be included by default when not configured
      expect(result).toEqual(['security', 'non-existent']);
    });

    it('should match any tag in include list', () => {
      const config = createConfig({
        security: { type: 'ai', prompt: 'security check', tags: ['security', 'critical'] },
        performance: { type: 'ai', prompt: 'performance check', tags: ['performance', 'optional'] },
        style: { type: 'ai', prompt: 'style check', tags: ['style', 'optional'] },
      });

      const tagFilter: TagFilter = { include: ['critical', 'optional'] };
      const checks = ['security', 'performance', 'style'];
      const result = (
        engine as unknown as {
          filterChecksByTags: (
            checks: string[],
            config: VisorConfig,
            tagFilter: TagFilter | undefined
          ) => string[];
        }
      ).filterChecksByTags(checks, config, tagFilter);

      expect(result).toEqual(['security', 'performance', 'style']);
    });

    it('should exclude if any exclude tag matches', () => {
      const config = createConfig({
        security: { type: 'ai', prompt: 'security check', tags: ['security', 'slow', 'critical'] },
        performance: { type: 'ai', prompt: 'performance check', tags: ['performance', 'fast'] },
        style: { type: 'ai', prompt: 'style check', tags: ['style', 'experimental', 'fast'] },
      });

      const tagFilter: TagFilter = { exclude: ['slow', 'experimental'] };
      const checks = ['security', 'performance', 'style'];
      const result = (
        engine as unknown as {
          filterChecksByTags: (
            checks: string[],
            config: VisorConfig,
            tagFilter: TagFilter | undefined
          ) => string[];
        }
      ).filterChecksByTags(checks, config, tagFilter);

      expect(result).toEqual(['performance']);
    });

    it('should prioritize exclude over include', () => {
      const config = createConfig({
        security: { type: 'ai', prompt: 'security check', tags: ['important', 'slow'] },
        performance: { type: 'ai', prompt: 'performance check', tags: ['important', 'fast'] },
      });

      const tagFilter: TagFilter = {
        include: ['important'],
        exclude: ['slow'],
      };
      const checks = ['security', 'performance'];
      const result = (
        engine as unknown as {
          filterChecksByTags: (
            checks: string[],
            config: VisorConfig,
            tagFilter: TagFilter | undefined
          ) => string[];
        }
      ).filterChecksByTags(checks, config, tagFilter);

      // Security should be excluded even though it has the 'important' tag
      expect(result).toEqual(['performance']);
    });
  });
});
