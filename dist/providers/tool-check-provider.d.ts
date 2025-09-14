import { CheckProvider, CheckProviderConfig } from './check-provider.interface';
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary } from '../reviewer';
/**
 * Check provider that executes external tools (linters, analyzers, etc.)
 */
export declare class ToolCheckProvider extends CheckProvider {
    getName(): string;
    getDescription(): string;
    validateConfig(config: unknown): Promise<boolean>;
    execute(prInfo: PRInfo, config: CheckProviderConfig, _dependencyResults?: Map<string, ReviewSummary>): Promise<ReviewSummary>;
    private executeCommand;
    private parseToolOutput;
    private generateSuggestions;
    getSupportedConfigKeys(): string[];
    isAvailable(): Promise<boolean>;
    getRequirements(): string[];
}
//# sourceMappingURL=tool-check-provider.d.ts.map