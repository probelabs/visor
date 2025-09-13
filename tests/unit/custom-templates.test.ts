import { PRReviewer } from '../../src/reviewer';
import { CustomTemplateConfig } from '../../src/types/config';
import fs from 'fs/promises';
import { Octokit } from '@octokit/rest';

// Mock filesystem operations
jest.mock('fs/promises');

describe('Custom Templates', () => {
  let reviewer: PRReviewer;
  let mockFs: jest.Mocked<typeof fs>;

  beforeEach(() => {
    // Mock Octokit
    const mockOctokit = {
      rest: {
        issues: {
          createComment: jest.fn(),
          updateComment: jest.fn(),
          listComments: jest.fn().mockResolvedValue({ data: [] }),
        },
      },
    } as unknown as Octokit;

    reviewer = new PRReviewer(mockOctokit);
    mockFs = fs as jest.Mocked<typeof fs>;
    mockFs.readFile = jest.fn();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('Raw template content', () => {
    test('should use raw template content when provided', async () => {
      const customTemplate: CustomTemplateConfig = {
        content: '# Custom Template\n\n{{ content }}\n\n**Issues:** {{ issues | size }}',
      };

      const mockIssues = [
        {
          file: 'test.ts',
          line: 1,
          ruleId: 'custom-check/test-rule',
          message: 'Test issue',
          severity: 'warning' as const,
          category: 'style' as const,
          schema: 'code-review', // Use code-review schema to get issues array
          template: customTemplate,
        },
      ];

      // Access the private method for testing
      const result = await (reviewer as any).renderSingleCheckTemplate(
        'custom-check',
        mockIssues,
        'code-review',
        customTemplate
      );

      expect(result).toContain('# Custom Template');
      expect(result).toContain('**Issues:** 1');
      expect(mockFs.readFile).not.toHaveBeenCalled(); // Should not read any files
    });

    test('should handle complex liquid template syntax', async () => {
      const customTemplate: CustomTemplateConfig = {
        content: `
{% if issues.size > 0 %}
## Issues Found ({{ issues.size }})
{% for issue in issues %}
- **{{ issue.severity | upcase }}**: {{ issue.message }} ({{ issue.file }}:{{ issue.line }})
{% endfor %}
{% else %}
## No Issues Found ✅
{% endif %}
        `,
      };

      const mockIssues = [
        {
          file: 'test.ts',
          line: 10,
          ruleId: 'security/test',
          message: 'SQL injection vulnerability',
          severity: 'critical' as const,
          category: 'security' as const,
          template: customTemplate,
        },
        {
          file: 'utils.ts',
          line: 25,
          ruleId: 'performance/test',
          message: 'Inefficient loop',
          severity: 'warning' as const,
          category: 'performance' as const,
          template: customTemplate,
        },
      ];

      const result = await (reviewer as any).renderSingleCheckTemplate(
        'security-check',
        mockIssues,
        'code-review',
        customTemplate
      );

      expect(result).toContain('## Issues Found (2)');
      expect(result).toContain('**CRITICAL**: SQL injection vulnerability (test.ts:10)');
      expect(result).toContain('**WARNING**: Inefficient loop (utils.ts:25)');
    });
  });

  describe('Template file loading', () => {
    test('should load template from relative file path', async () => {
      const templateContent =
        '# File Template\n\n{{ checkName }} found {{ issues | size }} issues.';
      mockFs.readFile.mockResolvedValue(templateContent);

      const customTemplate: CustomTemplateConfig = {
        file: 'templates/custom.liquid',
      };

      const mockIssues = [
        {
          file: 'test.ts',
          line: 1,
          ruleId: 'test/rule',
          message: 'Test message',
          severity: 'info' as const,
          category: 'style' as const,
          template: customTemplate,
        },
      ];

      const result = await (reviewer as any).renderSingleCheckTemplate(
        'my-check',
        mockIssues,
        'code-review',
        customTemplate
      );

      expect(result).toContain('# File Template');
      expect(result).toContain('my-check found 1 issues');
      expect(mockFs.readFile).toHaveBeenCalledWith(
        expect.stringMatching(/templates[/\\]custom\.liquid$/),
        'utf-8'
      );
    });

    test('should load template from absolute file path', async () => {
      const templateContent = '## Absolute Template\n\nResults: {{ content }}';
      mockFs.readFile.mockResolvedValue(templateContent);

      const absolutePath = '/home/user/custom-template.liquid';
      const customTemplate: CustomTemplateConfig = {
        file: absolutePath,
      };

      const mockIssues = [
        {
          file: 'test.ts',
          line: 1,
          ruleId: 'test/rule',
          message: 'Test content',
          severity: 'info' as const,
          category: 'style' as const,
          schema: 'plain',
          template: customTemplate,
        },
      ];

      const result = await (reviewer as any).renderSingleCheckTemplate(
        'test-check',
        mockIssues,
        'plain',
        customTemplate
      );

      expect(result).toContain('## Absolute Template');
      expect(mockFs.readFile).toHaveBeenCalledWith(absolutePath, 'utf-8');
    });

    test('should handle file read errors gracefully', async () => {
      mockFs.readFile.mockRejectedValue(new Error('File not found'));

      const customTemplate: CustomTemplateConfig = {
        file: 'nonexistent.liquid',
      };

      const mockIssues = [
        {
          file: 'test.ts',
          line: 1,
          ruleId: 'test/rule',
          message: 'Test',
          severity: 'info' as const,
          category: 'style' as const,
          template: customTemplate,
        },
      ];

      await expect(
        (reviewer as any).renderSingleCheckTemplate('test', mockIssues, 'plain', customTemplate)
      ).rejects.toThrow('Failed to load custom template');
    });
  });

  describe('Security validation', () => {
    test('should reject path traversal attempts in file paths', async () => {
      const customTemplate: CustomTemplateConfig = {
        file: '../../../etc/passwd',
      };

      const mockIssues = [
        {
          file: 'test.ts',
          line: 1,
          ruleId: 'test/rule',
          message: 'Test',
          severity: 'info' as const,
          category: 'style' as const,
          template: customTemplate,
        },
      ];

      await expect(
        (reviewer as any).renderSingleCheckTemplate('test', mockIssues, 'plain', customTemplate)
      ).rejects.toThrow('path traversal detected');
    });

    test('should reject non-liquid file extensions', async () => {
      const customTemplate: CustomTemplateConfig = {
        file: 'malicious.js',
      };

      const mockIssues = [
        {
          file: 'test.ts',
          line: 1,
          ruleId: 'test/rule',
          message: 'Test',
          severity: 'info' as const,
          category: 'style' as const,
          template: customTemplate,
        },
      ];

      await expect(
        (reviewer as any).renderSingleCheckTemplate('test', mockIssues, 'plain', customTemplate)
      ).rejects.toThrow('must have .liquid extension');
    });

    test('should handle path normalization correctly', async () => {
      const templateContent = 'Normalized template';
      mockFs.readFile.mockResolvedValue(templateContent);

      const customTemplate: CustomTemplateConfig = {
        file: './templates/../templates/safe.liquid',
      };

      const mockIssues = [
        {
          file: 'test.ts',
          line: 1,
          ruleId: 'test/rule',
          message: 'Test',
          severity: 'info' as const,
          category: 'style' as const,
          template: customTemplate,
        },
      ];

      const result = await (reviewer as any).renderSingleCheckTemplate(
        'test',
        mockIssues,
        'plain',
        customTemplate
      );

      expect(result).toContain('Normalized template');
      expect(mockFs.readFile).toHaveBeenCalledWith(
        expect.stringMatching(/templates[/\\]safe\.liquid$/),
        'utf-8'
      );
    });
  });

  describe('Configuration validation', () => {
    test('should require either file or content', async () => {
      const customTemplate: CustomTemplateConfig = {}; // Neither file nor content

      const mockIssues = [
        {
          file: 'test.ts',
          line: 1,
          ruleId: 'test/rule',
          message: 'Test',
          severity: 'info' as const,
          category: 'style' as const,
          template: customTemplate,
        },
      ];

      await expect(
        (reviewer as any).renderSingleCheckTemplate('test', mockIssues, 'plain', customTemplate)
      ).rejects.toThrow('must specify either "file" or "content"');
    });

    test('should prioritize content over file when both are provided', async () => {
      const customTemplate: CustomTemplateConfig = {
        content: '# Content Template',
        file: 'should-not-be-loaded.liquid',
      };

      const mockIssues = [
        {
          file: 'test.ts',
          line: 1,
          ruleId: 'test/rule',
          message: 'Test',
          severity: 'info' as const,
          category: 'style' as const,
          template: customTemplate,
        },
      ];

      const result = await (reviewer as any).renderSingleCheckTemplate(
        'test',
        mockIssues,
        'plain',
        customTemplate
      );

      expect(result).toContain('# Content Template');
      expect(mockFs.readFile).not.toHaveBeenCalled(); // File should not be read
    });
  });

  describe('Fallback behavior', () => {
    test('should use schema-based template when no custom template is provided', async () => {
      // Mock the schema template file
      mockFs.readFile.mockResolvedValue('{{ content }}');

      const mockIssues = [
        {
          file: 'test.ts',
          line: 1,
          ruleId: 'test/rule',
          message: 'Default template test',
          severity: 'info' as const,
          category: 'style' as const,
          schema: 'plain',
        },
      ];

      await (reviewer as any).renderSingleCheckTemplate(
        'test',
        mockIssues,
        'plain'
        // No custom template provided
      );

      expect(mockFs.readFile).toHaveBeenCalledWith(
        expect.stringMatching(/output[/\\]plain[/\\]template\.liquid$/),
        'utf-8'
      );
    });
  });
});
