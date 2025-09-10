import { CheckExecutionEngine } from '../../src/check-execution-engine';
import { CheckProviderRegistry } from '../../src/providers/check-provider-registry';
import { VisorConfig } from '../../src/types/config';

// Mock the CheckProviderRegistry
jest.mock('../../src/providers/check-provider-registry');

describe('CheckExecutionEngine - Dependencies', () => {
  let engine: CheckExecutionEngine;
  let mockRegistry: jest.Mocked<CheckProviderRegistry>;
  let mockProvider: jest.Mocked<{ execute: jest.Mock }>;

  beforeEach(() => {
    // Reset the mock
    jest.clearAllMocks();

    // Create mock provider
    mockProvider = {
      execute: jest.fn().mockResolvedValue({
        issues: [],
        suggestions: [],
      }),
    };

    // Create mock registry
    mockRegistry = {
      getInstance: jest.fn(),
      hasProvider: jest.fn().mockReturnValue(true),
      getProviderOrThrow: jest.fn().mockReturnValue(mockProvider),
      registerProvider: jest.fn(),
      getAvailableProviders: jest.fn().mockReturnValue(['ai']),
      listProviders: jest.fn(),
    } as unknown as jest.Mocked<CheckProviderRegistry>;

    // Mock the singleton getInstance method
    (CheckProviderRegistry.getInstance as jest.Mock).mockReturnValue(mockRegistry);

    engine = new CheckExecutionEngine('.');
  });

  describe('dependency-aware execution', () => {
    it('should execute checks with no dependencies in parallel', async () => {
      const config: VisorConfig = {
        version: '1.0',
        checks: {
          security: {
            type: 'ai',
            prompt: 'Security check',
            on: ['pr_opened'],
          },
          performance: {
            type: 'ai',
            prompt: 'Performance check',
            on: ['pr_opened'],
          },
          style: {
            type: 'ai',
            prompt: 'Style check',
            on: ['pr_opened'],
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: false,
          },
        },
      };

      const result = await engine.executeChecks({
        checks: ['security', 'performance', 'style'],
        config,
        debug: true,
      });

      expect(result.reviewSummary.issues).toBeDefined();
      expect(mockProvider.execute).toHaveBeenCalledTimes(3);
    });

    it('should execute checks with linear dependencies sequentially', async () => {
      const config: VisorConfig = {
        version: '1.0',
        checks: {
          security: {
            type: 'ai',
            prompt: 'Security check',
            on: ['pr_opened'],
          },
          performance: {
            type: 'ai',
            prompt: 'Performance check',
            on: ['pr_opened'],
            depends_on: ['security'],
          },
          style: {
            type: 'ai',
            prompt: 'Style check',
            on: ['pr_opened'],
            depends_on: ['performance'],
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: false,
          },
        },
      };

      // Track execution order
      const executionOrder: string[] = [];
      mockProvider.execute.mockImplementation(
        (prInfo: unknown, providerConfig: { focus?: string }) => {
          // Extract check name from the prompt or focus
          const checkName = providerConfig.focus || 'unknown';
          executionOrder.push(checkName);
          return Promise.resolve({
            issues: [],
            suggestions: [`${checkName} completed`],
          });
        }
      );

      const result = await engine.executeChecks({
        checks: ['security', 'performance', 'style'],
        config,
        debug: true,
      });

      expect(result.reviewSummary.issues).toBeDefined();
      expect(mockProvider.execute).toHaveBeenCalledTimes(3);

      // Verify execution order respects dependencies
      expect(executionOrder.indexOf('security')).toBeLessThan(
        executionOrder.indexOf('performance')
      );
      expect(executionOrder.indexOf('performance')).toBeLessThan(executionOrder.indexOf('style'));
    });

    it('should handle mixed parallel and sequential execution', async () => {
      const config: VisorConfig = {
        version: '1.0',
        checks: {
          security: {
            type: 'ai',
            prompt: 'Security check',
            on: ['pr_opened'],
          },
          performance: {
            type: 'ai',
            prompt: 'Performance check',
            on: ['pr_opened'],
          },
          style: {
            type: 'ai',
            prompt: 'Style check',
            on: ['pr_opened'],
            depends_on: ['security', 'performance'],
          },
          architecture: {
            type: 'ai',
            prompt: 'Architecture check',
            on: ['pr_opened'],
            depends_on: ['style'],
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: false,
          },
        },
      };

      // Track execution order to verify dependency constraints
      const executionOrder: string[] = [];

      mockProvider.execute.mockImplementation(
        async (prInfo: unknown, providerConfig: { focus?: string }) => {
          const checkName = providerConfig.focus || 'unknown';
          executionOrder.push(checkName);

          return {
            issues: [],
            suggestions: [`${checkName} completed`],
          };
        }
      );

      const result = await engine.executeChecks({
        checks: ['security', 'performance', 'style', 'architecture'],
        config,
        debug: true,
      });

      expect(result.reviewSummary.issues).toBeDefined();
      expect(mockProvider.execute).toHaveBeenCalledTimes(4);

      // Verify execution order respects dependencies
      // security and performance should execute before style (no specific order between them)
      const securityIndex = executionOrder.indexOf('security');
      const performanceIndex = executionOrder.indexOf('performance');
      const styleIndex = executionOrder.indexOf('style');
      const architectureIndex = executionOrder.indexOf('architecture');

      expect(securityIndex).toBeGreaterThanOrEqual(0);
      expect(performanceIndex).toBeGreaterThanOrEqual(0);
      expect(styleIndex).toBeGreaterThan(Math.max(securityIndex, performanceIndex));
      expect(architectureIndex).toBeGreaterThan(styleIndex);
    });

    it('should handle circular dependencies gracefully', async () => {
      const config: VisorConfig = {
        version: '1.0',
        checks: {
          security: {
            type: 'ai',
            prompt: 'Security check',
            on: ['pr_opened'],
            depends_on: ['performance'],
          },
          performance: {
            type: 'ai',
            prompt: 'Performance check',
            on: ['pr_opened'],
            depends_on: ['security'],
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: false,
          },
        },
      };

      const result = await engine.executeChecks({
        checks: ['security', 'performance'],
        config,
      });

      // Should return error result instead of throwing
      expect(result.reviewSummary.issues).toHaveLength(1);
      expect(result.reviewSummary.issues[0].message).toContain('Circular dependencies detected');
      expect(mockProvider.execute).not.toHaveBeenCalled();
    });

    it('should handle missing dependencies gracefully', async () => {
      const config: VisorConfig = {
        version: '1.0',
        checks: {
          security: {
            type: 'ai',
            prompt: 'Security check',
            on: ['pr_opened'],
            depends_on: ['nonexistent'],
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: false,
          },
        },
      };

      const result = await engine.executeChecks({
        checks: ['security'],
        config,
      });

      // Should return error result instead of throwing
      expect(result.reviewSummary.issues).toHaveLength(1);
      expect(result.reviewSummary.issues[0].message).toContain('Dependency validation failed');
      expect(mockProvider.execute).not.toHaveBeenCalled();
    });

    it('should handle check failure and continue with dependent checks', async () => {
      const config: VisorConfig = {
        version: '1.0',
        checks: {
          security: {
            type: 'ai',
            prompt: 'Security check',
            on: ['pr_opened'],
          },
          performance: {
            type: 'ai',
            prompt: 'Performance check',
            on: ['pr_opened'],
            depends_on: ['security'],
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: false,
          },
        },
      };

      // Make security check fail
      mockProvider.execute.mockImplementation(
        (prInfo: unknown, providerConfig: { focus?: string }) => {
          const checkName = providerConfig.focus || 'unknown';
          if (checkName === 'security') {
            throw new Error('Security check failed');
          }
          return Promise.resolve({
            issues: [],
            suggestions: [`${checkName} completed`],
          });
        }
      );

      const result = await engine.executeChecks({
        checks: ['security', 'performance'],
        config,
        debug: true,
      });

      expect(result.reviewSummary.issues).toBeDefined();
      expect(mockProvider.execute).toHaveBeenCalledTimes(2);

      // Should have error issues from failed security check
      const errorIssues = result.reviewSummary.issues.filter(issue =>
        issue.ruleId?.includes('error')
      );
      expect(errorIssues).toHaveLength(1);
      expect(errorIssues[0].message).toContain('Security check failed');
    });

    it('should include dependency execution statistics in debug output', async () => {
      const config: VisorConfig = {
        version: '1.0',
        checks: {
          security: {
            type: 'ai',
            prompt: 'Security check',
            on: ['pr_opened'],
          },
          performance: {
            type: 'ai',
            prompt: 'Performance check',
            on: ['pr_opened'],
            depends_on: ['security'],
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: false,
          },
        },
      };

      const result = await engine.executeChecks({
        checks: ['security', 'performance'],
        config,
        debug: true,
      });

      const containsExecutionCompleted = result.reviewSummary.suggestions.some(suggestion =>
        suggestion.includes('Dependency-aware execution completed')
      );
      expect(containsExecutionCompleted).toBe(true);

      const containsExecutionLevels = result.reviewSummary.suggestions.some(suggestion =>
        suggestion.includes('2 checks in 2 execution levels')
      );
      expect(containsExecutionLevels).toBe(true);

      const containsMaxParallelism = result.reviewSummary.suggestions.some(suggestion =>
        suggestion.includes('Maximum parallelism: 1')
      );
      expect(containsMaxParallelism).toBe(true);
    });
  });
});
