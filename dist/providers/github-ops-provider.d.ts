import { CheckProvider, CheckProviderConfig } from './check-provider.interface';
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary } from '../reviewer';
export declare class GitHubOpsProvider extends CheckProvider {
    private sandbox?;
    getName(): string;
    getDescription(): string;
    validateConfig(config: unknown): Promise<boolean>;
    getSupportedConfigKeys(): string[];
    isAvailable(): Promise<boolean>;
    getRequirements(): string[];
    execute(prInfo: PRInfo, config: CheckProviderConfig, dependencyResults?: Map<string, ReviewSummary>): Promise<ReviewSummary>;
    /**
     * Create a secure sandbox for evaluating small expressions without access to process/env
     */
    private getSecureSandbox;
}
//# sourceMappingURL=github-ops-provider.d.ts.map