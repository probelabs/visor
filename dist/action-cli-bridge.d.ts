import { GitHubActionInputs, GitHubContext } from './types/github';
export { GitHubActionInputs, GitHubContext };
export interface ActionCliOutput {
    success: boolean;
    output?: string;
    error?: string;
    exitCode?: number;
    cliOutput?: {
        reviewScore?: number;
        issuesFound?: number;
        autoReviewCompleted?: boolean;
    };
}
/**
 * Minimal bridge between GitHub Action and Visor
 * Provides utility functions for parsing GitHub Action inputs
 */
export declare class ActionCliBridge {
    private githubToken;
    private context;
    constructor(githubToken: string, context: GitHubContext);
    /**
     * Determine if legacy Visor inputs are present
     */
    shouldUseVisor(inputs: GitHubActionInputs): boolean;
    /**
     * Parse GitHub Action inputs into CLI arguments
     * Note: No validation - let the config system handle it
     */
    parseGitHubInputsToCliArgs(inputs: GitHubActionInputs): string[];
    /**
     * Merge CLI outputs with legacy Action outputs
     */
    mergeActionAndCliOutputs(inputs: GitHubActionInputs, cliResult: ActionCliOutput, legacyOutputs?: Record<string, string>): Record<string, string>;
    /**
     * Cleanup method for compatibility (no-op since we don't create temp files)
     */
    cleanup(): Promise<void>;
}
