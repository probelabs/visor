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
      expect(GitRepositoryAnalyzer).toHaveBeenCalledWith(undefined);
    });

    it('should initialize with custom working directory', () => {
      const customDir = '/custom/work/dir';
      const engine = new CheckExecutionEngine(customDir);
      expect(GitRepositoryAnalyzer).toHaveBeenCalledWith(customDir);
    });
  });

  describe('executeChecks', () => {
    const mockReviewSummary = {
      suggestions: ['Add input validation', 'Improve error handling'],
      issues: [
        {
          file: 'src/test.ts',
          line: 10,
          message: 'Potential security issue',
          severity: 'error' as const,
          category: 'security' as const,
        },
        {
          file: 'src/test.ts',
          line: 15,
          message: 'Style improvement needed',
          severity: 'info' as const,
          category: 'style' as const,
        },
      ],
    };

    beforeEach(() => {
      mockGitAnalyzer.analyzeRepository.mockResolvedValue(mockRepositoryInfo);
      mockGitAnalyzer.toPRInfo.mockReturnValue(mockPRInfo);
      mockReviewer.reviewPR.mockResolvedValue(mockReviewSummary);
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
          format: 'markdown',
        })
      );

      expect(result.repositoryInfo).toEqual(mockRepositoryInfo);
      expect(result.reviewSummary).toEqual(mockReviewSummary);
      expect(result.checksExecuted).toEqual(['security', 'performance']);
      expect(result.executionTime).toBeGreaterThan(0);
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
          format: 'markdown',
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
          format: 'markdown',
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
          format: 'markdown',
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
          format: 'markdown',
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
          format: 'markdown',
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
          format: 'markdown',
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
      expect(result.reviewSummary.issues[0].message).toContain('Not a git repository');
      expect(mockReviewer.reviewPR).not.toHaveBeenCalled();
    });

    it('should handle git analyzer errors', async () => {
      mockGitAnalyzer.analyzeRepository.mockRejectedValue(new Error('Git command failed'));

      const options: CheckExecutionOptions = {
        checks: ['security'],
      };

      const result = await checkEngine.executeChecks(options);

      expect(result.reviewSummary.issues).toHaveLength(1);
      expect(result.reviewSummary.issues[0].message).toBe('Git command failed');
      expect(result.reviewSummary.issues[0].severity).toBe('error');
    });

    it('should handle reviewer errors', async () => {
      mockReviewer.reviewPR.mockRejectedValue(new Error('Review failed'));

      const options: CheckExecutionOptions = {
        checks: ['security'],
      };

      const result = await checkEngine.executeChecks(options);

      expect(result.reviewSummary.issues).toHaveLength(1);
      expect(result.reviewSummary.issues[0].message).toBe('Review failed');
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

      expect(result.executionTime).toBeGreaterThanOrEqual(10);
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

        expect(checkTypes).toContain('security');
        expect(checkTypes).toContain('performance');
        expect(checkTypes).toContain('style');
        expect(checkTypes).toContain('architecture');
        expect(checkTypes).toContain('all');
        // Now includes provider types (ai, tool, script, webhook) + standard types
        expect(checkTypes).toHaveLength(9);
      });
    });

    describe('validateCheckTypes', () => {
      it('should validate all valid check types', () => {
        const checks = ['security', 'performance', 'style'];
        const result = CheckExecutionEngine.validateCheckTypes(checks);

        expect(result.valid).toEqual(checks);
        expect(result.invalid).toHaveLength(0);
      });

      it('should identify invalid check types', () => {
        const checks = ['security', 'invalid-check', 'performance', 'another-invalid'];
        const result = CheckExecutionEngine.validateCheckTypes(checks);

        expect(result.valid).toEqual(['security', 'performance']);
        expect(result.invalid).toEqual(['invalid-check', 'another-invalid']);
      });

      it('should handle empty check list', () => {
        const result = CheckExecutionEngine.validateCheckTypes([]);

        expect(result.valid).toHaveLength(0);
        expect(result.invalid).toHaveLength(0);
      });

      it('should handle all check type', () => {
        const checks = ['all'];
        const result = CheckExecutionEngine.validateCheckTypes(checks);

        expect(result.valid).toEqual(['all']);
        expect(result.invalid).toHaveLength(0);
      });

      it('should handle mixed valid and invalid checks', () => {
        const checks = ['all', 'invalid', 'security', 'bad-check', 'performance'];
        const result = CheckExecutionEngine.validateCheckTypes(checks);

        expect(result.valid).toEqual(['all', 'security', 'performance']);
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
      expect(result.reviewSummary.suggestions).toEqual([`Error: ${errorMessage}`]);
      expect(result.reviewSummary.issues[0].severity).toBe('error');
      expect(result.reviewSummary.issues[0].category).toBe('logic');
      expect(result.reviewSummary.issues[0].file).toBe('system');
      expect(result.reviewSummary.issues[0].line).toBe(0);
    });

    it('should handle non-Error exceptions', async () => {
      mockGitAnalyzer.analyzeRepository.mockRejectedValue('String error');

      const options: CheckExecutionOptions = {
        checks: ['security'],
      };

      const result = await checkEngine.executeChecks(options);

      expect(result.reviewSummary.issues[0].message).toBe('Unknown error occurred');
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
});
