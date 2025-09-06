import { CliOptions } from './types/cli';
/**
 * CLI argument parser and command handler
 */
export declare class CLI {
    private program;
    private validChecks;
    private validOutputs;
    constructor();
    /**
     * Set up the commander program with options and validation
     */
    private setupProgram;
    /**
     * Collect multiple check arguments
     */
    private collectChecks;
    /**
     * Parse command line arguments
     */
    parseArgs(argv: string[]): CliOptions;
    /**
     * Validate parsed options
     */
    private validateOptions;
    /**
     * Get help text
     */
    getHelpText(): string;
    /**
     * Get version from package.json
     */
    getVersion(): string;
    /**
     * Get examples text for help
     */
    getExamplesText(): string;
    /**
     * Display help
     */
    showHelp(): void;
    /**
     * Display version
     */
    showVersion(): void;
}
//# sourceMappingURL=cli.d.ts.map