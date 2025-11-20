import type { ExecutionStatistics } from '../../types/execution';
import { StateMachineExecutionEngine } from '../../state-machine-execution-engine';
import { RecordingOctokit } from '../recorders/github-recorder';
type PrintHeaderFn = (flowName: string, stageName: string, event?: string, fixture?: string) => void;
type PrintChecksFn = (checks: string[]) => void;
type MapEventFn = (fixtureName?: string) => import('../../types/config').EventTrigger;
type ComputeChecksFn = (cfg: any, event: string, desired?: Set<string>) => string[];
type WarnUnmockedFn = (stats: ExecutionStatistics, cfg: any, mocks: Record<string, unknown>) => void;
export declare class FlowStage {
    private readonly flowName;
    private readonly engine;
    private readonly recorder;
    private readonly cfg;
    private readonly prompts;
    private readonly promptCap;
    private readonly mapEventFromFixtureName;
    private readonly computeChecksToRun;
    private readonly printStageHeader;
    private readonly printSelectedChecks;
    private readonly warnUnmockedProviders;
    private readonly defaultIncludeTags?;
    private readonly defaultExcludeTags?;
    constructor(flowName: string, engine: StateMachineExecutionEngine, recorder: RecordingOctokit, cfg: any, prompts: Record<string, string[]>, promptCap: number | undefined, mapEventFromFixtureName: MapEventFn, computeChecksToRun: ComputeChecksFn, printStageHeader: PrintHeaderFn, printSelectedChecks: PrintChecksFn, warnUnmockedProviders: WarnUnmockedFn, defaultIncludeTags?: string[] | undefined, defaultExcludeTags?: string[] | undefined);
    run(stage: any, flowCase: any, strict: boolean): Promise<{
        name: string;
        errors?: string[];
        stats?: ExecutionStatistics;
    }>;
}
export {};
//# sourceMappingURL=flow-stage.d.ts.map