import { AIReviewService } from '../../src/ai-review-service';
import { PRInfo } from '../../src/pr-analyzer';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';

// Mock child_process spawn
jest.mock('child_process', () => ({
  spawn: jest.fn(),
}));

describe('AIReviewService', () => {
  const mockSpawn = spawn as jest.MockedFunction<typeof spawn>;
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
        'No API key configured. Please set GOOGLE_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY environment variable.'
      );
    });

    it('should execute AI review when API key is available', async () => {
      process.env.GOOGLE_API_KEY = 'test-key';

      // Mock successful probe-chat response
      const mockChild = new EventEmitter() as any;
      mockChild.stdin = { write: jest.fn(), end: jest.fn() };
      mockChild.stdout = new EventEmitter();
      mockChild.stderr = new EventEmitter();
      mockChild.kill = jest.fn();

      mockSpawn.mockReturnValue(mockChild);

      const service = new AIReviewService();
      const reviewPromise = service.executeReview(mockPRInfo, 'security');

      // Simulate probe-chat response
      setTimeout(() => {
        const mockResponse = JSON.stringify({
          response: JSON.stringify({
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
            suggestions: ['Fix SQL injection vulnerability'],
          }),
        });
        mockChild.stdout.emit('data', Buffer.from(mockResponse));
        mockChild.emit('close', 0);
      }, 10);

      const result = await reviewPromise;

      expect(result.issues).toHaveLength(1);
      expect(result.suggestions).toContain('Fix SQL injection vulnerability');
      expect(result.issues[0].message).toBe('SQL injection risk');
      expect(result.issues[0].suggestion).toBe('Use parameterized queries');
      expect(result.issues[0].replacement).toContain('db.query');
    });

    it('should handle probe-chat errors and throw', async () => {
      process.env.GOOGLE_API_KEY = 'test-key';

      const mockChild = new EventEmitter() as any;
      mockChild.stdin = { write: jest.fn(), end: jest.fn() };
      mockChild.stdout = new EventEmitter();
      mockChild.stderr = new EventEmitter();
      mockChild.kill = jest.fn();

      mockSpawn.mockReturnValue(mockChild);

      const service = new AIReviewService();
      const reviewPromise = service.executeReview(mockPRInfo, 'performance');

      // Simulate probe-chat error
      setTimeout(() => {
        mockChild.stderr.emit('data', Buffer.from('Error: API rate limit exceeded'));
        mockChild.emit('close', 1);
      }, 10);

      await expect(reviewPromise).rejects.toThrow(
        'probe-chat exited with code 1: Error: API rate limit exceeded'
      );
    });

    it('should handle timeout and throw', async () => {
      process.env.GOOGLE_API_KEY = 'test-key';

      const mockChild = new EventEmitter() as any;
      mockChild.stdin = { write: jest.fn(), end: jest.fn() };
      mockChild.stdout = new EventEmitter();
      mockChild.stderr = new EventEmitter();
      mockChild.kill = jest.fn();

      mockSpawn.mockReturnValue(mockChild);

      const service = new AIReviewService({ timeout: 100 }); // Very short timeout
      const reviewPromise = service.executeReview(mockPRInfo, 'all');

      // Don't emit any response, let it timeout

      await expect(reviewPromise).rejects.toThrow('AI review timed out after 100ms');
      expect(mockChild.kill).toHaveBeenCalled();
    });
  });

  describe('Prompt Building', () => {
    it('should build security-focused prompt', () => {
      const service = new AIReviewService();
      const prInfo: PRInfo = {
        number: 1,
        title: 'Add authentication',
        body: 'Adds user login',
        author: 'dev',
        base: 'main',
        head: 'auth',
        files: [],
        totalAdditions: 0,
        totalDeletions: 0,
      };

      const prompt = (service as any).buildPrompt(prInfo, 'security');

      expect(prompt).toContain('security issues');
      expect(prompt).toContain('Add authentication');
      expect(prompt).toContain('JSON');
    });

    it('should build performance-focused prompt', () => {
      const service = new AIReviewService();
      const prInfo: PRInfo = {
        number: 2,
        title: 'Optimize queries',
        body: '',
        author: 'dev',
        base: 'main',
        head: 'perf',
        files: [],
        totalAdditions: 0,
        totalDeletions: 0,
      };

      const prompt = (service as any).buildPrompt(prInfo, 'performance');

      expect(prompt).toContain('performance issues');
      expect(prompt).toContain('Optimize queries');
    });

    it('should include suggestion and replacement field guidelines in prompt', () => {
      const service = new AIReviewService();
      const prInfo: PRInfo = {
        number: 1,
        title: 'Test PR',
        body: 'Test description',
        author: 'dev',
        base: 'main',
        head: 'feature',
        files: [],
        totalAdditions: 0,
        totalDeletions: 0,
      };

      const prompt = (service as any).buildPrompt(prInfo, 'all');

      expect(prompt).toContain('suggestion');
      expect(prompt).toContain('replacement');
      expect(prompt).toContain('clear actionable explanation of how to fix');
      expect(prompt).toContain('complete working code that should replace');
    });

    it('should include field examples in prompt', () => {
      const service = new AIReviewService();
      const prInfo: PRInfo = {
        number: 1,
        title: 'Test PR',
        body: 'Test description',
        author: 'dev',
        base: 'main',
        head: 'feature',
        files: [],
        totalAdditions: 0,
        totalDeletions: 0,
      };

      const prompt = (service as any).buildPrompt(prInfo, 'all');

      // Check for example patterns
      expect(prompt).toContain('Code Replacement Examples');
      expect(prompt).toContain('Use const instead of let');
      expect(prompt).toContain('Use parameterized queries');
      expect(prompt).toContain('Add try-catch block');
      expect(prompt).toContain('const userName = getUserName()');
      expect(prompt).toContain("const query = 'SELECT * FROM users WHERE id = ?'");
    });

    it('should include enhanced field guidelines', () => {
      const service = new AIReviewService();
      const prInfo: PRInfo = {
        number: 1,
        title: 'Test PR',
        body: 'Test description',
        author: 'dev',
        base: 'main',
        head: 'feature',
        files: [],
        totalAdditions: 0,
        totalDeletions: 0,
      };

      const prompt = (service as any).buildPrompt(prInfo, 'all');

      expect(prompt).toContain('Field Guidelines:');
      expect(prompt).toContain('Complete and syntactically correct');
      expect(prompt).toContain('Properly indented to match the surrounding code');
      expect(prompt).toContain('working solution that can be directly copy-pasted');
    });

    it('should truncate large patches', () => {
      const service = new AIReviewService();
      const largePatch = Array(200).fill('line').join('\n');
      const prInfo: PRInfo = {
        number: 1,
        title: 'Large change',
        body: '',
        author: 'dev',
        base: 'main',
        head: 'feature',
        files: [
          {
            filename: 'large.js',
            additions: 200,
            deletions: 0,
            changes: 200,
            status: 'added',
            patch: largePatch,
          },
        ],
        totalAdditions: 200,
        totalDeletions: 0,
      };

      const prompt = (service as any).buildPrompt(prInfo, 'all');

      // Check for the enhanced prompt content
      expect(prompt).toContain('Field Guidelines:');
      expect(prompt).toContain('Code Replacement Examples:');
      expect(prompt).toContain('Example 1 - Variable declaration:');
      expect(prompt).toContain('Example 2 - SQL Injection:');
      expect(prompt).toContain('Example 3 - Missing error handling:');
    });
  });

  describe('Response Parsing', () => {
    it('should parse probe-chat JSON response', () => {
      const service = new AIReviewService();
      const response = JSON.stringify({
        response: JSON.stringify({
          issues: [
            {
              file: 'app.js',
              line: 10,
              ruleId: 'logic/error-handling',
              message: 'Missing error handling',
              severity: 'warning',
              category: 'logic',
              suggestion: 'Add try-catch block to handle potential errors',
              replacement:
                'try {\n  // existing code\n} catch (error) {\n  console.error(error);\n}',
            },
          ],
          suggestions: ['Add tests'],
        }),
      });

      const result = (service as any).parseAIResponse(response);

      expect(result.issues).toHaveLength(1);
      expect(result.suggestions).toContain('Add tests');
      expect(result.issues[0].message).toBe('Missing error handling');
      expect(result.issues[0].suggestion).toBe('Add try-catch block to handle potential errors');
      expect(result.issues[0].replacement).toContain('try {');
    });

    it('should handle response wrapped in markdown code blocks', () => {
      const service = new AIReviewService();
      const response = JSON.stringify({
        response:
          '```json\n' +
          JSON.stringify({
            issues: [],
            suggestions: ['Code looks good overall'],
          }) +
          '\n```',
      });

      const result = (service as any).parseAIResponse(response);

      expect(result.issues).toHaveLength(0);
      expect(result.suggestions).toContain('Code looks good overall');
    });

    it('should parse enhanced response format with suggestions and replacements', () => {
      const service = new AIReviewService();
      const response = JSON.stringify({
        response: JSON.stringify({
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
          suggestions: ['Add input validation', 'Consider adding tests'],
        }),
      });

      const result = (service as any).parseAIResponse(response);

      expect(result.issues).toHaveLength(2);
      expect(result.suggestions).toHaveLength(2);

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

    it('should validate and normalize severity levels', () => {
      const service = new AIReviewService();
      const response = JSON.stringify({
        response: JSON.stringify({
          suggestions: [],
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
        }),
      });

      const result = (service as any).parseAIResponse(response);

      expect(result.issues[0].severity).toBe('critical'); // critical stays as critical
      expect(result.issues[1].severity).toBe('error'); // major -> error
      expect(result.issues[2].severity).toBe('info'); // minor -> info
    });

    it('should validate and normalize categories', () => {
      const service = new AIReviewService();
      const response = JSON.stringify({
        response: JSON.stringify({
          suggestions: [],
          issues: [
            { file: 'a.js', line: 1, message: 'Bug', severity: 'error', category: 'bug' },
            { file: 'b.js', line: 2, message: 'Docs', severity: 'info', category: 'docs' },
          ],
        }),
      });

      const result = (service as any).parseAIResponse(response);

      expect(result.issues[0].category).toBe('logic'); // bug -> logic
      expect(result.issues[1].category).toBe('documentation'); // docs -> documentation
    });

    it('should handle invalid JSON gracefully', () => {
      const service = new AIReviewService();
      const invalidResponse = 'Not a JSON response';

      expect(() => {
        (service as any).parseAIResponse(invalidResponse);
      }).toThrow('Invalid AI response format');
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
        'No API key configured. Please set GOOGLE_API_KEY, ANTHROPIC_API_KEY, or OPENAI_API_KEY environment variable.'
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
});
