/* eslint-disable @typescript-eslint/no-explicit-any */
import { PRReviewer, GroupedCheckResults } from '../../src/reviewer';

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
    // Create grouped check results with different groups
    const mockGroupedCheckResults: GroupedCheckResults = {
      review: [
        {
          checkName: 'security-check',
          content: `## Security Issues Found

| File | Line | Issue | Severity |
|------|------|-------|----------|
| src/security.ts | 1 | SQL injection vulnerability | critical |
| src/performance.ts | 2 | N+1 query detected | warning |`,
          group: 'review',
        },
      ],
      overview: [
        {
          checkName: 'overview-check',
          content: `## PR Overview

| File | Line | Issue | Severity |
|------|------|-------|----------|
| README.md | 1 | PR overview generated | info |`,
          group: 'overview',
        },
      ],
      suggestions: [
        {
          checkName: 'suggestions-check',
          content: 'This is overview analysis with detailed insights about the PR',
          group: 'suggestions',
        },
      ],
    };

    // Post review comment - should create separate comments for different groups
    await reviewer.postReviewComment('owner', 'repo', 1, mockGroupedCheckResults);

    // Debug: Check how many comments were created
    const callCount = (mockOctokit.rest.issues.createComment as jest.Mock).mock.calls.length;
    console.log(`Created ${callCount} comments`);

    // Should create separate comments for different groups
    expect(mockOctokit.rest.issues.createComment as jest.Mock).toHaveBeenCalledTimes(3);

    const call1 = (mockOctokit.rest.issues.createComment as jest.Mock).mock.calls[0][0];
    const call2 = (mockOctokit.rest.issues.createComment as jest.Mock).mock.calls[1][0];
    const call3 = (mockOctokit.rest.issues.createComment as jest.Mock).mock.calls[2][0];

    // Find which comment contains what content
    const reviewComment = [call1, call2, call3].find(call =>
      call.body.includes('SQL injection vulnerability')
    );
    const overviewComment = [call1, call2, call3].find(call =>
      call.body.includes('PR overview generated')
    );
    const suggestionsComment = [call1, call2, call3].find(call =>
      call.body.includes('This is overview analysis')
    );

    // Review comment should have BOTH security and performance issues in one comment
    expect(reviewComment.body).toContain('SQL injection vulnerability');
    expect(reviewComment.body).toContain('N+1 query detected');

    // Overview comment should contain overview group content
    expect(overviewComment.body).toContain('PR overview generated');

    // Suggestions comment should contain suggestions
    expect(suggestionsComment.body).toContain(
      'This is overview analysis with detailed insights about the PR'
    );
  });

  test('should use correct template per group', async () => {
    const mockGroupedCheckResults: GroupedCheckResults = {
      'pr-overview': [
        {
          checkName: 'overview-check',
          content: `## PR Overview

This PR adds new features.

<table>
<tr>
<th>File</th>
<th>Line</th>
<th>Rule</th>
<th>Message</th>
<th>Severity</th>
</tr>
<tr>
<td>README.md</td>
<td>1</td>
<td>full-review/overview</td>
<td>## PR Overview\n\nThis PR adds new features.</td>
<td>info</td>
</tr>
</table>`,
          group: 'pr-overview',
        },
      ],
    };

    await reviewer.postReviewComment('owner', 'repo', 1, mockGroupedCheckResults);

    expect(mockOctokit.rest.issues.createComment as jest.Mock).toHaveBeenCalledTimes(1);

    const call = (mockOctokit.rest.issues.createComment as jest.Mock).mock.calls[0][0];

    // Should render using standard code-review template (with table)
    expect(call.body).toContain('## PR Overview');
    expect(call.body).toContain('This PR adds new features.');
    expect(call.body).toContain('<table>'); // Uses standard template with table
  });
});
