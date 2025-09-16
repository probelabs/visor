import { CheckProvider, CheckProviderConfig } from './check-provider.interface';
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary } from '../reviewer';
/**
 * Check provider that sends PR info to a webhook for external analysis
 */
export declare class WebhookCheckProvider extends CheckProvider {
    getName(): string;
    getDescription(): string;
    validateConfig(config: unknown): Promise<boolean>;
    execute(prInfo: PRInfo, config: CheckProviderConfig, _dependencyResults?: Map<string, ReviewSummary>, _sessionInfo?: {
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
//# sourceMappingURL=webhook-check-provider.d.ts.map