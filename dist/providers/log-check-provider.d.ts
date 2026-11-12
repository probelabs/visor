import { CheckProvider, CheckProviderConfig, ExecutionContext } from './check-provider.interface';
import { PRInfo } from '../pr-analyzer';
import { ReviewSummary } from '../reviewer';
/**
 * Log levels supported by the log provider
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
/**
 * Check provider that outputs debugging and logging information.
 * Useful for troubleshooting check workflows and understanding execution flow.
 */
export declare class LogCheckProvider extends CheckProvider {
    private liquid;
    constructor();
    getName(): string;
    getDescription(): string;
    validateConfig(config: unknown): Promise<boolean>;
    execute(prInfo: PRInfo, config: CheckProviderConfig, dependencyResults?: Map<string, ReviewSummary>, context?: ExecutionContext): Promise<ReviewSummary>;
    private buildTemplateContext;
    private formatLogOutput;
    private getLevelEmoji;
    getSupportedConfigKeys(): string[];
    isAvailable(): Promise<boolean>;
    getRequirements(): string[];
}
//# sourceMappingURL=log-check-provider.d.ts.map