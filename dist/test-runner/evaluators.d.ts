import { RecordingOctokit } from './recorders/github-recorder';
import { type ExpectBlock } from './assertions';
type ExecStats = import('../types/execution').ExecutionStatistics;
type GroupedResults = import('../reviewer').GroupedCheckResults;
export declare function evaluateCalls(errors: string[], expect: ExpectBlock, executed: Record<string, number>): void;
export declare function evaluateProviderCalls(errors: string[], expect: ExpectBlock, recorder: RecordingOctokit): void;
export declare function evaluateNoCalls(errors: string[], expect: ExpectBlock, executed: Record<string, number>, recorder: RecordingOctokit): void;
export declare function evaluatePrompts(errors: string[], expect: ExpectBlock, promptsByStep: Record<string, string[]>): void;
export declare function evaluateOutputs(errors: string[], expect: ExpectBlock, outputHistory: Record<string, unknown[]>): void;
export declare function evaluateCase(caseName: string, stats: ExecStats, recorder: RecordingOctokit, expect: ExpectBlock, strict: boolean, promptsByStep: Record<string, string[]>, _results: GroupedResults, outputHistory: Record<string, unknown[]>): string[];
export {};
//# sourceMappingURL=evaluators.d.ts.map