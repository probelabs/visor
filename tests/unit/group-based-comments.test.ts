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

describe('Group-based Comments', () => {
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

  test('should create separate comments for different groups', async () => {
    // Mock review results from multiple groups
    const mockReviewWithMultipleGroups = {
      issues: [
        // Code review group issues
        {
          file: 'src/security.ts',
          line: 1,
          ruleId: 'security/sql-injection',
          message: 'SQL injection vulnerability',
          severity: 'critical' as const,
          category: 'security' as const,
          group: 'code-review', // This should go to code-review comment
        },
        {
          file: 'src/performance.ts',
          line: 2,
          ruleId: 'performance/n-plus-one',
          message: 'N+1 query detected',
          severity: 'warning' as const,
          category: 'performance' as const,
          group: 'code-review', // This should go to code-review comment
        },
        // PR overview group issue
        {
          file: 'README.md',
          line: 1,
          ruleId: 'full-review/overview',
          message: 'PR overview generated',
          severity: 'info' as const,
          category: 'documentation' as const,
          group: 'pr-overview', // This should go to separate pr-overview comment
        },
      ],
      suggestions: [],
    };

    // This is a hypothetical API - the question is how should group-based posting work?
    // Option 1: postReviewComment automatically detects groups and posts separate comments
    await reviewer.postReviewComment('owner', 'repo', 1, mockReviewWithMultipleGroups);

    // Should create TWO separate comments - one per group
    expect(mockOctokit.rest.issues.createComment as jest.Mock).toHaveBeenCalledTimes(2);

    const call1 = (mockOctokit.rest.issues.createComment as jest.Mock).mock.calls[0][0];
    const call2 = (mockOctokit.rest.issues.createComment as jest.Mock).mock.calls[1][0];

    // One comment should contain code-review group content
    const codeReviewComment = call1.body.includes('Security Issues') ? call1 : call2;
    const prOverviewComment = call1.body.includes('Security Issues') ? call2 : call1;

    expect(codeReviewComment.body).toContain('Security Issues');
    expect(codeReviewComment.body).toContain('Performance Issues');
    expect(codeReviewComment.body).toContain('SQL injection vulnerability');
    expect(codeReviewComment.body).toContain('N+1 query detected');

    // Other comment should contain pr-overview group content
    expect(prOverviewComment.body).toContain('PR overview generated');
    expect(prOverviewComment.body).not.toContain('SQL injection vulnerability');
  });

  test('should use correct template per group', async () => {
    const mockReviewWithOverview = {
      issues: [
        {
          file: 'README.md',
          line: 1,
          ruleId: 'full-review/overview',
          message: '## PR Overview\n\nThis PR adds new features.',
          severity: 'info' as const,
          category: 'documentation' as const,
          group: 'pr-overview',
        },
      ],
      suggestions: [],
    };

    await reviewer.postReviewComment('owner', 'repo', 1, mockReviewWithOverview);

    expect(mockOctokit.rest.issues.createComment as jest.Mock).toHaveBeenCalledTimes(1);

    const call = (mockOctokit.rest.issues.createComment as jest.Mock).mock.calls[0][0];

    // Should render using standard code-review template (with table)
    expect(call.body).toContain('## PR Overview');
    expect(call.body).toContain('This PR adds new features.');
    expect(call.body).toContain('<table>'); // Uses standard template with table
  });
});
