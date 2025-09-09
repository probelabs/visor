/* eslint-disable @typescript-eslint/no-explicit-any */
import { PRReviewer } from '../../src/reviewer';
import { PRInfo } from '../../src/pr-analyzer';

// Mock AI service to avoid actual API calls
jest.mock('../../src/ai-review-service', () => {
  return {
    AIReviewService: jest.fn().mockImplementation(() => ({
      executeReview: jest.fn().mockImplementation((prInfo, focus) => {
        const issues: any[] = [];
        const suggestions: string[] = [];

        // Dynamic responses based on test context
        if (
          focus === 'security' ||
          prInfo.files[0]?.patch?.includes('eval') ||
          prInfo.files[0]?.patch?.includes('innerHTML')
        ) {
          issues.push({
            file: 'src/test.ts',
            line: 5,
            ruleId: 'security/dangerous-eval',
            message: 'Dangerous eval usage detected',
            severity: 'critical',
            category: 'security',
          });
        }

        // Large file detection
        if (prInfo.files.some((f: any) => f.additions > 100)) {
          issues.push({
            file: prInfo.files.find((f: any) => f.additions > 100)?.filename || 'src/large.ts',
            line: 1,
            ruleId: 'style/large-change',
            message: 'Large file change detected, consider breaking into smaller PRs',
            severity: 'warning',
            category: 'style',
          });
        }

        // Test file suggestions
        const hasTestFiles = prInfo.files.some(
          (f: any) => f.filename.includes('.test.') || f.filename.includes('.spec.')
        );
        const hasSourceFiles = prInfo.files.some(
          (f: any) =>
            f.filename.includes('src/') &&
            !f.filename.includes('.test.') &&
            !f.filename.includes('.spec.')
        );

        if (hasSourceFiles && !hasTestFiles) {
          suggestions.push('Consider adding unit tests for the new functionality');
        } else if (hasTestFiles) {
          suggestions.push('Great job including tests with your changes!');
        }

        // Default response if no specific conditions met
        if (issues.length === 0) {
          issues.push({
            file: 'src/test.ts',
            line: 10,
            ruleId: 'style/naming-convention',
            message: 'Consider using const instead of let',
            severity: 'info',
            category: 'style',
          });
        }

        if (suggestions.length === 0) {
          suggestions.push('Add unit tests', 'Consider performance optimization');
        }

        return Promise.resolve({ issues, suggestions });
      }),
    })),
  };
});

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
  graphql: jest.fn().mockResolvedValue({}),
  log: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
  hook: {
    before: jest.fn(),
    after: jest.fn(),
    error: jest.fn(),
    wrap: jest.fn(),
  },
  auth: jest.fn().mockResolvedValue({ token: 'mock-token' }),
} as any;

describe('PRReviewer', () => {
  let reviewer: PRReviewer;
  let mockPRInfo: PRInfo;

  beforeEach(() => {
    reviewer = new PRReviewer(mockOctokit);
    jest.clearAllMocks();

    mockPRInfo = {
      number: 1,
      title: 'Test PR',
      body: 'This is a test PR',
      author: 'test-user',
      base: 'main',
      head: 'feature-branch',
      files: [
        {
          filename: 'src/test.ts',
          additions: 50,
          deletions: 10,
          changes: 60,
          patch: 'function test() {\n  console.log("test");\n}',
          status: 'modified',
        },
      ],
      totalAdditions: 50,
      totalDeletions: 10,
    };
  });

  describe('reviewPR', () => {
    test('should generate basic review summary', async () => {
      const review = await reviewer.reviewPR('owner', 'repo', 1, mockPRInfo);

      expect(review).toBeDefined();
      expect(Array.isArray(review.issues)).toBe(true);
      expect(Array.isArray(review.suggestions)).toBe(true);
      expect(review.issues.length).toBeGreaterThanOrEqual(0);
      expect(review.suggestions.length).toBeGreaterThanOrEqual(0);
    });

    test('should focus on security when requested', async () => {
      mockPRInfo.files[0].patch = 'eval("dangerous code"); innerHTML = userInput;';

      const review = await reviewer.reviewPR('owner', 'repo', 1, mockPRInfo, {
        focus: 'security',
      });

      const securityIssues = review.issues.filter(issue => issue.category === 'security');
      expect(securityIssues.length).toBeGreaterThan(0);
    });

    test('should provide detailed comments when requested', async () => {
      mockPRInfo.files = Array(10)
        .fill(null)
        .map((_, i) => ({
          filename: `src/file${i}.ts`,
          additions: 20,
          deletions: 5,
          changes: 25,
          patch: 'function test() { /* code */ }',
          status: 'modified' as const,
        }));

      const summaryReview = await reviewer.reviewPR('owner', 'repo', 1, mockPRInfo, {
        format: 'table',
      });

      const detailedReview = await reviewer.reviewPR('owner', 'repo', 1, mockPRInfo, {
        format: 'markdown',
      });

      expect(detailedReview.issues.length).toBeGreaterThanOrEqual(summaryReview.issues.length);
    });

    test('should detect large file changes', async () => {
      mockPRInfo.files[0].additions = 150;

      const review = await reviewer.reviewPR('owner', 'repo', 1, mockPRInfo);

      const largeFileIssues = review.issues.filter(
        issue => issue.message.includes('Large file change') || issue.message.includes('large')
      );
      expect(largeFileIssues.length).toBeGreaterThan(0);
    });

    test('should suggest tests when missing', async () => {
      mockPRInfo.files = [
        {
          filename: 'src/feature.ts',
          additions: 100,
          deletions: 0,
          changes: 100,
          patch: 'export function newFeature() {}',
          status: 'added',
        },
      ];

      const review = await reviewer.reviewPR('owner', 'repo', 1, mockPRInfo);

      const testSuggestion = review.suggestions.find(s => s.includes('unit tests'));
      expect(testSuggestion).toBeDefined();
    });

    test('should provide positive feedback when tests are present', async () => {
      mockPRInfo.files.push({
        filename: 'src/test.spec.ts',
        additions: 30,
        deletions: 0,
        changes: 30,
        patch: 'describe("test", () => {})',
        status: 'added',
      });

      const review = await reviewer.reviewPR('owner', 'repo', 1, mockPRInfo);

      const testSuggestion = review.suggestions.find(s => s.includes('Great job including tests'));
      expect(testSuggestion).toBeDefined();
    });
  });

  describe('postReviewComment', () => {
    test('should post formatted review comment', async () => {
      // Mock listComments to return empty (so it creates new comment)
      mockOctokit.rest.issues.listComments.mockResolvedValue({ data: [] });
      mockOctokit.rest.issues.createComment.mockResolvedValue({
        data: {
          id: 123,
          body: 'Test comment',
          user: { login: 'visor-bot' },
          created_at: '2023-01-01T00:00:00Z',
          updated_at: '2023-01-01T00:00:00Z',
        },
      });

      const mockReview = {
        issues: [
          {
            file: 'src/test.ts',
            line: 10,
            ruleId: 'style/naming-convention',
            message: 'Consider using const instead of let',
            severity: 'info' as const,
            category: 'style' as const,
          },
        ],
        suggestions: ['Add unit tests', 'Consider performance optimization'],
      };

      await reviewer.postReviewComment('owner', 'repo', 1, mockReview);

      expect(mockOctokit.rest.issues.listComments).toHaveBeenCalled();
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        issue_number: 1,
        body: expect.stringContaining('Style Analysis'),
      });

      const callArgs = mockOctokit.rest.issues.createComment.mock.calls[0][0];
      expect(callArgs.body).toContain('🎨 Style Analysis');
      expect(callArgs.body).toContain('1 informational item noted');
      expect(callArgs.body).toContain('Add unit tests');
      expect(callArgs.body).toContain('src/test.ts:10');
    });

    test('should format comment with different severity levels', async () => {
      // Mock listComments to return empty (so it creates new comment)
      mockOctokit.rest.issues.listComments.mockResolvedValue({ data: [] });
      mockOctokit.rest.issues.createComment.mockResolvedValue({
        data: {
          id: 124,
          body: 'Test comment',
          user: { login: 'visor-bot' },
          created_at: '2023-01-01T00:00:00Z',
          updated_at: '2023-01-01T00:00:00Z',
        },
      });

      const mockReview = {
        issues: [
          {
            file: 'src/error.ts',
            line: 5,
            ruleId: 'security/critical-vulnerability',
            message: 'Critical security issue',
            severity: 'error' as const,
            category: 'security' as const,
          },
          {
            file: 'src/warning.ts',
            line: 15,
            ruleId: 'performance/inefficiency',
            message: 'Potential performance issue',
            severity: 'warning' as const,
            category: 'performance' as const,
          },
          {
            file: 'src/info.ts',
            line: 25,
            ruleId: 'style/improvement',
            message: 'Style improvement',
            severity: 'info' as const,
            category: 'style' as const,
          },
        ],
        suggestions: [],
      };

      await reviewer.postReviewComment('owner', 'repo', 1, mockReview);

      const callArgs = mockOctokit.rest.issues.createComment.mock.calls[0][0];
      expect(callArgs.body).toContain('Critical security issue');
      expect(callArgs.body).toContain('Potential performance issue');
      expect(callArgs.body).toContain('Style improvement');
      expect(callArgs.body).toContain('🔒 Security Analysis');
      expect(callArgs.body).toContain('📈 Performance Analysis');
      expect(callArgs.body).toContain('🎨 Style Analysis');
    });

    test('should include debug information when debug data is provided', async () => {
      // Mock listComments to return empty (so it creates new comment)
      mockOctokit.rest.issues.listComments.mockResolvedValue({ data: [] });
      mockOctokit.rest.issues.createComment.mockResolvedValue({
        data: {
          id: 125,
          body: 'Test comment',
          user: { login: 'visor-bot' },
          created_at: '2023-01-01T00:00:00Z',
          updated_at: '2023-01-01T00:00:00Z',
        },
      });

      const mockReview = {
        issues: [
          {
            file: 'src/test.ts',
            line: 10,
            ruleId: 'style/naming-convention',
            message: 'Consider using const instead of let',
            severity: 'info' as const,
            category: 'style' as const,
          },
        ],
        suggestions: ['Add unit tests'],
        debug: {
          prompt: 'Test prompt for AI review',
          rawResponse: '{"issues":[{"file":"src/test.ts","line":10,"message":"test"}]}',
          provider: 'google',
          model: 'gemini-1.5-flash',
          apiKeySource: 'GOOGLE_API_KEY environment variable',
          processingTime: 1250,
          promptLength: 2048,
          responseLength: 512,
          jsonParseSuccess: true,
          timestamp: '2023-01-01T00:00:00.000Z',
          errors: [],
        },
      };

      await reviewer.postReviewComment('owner', 'repo', 1, mockReview);

      const callArgs = mockOctokit.rest.issues.createComment.mock.calls[0][0];

      // Check that debug section is included
      expect(callArgs.body).toContain('🐛 Debug Information');
      expect(callArgs.body).toContain('**Provider:** google');
      expect(callArgs.body).toContain('**Model:** gemini-1.5-flash');
      expect(callArgs.body).toContain('**API Key Source:** GOOGLE_API_KEY environment variable');
      expect(callArgs.body).toContain('**Processing Time:** 1250ms');
      expect(callArgs.body).toContain('**JSON Parse Success:** ✅');
      expect(callArgs.body).toContain('### AI Prompt');
      expect(callArgs.body).toContain('Test prompt for AI review');
      expect(callArgs.body).toContain('### Raw AI Response');
      expect(callArgs.body).toContain('"file":"src/test.ts"');
    });

    test('should not include debug information when debug data is not provided', async () => {
      // Mock listComments to return empty (so it creates new comment)
      mockOctokit.rest.issues.listComments.mockResolvedValue({ data: [] });
      mockOctokit.rest.issues.createComment.mockResolvedValue({
        data: {
          id: 126,
          body: 'Test comment',
          user: { login: 'visor-bot' },
          created_at: '2023-01-01T00:00:00Z',
          updated_at: '2023-01-01T00:00:00Z',
        },
      });

      const mockReview = {
        issues: [
          {
            file: 'src/test.ts',
            line: 10,
            ruleId: 'style/naming-convention',
            message: 'Consider using const instead of let',
            severity: 'info' as const,
            category: 'style' as const,
          },
        ],
        suggestions: ['Add unit tests'],
        // No debug field
      };

      await reviewer.postReviewComment('owner', 'repo', 1, mockReview);

      const callArgs = mockOctokit.rest.issues.createComment.mock.calls[0][0];

      // Check that debug section is NOT included
      expect(callArgs.body).not.toContain('🐛 Debug Information');
      expect(callArgs.body).not.toContain('**Provider:**');
      expect(callArgs.body).not.toContain('### AI Prompt');
    });
  });
});
