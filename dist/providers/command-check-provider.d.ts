import { CheckProvider, CheckProviderConfig } from './check-provider.interface';
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary } from '../reviewer';
/**
 * Check provider that executes shell commands and captures their output
 * Supports JSON parsing and integration with forEach functionality
 */
export declare class CommandCheckProvider extends CheckProvider {
    private liquid;
    private sandbox?;
    constructor();
    private createSecureSandbox;
    getName(): string;
    getDescription(): string;
    validateConfig(config: unknown): Promise<boolean>;
    execute(prInfo: PRInfo, config: CheckProviderConfig, dependencyResults?: Map<string, ReviewSummary>, context?: import('./check-provider.interface').ExecutionContext): Promise<ReviewSummary>;
    private buildOutputContext;
    /**
     * Wrap a value with JSON-smart behavior:
     *  - If it's a JSON string, expose parsed properties via Proxy (e.g., value.key)
     *  - When coerced to string (toString/valueOf/Symbol.toPrimitive), return the original raw string
     *  - If parsing fails or value is not a string, return the value unchanged
     *  - Attempts to extract JSON from the end of the output if full parse fails
     */
    private makeJsonSmart;
    /**
     * Extract JSON from the end of a string that may contain logs/debug output
     * Looks for the last occurrence of { or [ and tries to parse from there
     */
    private extractJsonFromEnd;
    private extractJsonAnywhere;
    private looseJsonToStrict;
    /**
     * Recursively apply JSON-smart wrapper to outputs object values
     */
    private makeOutputsJsonSmart;
    private getSafeEnvironmentVariables;
    getSupportedConfigKeys(): string[];
    isAvailable(): Promise<boolean>;
    getRequirements(): string[];
    private extractIssuesFromOutput;
    private shouldTreatAsTextOutput;
    private normalizeIssueArray;
    private normalizeIssue;
    private toTrimmedString;
    private toNumber;
    private renderCommandTemplate;
    private renderWithJsExpressions;
}
//# sourceMappingURL=command-check-provider.d.ts.map