/* eslint-disable @typescript-eslint/no-explicit-any */
import { PRAnalyzer } from '../../src/pr-analyzer';

// Mock Octokit
const mockOctokit = {
  rest: {
    pulls: {
      get: jest.fn(),
      listFiles: jest.fn(),
    },
    repos: {
      getCommit: jest.fn(),
    },
    issues: {
      listComments: jest.fn(),
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

describe('PRAnalyzer', () => {
  let analyzer: PRAnalyzer;

  beforeEach(() => {
    analyzer = new PRAnalyzer(mockOctokit);
    jest.clearAllMocks();
  });

  describe('fetchPRDiff', () => {
    test('should fetch PR information and files', async () => {
      const mockPRData = {
        data: {
          number: 1,
          title: 'Test PR',
          body: 'This is a test PR',
          user: { login: 'test-user' },
          base: { ref: 'main' },
          head: { ref: 'feature-branch' },
        },
      };

      const mockFilesData = {
        data: [
          {
            filename: 'src/test.ts',
            additions: 50,
            deletions: 10,
            changes: 60,
            patch:
              '@@ -1,3 +1,4 @@\n function test() {\n+  console.log("new line");\n   return true;\n }',
            status: 'modified',
          },
          {
            filename: 'src/new.ts',
            additions: 25,
            deletions: 0,
            changes: 25,
            patch: '@@ -0,0 +1,5 @@\n+export function newFunction() {\n+  return "hello";\n+}',
            status: 'added',
          },
        ],
      };

      mockOctokit.rest.pulls.get.mockResolvedValue(mockPRData);
      mockOctokit.rest.pulls.listFiles.mockResolvedValue(mockFilesData);

      const result = await analyzer.fetchPRDiff('owner', 'repo', 1);

      expect(result).toEqual({
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
            patch: expect.any(String),
            status: 'modified',
          },
          {
            filename: 'src/new.ts',
            additions: 25,
            deletions: 0,
            changes: 25,
            patch: expect.any(String),
            status: 'added',
          },
        ],
        totalAdditions: 75,
        totalDeletions: 10,
        fullDiff: expect.stringContaining('--- src/test.ts'),
        isIncremental: false,
      });

      expect(mockOctokit.rest.pulls.get).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        pull_number: 1,
      });

      expect(mockOctokit.rest.pulls.listFiles).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        pull_number: 1,
      });
    });

    test('should handle PR without body', async () => {
      const mockPRData = {
        data: {
          number: 2,
          title: 'Test PR',
          body: null,
          user: { login: 'test-user' },
          base: { ref: 'main' },
          head: { ref: 'feature-branch' },
        },
      };

      const mockFilesData = { data: [] };

      mockOctokit.rest.pulls.get.mockResolvedValue(mockPRData);
      mockOctokit.rest.pulls.listFiles.mockResolvedValue(mockFilesData);

      const result = await analyzer.fetchPRDiff('owner', 'repo', 2);

      expect(result.body).toBe('');
    });

    test('should handle PR without user', async () => {
      const mockPRData = {
        data: {
          number: 3,
          title: 'Test PR',
          body: 'Test body',
          user: null,
          base: { ref: 'main' },
          head: { ref: 'feature-branch' },
        },
      };

      const mockFilesData = { data: [] };

      mockOctokit.rest.pulls.get.mockResolvedValue(mockPRData);
      mockOctokit.rest.pulls.listFiles.mockResolvedValue(mockFilesData);

      const result = await analyzer.fetchPRDiff('owner', 'repo', 3);

      expect(result.author).toBe('unknown');
    });
  });

  describe('fetchPRComments', () => {
    test('should fetch PR comments', async () => {
      const mockCommentsData = {
        data: [
          {
            id: 1,
            body: 'First comment',
            user: { login: 'user1' },
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
          },
          {
            id: 2,
            body: 'Second comment',
            user: { login: 'user2' },
            created_at: '2024-01-01T01:00:00Z',
            updated_at: '2024-01-01T01:00:00Z',
          },
        ],
      };

      mockOctokit.rest.issues.listComments.mockResolvedValue(mockCommentsData);

      const result = await analyzer.fetchPRComments('owner', 'repo', 1);

      expect(result).toEqual([
        {
          id: 1,
          author: 'user1',
          body: 'First comment',
          createdAt: '2024-01-01T00:00:00Z',
          updatedAt: '2024-01-01T00:00:00Z',
        },
        {
          id: 2,
          author: 'user2',
          body: 'Second comment',
          createdAt: '2024-01-01T01:00:00Z',
          updatedAt: '2024-01-01T01:00:00Z',
        },
      ]);

      expect(mockOctokit.rest.issues.listComments).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        issue_number: 1,
      });
    });

    test('should handle comments without user or body', async () => {
      const mockCommentsData = {
        data: [
          {
            id: 1,
            body: null,
            user: null,
            created_at: '2024-01-01T00:00:00Z',
            updated_at: '2024-01-01T00:00:00Z',
          },
        ],
      };

      mockOctokit.rest.issues.listComments.mockResolvedValue(mockCommentsData);

      const result = await analyzer.fetchPRComments('owner', 'repo', 1);

      expect(result[0].author).toBe('unknown');
      expect(result[0].body).toBe('');
    });
  });

  describe('fetchCommitDiff', () => {
    test('should fetch commit diff for incremental analysis', async () => {
      const mockCommitData = {
        data: {
          sha: 'abc123',
          files: [
            {
              filename: 'src/updated.ts',
              patch:
                '@@ -1,3 +1,4 @@\n function updated() {\n+  console.log("updated");\n   return true;\n }',
            },
            {
              filename: 'src/new.ts',
              patch: '@@ -0,0 +1,3 @@\n+export function newFunc() {\n+  return "new";\n+}',
            },
          ],
        },
      };

      mockOctokit.rest.repos.getCommit.mockResolvedValue(mockCommitData);

      const result = await analyzer.fetchCommitDiff('owner', 'repo', 'abc123');

      expect(result).toContain('--- src/updated.ts');
      expect(result).toContain('--- src/new.ts');
      expect(result).toContain('console.log("updated")');
      expect(result).toContain('export function newFunc()');

      expect(mockOctokit.rest.repos.getCommit).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        ref: 'abc123',
      });
    });

    test('should handle commit with no files', async () => {
      const mockCommitData = {
        data: {
          sha: 'abc123',
          files: [],
        },
      };

      mockOctokit.rest.repos.getCommit.mockResolvedValue(mockCommitData);

      const result = await analyzer.fetchCommitDiff('owner', 'repo', 'abc123');

      expect(result).toBe('');
    });

    test('should handle commit fetch error gracefully', async () => {
      mockOctokit.rest.repos.getCommit.mockRejectedValue(new Error('Commit not found'));

      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

      const result = await analyzer.fetchCommitDiff('owner', 'repo', 'invalid');

      expect(result).toBe('');
      expect(consoleSpy).toHaveBeenCalledWith(
        'Failed to fetch commit diff for invalid:',
        expect.any(Error)
      );

      consoleSpy.mockRestore();
    });
  });

  describe('fetchPRDiff with commit SHA', () => {
    test('should include commit diff when commit SHA is provided', async () => {
      const mockPRData = {
        data: {
          number: 1,
          title: 'Test PR',
          body: 'This is a test PR',
          user: { login: 'test-user' },
          base: { ref: 'main' },
          head: { ref: 'feature-branch' },
        },
      };

      const mockFilesData = {
        data: [
          {
            filename: 'src/test.ts',
            additions: 10,
            deletions: 5,
            changes: 15,
            patch: '@@ -1,3 +1,3 @@\n function test() {\n-  return false;\n+  return true;\n }',
            status: 'modified',
          },
        ],
      };

      const mockCommitData = {
        data: {
          sha: 'commit123',
          files: [
            {
              filename: 'src/test.ts',
              patch: '@@ -2,1 +2,1 @@\n-  return false;\n+  return true;',
            },
          ],
        },
      };

      mockOctokit.rest.pulls.get.mockResolvedValue(mockPRData);
      mockOctokit.rest.pulls.listFiles.mockResolvedValue(mockFilesData);
      mockOctokit.rest.repos.getCommit.mockResolvedValue(mockCommitData);

      const result = await analyzer.fetchPRDiff('owner', 'repo', 1, 'commit123');

      expect(result).toEqual(
        expect.objectContaining({
          number: 1,
          title: 'Test PR',
          fullDiff: expect.stringContaining('--- src/test.ts'),
          commitDiff: expect.stringContaining('--- src/test.ts'),
          isIncremental: true,
        })
      );

      expect(result.commitDiff).toContain('return true');
      expect(mockOctokit.rest.repos.getCommit).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        ref: 'commit123',
      });
    });

    test('should work without commit SHA', async () => {
      const mockPRData = {
        data: {
          number: 1,
          title: 'Test PR',
          body: 'This is a test PR',
          user: { login: 'test-user' },
          base: { ref: 'main' },
          head: { ref: 'feature-branch' },
        },
      };

      const mockFilesData = { data: [] };

      mockOctokit.rest.pulls.get.mockResolvedValue(mockPRData);
      mockOctokit.rest.pulls.listFiles.mockResolvedValue(mockFilesData);

      const result = await analyzer.fetchPRDiff('owner', 'repo', 1);

      expect(result).toEqual(
        expect.objectContaining({
          number: 1,
          title: 'Test PR',
          fullDiff: '',
          isIncremental: false,
        })
      );

      expect(result).not.toHaveProperty('commitDiff');
      expect(mockOctokit.rest.repos.getCommit).not.toHaveBeenCalled();
    });
  });
});
