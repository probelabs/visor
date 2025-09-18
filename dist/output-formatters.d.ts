import { ReviewSummary } from './reviewer';
import { GitRepositoryInfo } from './git-repository-analyzer';
import { FailureConditionResult } from './types/config';
export interface AnalysisResult {
    repositoryInfo: GitRepositoryInfo;
    reviewSummary: ReviewSummary;
    executionTime: number;
    timestamp: string;
    checksExecuted: string[];
    debug?: DebugInfo;
    failureConditions?: FailureConditionResult[];
}
export interface DebugInfo {
    provider?: string;
    model?: string;
    processingTime?: number;
    parallelExecution?: boolean;
    checksExecuted?: string[];
    totalApiCalls?: number;
    apiCallDetails?: Array<{
        checkName: string;
        provider: string;
        model: string;
        processingTime: number;
        success: boolean;
    }>;
}
export interface OutputFormatterOptions {
    showDetails?: boolean;
    groupByCategory?: boolean;
    includeFiles?: boolean;
    includeTimestamp?: boolean;
}
export declare class OutputFormatters {
    /**
     * Format analysis results as a table using cli-table3
     */
    static formatAsTable(result: AnalysisResult, options?: OutputFormatterOptions): string;
    /**
     * Format analysis results as JSON
     */
    static formatAsJSON(result: AnalysisResult, options?: OutputFormatterOptions): string;
    /**
     * Format analysis results as SARIF 2.1.0
     */
    static formatAsSarif(result: AnalysisResult, _options?: OutputFormatterOptions): string;
    /**
     * Format analysis results as markdown
     */
    static formatAsMarkdown(result: AnalysisResult, options?: OutputFormatterOptions): string;
    private static groupCommentsByCategory;
    /**
     * Convert ReviewIssue to ReviewComment for backward compatibility
     */
    private static issueToComment;
    /**
     * Group issues by category for display
     */
    private static groupIssuesByCategory;
    private static formatSeverity;
    private static getFileStatusEmoji;
    private static getSeverityColor;
    private static truncateText;
    private static wrapText;
}
//# sourceMappingURL=output-formatters.d.ts.map