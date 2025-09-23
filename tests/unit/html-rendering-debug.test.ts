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
    };

    const groupedResults = convertReviewSummaryToGroupedResults(mockReview);
    await reviewer.postReviewComment('owner', 'repo', 1, groupedResults);

    const callArgs = (mockOctokit.rest.issues.createComment as jest.Mock).mock.calls[0][0];
    console.log('=== GENERATED COMMENT ===');
    console.log(callArgs.body);
    console.log('=== END COMMENT ===');

    // Should have simple markdown structure instead of HTML tables
    expect(callArgs.body).toContain('## Issues Found (1)');
    expect(callArgs.body).toContain('- **ERROR**: Test security issue (src/test.ts:10)');

    // Should NOT have HTML tables in the new format
    expect(callArgs.body).not.toContain('<table>');
    expect(callArgs.body).not.toContain('<thead>');
    expect(callArgs.body).not.toContain('<tbody>');
    expect(callArgs.body).not.toMatch(/```[\s\S]*<tr>[\s\S]*```/);

    // Should have proper content
    expect(callArgs.body).toContain('Test security issue');
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
    };

    const groupedResults = convertReviewSummaryToGroupedResults(mockReview);
    await reviewer.postReviewComment('owner', 'repo', 1, groupedResults);

    const callArgs = (mockOctokit.rest.issues.createComment as jest.Mock).mock.calls[0][0];
    console.log('=== SUGGESTION RENDERING ===');
    console.log(callArgs.body);
    console.log('=== END ===');

    // Should have the simple format without escaping individual suggestion/replacement properties
    expect(callArgs.body).toContain('## Issues Found (1)');
    expect(callArgs.body).toContain('- **WARNING**: Test issue (src/test.ts:10)');

    // Should not contain HTML structures in the new format
    expect(callArgs.body).not.toContain('<details>');
    expect(callArgs.body).not.toContain('<summary>');
    expect(callArgs.body).not.toContain('<script>');
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
          group: 'overview',
          schema: 'plain',
        },
      ],
    };

    const groupedResults = convertReviewSummaryToGroupedResults(mockReview);
    await reviewer.postReviewComment('owner', 'repo', 1, groupedResults);

    // Should create 1 comment with all issues in the simple format
    expect(mockOctokit.rest.issues.createComment as jest.Mock).toHaveBeenCalledTimes(1);

    const call1 = (mockOctokit.rest.issues.createComment as jest.Mock).mock.calls[0][0];

    console.log('=== COMMENT ===');
    console.log(call1.body);
    console.log('=== END ===');

    // Should have simple markdown format with all issues
    expect(call1.body).toContain('## Issues Found (2)');
    expect(call1.body).toContain('SQL injection vulnerability');
    expect(call1.body).toContain('## PR Overview');

    // Should not have table format
    expect(call1.body).not.toContain('<table>');
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
    };

    const groupedResults = convertReviewSummaryToGroupedResults(mockReview);
    await reviewer.postReviewComment('owner', 'repo', 1, groupedResults);

    const callArgs = (mockOctokit.rest.issues.createComment as jest.Mock).mock.calls[0][0];

    // Should have issues but not suggestions section when suggestions are empty
    expect(callArgs.body).toContain('## Issues Found (1)');
    expect(callArgs.body).toContain('- **WARNING**: Test issue');
    expect(callArgs.body).not.toContain('## Suggestions');
  });
});
