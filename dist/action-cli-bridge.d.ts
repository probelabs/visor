export interface GitHubActionInputs {
    'github-token': string;
    owner?: string;
    repo?: string;
    'auto-review'?: string;
    'app-id'?: string;
    'private-key'?: string;
    'installation-id'?: string;
    checks?: string;
    'output-format'?: string;
    'config-path'?: string;
    'comment-on-pr'?: string;
    'create-check'?: string;
    'add-labels'?: string;
    'fail-on-critical'?: string;
    'fail-on-api-error'?: string;
    'min-score'?: string;
    debug?: string;
    'visor-config-path'?: string;
    'visor-checks'?: string;
}
export interface GitHubContext {
    event_name: string;
    repository?: {
        owner: {
            login: string;
        };
        name: string;
    };
    event?: {
        comment?: Record<string, unknown>;
        issue?: Record<string, unknown>;
        pull_request?: Record<string, unknown>;
        action?: string;
    };
    payload?: Record<string, unknown>;
}
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
 * Bridge between GitHub Action and Visor CLI
 */
export declare class ActionCliBridge {
    private githubToken;
    private context;
    constructor(githubToken: string, context: GitHubContext);
    /**
     * Determine if Visor CLI should be used based on inputs
     */
    shouldUseVisor(inputs: GitHubActionInputs): boolean;
    /**
     * Parse GitHub Action inputs to CLI arguments
     */
    parseGitHubInputsToCliArgs(inputs: GitHubActionInputs): string[];
    /**
     * Execute CLI with GitHub context
     */
    executeCliWithContext(inputs: GitHubActionInputs, options?: {
        workingDir?: string;
        timeout?: number;
    }): Promise<ActionCliOutput>;
    /**
     * Merge CLI and Action outputs for backward compatibility
     */
    mergeActionAndCliOutputs(actionInputs: GitHubActionInputs, cliResult: ActionCliOutput, legacyOutputs?: Record<string, string>): Record<string, string>;
    /**
     * Execute command with timeout and proper error handling
     */
    private executeCommand;
    /**
     * Parse CLI JSON output to extract relevant data
     */
    private parseCliOutput;
    /**
     * Check if a check type is valid
     */
    private isValidCheck;
    /**
     * Create temporary config file from action inputs
     */
    createTempConfigFromInputs(inputs: GitHubActionInputs, options?: {
        workingDir?: string;
    }): Promise<string | null>;
    /**
     * Get AI prompt for a specific check type
     */
    private getPromptForCheck;
    /**
     * Cleanup temporary files
     */
    cleanup(options?: {
        workingDir?: string;
    }): Promise<void>;
}
//# sourceMappingURL=action-cli-bridge.d.ts.map