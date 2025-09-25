/* eslint-disable @typescript-eslint/no-explicit-any */
import { AIReviewService } from '../../src/ai-review-service';
import { PRInfo } from '../../src/pr-analyzer';
import { ProbeAgent } from '@probelabs/probe';

// Mock ProbeAgent
jest.mock('@probelabs/probe', () => ({
  ProbeAgent: jest.fn(),
}));

describe('AIReviewService', () => {
  const MockedProbeAgent = ProbeAgent as jest.MockedClass<typeof ProbeAgent>;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    // Save original environment
    originalEnv = { ...process.env };
    // Clear environment variables
    delete process.env.GOOGLE_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.MODEL_NAME;
    // Reset mocks
    jest.clearAllMocks();
  });

  afterEach(() => {
    // Restore original environment
    process.env = originalEnv;
  });

  describe('Configuration', () => {
    it('should auto-detect Google API key from environment', () => {
      process.env.GOOGLE_API_KEY = 'test-google-key';
      process.env.MODEL_NAME = 'gemini-2.0';

      const service = new AIReviewService();
      expect((service as any).config.apiKey).toBe('test-google-key');
      expect((service as any).config.provider).toBe('google');
      expect((service as any).config.model).toBe('gemini-2.0');
    });

    it('should auto-detect Anthropic API key from environment', () => {
      process.env.ANTHROPIC_API_KEY = 'test-anthropic-key';

      const service = new AIReviewService();
      expect((service as any).config.apiKey).toBe('test-anthropic-key');
      expect((service as any).config.provider).toBe('anthropic');
    });

    it('should auto-detect OpenAI API key from environment', () => {
      process.env.OPENAI_API_KEY = 'test-openai-key';

      const service = new AIReviewService();
      expect((service as any).config.apiKey).toBe('test-openai-key');
      expect((service as any).config.provider).toBe('openai');
    });

    it('should use provided configuration over environment', () => {
      process.env.GOOGLE_API_KEY = 'env-key';

      const service = new AIReviewService({
        apiKey: 'config-key',
        provider: 'anthropic',
        model: 'claude-3',
        timeout: 60000,
      });

      expect((service as any).config.apiKey).toBe('config-key');
      expect((service as any).config.provider).toBe('anthropic');
      expect((service as any).config.model).toBe('claude-3');
      expect((service as any).config.timeout).toBe(60000);
    });

    it('should use increased default timeout of 10 minutes', () => {
      process.env.GOOGLE_API_KEY = 'test-key';

      const service = new AIReviewService();
      expect((service as any).config.timeout).toBe(600000); // 10 minutes
    });

    it('should allow custom timeout configuration', () => {
      process.env.GOOGLE_API_KEY = 'test-key';

      const service = new AIReviewService({ timeout: 300000 }); // 5 minutes
      expect((service as any).config.timeout).toBe(300000);
    });
  });

  describe('executeReview', () => {
    const mockPRInfo: PRInfo = {
      number: 1,
      title: 'Test PR',
      body: 'Test description',
      author: 'testuser',
      base: 'main',
      head: 'feature',
      files: [
        {
          filename: 'test.js',
          additions: 10,
          deletions: 5,
          changes: 15,
          status: 'modified',
          patch: '@@ -1,5 +1,10 @@\n-old code\n+new code',
        },
      ],
      totalAdditions: 10,
      totalDeletions: 5,
    };

    it('should throw error when no API key is available', async () => {
      const service = new AIReviewService();

      await expect(service.executeReview(mockPRInfo, 'security')).rejects.toThrow(
        'No API key configured. Please set GOOGLE_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY environment variable, or configure AWS credentials for Bedrock (AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY).'
      );
    });

    it('should execute AI review when API key is available', async () => {
      process.env.GOOGLE_API_KEY = 'test-key';

      // Mock ProbeAgent response
      const mockAnswer = jest.fn().mockResolvedValue(
        JSON.stringify({
          issues: [
            {
              file: 'test.js',
              line: 5,
              ruleId: 'security/sql-injection',
              message: 'SQL injection risk',
              severity: 'error',
              category: 'security',
              suggestion: 'Use parameterized queries',
              replacement: 'db.query("SELECT * FROM users WHERE id = ?", [userId])',
            },
          ],
        })
      );

      MockedProbeAgent.mockImplementation(
        () =>
          ({
            answer: mockAnswer,
          }) as any
      );

      const service = new AIReviewService();
      const result = await service.executeReview(mockPRInfo, 'security', 'code-review');

      expect(result.issues).toHaveLength(1);
      expect(result.issues![0].message).toBe('SQL injection risk');
      expect(result.issues![0].suggestion).toBe('Use parameterized queries');
      expect(result.issues![0].replacement).toContain('db.query');
      expect(MockedProbeAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          promptType: 'code-review-template',
          allowEdit: false,
          debug: false,
          provider: 'google',
          sessionId: expect.stringMatching(
            /^visor-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-unknown$/
          ),
        })
      );
    });

    it('should handle ProbeAgent errors and throw', async () => {
      process.env.GOOGLE_API_KEY = 'test-key';

      const mockAnswer = jest.fn().mockRejectedValue(new Error('API rate limit exceeded'));
      MockedProbeAgent.mockImplementation(
        () =>
          ({
            answer: mockAnswer,
          }) as any
      );

      const service = new AIReviewService();

      await expect(service.executeReview(mockPRInfo, 'performance')).rejects.toThrow(
        'ProbeAgent execution failed: API rate limit exceeded'
      );
    });

    it('should handle timeout and throw', async () => {
      process.env.GOOGLE_API_KEY = 'test-key';

      // Mock ProbeAgent to throw a timeout error
      const mockAnswer = jest.fn().mockRejectedValue(new Error('Request timed out'));
      MockedProbeAgent.mockImplementation(
        () =>
          ({
            answer: mockAnswer,
          }) as any
      );

      const service = new AIReviewService({ timeout: 100 }); // Very short timeout

      await expect(
        service.executeReview(mockPRInfo, 'Review this code for all issues')
      ).rejects.toThrow('ProbeAgent execution failed: Request timed out');

      expect(MockedProbeAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          promptType: undefined,
          allowEdit: false,
          debug: false,
          provider: 'google',
          sessionId: expect.stringMatching(
            /^visor-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-unknown$/
          ),
        })
      );
    });
  });

  // NOTE: Prompt building tests were removed because built-in prompts were removed.
  // All prompts now come from .visor.yaml configuration files.

  describe('Response Parsing', () => {
    it('should parse probe agent JSON response', () => {
      const service = new AIReviewService();
      const response = JSON.stringify({
        issues: [
          {
            file: 'app.js',
            line: 10,
            ruleId: 'logic/error-handling',
            message: 'Missing error handling',
            severity: 'warning',
            category: 'logic',
            suggestion: 'Add try-catch block to handle potential errors',
            replacement: 'try {\n  // existing code\n} catch (error) {\n  console.error(error);\n}',
          },
        ],
      });

      const result = (service as any).parseAIResponse(response, undefined, 'code-review');

      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].message).toBe('Missing error handling');
      expect(result.issues[0].suggestion).toBe('Add try-catch block to handle potential errors');
      expect(result.issues[0].replacement).toContain('try {');
    });

    it('should handle response wrapped in markdown code blocks', () => {
      const service = new AIReviewService();
      const response =
        '```json\n' +
        JSON.stringify({
          issues: [],
        }) +
        '\n```';

      const result = (service as any).parseAIResponse(response, undefined, 'code-review');

      expect(result.issues).toHaveLength(0);
    });

    it('should parse enhanced response format with suggestions and replacements', () => {
      const service = new AIReviewService();
      const response = JSON.stringify({
        issues: [
          {
            file: 'auth.js',
            line: 15,
            ruleId: 'security/sql-injection',
            message: 'SQL query is vulnerable to injection attacks',
            severity: 'critical',
            category: 'security',
            suggestion: 'Use parameterized queries to prevent SQL injection',
            replacement:
              'const query = "SELECT * FROM users WHERE id = ?";\nconst result = await db.query(query, [userId]);',
          },
          {
            file: 'utils.js',
            line: 23,
            endLine: 25,
            ruleId: 'style/naming',
            message: 'Variable name should use camelCase',
            severity: 'info',
            category: 'style',
            suggestion: 'Use camelCase naming convention for JavaScript variables',
            replacement: 'const userName = getValue();',
          },
        ],
      });

      const result = (service as any).parseAIResponse(response, undefined, 'code-review');

      expect(result.issues).toHaveLength(2);

      // Check first issue (critical security)
      const securityIssue = result.issues[0];
      expect(securityIssue.severity).toBe('critical');
      expect(securityIssue.category).toBe('security');
      expect(securityIssue.suggestion).toBe('Use parameterized queries to prevent SQL injection');
      expect(securityIssue.replacement).toContain('db.query(query, [userId])');

      // Check second issue (style info)
      const styleIssue = result.issues[1];
      expect(styleIssue.severity).toBe('info');
      expect(styleIssue.endLine).toBe(25);
      expect(styleIssue.suggestion).toBe(
        'Use camelCase naming convention for JavaScript variables'
      );
      expect(styleIssue.replacement).toBe('const userName = getValue();');
    });

    it('should preserve original severity levels', () => {
      const service = new AIReviewService();
      const response = JSON.stringify({
        issues: [
          {
            file: 'a.js',
            line: 1,
            message: 'Issue 1',
            severity: 'critical',
            category: 'security',
          },
          { file: 'b.js', line: 2, message: 'Issue 2', severity: 'major', category: 'logic' },
          { file: 'c.js', line: 3, message: 'Issue 3', severity: 'minor', category: 'style' },
        ],
      });

      const result = (service as any).parseAIResponse(response, undefined, 'code-review');

      expect(result.issues[0].severity).toBe('critical'); // critical preserved
      expect(result.issues[1].severity).toBe('major'); // major preserved as-is
      expect(result.issues[2].severity).toBe('minor'); // minor preserved as-is
    });

    it('should preserve original categories', () => {
      const service = new AIReviewService();
      const response = JSON.stringify({
        issues: [
          { file: 'a.js', line: 1, message: 'Bug', severity: 'error', category: 'bug' },
          { file: 'b.js', line: 2, message: 'Docs', severity: 'info', category: 'docs' },
        ],
      });

      const result = (service as any).parseAIResponse(response, undefined, 'code-review');

      expect(result.issues[0].category).toBe('bug'); // bug preserved as-is
      expect(result.issues[1].category).toBe('docs'); // docs preserved as-is
    });

    it('should handle invalid JSON gracefully', () => {
      const service = new AIReviewService();
      const invalidResponse = 'Not a JSON response';

      const result = (service as any).parseAIResponse(invalidResponse);

      // Should return a structured fallback instead of throwing
      expect(result).toHaveProperty('issues');
      expect(result.issues).toHaveLength(1);
      expect(result.issues![0].message).toBe('Not a JSON response');
    });
  });

  describe('Error Handling', () => {
    it('should require API key for executeReview', async () => {
      const service = new AIReviewService();
      const prInfo: PRInfo = {
        number: 1,
        title: 'Test',
        body: '',
        author: 'dev',
        base: 'main',
        head: 'feature',
        files: [],
        totalAdditions: 0,
        totalDeletions: 0,
      };

      await expect(service.executeReview(prInfo, 'security')).rejects.toThrow(
        'No API key configured. Please set GOOGLE_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY environment variable, or configure AWS credentials for Bedrock (AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY).'
      );
    });

    it('should handle configuration validation', () => {
      const service = new AIReviewService({
        apiKey: 'test-key',
        provider: 'google',
        model: 'test-model',
        timeout: 5000,
      });

      expect((service as any).config.apiKey).toBe('test-key');
      expect((service as any).config.provider).toBe('google');
      expect((service as any).config.model).toBe('test-model');
      expect((service as any).config.timeout).toBe(5000);
    });
  });

  describe('Code Context Handling', () => {
    let service: AIReviewService;
    let mockPRInfo: PRInfo;

    beforeEach(() => {
      service = new AIReviewService({ provider: 'mock' });
      mockPRInfo = {
        number: 123,
        title: 'Test PR',
        body: 'Test description',
        author: 'testuser',
        base: 'main',
        head: 'feature-branch',
        files: [
          {
            filename: 'test.ts',
            additions: 10,
            deletions: 5,
            changes: 15,
            status: 'modified',
            patch: '--- a/test.ts\n+++ b/test.ts\n@@ -1 +1 @@\n-old\n+new',
          },
        ],
        totalAdditions: 10,
        totalDeletions: 5,
        fullDiff: '--- test.ts\n--- a/test.ts\n+++ b/test.ts\n@@ -1 +1 @@\n-old\n+new',
      };
    });

    it('should include diffs when includeCodeContext is true', () => {
      (mockPRInfo as any).includeCodeContext = true;
      const context = (service as any).formatPRContext(mockPRInfo);

      expect(context).toContain('<full_diff>');
      expect(context).toContain('--- test.ts');
      expect(context).not.toContain('Code diffs excluded');
    });

    it('should exclude diffs when includeCodeContext is false', () => {
      (mockPRInfo as any).includeCodeContext = false;
      const context = (service as any).formatPRContext(mockPRInfo);

      expect(context).not.toContain('<full_diff>');
      expect(context).not.toContain('--- test.ts');
      expect(context).toContain('Code diffs excluded to reduce token usage');
    });

    it('should always include diffs when isPRContext is true', () => {
      (mockPRInfo as any).includeCodeContext = false;
      (mockPRInfo as any).isPRContext = true;
      const context = (service as any).formatPRContext(mockPRInfo);

      // Even though includeCodeContext is false, PR context should include diffs
      expect(context).toContain('<full_diff>');
      expect(context).toContain('--- test.ts');
    });

    it('should include diffs by default when no flags are set', () => {
      // No includeCodeContext flag set - should default to true
      const context = (service as any).formatPRContext(mockPRInfo);

      expect(context).toContain('<full_diff>');
      expect(context).toContain('--- test.ts');
    });

    it('should handle incremental diff when available', () => {
      (mockPRInfo as any).includeCodeContext = true;
      (mockPRInfo as any).isIncremental = true;
      (mockPRInfo as any).commitDiff =
        '--- a/test.ts\n+++ b/test.ts\n@@ -2 +2 @@\n-line2\n+line2-modified';

      const context = (service as any).formatPRContext(mockPRInfo);

      expect(context).toContain('<commit_diff>');
      expect(context).toContain('line2-modified');
    });

    it('should always include files_summary regardless of includeCodeContext', () => {
      (mockPRInfo as any).includeCodeContext = false;
      const context = (service as any).formatPRContext(mockPRInfo);

      expect(context).toContain('<files_summary>');
      expect(context).toContain('<filename>test.ts</filename>');
      expect(context).toContain('<additions>10</additions>');
      expect(context).toContain('<deletions>5</deletions>');
    });
  });
});
