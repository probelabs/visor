/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
import { CommentManager, RetryConfig } from '../../src/github-comments';

// Mock the Octokit module
jest.mock('@octokit/rest', () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    rest: {
      issues: {
        listComments: jest.fn(),
        createComment: jest.fn(),
        updateComment: jest.fn(),
        getComment: jest.fn(),
      },
    },
  })),
}));

describe('CommentManager', () => {
  let mockOctokit: any;
  let commentManager: CommentManager;

  beforeEach(() => {
    mockOctokit = {
      rest: {
        issues: {
          listComments: jest.fn(),
          createComment: jest.fn(),
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
    };

    const retryConfig: Partial<RetryConfig> = {
      maxRetries: 1,
      baseDelay: 100,
      maxDelay: 500,
      backoffFactor: 2,
    };

    commentManager = new CommentManager(mockOctokit, retryConfig);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('findVisorComment', () => {
    it('should find existing Visor comment by ID', async () => {
      const mockComments = [
        {
          id: 1,
          body: 'Regular comment',
          user: { login: 'user1' },
          created_at: '2023-01-01T00:00:00Z',
          updated_at: '2023-01-01T00:00:00Z',
        },
        {
          id: 2,
          body: '<!-- visor-comment-id:abc123 -->\nVisor review content\n<!-- /visor-comment-id:abc123 -->',
          user: { login: 'visor-bot' },
          created_at: '2023-01-01T00:00:00Z',
          updated_at: '2023-01-01T00:00:00Z',
        },
      ];

      mockOctokit.rest.issues.listComments.mockResolvedValue({
        data: mockComments,
      } as any);

      const result = await commentManager.findVisorComment('owner', 'repo', 123, 'abc123');

      expect(result).toEqual(mockComments[1]);
      expect(mockOctokit.rest.issues.listComments).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        issue_number: 123,
        per_page: 100,
      });
    });

    it('should return null when no Visor comment exists', async () => {
      mockOctokit.rest.issues.listComments.mockResolvedValue({
        data: [
          {
            id: 1,
            body: 'Regular comment',
            user: { login: 'user1' },
            created_at: '2023-01-01T00:00:00Z',
            updated_at: '2023-01-01T00:00:00Z',
          },
        ],
      } as any);

      const result = await commentManager.findVisorComment('owner', 'repo', 123, 'abc123');

      expect(result).toBeNull();
    });

    it('should find any Visor comment when no specific ID provided', async () => {
      const mockComments = [
        {
          id: 1,
          body: 'Regular comment',
          user: { login: 'user1' },
          created_at: '2023-01-01T00:00:00Z',
          updated_at: '2023-01-01T00:00:00Z',
        },
        {
          id: 2,
          body: '<!-- visor-comment-id:xyz789 -->\nAny Visor content\n<!-- /visor-comment-id:xyz789 -->',
          user: { login: 'visor-bot' },
          created_at: '2023-01-01T00:00:00Z',
          updated_at: '2023-01-01T00:00:00Z',
        },
      ];

      mockOctokit.rest.issues.listComments.mockResolvedValue({
        data: mockComments,
      } as any);

      const result = await commentManager.findVisorComment('owner', 'repo', 123);

      expect(result).toEqual(mockComments[1]);
    });

    it('should handle rate limit errors', async () => {
      const rateLimitError = {
        status: 403,
        response: {
          data: { message: 'API rate limit exceeded' },
          headers: { 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 1) },
        },
      };

      mockOctokit.rest.issues.listComments
        .mockRejectedValueOnce(rateLimitError)
        .mockResolvedValueOnce({ data: [] } as any);

      const result = await commentManager.findVisorComment('owner', 'repo', 123);

      expect(result).toBeNull();
      expect(mockOctokit.rest.issues.listComments).toHaveBeenCalledTimes(2);
    });
  });

  describe('updateOrCreateComment', () => {
    it('should create new comment when none exists', async () => {
      mockOctokit.rest.issues.listComments.mockResolvedValue({ data: [] } as any);
      mockOctokit.rest.issues.createComment.mockResolvedValue({
        data: {
          id: 123,
          body: 'New comment',
          user: { login: 'visor-bot' },
          created_at: '2023-01-01T00:00:00Z',
          updated_at: '2023-01-01T00:00:00Z',
        },
      } as any);

      const result = await commentManager.updateOrCreateComment(
        'owner',
        'repo',
        123,
        'Review content',
        { commentId: 'test123', triggeredBy: 'pr_opened' }
      );

      expect(result.id).toBe(123);
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        issue_number: 123,
        body: expect.stringContaining('visor-comment-id:test123'),
      });
    });

    it('should update existing comment', async () => {
      const existingComment = {
        id: 456,
        body: '<!-- visor-comment-id:test123 -->\nOld content\n<!-- /visor-comment-id:test123 -->',
        user: { login: 'visor-bot' },
        created_at: '2023-01-01T00:00:00Z',
        updated_at: '2023-01-01T00:00:00Z',
      };

      mockOctokit.rest.issues.listComments.mockResolvedValue({
        data: [existingComment],
      } as any);

      mockOctokit.rest.issues.getComment.mockResolvedValue({
        data: existingComment,
      } as any);

      mockOctokit.rest.issues.updateComment.mockResolvedValue({
        data: {
          ...existingComment,
          body: 'Updated content',
          updated_at: '2023-01-01T01:00:00Z',
        },
      } as any);

      const result = await commentManager.updateOrCreateComment(
        'owner',
        'repo',
        123,
        'Updated review content',
        { commentId: 'test123', triggeredBy: 'pr_updated' }
      );

      expect(mockOctokit.rest.issues.updateComment).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        comment_id: 456,
        body: expect.stringContaining('Updated review content'),
      });
    });

    it('should detect comment collision', async () => {
      const originalComment = {
        id: 456,
        body: '<!-- visor-comment-id:test123 -->\nOriginal content\n<!-- /visor-comment-id:test123 -->',
        user: { login: 'visor-bot' },
        created_at: '2023-01-01T00:00:00Z',
        updated_at: '2023-01-01T00:00:00Z',
      };

      const modifiedComment = {
        ...originalComment,
        updated_at: '2023-01-01T01:00:00Z', // Different timestamp
      };

      mockOctokit.rest.issues.listComments.mockResolvedValue({
        data: [originalComment],
      } as any);

      mockOctokit.rest.issues.getComment.mockResolvedValue({
        data: modifiedComment,
      } as any);

      await expect(
        commentManager.updateOrCreateComment('owner', 'repo', 123, 'New content', {
          commentId: 'test123',
          allowConcurrentUpdates: false,
        })
      ).rejects.toThrow('Comment collision detected');
    });

    it('should allow concurrent updates when specified', async () => {
      const existingComment = {
        id: 456,
        body: '<!-- visor-comment-id:test123 -->\nOriginal content\n<!-- /visor-comment-id:test123 -->',
        user: { login: 'visor-bot' },
        created_at: '2023-01-01T00:00:00Z',
        updated_at: '2023-01-01T00:00:00Z',
      };

      mockOctokit.rest.issues.listComments.mockResolvedValue({
        data: [existingComment],
      } as any);

      mockOctokit.rest.issues.updateComment.mockResolvedValue({
        data: {
          ...existingComment,
          body: 'Updated content',
        },
      } as any);

      const result = await commentManager.updateOrCreateComment(
        'owner',
        'repo',
        123,
        'New content',
        { commentId: 'test123', allowConcurrentUpdates: true }
      );

      expect(mockOctokit.rest.issues.updateComment).toHaveBeenCalled();
      expect(mockOctokit.rest.issues.getComment).not.toHaveBeenCalled();
    });
  });

  describe('formatCommentWithMetadata', () => {
    it('should format comment with metadata markers', () => {
      const content = 'Review results here';
      const metadata = {
        commentId: 'abc123',
        lastUpdated: '2023-01-01T00:00:00Z',
        triggeredBy: 'pr_opened',
      };

      const result = commentManager.formatCommentWithMetadata(content, metadata);

      expect(result).toContain('visor-comment-id:abc123');
      expect(result).toContain('/visor-comment-id:abc123');
      expect(result).toContain('Last updated: 2023-01-01T00:00:00Z');
      expect(result).toContain('Triggered by: pr_opened');
      expect(result).toContain(content);
    });
  });

  describe('createCollapsibleSection', () => {
    it('should create collapsible section with proper HTML', () => {
      const result = commentManager.createCollapsibleSection('Test Section', 'Content here');

      expect(result).toContain('<details>');
      expect(result).toContain('<summary>Test Section</summary>');
      expect(result).toContain('Content here');
      expect(result).toContain('</details>');
    });

    it('should create expanded section when specified', () => {
      const result = commentManager.createCollapsibleSection('Test Section', 'Content here', true);

      expect(result).toContain('<details open>');
    });
  });

  describe('formatGroupedResults', () => {
    it('should group results by check type', () => {
      const results = [
        { checkType: 'performance', content: 'Performance issues', score: 80, issuesFound: 2 },
        { checkType: 'security', content: 'Security issues', score: 90, issuesFound: 1 },
        { checkType: 'performance', content: 'More performance', score: 70, issuesFound: 3 },
      ];

      const result = commentManager.formatGroupedResults(results, 'check');

      expect(result).toContain('📈 performance Review (Score: 75/100) - 5 issues found');
      expect(result).toContain('🔒 security Review (Score: 90/100) - 1 issues found');
      expect(result).toContain('<details open>'); // Should expand sections with issues
    });

    it('should group results by severity', () => {
      const results = [
        { checkType: 'performance', content: 'Good performance', score: 85, issuesFound: 1 },
        { checkType: 'security', content: 'Critical security', score: 40, issuesFound: 5 },
      ];

      const result = commentManager.formatGroupedResults(results, 'severity');

      expect(result).toContain('👍 Good Review');
      expect(result).toContain('🚨 Critical Issues Review');
    });
  });

  describe('extractCommentId', () => {
    it('should extract comment ID from comment body', () => {
      const body = '<!-- visor-comment-id:abc123 -->\nContent\n<!-- /visor-comment-id:abc123 -->';
      const result = commentManager.extractCommentId(body);

      expect(result).toBe('abc123');
    });

    it('should return null when no comment ID found', () => {
      const body = 'Regular comment without Visor markers';
      const result = commentManager.extractCommentId(body);

      expect(result).toBeNull();
    });
  });
});
