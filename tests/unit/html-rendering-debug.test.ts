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

describe('HTML Rendering Debug', () => {
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

  test('should generate proper HTML table structure', async () => {
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
          replacement: 'const fixed = true;',
          group: 'code-review',
          schema: 'code-review',
        },
      ],
      suggestions: [],
    };

    await reviewer.postReviewComment('owner', 'repo', 1, mockReview);

    const callArgs = (mockOctokit.rest.issues.createComment as jest.Mock).mock.calls[0][0];
    console.log('=== GENERATED COMMENT ===');
    console.log(callArgs.body);
    console.log('=== END COMMENT ===');

    // Should have proper HTML table structure
    expect(callArgs.body).toContain('<table>');
    expect(callArgs.body).toContain('<thead>');
    expect(callArgs.body).toContain('<tbody>');
    expect(callArgs.body).toContain('<tr>');
    expect(callArgs.body).toContain('<td>');

    // Should NOT have HTML inside code blocks
    expect(callArgs.body).not.toMatch(/```[\s\S]*<table>[\s\S]*```/);
    expect(callArgs.body).not.toMatch(/```[\s\S]*<tr>[\s\S]*```/);

    // Should have proper table content
    expect(callArgs.body).toContain('Test security issue');
    expect(callArgs.body).toContain('Fix this issue');
  });

  test('should render suggestions and replacements correctly', async () => {
    const mockReview = {
      issues: [
        {
          file: 'src/test.ts',
          line: 10,
          ruleId: 'security/test-rule',
          message: 'Test issue',
          severity: 'warning' as const,
          category: 'security' as const,
          suggestion: 'Use proper validation',
          replacement: '<script>alert("test")</script>',
          group: 'code-review',
          schema: 'code-review',
        },
      ],
      suggestions: [],
    };

    await reviewer.postReviewComment('owner', 'repo', 1, mockReview);

    const callArgs = (mockOctokit.rest.issues.createComment as jest.Mock).mock.calls[0][0];
    console.log('=== SUGGESTION RENDERING ===');
    console.log(callArgs.body);
    console.log('=== END ===');

    // Should escape HTML in code suggestions
    expect(callArgs.body).toContain('&lt;script&gt;');
    expect(callArgs.body).not.toContain('<script>alert("test")</script>');

    // Should have proper details/summary structure
    expect(callArgs.body).toContain('<details>');
    expect(callArgs.body).toContain('<summary>');
    expect(callArgs.body).toContain('💡 <strong>Suggestion</strong>');
    expect(callArgs.body).toContain('🔧 <strong>Suggested Fix</strong>');
  });

  test('should handle multiple groups correctly', async () => {
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
          file: 'README.md',
          line: 1,
          ruleId: 'full-review/overview',
          message: '## PR Overview\n\nThis PR adds new security features.',
          severity: 'info' as const,
          category: 'documentation' as const,
          group: 'pr-overview',
          schema: 'markdown',
        },
      ],
      suggestions: [
        '[security] Consider adding input validation',
        '[full-review] Update documentation',
      ],
    };

    await reviewer.postReviewComment('owner', 'repo', 1, mockReview);

    // Should create 2 separate comments for different groups
    expect(mockOctokit.rest.issues.createComment as jest.Mock).toHaveBeenCalledTimes(2);

    const call1 = (mockOctokit.rest.issues.createComment as jest.Mock).mock.calls[0][0];
    const call2 = (mockOctokit.rest.issues.createComment as jest.Mock).mock.calls[1][0];

    console.log('=== FIRST COMMENT (should be code-review) ===');
    console.log(call1.body);
    console.log('=== SECOND COMMENT (should be pr-overview) ===');
    console.log(call2.body);
    console.log('=== END ===');

    // One should be table format, other should be markdown
    const hasTable = call1.body.includes('<table>') || call2.body.includes('<table>');
    const hasMarkdown =
      call1.body.includes('## PR Overview') || call2.body.includes('## PR Overview');

    expect(hasTable).toBe(true);
    expect(hasMarkdown).toBe(true);
  });

  test('should not show General Suggestions if suggestions are empty', async () => {
    const mockReview = {
      issues: [
        {
          file: 'src/test.ts',
          line: 10,
          ruleId: 'security/test-rule',
          message: 'Test issue',
          severity: 'warning' as const,
          category: 'security' as const,
          group: 'code-review',
          schema: 'code-review',
        },
      ],
      suggestions: [], // Empty suggestions
    };

    await reviewer.postReviewComment('owner', 'repo', 1, mockReview);

    const callArgs = (mockOctokit.rest.issues.createComment as jest.Mock).mock.calls[0][0];

    // Should NOT contain General Suggestions section
    expect(callArgs.body).not.toContain('## 💡 General Suggestions');
  });
});
