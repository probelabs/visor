import { AICheckProvider } from '../../src/providers/ai-check-provider';
import { PRInfo } from '../../src/pr-analyzer';
import { VisorConfig } from '../../src/types/config';
import fs from 'fs/promises';

// Mock filesystem operations
jest.mock('fs/promises');

describe('Enhanced Prompts Integration', () => {
  let mockFs: jest.Mocked<typeof fs>;

  const mockPRInfo: PRInfo = {
    number: 456,
    title: 'Implement user authentication system',
    body: 'This PR adds JWT-based authentication with role-based access control',
    author: 'developer123',
    base: 'main',
    head: 'feature/auth-system',
    files: [
      {
        filename: 'src/auth/login.ts',
        additions: 120,
        deletions: 10,
        changes: 130,
        status: 'added',
      },
      {
        filename: 'src/auth/middleware.js',
        additions: 80,
        deletions: 5,
        changes: 85,
        status: 'added',
      },
      {
        filename: 'src/utils/crypto.ts',
        additions: 45,
        deletions: 2,
        changes: 47,
        status: 'modified',
      },
      {
        filename: 'README.md',
        additions: 25,
        deletions: 0,
        changes: 25,
        status: 'modified',
      },
    ],
    totalAdditions: 270,
    totalDeletions: 17,
    isIncremental: false,
  };

  beforeEach(() => {
    mockFs = fs as jest.Mocked<typeof fs>;
    mockFs.readFile = jest.fn();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('End-to-End Enhanced Prompt Processing', () => {
    test('should process complex prompt with all features combined', async () => {
      // Mock external prompt file
      const complexPromptTemplate = `
# Security Review for PR {{ pr.number }}: {{ pr.title }}

## Event Context
- Triggered by: {{ event.name }} ({{ event.action }})
- Repository: {{ event.repository.fullName }}
{% if event.comment %}
- Comment: "{{ event.comment.body }}" by {{ event.comment.author }}
{% endif %}

## PR Analysis
- Author: {{ pr.author }}
- Branch: {{ pr.headBranch }} → {{ pr.baseBranch }}
- Files changed: {{ pr.filesChanged.size }}
- Total changes: +{{ pr.totalAdditions }}/-{{ pr.totalDeletions }}

## File Breakdown
{% assign tsFiles = utils.filesByExtension.ts %}
{% assign jsFiles = utils.filesByExtension.js %}
{% assign mdFiles = utils.filesByExtension.md %}

{% if tsFiles.size > 0 %}
### TypeScript Files ({{ tsFiles.size }})
{% for file in tsFiles %}
- {{ file.filename }} (+{{ file.additions }}/-{{ file.deletions }})
{% endfor %}
{% endif %}

{% if jsFiles.size > 0 %}
### JavaScript Files ({{ jsFiles.size }})
{% for file in jsFiles %}
- {{ file.filename }} (+{{ file.additions }}/-{{ file.deletions }})
{% endfor %}
{% endif %}

{% if utils.hasLargeChanges %}
⚠️ **Warning**: This PR contains large changes that require careful review.
{% endif %}

## Previous Security Results
{% if outputs.security %}
Security check found {{ outputs.security.totalIssues }} total issues:
- Critical: {{ outputs.security.criticalIssues }}
- Errors: {{ outputs.security.errorIssues }}
- Warnings: {{ outputs.security.warningIssues }}

{% if outputs.security.securityIssues.size > 0 %}
### Security Issues Found:
{% for issue in outputs.security.securityIssues %}
- **{{ issue.severity | upcase }}** in {{ issue.file }}:{{ issue.line }}: {{ issue.message }}
{% endfor %}
{% endif %}

### Security Recommendations:
{% for suggestion in outputs.security.suggestions %}
- {{ suggestion }}
{% endfor %}
{% else %}
No previous security results available for context.
{% endif %}

## Focus Areas for This Review
1. Authentication implementation security
2. JWT token handling
3. Role-based access control
4. Input validation and sanitization
5. Cryptographic practices

Please analyze the authentication system for:
- SQL injection vulnerabilities
- Authentication bypass possibilities  
- JWT token security issues
- Role escalation vulnerabilities
- Proper error handling
      `;

      mockFs.readFile.mockResolvedValue(complexPromptTemplate);

      // Mock dependency results from security check
      const mockDependencyResults = new Map();
      mockDependencyResults.set('security', {
        issues: [
          {
            file: 'src/old-auth.ts',
            line: 45,
            severity: 'critical',
            category: 'security',
            message: 'Hardcoded credentials detected',
          },
          {
            file: 'src/validation.ts',
            line: 12,
            severity: 'error',
            category: 'security',
            message: 'SQL injection vulnerability in user input',
          },
          {
            file: 'src/routes.ts',
            line: 8,
            severity: 'warning',
            category: 'security',
            message: 'Missing rate limiting on authentication endpoint',
          },
        ],
        suggestions: [
          'Use environment variables for sensitive configuration',
          'Implement parameterized queries',
          'Add rate limiting to prevent brute force attacks',
        ],
      });

      // Mock event context
      const eventContext = {
        event_name: 'pull_request',
        action: 'opened',
        repository: {
          owner: { login: 'mycompany' },
          name: 'secure-app',
        },
        comment: {
          body: '/visor security',
          user: { login: 'security-reviewer' },
        },
      };

      const provider = new AICheckProvider();

      // Test the complete prompt processing pipeline
      const processedPrompt = await (provider as any).processPrompt(
        { file: './security-prompt.liquid' },
        mockPRInfo,
        eventContext,
        mockDependencyResults
      );

      // Verify all template features are working
      expect(processedPrompt).toContain(
        'Security Review for PR 456: Implement user authentication system'
      );
      expect(processedPrompt).toContain('Triggered by: pull_request (opened)');
      expect(processedPrompt).toContain('Repository: mycompany/secure-app');
      expect(processedPrompt).toContain('Comment: "/visor security" by security-reviewer');

      expect(processedPrompt).toContain('Author: developer123');
      expect(processedPrompt).toContain('Branch: feature/auth-system → main');
      expect(processedPrompt).toContain('Files changed: 4');
      expect(processedPrompt).toContain('Total changes: +270/-17');

      expect(processedPrompt).toContain('TypeScript Files (2)');
      expect(processedPrompt).toContain('src/auth/login.ts (+120/-10)');
      expect(processedPrompt).toContain('src/utils/crypto.ts (+45/-2)');

      expect(processedPrompt).toContain('JavaScript Files (1)');
      expect(processedPrompt).toContain('src/auth/middleware.js (+80/-5)');

      expect(processedPrompt).toContain('Warning**: This PR contains large changes');

      expect(processedPrompt).toContain('Security check found 3 total issues');
      expect(processedPrompt).toContain('Critical: 1');
      expect(processedPrompt).toContain('Errors: 1');
      expect(processedPrompt).toContain('Warnings: 1');

      expect(processedPrompt).toContain(
        'CRITICAL** in src/old-auth.ts:45: Hardcoded credentials detected'
      );
      expect(processedPrompt).toContain('Use environment variables for sensitive configuration');
      expect(processedPrompt).toContain('Implement parameterized queries');

      expect(processedPrompt).toContain('Focus Areas for This Review');
      expect(processedPrompt).toContain('Authentication implementation security');

      expect(mockFs.readFile).toHaveBeenCalledWith(
        expect.stringMatching(/security-prompt\.liquid$/),
        'utf-8'
      );
    });

    test('should handle configuration with prompt file and custom template', async () => {
      const config: VisorConfig = {
        version: '1.0',
        checks: {
          'enhanced-security': {
            type: 'ai',
            prompt: {
              file: './prompts/security-with-context.liquid',
            },
            template: {
              file: './templates/security-output.liquid',
            },
            on: ['pr_opened'],
            group: 'security-review',
            schema: 'code-review',
          },
        },
        output: {
          pr_comment: {
            format: 'markdown',
            group_by: 'check',
            collapse: false,
          },
        },
      };

      const promptContent = `
Review security for PR {{ pr.number }}:
{% if outputs.architecture %}
Architecture score: {{ outputs.architecture.totalIssues }}
{% endif %}
Focus on {{ utils.filesByExtension.ts.size }} TypeScript files.
      `;

      mockFs.readFile.mockResolvedValue(promptContent);

      const provider = new AICheckProvider();

      const processedPrompt = await (provider as any).processPrompt(
        config.checks['enhanced-security'].prompt,
        mockPRInfo
      );

      expect(processedPrompt).toContain('Review security for PR 456');
      expect(processedPrompt).toContain('Focus on 2 TypeScript files');
      expect(mockFs.readFile).toHaveBeenCalledWith(
        expect.stringMatching(/prompts[/\\]security-with-context\.liquid$/),
        'utf-8'
      );
    });

    test('should work with inline prompt content and dependency results', async () => {
      const mockDependencyResults = new Map();
      mockDependencyResults.set('performance', {
        issues: [
          {
            file: 'src/slow-query.ts',
            line: 25,
            severity: 'warning',
            category: 'performance',
            message: 'N+1 query detected',
          },
        ],
        suggestions: ['Use batch queries', 'Add database indexing'],
      });

      const provider = new AICheckProvider();

      const processedPrompt = await (provider as any).processPrompt(
        {
          content: `
Performance Review Summary:
- PR: {{ pr.title }}
- Performance issues from previous check: {{ outputs.performance.totalIssues }}
{% for issue in outputs.performance.performanceIssues %}
- {{ issue.message }} in {{ issue.file }}
{% endfor %}

Recommendations:
{% for suggestion in outputs.performance.suggestions %}
- {{ suggestion }}
{% endfor %}

New files to analyze:
{% for file in utils.addedFiles %}
- {{ file.filename }} ({{ file.status }})
{% endfor %}
          `,
        },
        mockPRInfo,
        undefined,
        mockDependencyResults
      );

      expect(processedPrompt).toContain('Performance Review Summary');
      expect(processedPrompt).toContain('PR: Implement user authentication system');
      expect(processedPrompt).toContain('Performance issues from previous check: 1');
      expect(processedPrompt).toContain('N+1 query detected in src/slow-query.ts');
      expect(processedPrompt).toContain('Use batch queries');
      expect(processedPrompt).toContain('Add database indexing');
      expect(processedPrompt).toContain('src/auth/login.ts (added)');
      expect(processedPrompt).toContain('src/auth/middleware.js (added)');
    });
  });

  describe('Error Handling and Edge Cases', () => {
    test('should handle missing dependency results gracefully', async () => {
      const provider = new AICheckProvider();

      const processedPrompt = await (provider as any).processPrompt(
        {
          content: `
{% if outputs.nonexistent %}
Has nonexistent results
{% else %}
No nonexistent results
{% endif %}

{% if outputs.security %}
Security results available
{% else %}
No security results
{% endif %}
          `,
        },
        mockPRInfo
      );

      expect(processedPrompt).toContain('No nonexistent results');
      expect(processedPrompt).toContain('No security results');
    });

    test('should handle file extension edge cases', async () => {
      const prInfoWithEdgeCases: PRInfo = {
        ...mockPRInfo,
        files: [
          {
            filename: 'Dockerfile',
            additions: 10,
            deletions: 0,
            changes: 10,
            status: 'added',
          },
          {
            filename: '.env.example',
            additions: 5,
            deletions: 0,
            changes: 5,
            status: 'added',
          },
          {
            filename: 'file-without-extension',
            additions: 2,
            deletions: 1,
            changes: 3,
            status: 'modified',
          },
        ],
      };

      const provider = new AICheckProvider();

      const processedPrompt = await (provider as any).processPrompt(
        {
          content: `
Files by extension:
{% for ext in utils.filesByExtension %}
- {{ ext[0] }}: {{ ext[1].size }} files
{% endfor %}
          `,
        },
        prInfoWithEdgeCases
      );

      // Files without extensions should be grouped under 'noext'
      expect(processedPrompt).toContain('example: 1 files');
      expect(processedPrompt).toContain('noext: 2 files'); // Dockerfile and file-without-extension
    });
  });
});
