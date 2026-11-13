import { CheckProvider, CheckProviderConfig } from './check-provider.interface';
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary } from '../reviewer';
/**
 * Check provider that fetches data from HTTP endpoints
 */
export declare class HttpClientProvider extends CheckProvider {
    private liquid;
    private sandbox?;
    constructor();
    private createSecureSandbox;
    getName(): string;
    getDescription(): string;
    validateConfig(config: unknown): Promise<boolean>;
    execute(prInfo: PRInfo, config: CheckProviderConfig, dependencyResults?: Map<string, ReviewSummary>, context?: import('./check-provider.interface').ExecutionContext): Promise<ReviewSummary>;
    private fetchData;
    private downloadToFile;
    getSupportedConfigKeys(): string[];
    isAvailable(): Promise<boolean>;
    getRequirements(): string[];
}
//# sourceMappingURL=http-client-provider.d.ts.map