import { AnalysisResult } from './output-formatters';
export interface MockOctokit {
    rest: {
        pulls: {
            get: () => Promise<{
                data: Record<string, unknown>;
            }>;
            listFiles: () => Promise<{
                data: Record<string, unknown>[];
            }>;
        };
        issues: {
            listComments: () => Promise<{
                data: Record<string, unknown>[];
            }>;
            createComment: () => Promise<{
                data: Record<string, unknown>;
            }>;
        };
    };
    request: () => Promise<{
        data: Record<string, unknown>;
    }>;
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
    auth: () => Promise<{
        token: string;
    }>;
}
export interface CheckExecutionOptions {
    checks: string[];
    workingDirectory?: string;
    showDetails?: boolean;
    timeout?: number;
    outputFormat?: string;
}
export declare class CheckExecutionEngine {
    private gitAnalyzer;
    private mockOctokit;
    private reviewer;
    private providerRegistry;
    constructor(workingDirectory?: string);
    /**
     * Execute checks on the local repository
     */
    executeChecks(options: CheckExecutionOptions): Promise<AnalysisResult>;
    /**
     * Execute review checks using the provider registry
     */
    private executeReviewChecks;
    /**
     * Get available check types
     */
    static getAvailableCheckTypes(): string[];
    /**
     * Validate check types
     */
    static validateCheckTypes(checks: string[]): {
        valid: string[];
        invalid: string[];
    };
    /**
     * List available providers with their status
     */
    listProviders(): Promise<Array<{
        name: string;
        description: string;
        available: boolean;
        requirements: string[];
    }>>;
    /**
     * Create a mock Octokit instance for local analysis
     */
    private createMockOctokit;
    /**
     * Create an error result
     */
    private createErrorResult;
    /**
     * Check if the working directory is a valid git repository
     */
    isGitRepository(): Promise<boolean>;
    /**
     * Get repository status summary
     */
    getRepositoryStatus(): Promise<{
        isGitRepository: boolean;
        hasChanges: boolean;
        branch: string;
        filesChanged: number;
    }>;
}
//# sourceMappingURL=check-execution-engine.d.ts.map