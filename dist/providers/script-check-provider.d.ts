import { CheckProvider, CheckProviderConfig } from './check-provider.interface';
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary } from '../reviewer';
/**
 * Provider that executes JavaScript in a secure sandbox using
 * a first-class step: `type: 'script'` + `content: | ...`.
 */
export declare class ScriptCheckProvider extends CheckProvider {
    private liquid;
    constructor();
    private createSecureSandbox;
    getName(): string;
    getDescription(): string;
    validateConfig(config: unknown): Promise<boolean>;
    execute(prInfo: PRInfo, config: CheckProviderConfig & {
        content?: string;
    }, dependencyResults?: Map<string, ReviewSummary>, _sessionInfo?: {
        parentSessionId?: string;
        reuseSession?: boolean;
    } & import('./check-provider.interface').ExecutionContext): Promise<ReviewSummary>;
    getSupportedConfigKeys(): string[];
    isAvailable(): Promise<boolean>;
    getRequirements(): string[];
}
//# sourceMappingURL=script-check-provider.d.ts.map