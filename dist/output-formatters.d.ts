import { ReviewSummary } from './reviewer';
import { GitRepositoryInfo } from './git-repository-analyzer';
export interface AnalysisResult {
    repositoryInfo: GitRepositoryInfo;
    reviewSummary: ReviewSummary;
    executionTime: number;
    timestamp: string;
    checksExecuted: string[];
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
    private static calculateCategoryScore;
    /**
     * Calculate overall score from issues
     */
    private static calculateOverallScore;
    /**
     * Convert ReviewIssue to ReviewComment for backward compatibility
     */
    private static issueToComment;
    /**
     * Group issues by category for display
     */
    private static groupIssuesByCategory;
    private static getCategoryEmoji;
    private static getSeverityEmoji;
    private static formatSeverity;
    private static getFileStatusEmoji;
    private static getSeverityColor;
    private static truncateText;
    private static wrapText;
}
//# sourceMappingURL=output-formatters.d.ts.map