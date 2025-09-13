/* eslint-disable @typescript-eslint/no-explicit-any */
import { PRReviewer, ReviewIssue, ReviewSummary } from '../../src/reviewer';
import { PRInfo } from '../../src/pr-analyzer';

// Mock CheckExecutionEngine
jest.mock('../../src/check-execution-engine', () => {
  return {
    CheckExecutionEngine: jest.fn().mockImplementation(() => ({
      executeReviewChecks: jest
        .fn()
        .mockImplementation(async (_prInfo, _checks, _unused1, _config, _unused2, _debug) => {
          // Return mock results similar to AIReviewService mock
          const issues: any[] = [];
          const suggestions: string[] = [];

          // Generate mock issues based on check names
          if (_checks.includes('security-review') || _checks.includes('basic-review')) {
            if (
              _prInfo.files[0]?.patch?.includes('eval') ||
              _prInfo.files[0]?.patch?.includes('innerHTML')
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
          }

          // Large file detection
          if (_prInfo.files.some((f: any) => f.additions > 100)) {
            issues.push({
              file: _prInfo.files.find((f: any) => f.additions > 100)?.filename || 'src/large.ts',
              line: 1,
              ruleId: 'style/large-change',
              message: 'Large file change detected, consider breaking into smaller PRs',
              severity: 'warning',
              category: 'style',
            });
          }

          // Test file suggestions
          const hasTestFiles = _prInfo.files.some(
            (f: any) => f.filename.includes('.test.') || f.filename.includes('.spec.')
          );
          const hasSourceFiles = _prInfo.files.some(
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

          return { issues, suggestions };
        }),
    })),
  };
});

// Mock AI service to avoid actual API calls
jest.mock('../../src/ai-review-service', () => {
  return {
    AIReviewService: jest.fn().mockImplementation(() => ({
      executeReview: jest.fn().mockImplementation((prInfo, customPrompt) => {
        const issues: any[] = [];
        const suggestions: string[] = [];

        // Dynamic responses based on test context and custom prompt
        if (
          customPrompt?.toLowerCase().includes('security') ||
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
      const mockConfig = {
        checks: {
          'basic-review': {
            provider: 'ai',
            prompt: 'Review this code for basic issues',
          },
        },
      };

      const review = await reviewer.reviewPR('owner', 'repo', 1, mockPRInfo, {
        config: mockConfig as any,
        checks: ['basic-review'],
        parallelExecution: false,
      });

      expect(review).toBeDefined();
      expect(Array.isArray(review.issues)).toBe(true);
      expect(Array.isArray(review.suggestions)).toBe(true);
      expect(review.issues.length).toBeGreaterThanOrEqual(0);
      expect(review.suggestions.length).toBeGreaterThanOrEqual(0);
    });

    test('should focus on security when requested', async () => {
      mockPRInfo.files[0].patch = 'eval("dangerous code"); innerHTML = userInput;';

      const mockConfig = {
        checks: {
          'security-review': {
            provider: 'ai',
            prompt: 'Review this code for security issues',
          },
        },
      };

      const review = await reviewer.reviewPR('owner', 'repo', 1, mockPRInfo, {
        config: mockConfig as any,
        checks: ['security-review'],
        parallelExecution: false,
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

      const mockConfig = {
        checks: {
          'detailed-review': {
            provider: 'ai',
            prompt: 'Review this code in detail',
          },
        },
      };

      const summaryReview = await reviewer.reviewPR('owner', 'repo', 1, mockPRInfo, {
        format: 'table',
        config: mockConfig as any,
        checks: ['detailed-review'],
        parallelExecution: false,
      });

      const detailedReview = await reviewer.reviewPR('owner', 'repo', 1, mockPRInfo, {
        format: 'markdown',
        config: mockConfig as any,
        checks: ['detailed-review'],
        parallelExecution: false,
      });

      expect(detailedReview.issues.length).toBeGreaterThanOrEqual(summaryReview.issues.length);
    });

    test('should detect large file changes', async () => {
      mockPRInfo.files[0].additions = 150;

      const mockConfig = {
        checks: {
          'large-file-review': {
            provider: 'ai',
            prompt: 'Review this code for large file changes',
          },
        },
      };

      const review = await reviewer.reviewPR('owner', 'repo', 1, mockPRInfo, {
        config: mockConfig as any,
        checks: ['large-file-review'],
        parallelExecution: false,
      });

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

      const mockConfig = {
        checks: {
          'test-review': {
            provider: 'ai',
            prompt: 'Review this code and suggest testing improvements',
          },
        },
      };

      const review = await reviewer.reviewPR('owner', 'repo', 1, mockPRInfo, {
        config: mockConfig as any,
        checks: ['test-review'],
        parallelExecution: false,
      });

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

      const mockConfig = {
        checks: {
          'test-feedback-review': {
            provider: 'ai',
            prompt: 'Review this code and provide feedback on testing',
          },
        },
      };

      const review = await reviewer.reviewPR('owner', 'repo', 1, mockPRInfo, {
        config: mockConfig as any,
        checks: ['test-feedback-review'],
        parallelExecution: false,
      });

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
        body: expect.stringContaining('Code Analysis Results'),
      });

      const callArgs = mockOctokit.rest.issues.createComment.mock.calls[0][0];
      expect(callArgs.body).toContain('## 🔍 Code Analysis Results');
      expect(callArgs.body).toContain('### Style Issues (1)');
      expect(callArgs.body).toContain('<table>');
      expect(callArgs.body).toContain('<th>Severity</th>');
      expect(callArgs.body).toContain('<th>Location</th>');
      expect(callArgs.body).toContain('<th>Issue</th>');
      expect(callArgs.body).not.toContain('<th>Category</th>'); // Category column removed since we have separate tables
      // Should not contain the old summary sections
      expect(callArgs.body).not.toContain('📊 Summary');
      expect(callArgs.body).not.toContain('**Total Issues Found:**');
      expect(callArgs.body).toContain('<code>src/test.ts:10</code>');
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
      expect(callArgs.body).toContain('### Security Issues (1)');
      expect(callArgs.body).toContain('### Performance Issues (1)');
      expect(callArgs.body).toContain('### Style Issues (1)');
      // Should have multiple tables, one for each category
      const tableMatches = callArgs.body.match(/<table>/g);
      expect(tableMatches).toBeTruthy();
      expect(tableMatches.length).toBe(3); // Three separate tables for three categories
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

    test('should escape HTML in suggestions and replacements to prevent nested tables', async () => {
      // Mock listComments to return empty (so it creates new comment)
      mockOctokit.rest.issues.listComments.mockResolvedValue({ data: [] });
      mockOctokit.rest.issues.createComment.mockResolvedValue({
        data: {
          id: 127,
          body: 'Test comment',
          user: { login: 'visor-bot' },
          created_at: '2023-01-01T00:00:00Z',
          updated_at: '2023-01-01T00:00:00Z',
        },
      });

      const mockReview = {
        issues: [
          {
            file: 'src/table.ts',
            line: 10,
            ruleId: 'style/html-structure',
            message: 'HTML table structure needs improvement',
            severity: 'warning' as const,
            category: 'style' as const,
            suggestion: 'Use proper <table> tags with <thead> and <tbody>',
            replacement: `<table>
  <thead>
    <tr>
      <th>Column 1</th>
      <th>Column 2</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td>Data 1</td>
      <td>Data 2</td>
    </tr>
  </tbody>
</table>`,
          },
        ],
        suggestions: ['Consider using semantic HTML'],
      };

      await reviewer.postReviewComment('owner', 'repo', 1, mockReview);

      const callArgs = mockOctokit.rest.issues.createComment.mock.calls[0][0];

      // Check that HTML is properly escaped in suggestions
      expect(callArgs.body).toContain('&lt;table&gt;');
      expect(callArgs.body).toContain('&lt;thead&gt;');
      expect(callArgs.body).toContain('&lt;tbody&gt;');
      expect(callArgs.body).toContain('&lt;tr&gt;');
      expect(callArgs.body).toContain('&lt;th&gt;');
      expect(callArgs.body).toContain('&lt;td&gt;');

      // Check that content is wrapped in a div for better table layout
      expect(callArgs.body).toContain('<td><div>');
      expect(callArgs.body).toContain('</div></td>');

      // The HTML inside the code suggestions should be escaped
      // This prevents the nested table issue where HTML code appears as actual HTML
      const codeBlockMatch = callArgs.body.match(/<pre><code[^>]*>([\s\S]*?)<\/code><\/pre>/);
      expect(codeBlockMatch).toBeTruthy();
      if (codeBlockMatch) {
        const codeContent = codeBlockMatch[1];
        // Inside the code block, HTML should be escaped
        expect(codeContent).toContain('&lt;table&gt;');
        expect(codeContent).toContain('&lt;thead&gt;');
        // Should not contain unescaped HTML tags within the code block
        expect(codeContent).not.toContain('<table>');
        expect(codeContent).not.toContain('<thead>');
      }

      // Check that <br/> tags have been replaced with newlines in structured content
      const issueCell = callArgs.body.match(/<td><div>[\s\S]*?<\/div><\/td>/);
      expect(issueCell).toBeTruthy();
      if (issueCell) {
        // Should not contain <br/> tags between details sections
        expect(issueCell[0]).not.toContain('</details><br/><details>');
        // Should contain newlines between details sections for proper spacing (allow for indentation)
        expect(issueCell[0]).toMatch(/<\/details>\s*\n\s*<details>/);
      }
    });

    test('should create separate tables for each category', async () => {
      // Mock listComments to return empty (so it creates new comment)
      mockOctokit.rest.issues.listComments.mockResolvedValue({ data: [] });
      mockOctokit.rest.issues.createComment.mockResolvedValue({
        data: {
          id: 128,
          body: 'Test comment',
          user: { login: 'visor-bot' },
          created_at: '2023-01-01T00:00:00Z',
          updated_at: '2023-01-01T00:00:00Z',
        },
      });

      const mockReview = {
        issues: [
          {
            file: 'src/auth.ts',
            line: 5,
            ruleId: 'security/auth-vulnerability',
            message: 'Authentication bypass detected',
            severity: 'critical' as const,
            category: 'security' as const,
          },
          {
            file: 'src/login.ts',
            line: 10,
            ruleId: 'security/sql-injection',
            message: 'SQL injection vulnerability',
            severity: 'error' as const,
            category: 'security' as const,
          },
          {
            file: 'src/styles.css',
            line: 20,
            ruleId: 'style/formatting',
            message: 'Inconsistent formatting',
            severity: 'info' as const,
            category: 'style' as const,
          },
          {
            file: 'src/process.ts',
            line: 100,
            ruleId: 'performance/n-plus-one',
            message: 'N+1 query detected',
            severity: 'warning' as const,
            category: 'performance' as const,
          },
        ],
        suggestions: [],
      };

      await reviewer.postReviewComment('owner', 'repo', 1, mockReview);

      const callArgs = mockOctokit.rest.issues.createComment.mock.calls[0][0];

      // Check that we have category-specific headers
      expect(callArgs.body).toContain('### Security Issues (2)');
      expect(callArgs.body).toContain('### Style Issues (1)');
      expect(callArgs.body).toContain('### Performance Issues (1)');

      // Check that we have exactly 3 tables (one per category)
      const tableMatches = callArgs.body.match(/<table>/g);
      expect(tableMatches).toBeTruthy();
      expect(tableMatches.length).toBe(3);

      // Verify that security issues are in the security table section
      const securitySection = callArgs.body.match(/### Security Issues[\s\S]*?(?=###|<details>|$)/);
      expect(securitySection).toBeTruthy();
      if (securitySection) {
        expect(securitySection[0]).toContain('Authentication bypass detected');
        expect(securitySection[0]).toContain('SQL injection vulnerability');
        expect(securitySection[0]).not.toContain('Inconsistent formatting'); // Style issue should not be here
      }

      // Verify that style issues are in the style table section
      const styleSection = callArgs.body.match(/### Style Issues[\s\S]*?(?=###|<details>|$)/);
      expect(styleSection).toBeTruthy();
      if (styleSection) {
        expect(styleSection[0]).toContain('Inconsistent formatting');
        expect(styleSection[0]).not.toContain('Authentication bypass'); // Security issue should not be here
      }
    });

    test('should generate GitHub permalink when commit SHA is provided', async () => {
      // Mock listComments to return empty (so it creates new comment)
      mockOctokit.rest.issues.listComments.mockResolvedValue({ data: [] });
      mockOctokit.rest.issues.createComment.mockResolvedValue({
        data: {
          id: 127,
          body: 'Test comment',
          user: { login: 'visor-bot' },
          created_at: '2023-01-01T00:00:00Z',
          updated_at: '2023-01-01T00:00:00Z',
        },
      });

      const issueWithLine: ReviewIssue = {
        file: 'src/components/Button.tsx',
        line: 42,
        endLine: 45,
        message: 'Missing prop validation',
        severity: 'warning',
        category: 'logic',
        ruleId: 'quality/prop-validation',
      };

      const summary: ReviewSummary = {
        issues: [issueWithLine],
        suggestions: [],
      };

      // Pass commit SHA in options
      await reviewer.postReviewComment('owner', 'repo', 1, summary, {
        commitSha: 'abc123def456',
      });

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalled();
      const callArgs = mockOctokit.rest.issues.createComment.mock.calls[0][0];

      // Should contain GitHub permalink with commit SHA (auto-expands in comments)
      expect(callArgs.body).toContain(
        'href="https://github.com/owner/repo/blob/abc123def456/src/components/Button.tsx#L42-L45'
      );
      expect(callArgs.body).toContain('<code>src/components/Button.tsx:42-45</code></a>');
    });

    test('should generate GitHub links for files and line numbers', async () => {
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

      const issueWithLine: ReviewIssue = {
        file: 'src/components/Button.tsx',
        line: 42,
        endLine: 45,
        message: 'Missing prop validation',
        severity: 'warning',
        category: 'logic',
        ruleId: 'quality/prop-validation',
      };

      const summary: ReviewSummary = {
        issues: [issueWithLine],
        suggestions: [],
      };

      await reviewer.postReviewComment('owner', 'repo', 1, summary, {});

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalled();
      const callArgs = mockOctokit.rest.issues.createComment.mock.calls[0][0];

      // Should contain GitHub link with file and line combined
      // When no commit SHA is provided, should fall back to PR files view
      expect(callArgs.body).toContain('href="https://github.com/owner/repo/pull/1/files');
      expect(callArgs.body).toContain('<code>src/components/Button.tsx:42-45</code></a>');
    });

    test('should include category-specific recommendations', async () => {
      // Mock listComments to return empty (so it creates new comment)
      mockOctokit.rest.issues.listComments.mockResolvedValue({ data: [] });
      mockOctokit.rest.issues.createComment.mockResolvedValue({
        data: {
          id: 129,
          body: 'Test comment',
          user: { login: 'visor-bot' },
          created_at: '2023-01-01T00:00:00Z',
          updated_at: '2023-01-01T00:00:00Z',
        },
      });

      const mockReview = {
        issues: [
          {
            file: 'src/auth.ts',
            line: 5,
            ruleId: 'security/critical',
            message: 'Critical security vulnerability',
            severity: 'critical' as const,
            category: 'security' as const,
          },
          {
            file: 'src/perf.ts',
            line: 10,
            ruleId: 'performance/warning',
            message: 'Performance issue detected',
            severity: 'warning' as const,
            category: 'performance' as const,
          },
          {
            file: 'src/style.css',
            line: 20,
            ruleId: 'style/info',
            message: 'Style improvement suggested',
            severity: 'info' as const,
            category: 'style' as const,
          },
        ],
        suggestions: [],
      };

      await reviewer.postReviewComment('owner', 'repo', 1, mockReview);

      const callArgs = mockOctokit.rest.issues.createComment.mock.calls[0][0];

      // Check for category headings (no hardcoded recommendations anymore)
      expect(callArgs.body).toContain('### Security Issues (1)');
      expect(callArgs.body).toContain('### Performance Issues (1)');
      expect(callArgs.body).toContain('### Style Issues (1)');

      // Should not contain the old summary/recommendations sections
      expect(callArgs.body).not.toContain('📊 Summary');
      expect(callArgs.body).not.toContain(
        '<details>\n<summary><strong>💡 Recommendations</strong></summary>'
      );
    });
  });
});
