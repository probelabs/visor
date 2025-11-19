/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  PRReviewer,
  ReviewIssue,
  ReviewSummary,
  convertReviewSummaryToGroupedResults,
} from '../../src/reviewer';
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

          // Generate mock issues based on check names
          if (_checks.includes('security-review') || _checks.includes('basic-review')) {
            if (
              _prInfo.files[0]?.patch?.includes('eval') ||
              _prInfo.files[0]?.patch?.includes('innerHTML')
            ) {
              issues.push({
                file: 'src/test.ts',
                line: 5,
                ruleId: 'security-review/dangerous-eval',
                message: 'Dangerous eval usage detected - security vulnerability',
                severity: 'critical',
                category: 'security',
              });
            }
          }

          // Large file detection
          if (_prInfo.files.some((f: any) => f.additions > 100)) {
            const checkName =
              _checks.find((c: string) => c.includes('large') || c.includes('basic')) || _checks[0];
            issues.push({
              file: _prInfo.files.find((f: any) => f.additions > 100)?.filename || 'src/large.ts',
              line: 1,
              ruleId: `${checkName}/large-change`,
              message: 'Large file change detected, consider breaking into smaller PRs',
              severity: 'warning',
              category: 'style',
            });
          }

          // Test file handling (removed suggestions)
          // Test file detection logic removed as suggestions field is deprecated

          // Default response if no specific conditions met
          if (issues.length === 0) {
            const checkName = _checks[0] || 'basic-review';
            issues.push({
              file: 'src/test.ts',
              line: 10,
              ruleId: `${checkName}/naming-convention`,
              message: 'Consider using const instead of let',
              severity: 'info',
              category: 'style',
            });
          }

          // Default suggestions logic removed as suggestions field is deprecated

          return { issues };
        }),
      executeGroupedChecks: jest
        .fn()
        .mockImplementation(async (_prInfo, _checks, _unused1, _config, _unused2, _debug) => {
          // Return GroupedCheckResults format
          const issues: any[] = [];

          // Generate mock issues based on check names
          if (_checks.includes('security-review') || _checks.includes('basic-review')) {
            if (
              _prInfo.files[0]?.patch?.includes('eval') ||
              _prInfo.files[0]?.patch?.includes('innerHTML')
            ) {
              issues.push({
                file: 'src/test.ts',
                line: 5,
                ruleId: 'security-review/dangerous-eval',
                message: 'Dangerous eval usage detected - security vulnerability',
                severity: 'critical',
                category: 'security',
              });
            }
          }

          // Large file detection
          if (_prInfo.files.some((f: any) => f.additions > 100)) {
            const checkName =
              _checks.find((c: string) => c.includes('large') || c.includes('basic')) || _checks[0];
            issues.push({
              file: _prInfo.files.find((f: any) => f.additions > 100)?.filename || 'src/large.ts',
              line: 1,
              ruleId: `${checkName}/large-change`,
              message: 'Large file change detected, consider breaking into smaller PRs',
              severity: 'warning',
              category: 'style',
            });
          }

          // Test file handling (removed suggestions)
          // Test file detection logic removed as suggestions field is deprecated

          // Default response if no specific conditions met
          if (issues.length === 0) {
            const checkName = _checks[0] || 'basic-review';
            issues.push({
              file: 'src/test.ts',
              line: 10,
              ruleId: `${checkName}/naming-convention`,
              message: 'Consider using const instead of let',
              severity: 'info',
              category: 'style',
            });
          }

          // Default suggestions logic removed as suggestions field is deprecated

          // Convert to GroupedCheckResults format
          const groupedResults: any = {};
          for (const checkName of _checks) {
            const group = _config?.checks?.[checkName]?.group || 'default';
            if (!groupedResults[group]) {
              groupedResults[group] = [];
            }

            // Create a simple content string for this check
            const checkIssues = issues.filter(
              i => i.ruleId?.startsWith(`${checkName}/`) || !i.ruleId?.includes('/')
            );
            // Check suggestions filtering removed as suggestions field is deprecated

            let content = '';
            if (checkIssues.length > 0) {
              content += checkIssues
                .map(i => `- **${i.severity.toUpperCase()}**: ${i.message} (${i.file}:${i.line})`)
                .join('\n');
            }
            // Suggestions content generation removed as suggestions field is deprecated
            if (!content) {
              content = 'No issues found.';
            }

            groupedResults[group].push({
              checkName,
              content,
              group,
              debug: _debug ? { provider: 'mock', model: 'mock-model' } : undefined,
            });
          }

          return {
            results: groupedResults,
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
            message: 'Dangerous eval usage detected - security vulnerability',
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

        // Default suggestions logic removed as suggestions field is deprecated

        return Promise.resolve({ issues });
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
      expect(review).toEqual(expect.any(Object));
      // Verify GroupedCheckResults structure
      const allResults = Object.values(review).flat();
      expect(allResults.length).toBeGreaterThan(0);
      expect(allResults[0]).toHaveProperty('checkName');
      expect(allResults[0]).toHaveProperty('content');
      expect(allResults[0]).toHaveProperty('group');
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

      // Check that security-related content was generated
      const allContent = Object.values(review)
        .flat()
        .map(result => result.content)
        .join(' ');
      expect(allContent.toLowerCase()).toContain('security');
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

      // Both should return valid GroupedCheckResults
      expect(summaryReview).toEqual(expect.any(Object));
      expect(detailedReview).toEqual(expect.any(Object));
      const summaryResults = Object.values(summaryReview).flat();
      const detailedResults = Object.values(detailedReview).flat();
      expect(summaryResults.length).toBeGreaterThan(0);
      expect(detailedResults.length).toBeGreaterThan(0);
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

      // Check that large file related content was generated
      const allContent = Object.values(review)
        .flat()
        .map(result => result.content)
        .join(' ');
      expect(allContent.toLowerCase()).toContain('large');
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

      // Check that test-related suggestions were generated
      const allContent = Object.values(review)
        .flat()
        .map(result => result.content)
        .join(' ');
      expect(allContent.toLowerCase()).toContain('test');
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

      // Check that positive test feedback was generated
      const allContent = Object.values(review)
        .flat()
        .map(result => result.content)
        .join(' ');
      expect(allContent.toLowerCase()).toMatch(/great|good|test/);
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
      };

      const groupedResults = convertReviewSummaryToGroupedResults(mockReview);
      await reviewer.postReviewComment('owner', 'repo', 1, groupedResults);

      expect(mockOctokit.rest.issues.listComments).toHaveBeenCalled();
      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalledWith({
        owner: 'owner',
        repo: 'repo',
        issue_number: 1,
        body: expect.stringContaining('Code Analysis Results'),
      });

      const callArgs = mockOctokit.rest.issues.createComment.mock.calls[0][0];
      expect(callArgs.body).toContain('## 🔍 Code Analysis Results');
      expect(callArgs.body).toContain('## Issues Found (1)');
      expect(callArgs.body).toContain(
        '- **INFO**: Consider using const instead of let (src/test.ts:10)'
      );
      // Suggestions section should not be present as suggestions field was removed
      expect(callArgs.body).not.toContain('## Suggestions');
      expect(callArgs.body).not.toContain('- Add unit tests');
      expect(callArgs.body).not.toContain('- Consider performance optimization');
      // Should not contain the old table format
      expect(callArgs.body).not.toContain('<table>');
      expect(callArgs.body).not.toContain('<th>');
      // Should not contain the old summary sections
      expect(callArgs.body).not.toContain('📊 Summary');
      expect(callArgs.body).not.toContain('**Total Issues Found:**');
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
      };

      const groupedResults = convertReviewSummaryToGroupedResults(mockReview);
      await reviewer.postReviewComment('owner', 'repo', 1, groupedResults);

      const callArgs = mockOctokit.rest.issues.createComment.mock.calls[0][0];
      expect(callArgs.body).toContain('Critical security issue');
      expect(callArgs.body).toContain('Potential performance issue');
      expect(callArgs.body).toContain('Style improvement');
      expect(callArgs.body).toContain('## Issues Found (3)');
      expect(callArgs.body).toContain('- **ERROR**: Critical security issue');
      expect(callArgs.body).toContain('- **WARNING**: Potential performance issue');
      expect(callArgs.body).toContain('- **INFO**: Style improvement');
      // Should not have tables in the new format
      expect(callArgs.body).not.toContain('<table>');
      expect(callArgs.body).not.toContain('<th>');
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

      const groupedResults = convertReviewSummaryToGroupedResults(mockReview);
      await reviewer.postReviewComment('owner', 'repo', 1, groupedResults);

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
        // No debug field
      };

      const groupedResults = convertReviewSummaryToGroupedResults(mockReview);
      await reviewer.postReviewComment('owner', 'repo', 1, groupedResults);

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
      };

      const groupedResults = convertReviewSummaryToGroupedResults(mockReview);
      await reviewer.postReviewComment('owner', 'repo', 1, groupedResults);

      const callArgs = mockOctokit.rest.issues.createComment.mock.calls[0][0];

      // Check that the simple format is used and issue message appears
      expect(callArgs.body).toContain('## Issues Found (1)');
      expect(callArgs.body).toContain('- **WARNING**: HTML table structure needs improvement');
      // Suggestions section should not be present as suggestions field was removed
      expect(callArgs.body).not.toContain('## Suggestions');
      expect(callArgs.body).not.toContain('- Consider using semantic HTML');

      // The new format should not contain HTML tables or escaped HTML
      expect(callArgs.body).not.toContain('<table>');
      expect(callArgs.body).not.toContain('&lt;table&gt;');
      expect(callArgs.body).not.toContain('<td><div>');

      // The new format is simple markdown, so no complex HTML escaping is needed
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
      };

      const groupedResults = convertReviewSummaryToGroupedResults(mockReview);
      await reviewer.postReviewComment('owner', 'repo', 1, groupedResults);

      const callArgs = mockOctokit.rest.issues.createComment.mock.calls[0][0];

      // Check that all issues are listed in the simple format
      expect(callArgs.body).toContain('## Issues Found (4)');
      expect(callArgs.body).toContain('- **CRITICAL**: Authentication bypass detected');
      expect(callArgs.body).toContain('- **ERROR**: SQL injection vulnerability');
      expect(callArgs.body).toContain('- **INFO**: Inconsistent formatting');
      expect(callArgs.body).toContain('- **WARNING**: N+1 query detected');

      // The new format should not have tables or category-specific sections
      expect(callArgs.body).not.toContain('<table>');
      expect(callArgs.body).not.toContain('### Security Issues');
      expect(callArgs.body).not.toContain('### Style Issues');
      expect(callArgs.body).not.toContain('### Performance Issues');
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
      };

      // Pass commit SHA in options
      const groupedResults = convertReviewSummaryToGroupedResults(summary);
      await reviewer.postReviewComment('owner', 'repo', 1, groupedResults, {
        commitSha: 'abc123def456',
      });

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalled();
      const callArgs = mockOctokit.rest.issues.createComment.mock.calls[0][0];

      // Should contain the issue in simple format and commit SHA in footer
      expect(callArgs.body).toContain(
        '- **WARNING**: Missing prop validation (src/components/Button.tsx:42)'
      );
      expect(callArgs.body).toContain('Commit: abc123d');

      // The new format should not contain HTML links
      expect(callArgs.body).not.toContain('href=');
      expect(callArgs.body).not.toContain('<a>');
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
      };

      const groupedResults = convertReviewSummaryToGroupedResults(summary);
      await reviewer.postReviewComment('owner', 'repo', 1, groupedResults, {});

      expect(mockOctokit.rest.issues.createComment).toHaveBeenCalled();
      const callArgs = mockOctokit.rest.issues.createComment.mock.calls[0][0];

      // Should contain the issue in simple format without links
      expect(callArgs.body).toContain(
        '- **WARNING**: Missing prop validation (src/components/Button.tsx:42)'
      );

      // The new format should not contain HTML links
      expect(callArgs.body).not.toContain('href=');
      expect(callArgs.body).not.toContain('<a>');
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
      };

      const groupedResults = convertReviewSummaryToGroupedResults(mockReview);
      await reviewer.postReviewComment('owner', 'repo', 1, groupedResults);

      const callArgs = mockOctokit.rest.issues.createComment.mock.calls[0][0];

      // Check that all issues are listed in the simple format
      expect(callArgs.body).toContain('## Issues Found (3)');
      expect(callArgs.body).toContain('- **CRITICAL**: Critical security vulnerability');
      expect(callArgs.body).toContain('- **WARNING**: Performance issue detected');
      expect(callArgs.body).toContain('- **INFO**: Style improvement suggested');

      // Should not contain the old category-specific sections or summary sections
      expect(callArgs.body).not.toContain('### Security Issues');
      expect(callArgs.body).not.toContain('### Performance Issues');
      expect(callArgs.body).not.toContain('### Style Issues');
      expect(callArgs.body).not.toContain('📊 Summary');
      expect(callArgs.body).not.toContain('<details>');
    });
  });
});
