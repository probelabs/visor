/* eslint-disable @typescript-eslint/no-explicit-any */
import { PRAnalyzer } from '../../src/pr-analyzer';
import { PRReviewer } from '../../src/reviewer';
import { CommentManager } from '../../src/github-comments';
import { AIReviewService } from '../../src/ai-review-service';

// Mock CheckExecutionEngine
jest.mock('../../src/check-execution-engine', () => {
  return {
    CheckExecutionEngine: jest.fn().mockImplementation(() => ({
      executeReviewChecks: jest
        .fn()
        .mockImplementation(async (_prInfo, _checks, _unused1, _config, _unused2, _debug) => {
          return {
            issues: [
              {
                file: 'src/test.ts',
                line: 10,
                ruleId: 'security/hardcoded-secret',
                message: 'Potential hardcoded API key detected',
                severity: 'critical',
                category: 'security',
                suggestion: 'Use environment variables for API keys',
              },
              {
                file: 'src/test.ts',
                line: 25,
                ruleId: 'performance/inefficient-loop',
                message: 'Consider using a more efficient data structure',
                severity: 'warning',
                category: 'performance',
              },
            ],
            suggestions: [
              'Consider adding input validation',
              'Add unit tests for new functionality',
            ],
          };
        }),
      executeGroupedChecks: jest
        .fn()
        .mockImplementation(async (_prInfo, _checks, _unused1, _config, _unused2, _debug) => {
          // Return ExecutionResult format
          return {
            results: {
              default: [
                {
                  checkName: 'security-review',
                  content: `## Security Issues Found\n\n- **CRITICAL**: Potential hardcoded API key detected (src/test.ts:10)\n- **WARNING**: Consider using a more efficient data structure (src/test.ts:25)\n\n## Suggestions\n\n- Consider adding input validation\n- Add unit tests for new functionality`,
                  group: 'default',
                  debug: {
                    provider: 'google',
                    model: 'gemini-2.0-flash-exp',
                    processingTime: 1500,
                    apiKeySource: 'environment',
                    prompt: 'Mocked prompt',
                    rawResponse: 'Mocked response',
                    promptLength: 100,
                    responseLength: 200,
                    jsonParseSuccess: true,
                    errors: [],
                    timestamp: new Date().toISOString(),
                  },
                },
              ],
            },
            statistics: {
              totalChecksConfigured: _checks.length,
              totalExecutions: _checks.length,
              successfulExecutions: _checks.length,
              failedExecutions: 0,
              skippedChecks: 0,
              totalDuration: 0,
              checks: [],
            },
          };
        }),
    })),
  };
});

// Mock environment variables
const originalEnv = process.env;

beforeEach(() => {
  jest.resetModules();
  process.env = {
    ...originalEnv,
    GOOGLE_API_KEY: 'test-api-key',
    MODEL_NAME: 'gemini-2.0-flash-exp',
  };
});

afterEach(() => {
  process.env = originalEnv;
});

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
} as any;

// Mock AI service to avoid actual API calls
jest.mock('../../src/ai-review-service', () => {
  return {
    AIReviewService: jest.fn().mockImplementation(() => ({
      executeReview: jest.fn().mockResolvedValue({
        issues: [
          {
            file: 'src/test.ts',
            line: 10,
            ruleId: 'security/hardcoded-secret',
            message: 'Potential hardcoded API key detected',
            severity: 'critical',
            category: 'security',
            suggestion: 'Use environment variables for API keys',
          },
          {
            file: 'src/test.ts',
            line: 25,
            ruleId: 'performance/inefficient-loop',
            message: 'Consider using a more efficient data structure',
            severity: 'warning',
            category: 'performance',
          },
        ],
      }),
    })),
  };
});

describe('GitHub PR Workflow Integration', () => {
  let analyzer: PRAnalyzer;
  let reviewer: PRReviewer;
  let commentManager: CommentManager;

  beforeEach(() => {
    analyzer = new PRAnalyzer(mockOctokit);
    reviewer = new PRReviewer(mockOctokit);
    commentManager = new CommentManager(mockOctokit);
    jest.clearAllMocks();
  });

  describe('PR Opened Event', () => {
    test('should create initial PR review comment with full analysis', async () => {
      // Mock PR data
      const mockPRData = {
        data: {
          number: 123,
          title: 'Add user authentication system',
          body: 'This PR adds JWT-based authentication with role-based access control.',
          user: { login: 'dev-user' },
          base: { ref: 'main' },
          head: { ref: 'feature/auth-system' },
        },
      };

      const mockFilesData = {
        data: [
          {
            filename: 'src/auth.ts',
            additions: 120,
            deletions: 5,
            changes: 125,
            patch: `@@ -1,3 +1,10 @@
+import jwt from 'jsonwebtoken';
+
+const API_KEY = 'hardcoded-secret-123'; // This should be flagged
+
 export class AuthService {
-  // TODO: implement
+  public generateToken(userId: string): string {
+    return jwt.sign({ userId }, API_KEY, { expiresIn: '1h' });
+  }
 }`,
            status: 'modified',
          },
          {
            filename: 'src/middleware/auth.ts',
            additions: 85,
            deletions: 0,
            changes: 85,
            patch: `@@ -0,0 +1,20 @@
+export function authMiddleware(req: Request, res: Response, next: NextFunction) {
+  const token = req.headers.authorization?.split(' ')[1];
+  
+  if (!token) {
+    return res.status(401).json({ error: 'No token provided' });
+  }
+  
+  // Verify token logic here
+  next();
+}`,
            status: 'added',
          },
        ],
      };

      mockOctokit.rest.pulls.get.mockResolvedValue(mockPRData);
      mockOctokit.rest.pulls.listFiles.mockResolvedValue(mockFilesData);
      mockOctokit.rest.issues.listComments.mockResolvedValue({ data: [] });
      mockOctokit.rest.issues.createComment.mockResolvedValue({
        data: { id: 456, body: 'Review comment', user: { login: 'visor-bot' } },
      });

      // Simulate PR opened workflow
      const prInfo = await analyzer.fetchPRDiff('owner', 'repo', 123);

      // Verify PR info structure with XML data
      expect(prInfo).toEqual(
        expect.objectContaining({
          number: 123,
          title: 'Add user authentication system',
          body: 'This PR adds JWT-based authentication with role-based access control.',
          author: 'dev-user',
          base: 'main',
          head: 'feature/auth-system',
          totalAdditions: 205,
          totalDeletions: 5,
          fullDiff: expect.stringContaining('hardcoded-secret-123'),
        })
      );

      // Perform review
      const mockConfig = {
        checks: {
          'security-review': {
            provider: 'ai',
            prompt: 'Review this code for security issues',
          },
        },
      };

      const review = await reviewer.reviewPR('owner', 'repo', 123, prInfo, {
        config: mockConfig as any,
        checks: ['security-review'],
        parallelExecution: false,
      });

      // Verify review structure (new GroupedCheckResults format)
      expect(review).toEqual(
        expect.objectContaining({
          default: expect.arrayContaining([
            expect.objectContaining({
              checkName: 'security-review',
              content: expect.stringContaining('Security Issues Found'),
              group: 'default',
            }),
          ]),
        })
      );

      // Create comment using smart comment manager
      const commentId = 'pr-review-123';
      await commentManager.updateOrCreateComment('owner', 'repo', 123, 'Review content', {
        commentId,
        triggeredBy: 'opened',
      });

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        issue_number: 123,
        body: expect.stringContaining('visor-comment-id:pr-review-123'),
      });
    });
  });

  describe('PR Synchronize Event (New Commit)', () => {
    test('should update existing comment with incremental analysis', async () => {
      // Mock PR data
      const mockPRData = {
        data: {
          number: 123,
          title: 'Add user authentication system',
          body: 'Updated: Fixed security issues and added tests.',
          user: { login: 'dev-user' },
          base: { ref: 'main' },
          head: { ref: 'feature/auth-system', sha: 'new-commit-abc123' },
        },
      };

      const mockFilesData = {
        data: [
          {
            filename: 'src/auth.ts',
            additions: 125,
            deletions: 8,
            changes: 133,
            patch: `@@ -1,10 +1,12 @@
 import jwt from 'jsonwebtoken';
 
-const API_KEY = 'hardcoded-secret-123';
+const API_KEY = process.env.JWT_SECRET || 'default-secret';
 
 export class AuthService {
   public generateToken(userId: string): string {
+    if (!userId) throw new Error('User ID is required');
     return jwt.sign({ userId }, API_KEY, { expiresIn: '1h' });
   }
 }`,
            status: 'modified',
          },
        ],
      };

      // Mock incremental commit diff
      const mockCommitData = {
        data: {
          sha: 'new-commit-abc123',
          files: [
            {
              filename: 'src/auth.ts',
              patch: `@@ -3,1 +3,1 @@
-const API_KEY = 'hardcoded-secret-123';
+const API_KEY = process.env.JWT_SECRET || 'default-secret';
@@ -6,0 +6,1 @@
+    if (!userId) throw new Error('User ID is required');`,
            },
            {
              filename: 'tests/auth.test.ts',
              patch: `@@ -0,0 +1,15 @@
+import { AuthService } from '../src/auth';
+
+describe('AuthService', () => {
+  test('should generate valid JWT token', () => {
+    const authService = new AuthService();
+    const token = authService.generateToken('user123');
+    expect(token).toBeTruthy();
+  });
+});`,
            },
          ],
        },
      };

      // Mock existing comment
      const existingComment = {
        id: 456,
        body: '<!-- visor-comment-id:pr-review-123 -->\nPrevious review content\n<!-- /visor-comment-id:pr-review-123 -->',
        user: { login: 'visor-bot' },
        created_at: '2023-01-01T00:00:00Z',
        updated_at: '2023-01-01T00:00:00Z',
      };

      mockOctokit.rest.pulls.get.mockResolvedValue(mockPRData);
      mockOctokit.rest.pulls.listFiles.mockResolvedValue(mockFilesData);
      mockOctokit.rest.repos.getCommit.mockResolvedValue(mockCommitData);
      mockOctokit.rest.issues.listComments.mockResolvedValue({ data: [existingComment] });
      mockOctokit.rest.issues.getComment.mockResolvedValue({ data: existingComment });
      mockOctokit.rest.issues.updateComment.mockResolvedValue({
        data: { ...existingComment, body: 'Updated review content' },
      });

      // Simulate PR synchronize workflow with commit SHA
      const prInfo = await analyzer.fetchPRDiff('owner', 'repo', 123, 'new-commit-abc123');

      // Verify incremental analysis data
      expect(prInfo).toEqual(
        expect.objectContaining({
          number: 123,
          fullDiff: expect.stringContaining('JWT_SECRET'),
          commitDiff: expect.stringContaining('hardcoded-secret-123'),
          isIncremental: true,
        })
      );

      expect(prInfo.commitDiff).toContain('tests/auth.test.ts');
      expect(prInfo.commitDiff).toContain('AuthService');

      // Perform review with incremental data
      const mockConfig = {
        checks: {
          'incremental-review': {
            provider: 'ai',
            prompt: 'Review this incremental code change',
          },
        },
      };

      await reviewer.reviewPR('owner', 'repo', 123, prInfo, {
        config: mockConfig as any,
        checks: ['incremental-review'],
        parallelExecution: false,
      });

      // Update existing comment
      const commentId = 'pr-review-123';
      await commentManager.updateOrCreateComment('owner', 'repo', 123, 'Updated review', {
        commentId,
        triggeredBy: 'synchronize',
        allowConcurrentUpdates: true,
      });

      expect(mockOctokit.rest.issues.updateComment).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        comment_id: 456,
        body: expect.stringContaining('visor-comment-id:pr-review-123'),
      });

      expect(mockOctokit.rest.repos.getCommit).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        ref: 'new-commit-abc123',
      });
    });
  });

  describe('AI Service Integration with XML Format', () => {
    test('should create AI service with correct configuration', async () => {
      const mockAIService = new AIReviewService({
        apiKey: 'test-key',
        model: 'gemini-2.0-flash-exp',
        provider: 'google',
      });

      expect(mockAIService).toBeDefined();
      expect(typeof mockAIService.executeReview).toBe('function');
    });

    test('should handle PR data with incremental commit diff', async () => {
      const testPRInfo = {
        number: 123,
        title: 'Test & Special <chars> in title',
        body: 'Description with "quotes" and <tags>',
        author: 'test-user',
        base: 'main',
        head: 'feature/test',
        files: [
          {
            filename: 'src/test.ts',
            additions: 10,
            deletions: 2,
            changes: 12,
            patch:
              '@@ -1,3 +1,4 @@\n+console.log("test");\n function test() {\n   return true;\n }',
            status: 'modified' as const,
          },
        ],
        totalAdditions: 10,
        totalDeletions: 2,
        fullDiff:
          '--- src/test.ts\n@@ -1,3 +1,4 @@\n+console.log("test");\n function test() {\n   return true;\n }',
        commitDiff: '--- src/test.ts\n@@ -2,0 +2,1 @@\n+console.log("new change");',
        isIncremental: true,
      };

      // Verify that PRInfo structure supports both full and incremental analysis
      expect(testPRInfo.fullDiff).toBeDefined();
      expect(testPRInfo.commitDiff).toBeDefined();
      expect(testPRInfo.fullDiff).toContain('src/test.ts');
      expect(testPRInfo.commitDiff).toContain('new change');
    });

    test('should handle PR data without commit diff for full analysis', async () => {
      const testPRInfo = {
        number: 123,
        title: 'Full PR Review',
        body: 'Complete analysis',
        author: 'test-user',
        base: 'main',
        head: 'feature/full',
        files: [],
        totalAdditions: 50,
        totalDeletions: 10,
        fullDiff:
          '--- src/app.ts\n+++ src/app.ts\n@@ -1,3 +1,5 @@\n+import express from "express";\n+const app = express();\n function main() {\n   console.log("Hello");\n }',
        isIncremental: false,
      };

      // Verify that PRInfo structure supports full analysis without commit diff
      expect(testPRInfo.fullDiff).toBeDefined();
      expect('commitDiff' in testPRInfo).toBeFalsy();
      expect(testPRInfo.fullDiff).toContain('express');
    });
  });

  describe('Error Handling and Fallbacks', () => {
    test('should handle comment update failures gracefully', async () => {
      const commentManager = new CommentManager(mockOctokit);

      // Mock comment update failure
      mockOctokit.rest.issues.listComments.mockResolvedValue({ data: [] });
      mockOctokit.rest.issues.createComment.mockRejectedValue(new Error('API rate limit exceeded'));

      // Should not throw an error, but handle it gracefully
      await expect(
        commentManager.updateOrCreateComment('owner', 'repo', 123, 'content', {
          commentId: 'test-123',
        })
      ).rejects.toThrow('API rate limit exceeded');
    });

    test('should handle commit diff fetch failures', async () => {
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation();

      mockOctokit.rest.repos.getCommit.mockRejectedValue(new Error('Commit not found'));

      const result = await analyzer.fetchCommitDiff('owner', 'repo', 'nonexistent-sha');

      expect(result).toBe('');
      expect(consoleSpy).toHaveBeenCalledWith(
        'Failed to fetch commit diff for nonexistent-sha:',
        expect.any(Error)
      );

      consoleSpy.mockRestore();
    });

    test('should handle malformed PR data', async () => {
      const malformedPRData = {
        data: {
          number: null,
          title: null,
          body: null,
          user: null,
          base: null,
          head: null,
        },
      };

      mockOctokit.rest.pulls.get.mockResolvedValue(malformedPRData);
      mockOctokit.rest.pulls.listFiles.mockResolvedValue({ data: [] });

      const result = await analyzer.fetchPRDiff('owner', 'repo', 1);

      expect(result).toEqual(
        expect.objectContaining({
          number: 1,
          title: 'MISSING',
          body: '',
          author: 'unknown',
          base: 'main',
          head: 'feature',
          files: [],
          totalAdditions: 0,
          totalDeletions: 0,
          fullDiff: '',
        })
      );
    });
  });
});
