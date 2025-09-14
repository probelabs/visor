/**
 * Tests for simplified fail_if syntax
 */

import { FailureConditionEvaluator } from '../../src/failure-condition-evaluator';
import { ReviewSummary } from '../../src/reviewer';

describe('Simplified fail_if syntax', () => {
  let evaluator: FailureConditionEvaluator;

  beforeEach(() => {
    evaluator = new FailureConditionEvaluator();
  });

  describe('Simple fail_if conditions', () => {
    it('should evaluate basic fail_if expression', async () => {
      const reviewSummary: ReviewSummary = {
        issues: [
          {
            file: 'test.js',
            line: 1,
            severity: 'critical',
            message: 'Issue',
            category: 'security',
            ruleId: 'test',
          },
        ],
        suggestions: [],
      };

      // Test simple condition
      const shouldFail = await evaluator.evaluateSimpleCondition(
        'test-check',
        'code-review',
        'test',
        reviewSummary,
        'output.issues.some(i => i.severity === "critical")'
      );

      expect(shouldFail).toBe(true);

      // Test condition that should pass
      const shouldPass = await evaluator.evaluateSimpleCondition(
        'test-check',
        'code-review',
        'test',
        reviewSummary,
        'output.issues.filter(i => i.severity === "critical").length > 10'
      );

      expect(shouldPass).toBe(false);
    });

    it('should work with GitHub Actions-style functions', async () => {
      const reviewSummary: ReviewSummary = {
        issues: [],
        suggestions: [],
      };

      // Test always() function
      const alwaysTrue = await evaluator.evaluateSimpleCondition(
        'test-check',
        'code-review',
        'test',
        reviewSummary,
        'always()'
      );

      expect(alwaysTrue).toBe(true);

      // Test contains() function
      const containsCheck = await evaluator.evaluateSimpleCondition(
        'security-check',
        'code-review',
        'test',
        reviewSummary,
        'contains(checkName, "security")'
      );

      expect(containsCheck).toBe(true);

      // Test startsWith() function
      const startsWithCheck = await evaluator.evaluateSimpleCondition(
        'api-endpoint',
        'code-review',
        'test',
        reviewSummary,
        'startsWith(checkName, "api")'
      );

      expect(startsWithCheck).toBe(true);
    });

    it('should handle complex single-line expressions', async () => {
      const reviewSummary: ReviewSummary = {
        issues: [
          {
            file: 'auth.js',
            line: 1,
            severity: 'error',
            message: 'Issue',
            category: 'security',
            ruleId: 'test',
          },
          {
            file: 'api.js',
            line: 2,
            severity: 'warning',
            message: 'Issue',
            category: 'performance',
            ruleId: 'test',
          },
        ],
        suggestions: ['Fix auth issue'],
      };

      // Complex condition with multiple checks
      const complexCondition = await evaluator.evaluateSimpleCondition(
        'test-check',
        'code-review',
        'test',
        reviewSummary,
        '(output.issues.some(i => i.severity === "error") && output.issues.some(i => i.severity === "warning")) || output.issues.length > 5'
      );

      expect(complexCondition).toBe(true);

      // Using hasIssue helper
      const hasSecurityIssue = await evaluator.evaluateSimpleCondition(
        'test-check',
        'code-review',
        'test',
        reviewSummary,
        'hasIssue(issues, "category", "security")'
      );

      expect(hasSecurityIssue).toBe(true);

      // Using hasFileMatching helper
      const hasAuthFile = await evaluator.evaluateSimpleCondition(
        'test-check',
        'code-review',
        'test',
        reviewSummary,
        'hasFileMatching(issues, "auth")'
      );

      expect(hasAuthFile).toBe(true);
    });

    it('should use success() and failure() functions', async () => {
      const successSummary: ReviewSummary = {
        issues: [],
        suggestions: [],
      };

      const failureSummary: ReviewSummary = {
        issues: [
          {
            file: 'test.js',
            line: 1,
            severity: 'critical',
            message: 'Issue',
            category: 'security',
            ruleId: 'test',
          },
        ],
        suggestions: [],
      };

      // Test success function - no critical/error issues
      const successCheck = await evaluator.evaluateSimpleCondition(
        'test-check',
        'code-review',
        'test',
        successSummary,
        'criticalIssues === 0 && errorIssues === 0'
      );

      expect(successCheck).toBe(true); // No issues = success

      // Test failure function - has critical issues
      const failureCheck = await evaluator.evaluateSimpleCondition(
        'test-check',
        'code-review',
        'test',
        failureSummary,
        'criticalIssues > 0'
      );

      expect(failureCheck).toBe(true); // Has critical issues = failure
    });

    it('should handle invalid expressions gracefully', async () => {
      const reviewSummary: ReviewSummary = {
        issues: [],
        suggestions: [],
      };

      // Invalid expression should return false (not fail)
      const invalidExpression = await evaluator.evaluateSimpleCondition(
        'test-check',
        'code-review',
        'test',
        reviewSummary,
        'this is not valid expression syntax ++'
      );

      expect(invalidExpression).toBe(false); // Should not throw, returns false
    });
  });

  describe('Integration with config', () => {
    it('should evaluate config with fail_if fields', async () => {
      const reviewWithCritical: ReviewSummary = {
        issues: [
          {
            file: 'test.js',
            line: 1,
            severity: 'critical',
            message: 'Issue',
            category: 'security',
            ruleId: 'test',
          },
        ],
        suggestions: [],
      };

      const reviewWithWarning: ReviewSummary = {
        issues: [
          {
            file: 'test.js',
            line: 1,
            severity: 'warning',
            message: 'Issue',
            category: 'style',
            ruleId: 'test',
          },
        ],
        suggestions: [],
      };

      // Test security-check with its own fail_if
      const securityFail = await evaluator.evaluateSimpleCondition(
        'security-check',
        'code-review',
        'test',
        reviewWithWarning, // Only warning, but security check fails on ANY issues
        'output.issues.length > 0'
      );

      expect(securityFail).toBe(true);

      // Test style-check with global fail_if
      const styleFail = await evaluator.evaluateSimpleCondition(
        'style-check',
        'code-review',
        'test',
        reviewWithCritical, // Has critical issue
        'output.issues.some(i => i.severity === "critical")'
      );

      expect(styleFail).toBe(true);

      // Style check with only warnings should pass global condition
      const stylePass = await evaluator.evaluateSimpleCondition(
        'style-check',
        'code-review',
        'test',
        reviewWithWarning, // Only warning, no critical
        'output.issues.some(i => i.severity === "critical")'
      );

      expect(stylePass).toBe(false);
    });
  });
});
