import { PRReviewer } from '../../src/reviewer';

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
      suggestions: [],
    };

    await reviewer.postReviewComment('owner', 'repo', 1, mockReview);

    const callArgs = (mockOctokit.rest.issues.createComment as jest.Mock).mock.calls[0][0];
    const comment = callArgs.body;

    console.log('=== GENERATED HTML ===');
    console.log(comment);
    console.log('=== END ===');

    // Should not have empty lines within the table structure that would break GitHub's HTML parsing

    // Check for problematic patterns
    expect(comment).not.toMatch(/<tbody>\s*\n\s*\n/); // No double newlines after <tbody>
    expect(comment).not.toMatch(/<tr>\s*\n\s*\n/); // No double newlines after <tr>
    expect(comment).not.toMatch(/<td>\s*\n\s*\n/); // No double newlines after <td>

    // Should have clean table structure
    expect(comment).toContain('<tbody>');
    expect(comment).toContain('<tr>');
    expect(comment).toContain('<td>🔴 Critical</td>');

    // Should NOT contain General Suggestions
    expect(comment).not.toContain('General Suggestions');

    // Should have proper content
    expect(comment).toContain('Test security issue');
    expect(comment).toContain('Security Issues');
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
      suggestions: [],
    };

    await reviewer.postReviewComment('owner', 'repo', 1, mockReview);

    const callArgs = (mockOctokit.rest.issues.createComment as jest.Mock).mock.calls[0][0];
    const comment = callArgs.body;

    console.log('=== MULTI-CHECK COMMENT ===');
    console.log(comment);
    console.log('=== END ===');

    // Should have separate sections for each check
    expect(comment).toContain('Security Issues');
    expect(comment).toContain('Performance Issues');

    // Should have both issues
    expect(comment).toContain('SQL injection vulnerability');
    expect(comment).toContain('N+1 query detected');

    // Should have two separate tables (one per check)
    const tableMatches = comment.match(/<table>/g);
    expect(tableMatches).toHaveLength(2);

    // Should have proper HTML structure
    expect(comment).not.toMatch(/<tbody>\s*\n\s*\n/);
  });
});
