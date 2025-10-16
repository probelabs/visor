/* eslint-disable @typescript-eslint/no-explicit-any */
import { PRReviewer, GroupedCheckResults } from '../../src/reviewer';
import { VisorConfig } from '../../src/types/config';

// Helper to create minimal config for testing
function createTestConfig(checks: VisorConfig['checks']): VisorConfig {
  return {
    version: '1.0',
    checks,
    output: {
      pr_comment: {
        enabled: true,
        format: 'markdown',
        group_by: 'check',
        collapse: false,
      },
    },
  } as VisorConfig;
}

describe('GitHub Comment Generation E2E', () => {
  let mockOctokit: any;
  let reviewer: PRReviewer;

  beforeEach(() => {
    mockOctokit = {
      rest: {
        issues: {
          createComment: jest.fn().mockResolvedValue({
            data: {
              id: 123,
              body: 'Test comment',
              user: { login: 'visor-bot' },
              created_at: '2023-01-01T00:00:00Z',
              updated_at: '2023-01-01T00:00:00Z',
            },
          }),
          listComments: jest.fn().mockResolvedValue({ data: [] }),
          updateComment: jest.fn(),
          getComment: jest.fn(),
        },
      },
      request: jest.fn().mockResolvedValue({ data: {} }),
    };

    reviewer = new PRReviewer(mockOctokit);
    jest.clearAllMocks();
  });

  describe('code-review schema', () => {
    test('should generate GitHub comments for AI checks with code-review schema', async () => {
      const config = createTestConfig({
        'security-review': {
          type: 'ai',
          prompt: 'Review code for security issues',
          schema: 'code-review',
        },
      });

      const groupedResults: GroupedCheckResults = {
        default: [
          {
            checkName: 'security-review',
            content: `## Security Review

Found 2 security issues:
- SQL injection in src/db.ts:10
- XSS vulnerability in src/view.ts:20`,
            group: 'default',
          },
        ],
      };

      await reviewer.postReviewComment('owner', 'repo', 123, groupedResults, {
        config,
      });

      // Should create a comment since code-review schema generates comments
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(1);

      const call = mockOctokit.rest.issues.createComment.mock.calls[0][0];
      expect(call.body).toContain('Security Review');
      expect(call.body).toContain('SQL injection');
      expect(call.body).toContain('XSS vulnerability');
    });

    test('should generate GitHub comments for AI checks without schema', async () => {
      const config = createTestConfig({
        'general-review': {
          type: 'ai',
          prompt: 'Review code',
          // No schema specified - should default to generating comments
        },
      });

      const groupedResults: GroupedCheckResults = {
        default: [
          {
            checkName: 'general-review',
            content: `## General Review

Code looks good overall.`,
            group: 'default',
          },
        ],
      };

      await reviewer.postReviewComment('owner', 'repo', 123, groupedResults, {
        config,
      });

      // Should create a comment since AI checks without schema generate comments
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(1);

      const call = mockOctokit.rest.issues.createComment.mock.calls[0][0];
      expect(call.body).toContain('General Review');
    });

    test('should generate GitHub comments for claude-code checks with code-review schema', async () => {
      const config = createTestConfig({
        'advanced-review': {
          type: 'claude-code',
          prompt: 'Perform advanced code review',
          schema: 'code-review',
        },
      });

      const groupedResults: GroupedCheckResults = {
        default: [
          {
            checkName: 'advanced-review',
            content: `## Advanced Review

Detailed analysis results here.`,
            group: 'default',
          },
        ],
      };

      await reviewer.postReviewComment('owner', 'repo', 123, groupedResults, {
        config,
      });

      // Should create a comment
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
    });
  });

  describe('overview schema', () => {
    test('should generate GitHub comments for checks with overview schema', async () => {
      const config = createTestConfig({
        'pr-overview': {
          type: 'ai',
          prompt: 'Generate PR overview',
          schema: 'overview',
        },
      });

      const groupedResults: GroupedCheckResults = {
        default: [
          {
            checkName: 'pr-overview',
            content: `## PR Overview

This PR adds new features.`,
            group: 'default',
          },
        ],
      };

      await reviewer.postReviewComment('owner', 'repo', 123, groupedResults, {
        config,
      });

      // Should create a comment since overview schema has a text field
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(1);

      const call = mockOctokit.rest.issues.createComment.mock.calls[0][0];
      expect(call.body).toContain('PR Overview');
    });
  });

  describe('plain/text schemas', () => {
    test('should generate GitHub comments for checks with plain schema', async () => {
      const config = createTestConfig({
        'plain-check': {
          type: 'ai',
          prompt: 'Plain text analysis',
          schema: 'plain',
        },
      });

      const groupedResults: GroupedCheckResults = {
        default: [
          {
            checkName: 'plain-check',
            content: 'Plain text analysis results',
            group: 'default',
          },
        ],
      };

      await reviewer.postReviewComment('owner', 'repo', 123, groupedResults, {
        config,
      });

      // Should create a comment
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
    });

    test('should generate GitHub comments for checks with text schema', async () => {
      const config = createTestConfig({
        'text-check': {
          type: 'ai',
          prompt: 'Text analysis',
          schema: 'text',
        },
      });

      const groupedResults: GroupedCheckResults = {
        default: [
          {
            checkName: 'text-check',
            content: 'Text analysis results',
            group: 'default',
          },
        ],
      };

      await reviewer.postReviewComment('owner', 'repo', 123, groupedResults, {
        config,
      });

      // Should create a comment
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
    });
  });

  describe('non-comment-generating checks', () => {
    test('should NOT generate GitHub comments for command checks without schema', async () => {
      const config = createTestConfig({
        'run-tests': {
          type: 'command',
          command: 'npm test',
          // No schema - command checks are for orchestration only
        },
      });

      const groupedResults: GroupedCheckResults = {
        default: [
          {
            checkName: 'run-tests',
            content: 'Tests passed successfully',
            group: 'default',
          },
        ],
      };

      await reviewer.postReviewComment('owner', 'repo', 123, groupedResults, {
        config,
      });

      // Should NOT create a comment since command checks without schema are for orchestration
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    test('should NOT generate GitHub comments for http checks without comment-generating schema', async () => {
      const config = createTestConfig({
        'webhook-notify': {
          type: 'http',
          url: 'https://example.com/webhook',
          method: 'POST',
          // No schema - http checks are for external notifications
        },
      });

      const groupedResults: GroupedCheckResults = {
        default: [
          {
            checkName: 'webhook-notify',
            content: 'Webhook sent successfully',
            group: 'default',
          },
        ],
      };

      await reviewer.postReviewComment('owner', 'repo', 123, groupedResults, {
        config,
      });

      // Should NOT create a comment
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    test('should NOT generate GitHub comments for checks with custom non-text schema', async () => {
      const config = createTestConfig({
        'metrics-check': {
          type: 'ai',
          prompt: 'Calculate metrics',
          schema: {
            type: 'object',
            properties: {
              metrics: { type: 'object' },
              score: { type: 'number' },
            },
            // No text field - just structured data
          },
        },
      });

      const groupedResults: GroupedCheckResults = {
        default: [
          {
            checkName: 'metrics-check',
            content: 'Metrics calculated',
            group: 'default',
            output: { metrics: { loc: 100 }, score: 85 },
          },
        ],
      };

      await reviewer.postReviewComment('owner', 'repo', 123, groupedResults, {
        config,
      });

      // Should NOT create a comment since schema has no text field
      expect(mockOctokit.rest.issues.createComment).not.toHaveBeenCalled();
    });

    test('SHOULD generate GitHub comments for checks with custom schema containing text field', async () => {
      const config = createTestConfig({
        'custom-review': {
          type: 'ai',
          prompt: 'Custom review',
          schema: {
            type: 'object',
            properties: {
              text: { type: 'string' },
              metadata: { type: 'object' },
            },
          },
        },
      });

      const groupedResults: GroupedCheckResults = {
        default: [
          {
            checkName: 'custom-review',
            content: 'Custom review results',
            group: 'default',
          },
        ],
      };

      await reviewer.postReviewComment('owner', 'repo', 123, groupedResults, {
        config,
      });

      // SHOULD create a comment since schema has a text field
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(1);
    });
  });

  describe('multiple checks mixed', () => {
    test('should only generate comments for comment-generating checks', async () => {
      const config = createTestConfig({
        'security-review': {
          type: 'ai',
          prompt: 'Security review',
          schema: 'code-review',
        },
        'run-tests': {
          type: 'command',
          command: 'npm test',
        },
        'pr-overview': {
          type: 'ai',
          prompt: 'PR overview',
          schema: 'overview',
        },
        'webhook-notify': {
          type: 'http',
          url: 'https://example.com',
          method: 'POST',
        },
      });

      const groupedResults: GroupedCheckResults = {
        default: [
          {
            checkName: 'security-review',
            content: 'Security issues found',
            group: 'default',
          },
          {
            checkName: 'run-tests',
            content: 'Tests passed',
            group: 'default',
          },
          {
            checkName: 'pr-overview',
            content: 'PR looks good',
            group: 'default',
          },
          {
            checkName: 'webhook-notify',
            content: 'Webhook sent',
            group: 'default',
          },
        ],
      };

      await reviewer.postReviewComment('owner', 'repo', 123, groupedResults, {
        config,
      });

      // Should create exactly 1 comment with only the comment-generating checks
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledTimes(1);

      const call = mockOctokit.rest.issues.createComment.mock.calls[0][0];
      // Should contain AI checks with comment-generating schemas
      expect(call.body).toContain('Security issues found');
      expect(call.body).toContain('PR looks good');
      // Should NOT contain orchestration checks
      expect(call.body).not.toContain('Tests passed');
      expect(call.body).not.toContain('Webhook sent');
    });
  });
});
