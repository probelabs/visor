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

  test('should create combined comment with all content', async () => {
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
          group: 'code-review',
        },
        {
          file: 'src/performance.ts',
          line: 2,
          ruleId: 'performance/n-plus-one',
          message: 'N+1 query detected',
          severity: 'warning' as const,
          category: 'performance' as const,
          group: 'code-review',
        },
        // PR overview group issue
        {
          file: 'README.md',
          line: 1,
          ruleId: 'full-review/overview',
          message: 'PR overview generated',
          severity: 'info' as const,
          category: 'documentation' as const,
          group: 'pr-overview',
        },
      ],
      suggestions: ['This is overview analysis with detailed insights about the PR'],
    };

    // Post review comment - should create single comment with all content
    await reviewer.postReviewComment('owner', 'repo', 1, mockReviewWithMultipleGroups);

    // Should create ONE comment with all content combined
    expect(mockOctokit.rest.issues.createComment as jest.Mock).toHaveBeenCalledTimes(1);

    const callArgs = (mockOctokit.rest.issues.createComment as jest.Mock).mock.calls[0][0];

    // Comment should contain both structured issues and suggestions
    expect(callArgs.body).toContain('SQL injection vulnerability');
    expect(callArgs.body).toContain('N+1 query detected');
    expect(callArgs.body).toContain('PR overview generated');
    expect(callArgs.body).toContain(
      'This is overview analysis with detailed insights about the PR'
    );
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
