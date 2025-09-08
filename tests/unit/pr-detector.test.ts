import { PRDetector, GitHubEventContext } from '../../src/pr-detector';
import { Octokit } from '@octokit/rest';

// Mock Octokit methods
const mockPullsList = jest.fn();
const mockPullsListCommits = jest.fn();
const mockSearchIssuesAndPullRequests = jest.fn();

// Mock Octokit
const mockOctokit = {
  rest: {
    pulls: {
      list: mockPullsList,
      listCommits: mockPullsListCommits,
    },
    search: {
      issuesAndPullRequests: mockSearchIssuesAndPullRequests,
    },
  },
} as unknown as Octokit;

describe('PRDetector', () => {
  let prDetector: PRDetector;

  beforeEach(() => {
    jest.clearAllMocks();
    mockPullsList.mockClear();
    mockPullsListCommits.mockClear();
    mockSearchIssuesAndPullRequests.mockClear();
    prDetector = new PRDetector(mockOctokit, false);
  });

  describe('detectPRNumber', () => {
    const mockContext: GitHubEventContext = {
      event_name: 'push',
      repository: {
        owner: { login: 'testowner' },
        name: 'testrepo',
      },
      event: {},
      payload: {},
    };

    test('should detect PR from direct pull_request event', async () => {
      const prContext: GitHubEventContext = {
        ...mockContext,
        event_name: 'pull_request',
        event: {
          pull_request: { number: 123 },
          action: 'opened',
        },
      };

      const result = await prDetector.detectPRNumber(prContext, 'testowner', 'testrepo');

      expect(result.prNumber).toBe(123);
      expect(result.confidence).toBe('high');
      expect(result.source).toBe('direct');
    });

    test('should detect PR from issue comment on PR', async () => {
      const commentContext: GitHubEventContext = {
        ...mockContext,
        event_name: 'issue_comment',
        event: {
          issue: {
            number: 456,
            pull_request: {},
          },
          comment: {},
        },
      };

      const result = await prDetector.detectPRNumber(commentContext, 'testowner', 'testrepo');

      expect(result.prNumber).toBe(456);
      expect(result.confidence).toBe('high');
      expect(result.source).toBe('comment');
    });

    test('should detect PR from push event by querying branch', async () => {
      const pushContext: GitHubEventContext = {
        ...mockContext,
        event_name: 'push',
        event: {
          ref: 'refs/heads/feature-branch',
          commits: [{ id: 'abc123' }],
        },
      };

      mockPullsList.mockResolvedValueOnce({
        data: [{ number: 789, head: { ref: 'feature-branch' } }],
      });

      const result = await prDetector.detectPRNumber(pushContext, 'testowner', 'testrepo');

      expect(result.prNumber).toBe(789);
      expect(result.confidence).toBe('high');
      expect(result.source).toBe('api_query');
      expect(mockPullsList).toHaveBeenCalledWith({
        owner: 'testowner',
        repo: 'testrepo',
        head: 'testowner:feature-branch',
        state: 'open',
      });
    });

    test('should return null when no PR is found', async () => {
      const noprContext: GitHubEventContext = {
        ...mockContext,
        event_name: 'push',
        event: {
          ref: 'refs/heads/main',
        },
      };

      mockPullsList.mockResolvedValue({ data: [] });
      mockSearchIssuesAndPullRequests.mockResolvedValue({
        data: { items: [] },
      });

      const result = await prDetector.detectPRNumber(noprContext, 'testowner', 'testrepo');

      expect(result.prNumber).toBeNull();
      expect(result.confidence).toBe('low');
    });

    test('should handle errors gracefully', async () => {
      const errorContext: GitHubEventContext = {
        ...mockContext,
        event_name: 'push',
        event: {
          ref: 'refs/heads/feature-branch',
        },
      };

      mockPullsList.mockRejectedValue(new Error('API Error'));

      const result = await prDetector.detectPRNumber(errorContext, 'testowner', 'testrepo');

      expect(result.prNumber).toBeNull();
      expect(result.confidence).toBe('low');
      expect(result.details).toContain('No PR found for push event');
    });

    test('should search by commit SHA when available', async () => {
      const commitContext: GitHubEventContext = {
        ...mockContext,
        event_name: 'push',
        event: {
          head_commit: { id: 'commit123' },
          commits: [{ id: 'commit123' }],
        },
      };

      mockPullsList.mockResolvedValue({ data: [] });
      mockSearchIssuesAndPullRequests.mockResolvedValue({
        data: {
          items: [
            {
              number: 999,
              pull_request: {},
            },
          ],
        },
      });

      const result = await prDetector.detectPRNumber(commitContext, 'testowner', 'testrepo');

      expect(result.prNumber).toBe(999);
      expect(result.source).toBe('api_query');
      expect(mockSearchIssuesAndPullRequests).toHaveBeenCalledWith({
        q: 'repo:testowner/testrepo type:pr commit123',
        sort: 'updated',
        order: 'desc',
        per_page: 10,
      });
    });
  });

  describe('getDetectionStrategies', () => {
    test('should return list of detection strategies', () => {
      const strategies = prDetector.getDetectionStrategies();

      expect(strategies).toHaveLength(5);
      expect(strategies[0]).toContain('Direct PR event detection');
      expect(strategies[1]).toContain('Issue comment PR detection');
      expect(strategies[2]).toContain('Push event PR detection');
      expect(strategies[3]).toContain('Branch-based PR search');
      expect(strategies[4]).toContain('Commit-based PR search');
    });
  });
});