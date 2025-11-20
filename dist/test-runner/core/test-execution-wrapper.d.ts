import type { PRInfo } from '../../pr-analyzer';
import { StateMachineExecutionEngine } from '../../state-machine-execution-engine';
export declare class TestExecutionWrapper {
    private readonly engine;
    constructor(engine: StateMachineExecutionEngine);
    /**
     * Execute a grouped run in a deterministic, test-friendly way without
     * adding test-specific branches to the core engine.
     */
    execute(prInfo: PRInfo, checks: string[], cfg: any, debug: boolean, tagFilter?: {
        include?: string[];
        exclude?: string[];
    }): Promise<{
        res: any;
        outHistory: Record<string, unknown[]>;
    }>;
}
//# sourceMappingURL=test-execution-wrapper.d.ts.map