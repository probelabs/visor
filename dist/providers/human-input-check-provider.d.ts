import { CheckProvider, CheckProviderConfig, ExecutionContext } from './check-provider.interface';
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary } from '../reviewer';
import { HumanInputRequest } from '../types/config';
/**
 * Human input check provider that pauses workflow to request user input.
 *
 * Supports four modes:
 * 1. CLI with --message argument (inline or file path)
 * 2. CLI with piped stdin
 * 3. CLI interactive mode (beautiful terminal UI)
 * 4. SDK mode with onHumanInput hook
 *
 * Example config:
 * ```yaml
 * checks:
 *   approval:
 *     type: human-input
 *     prompt: "Do you approve? (yes/no)"
 *     allow_empty: false
 *     timeout: 300000
 * ```
 */
export declare class HumanInputCheckProvider extends CheckProvider {
    /**
     * @deprecated Use ExecutionContext.cliMessage instead
     * Kept for backward compatibility
     */
    private static cliMessage;
    /**
     * @deprecated Use ExecutionContext.hooks instead
     * Kept for backward compatibility
     */
    private static hooks;
    /**
     * Set the CLI message value (from --message argument)
     * @deprecated Use ExecutionContext.cliMessage instead
     */
    static setCLIMessage(message: string | undefined): void;
    /**
     * Get the current CLI message value
     * @deprecated Use ExecutionContext.cliMessage instead
     */
    static getCLIMessage(): string | undefined;
    /**
     * Set hooks for SDK mode
     * @deprecated Use ExecutionContext.hooks instead
     */
    static setHooks(hooks: {
        onHumanInput?: (request: HumanInputRequest) => Promise<string>;
    }): void;
    getName(): string;
    getDescription(): string;
    validateConfig(config: unknown): Promise<boolean>;
    /**
     * Check if a string looks like a file path
     */
    private looksLikePath;
    /**
     * Sanitize user input to prevent injection attacks in dependent checks
     * Removes potentially dangerous characters while preserving useful input
     */
    private sanitizeInput;
    /**
     * Try to read message from file if it exists
     * Validates path to prevent directory traversal attacks
     */
    private tryReadFile;
    /**
     * Get user input through various methods
     */
    private getUserInput;
    execute(_prInfo: PRInfo, config: CheckProviderConfig, _dependencyResults?: Map<string, ReviewSummary>, context?: ExecutionContext): Promise<ReviewSummary>;
    getSupportedConfigKeys(): string[];
    isAvailable(): Promise<boolean>;
    getRequirements(): string[];
}
//# sourceMappingURL=human-input-check-provider.d.ts.map