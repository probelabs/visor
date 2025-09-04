/* eslint-disable @typescript-eslint/no-explicit-any */
import { PRReviewer } from '../../src/reviewer';
import { PRInfo } from '../../src/pr-analyzer';

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
      expect(review.overallScore).toBeGreaterThanOrEqual(0);
      expect(review.overallScore).toBeLessThanOrEqual(100);
      expect(review.totalIssues).toBeGreaterThanOrEqual(0);
      expect(review.criticalIssues).toBeGreaterThanOrEqual(0);
      expect(Array.isArray(review.suggestions)).toBe(true);
      expect(Array.isArray(review.comments)).toBe(true);
    });

    test('should focus on security when requested', async () => {
      mockPRInfo.files[0].patch = 'eval("dangerous code"); innerHTML = userInput;';

      const review = await reviewer.reviewPR('owner', 'repo', 1, mockPRInfo, {
        focus: 'security',
      });

      const securityComments = review.comments.filter(c => c.category === 'security');
      expect(securityComments.length).toBeGreaterThan(0);
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
        format: 'summary',
      });

      const detailedReview = await reviewer.reviewPR('owner', 'repo', 1, mockPRInfo, {
        format: 'detailed',
      });

      expect(detailedReview.comments.length).toBeGreaterThanOrEqual(summaryReview.comments.length);
    });

    test('should detect large file changes', async () => {
      mockPRInfo.files[0].additions = 150;

      const review = await reviewer.reviewPR('owner', 'repo', 1, mockPRInfo);

      const largeFileComments = review.comments.filter(c =>
        c.message.includes('Large file change')
      );
      expect(largeFileComments.length).toBeGreaterThan(0);
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
        overallScore: 85,
        totalIssues: 3,
        criticalIssues: 0,
        suggestions: ['Add unit tests', 'Consider performance optimization'],
        comments: [
          {
            file: 'src/test.ts',
            line: 10,
            message: 'Consider using const instead of let',
            severity: 'info' as const,
            category: 'style' as const,
          },
        ],
      };

      await reviewer.postReviewComment('owner', 'repo', 1, mockReview);

      expect(mockOctokit.rest.issues.listComments).toHaveBeenCalled();
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        issue_number: 1,
        body: expect.stringContaining('Visor Code Review Results'),
      });

      const callArgs = mockOctokit.rest.issues.createComment.mock.calls[0][0];
      expect(callArgs.body).toContain('Overall Score**: 85/100');
      expect(callArgs.body).toContain('Issues Found**: 3');
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
        overallScore: 60,
        totalIssues: 3,
        criticalIssues: 1,
        suggestions: [],
        comments: [
          {
            file: 'src/error.ts',
            line: 5,
            message: 'Critical security issue',
            severity: 'error' as const,
            category: 'security' as const,
          },
          {
            file: 'src/warning.ts',
            line: 15,
            message: 'Potential performance issue',
            severity: 'warning' as const,
            category: 'performance' as const,
          },
          {
            file: 'src/info.ts',
            line: 25,
            message: 'Style improvement',
            severity: 'info' as const,
            category: 'style' as const,
          },
        ],
      };

      await reviewer.postReviewComment('owner', 'repo', 1, mockReview);

      const callArgs = mockOctokit.rest.issues.createComment.mock.calls[0][0];
      expect(callArgs.body).toContain('**ERROR**: Critical security issue');
      expect(callArgs.body).toContain('**WARNING**: Potential performance issue');
      expect(callArgs.body).toContain('**INFO**: Style improvement');
      expect(callArgs.body).toContain('🔒 Security Review');
      expect(callArgs.body).toContain('📈 Performance Review');
      expect(callArgs.body).toContain('🎨 Style Review');
    });
  });
});
