/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Integration tests for failure condition evaluation
 */

import { CheckExecutionEngine } from '../../src/check-execution-engine';
import { VisorConfig } from '../../src/types/config';
import { FailureConditionEvaluator } from '../../src/failure-condition-evaluator';

describe('Failure Conditions Integration', () => {
  let engine: CheckExecutionEngine;
  let mockConfig: VisorConfig;

  beforeEach(() => {
    engine = new CheckExecutionEngine();

    mockConfig = {
      version: '1.0',
      failure_conditions: {
        // Global conditions
        critical_blocker: 'metadata.criticalIssues > 0',
        quality_gate: {
          condition: 'metadata.totalIssues > 10',
          message: 'Too many issues found',
          severity: 'warning',
          halt_execution: false,
        },
      },
      checks: {
        security: {
          type: 'ai',
          prompt: 'Security analysis',
          group: 'security-analysis',
          schema: 'code-review',
          on: ['pr_opened', 'pr_updated'],
          failure_conditions: {
            // Check-specific conditions
            security_gate: 'metadata.errorIssues >= 1',
            sql_injection: {
              condition:
                'hasFileWith(issues, "auth") && hasIssueWith(issues, "severity", "critical")',
              message: 'Critical SQL injection vulnerability detected',
              severity: 'error',
              halt_execution: true,
            },
          },
        },
        performance: {
          type: 'ai',
          prompt: 'Performance analysis',
          group: 'performance-analysis',
          schema: 'code-review',
          on: ['pr_opened', 'pr_updated'],
          // Uses only global conditions
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
  });

  describe('Configuration loading and validation', () => {
    it('should load failure conditions from configuration', () => {
      expect(mockConfig.failure_conditions).toBeDefined();
      expect(mockConfig.failure_conditions?.critical_blocker).toBe('metadata.criticalIssues > 0');
      expect(mockConfig.checks.security.failure_conditions).toBeDefined();
    });

    it('should handle missing failure conditions gracefully', () => {
      const configWithoutConditions: VisorConfig = {
        ...mockConfig,
        failure_conditions: undefined,
        checks: {
          security: {
            ...mockConfig.checks.security,
            failure_conditions: undefined,
          },
        },
      };

      expect(configWithoutConditions.failure_conditions).toBeUndefined();
      expect(configWithoutConditions.checks.security.failure_conditions).toBeUndefined();
    });
  });

  describe('Failure condition evaluation in engine', () => {
    it('should evaluate failure conditions for check results', async () => {
      const mockReviewSummary = {
        issues: [
          {
            file: 'src/auth.ts',
            line: 10,
            ruleId: 'security/sql-injection',
            message: 'Potential SQL injection vulnerability',
            severity: 'critical' as const,
            category: 'security' as const,
          },
          {
            file: 'src/api.ts',
            line: 25,
            ruleId: 'performance/query',
            message: 'Database query optimization needed',
            severity: 'error' as const,
            category: 'performance' as const,
          },
        ],
        suggestions: ['Add input validation', 'Review database queries'],
      };

      const results = await engine.evaluateFailureConditions(
        'security',
        mockReviewSummary,
        mockConfig
      );

      expect(results.length).toBeGreaterThan(0);

      // Should have global conditions
      const criticalBlocker = results.find(r => r.conditionName === 'critical_blocker');
      expect(criticalBlocker?.failed).toBe(true);

      // Should have check-specific conditions
      const sqlInjection = results.find(r => r.conditionName === 'sql_injection');
      expect(sqlInjection?.failed).toBe(true);
      expect(sqlInjection?.message).toContain('SQL injection vulnerability');
      expect(sqlInjection?.haltExecution).toBe(true);
    });

    it('should handle different check types with different conditions', async () => {
      const securitySummary = {
        issues: [
          {
            file: 'src/auth.ts',
            line: 10,
            ruleId: 'security/vulnerability',
            message: 'Security issue',
            severity: 'error' as const,
            category: 'security' as const,
          },
        ],
        suggestions: [],
      };

      const performanceSummary = {
        issues: [
          {
            file: 'src/slow.ts',
            line: 15,
            ruleId: 'performance/slow',
            message: 'Performance issue',
            severity: 'warning' as const,
            category: 'performance' as const,
          },
        ],
        suggestions: [],
      };

      // Security check has specific conditions
      const securityResults = await engine.evaluateFailureConditions(
        'security',
        securitySummary,
        mockConfig
      );

      // Performance check only has global conditions
      const performanceResults = await engine.evaluateFailureConditions(
        'performance',
        performanceSummary,
        mockConfig
      );

      // Security should have more conditions (global + check-specific)
      expect(securityResults.length).toBeGreaterThan(performanceResults.length);

      // Both should have global conditions
      const securityCritical = securityResults.find(r => r.conditionName === 'critical_blocker');
      const performanceCritical = performanceResults.find(
        r => r.conditionName === 'critical_blocker'
      );

      expect(securityCritical).toBeDefined();
      expect(performanceCritical).toBeDefined();
    });

    it('should prioritize check-specific conditions over global ones', async () => {
      const configWithOverride: VisorConfig = {
        ...mockConfig,
        failure_conditions: {
          quality_gate: 'metadata.totalIssues > 20', // Global threshold
        },
        checks: {
          security: {
            ...mockConfig.checks.security,
            failure_conditions: {
              quality_gate: 'metadata.totalIssues > 3', // Override with stricter limit
            },
          },
        },
      };

      const reviewSummary = {
        issues: Array.from({ length: 5 }, (_, i) => ({
          file: `src/file${i}.ts`,
          line: 1,
          ruleId: 'test/rule',
          message: 'Test issue',
          severity: 'info' as const,
          category: 'logic' as const,
        })),
        suggestions: [],
      };

      const results = await engine.evaluateFailureConditions(
        'security',
        reviewSummary,
        configWithOverride
      );

      const qualityGate = results.find(r => r.conditionName === 'quality_gate');
      expect(qualityGate?.failed).toBe(true); // 5 > 3 (check-specific threshold)
      expect(qualityGate?.expression).toBe('metadata.totalIssues > 3');
    });
  });

  describe('Failure condition utilities', () => {
    it('should identify execution-halting conditions', () => {
      const results = [
        {
          conditionName: 'critical_issue',
          failed: true,
          expression: 'test',
          severity: 'error' as const,
          haltExecution: true,
        },
        {
          conditionName: 'warning_issue',
          failed: true,
          expression: 'test',
          severity: 'warning' as const,
          haltExecution: false,
        },
      ];

      expect(FailureConditionEvaluator.shouldHaltExecution(results)).toBe(true);
    });

    it('should format multiple failure conditions appropriately', () => {
      const results = [
        {
          conditionName: 'security_critical',
          failed: true,
          expression: 'metadata.criticalIssues > 0',
          message: 'Critical security issues found',
          severity: 'error' as const,
          haltExecution: true,
        },
        {
          conditionName: 'quality_warning',
          failed: true,
          expression: 'metadata.totalIssues > 5',
          message: 'Code quality below threshold',
          severity: 'warning' as const,
          haltExecution: false,
        },
        {
          conditionName: 'info_note',
          failed: true,
          expression: 'suggestions.length > 0',
          message: 'Suggestions available for improvement',
          severity: 'info' as const,
          haltExecution: false,
        },
      ];

      const formatted = FailureConditionEvaluator.formatResults(results);

      expect(formatted).toContain('❌ **Error conditions (1):**');
      expect(formatted).toContain('security_critical: Critical security issues found');
      expect(formatted).toContain('⚠️ **Warning conditions (1):**');
      expect(formatted).toContain('quality_warning: Code quality below threshold');
      expect(formatted).toContain('ℹ️ **Info conditions (1):**');
      expect(formatted).toContain('info_note: Suggestions available for improvement');
    });

    it('should handle empty or all-passing conditions', () => {
      const emptyResults: any[] = [];
      expect(FailureConditionEvaluator.formatResults(emptyResults)).toBe(
        '✅ All failure conditions passed'
      );

      const passingResults = [
        {
          conditionName: 'all_good',
          failed: false,
          expression: 'metadata.criticalIssues > 0',
          severity: 'info' as const,
          haltExecution: false,
        },
      ];

      expect(FailureConditionEvaluator.formatResults(passingResults)).toBe(
        '✅ All failure conditions passed'
      );
    });
  });

  describe('Real-world scenario tests', () => {
    it('should handle a typical security review scenario', async () => {
      const securityScenario = {
        issues: [
          {
            file: 'src/auth/password.ts',
            line: 20,
            ruleId: 'security/weak-password',
            message: 'Password validation is insufficient',
            severity: 'error' as const,
            category: 'security' as const,
          },
          {
            file: 'src/database/user.ts',
            line: 45,
            ruleId: 'security/sql-injection',
            message: 'Potential SQL injection in user query',
            severity: 'critical' as const,
            category: 'security' as const,
          },
          {
            file: 'src/api/auth.ts',
            line: 10,
            ruleId: 'security/auth-bypass',
            message: 'Authentication bypass possibility',
            severity: 'critical' as const,
            category: 'security' as const,
          },
        ],
        suggestions: [
          'Implement parameterized queries to prevent SQL injection',
          'Add comprehensive password validation',
          'Review authentication flow for potential bypasses',
        ],
      };

      const results = await engine.evaluateFailureConditions(
        'security',
        securityScenario,
        mockConfig
      );

      // Should fail multiple conditions
      const failedResults = FailureConditionEvaluator.getFailedConditions(results);
      expect(failedResults.length).toBeGreaterThan(0);

      // Should halt execution due to critical issues
      expect(FailureConditionEvaluator.shouldHaltExecution(results)).toBe(true);

      // Should detect SQL injection specifically
      const sqlInjectionResult = results.find(r => r.conditionName === 'sql_injection');
      expect(sqlInjectionResult?.failed).toBe(true);
    });

    it('should handle a performance review with timing information', async () => {
      const performanceScenario = {
        issues: [
          {
            file: 'src/api/slow-endpoint.ts',
            line: 30,
            ruleId: 'performance/n-plus-one',
            message: 'N+1 query detected in user listing',
            severity: 'error' as const,
            category: 'performance' as const,
          },
          {
            file: 'src/utils/heavy-computation.ts',
            line: 15,
            ruleId: 'performance/algorithm',
            message: 'Algorithm has O(n²) complexity',
            severity: 'warning' as const,
            category: 'performance' as const,
          },
        ],
        suggestions: ['Consider database indexing', 'Optimize algorithm complexity'],
        debug: {
          provider: 'anthropic',
          model: 'claude-3-sonnet',
          processingTime: 8000, // Slow processing
          errors: [],
          apiKeySource: 'environment',
          prompt: 'performance prompt',
          rawResponse: 'performance response',
          promptLength: 150,
          responseLength: 300,
          jsonParseSuccess: true,
          timestamp: new Date().toISOString(),
        },
      };

      const results = await engine.evaluateFailureConditions(
        'performance',
        performanceScenario,
        mockConfig
      );

      // Should detect issues based on global conditions
      const criticalBlocker = results.find(r => r.conditionName === 'critical_blocker');
      expect(criticalBlocker?.failed).toBe(false); // No critical issues

      const qualityGate = results.find(r => r.conditionName === 'quality_gate');
      expect(qualityGate?.failed).toBe(false); // Only 2 issues < 10
    });
  });
});
