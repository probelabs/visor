import type { PRInfo } from '../pr-analyzer';
import type { ReviewSummary } from '../reviewer';
import { MemoryStore } from '../memory-store';
export declare function buildProviderTemplateContext(prInfo: PRInfo, dependencyResults?: Map<string, ReviewSummary>, memoryStore?: MemoryStore, outputHistory?: Map<string, unknown[]>, stageHistoryBase?: Record<string, number>, opts?: {
    attachMemoryReadHelpers?: boolean;
    args?: Record<string, unknown>;
}): Record<string, unknown>;
//# sourceMappingURL=template-context.d.ts.map