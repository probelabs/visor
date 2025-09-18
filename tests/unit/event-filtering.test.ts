import { describe, it, expect, beforeEach } from '@jest/globals';
import { FailureConditionEvaluator } from '../../src/failure-condition-evaluator';

describe('Event Filtering', () => {
  let evaluator: FailureConditionEvaluator;

  beforeEach(() => {
    evaluator = new FailureConditionEvaluator();
  });

  describe('PR vs Issue Detection', () => {
    it('should identify pull request events', async () => {
      const result = await evaluator.evaluateIfCondition(
        'test-check',
        'event.event_name === "pull_request"',
        {
          event: 'pull_request',
          branch: 'feature/test',
          baseBranch: 'main',
          filesChanged: ['test.js'],
        }
      );

      expect(result).toBe(true);
    });

    it('should identify pull request comment events', async () => {
      const result = await evaluator.evaluateIfCondition(
        'test-check',
        'event.event_name === "issue_comment"',
        {
          event: 'issue_comment', // Comments on PRs are still issue_comment events
          branch: 'feature/test',
          baseBranch: 'main',
          filesChanged: ['test.js'],
        }
      );

      // issue_comment event name matches
      expect(result).toBe(true);
    });

    it('should identify issue events', async () => {
      const result = await evaluator.evaluateIfCondition(
        'test-check',
        'event.event_name === "issues"',
        {
          event: 'issues',
          branch: 'main',
          baseBranch: 'main',
          filesChanged: [],
        }
      );

      expect(result).toBe(true);
    });

    it('should identify issue comment events', async () => {
      const result = await evaluator.evaluateIfCondition(
        'test-check',
        'event.event_name === "issue_comment"',
        {
          event: 'issue_comment',
          branch: 'main',
          baseBranch: 'main',
          filesChanged: [],
        }
      );

      expect(result).toBe(true);
    });

    it('should handle unknown events', async () => {
      const result = await evaluator.evaluateIfCondition(
        'test-check',
        'event.event_name === "pull_request" || event.event_name === "issues"',
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
      const result = await evaluator.evaluateIfCondition(
        'test-check',
        'event.event_name === "manual"',
        {
          event: 'manual',
          branch: 'main',
          baseBranch: 'main',
          filesChanged: [],
        }
      );

      expect(result).toBe(true);
    });
  });

  describe('Complex Event Conditions', () => {
    it('should handle PR-only conditions', async () => {
      const condition = 'event.event_name === "pull_request" && filesChanged.length > 0';

      // PR with files changed
      const prResult = await evaluator.evaluateIfCondition('test-check', condition, {
        event: 'pull_request',
        branch: 'feature/test',
        baseBranch: 'main',
        filesChanged: ['test.js', 'docs.md'],
      });

      expect(prResult).toBe(true);

      // Issue with files (shouldn't happen but tests the logic)
      const issueResult = await evaluator.evaluateIfCondition('test-check', condition, {
        event: 'issues',
        branch: 'main',
        baseBranch: 'main',
        filesChanged: ['test.js'],
      });

      expect(issueResult).toBe(false);
    });

    it('should handle issue-only conditions', async () => {
      const condition = 'event.event_name === "issues" && event.event_name !== "pull_request"';

      const issueResult = await evaluator.evaluateIfCondition('test-check', condition, {
        event: 'issues',
        branch: 'main',
        baseBranch: 'main',
        filesChanged: [],
      });

      expect(issueResult).toBe(true);

      const prResult = await evaluator.evaluateIfCondition('test-check', condition, {
        event: 'pull_request',
        branch: 'feature/test',
        baseBranch: 'main',
        filesChanged: ['test.js'],
      });

      expect(prResult).toBe(false);
    });

    it('should handle event type checking', async () => {
      const condition = 'event.event_name === "issue_comment"';

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
        '(event.event_name === "pull_request" && filesCount > 5) || (event.event_name === "issues" && event.event_name === "issues")';

      // Large PR
      const largePrResult = await evaluator.evaluateIfCondition('test-check', condition, {
        event: 'pull_request',
        branch: 'feature/large',
        baseBranch: 'main',
        filesChanged: ['a.js', 'b.js', 'c.js', 'd.js', 'e.js', 'f.js'],
      });

      expect(largePrResult).toBe(true);

      // New issue
      const newIssueResult = await evaluator.evaluateIfCondition('test-check', condition, {
        event: 'issues',
        branch: 'main',
        baseBranch: 'main',
        filesChanged: [],
      });

      expect(newIssueResult).toBe(true);

      // Small PR
      const smallPrResult = await evaluator.evaluateIfCondition('test-check', condition, {
        event: 'pull_request',
        branch: 'feature/small',
        baseBranch: 'main',
        filesChanged: ['test.js'],
      });

      expect(smallPrResult).toBe(false);
    });
  });
});
