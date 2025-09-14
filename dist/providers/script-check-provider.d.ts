import { CheckProvider, CheckProviderConfig } from './check-provider.interface';
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary } from '../reviewer';
/**
 * Check provider that executes custom scripts for analysis
 */
export declare class ScriptCheckProvider extends CheckProvider {
    getName(): string;
    getDescription(): string;
    validateConfig(config: unknown): Promise<boolean>;
    execute(prInfo: PRInfo, config: CheckProviderConfig, _dependencyResults?: Map<string, ReviewSummary>): Promise<ReviewSummary>;
    private executeScript;
    private parseScriptOutput;
    private validateSeverity;
    private validateCategory;
    getSupportedConfigKeys(): string[];
    isAvailable(): Promise<boolean>;
    getRequirements(): string[];
}
//# sourceMappingURL=script-check-provider.d.ts.map