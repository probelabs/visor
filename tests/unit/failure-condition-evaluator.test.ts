/**
 * Unit tests for FailureConditionEvaluator
 */

import { FailureConditionEvaluator } from '../../src/failure-condition-evaluator';
import { ReviewSummary, ReviewIssue } from '../../src/reviewer';
import { FailureConditions, FailureConditionResult } from '../../src/types/config';

describe('FailureConditionEvaluator', () => {
  let evaluator: FailureConditionEvaluator;
  let mockReviewSummary: ReviewSummary;

  beforeEach(() => {
    evaluator = new FailureConditionEvaluator();

    // Create mock review summary with various issue types
    const mockIssues: ReviewIssue[] = [
      {
        file: 'src/auth.ts',
        line: 10,
        ruleId: 'security/sql-injection',
        message: 'Potential SQL injection vulnerability',
        severity: 'critical',
        category: 'security',
        group: 'security-analysis',
        schema: 'code-review',
      },
      {
        file: 'src/api.ts',
        line: 25,
        ruleId: 'performance/n-plus-one',
        message: 'N+1 query detected',
        severity: 'error',
        category: 'performance',
        group: 'performance-analysis',
        schema: 'code-review',
      },
      {
        file: 'src/utils.ts',
        line: 15,
        ruleId: 'style/naming',
        message: 'Variable naming could be improved',
        severity: 'warning',
        category: 'style',
      },
      {
        file: 'src/config.ts',
        line: 5,
        ruleId: 'logic/validation',
        message: 'Input validation missing',
        severity: 'info',
        category: 'logic',
      },
    ];

    mockReviewSummary = {
      issues: mockIssues,
      suggestions: [
        'Consider adding unit tests',
        'Review error handling patterns',
        'Check for SQL injection vulnerabilities',
      ],
      debug: {
        provider: 'anthropic',
        model: 'claude-3-sonnet',
        processingTime: 5000,
        errors: [],
        apiKeySource: 'environment',
        prompt: 'test prompt',
        rawResponse: 'test response',
        promptLength: 100,
        responseLength: 200,
        jsonParseSuccess: true,
        timestamp: new Date().toISOString(),
      },
    };
  });

  describe('evaluateConditions', () => {
    it('should evaluate simple global conditions', async () => {
      const globalConditions: FailureConditions = {
        critical_blocker: 'metadata.criticalIssues > 0',
        error_threshold: 'metadata.errorIssues >= 2',
        total_issues: 'metadata.totalIssues > 10',
      };

      const results = await evaluator.evaluateConditions(
        'security',
        'code-review',
        'security-analysis',
        mockReviewSummary,
        globalConditions
      );

      expect(results).toHaveLength(3);

      const criticalResult = results.find(r => r.conditionName === 'critical_blocker');
      expect(criticalResult?.failed).toBe(true);

      const errorResult = results.find(r => r.conditionName === 'error_threshold');
      expect(errorResult?.failed).toBe(false); // Only 1 error issue

      const totalResult = results.find(r => r.conditionName === 'total_issues');
      expect(totalResult?.failed).toBe(false); // Only 4 total issues
    });

    it('should evaluate complex conditions with metadata access', async () => {
      const conditions: FailureConditions = {
        security_check: 'metadata.checkName == "security" && metadata.criticalIssues > 0',
        schema_based: 'metadata.schema == "code-review" && metadata.totalIssues >= 4',
        group_specific: 'metadata.group == "security-analysis" && metadata.warningIssues >= 1',
      };

      const results = await evaluator.evaluateConditions(
        'security',
        'code-review',
        'security-analysis',
        mockReviewSummary,
        conditions
      );

      expect(results).toHaveLength(3);

      const securityResult = results.find(r => r.conditionName === 'security_check');
      expect(securityResult?.failed).toBe(true);

      const schemaResult = results.find(r => r.conditionName === 'schema_based');
      expect(schemaResult?.failed).toBe(true);

      const groupResult = results.find(r => r.conditionName === 'group_specific');
      expect(groupResult?.failed).toBe(true);
    });

    it('should evaluate conditions with helper functions for issues', async () => {
      const conditions: FailureConditions = {
        has_sql_injection: 'hasFileWith(issues, "auth")',
        has_critical_security: 'hasIssueWith(issues, "severity", "critical")',
        count_errors: 'countIssues(issues, "severity", "error") >= 1',
        file_analysis: 'hasFileWith(issues, "auth")',
      };

      const results = await evaluator.evaluateConditions(
        'security',
        'code-review',
        'security-analysis',
        mockReviewSummary,
        conditions
      );

      expect(results).toHaveLength(4);

      const sqlResult = results.find(r => r.conditionName === 'has_sql_injection');
      expect(sqlResult?.failed).toBe(true); // Has auth.ts file

      const critSecResult = results.find(r => r.conditionName === 'has_critical_security');
      expect(critSecResult?.failed).toBe(true); // Has critical severity

      const countResult = results.find(r => r.conditionName === 'count_errors');
      expect(countResult?.failed).toBe(true); // Has 1 error

      const fileResult = results.find(r => r.conditionName === 'file_analysis');
      expect(fileResult?.failed).toBe(true); // Has auth file
    });

    it('should evaluate conditions with suggestion analysis', async () => {
      const conditions: FailureConditions = {
        missing_tests: 'hasSuggestion(suggestions, "test")',
        sql_suggestions: 'hasSuggestion(suggestions, "SQL")',
        error_handling: 'hasSuggestion(suggestions, "error")',
      };

      const results = await evaluator.evaluateConditions(
        'security',
        'code-review',
        'security-analysis',
        mockReviewSummary,
        conditions
      );

      expect(results).toHaveLength(3);

      const testResult = results.find(r => r.conditionName === 'missing_tests');
      expect(testResult?.failed).toBe(true);

      const sqlResult = results.find(r => r.conditionName === 'sql_suggestions');
      expect(sqlResult?.failed).toBe(true);

      const errorResult = results.find(r => r.conditionName === 'error_handling');
      expect(errorResult?.failed).toBe(true);
    });

    it('should evaluate complex failure conditions with metadata', async () => {
      const conditions: FailureConditions = {
        complex_condition: {
          condition: 'metadata.criticalIssues > 0 && metadata.checkName == "security"',
          message: 'Critical security issues require immediate attention',
          severity: 'error',
          halt_execution: true,
        },
        performance_warning: {
          condition: 'metadata.errorIssues >= 1 && debug && debug.processingTime > 3000',
          message: 'Performance analysis found issues and took significant time',
          severity: 'warning',
          halt_execution: false,
        },
      };

      const results = await evaluator.evaluateConditions(
        'security',
        'code-review',
        'security-analysis',
        mockReviewSummary,
        conditions
      );

      expect(results).toHaveLength(2);

      const complexResult = results.find(r => r.conditionName === 'complex_condition');
      expect(complexResult?.failed).toBe(true);
      expect(complexResult?.message).toBe('Critical security issues require immediate attention');
      expect(complexResult?.severity).toBe('error');
      expect(complexResult?.haltExecution).toBe(true);

      const perfResult = results.find(r => r.conditionName === 'performance_warning');
      expect(perfResult?.failed).toBe(true);
      expect(perfResult?.severity).toBe('warning');
      expect(perfResult?.haltExecution).toBe(false);
    });

    it('should handle check-specific conditions overriding global ones', async () => {
      const globalConditions: FailureConditions = {
        quality_gate: 'metadata.totalIssues > 10',
        critical_gate: 'metadata.criticalIssues > 0',
      };

      const checkConditions: FailureConditions = {
        quality_gate: 'metadata.totalIssues > 2', // Override with stricter limit
        security_specific: 'metadata.errorIssues >= 1',
      };

      const results = await evaluator.evaluateConditions(
        'security',
        'code-review',
        'security-analysis',
        mockReviewSummary,
        globalConditions,
        checkConditions
      );

      expect(results).toHaveLength(3);

      // Check-specific quality_gate should override global one
      const qualityResult = results.find(r => r.conditionName === 'quality_gate');
      expect(qualityResult?.failed).toBe(true); // 4 > 2 (check-specific threshold)
      expect(qualityResult?.expression).toBe('metadata.totalIssues > 2');

      // Global critical_gate should remain
      const criticalResult = results.find(r => r.conditionName === 'critical_gate');
      expect(criticalResult?.failed).toBe(true);

      // Check-specific condition should be present
      const securityResult = results.find(r => r.conditionName === 'security_specific');
      expect(securityResult?.failed).toBe(true);
    });

    it('should handle debug information in conditions', async () => {
      const conditions: FailureConditions = {
        slow_analysis: 'debug && debug.processingTime > 3000',
        provider_specific: 'debug && debug.provider == "anthropic"',
        has_errors: 'debug && debug.errors.length > 0',
      };

      const results = await evaluator.evaluateConditions(
        'security',
        'code-review',
        'security-analysis',
        mockReviewSummary,
        conditions
      );

      expect(results).toHaveLength(3);

      const slowResult = results.find(r => r.conditionName === 'slow_analysis');
      expect(slowResult?.failed).toBe(true); // 5000ms > 3000ms

      const providerResult = results.find(r => r.conditionName === 'provider_specific');
      expect(providerResult?.failed).toBe(true);

      const errorsResult = results.find(r => r.conditionName === 'has_errors');
      expect(errorsResult?.failed).toBe(false); // No errors in mock
    });

    it('should handle malformed expressions gracefully', async () => {
      const conditions: FailureConditions = {
        valid_condition: 'metadata.totalIssues > 0',
        invalid_syntax: 'metadata.totalIssues >>', // Invalid syntax
        undefined_property: 'metadata.nonexistentProperty > 0',
      };

      const results = await evaluator.evaluateConditions(
        'security',
        'code-review',
        'security-analysis',
        mockReviewSummary,
        conditions
      );

      expect(results).toHaveLength(3);

      const validResult = results.find(r => r.conditionName === 'valid_condition');
      expect(validResult?.failed).toBe(true);
      expect(validResult?.error).toBeUndefined();

      const invalidResult = results.find(r => r.conditionName === 'invalid_syntax');
      expect(invalidResult?.failed).toBe(false);
      expect(invalidResult?.error).toContain('Expression evaluation error');

      const undefinedResult = results.find(r => r.conditionName === 'undefined_property');
      expect(undefinedResult?.failed).toBe(false); // undefined > 0 is false
    });
  });

  describe('static utility methods', () => {
    it('should identify conditions that require halting execution', () => {
      const results: FailureConditionResult[] = [
        {
          conditionName: 'critical_issue',
          failed: true,
          expression: 'test',
          severity: 'error',
          haltExecution: true,
        },
        {
          conditionName: 'warning_issue',
          failed: true,
          expression: 'test',
          severity: 'warning',
          haltExecution: false,
        },
        {
          conditionName: 'passed_condition',
          failed: false,
          expression: 'test',
          severity: 'error',
          haltExecution: true,
        },
      ];

      const shouldHalt = FailureConditionEvaluator.shouldHaltExecution(results);
      expect(shouldHalt).toBe(true);
    });

    it('should get only failed conditions', () => {
      const results: FailureConditionResult[] = [
        {
          conditionName: 'failed_condition',
          failed: true,
          expression: 'test',
          severity: 'error',
          haltExecution: false,
        },
        {
          conditionName: 'passed_condition',
          failed: false,
          expression: 'test',
          severity: 'warning',
          haltExecution: false,
        },
      ];

      const failed = FailureConditionEvaluator.getFailedConditions(results);
      expect(failed).toHaveLength(1);
      expect(failed[0].conditionName).toBe('failed_condition');
    });

    it('should group results by severity', () => {
      const results: FailureConditionResult[] = [
        {
          conditionName: 'error_condition',
          failed: true,
          expression: 'test',
          severity: 'error',
          haltExecution: false,
        },
        {
          conditionName: 'warning_condition',
          failed: true,
          expression: 'test',
          severity: 'warning',
          haltExecution: false,
        },
        {
          conditionName: 'info_condition',
          failed: true,
          expression: 'test',
          severity: 'info',
          haltExecution: false,
        },
      ];

      const grouped = FailureConditionEvaluator.groupResultsBySeverity(results);
      expect(grouped.error).toHaveLength(1);
      expect(grouped.warning).toHaveLength(1);
      expect(grouped.info).toHaveLength(1);
    });

    it('should format results for display', () => {
      const results: FailureConditionResult[] = [
        {
          conditionName: 'error_condition',
          failed: true,
          expression: 'metadata.criticalIssues > 0',
          message: 'Critical issues found',
          severity: 'error',
          haltExecution: true,
        },
        {
          conditionName: 'warning_condition',
          failed: true,
          expression: 'metadata.totalIssues > 5',
          severity: 'warning',
          haltExecution: false,
        },
        {
          conditionName: 'passed_condition',
          failed: false,
          expression: 'metadata.totalIssues > 10',
          severity: 'info',
          haltExecution: false,
        },
      ];

      const formatted = FailureConditionEvaluator.formatResults(results);
      expect(formatted).toContain('❌ **Error conditions (1):**');
      expect(formatted).toContain('error_condition: Critical issues found');
      expect(formatted).toContain('⚠️ **Warning conditions (1):**');
      expect(formatted).toContain('warning_condition: metadata.totalIssues > 5');
      expect(formatted).not.toContain('passed_condition'); // Should not include passed conditions
    });

    it('should show success message when all conditions pass', () => {
      const results: FailureConditionResult[] = [
        {
          conditionName: 'passed_condition',
          failed: false,
          expression: 'metadata.totalIssues > 10',
          severity: 'info',
          haltExecution: false,
        },
      ];

      const formatted = FailureConditionEvaluator.formatResults(results);
      expect(formatted).toBe('✅ All failure conditions passed');
    });
  });
});
