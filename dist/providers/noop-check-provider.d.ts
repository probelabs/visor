import { CheckProvider, CheckProviderConfig } from './check-provider.interface';
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary } from '../reviewer';
/**
 * No-operation check provider that doesn't perform any analysis.
 *
 * This provider is designed for command orchestration - it allows creating
 * checks that exist purely to trigger other checks through dependencies.
 *
 * Example use case: A "/review" command that triggers multiple analysis checks
 * without performing any analysis itself.
 */
export declare class NoopCheckProvider extends CheckProvider {
    getName(): string;
    getDescription(): string;
    validateConfig(config: unknown): Promise<boolean>;
    execute(_prInfo: PRInfo, _config: CheckProviderConfig, _dependencyResults?: Map<string, ReviewSummary>, _sessionInfo?: {
        parentSessionId?: string;
        reuseSession?: boolean;
    }): Promise<ReviewSummary>;
    getSupportedConfigKeys(): string[];
    isAvailable(): Promise<boolean>;
    getRequirements(): string[];
}
//# sourceMappingURL=noop-check-provider.d.ts.map