import { CheckProvider, CheckProviderConfig } from './check-provider.interface';
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary } from '../reviewer';
/**
 * Check provider that receives input from HTTP webhooks and makes it available to dependent checks
 */
export declare class HttpInputProvider extends CheckProvider {
    private liquid;
    private webhookContext?;
    constructor();
    /**
     * Set webhook context for accessing webhook data
     */
    setWebhookContext(webhookContext: Map<string, unknown>): void;
    getName(): string;
    getDescription(): string;
    validateConfig(config: unknown): Promise<boolean>;
    execute(prInfo: PRInfo, config: CheckProviderConfig, _dependencyResults?: Map<string, ReviewSummary>, _sessionInfo?: {
        parentSessionId?: string;
        reuseSession?: boolean;
    }): Promise<ReviewSummary>;
    private getWebhookData;
    getSupportedConfigKeys(): string[];
    isAvailable(): Promise<boolean>;
    getRequirements(): string[];
}
//# sourceMappingURL=http-input-provider.d.ts.map