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
        critical_blocker: 'output.issues.some(i => i.severity === "critical")',
        error_threshold: 'output.issues.filter(i => i.severity === "error").length >= 2',
        total_issues: 'output.issues.length > 10',
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

    it('should evaluate complex conditions with output access', async () => {
      const conditions: FailureConditions = {
        security_check:
          'checkName == "security" && output.issues.some(i => i.severity === "critical")',
        schema_based: 'schema == "code-review" && output.issues.length >= 4',
        group_specific:
          'group == "security-analysis" && output.issues.filter(i => i.severity === "warning").length >= 1',
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
        has_sql_injection: 'hasFileWith(output.issues, "auth")',
        has_critical_security: 'hasIssueWith(output.issues, "severity", "critical")',
        count_errors: 'countIssues(output.issues, "severity", "error") >= 1',
        file_analysis: 'hasFileWith(output.issues, "auth")',
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

    it('should evaluate conditions based on issue analysis', async () => {
      const conditions: FailureConditions = {
        security_issues: 'output.issues.some(i => i.category === "security")',
        sql_related: 'output.issues.some(i => i.ruleId.includes("sql"))',
        high_severity: 'output.issues.some(i => ["critical", "error"].includes(i.severity))',
      };

      const results = await evaluator.evaluateConditions(
        'security',
        'code-review',
        'security-analysis',
        mockReviewSummary,
        conditions
      );

      expect(results).toHaveLength(3);

      const securityResult = results.find(r => r.conditionName === 'security_issues');
      expect(securityResult?.failed).toBe(true);

      const sqlResult = results.find(r => r.conditionName === 'sql_related');
      expect(sqlResult?.failed).toBe(true);

      const severityResult = results.find(r => r.conditionName === 'high_severity');
      expect(severityResult?.failed).toBe(true);
    });

    it('should evaluate complex failure conditions with metadata', async () => {
      const conditions: FailureConditions = {
        complex_condition: {
          condition:
            'output.issues.some(i => i.severity === "critical") && checkName == "security"',
          message: 'Critical security issues require immediate attention',
          severity: 'error',
          halt_execution: true,
        },
        performance_warning: {
          condition:
            'output.issues.filter(i => i.severity === "error").length >= 1 && debug && debug.processingTime > 3000',
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
        quality_gate: 'output.issues.length > 10',
        critical_gate: 'output.issues.some(i => i.severity === "critical")',
      };

      const checkConditions: FailureConditions = {
        quality_gate: 'output.issues.length > 2', // Override with stricter limit
        security_specific: 'output.issues.filter(i => i.severity === "error").length >= 1',
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
      expect(qualityResult?.expression).toBe('output.issues.length > 2');

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
        valid_condition: 'output.issues.length > 0',
        invalid_syntax: 'output.issues.length >>', // Invalid syntax
        undefined_property: 'output.nonexistentProperty > 0',
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
          expression: 'output.issues.some(i => i.severity === "critical")',
          message: 'Critical issues found',
          severity: 'error',
          haltExecution: true,
        },
        {
          conditionName: 'warning_condition',
          failed: true,
          expression: 'output.issues.length > 5',
          severity: 'warning',
          haltExecution: false,
        },
        {
          conditionName: 'passed_condition',
          failed: false,
          expression: 'output.issues.length > 10',
          severity: 'info',
          haltExecution: false,
        },
      ];

      const formatted = FailureConditionEvaluator.formatResults(results);
      expect(formatted).toContain('❌ **Error severity conditions (1):**');
      expect(formatted).toContain('error_condition: Critical issues found');
      expect(formatted).toContain('⚠️ **Warning conditions (1):**');
      expect(formatted).toContain('warning_condition: output.issues.length > 5');
      expect(formatted).not.toContain('passed_condition'); // Should not include passed conditions
    });

    it('should show success message when all conditions pass', () => {
      const results: FailureConditionResult[] = [
        {
          conditionName: 'passed_condition',
          failed: false,
          expression: 'output.issues.length > 10',
          severity: 'info',
          haltExecution: false,
        },
      ];

      const formatted = FailureConditionEvaluator.formatResults(results);
      expect(formatted).toBe('✅ All failure conditions passed');
    });
  });

  describe('security tests', () => {
    it('should block access to process object', async () => {
      const conditions: FailureConditions = {
        malicious_process: 'process.exit(1)',
      };

      const results = await evaluator.evaluateConditions(
        'security',
        'code-review',
        'security-analysis',
        mockReviewSummary,
        conditions
      );

      expect(results).toHaveLength(1);
      const result = results[0];
      expect(result.failed).toBe(false);
      expect(result.error).toContain('Expression evaluation error');
    });

    it('should block access to require function', async () => {
      const conditions: FailureConditions = {
        malicious_require: 'require("fs").readFileSync("/etc/passwd")',
      };

      const results = await evaluator.evaluateConditions(
        'security',
        'code-review',
        'security-analysis',
        mockReviewSummary,
        conditions
      );

      expect(results).toHaveLength(1);
      const result = results[0];
      expect(result.failed).toBe(false);
      expect(result.error).toContain('Expression evaluation error');
    });

    it('should block access to global object', async () => {
      const conditions: FailureConditions = {
        malicious_global: 'global.process.exit(1)',
      };

      const results = await evaluator.evaluateConditions(
        'security',
        'code-review',
        'security-analysis',
        mockReviewSummary,
        conditions
      );

      expect(results).toHaveLength(1);
      const result = results[0];
      expect(result.failed).toBe(false);
      expect(result.error).toContain('Expression evaluation error');
    });

    it('should block access to Function constructor', async () => {
      const conditions: FailureConditions = {
        malicious_function: 'Function("return process").call(null)()',
      };

      const results = await evaluator.evaluateConditions(
        'security',
        'code-review',
        'security-analysis',
        mockReviewSummary,
        conditions
      );

      expect(results).toHaveLength(1);
      const result = results[0];
      expect(result.failed).toBe(false);
      expect(result.error).toContain('Expression evaluation error');
    });

    it('should block access to eval function', async () => {
      const conditions: FailureConditions = {
        malicious_eval: 'eval("process.exit(1)")',
      };

      const results = await evaluator.evaluateConditions(
        'security',
        'code-review',
        'security-analysis',
        mockReviewSummary,
        conditions
      );

      expect(results).toHaveLength(1);
      const result = results[0];
      expect(result.failed).toBe(false);
      expect(result.error).toContain('Expression evaluation error');
    });

    it('should block attempts to escape sandbox via constructor', async () => {
      const conditions: FailureConditions = {
        constructor_escape: '("").constructor.constructor("return process")()',
      };

      const results = await evaluator.evaluateConditions(
        'security',
        'code-review',
        'security-analysis',
        mockReviewSummary,
        conditions
      );

      expect(results).toHaveLength(1);
      const result = results[0];
      expect(result.failed).toBe(false);
      expect(result.error).toContain('Expression evaluation error');
    });

    it('should allow safe array and string operations', async () => {
      const conditions: FailureConditions = {
        safe_array_ops: 'output.issues.some(i => i.severity === "critical")',
        safe_string_ops: 'checkName.toLowerCase().includes("security")',
        safe_math_ops: 'Math.max(output.issues.length, 5) > 3',
        safe_helper_function: 'contains(checkName, "security")',
      };

      const results = await evaluator.evaluateConditions(
        'security',
        'code-review',
        'security-analysis',
        mockReviewSummary,
        conditions
      );

      expect(results).toHaveLength(4);

      // All results should evaluate without errors
      results.forEach(result => {
        expect(result.error).toBeUndefined();
      });

      // Check specific results
      const arrayOpsResult = results.find(r => r.conditionName === 'safe_array_ops');
      expect(arrayOpsResult?.failed).toBe(true); // Has critical issues

      const stringOpsResult = results.find(r => r.conditionName === 'safe_string_ops');
      expect(stringOpsResult?.failed).toBe(true); // checkName contains "security"

      const mathOpsResult = results.find(r => r.conditionName === 'safe_math_ops');
      expect(mathOpsResult?.failed).toBe(true); // Math.max(4, 5) = 5 > 3

      const helperResult = results.find(r => r.conditionName === 'safe_helper_function');
      expect(helperResult?.failed).toBe(true); // contains("security", "security") = true
    });
  });
});
