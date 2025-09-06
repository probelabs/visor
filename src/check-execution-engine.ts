import { PRReviewer, ReviewSummary, ReviewOptions } from './reviewer';
import { GitRepositoryAnalyzer, GitRepositoryInfo } from './git-repository-analyzer';
import { AnalysisResult } from './output-formatters';
import { PRInfo } from './pr-analyzer';
import { CheckProviderRegistry } from './providers/check-provider-registry';
import { CheckProviderConfig } from './providers/check-provider.interface';

export interface MockOctokit {
  rest: {
    pulls: {
      get: () => Promise<{ data: Record<string, unknown> }>;
      listFiles: () => Promise<{ data: Record<string, unknown>[] }>;
    };
    issues: {
      listComments: () => Promise<{ data: Record<string, unknown>[] }>;
      createComment: () => Promise<{ data: Record<string, unknown> }>;
    };
  };
  request: () => Promise<{ data: Record<string, unknown> }>;
  graphql: () => Promise<Record<string, unknown>>;
  log: {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
  hook: {
    before: (...args: unknown[]) => void;
    after: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    wrap: (...args: unknown[]) => void;
  };
  auth: () => Promise<{ token: string }>;
}

export interface CheckExecutionOptions {
  checks: string[];
  workingDirectory?: string;
  showDetails?: boolean;
  timeout?: number;
  outputFormat?: string;
}

export class CheckExecutionEngine {
  private gitAnalyzer: GitRepositoryAnalyzer;
  private mockOctokit: MockOctokit;
  private reviewer: PRReviewer;
  private providerRegistry: CheckProviderRegistry;

  constructor(workingDirectory?: string) {
    this.gitAnalyzer = new GitRepositoryAnalyzer(workingDirectory);
    this.providerRegistry = CheckProviderRegistry.getInstance();

    // Create a mock Octokit instance for local analysis
    // This allows us to reuse the existing PRReviewer logic without network calls
    this.mockOctokit = this.createMockOctokit();
    this.reviewer = new PRReviewer(this.mockOctokit as unknown as import('@octokit/rest').Octokit);
  }

  /**
   * Execute checks on the local repository
   */
  async executeChecks(options: CheckExecutionOptions): Promise<AnalysisResult> {
    const startTime = Date.now();
    const timestamp = new Date().toISOString();

    try {
      // Determine where to send log messages based on output format
      const logFn =
        options.outputFormat === 'json' || options.outputFormat === 'sarif'
          ? console.error
          : console.log;

      // Analyze the repository
      logFn('🔍 Analyzing local git repository...');
      const repositoryInfo = await this.gitAnalyzer.analyzeRepository();

      if (!repositoryInfo.isGitRepository) {
        return this.createErrorResult(
          repositoryInfo,
          'Not a git repository or no changes found',
          startTime,
          timestamp,
          options.checks
        );
      }

      // Convert to PRInfo format for compatibility with existing reviewer
      const prInfo = this.gitAnalyzer.toPRInfo(repositoryInfo);

      // Execute checks using the existing PRReviewer
      logFn(`🤖 Executing checks: ${options.checks.join(', ')}`);
      const reviewSummary = await this.executeReviewChecks(prInfo, options.checks, options.timeout);

      const executionTime = Date.now() - startTime;

      return {
        repositoryInfo,
        reviewSummary,
        executionTime,
        timestamp,
        checksExecuted: options.checks,
      };
    } catch (error) {
      console.error('Error executing checks:', error);

      const fallbackRepositoryInfo: GitRepositoryInfo = {
        title: 'Error during analysis',
        body: `Error: ${error instanceof Error ? error.message : 'Unknown error'}`,
        author: 'system',
        base: 'main',
        head: 'HEAD',
        files: [],
        totalAdditions: 0,
        totalDeletions: 0,
        isGitRepository: false,
        workingDirectory: options.workingDirectory || process.cwd(),
      };

      return this.createErrorResult(
        fallbackRepositoryInfo,
        error instanceof Error ? error.message : 'Unknown error occurred',
        startTime,
        timestamp,
        options.checks
      );
    }
  }

  /**
   * Execute review checks using the provider registry
   */
  private async executeReviewChecks(
    prInfo: PRInfo,
    checks: string[],
    timeout?: number
  ): Promise<ReviewSummary> {
    // First, try to use the new provider system for AI checks
    if (checks.length === 1 && this.providerRegistry.hasProvider(checks[0])) {
      const provider = this.providerRegistry.getProviderOrThrow(checks[0]);

      // Create config for the provider
      const config: CheckProviderConfig = {
        type: checks[0],
        prompt: 'all', // Default to comprehensive review
        ai: timeout ? { timeout } : undefined,
      };

      // Execute using the provider
      return await provider.execute(prInfo, config);
    }

    // Check if 'ai' provider is available for focus-based checks
    if (this.providerRegistry.hasProvider('ai')) {
      const provider = this.providerRegistry.getProviderOrThrow('ai');

      // Map CLI check types to focus options
      let focus = 'all';
      if (checks.length === 1) {
        if (checks[0] === 'security' || checks[0] === 'performance' || checks[0] === 'style') {
          focus = checks[0];
        }
      } else if (
        checks.includes('security') &&
        !checks.includes('performance') &&
        !checks.includes('style')
      ) {
        focus = 'security';
      } else if (
        checks.includes('performance') &&
        !checks.includes('security') &&
        !checks.includes('style')
      ) {
        focus = 'performance';
      } else if (
        checks.includes('style') &&
        !checks.includes('security') &&
        !checks.includes('performance')
      ) {
        focus = 'style';
      }

      const config: CheckProviderConfig = {
        type: 'ai',
        prompt: focus,
        focus: focus,
        ai: timeout ? { timeout } : undefined,
      };

      return await provider.execute(prInfo, config);
    }

    // Fallback to existing PRReviewer for backward compatibility
    const focusMap: Record<string, ReviewOptions['focus']> = {
      security: 'security',
      performance: 'performance',
      style: 'style',
      all: 'all',
      architecture: 'all',
    };

    let focus: ReviewOptions['focus'] = 'all';
    if (checks.length === 1 && focusMap[checks[0]]) {
      focus = focusMap[checks[0]];
    }

    return await this.reviewer.reviewPR('local', 'repository', 0, prInfo, {
      focus,
      format: 'table',
    });
  }

  /**
   * Get available check types
   */
  static getAvailableCheckTypes(): string[] {
    const registry = CheckProviderRegistry.getInstance();
    const providerTypes = registry.getAvailableProviders();
    // Add standard focus-based checks
    const standardTypes = ['security', 'performance', 'style', 'architecture', 'all'];
    // Combine provider types with standard types (remove duplicates)
    return [...new Set([...providerTypes, ...standardTypes])];
  }

  /**
   * Validate check types
   */
  static validateCheckTypes(checks: string[]): { valid: string[]; invalid: string[] } {
    const availableChecks = CheckExecutionEngine.getAvailableCheckTypes();
    const valid: string[] = [];
    const invalid: string[] = [];

    for (const check of checks) {
      if (availableChecks.includes(check)) {
        valid.push(check);
      } else {
        invalid.push(check);
      }
    }

    return { valid, invalid };
  }

  /**
   * List available providers with their status
   */
  async listProviders(): Promise<
    Array<{
      name: string;
      description: string;
      available: boolean;
      requirements: string[];
    }>
  > {
    return await this.providerRegistry.listProviders();
  }

  /**
   * Create a mock Octokit instance for local analysis
   */
  private createMockOctokit(): MockOctokit {
    // Create simple mock functions that return promises
    const mockGet = async () => ({
      data: {
        number: 0,
        title: 'Local Analysis',
        body: 'Local repository analysis',
        user: { login: 'local-user' },
        base: { ref: 'main' },
        head: { ref: 'HEAD' },
      },
    });

    const mockListFiles = async () => ({
      data: [],
    });

    const mockListComments = async () => ({
      data: [],
    });

    const mockCreateComment = async () => ({
      data: { id: 1 },
    });

    return {
      rest: {
        pulls: {
          get: mockGet,
          listFiles: mockListFiles,
        },
        issues: {
          listComments: mockListComments,
          createComment: mockCreateComment,
        },
      },
      request: async () => ({ data: {} }),
      graphql: async () => ({}),
      log: {
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: () => {},
      },
      hook: {
        before: () => {},
        after: () => {},
        error: () => {},
        wrap: () => {},
      },
      auth: async () => ({ token: 'mock-token' }),
    };
  }

  /**
   * Create an error result
   */
  private createErrorResult(
    repositoryInfo: GitRepositoryInfo,
    errorMessage: string,
    startTime: number,
    timestamp: string,
    checksExecuted: string[]
  ): AnalysisResult {
    const executionTime = Date.now() - startTime;

    return {
      repositoryInfo,
      reviewSummary: {
        issues: [
          {
            file: 'system',
            line: 0,
            endLine: undefined,
            ruleId: 'system/error',
            message: errorMessage,
            severity: 'error',
            category: 'logic',
            suggestion: undefined,
            replacement: undefined,
          },
        ],
        suggestions: [`Error: ${errorMessage}`],
      },
      executionTime,
      timestamp,
      checksExecuted,
    };
  }

  /**
   * Check if the working directory is a valid git repository
   */
  async isGitRepository(): Promise<boolean> {
    try {
      const repositoryInfo = await this.gitAnalyzer.analyzeRepository();
      return repositoryInfo.isGitRepository;
    } catch {
      return false;
    }
  }

  /**
   * Get repository status summary
   */
  async getRepositoryStatus(): Promise<{
    isGitRepository: boolean;
    hasChanges: boolean;
    branch: string;
    filesChanged: number;
  }> {
    try {
      const repositoryInfo = await this.gitAnalyzer.analyzeRepository();
      return {
        isGitRepository: repositoryInfo.isGitRepository,
        hasChanges: repositoryInfo.files.length > 0,
        branch: repositoryInfo.head,
        filesChanged: repositoryInfo.files.length,
      };
    } catch {
      return {
        isGitRepository: false,
        hasChanges: false,
        branch: 'unknown',
        filesChanged: 0,
      };
    }
  }
}
