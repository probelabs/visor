import { AICheckProvider } from '../../src/providers/ai-check-provider';
import { PRInfo } from '../../src/pr-analyzer';
import { CheckProviderConfig } from '../../src/providers/check-provider.interface';
import { PromptConfig } from '../../src/types/config';
import fs from 'fs/promises';

// Mock filesystem operations
jest.mock('fs/promises');

describe('Enhanced Prompts', () => {
  let provider: AICheckProvider;
  let mockFs: jest.Mocked<typeof fs>;

  const mockPRInfo: PRInfo = {
    number: 123,
    title: 'Add new feature',
    body: 'This PR adds a new feature for user authentication',
    author: 'developer',
    base: 'main',
    head: 'feature/auth',
    files: [
      {
        filename: 'src/auth.ts',
        additions: 50,
        deletions: 5,
        changes: 55,
        status: 'added',
      },
      {
        filename: 'src/utils.js',
        additions: 10,
        deletions: 2,
        changes: 12,
        status: 'modified',
      },
    ],
    totalAdditions: 60,
    totalDeletions: 7,
    isIncremental: false,
  };

  beforeEach(() => {
    provider = new AICheckProvider();
    mockFs = fs as jest.Mocked<typeof fs>;
    mockFs.readFile = jest.fn();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Liquid Template Processing in Prompts', () => {
    test('should process Liquid templates in string prompts', async () => {
      const config: CheckProviderConfig = {
        type: 'ai',
        prompt:
          'Review PR #{{ pr.number }}: "{{ pr.title }}" by {{ pr.author }}. Total files: {{ files.size }}',
      };

      // Access private method for testing
      const processedPrompt = await (provider as any).processPrompt(config.prompt, mockPRInfo);

      expect(processedPrompt).toBe(
        'Review PR #123: "Add new feature" by developer. Total files: 2'
      );
    });

    test('should process complex Liquid templates with loops and conditions', async () => {
      const config: CheckProviderConfig = {
        type: 'ai',
        prompt: `
{% if pr.isIncremental %}
Review incremental changes for PR {{ pr.number }}
{% else %}
Review full PR {{ pr.number }}: {{ pr.title }}
{% endif %}

Files changed:
{% for file in files %}
- {{ file.filename }} (+{{ file.additions }}/-{{ file.deletions }})
{% endfor %}

{% if utils.hasLargeChanges %}
This PR contains large changes that require careful review.
{% endif %}
        `,
      };

      const processedPrompt = await (provider as any).processPrompt(config.prompt, mockPRInfo);

      expect(processedPrompt).toContain('Review full PR 123: Add new feature');
      expect(processedPrompt).toContain('- src/auth.ts (+50/-5)');
      expect(processedPrompt).toContain('- src/utils.js (+10/-2)');
      expect(processedPrompt).toContain('This PR contains large changes');
    });

    test('should process event context in templates', async () => {
      const eventContext = {
        event_name: 'pull_request',
        action: 'opened',
        repository: {
          owner: { login: 'myorg' },
          name: 'myrepo',
        },
        comment: {
          body: '/review security',
          user: { login: 'reviewer' },
        },
      };

      const config: CheckProviderConfig = {
        type: 'ai',
        prompt: `
Event: {{ event.name }} - {{ event.action }}
Repository: {{ event.repository.fullName }}
{% if event.comment %}
Comment by {{ event.comment.author }}: {{ event.comment.body }}
{% endif %}
        `,
        eventContext,
      };

      const processedPrompt = await (provider as any).processPrompt(
        config.prompt,
        mockPRInfo,
        eventContext
      );

      expect(processedPrompt).toContain('Event: pull_request - opened');
      expect(processedPrompt).toContain('Repository: myorg/myrepo');
      expect(processedPrompt).toContain('Comment by reviewer: /review security');
    });
  });

  describe('Prompt File Loading', () => {
    test('should load prompt from file with PromptConfig', async () => {
      const promptContent = `
Review PR {{ pr.number }} for security issues.

Files to check:
{% for file in files %}
{% if file.filename contains '.ts' %}
- {{ file.filename }} (TypeScript file)
{% endif %}
{% endfor %}
      `;

      mockFs.readFile.mockResolvedValue(promptContent);

      const promptConfig: PromptConfig = {
        file: 'prompts/security-review.txt',
      };

      const config: CheckProviderConfig = {
        type: 'ai',
        prompt: promptConfig,
      };

      const processedPrompt = await (provider as any).processPrompt(config.prompt, mockPRInfo);

      expect(processedPrompt).toContain('Review PR 123 for security issues');
      expect(processedPrompt).toContain('- src/auth.ts (TypeScript file)');
      expect(mockFs.readFile).toHaveBeenCalledWith(
        expect.stringMatching(/prompts[/\\]security-review\.txt$/),
        'utf-8'
      );
    });

    test('should prioritize content over file in PromptConfig', async () => {
      const promptConfig: PromptConfig = {
        content: 'Inline prompt for PR {{ pr.number }}',
        file: 'should-not-be-loaded.txt',
      };

      const config: CheckProviderConfig = {
        type: 'ai',
        prompt: promptConfig,
      };

      const processedPrompt = await (provider as any).processPrompt(config.prompt, mockPRInfo);

      expect(processedPrompt).toBe('Inline prompt for PR 123');
      expect(mockFs.readFile).not.toHaveBeenCalled();
    });

    test('should handle file read errors gracefully', async () => {
      mockFs.readFile.mockRejectedValue(new Error('File not found'));

      const promptConfig: PromptConfig = {
        file: 'nonexistent.txt',
      };

      const config: CheckProviderConfig = {
        type: 'ai',
        prompt: promptConfig,
      };

      await expect((provider as any).processPrompt(config.prompt, mockPRInfo)).rejects.toThrow(
        'Failed to load prompt from'
      );
    });
  });

  describe('Security Validation for Prompt Files', () => {
    test('should reject path traversal in prompt files', async () => {
      const promptConfig: PromptConfig = {
        file: '../../../etc/passwd',
      };

      const config: CheckProviderConfig = {
        type: 'ai',
        prompt: promptConfig,
      };

      await expect((provider as any).processPrompt(config.prompt, mockPRInfo)).rejects.toThrow(
        'path traversal detected'
      );
    });

    test('should handle path normalization correctly', async () => {
      mockFs.readFile.mockResolvedValue('Safe prompt content for PR {{ pr.number }}');

      const promptConfig: PromptConfig = {
        file: './prompts/../prompts/safe.txt',
      };

      const config: CheckProviderConfig = {
        type: 'ai',
        prompt: promptConfig,
      };

      const processedPrompt = await (provider as any).processPrompt(config.prompt, mockPRInfo);

      expect(processedPrompt).toBe('Safe prompt content for PR 123');
      expect(mockFs.readFile).toHaveBeenCalledWith(
        expect.stringMatching(/prompts[/\\]safe\.txt$/),
        'utf-8'
      );
    });
  });

  describe('Template Context Utilities', () => {
    test('should provide dynamic file type utilities', async () => {
      const config: CheckProviderConfig = {
        type: 'ai',
        prompt: `
TypeScript files: {{ utils.filesByExtension.ts.size }}
JavaScript files: {{ utils.filesByExtension.js.size }}
Added files: {{ utils.addedFiles.size }}
Total files: {{ utils.totalFiles }}
        `,
      };

      const processedPrompt = await (provider as any).processPrompt(config.prompt, mockPRInfo);

      expect(processedPrompt).toContain('TypeScript files: 1');
      expect(processedPrompt).toContain('JavaScript files: 1');
      expect(processedPrompt).toContain('Added files: 1');
      expect(processedPrompt).toContain('Total files: 2');
    });

    test('should provide date/time utilities', async () => {
      const config: CheckProviderConfig = {
        type: 'ai',
        prompt: 'Review timestamp: {{ utils.now }} (date: {{ utils.today }})',
      };

      const processedPrompt = await (provider as any).processPrompt(config.prompt, mockPRInfo);

      expect(processedPrompt).toMatch(/Review timestamp: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
      expect(processedPrompt).toMatch(/date: \d{4}-\d{2}-\d{2}/);
    });
  });

  describe('Configuration Validation', () => {
    test('should require either file or content in PromptConfig', async () => {
      const promptConfig: PromptConfig = {}; // Neither file nor content

      const config: CheckProviderConfig = {
        type: 'ai',
        prompt: promptConfig,
      };

      await expect((provider as any).processPrompt(config.prompt, mockPRInfo)).rejects.toThrow(
        'must specify either "file" or "content"'
      );
    });

    test('should handle template rendering errors', async () => {
      const config: CheckProviderConfig = {
        type: 'ai',
        prompt: 'Invalid template: {% for x in nonexistent %}{{ x }}{% endfor',
      };

      await expect((provider as any).processPrompt(config.prompt, mockPRInfo)).rejects.toThrow(
        'Failed to render prompt template'
      );
    });
  });

  describe('Dependency Results Integration', () => {
    test('should include dependency results in template context', async () => {
      const mockDependencyResults = new Map();
      mockDependencyResults.set('security', {
        issues: [
          {
            file: 'auth.ts',
            line: 10,
            severity: 'critical',
            category: 'security',
            message: 'SQL injection vulnerability',
          },
          {
            file: 'utils.js',
            line: 5,
            severity: 'warning',
            category: 'performance',
            message: 'Inefficient loop',
          },
        ],
        suggestions: ['Use parameterized queries', 'Optimize loop performance'],
      });

      mockDependencyResults.set('style', {
        issues: [
          {
            file: 'module.ts',
            line: 15,
            severity: 'info',
            category: 'style',
            message: 'Consider consistent naming',
          },
        ],
        suggestions: ['Use consistent naming patterns'],
      });

      const config: CheckProviderConfig = {
        type: 'ai',
        prompt: `
Previous Results Summary:
- Security check found {{ outputs.security.totalIssues }} issues ({{ outputs.security.criticalIssues }} critical)
- Style check found {{ outputs.style.totalIssues }} issues

Security Issues:
{% for issue in outputs.security.securityIssues %}
- {{ issue.severity | upcase }}: {{ issue.message }} in {{ issue.file }}:{{ issue.line }}
{% endfor %}

Suggestions from security check:
{% for suggestion in outputs.security.suggestions %}
- {{ suggestion }}
{% endfor %}
        `,
      };

      const processedPrompt = await (provider as any).processPrompt(
        config.prompt,
        mockPRInfo,
        undefined,
        mockDependencyResults
      );

      expect(processedPrompt).toContain('Security check found 2 issues (1 critical)');
      expect(processedPrompt).toContain('Style check found 1 issues');
      expect(processedPrompt).toContain('CRITICAL: SQL injection vulnerability in auth.ts:10');
      expect(processedPrompt).toContain('- Use parameterized queries');
      expect(processedPrompt).toContain('- Optimize loop performance');
    });

    test('should handle empty dependency results', async () => {
      const config: CheckProviderConfig = {
        type: 'ai',
        prompt: `
{% if outputs.security %}
Security issues: {{ outputs.security.totalIssues }}
{% else %}
No previous security results available
{% endif %}
        `,
      };

      const processedPrompt = await (provider as any).processPrompt(config.prompt, mockPRInfo);

      expect(processedPrompt).toContain('No previous security results available');
    });

    test('should provide categorized issue counts', async () => {
      const mockDependencyResults = new Map();
      mockDependencyResults.set('comprehensive', {
        issues: [
          { severity: 'critical', category: 'security', message: 'Critical security issue' },
          { severity: 'error', category: 'logic', message: 'Logic error' },
          { severity: 'warning', category: 'performance', message: 'Performance warning' },
          { severity: 'info', category: 'style', message: 'Style suggestion' },
        ],
      });

      const config: CheckProviderConfig = {
        type: 'ai',
        prompt: `
Issue Summary:
- Critical: {{ outputs.comprehensive.criticalIssues }}
- Errors: {{ outputs.comprehensive.errorIssues }}  
- Warnings: {{ outputs.comprehensive.warningIssues }}
- Info: {{ outputs.comprehensive.infoIssues }}
- Security Issues: {{ outputs.comprehensive.securityIssues.size }}
- Performance Issues: {{ outputs.comprehensive.performanceIssues.size }}
        `,
      };

      const processedPrompt = await (provider as any).processPrompt(
        config.prompt,
        mockPRInfo,
        undefined,
        mockDependencyResults
      );

      expect(processedPrompt).toContain('Critical: 1');
      expect(processedPrompt).toContain('Errors: 1');
      expect(processedPrompt).toContain('Warnings: 1');
      expect(processedPrompt).toContain('Info: 1');
      expect(processedPrompt).toContain('Security Issues: 1');
      expect(processedPrompt).toContain('Performance Issues: 1');
    });
  });
});
