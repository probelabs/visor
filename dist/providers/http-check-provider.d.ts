import { CheckProvider, CheckProviderConfig } from './check-provider.interface';
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary } from '../reviewer';
/**
 * Check provider that sends data to an HTTP endpoint, typically used as an output/notification provider
 */
export declare class HttpCheckProvider extends CheckProvider {
    private liquid;
    constructor();
    getName(): string;
    getDescription(): string;
    validateConfig(config: unknown): Promise<boolean>;
    execute(prInfo: PRInfo, config: CheckProviderConfig, dependencyResults?: Map<string, ReviewSummary>, _sessionInfo?: {
        parentSessionId?: string;
        reuseSession?: boolean;
    }): Promise<ReviewSummary>;
    private sendWebhookRequest;
    private parseWebhookResponse;
    private createErrorResult;
    private validateSeverity;
    private validateCategory;
    getSupportedConfigKeys(): string[];
    isAvailable(): Promise<boolean>;
    getRequirements(): string[];
}
//# sourceMappingURL=http-check-provider.d.ts.map