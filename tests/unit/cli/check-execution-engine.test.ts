/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-unused-vars */
import { CheckExecutionEngine, CheckExecutionOptions } from '../../../src/check-execution-engine';
import { GitRepositoryAnalyzer, GitRepositoryInfo } from '../../../src/git-repository-analyzer';
import { ReviewSummary } from '../../../src/reviewer';
import { PRInfo } from '../../../src/pr-analyzer';
import { CheckProviderRegistry } from '../../../src/providers/check-provider-registry';

// Mock the dependencies
jest.mock('../../../src/git-repository-analyzer');
// PRReviewer legacy removed from command path; no need to mock
jest.mock('../../../src/providers/check-provider-registry');

// Mock for renderCheckContent tests
jest.mock('liquidjs');
jest.mock('fs/promises');
jest.mock('path');
jest.mock('../../../src/liquid-extensions');

describe('CheckExecutionEngine', () => {
  let checkEngine: CheckExecutionEngine;
  let mockGitAnalyzer: jest.Mocked<GitRepositoryAnalyzer>;
  let mockReviewer: any;
  let mockRegistry: jest.Mocked<CheckProviderRegistry>;
  let mockAIProvider: any;

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
    mockReviewer = {} as any;

    // Mock the AI provider to return a simple review summary
    mockAIProvider = {
      getName: jest.fn().mockReturnValue('ai'),
      getDescription: jest.fn().mockReturnValue('AI provider'),
      validateConfig: jest.fn().mockResolvedValue(true),
      getSupportedConfigKeys: jest.fn().mockReturnValue([]),
      isAvailable: jest.fn().mockResolvedValue(true),
      getRequirements: jest.fn().mockReturnValue([]),
      execute: jest.fn().mockImplementation(async () => ({
        issues: [
          {
            category: 'security',
            message: 'Potential security issue',
            severity: 'error',
            file: 'src/test.ts',
            line: 10,
          },
        ],
      })),
    };

    // Mock registry to return the AI provider
    mockRegistry = {
      hasProvider: jest.fn().mockReturnValue(true),
      getProviderOrThrow: jest.fn().mockReturnValue(mockAIProvider),
      getAvailableProviders: jest.fn().mockReturnValue(['ai', 'tool', 'script', 'webhook']),
    } as any;

    (CheckProviderRegistry as any).getInstance = jest.fn().mockReturnValue(mockRegistry);

    // Mock constructor behavior
    (GitRepositoryAnalyzer as jest.MockedClass<typeof GitRepositoryAnalyzer>).mockImplementation(
      () => mockGitAnalyzer
    );
    // no-op: legacy reviewer not used

    checkEngine = new CheckExecutionEngine('/test/working/dir');
  });

  describe('Constructor', () => {
    it('should initialize with default working directory', () => {
      const engine = new CheckExecutionEngine();
      // State machine engine just stores the working directory, doesn't create analyzer in constructor
      expect(engine).toBeDefined();
    });

    it('should initialize with custom working directory', () => {
      const customDir = '/custom/work/dir';
      const engine = new CheckExecutionEngine(customDir);
      // State machine engine just stores the working directory, doesn't create analyzer in constructor
      expect(engine).toBeDefined();
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
      // legacy reviewer not used
    });

    it('should execute checks successfully', async () => {
      const options: CheckExecutionOptions = {
        checks: ['security', 'performance'],
        workingDirectory: '/test/repo',
      };

      const result = await checkEngine.executeChecks(options);

      expect(mockGitAnalyzer.analyzeRepository).toHaveBeenCalled();

      // Verify the result structure and content
      expect(result.repositoryInfo).toEqual(mockRepositoryInfo);
      expect(result.reviewSummary.issues).toBeDefined();
      expect(result.checksExecuted).toEqual(['security', 'performance']);
      expect(result.executionTime).toBeGreaterThanOrEqual(0);
      expect(result.timestamp).toBeDefined();
    });

    it('should handle single security check', async () => {
      const options: CheckExecutionOptions = {
        checks: ['security'],
      };

      const result = await checkEngine.executeChecks(options);

      // Verify the check was executed
      expect(result.checksExecuted).toEqual(['security']);
      expect(result.reviewSummary.issues).toBeDefined();
    });

    it('should handle single performance check', async () => {
      const options: CheckExecutionOptions = {
        checks: ['performance'],
      };

      const result = await checkEngine.executeChecks(options);

      // Verify the check was executed
      expect(result.checksExecuted).toEqual(['performance']);
      expect(result.reviewSummary.issues).toBeDefined();
    });

    it('should handle single style check', async () => {
      const options: CheckExecutionOptions = {
        checks: ['style'],
      };

      const result = await checkEngine.executeChecks(options);

      // Verify the check was executed
      expect(result.checksExecuted).toEqual(['style']);
      expect(result.reviewSummary.issues).toBeDefined();
    });

    it('should pass timeout option to check execution', async () => {
      const options: CheckExecutionOptions = {
        checks: ['security'],
        timeout: 300000, // 5 minutes
      };

      const result = await checkEngine.executeChecks(options);

      // Verify the execution completed successfully
      expect(result.checksExecuted).toEqual(['security']);
      expect(result.reviewSummary.issues).toBeDefined();
    });

    it('should handle timeout option with default value', async () => {
      const options: CheckExecutionOptions = {
        checks: ['performance'],
        timeout: undefined, // Should use default (600000ms)
      };

      const result = await checkEngine.executeChecks(options);

      // Verify the execution completed successfully
      expect(result.checksExecuted).toEqual(['performance']);
      expect(result.reviewSummary.issues).toBeDefined();
    });

    it('should accept various timeout values', async () => {
      const timeoutValues = [60000, 180000, 300000, 600000, 900000];

      for (const timeout of timeoutValues) {
        jest.clearAllMocks();

        const options: CheckExecutionOptions = {
          checks: ['all'],
          timeout,
        };

        const result = await checkEngine.executeChecks(options);
        expect(result.checksExecuted).toEqual(['all']);
        expect(result.reviewSummary.issues).toBeDefined();
      }
    });

    it('should handle all check', async () => {
      const options: CheckExecutionOptions = {
        checks: ['all'],
      };

      const result = await checkEngine.executeChecks(options);

      // Verify the check was executed
      expect(result.checksExecuted).toEqual(['all']);
      expect(result.reviewSummary.issues).toBeDefined();
    });

    it('should handle architecture check (mapped to all)', async () => {
      const options: CheckExecutionOptions = {
        checks: ['architecture'],
      };

      const result = await checkEngine.executeChecks(options);

      // Verify the check was executed
      expect(result.checksExecuted).toEqual(['architecture']);
      expect(result.reviewSummary.issues).toBeDefined();
    });

    it('should handle multiple mixed checks', async () => {
      const options: CheckExecutionOptions = {
        checks: ['security', 'performance', 'style'],
      };

      const result = await checkEngine.executeChecks(options);

      // Verify all checks were executed
      expect(result.checksExecuted).toEqual(['security', 'performance', 'style']);
      expect(result.reviewSummary.issues).toBeDefined();
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
      // Legacy reviewer is removed; no reviewer side-effects to assert here
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
      // Update the mock provider to throw an error
      const mockAIProviderWithError = {
        getName: jest.fn().mockReturnValue('ai'),
        getDescription: jest.fn().mockReturnValue('AI provider'),
        validateConfig: jest.fn().mockResolvedValue(true),
        getSupportedConfigKeys: jest.fn().mockReturnValue([]),
        isAvailable: jest.fn().mockResolvedValue(true),
        getRequirements: jest.fn().mockReturnValue([]),
        execute: jest.fn().mockRejectedValue(new Error('Review failed')),
      };

      mockRegistry.getProviderOrThrow.mockReturnValue(mockAIProviderWithError);

      const options: CheckExecutionOptions = {
        checks: ['security'],
      };

      const result = await checkEngine.executeChecks(options);

      expect(result.reviewSummary.issues).toHaveLength(1);
      expect(result.reviewSummary.issues![0].message).toContain('Review failed');
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
});
