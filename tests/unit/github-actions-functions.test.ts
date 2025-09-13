/**
 * Tests for GitHub Actions-like functions in JEXL
 */

import { FailureConditionEvaluator } from '../../src/failure-condition-evaluator';
import { ReviewSummary } from '../../src/reviewer';
import { FailureConditions } from '../../src/types/config';

describe('GitHub Actions-like Functions', () => {
  let evaluator: FailureConditionEvaluator;
  let mockReviewSummary: ReviewSummary;

  beforeEach(() => {
    evaluator = new FailureConditionEvaluator();
    mockReviewSummary = {
      issues: [
        {
          file: 'src/auth.ts',
          line: 10,
          ruleId: 'security/sql-injection',
          message: 'SQL injection vulnerability',
          severity: 'critical',
          category: 'security',
        },
        {
          file: 'src/config.env',
          line: 1,
          ruleId: 'security/exposed-secret',
          message: 'Exposed API key',
          severity: 'error',
          category: 'security',
        },
      ],
      suggestions: ['Add input validation', 'Use parameterized queries'],
    };
  });

  describe('contains() function', () => {
    it('should work with strings', async () => {
      const conditions: FailureConditions = {
        check_name: 'contains(metadata.checkName, "security")',
        check_schema: 'contains(metadata.schema, "review")',
      };

      const results = await evaluator.evaluateConditions(
        'security-scan',
        'code-review',
        'security',
        mockReviewSummary,
        conditions
      );

      const nameResult = results.find(r => r.conditionName === 'check_name');
      const schemaResult = results.find(r => r.conditionName === 'check_schema');

      expect(nameResult?.failed).toBe(true); // contains "security"
      expect(schemaResult?.failed).toBe(true); // contains "review"
    });

    it('should work with arrays', async () => {
      const conditions: FailureConditions = {
        has_critical: 'contains(["critical", "error", "warning"], "critical")',
        no_info: '!contains(["critical", "error", "warning"], "info")',
      };

      const results = await evaluator.evaluateConditions(
        'test',
        'test',
        'test',
        mockReviewSummary,
        conditions
      );

      const hasCritical = results.find(r => r.conditionName === 'has_critical');
      const noInfo = results.find(r => r.conditionName === 'no_info');

      expect(hasCritical?.failed).toBe(true);
      expect(noInfo?.failed).toBe(true);
    });
  });

  describe('startsWith() and endsWith() functions', () => {
    it('should check string prefixes and suffixes', async () => {
      const conditions: FailureConditions = {
        starts_security: 'startsWith(metadata.checkName, "security")',
        ends_scan: 'endsWith(metadata.checkName, "scan")',
        starts_wrong: 'startsWith(metadata.checkName, "performance")',
      };

      const results = await evaluator.evaluateConditions(
        'security-scan',
        'code-review',
        'security',
        mockReviewSummary,
        conditions
      );

      const startsSecResult = results.find(r => r.conditionName === 'starts_security');
      const endsScanResult = results.find(r => r.conditionName === 'ends_scan');
      const startsWrongResult = results.find(r => r.conditionName === 'starts_wrong');

      expect(startsSecResult?.failed).toBe(true);
      expect(endsScanResult?.failed).toBe(true);
      expect(startsWrongResult?.failed).toBe(false);
    });
  });

  describe('success() and failure() functions', () => {
    it('should detect success state', async () => {
      const successSummary: ReviewSummary = {
        issues: [],
        suggestions: [],
      };

      const conditions: FailureConditions = {
        is_success: 'metadata.criticalIssues == 0 && metadata.errorIssues == 0',
        not_failure: 'metadata.criticalIssues == 0',
      };

      const results = await evaluator.evaluateConditions(
        'test',
        'test',
        'test',
        successSummary,
        conditions
      );

      const successResult = results.find(r => r.conditionName === 'is_success');
      const notFailureResult = results.find(r => r.conditionName === 'not_failure');

      expect(successResult?.failed).toBe(true); // No issues means success
      expect(notFailureResult?.failed).toBe(true); // No critical issues
    });

    it('should detect failure state with critical issues', async () => {
      const conditions: FailureConditions = {
        is_failure: 'metadata.criticalIssues > 0',
        not_success: 'metadata.criticalIssues > 0 || metadata.errorIssues > 0',
      };

      const results = await evaluator.evaluateConditions(
        'test',
        'test',
        'test',
        mockReviewSummary, // Has critical issues
        conditions
      );

      const failureResult = results.find(r => r.conditionName === 'is_failure');
      const notSuccessResult = results.find(r => r.conditionName === 'not_success');

      expect(failureResult?.failed).toBe(true); // Has critical issues
      expect(notSuccessResult?.failed).toBe(true); // Has critical or error issues
    });
  });

  describe('always() function', () => {
    it('should always return true', async () => {
      const conditions: FailureConditions = {
        always_true: 'always()',
        always_with_and: 'always() && metadata.totalIssues >= 0',
        always_with_or: 'false || always()',
      };

      const results = await evaluator.evaluateConditions(
        'test',
        'test',
        'test',
        mockReviewSummary,
        conditions
      );

      expect(results.every(r => r.failed)).toBe(true); // All should be true
    });
  });

  describe('hasIssue() function (GitHub Actions style)', () => {
    it('should find issues by field value', async () => {
      const conditions: FailureConditions = {
        has_sql_injection: 'hasIssue(issues, "ruleId", "security/sql-injection")',
        has_critical: 'hasIssue(issues, "severity", "critical")',
        no_performance: '!hasIssue(issues, "category", "performance")',
      };

      const results = await evaluator.evaluateConditions(
        'test',
        'test',
        'test',
        mockReviewSummary,
        conditions
      );

      const sqlResult = results.find(r => r.conditionName === 'has_sql_injection');
      const criticalResult = results.find(r => r.conditionName === 'has_critical');
      const noPerfResult = results.find(r => r.conditionName === 'no_performance');

      expect(sqlResult?.failed).toBe(true);
      expect(criticalResult?.failed).toBe(true);
      expect(noPerfResult?.failed).toBe(true); // No performance issues
    });
  });

  describe('hasFileMatching() function', () => {
    it('should find files matching patterns', async () => {
      const conditions: FailureConditions = {
        has_env_file: 'hasFileMatching(issues, ".env")',
        has_auth_file: 'hasFileMatching(issues, "auth")',
        no_test_file: '!hasFileMatching(issues, "test")',
      };

      const results = await evaluator.evaluateConditions(
        'test',
        'test',
        'test',
        mockReviewSummary,
        conditions
      );

      const envResult = results.find(r => r.conditionName === 'has_env_file');
      const authResult = results.find(r => r.conditionName === 'has_auth_file');
      const noTestResult = results.find(r => r.conditionName === 'no_test_file');

      expect(envResult?.failed).toBe(true); // Has config.env
      expect(authResult?.failed).toBe(true); // Has auth.ts
      expect(noTestResult?.failed).toBe(true); // No test files
    });
  });

  describe('Complex GitHub Actions-like expressions', () => {
    it('should handle complex combinations', async () => {
      const conditions: FailureConditions = {
        complex_check: `
          (startsWith(metadata.checkName, "security") && metadata.criticalIssues > 0) ||
          (contains(metadata.schema, "review") && metadata.totalIssues > 0)
        `,
        github_style: `
          always() ||
          (contains(metadata.checkName, "skip") && metadata.totalIssues == 0)
        `,
      };

      const results = await evaluator.evaluateConditions(
        'security-scan',
        'code-review',
        'security',
        mockReviewSummary,
        conditions
      );

      // Both should evaluate to true based on our test data
      expect(results.every(r => r.failed)).toBe(true);
    });
  });
});
