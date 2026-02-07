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

describe('HTML Whitespace Fix Test', () => {
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

  test('HTML table should not have empty lines that break GitHub rendering', async () => {
    const mockReview = {
      issues: [
        {
          file: 'src/test.ts',
          line: 10,
          ruleId: 'security/test-rule',
          message: 'Test security issue',
          severity: 'critical' as const,
          category: 'security' as const,
          group: 'code-review',
          schema: 'code-review',
        },
      ],
    };

    const groupedResults = convertReviewSummaryToGroupedResults(mockReview);
    await reviewer.postReviewComment('owner', 'repo', 1, groupedResults);

    const callArgs = (mockOctokit.rest.issues.createComment as jest.Mock).mock.calls[0][0];
    const comment = callArgs.body;

    console.log('=== GENERATED HTML ===');
    console.log(comment);
    console.log('=== END ===');

    // Should have simple markdown format without HTML tables
    expect(comment).toContain('## Issues Found (1)');
    expect(comment).toContain('- **CRITICAL**: Test security issue');

    // Should not have HTML table structures
    expect(comment).not.toContain('<tbody>');
    expect(comment).not.toContain('<tr>');
    expect(comment).not.toContain('<td>');

    // Should not have category-specific sections
    expect(comment).not.toContain('Security Issues');
    expect(comment).not.toContain('General Suggestions');
  });

  test('should handle multiple checks with individual templates', async () => {
    const mockReview = {
      issues: [
        {
          file: 'src/security.ts',
          line: 1,
          ruleId: 'security/sql-injection',
          message: 'SQL injection vulnerability',
          severity: 'critical' as const,
          category: 'security' as const,
          group: 'code-review',
          schema: 'code-review',
        },
        {
          file: 'src/performance.ts',
          line: 5,
          ruleId: 'performance/n-plus-one',
          message: 'N+1 query detected',
          severity: 'warning' as const,
          category: 'performance' as const,
          group: 'code-review',
          schema: 'code-review',
        },
      ],
    };

    const groupedResults = convertReviewSummaryToGroupedResults(mockReview);
    await reviewer.postReviewComment('owner', 'repo', 1, groupedResults);

    const callArgs = (mockOctokit.rest.issues.createComment as jest.Mock).mock.calls[0][0];
    const comment = callArgs.body;

    console.log('=== MULTI-CHECK COMMENT ===');
    console.log(comment);
    console.log('=== END ===');

    // Should have simple format with all issues
    expect(comment).toContain('## Issues Found (2)');
    expect(comment).toContain('SQL injection vulnerability');
    expect(comment).toContain('N+1 query detected');

    // Should not have category-specific sections
    expect(comment).not.toContain('Security Issues');
    expect(comment).not.toContain('Performance Issues');

    // Should not have HTML tables
    expect(comment).not.toContain('<table>');
  });
});
