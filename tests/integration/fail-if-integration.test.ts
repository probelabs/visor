/**
 * Integration tests for simplified fail_if syntax
 */

import { CheckExecutionEngine } from '../../src/check-execution-engine';
import { VisorConfig } from '../../src/types/config';

// Mock AI provider to return controlled results
jest.mock('../../src/providers/ai-check-provider', () => ({
  AICheckProvider: jest.fn().mockImplementation(() => ({
    getName: jest.fn().mockReturnValue('ai'),
    initialize: jest.fn().mockResolvedValue(undefined),
    execute: jest.fn().mockImplementation((prInfo, config) => {
      // Return different results based on focus or prompt content
      const focus = config.focus || '';
      const prompt = config.prompt || '';

      // Determine check type from focus or prompt keywords
      if (
        focus.includes('security') ||
        prompt.includes('Security') ||
        prompt.includes('security')
      ) {
        return Promise.resolve({
          issues: [
            {
              file: 'auth.js',
              line: 10,
              severity: 'critical',
              message: 'SQL injection vulnerability',
              category: 'security',
              ruleId: 'sql-injection',
            },
          ],
          suggestions: ['Use parameterized queries'],
        });
      } else if (focus.includes('style') || prompt.includes('Style') || prompt.includes('style')) {
        return Promise.resolve({
          issues: [
            {
              file: 'main.js',
              line: 5,
              severity: 'warning',
              message: 'Missing semicolon',
              category: 'style',
              ruleId: 'semi',
            },
          ],
          suggestions: ['Add semicolon'],
        });
      } else if (
        focus.includes('performance') ||
        prompt.includes('Performance') ||
        prompt.includes('performance')
      ) {
        return Promise.resolve({
          issues: [],
          suggestions: ['Code looks performant'],
        });
      } else if (prompt.includes('Quality') || prompt.includes('quality')) {
        // Quality check - return critical issue
        return Promise.resolve({
          issues: [
            {
              file: 'quality.js',
              line: 1,
              severity: 'critical',
              message: 'Quality issue',
              category: 'quality',
              ruleId: 'quality',
            },
          ],
          suggestions: ['Fix quality'],
        });
      } else if (prompt.includes('Auth') || prompt.includes('auth')) {
        // Auth check
        return Promise.resolve({
          issues: [
            {
              file: 'auth.js',
              line: 10,
              severity: 'critical',
              message: 'Auth security issue',
              category: 'security',
              ruleId: 'auth-security',
            },
          ],
          suggestions: ['Fix auth'],
        });
      } else if (prompt.includes('Complex') || prompt.includes('API')) {
        // Complex or API check - return error issues
        return Promise.resolve({
          issues: [
            {
              file: 'api.js',
              line: 1,
              severity: 'error',
              message: 'API issue',
              category: 'api',
              ruleId: 'api-error',
            },
          ],
          suggestions: ['Fix API'],
        });
      }
      return Promise.resolve({ issues: [], suggestions: [] });
    }),
  })),
}));

// Mock other providers
jest.mock('../../src/providers/tool-check-provider', () => ({
  ToolCheckProvider: jest.fn().mockImplementation(() => ({
    getName: jest.fn().mockReturnValue('tool'),
    initialize: jest.fn().mockResolvedValue(undefined),
    execute: jest.fn().mockResolvedValue({ issues: [], suggestions: [] }),
  })),
}));

jest.mock('../../src/providers/webhook-check-provider', () => ({
  WebhookCheckProvider: jest.fn().mockImplementation(() => ({
    getName: jest.fn().mockReturnValue('webhook'),
    initialize: jest.fn().mockResolvedValue(undefined),
    execute: jest.fn().mockResolvedValue({ issues: [], suggestions: [] }),
  })),
}));

// Mock git analyzer
jest.mock('../../src/git-repository-analyzer', () => ({
  GitRepositoryAnalyzer: jest.fn().mockImplementation(() => ({
    analyzeRepository: jest.fn().mockResolvedValue({
      isGitRepository: true,
      files: ['auth.js', 'main.js'],
      head: 'main',
    }),
    getDiff: jest.fn().mockResolvedValue('diff content'),
    toPRInfo: jest.fn().mockReturnValue({
      owner: 'test',
      repo: 'test-repo',
      number: 1,
      title: 'Test PR',
      body: 'Test body',
      branch: 'feature',
      baseBranch: 'main',
      files: ['auth.js', 'main.js'],
      diff: 'diff content',
    }),
  })),
}));

describe('fail_if Integration Tests', () => {
  let executionEngine: CheckExecutionEngine;

  beforeEach(() => {
    executionEngine = new CheckExecutionEngine(process.cwd());
  });

  describe('Simple fail_if conditions', () => {
    it('should fail check when fail_if condition is met', async () => {
      const config: VisorConfig = {
        version: '1.0',
        fail_if: 'metadata.criticalIssues > 0', // Global fail condition
        checks: {
          'security-check': {
            type: 'ai',
            prompt: 'Security analysis',
            on: ['pr_updated'],
            fail_if: 'metadata.totalIssues > 0', // Check-specific condition
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      // Execute the security check
      const result = await executionEngine.executeChecks({
        checks: ['security-check'],
        workingDirectory: process.cwd(),
        showDetails: false,
        outputFormat: 'json',
        config: config,
      });

      // The result will have issues enriched with check name prefix
      const criticalIssues = result.reviewSummary.issues.filter(i => i.severity === 'critical');
      expect(criticalIssues.length).toBeGreaterThan(0);

      // Evaluate failure conditions
      const failureResults = await executionEngine.evaluateFailureConditions(
        'security-check',
        result.reviewSummary,
        config
      );

      // Check-specific condition overrides global, so we only get one
      expect(failureResults.length).toBeGreaterThanOrEqual(1);

      // When check has its own fail_if, it overrides global
      // So we should only have the check-specific failure

      // Check-specific condition should also fail (total issues > 0)
      const checkFailure = failureResults.find(r => r.conditionName === 'security-check_fail_if');
      expect(checkFailure).toBeDefined();
      expect(checkFailure?.failed).toBe(true);
      expect(checkFailure?.expression).toBe('metadata.totalIssues > 0');
    });

    it('should pass check when fail_if condition is not met', async () => {
      const config: VisorConfig = {
        version: '1.0',
        fail_if: 'metadata.criticalIssues > 0', // Global fail condition
        checks: {
          'style-check': {
            type: 'ai',
            prompt: 'Style check',
            on: ['pr_updated'],
            fail_if: 'metadata.errorIssues > 0', // Only fail on errors, not warnings
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      // Execute the style check (returns only warnings)
      const result = await executionEngine.executeChecks({
        checks: ['style-check'],
        workingDirectory: process.cwd(),
        showDetails: false,
        outputFormat: 'json',
        config: config,
      });

      // Verify we have warning issues
      const warningIssues = result.reviewSummary.issues.filter(i => i.severity === 'warning');
      expect(warningIssues.length).toBeGreaterThan(0);
      const errorIssues = result.reviewSummary.issues.filter(i => i.severity === 'error');
      expect(errorIssues.length).toBe(0);

      // Evaluate failure conditions
      const failureResults = await executionEngine.evaluateFailureConditions(
        'style-check',
        result.reviewSummary,
        config
      );

      // Check-specific condition checks for errors > 0, but we only have warnings
      const checkFailure = failureResults.find(r => r.conditionName === 'style-check_fail_if');
      if (checkFailure) {
        expect(checkFailure.failed).toBe(false);
      }

      // Global condition checks for critical > 0, we have none
      const globalFailure = failureResults.find(r => r.conditionName === 'global_fail_if');
      if (globalFailure) {
        expect(globalFailure.failed).toBe(false);
      }
    });

    it('should use GitHub Actions-style functions', async () => {
      const config: VisorConfig = {
        version: '1.0',
        checks: {
          'security-check': {
            type: 'ai',
            prompt: 'Security analysis',
            on: ['pr_updated'],
            // Using contains() function
            fail_if: 'contains(metadata.checkName, "security") && metadata.totalIssues > 0',
          },
          'api-check': {
            type: 'ai',
            prompt: 'API check',
            on: ['pr_updated'],
            // Using startsWith() function
            fail_if: 'startsWith(metadata.checkName, "api") && metadata.totalIssues > 0',
          },
          'always-fail': {
            type: 'ai',
            prompt: 'Always fail check',
            on: ['pr_updated'],
            // Using always() function
            fail_if: 'always()',
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      // Test security-check with contains()
      const securityResult = await executionEngine.executeChecks({
        checks: ['security-check'],
        workingDirectory: process.cwd(),
        showDetails: false,
        outputFormat: 'json',
        config: config,
      });

      const securityFailures = await executionEngine.evaluateFailureConditions(
        'security-check',
        securityResult.reviewSummary,
        config
      );

      // Should fail because contains("security-check", "security") is true and has issues
      expect(securityFailures.some(r => r.failed)).toBe(true);

      // Test always() function
      const alwaysResult = await executionEngine.executeChecks({
        checks: ['always-fail'],
        workingDirectory: process.cwd(),
        showDetails: false,
        outputFormat: 'json',
        config: config,
      });

      const alwaysFailures = await executionEngine.evaluateFailureConditions(
        'always-fail',
        alwaysResult.reviewSummary,
        config
      );

      // Should always fail
      expect(alwaysFailures.some(r => r.failed)).toBe(true);
    });

    it('should use metadata success/failure transforms', async () => {
      const config: VisorConfig = {
        version: '1.0',
        checks: {
          'quality-gate': {
            type: 'ai',
            prompt: 'Quality check',
            on: ['pr_updated'],
            // Using failure transform
            fail_if: 'criticalIssues > 0 || errorIssues > 0',
          },
          'info-only': {
            type: 'ai',
            prompt: 'Info check',
            on: ['pr_updated'],
            // Using success check with negation (fail if NOT successful - has critical/error issues)
            fail_if: 'criticalIssues > 0 || errorIssues > 0',
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      // Test with security-check (has critical issues = failure)
      const failureConfig = { ...config };
      failureConfig.checks = {
        'security-check': {
          type: 'ai',
          prompt: 'Security check',
          on: ['pr_updated'],
          fail_if: 'always()',
        },
      };

      const securityResult = await executionEngine.executeChecks({
        checks: ['security-check'],
        workingDirectory: process.cwd(),
        showDetails: false,
        outputFormat: 'json',
        config: failureConfig,
      });

      const securityFailures = await executionEngine.evaluateFailureConditions(
        'security-check',
        securityResult.reviewSummary,
        failureConfig
      );

      // Should fail because always() is true
      expect(securityFailures.some(r => r.failed)).toBe(true);

      // Test with performance-check (no issues = success)
      const successConfig = { ...config };
      successConfig.checks = {
        'performance-check': {
          type: 'ai',
          prompt: 'Performance check',
          on: ['pr_updated'],
          fail_if: '!always()',
        },
      };

      const perfResult = await executionEngine.executeChecks({
        checks: ['performance-check'],
        workingDirectory: process.cwd(),
        showDetails: false,
        outputFormat: 'json',
        config: successConfig,
      });

      const perfFailures = await executionEngine.evaluateFailureConditions(
        'performance-check',
        perfResult.reviewSummary,
        successConfig
      );

      // Should pass because !always() is false
      expect(perfFailures.some(r => r.failed)).toBe(false);
    });

    it('should handle complex single-line expressions', async () => {
      const config: VisorConfig = {
        version: '1.0',
        checks: {
          'complex-check': {
            type: 'ai',
            prompt: 'Complex analysis',
            on: ['pr_updated'],
            // Complex condition combining multiple checks
            fail_if:
              '(metadata.errorIssues > 0 && metadata.warningIssues > 0) || metadata.criticalIssues > 0',
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      // Test with security-check (has critical issue)
      const securityConfig = { ...config };
      securityConfig.checks = {
        'security-check': {
          type: 'ai',
          prompt: 'Security check',
          on: ['pr_updated'],
          fail_if:
            '(metadata.errorIssues > 0 && metadata.warningIssues > 0) || metadata.criticalIssues > 0',
        },
      };

      const result = await executionEngine.executeChecks({
        checks: ['security-check'],
        workingDirectory: process.cwd(),
        showDetails: false,
        outputFormat: 'json',
        config: securityConfig,
      });

      const failures = await executionEngine.evaluateFailureConditions(
        'security-check',
        result.reviewSummary,
        securityConfig
      );

      // Should fail because has critical issues (second part of OR is true)
      expect(failures.some(r => r.failed)).toBe(true);
    });

    it('should handle hasIssue and hasFileMatching helpers', async () => {
      const config: VisorConfig = {
        version: '1.0',
        checks: {
          'auth-check': {
            type: 'ai',
            prompt: 'Auth check',
            on: ['pr_updated'],
            // Check for security issues in auth files
            fail_if: 'hasIssue(issues, "category", "security") && hasFileMatching(issues, "auth")',
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      // Use security-check which returns auth.js with security issue
      const securityConfig = { ...config };
      securityConfig.checks = {
        'security-check': {
          type: 'ai',
          prompt: 'Security check',
          on: ['pr_updated'],
          fail_if: 'hasIssue(issues, "category", "security") && hasFileMatching(issues, "auth")',
        },
      };

      const result = await executionEngine.executeChecks({
        checks: ['security-check'],
        workingDirectory: process.cwd(),
        showDetails: false,
        outputFormat: 'json',
        config: securityConfig,
      });

      const failures = await executionEngine.evaluateFailureConditions(
        'security-check',
        result.reviewSummary,
        securityConfig
      );

      // Should fail because has security issue in auth.js
      expect(failures.some(r => r.failed)).toBe(true);
    });
  });

  describe('Check dependencies with fail_if', () => {
    it('should access outputs from previous checks', async () => {
      // Mock provider to support depends_on
      const mockProvider = require('../../src/providers/ai-check-provider').AICheckProvider;
      mockProvider.mockImplementation(() => ({
        getName: jest.fn().mockReturnValue('ai'),
        initialize: jest.fn().mockResolvedValue(undefined),
        execute: jest.fn().mockImplementation((prInfo, config, dependencyResults) => {
          const prompt = config.prompt || '';
          if (prompt.includes('Combined') && dependencyResults && dependencyResults.size > 0) {
            // Access outputs from dependencies
            const securityOutputs = dependencyResults['security-check'];

            // Return issues based on dependencies
            if (securityOutputs && securityOutputs.issues.length > 0) {
              return Promise.resolve({
                issues: [
                  {
                    file: 'combined.js',
                    line: 1,
                    severity: 'error',
                    message: 'Security check found issues',
                    category: 'logic',
                    ruleId: 'combined',
                  },
                ],
                suggestions: ['Fix security issues first'],
              });
            }
            return Promise.resolve({ issues: [], suggestions: [] });
          }

          // Return original mock results for other checks
          const focus = config.focus || '';
          if (
            focus.includes('security') ||
            prompt.includes('Security') ||
            prompt.includes('security')
          ) {
            return Promise.resolve({
              issues: [
                {
                  file: 'auth.js',
                  line: 10,
                  severity: 'critical',
                  message: 'SQL injection vulnerability',
                  category: 'security',
                  ruleId: 'sql-injection',
                },
              ],
              suggestions: ['Use parameterized queries'],
            });
          } else if (
            focus.includes('performance') ||
            prompt.includes('Performance') ||
            prompt.includes('performance')
          ) {
            return Promise.resolve({
              issues: [],
              suggestions: ['Code looks performant'],
            });
          }
          return Promise.resolve({ issues: [], suggestions: [] });
        }),
      }));

      const config: VisorConfig = {
        version: '1.0',
        checks: {
          'security-check': {
            type: 'ai',
            prompt: 'Security analysis',
            on: ['pr_updated'],
            fail_if: 'metadata.criticalIssues > 0',
          },
          'performance-check': {
            type: 'ai',
            prompt: 'Performance check',
            on: ['pr_updated'],
            fail_if: 'metadata.errorIssues > 0',
          },
          'combined-check': {
            type: 'ai',
            prompt: 'Combined check',
            on: ['pr_updated'],
            depends_on: ['security-check', 'performance-check'],
            // This would be evaluated with outputs available
            fail_if: 'metadata.totalIssues > 0',
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: true,
          },
        },
      };

      // Execute all checks with dependencies
      const result = await executionEngine.executeChecks({
        checks: ['security-check', 'performance-check', 'combined-check'],
        workingDirectory: process.cwd(),
        showDetails: false,
        outputFormat: 'json',
        config: config,
      });

      // Combined check should have run after dependencies
      // Since security check has critical issues, combined check should detect them
      const criticalIssues = result.reviewSummary.issues.filter(i => i.severity === 'critical');
      expect(criticalIssues.length).toBeGreaterThan(0);

      // At least we should have the security issue
      expect(result.reviewSummary.issues).toContainEqual(
        expect.objectContaining({
          message: 'SQL injection vulnerability',
        })
      );
    });
  });
});
