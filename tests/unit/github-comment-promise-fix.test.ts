/* eslint-disable @typescript-eslint/no-explicit-any */
import { PRReviewer, convertReviewSummaryToGroupedResults } from '../../src/reviewer';

// Mock Octokit
const mockOctokit = {
  rest: {
    issues: {
      createComment: jest.fn(),
      listComments: jest.fn(),
      updateComment: jest.fn(),
      getComment: jest.fn(),
    },
  },
  request: jest.fn().mockResolvedValue({ data: {} }),
};

describe('GitHub Comment Promise Fix', () => {
  let reviewer: PRReviewer;

  beforeEach(() => {
    reviewer = new PRReviewer(mockOctokit as any);
    jest.clearAllMocks();
    (mockOctokit.rest.issues.listComments as jest.Mock).mockResolvedValue({ data: [] });
    (mockOctokit.rest.issues.createComment as jest.Mock).mockResolvedValue({
      data: {
        id: 123,
        body: 'Test comment',
        user: { login: 'visor-bot' },
        created_at: '2023-01-01T00:00:00Z',
        updated_at: '2023-01-01T00:00:00Z',
      },
    });
  });

  test('should not render "[object Promise]" in GitHub comments', async () => {
    const mockReview = {
      issues: [
        {
          file: 'src/test.ts',
          line: 10,
          ruleId: 'security/test-rule',
          message: 'Test security issue',
          severity: 'error' as const,
          category: 'security' as const,
          suggestion: 'Fix this issue',
          replacement: 'fixed code',
        },
      ],
    };

    const groupedResults = convertReviewSummaryToGroupedResults(mockReview);
    await reviewer.postReviewComment('owner', 'repo', 1, groupedResults);

    const callArgs = (mockOctokit.rest.issues.createComment as jest.Mock).mock.calls[0][0];

    // Should NOT contain "[object Promise]" anywhere in the comment
    expect(callArgs.body).not.toContain('[object Promise]');

    // Should contain actual rendered content
    expect(callArgs.body).toContain('Test security issue');

    // Should have simple format
    expect(callArgs.body).toContain('## Issues Found (1)');
  });

  test('should handle async template rendering correctly', async () => {
    const mockReview = {
      issues: [
        {
          file: 'src/async-test.ts',
          line: 5,
          ruleId: 'performance/async-issue',
          message: 'Async performance issue',
          severity: 'warning' as const,
          category: 'performance' as const,
        },
      ],
    };

    // This should not throw and should return proper string content
    const groupedResults = convertReviewSummaryToGroupedResults(mockReview);
    await reviewer.postReviewComment('owner', 'repo', 1, groupedResults);

    const callArgs = (mockOctokit.rest.issues.createComment as jest.Mock).mock.calls[0][0];

    // Verify the comment body is a proper string, not a Promise
    expect(typeof callArgs.body).toBe('string');
    expect(callArgs.body).toContain('Async performance issue');
    expect(callArgs.body).toContain('## Issues Found (1)');

    // Should not have category-specific sections
    expect(callArgs.body).not.toContain('Performance Issues');
  });

  test('should respect group property from .visor.yaml configuration', async () => {
    const mockReview = {
      issues: [
        {
          file: 'src/security.ts',
          line: 1,
          ruleId: 'security/sql-injection',
          message: 'SQL injection vulnerability',
          severity: 'critical' as const,
          category: 'security' as const,
        },
        {
          file: 'src/performance.ts',
          line: 2,
          ruleId: 'performance/n-plus-one',
          message: 'N+1 query detected',
          severity: 'warning' as const,
          category: 'performance' as const,
        },
      ],
    };

    const groupedResults = convertReviewSummaryToGroupedResults(mockReview);
    await reviewer.postReviewComment('owner', 'repo', 1, groupedResults);

    // For now, we should have one comment - but it should be grouped by check name
    expect(mockOctokit.rest.issues.createComment as jest.Mock).toHaveBeenCalledTimes(1);

    const callArgs = (mockOctokit.rest.issues.createComment as jest.Mock).mock.calls[0][0];

    // Should have all issues in the simple format
    expect(callArgs.body).toContain('## Issues Found (2)');
    expect(callArgs.body).toContain('SQL injection vulnerability');
    expect(callArgs.body).toContain('N+1 query detected');

    // Should not have category-specific sections
    expect(callArgs.body).not.toContain('Security Issues');
    expect(callArgs.body).not.toContain('Performance Issues');
  });
});
