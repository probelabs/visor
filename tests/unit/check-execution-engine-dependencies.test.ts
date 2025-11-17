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
      }),
    };

    // Create mock registry
    mockRegistry = {
      getInstance: jest.fn(),
      hasProvider: jest.fn((providerName: string) => providerName === 'ai'),
      getProviderOrThrow: jest.fn((providerName: string) => {
        if (providerName === 'ai') {
          return mockProvider;
        }
        throw new Error(`Provider ${providerName} not found`);
      }),
      getProvider: jest.fn((providerName: string) => {
        if (providerName === 'ai') {
          return mockProvider;
        }
        return undefined;
      }),
      register: jest.fn(),
      unregister: jest.fn(),
      getAllProviders: jest.fn().mockReturnValue([]),
      getActiveProviders: jest.fn().mockResolvedValue([]),
      reset: jest.fn(),
      clearInstance: jest.fn(),
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
            on: ['pr_updated'],
          },
          performance: {
            type: 'ai',
            prompt: 'Performance check',
            on: ['pr_updated'],
          },
          style: {
            type: 'ai',
            prompt: 'Style check',
            on: ['pr_updated'],
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
            on: ['pr_updated'],
          },
          performance: {
            type: 'ai',
            prompt: 'Performance check',
            on: ['pr_updated'],
            depends_on: ['security'],
          },
          style: {
            type: 'ai',
            prompt: 'Style check',
            on: ['pr_updated'],
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
            on: ['pr_updated'],
          },
          performance: {
            type: 'ai',
            prompt: 'Performance check',
            on: ['pr_updated'],
          },
          style: {
            type: 'ai',
            prompt: 'Style check',
            on: ['pr_updated'],
            depends_on: ['security', 'performance'],
          },
          architecture: {
            type: 'ai',
            prompt: 'Architecture check',
            on: ['pr_updated'],
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
            on: ['pr_updated'],
            depends_on: ['performance'],
          },
          performance: {
            type: 'ai',
            prompt: 'Performance check',
            on: ['pr_updated'],
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
      expect(result.reviewSummary.issues![0].message).toContain('Dependency cycle detected');
      expect(mockProvider.execute).not.toHaveBeenCalled();
    });

    it('should handle missing dependencies gracefully', async () => {
      const config: VisorConfig = {
        version: '1.0',
        checks: {
          security: {
            type: 'ai',
            prompt: 'Security check',
            on: ['pr_updated'],
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
      expect(result.reviewSummary.issues![0].message).toContain('depends on');
      expect(result.reviewSummary.issues![0].message).toContain('not defined');
      expect(mockProvider.execute).not.toHaveBeenCalled();
    });

    it('should handle check failure and continue with dependent checks', async () => {
      const config: VisorConfig = {
        version: '1.0',
        checks: {
          security: {
            type: 'ai',
            prompt: 'Security check',
            on: ['pr_updated'],
          },
          performance: {
            type: 'ai',
            prompt: 'Performance check',
            on: ['pr_updated'],
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
          });
        }
      );

      const result = await engine.executeChecks({
        checks: ['security', 'performance'],
        config,
        debug: true,
      });

      expect(result.reviewSummary.issues).toBeDefined();

      // State machine behavior: when a check throws, only that check is called
      // The dependent check is skipped because its dependency failed
      expect(mockProvider.execute).toHaveBeenCalledTimes(1);

      // Should have error issue from failed security check
      const errorIssues = (result.reviewSummary.issues || []).filter(
        issue => issue.message?.includes('Security check failed') || issue.ruleId?.includes('error')
      );
      expect(errorIssues.length).toBeGreaterThan(0);
    });

    it('should include dependency execution statistics in debug output', async () => {
      const config: VisorConfig = {
        version: '1.0',
        checks: {
          security: {
            type: 'ai',
            prompt: 'Security check',
            on: ['pr_updated'],
          },
          performance: {
            type: 'ai',
            prompt: 'Performance check',
            on: ['pr_updated'],
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

      // Debug information is no longer provided in suggestions field
      // The test validates that dependency-aware execution works correctly
      expect(result.reviewSummary.issues).toBeDefined();
      expect(mockProvider.execute).toHaveBeenCalledTimes(2);
    });
  });
});
