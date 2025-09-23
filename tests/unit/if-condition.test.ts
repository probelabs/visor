/**
 * Tests for if condition evaluation
 */

import { FailureConditionEvaluator } from '../../src/failure-condition-evaluator';
import { ReviewSummary } from '../../src/reviewer';

describe('If condition evaluation', () => {
  let evaluator: FailureConditionEvaluator;

  beforeEach(() => {
    evaluator = new FailureConditionEvaluator();
  });

  describe('Basic if conditions', () => {
    it('should evaluate simple branch conditions', async () => {
      // Test branch equals main
      const shouldRunOnMain = await evaluator.evaluateIfCondition(
        'test-check',
        'branch == "main"',
        {
          branch: 'main',
          baseBranch: 'main',
          filesChanged: [],
        }
      );
      expect(shouldRunOnMain).toBe(true);

      // Test branch not equals main
      const shouldNotRunOnFeature = await evaluator.evaluateIfCondition(
        'test-check',
        'branch == "main"',
        {
          branch: 'feature-branch',
          baseBranch: 'main',
          filesChanged: [],
        }
      );
      expect(shouldNotRunOnFeature).toBe(false);
    });

    it('should evaluate file change conditions', async () => {
      // Test when files changed
      const shouldRunWithChanges = await evaluator.evaluateIfCondition(
        'test-check',
        'filesCount > 0',
        {
          branch: 'main',
          baseBranch: 'main',
          filesChanged: ['file1.js', 'file2.js'],
        }
      );
      expect(shouldRunWithChanges).toBe(true);

      // Test when no files changed
      const shouldNotRunWithoutChanges = await evaluator.evaluateIfCondition(
        'test-check',
        'filesCount > 0',
        {
          branch: 'main',
          baseBranch: 'main',
          filesChanged: [],
        }
      );
      expect(shouldNotRunWithoutChanges).toBe(false);
    });

    it('should evaluate environment conditions', async () => {
      // Test environment variable check
      const shouldRunInCI = await evaluator.evaluateIfCondition('test-check', 'env.CI == "true"', {
        branch: 'main',
        baseBranch: 'main',
        filesChanged: [],
        environment: { CI: 'true' },
      });
      expect(shouldRunInCI).toBe(true);

      const shouldNotRunLocally = await evaluator.evaluateIfCondition(
        'test-check',
        'env.CI == "true"',
        {
          branch: 'main',
          baseBranch: 'main',
          filesChanged: [],
          environment: {},
        }
      );
      expect(shouldNotRunLocally).toBe(false);
    });
  });

  describe('GitHub Actions-style functions in if conditions', () => {
    it('should support contains() function', async () => {
      // Check if branch contains feature
      const shouldRunOnFeature = await evaluator.evaluateIfCondition(
        'test-check',
        'contains(branch, "feature")',
        {
          branch: 'feature-auth',
          baseBranch: 'main',
          filesChanged: [],
        }
      );
      expect(shouldRunOnFeature).toBe(true);

      // Check if files contain specific pattern
      const shouldRunForAuthFiles = await evaluator.evaluateIfCondition(
        'test-check',
        'contains(filesChanged, "auth.js")',
        {
          branch: 'main',
          baseBranch: 'main',
          filesChanged: ['auth.js', 'main.js'],
        }
      );
      expect(shouldRunForAuthFiles).toBe(true);
    });

    it('should support startsWith() function', async () => {
      const shouldRunOnFeature = await evaluator.evaluateIfCondition(
        'test-check',
        'startsWith(branch, "feature/")',
        {
          branch: 'feature/new-auth',
          baseBranch: 'main',
          filesChanged: [],
        }
      );
      expect(shouldRunOnFeature).toBe(true);

      const shouldNotRunOnMain = await evaluator.evaluateIfCondition(
        'test-check',
        'startsWith(branch, "feature/")',
        {
          branch: 'main',
          baseBranch: 'main',
          filesChanged: [],
        }
      );
      expect(shouldNotRunOnMain).toBe(false);
    });

    it('should support always() function', async () => {
      const shouldAlwaysRun = await evaluator.evaluateIfCondition('test-check', 'always()', {
        branch: 'any-branch',
        baseBranch: 'main',
        filesChanged: [],
      });
      expect(shouldAlwaysRun).toBe(true);

      // Using !always() to never run
      const shouldNeverRun = await evaluator.evaluateIfCondition('test-check', '!always()', {
        branch: 'any-branch',
        baseBranch: 'main',
        filesChanged: [],
      });
      expect(shouldNeverRun).toBe(false);
    });
  });

  describe('Complex if conditions', () => {
    it('should evaluate complex logical expressions', async () => {
      // Run on main or when many files changed
      const complexCondition = await evaluator.evaluateIfCondition(
        'test-check',
        'branch == "main" || filesCount > 5',
        {
          branch: 'feature',
          baseBranch: 'main',
          filesChanged: ['f1', 'f2', 'f3', 'f4', 'f5', 'f6'],
        }
      );
      expect(complexCondition).toBe(true);

      // Run only on feature branches with changes
      const featureWithChanges = await evaluator.evaluateIfCondition(
        'test-check',
        'startsWith(branch, "feature/") && filesCount > 0',
        {
          branch: 'feature/auth',
          baseBranch: 'main',
          filesChanged: ['auth.js'],
        }
      );
      expect(featureWithChanges).toBe(true);

      const mainWithChanges = await evaluator.evaluateIfCondition(
        'test-check',
        'startsWith(branch, "feature/") && filesCount > 0',
        {
          branch: 'main',
          baseBranch: 'main',
          filesChanged: ['auth.js'],
        }
      );
      expect(mainWithChanges).toBe(false);
    });

    it('should handle metadata access', async () => {
      const hasChangesCheck = await evaluator.evaluateIfCondition(
        'test-check',
        'metadata.hasChanges',
        {
          branch: 'main',
          baseBranch: 'main',
          filesChanged: ['file.js'],
        }
      );
      expect(hasChangesCheck).toBe(true);

      const checkNameCondition = await evaluator.evaluateIfCondition(
        'security-check',
        'contains(metadata.checkName, "security")',
        {
          branch: 'main',
          baseBranch: 'main',
          filesChanged: [],
        }
      );
      expect(checkNameCondition).toBe(true);
    });
  });

  describe('Dependency-based conditions', () => {
    it('should access outputs from previous checks', async () => {
      const previousResults = new Map<string, ReviewSummary>();
      previousResults.set('security-check', {
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
      });
      previousResults.set('style-check', {
        issues: [],
      });

      // First, test a simple check to see if outputs are accessible
      const hasOutputs = await evaluator.evaluateIfCondition('test-check', 'outputs', {
        branch: 'main',
        baseBranch: 'main',
        filesChanged: [],
        previousResults,
      });
      expect(hasOutputs).toBeTruthy();

      // Run only if security check found issues (use length() function)
      const shouldRunAfterSecurityIssues = await evaluator.evaluateIfCondition(
        'combined-check',
        'outputs["security-check"] && length(outputs["security-check"].issues) > 0',
        {
          branch: 'main',
          baseBranch: 'main',
          filesChanged: [],
          previousResults,
        }
      );
      expect(shouldRunAfterSecurityIssues).toBe(true);

      // Run only if style check passed (no issues)
      const shouldRunAfterStylePass = await evaluator.evaluateIfCondition(
        'final-check',
        'length(outputs["style-check"].issues) == 0',
        {
          branch: 'main',
          baseBranch: 'main',
          filesChanged: [],
          previousResults,
        }
      );
      expect(shouldRunAfterStylePass).toBe(true);

      // Check if we can use hasIssue helper with outputs
      const shouldNotRunWithCritical = await evaluator.evaluateIfCondition(
        'optional-check',
        '!hasIssue(outputs["security-check"].issues, "severity", "critical")',
        {
          branch: 'main',
          baseBranch: 'main',
          filesChanged: [],
          previousResults,
        }
      );
      expect(shouldNotRunWithCritical).toBe(false);
    });
  });

  describe('Error handling', () => {
    it('should default to true when expression is invalid', async () => {
      const invalidExpression = await evaluator.evaluateIfCondition(
        'test-check',
        'this is not valid expression syntax ++',
        {
          branch: 'main',
          baseBranch: 'main',
          filesChanged: [],
        }
      );
      // Should default to true (run the check) when evaluation fails
      expect(invalidExpression).toBe(true);
    });

    it('should handle missing context gracefully', async () => {
      const minimalContext = await evaluator.evaluateIfCondition(
        'test-check',
        'branch == "unknown"'
        // No context provided
      );
      expect(minimalContext).toBe(true); // "unknown" == "unknown"
    });
  });
});
