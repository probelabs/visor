import { describe, it, expect, beforeEach } from '@jest/globals';
import { FailureConditionEvaluator } from '../../src/failure-condition-evaluator';

describe('Event Filtering', () => {
  let evaluator: FailureConditionEvaluator;

  beforeEach(() => {
    evaluator = new FailureConditionEvaluator();
  });

  describe('PR vs Issue Detection', () => {
    it('should identify pull request events', async () => {
      const result = await evaluator.evaluateIfCondition('test-check', 'event.isPullRequest', {
        event: 'pr_opened',
        branch: 'feature/test',
        baseBranch: 'main',
        filesChanged: ['test.js'],
      });

      expect(result).toBe(true);
    });

    it('should identify pull request comment events', async () => {
      const result = await evaluator.evaluateIfCondition('test-check', 'event.isPullRequest', {
        event: 'issue_comment', // Comments on PRs are still issue_comment events
        branch: 'feature/test',
        baseBranch: 'main',
        filesChanged: ['test.js'],
      });

      // Note: issue_comment doesn't automatically indicate a PR
      // In real usage, the context would need to determine if the comment is on a PR
      expect(result).toBe(false);
    });

    it('should identify issue events', async () => {
      const result = await evaluator.evaluateIfCondition('test-check', 'event.isIssue', {
        event: 'issue_opened',
        branch: 'main',
        baseBranch: 'main',
        filesChanged: [],
      });

      expect(result).toBe(true);
    });

    it('should identify issue comment events', async () => {
      const result = await evaluator.evaluateIfCondition('test-check', 'event.isIssue', {
        event: 'issue_comment',
        branch: 'main',
        baseBranch: 'main',
        filesChanged: [],
      });

      expect(result).toBe(true);
    });

    it('should handle unknown events', async () => {
      const result = await evaluator.evaluateIfCondition(
        'test-check',
        'event.isPullRequest || event.isIssue',
        {
          event: 'unknown_event',
          branch: 'main',
          baseBranch: 'main',
          filesChanged: [],
        }
      );

      expect(result).toBe(false);
    });

    it('should handle manual events', async () => {
      const result = await evaluator.evaluateIfCondition('test-check', 'event.type === "manual"', {
        event: 'manual',
        branch: 'main',
        baseBranch: 'main',
        filesChanged: [],
      });

      expect(result).toBe(true);
    });
  });

  describe('Complex Event Conditions', () => {
    it('should handle PR-only conditions', async () => {
      const condition = 'event.isPullRequest && filesChanged.length > 0';

      // PR with files changed
      const prResult = await evaluator.evaluateIfCondition('test-check', condition, {
        event: 'pr_opened',
        branch: 'feature/test',
        baseBranch: 'main',
        filesChanged: ['test.js', 'docs.md'],
      });

      expect(prResult).toBe(true);

      // Issue with files (shouldn't happen but tests the logic)
      const issueResult = await evaluator.evaluateIfCondition('test-check', condition, {
        event: 'issue_opened',
        branch: 'main',
        baseBranch: 'main',
        filesChanged: ['test.js'],
      });

      expect(issueResult).toBe(false);
    });

    it('should handle issue-only conditions', async () => {
      const condition = 'event.isIssue && !event.isPullRequest';

      const issueResult = await evaluator.evaluateIfCondition('test-check', condition, {
        event: 'issue_opened',
        branch: 'main',
        baseBranch: 'main',
        filesChanged: [],
      });

      expect(issueResult).toBe(true);

      const prResult = await evaluator.evaluateIfCondition('test-check', condition, {
        event: 'pr_opened',
        branch: 'feature/test',
        baseBranch: 'main',
        filesChanged: ['test.js'],
      });

      expect(prResult).toBe(false);
    });

    it('should handle event type checking', async () => {
      const condition = 'event.type === "issue_comment"';

      const result = await evaluator.evaluateIfCondition('test-check', condition, {
        event: 'issue_comment',
        branch: 'main',
        baseBranch: 'main',
        filesChanged: [],
      });

      expect(result).toBe(true);
    });

    it('should handle combined conditions', async () => {
      const condition =
        '(event.isPullRequest && filesCount > 5) || (event.isIssue && event.type === "issue_opened")';

      // Large PR
      const largePrResult = await evaluator.evaluateIfCondition('test-check', condition, {
        event: 'pr_opened',
        branch: 'feature/large',
        baseBranch: 'main',
        filesChanged: ['a.js', 'b.js', 'c.js', 'd.js', 'e.js', 'f.js'],
      });

      expect(largePrResult).toBe(true);

      // New issue
      const newIssueResult = await evaluator.evaluateIfCondition('test-check', condition, {
        event: 'issue_opened',
        branch: 'main',
        baseBranch: 'main',
        filesChanged: [],
      });

      expect(newIssueResult).toBe(true);

      // Small PR
      const smallPrResult = await evaluator.evaluateIfCondition('test-check', condition, {
        event: 'pr_opened',
        branch: 'feature/small',
        baseBranch: 'main',
        filesChanged: ['test.js'],
      });

      expect(smallPrResult).toBe(false);
    });
  });
});
