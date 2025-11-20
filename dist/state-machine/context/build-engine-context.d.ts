import type { VisorConfig } from '../../types/config';
import type { PRInfo } from '../../pr-analyzer';
import type { EngineContext } from '../../types/engine';
/**
 * Pure helper to build an EngineContext for a state-machine run.
 * Extracted to reduce StateMachineExecutionEngine size; behavior unchanged.
 */
export declare function buildEngineContextForRun(workingDirectory: string, config: VisorConfig, prInfo: PRInfo, debug?: boolean, maxParallelism?: number, failFast?: boolean, requestedChecks?: string[]): EngineContext;
//# sourceMappingURL=build-engine-context.d.ts.map