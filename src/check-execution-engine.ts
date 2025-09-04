import { PRReviewer, ReviewSummary, ReviewOptions } from './reviewer';
import { GitRepositoryAnalyzer, GitRepositoryInfo } from './git-repository-analyzer';
import { AnalysisResult } from './output-formatters';
import { PRInfo } from './pr-analyzer';

export interface MockOctokit {
  rest: {
    pulls: {
      get: any;
      listFiles: any;
    };
    issues: {
      listComments: any;
      createComment: any;
    };
  };
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

  constructor(workingDirectory?: string) {
    this.gitAnalyzer = new GitRepositoryAnalyzer(workingDirectory);
    
    // Create a mock Octokit instance for local analysis
    // This allows us to reuse the existing PRReviewer logic without network calls
    this.mockOctokit = this.createMockOctokit();
    this.reviewer = new PRReviewer(this.mockOctokit as any);
  }

  /**
   * Execute checks on the local repository
   */
  async executeChecks(options: CheckExecutionOptions): Promise<AnalysisResult> {
    const startTime = Date.now();
    const timestamp = new Date().toISOString();

    try {
      // Determine where to send log messages based on output format
      const logFn = (options.outputFormat === 'json' || options.outputFormat === 'sarif') ? console.error : console.log;
      
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
      const reviewSummary = await this.executeReviewChecks(prInfo, options.checks);

      const executionTime = Date.now() - startTime;
      
      return {
        repositoryInfo,
        reviewSummary,
        executionTime,
        timestamp,
        checksExecuted: options.checks
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
        workingDirectory: options.workingDirectory || process.cwd()
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
   * Execute review checks using the existing PRReviewer logic
   */
  private async executeReviewChecks(prInfo: PRInfo, checks: string[]): Promise<ReviewSummary> {
    // Map CLI check types to reviewer focus options
    const focusMap: Record<string, ReviewOptions['focus']> = {
      'security': 'security',
      'performance': 'performance',
      'style': 'style',
      'all': 'all',
      'architecture': 'all', // Map architecture to all for now
    };

    // If multiple specific checks are requested, we'll run them separately and merge
    if (checks.length === 1 && checks[0] !== 'all') {
      const focus = focusMap[checks[0]] || 'all';
      return await this.reviewer.reviewPR('local', 'repository', 0, prInfo, { focus, format: 'detailed' });
    }

    // For multiple checks or 'all', run a comprehensive review
    let focus: ReviewOptions['focus'] = 'all';
    
    // If specific checks are requested, determine the most appropriate focus
    if (checks.includes('security') && !checks.includes('performance') && !checks.includes('style')) {
      focus = 'security';
    } else if (checks.includes('performance') && !checks.includes('security') && !checks.includes('style')) {
      focus = 'performance';
    } else if (checks.includes('style') && !checks.includes('security') && !checks.includes('performance')) {
      focus = 'style';
    }

    return await this.reviewer.reviewPR('local', 'repository', 0, prInfo, { focus, format: 'detailed' });
  }

  /**
   * Get available check types
   */
  static getAvailableCheckTypes(): string[] {
    return ['security', 'performance', 'style', 'architecture', 'all'];
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
        head: { ref: 'HEAD' }
      }
    });

    const mockListFiles = async () => ({
      data: []
    });

    const mockListComments = async () => ({
      data: []
    });

    const mockCreateComment = async () => ({
      data: { id: 1 }
    });

    return {
      rest: {
        pulls: {
          get: mockGet,
          listFiles: mockListFiles
        },
        issues: {
          listComments: mockListComments,
          createComment: mockCreateComment
        }
      }
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
        overallScore: 0,
        totalIssues: 1,
        criticalIssues: 1,
        suggestions: [`Error: ${errorMessage}`],
        comments: [{
          file: 'system',
          line: 0,
          message: errorMessage,
          severity: 'error',
          category: 'logic'
        }]
      },
      executionTime,
      timestamp,
      checksExecuted
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
        filesChanged: repositoryInfo.files.length
      };
    } catch (error) {
      return {
        isGitRepository: false,
        hasChanges: false,
        branch: 'unknown',
        filesChanged: 0
      };
    }
  }
}