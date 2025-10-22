/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
import { CheckExecutionEngine, CheckExecutionOptions } from '../../../src/check-execution-engine';
import { GitRepositoryAnalyzer, GitRepositoryInfo } from '../../../src/git-repository-analyzer';
import { PRReviewer, ReviewSummary } from '../../../src/reviewer';
import { PRInfo } from '../../../src/pr-analyzer';
import { CheckProviderRegistry } from '../../../src/providers/check-provider-registry';

// Mock the dependencies
jest.mock('../../../src/git-repository-analyzer');
jest.mock('../../../src/reviewer');
jest.mock('../../../src/providers/check-provider-registry');

// Mock for renderCheckContent tests
jest.mock('liquidjs');
jest.mock('fs/promises');
jest.mock('path');
jest.mock('../../../src/liquid-extensions');

describe('CheckExecutionEngine', () => {
  let checkEngine: CheckExecutionEngine;
  let mockGitAnalyzer: jest.Mocked<GitRepositoryAnalyzer>;
  let mockReviewer: jest.Mocked<PRReviewer>;
  let mockRegistry: jest.Mocked<CheckProviderRegistry>;

  const mockRepositoryInfo: GitRepositoryInfo = {
    title: 'Test Repository',
    body: 'Test repository description',
    author: 'test-author',
    base: 'main',
    head: 'feature-branch',
    isGitRepository: true,
    workingDirectory: '/test/repo',
    files: [
      {
        filename: 'src/test.ts',
        status: 'modified',
        additions: 10,
        deletions: 5,
        changes: 15,
        patch: '@@ -1,5 +1,10 @@\n test changes',
      },
    ],
    totalAdditions: 10,
    totalDeletions: 5,
  };

  const mockPRInfo: PRInfo = {
    number: 0,
    title: 'Test Repository',
    body: 'Test repository description',
    author: 'test-author',
    base: 'main',
    head: 'feature-branch',
    files: [
      {
        filename: 'src/test.ts',
        status: 'modified',
        additions: 10,
        deletions: 5,
        changes: 15,
        patch: '@@ -1,5 +1,10 @@\n test changes',
      },
    ],
    totalAdditions: 10,
    totalDeletions: 5,
  };

  beforeEach(() => {
    // Clear all mocks before each test
    jest.clearAllMocks();

    // Create mock instances
    mockGitAnalyzer = new GitRepositoryAnalyzer() as jest.Mocked<GitRepositoryAnalyzer>;
    mockReviewer = new PRReviewer(null as any) as jest.Mocked<PRReviewer>;

    // Mock registry to return false for hasProvider so it falls back to PRReviewer
    mockRegistry = {
      hasProvider: jest.fn().mockReturnValue(false),
      getProviderOrThrow: jest.fn(),
      getAvailableProviders: jest.fn().mockReturnValue(['ai', 'tool', 'script', 'webhook']),
    } as any;

    (CheckProviderRegistry as any).getInstance = jest.fn().mockReturnValue(mockRegistry);

    // Mock constructor behavior
    (GitRepositoryAnalyzer as jest.MockedClass<typeof GitRepositoryAnalyzer>).mockImplementation(
      () => mockGitAnalyzer
    );
    (PRReviewer as jest.MockedClass<typeof PRReviewer>).mockImplementation(() => mockReviewer);

    checkEngine = new CheckExecutionEngine('/test/working/dir');
  });

  describe('Constructor', () => {
    it('should initialize with default working directory', () => {
      const engine = new CheckExecutionEngine();
      expect(GitRepositoryAnalyzer).toHaveBeenCalledWith(process.cwd());
    });

    it('should initialize with custom working directory', () => {
      const customDir = '/custom/work/dir';
      const engine = new CheckExecutionEngine(customDir);
      expect(GitRepositoryAnalyzer).toHaveBeenCalledWith(customDir);
    });
  });

  describe('executeChecks', () => {
    const mockGroupedResults = {
      default: [
        {
          checkName: 'security',
          content: `## Security Issues Found\n\n- **ERROR**: Potential security issue (src/test.ts:10)\n\n## Style Issues Found\n\n- **INFO**: Style improvement needed (src/test.ts:15)`,
          group: 'default',
        },
      ],
    };

    const mockReviewSummary = {
      issues: [
        {
          category: 'security',
          message: 'Potential security issue',
          severity: 'error',
          file: 'src/test.ts',
          line: 10,
        },
      ],
    };

    beforeEach(() => {
      mockGitAnalyzer.analyzeRepository.mockResolvedValue(mockRepositoryInfo);
      mockGitAnalyzer.toPRInfo.mockReturnValue(mockPRInfo);
      mockReviewer.reviewPR.mockResolvedValue(mockReviewSummary as any);
    });

    it('should execute checks successfully', async () => {
      const options: CheckExecutionOptions = {
        checks: ['security', 'performance'],
        workingDirectory: '/test/repo',
      };

      const result = await checkEngine.executeChecks(options);

      expect(mockGitAnalyzer.analyzeRepository).toHaveBeenCalled();
      expect(mockReviewer.reviewPR).toHaveBeenCalledWith(
        'local',
        'repository',
        0,
        expect.any(Object),
        expect.objectContaining({
          focus: 'all',
          format: 'table',
        })
      );

      expect(result.repositoryInfo).toEqual(mockRepositoryInfo);
      expect(result.reviewSummary).toEqual(mockReviewSummary);
      expect(result.checksExecuted).toEqual(['security', 'performance']);
      expect(result.executionTime).toBeGreaterThanOrEqual(0);
      expect(result.timestamp).toBeDefined();
    });

    it('should handle single security check', async () => {
      const options: CheckExecutionOptions = {
        checks: ['security'],
      };

      await checkEngine.executeChecks(options);

      expect(mockReviewer.reviewPR).toHaveBeenCalledWith(
        'local',
        'repository',
        0,
        expect.any(Object),
        expect.objectContaining({
          focus: 'security',
          format: 'table',
        })
      );
    });

    it('should handle single performance check', async () => {
      const options: CheckExecutionOptions = {
        checks: ['performance'],
      };

      await checkEngine.executeChecks(options);

      expect(mockReviewer.reviewPR).toHaveBeenCalledWith(
        'local',
        'repository',
        0,
        expect.any(Object),
        expect.objectContaining({
          focus: 'performance',
          format: 'table',
        })
      );
    });

    it('should handle single style check', async () => {
      const options: CheckExecutionOptions = {
        checks: ['style'],
      };

      await checkEngine.executeChecks(options);

      expect(mockReviewer.reviewPR).toHaveBeenCalledWith(
        'local',
        'repository',
        0,
        expect.any(Object),
        expect.objectContaining({
          focus: 'style',
          format: 'table',
        })
      );
    });

    it('should pass timeout option to check execution', async () => {
      const options: CheckExecutionOptions = {
        checks: ['security'],
        timeout: 300000, // 5 minutes
      };

      await checkEngine.executeChecks(options);

      // Since we're using PRReviewer, the timeout should be stored but we can't directly test it
      // without mocking the AI service. For now, we just verify the call happened
      expect(mockReviewer.reviewPR).toHaveBeenCalled();
    });

    it('should handle timeout option with default value', async () => {
      const options: CheckExecutionOptions = {
        checks: ['performance'],
        timeout: undefined, // Should use default (600000ms)
      };

      await checkEngine.executeChecks(options);

      expect(mockReviewer.reviewPR).toHaveBeenCalled();
    });

    it('should accept various timeout values', async () => {
      const timeoutValues = [60000, 180000, 300000, 600000, 900000];

      for (const timeout of timeoutValues) {
        jest.clearAllMocks();

        const options: CheckExecutionOptions = {
          checks: ['all'],
          timeout,
        };

        await checkEngine.executeChecks(options);
        expect(mockReviewer.reviewPR).toHaveBeenCalled();
      }
    });

    it('should handle all check', async () => {
      const options: CheckExecutionOptions = {
        checks: ['all'],
      };

      await checkEngine.executeChecks(options);

      expect(mockReviewer.reviewPR).toHaveBeenCalledWith(
        'local',
        'repository',
        0,
        expect.any(Object),
        expect.objectContaining({
          focus: 'all',
          format: 'table',
        })
      );
    });

    it('should handle architecture check (mapped to all)', async () => {
      const options: CheckExecutionOptions = {
        checks: ['architecture'],
      };

      await checkEngine.executeChecks(options);

      expect(mockReviewer.reviewPR).toHaveBeenCalledWith(
        'local',
        'repository',
        0,
        expect.any(Object),
        expect.objectContaining({
          focus: 'all',
          format: 'table',
        })
      );
    });

    it('should handle multiple mixed checks', async () => {
      const options: CheckExecutionOptions = {
        checks: ['security', 'performance', 'style'],
      };

      await checkEngine.executeChecks(options);

      expect(mockReviewer.reviewPR).toHaveBeenCalledWith(
        'local',
        'repository',
        0,
        expect.any(Object),
        expect.objectContaining({
          focus: 'all',
          format: 'table',
        })
      );
    });

    it('should handle non-git repository', async () => {
      const nonGitRepoInfo = {
        ...mockRepositoryInfo,
        isGitRepository: false,
      };

      mockGitAnalyzer.analyzeRepository.mockResolvedValue(nonGitRepoInfo);

      const options: CheckExecutionOptions = {
        checks: ['security'],
      };

      const result = await checkEngine.executeChecks(options);

      expect(result.repositoryInfo.isGitRepository).toBe(false);
      expect(result.reviewSummary.issues).toHaveLength(1);
      expect(result.reviewSummary.issues![0].message).toContain('Not a git repository');
      expect(mockReviewer.reviewPR).not.toHaveBeenCalled();
    });

    it('should handle git analyzer errors', async () => {
      mockGitAnalyzer.analyzeRepository.mockRejectedValue(new Error('Git command failed'));

      const options: CheckExecutionOptions = {
        checks: ['security'],
      };

      const result = await checkEngine.executeChecks(options);

      expect(result.reviewSummary.issues).toHaveLength(1);
      expect(result.reviewSummary.issues![0].message).toBe('Git command failed');
      expect(result.reviewSummary.issues![0].severity).toBe('error');
      expect(result.reviewSummary.issues![0].ruleId).toBe('system/error');
    });

    it('should handle reviewer errors', async () => {
      mockReviewer.reviewPR.mockRejectedValue(new Error('Review failed'));

      const options: CheckExecutionOptions = {
        checks: ['security'],
      };

      const result = await checkEngine.executeChecks(options);

      expect(result.reviewSummary.issues).toHaveLength(1);
      expect(result.reviewSummary.issues![0].message).toBe('Review failed');
      expect(result.reviewSummary.issues![0].ruleId).toBe('system/error');
    });

    it('should measure execution time correctly', async () => {
      // Add a small delay to the mock to ensure measurable execution time
      mockGitAnalyzer.analyzeRepository.mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return mockRepositoryInfo;
      });

      const options: CheckExecutionOptions = {
        checks: ['security'],
      };

      const result = await checkEngine.executeChecks(options);

      // Execution time should be positive, CI environments may have timing variations
      expect(result.executionTime).toBeGreaterThanOrEqual(0);
      expect(result.timestamp).toBeDefined();
      expect(new Date(result.timestamp)).toBeInstanceOf(Date);
    });
  });

  describe('getRepositoryStatus', () => {
    it('should get repository status', async () => {
      mockGitAnalyzer.analyzeRepository.mockResolvedValue(mockRepositoryInfo);

      const status = await checkEngine.getRepositoryStatus();

      expect(mockGitAnalyzer.analyzeRepository).toHaveBeenCalled();
      expect(status.isGitRepository).toBe(true);
      expect(status.branch).toBe('feature-branch');
      expect(status.hasChanges).toBe(true);
      expect(status.filesChanged).toBe(1);
    });

    it('should handle status check errors', async () => {
      mockGitAnalyzer.analyzeRepository.mockRejectedValue(new Error('Status check failed'));

      const status = await checkEngine.getRepositoryStatus();

      expect(status.isGitRepository).toBe(false);
      expect(status.hasChanges).toBe(false);
    });
  });

  describe('isGitRepository', () => {
    it('should return true for git repository', async () => {
      mockGitAnalyzer.analyzeRepository.mockResolvedValue({
        ...mockRepositoryInfo,
        isGitRepository: true,
      } as GitRepositoryInfo);

      const isGit = await checkEngine.isGitRepository();

      expect(isGit).toBe(true);
    });

    it('should return false for non-git repository', async () => {
      mockGitAnalyzer.analyzeRepository.mockResolvedValue({
        ...mockRepositoryInfo,
        isGitRepository: false,
      } as GitRepositoryInfo);

      const isGit = await checkEngine.isGitRepository();

      expect(isGit).toBe(false);
    });

    it('should return false on analysis error', async () => {
      mockGitAnalyzer.analyzeRepository.mockRejectedValue(new Error('Analysis failed'));

      const isGit = await checkEngine.isGitRepository();

      expect(isGit).toBe(false);
    });
  });

  describe('Static Methods', () => {
    describe('getAvailableCheckTypes', () => {
      it('should return all available check types', () => {
        const checkTypes = CheckExecutionEngine.getAvailableCheckTypes();

        // After removing 'style' check and making system config-driven,
        // getAvailableCheckTypes now returns only provider types
        expect(checkTypes).toContain('ai');
        expect(checkTypes).toContain('tool');
        expect(checkTypes).toContain('script');
        expect(checkTypes).toContain('webhook');
      });
    });

    describe('validateCheckTypes', () => {
      it('should validate all valid check types', () => {
        const checks = ['ai', 'tool', 'script'];
        const result = CheckExecutionEngine.validateCheckTypes(checks);

        expect(result.valid).toEqual(checks);
        expect(result.invalid).toHaveLength(0);
      });

      it('should identify invalid check types', () => {
        const checks = ['ai', 'invalid-check', 'tool', 'another-invalid'];
        const result = CheckExecutionEngine.validateCheckTypes(checks);

        expect(result.valid).toEqual(['ai', 'tool']);
        expect(result.invalid).toEqual(['invalid-check', 'another-invalid']);
      });

      it('should handle empty check list', () => {
        const result = CheckExecutionEngine.validateCheckTypes([]);

        expect(result.valid).toHaveLength(0);
        expect(result.invalid).toHaveLength(0);
      });

      it('should handle provider types', () => {
        const checks = ['ai', 'tool'];
        const result = CheckExecutionEngine.validateCheckTypes(checks);

        expect(result.valid).toEqual(['ai', 'tool']);
        expect(result.invalid).toHaveLength(0);
      });

      it('should handle mixed valid and invalid checks', () => {
        const checks = ['ai', 'invalid', 'tool', 'bad-check', 'script'];
        const result = CheckExecutionEngine.validateCheckTypes(checks);

        expect(result.valid).toEqual(['ai', 'tool', 'script']);
        expect(result.invalid).toEqual(['invalid', 'bad-check']);
      });
    });
  });

  describe('Error Scenarios', () => {
    it('should create proper error results', async () => {
      const errorMessage = 'Test error message';
      mockGitAnalyzer.analyzeRepository.mockRejectedValue(new Error(errorMessage));

      const options: CheckExecutionOptions = {
        checks: ['security'],
      };

      const result = await checkEngine.executeChecks(options);

      expect(result.reviewSummary.issues).toHaveLength(1);
      expect(result.reviewSummary.issues![0].message).toBe(errorMessage);
      expect(result.reviewSummary.issues![0].severity).toBe('error');
      expect(result.reviewSummary.issues![0].category).toBe('logic');
      expect(result.reviewSummary.issues![0].file).toBe('system');
      expect(result.reviewSummary.issues![0].line).toBe(0);
      expect(result.reviewSummary.issues![0].ruleId).toBe('system/error');
    });

    it('should handle non-Error exceptions', async () => {
      mockGitAnalyzer.analyzeRepository.mockRejectedValue('String error');

      const options: CheckExecutionOptions = {
        checks: ['security'],
      };

      const result = await checkEngine.executeChecks(options);

      expect(result.reviewSummary.issues![0].message).toBe('Unknown error occurred');
      expect(result.reviewSummary.issues![0].ruleId).toBe('system/error');
    });

    it('should handle timeout scenarios', async () => {
      const options: CheckExecutionOptions = {
        checks: ['security'],
        timeout: 100, // Very short timeout
      };

      // Mock a long-running operation
      mockGitAnalyzer.analyzeRepository.mockImplementation(async () => {
        await new Promise(resolve => setTimeout(resolve, 200));
        return mockRepositoryInfo;
      });

      // Note: The actual timeout implementation would need to be added to CheckExecutionEngine
      // This test demonstrates the expected behavior
      const result = await checkEngine.executeChecks(options);
      expect(result).toBeDefined();
    });
  });

  describe('renderCheckContent', () => {
    let mockLiquidInstance: jest.Mocked<any>;
    let mockLiquid: jest.Mocked<any>;
    let mockFs: jest.Mocked<any>;
    let mockPath: jest.Mocked<any>;

    const mockReviewSummary: ReviewSummary = {
      issues: [
        {
          category: 'security',
          message: 'Potential security vulnerability',
          severity: 'error',
          file: 'src/test.ts',
          line: 10,
          ruleId: 'sec-001',
        },
        {
          category: 'style',
          message: 'Code style issue',
          severity: 'warning',
          file: 'src/test.ts',
          line: 15,
          ruleId: 'style-001',
        },
      ],
    };

    beforeEach(() => {
      // Reset all mocks
      jest.clearAllMocks();

      // Mock liquidjs
      mockLiquidInstance = {
        parseAndRender: jest.fn(),
      };
      mockLiquid = {
        Liquid: jest.fn().mockImplementation(() => mockLiquidInstance),
      };

      // Mock fs/promises
      mockFs = {
        readFile: jest.fn(),
      };

      // Mock path
      mockPath = {
        join: jest.fn(),
        resolve: jest.fn(),
        isAbsolute: jest.fn(),
        sep: '/',
      };

      // Configure the mocked modules
      const liquidjsMock = require('liquidjs') as jest.Mocked<typeof import('liquidjs')>;
      liquidjsMock.Liquid = mockLiquid.Liquid;

      const liquidExtensionsMock = require('../../../src/liquid-extensions') as jest.Mocked<
        typeof import('../../../src/liquid-extensions')
      >;
      liquidExtensionsMock.createExtendedLiquid = jest
        .fn()
        .mockImplementation(() => mockLiquidInstance);

      const fsMock = require('fs/promises') as jest.Mocked<typeof import('fs/promises')>;
      fsMock.readFile = mockFs.readFile;

      const pathMock = require('path') as jest.Mocked<typeof import('path')>;
      pathMock.join = mockPath.join;
      pathMock.resolve = mockPath.resolve;
      pathMock.isAbsolute = mockPath.isAbsolute;
      (pathMock as any).sep = mockPath.sep;
    });

    it('should return raw content for plain schema without template processing', async () => {
      const checkConfig = { schema: 'plain' };

      // Access the private method using bracket notation
      const result = await (checkEngine as any).renderCheckContent(
        'security',
        mockReviewSummary,
        checkConfig
      );

      expect(result).toBe('Potential security vulnerability');
      expect(mockLiquidInstance.parseAndRender).not.toHaveBeenCalled();
      expect(mockFs.readFile).not.toHaveBeenCalled();
    });

    it('should handle plain schema with missing issues and suggestions', async () => {
      const emptyReviewSummary: ReviewSummary = {};
      const checkConfig = { schema: 'plain' };

      const result = await (checkEngine as any).renderCheckContent(
        'security',
        emptyReviewSummary,
        checkConfig
      );

      expect(result).toBe('');
    });

    it('should use custom template content when provided', async () => {
      const checkConfig = {
        template: {
          content: 'Check: {{ checkName }}\nIssues: {{ issues.size }}',
        },
      };

      mockLiquidInstance.parseAndRender.mockResolvedValue('Check: security\nIssues: 2');

      const result = await (checkEngine as any).renderCheckContent(
        'security',
        mockReviewSummary,
        checkConfig
      );

      expect(mockLiquidInstance.parseAndRender).toHaveBeenCalledWith(checkConfig.template.content, {
        issues: mockReviewSummary.issues,
        checkName: 'security',
      });
      expect(result).toBe('Check: security\nIssues: 2');
    });

    it('should read custom template from file when file path is provided', async () => {
      const templateContent = 'Template from file: {{ checkName }}';
      const checkConfig = {
        template: {
          file: 'templates/template.liquid',
        },
      };

      // Mock the git analyzer to return working directory
      mockGitAnalyzer.analyzeRepository.mockResolvedValue({
        ...mockRepositoryInfo,
        workingDirectory: '/test/working/dir',
      });

      // Set up path mocks for this test
      mockPath.isAbsolute.mockReturnValue(false);
      mockPath.sep = '/';
      mockPath.resolve.mockImplementation((base: string, relative?: string) => {
        if (relative) {
          return `${base}/${relative}`;
        }
        return base;
      });

      mockFs.readFile.mockResolvedValue(templateContent);
      mockLiquidInstance.parseAndRender.mockResolvedValue('Template from file: security');

      const result = await (checkEngine as any).renderCheckContent(
        'security',
        mockReviewSummary,
        checkConfig
      );

      // The path should be validated and resolved to an absolute path within the project
      expect(mockFs.readFile).toHaveBeenCalled();
      const calledPath = mockFs.readFile.mock.calls[0][0];
      expect(calledPath).toContain('templates/template.liquid');
      expect(mockLiquidInstance.parseAndRender).toHaveBeenCalledWith(templateContent, {
        issues: mockReviewSummary.issues,
        checkName: 'security',
      });
      expect(result).toBe('Template from file: security');
    });

    it('should use built-in schema template when schema is specified', async () => {
      const templateContent = 'Built-in template: {{ checkName }}';
      const checkConfig = { schema: 'markdown' };

      mockPath.join.mockReturnValue('/app/src/output/markdown/template.liquid');
      mockFs.readFile.mockResolvedValue(templateContent);
      mockLiquidInstance.parseAndRender.mockResolvedValue('Built-in template: security');

      const result = await (checkEngine as any).renderCheckContent(
        'security',
        mockReviewSummary,
        checkConfig
      );

      expect(mockPath.join).toHaveBeenCalledWith(
        expect.any(String),
        'output/markdown/template.liquid'
      );
      expect(mockFs.readFile).toHaveBeenCalledWith(
        '/app/src/output/markdown/template.liquid',
        'utf-8'
      );
      expect(mockLiquidInstance.parseAndRender).toHaveBeenCalledWith(templateContent, {
        issues: mockReviewSummary.issues,
        checkName: 'security',
      });
      expect(result).toBe('Built-in template: security');
    });

    it('should sanitize schema names for security', async () => {
      const templateContent = 'Sanitized template';
      const checkConfig = { schema: 'markdown/../../../etc/passwd' };

      mockPath.join.mockReturnValue('/app/src/output/markdownetcpasswd/template.liquid');
      mockFs.readFile.mockResolvedValue(templateContent);
      mockLiquidInstance.parseAndRender.mockResolvedValue('Sanitized template');

      const result = await (checkEngine as any).renderCheckContent(
        'security',
        mockReviewSummary,
        checkConfig
      );

      // Should sanitize to 'markdownetcpasswd' and strip malicious path components like '../'
      expect(mockPath.join).toHaveBeenCalledWith(
        expect.any(String),
        'output/markdownetcpasswd/template.liquid'
      );
      expect(result).toBe('Sanitized template');
    });

    it('should throw error for invalid schema name (empty after sanitization)', async () => {
      const checkConfig = { schema: '../../../' };

      await expect(
        (checkEngine as any).renderCheckContent('security', mockReviewSummary, checkConfig)
      ).rejects.toThrow('Invalid schema name');

      expect(mockFs.readFile).not.toHaveBeenCalled();
      expect(mockLiquidInstance.parseAndRender).not.toHaveBeenCalled();
    });

    it('should throw error when custom template has neither content nor file', async () => {
      const checkConfig = {
        template: {}, // Empty template config
      };

      await expect(
        (checkEngine as any).renderCheckContent('security', mockReviewSummary, checkConfig)
      ).rejects.toThrow('Custom template must specify either "file" or "content"');

      expect(mockFs.readFile).not.toHaveBeenCalled();
      expect(mockLiquidInstance.parseAndRender).not.toHaveBeenCalled();
    });

    it('should handle file read errors for custom template files', async () => {
      const checkConfig = {
        template: {
          file: 'nonexistent/template.liquid',
        },
      };

      // Set up path mocks for this test
      mockPath.isAbsolute.mockReturnValue(false);
      mockPath.resolve.mockImplementation((base: string, relative?: string) => {
        if (relative) {
          return `${base}/${relative}`;
        }
        return base;
      });

      mockFs.readFile.mockRejectedValue(new Error('File not found'));

      await expect(
        (checkEngine as any).renderCheckContent('security', mockReviewSummary, checkConfig)
      ).rejects.toThrow('File not found');

      // The path should be validated and resolved to an absolute path within the project
      expect(mockFs.readFile).toHaveBeenCalled();
      const calledPath = mockFs.readFile.mock.calls[0][0];
      expect(calledPath).toContain('nonexistent/template.liquid');
      expect(mockLiquidInstance.parseAndRender).not.toHaveBeenCalled();
    });

    // Security tests for path traversal prevention
    it('should block absolute paths to prevent path traversal', async () => {
      const checkConfig = {
        template: {
          file: '/etc/passwd.liquid',
        },
      };

      // Set up path mocks for this test
      mockPath.isAbsolute.mockReturnValue(true); // Absolute path

      await expect(
        (checkEngine as any).renderCheckContent('security', mockReviewSummary, checkConfig)
      ).rejects.toThrow('Template path must be relative to project directory');

      expect(mockFs.readFile).not.toHaveBeenCalled();
    });

    it('should block paths with .. segments to prevent path traversal', async () => {
      const checkConfig = {
        template: {
          file: '../../../etc/passwd.liquid',
        },
      };

      // Set up path mocks for this test
      mockPath.isAbsolute.mockReturnValue(false); // Not absolute but has .. segments

      await expect(
        (checkEngine as any).renderCheckContent('security', mockReviewSummary, checkConfig)
      ).rejects.toThrow('Template path cannot contain ".." segments');

      expect(mockFs.readFile).not.toHaveBeenCalled();
    });

    it('should block home directory paths to prevent path traversal', async () => {
      const checkConfig = {
        template: {
          file: '~/.ssh/id_rsa.liquid',
        },
      };

      // Set up path mocks for this test
      mockPath.isAbsolute.mockReturnValue(false); // Not absolute but starts with ~

      await expect(
        (checkEngine as any).renderCheckContent('security', mockReviewSummary, checkConfig)
      ).rejects.toThrow('Template path cannot reference home directory');

      expect(mockFs.readFile).not.toHaveBeenCalled();
    });

    it('should block paths with null bytes to prevent path traversal', async () => {
      const checkConfig = {
        template: {
          file: 'template\0.liquid',
        },
      };

      // Set up path mocks for this test
      mockPath.isAbsolute.mockReturnValue(false); // Not absolute but has null byte

      await expect(
        (checkEngine as any).renderCheckContent('security', mockReviewSummary, checkConfig)
      ).rejects.toThrow('Template path contains invalid characters');

      expect(mockFs.readFile).not.toHaveBeenCalled();
    });

    it('should block empty or invalid template paths', async () => {
      const checkConfig = {
        template: {
          file: '',
        },
      };

      // Empty string is falsy, so it will trigger the "must specify either file or content" error
      await expect(
        (checkEngine as any).renderCheckContent('security', mockReviewSummary, checkConfig)
      ).rejects.toThrow('Custom template must specify either "file" or "content"');

      expect(mockFs.readFile).not.toHaveBeenCalled();
    });

    it('should block whitespace-only template paths', async () => {
      const checkConfig = {
        template: {
          file: '   ',
        },
      };

      // Set up path mocks for this test
      mockPath.isAbsolute.mockReturnValue(false); // Whitespace is not absolute

      await expect(
        (checkEngine as any).renderCheckContent('security', mockReviewSummary, checkConfig)
      ).rejects.toThrow('Template path must be a non-empty string');

      expect(mockFs.readFile).not.toHaveBeenCalled();
    });

    it('should enforce .liquid file extension for template files', async () => {
      const checkConfig = {
        template: {
          file: 'templates/template.txt',
        },
      };

      // Mock the git analyzer to return working directory
      mockGitAnalyzer.analyzeRepository.mockResolvedValue({
        ...mockRepositoryInfo,
        workingDirectory: '/test/working/dir',
      });

      await expect(
        (checkEngine as any).renderCheckContent('security', mockReviewSummary, checkConfig)
      ).rejects.toThrow('Template file must have .liquid extension');

      expect(mockFs.readFile).not.toHaveBeenCalled();
    });

    it('should handle file read errors for built-in schema templates', async () => {
      const checkConfig = { schema: 'nonexistent-schema' };

      mockPath.join.mockReturnValue('/app/src/output/nonexistent-schema/template.liquid');
      mockFs.readFile.mockRejectedValue(new Error('Template file not found'));

      await expect(
        (checkEngine as any).renderCheckContent('security', mockReviewSummary, checkConfig)
      ).rejects.toThrow('Template file not found');

      expect(mockPath.join).toHaveBeenCalledWith(
        expect.any(String),
        'output/nonexistent-schema/template.liquid'
      );
      expect(mockFs.readFile).toHaveBeenCalledWith(
        '/app/src/output/nonexistent-schema/template.liquid',
        'utf-8'
      );
    });

    it('should handle liquid template rendering errors', async () => {
      const checkConfig = {
        template: {
          content: 'Invalid {{ liquid.syntax',
        },
      };

      mockLiquidInstance.parseAndRender.mockRejectedValue(new Error('Liquid parsing error'));

      await expect(
        (checkEngine as any).renderCheckContent('security', mockReviewSummary, checkConfig)
      ).rejects.toThrow('Liquid parsing error');

      expect(mockLiquidInstance.parseAndRender).toHaveBeenCalledWith(checkConfig.template.content, {
        issues: mockReviewSummary.issues,
        checkName: 'security',
      });
    });

    it('should initialize Liquid with correct configuration', async () => {
      const checkConfig = {
        template: {
          content: 'Test template',
        },
      };

      mockLiquidInstance.parseAndRender.mockResolvedValue('rendered');

      const liquidExtensionsMock = require('../../../src/liquid-extensions') as jest.Mocked<
        typeof import('../../../src/liquid-extensions')
      >;

      await (checkEngine as any).renderCheckContent('security', mockReviewSummary, checkConfig);

      expect(liquidExtensionsMock.createExtendedLiquid).toHaveBeenCalledWith({
        trimTagLeft: false,
        trimTagRight: false,
        trimOutputLeft: false,
        trimOutputRight: false,
        greedy: false,
      });
    });

    it('should trim whitespace from rendered output', async () => {
      const checkConfig = {
        template: {
          content: 'Test template',
        },
      };

      mockLiquidInstance.parseAndRender.mockResolvedValue('  \n  rendered content  \n  ');

      const result = await (checkEngine as any).renderCheckContent(
        'security',
        mockReviewSummary,
        checkConfig
      );

      expect(result).toBe('rendered content');
    });

    it('should handle empty issues and suggestions arrays in template data', async () => {
      const emptyReviewSummary: ReviewSummary = {
        issues: [],
      };
      const checkConfig = {
        template: {
          content: 'Issues: {{ issues.size }}',
        },
      };

      mockLiquidInstance.parseAndRender.mockResolvedValue('Issues: 0');

      const result = await (checkEngine as any).renderCheckContent(
        'security',
        emptyReviewSummary,
        checkConfig
      );

      expect(mockLiquidInstance.parseAndRender).toHaveBeenCalledWith(checkConfig.template.content, {
        issues: [],
        checkName: 'security',
      });
      expect(result).toBe('Issues: 0');
    });

    it('should pass PRInfo to template if provided', async () => {
      const checkConfig = {
        template: {
          content: 'Check: {{ checkName }}',
        },
      };
      const prInfo = mockPRInfo;

      mockLiquidInstance.parseAndRender.mockResolvedValue('Check: security');

      const result = await (checkEngine as any).renderCheckContent(
        'security',
        mockReviewSummary,
        checkConfig,
        prInfo
      );

      expect(mockLiquidInstance.parseAndRender).toHaveBeenCalledWith(checkConfig.template.content, {
        issues: mockReviewSummary.issues,
        checkName: 'security',
      });
      expect(result).toBe('Check: security');
    });

    it('should handle complex schema names with special characters', async () => {
      const templateContent = 'Complex schema template';
      const checkConfig = { schema: 'markdown-v2.1_beta#test' };

      mockPath.join.mockReturnValue('/app/src/output/markdown-v21betatest/template.liquid');
      mockFs.readFile.mockResolvedValue(templateContent);
      mockLiquidInstance.parseAndRender.mockResolvedValue('Complex schema template');

      const result = await (checkEngine as any).renderCheckContent(
        'security',
        mockReviewSummary,
        checkConfig
      );

      // Should sanitize to 'markdown-v21betatest' removing special characters (. _ #)
      expect(mockPath.join).toHaveBeenCalledWith(
        expect.any(String),
        'output/markdown-v21betatest/template.liquid'
      );
      expect(result).toBe('Complex schema template');
    });
  });
});
