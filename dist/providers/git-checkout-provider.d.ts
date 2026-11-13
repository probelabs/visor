/**
 * Git Checkout Provider
 *
 * Provides git checkout functionality using worktrees for efficient
 * multi-workflow execution.
 */
import { CheckProvider } from './check-provider.interface';
import type { PRInfo } from '../pr-analyzer';
import type { ReviewSummary } from '../reviewer';
import type { CheckProviderConfig, ExecutionContext } from './check-provider.interface';
export declare class GitCheckoutProvider extends CheckProvider {
    private liquid;
    getName(): string;
    getDescription(): string;
    validateConfig(config: unknown): Promise<boolean>;
    execute(prInfo: PRInfo, config: CheckProviderConfig, dependencyResults?: Map<string, ReviewSummary>, context?: ExecutionContext): Promise<ReviewSummary>;
    /**
     * Build template context for variable resolution
     */
    private buildTemplateContext;
    getSupportedConfigKeys(): string[];
    isAvailable(): Promise<boolean>;
    getRequirements(): string[];
}
//# sourceMappingURL=git-checkout-provider.d.ts.map