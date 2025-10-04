import { CheckExecutionEngine } from '../../src/check-execution-engine';
import { VisorConfig, TagFilter } from '../../src/types/config';
import { PRInfo } from '../../src/pr-analyzer';

describe('Tag-Based Execution Integration', () => {
  let engine: CheckExecutionEngine;
  let mockPRInfo: PRInfo;

  beforeEach(() => {
    engine = new CheckExecutionEngine();
    mockPRInfo = {
      number: 1,
      title: 'Test PR',
      body: 'Test PR body',
      author: 'testuser',
      base: 'main',
      head: 'feature-branch',
      files: [],
      totalAdditions: 0,
      totalDeletions: 0,
    };
  });

  describe('Comprehensive tag filtering scenarios', () => {
    const createConfig = (): VisorConfig => ({
      version: '1.0',
      checks: {
        // Local checks
        'local-security': {
          type: 'noop',
          tags: ['local', 'security', 'fast'],
          on: ['pr_opened', 'pr_updated'],
        },
        'local-performance': {
          type: 'noop',
          tags: ['local', 'performance', 'fast'],
          on: ['pr_opened', 'pr_updated'],
        },
        'local-style': {
          type: 'noop',
          tags: ['local', 'style', 'fast'],
          on: ['pr_opened', 'pr_updated'],
        },

        // Remote checks
        'remote-security-comprehensive': {
          type: 'noop',
          tags: ['remote', 'security', 'comprehensive', 'slow'],
          on: ['pr_opened'],
        },
        'remote-performance-analysis': {
          type: 'noop',
          tags: ['remote', 'performance', 'comprehensive', 'slow'],
          on: ['pr_opened'],
        },

        // Experimental checks
        'experimental-ai-review': {
          type: 'noop',
          tags: ['experimental', 'ai', 'comprehensive'],
          on: ['pr_opened', 'pr_updated'],
        },

        // Dependency check example
        'security-report': {
          type: 'noop',
          tags: ['reporting', 'local', 'remote'],
          depends_on: ['local-security', 'remote-security-comprehensive'],
          on: ['pr_opened', 'pr_updated'],
        },
      },
      output: {
        pr_comment: {
          format: 'table' as const,
          group_by: 'check' as const,
          collapse: false,
        },
      },
    });

    it('should run only local checks when filtered by local tag', async () => {
      const config = createConfig();
      const tagFilter: TagFilter = { include: ['local'] };

      const { results } = await engine.executeGroupedChecks(
        mockPRInfo,
        Object.keys(config.checks),
        30000,
        config,
        'json',
        false,
        3,
        false,
        tagFilter
      );

      // Results are grouped by 'group' field, extract check names
      const executedChecks: string[] = [];
      for (const group of Object.values(results)) {
        for (const check of group) {
          if (check.checkName) {
            executedChecks.push(check.checkName);
          }
        }
      }

      expect(executedChecks).toContain('local-security');
      expect(executedChecks).toContain('local-performance');
      expect(executedChecks).toContain('local-style');
      expect(executedChecks).toContain('security-report'); // Has 'local' tag
      expect(executedChecks).not.toContain('remote-security-comprehensive');
      expect(executedChecks).not.toContain('remote-performance-analysis');
      expect(executedChecks).not.toContain('experimental-ai-review');
    });

    it('should run only remote checks when filtered by remote tag', async () => {
      const config = createConfig();
      const tagFilter: TagFilter = { include: ['remote'] };

      const { results } = await engine.executeGroupedChecks(
        mockPRInfo,
        Object.keys(config.checks),
        30000,
        config,
        'json',
        false,
        3,
        false,
        tagFilter
      );

      // Results are grouped by 'group' field, extract check names
      const executedChecks: string[] = [];
      for (const group of Object.values(results)) {
        for (const check of group) {
          if (check.checkName) {
            executedChecks.push(check.checkName);
          }
        }
      }

      expect(executedChecks).toContain('remote-security-comprehensive');
      expect(executedChecks).toContain('remote-performance-analysis');
      expect(executedChecks).toContain('security-report'); // Has 'remote' tag
      expect(executedChecks).not.toContain('local-security');
      expect(executedChecks).not.toContain('local-performance');
      expect(executedChecks).not.toContain('local-style');
    });

    it('should exclude slow checks when specified', async () => {
      const config = createConfig();
      const tagFilter: TagFilter = { exclude: ['slow'] };

      const { results } = await engine.executeGroupedChecks(
        mockPRInfo,
        Object.keys(config.checks),
        30000,
        config,
        'json',
        false,
        3,
        false,
        tagFilter
      );

      // Results are grouped by 'group' field, extract check names
      const executedChecks: string[] = [];
      for (const group of Object.values(results)) {
        for (const check of group) {
          if (check.checkName) {
            executedChecks.push(check.checkName);
          }
        }
      }

      expect(executedChecks).toContain('local-security');
      expect(executedChecks).toContain('local-performance');
      expect(executedChecks).toContain('local-style');
      expect(executedChecks).not.toContain('remote-security-comprehensive');
      expect(executedChecks).not.toContain('remote-performance-analysis');
    });

    it('should run fast local checks excluding experimental', async () => {
      const config = createConfig();
      const tagFilter: TagFilter = {
        include: ['local', 'fast'],
        exclude: ['experimental'],
      };

      const { results } = await engine.executeGroupedChecks(
        mockPRInfo,
        Object.keys(config.checks),
        30000,
        config,
        'json',
        false,
        3,
        false,
        tagFilter
      );

      // Results are grouped by 'group' field, extract check names
      const executedChecks: string[] = [];
      for (const group of Object.values(results)) {
        for (const check of group) {
          if (check.checkName) {
            executedChecks.push(check.checkName);
          }
        }
      }

      expect(executedChecks).toContain('local-security');
      expect(executedChecks).toContain('local-performance');
      expect(executedChecks).toContain('local-style');
      expect(executedChecks).not.toContain('experimental-ai-review');
    });

    it('should run security checks only', async () => {
      const config = createConfig();
      const tagFilter: TagFilter = { include: ['security'] };

      const { results } = await engine.executeGroupedChecks(
        mockPRInfo,
        Object.keys(config.checks),
        30000,
        config,
        'json',
        false,
        3,
        false,
        tagFilter
      );

      // Results are grouped by 'group' field, extract check names
      const executedChecks: string[] = [];
      for (const group of Object.values(results)) {
        for (const check of group) {
          if (check.checkName) {
            executedChecks.push(check.checkName);
          }
        }
      }

      expect(executedChecks).toContain('local-security');
      expect(executedChecks).toContain('remote-security-comprehensive');
      expect(executedChecks).not.toContain('local-performance');
      expect(executedChecks).not.toContain('local-style');
    });

    it('should handle dependencies with tag filtering', async () => {
      const config = createConfig();

      // Remove remote checks but keep the report that depends on them
      const tagFilter: TagFilter = {
        include: ['local'],
      };

      const { results } = await engine.executeGroupedChecks(
        mockPRInfo,
        Object.keys(config.checks),
        30000,
        config,
        'json',
        false,
        3,
        false,
        tagFilter
      );

      // Results are grouped by 'group' field, extract check names
      const executedChecks: string[] = [];
      for (const group of Object.values(results)) {
        for (const check of group) {
          if (check.checkName) {
            executedChecks.push(check.checkName);
          }
        }
      }

      // Should include the report and local-security
      expect(executedChecks).toContain('security-report');
      expect(executedChecks).toContain('local-security');

      // Remote dependency should not be executed
      expect(executedChecks).not.toContain('remote-security-comprehensive');

      // The report should still run even though one dependency is filtered out
      // This demonstrates soft dependencies - it uses what's available
    });

    it('should handle comprehensive vs fast execution profiles', async () => {
      const config = createConfig();

      // Fast profile - for local development
      const fastFilter: TagFilter = {
        include: ['fast'],
      };

      const fastResult = await engine.executeGroupedChecks(
        mockPRInfo,
        Object.keys(config.checks),
        30000,
        config,
        'json',
        false,
        3,
        false,
        fastFilter
      );

      // Results are grouped by 'group' field, extract check names
      const fastChecks: string[] = [];
      for (const group of Object.values(fastResult.results)) {
        for (const check of group) {
          if (check.checkName) {
            fastChecks.push(check.checkName);
          }
        }
      }

      // Should only include fast checks
      expect(fastChecks).toContain('local-security');
      expect(fastChecks).toContain('local-performance');
      expect(fastChecks).toContain('local-style');
      expect(fastChecks.length).toBe(3);

      // Comprehensive profile - for CI/remote
      const comprehensiveFilter: TagFilter = {
        include: ['comprehensive'],
      };

      const { results: comprehensiveResults } = await engine.executeGroupedChecks(
        mockPRInfo,
        Object.keys(config.checks),
        30000,
        config,
        'json',
        false,
        3,
        false,
        comprehensiveFilter
      );

      // Results are grouped by 'group' field, extract check names
      const comprehensiveChecks: string[] = [];
      for (const group of Object.values(comprehensiveResults)) {
        for (const check of group) {
          if (check.checkName) {
            comprehensiveChecks.push(check.checkName);
          }
        }
      }

      // Should include comprehensive checks
      expect(comprehensiveChecks).toContain('remote-security-comprehensive');
      expect(comprehensiveChecks).toContain('remote-performance-analysis');
      expect(comprehensiveChecks).toContain('experimental-ai-review');
    });

    it('should return empty results when no checks match filters', async () => {
      const config = createConfig();
      const tagFilter: TagFilter = { include: ['non-existent-tag'] };

      const { results } = await engine.executeGroupedChecks(
        mockPRInfo,
        Object.keys(config.checks),
        30000,
        config,
        'json',
        false,
        3,
        false,
        tagFilter
      );

      expect(Object.keys(results).length).toBe(0);
    });

    it('should combine multiple include tags with OR logic', async () => {
      const config = createConfig();
      const tagFilter: TagFilter = {
        include: ['security', 'performance'],
      };

      const { results } = await engine.executeGroupedChecks(
        mockPRInfo,
        Object.keys(config.checks),
        30000,
        config,
        'json',
        false,
        3,
        false,
        tagFilter
      );

      // Results are grouped by 'group' field, extract check names
      const executedChecks: string[] = [];
      for (const group of Object.values(results)) {
        for (const check of group) {
          if (check.checkName) {
            executedChecks.push(check.checkName);
          }
        }
      }

      // Should include both security AND performance checks
      expect(executedChecks).toContain('local-security');
      expect(executedChecks).toContain('local-performance');
      expect(executedChecks).toContain('remote-security-comprehensive');
      expect(executedChecks).toContain('remote-performance-analysis');

      // Should NOT include style or experimental checks
      expect(executedChecks).not.toContain('local-style');
      expect(executedChecks).not.toContain('experimental-ai-review');
    });
  });
});
