/**
 * Failure condition evaluation engine using SandboxJS for secure expression evaluation
 */
import { ReviewSummary } from './reviewer';
import { FailureConditions, FailureConditionResult } from './types/config';
/**
 * Evaluates failure conditions using SandboxJS for secure evaluation
 */
export declare class FailureConditionEvaluator {
    private sandbox?;
    constructor();
    /**
     * Create a secure sandbox with whitelisted functions and globals
     */
    private createSecureSandbox;
    /**
     * Evaluate simple fail_if condition
     */
    evaluateSimpleCondition(checkName: string, checkSchema: string, checkGroup: string, reviewSummary: ReviewSummary, expression: string, previousOutputs?: Record<string, ReviewSummary>, authorAssociation?: string): Promise<boolean>;
    /**
     * Determine if the event is related to pull requests
     */
    private determineIfPullRequest;
    /**
     * Determine if the event is related to issues
     */
    private determineIfIssue;
    /**
     * Evaluate if condition to determine whether a check should run
     */
    evaluateIfCondition(checkName: string, expression: string, contextData?: {
        branch?: string;
        baseBranch?: string;
        filesChanged?: string[];
        event?: string;
        environment?: Record<string, string>;
        previousResults?: Map<string, ReviewSummary>;
        authorAssociation?: string;
    }): Promise<boolean>;
    /**
     * Evaluate all failure conditions for a check result
     */
    evaluateConditions(checkName: string, checkSchema: string, checkGroup: string, reviewSummary: ReviewSummary, globalConditions?: FailureConditions, checkConditions?: FailureConditions, previousOutputs?: Record<string, ReviewSummary>, authorAssociation?: string): Promise<FailureConditionResult[]>;
    /**
     * Evaluate a set of failure conditions
     */
    private evaluateConditionSet;
    /**
     * Evaluate a single failure condition
     */
    private evaluateSingleCondition;
    /**
     * Secure expression evaluation using SandboxJS
     * Supports the same GitHub Actions-style functions as the previous implementation
     */
    private evaluateExpression;
    /**
     * Extract the expression from a failure condition
     */
    private extractExpression;
    /**
     * Extract configuration from a failure condition
     */
    private extractConditionConfig;
    /**
     * Build the evaluation context for expressions
     */
    private buildEvaluationContext;
    private tryExtractJsonFromEnd;
    /**
     * Check if any failure condition requires halting execution
     */
    static shouldHaltExecution(results: FailureConditionResult[]): boolean;
    /**
     * Get all failed conditions
     */
    static getFailedConditions(results: FailureConditionResult[]): FailureConditionResult[];
    /**
     * Group results by severity
     */
    static groupResultsBySeverity(results: FailureConditionResult[]): {
        error: FailureConditionResult[];
        warning: FailureConditionResult[];
        info: FailureConditionResult[];
    };
    /**
     * Format results for display
     */
    static formatResults(results: FailureConditionResult[]): string;
}
