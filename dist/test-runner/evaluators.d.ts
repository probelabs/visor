import type { SlackRecordedCall } from './recorders/slack-recorder';
import { type ExpectBlock } from './assertions';
type ExecStats = import('../types/execution').ExecutionStatistics;
type GroupedResults = import('../reviewer').GroupedCheckResults;
export declare function evaluateCalls(errors: string[], expect: ExpectBlock, executed: Record<string, number>): void;
export declare function evaluateProviderCalls(errors: string[], expect: ExpectBlock, recorder: {
    calls: Array<{
        provider: string;
        op: string;
        args: any;
        ts: number;
    }>;
}, slackRecorder?: {
    calls: SlackRecordedCall[];
}): void;
export declare function evaluateNoCalls(errors: string[], expect: ExpectBlock, executed: Record<string, number>, recorder: {
    calls: Array<{
        provider: string;
        op: string;
        args: any;
        ts: number;
    }>;
}, slackRecorder?: {
    calls: SlackRecordedCall[];
}): void;
export declare function evaluatePrompts(errors: string[], expect: ExpectBlock, promptsByStep: Record<string, string[]>): void;
/**
 * Evaluate workflow_output assertions against computed workflow outputs.
 * Similar to evaluateOutputs but tests workflow-level outputs (defined in outputs: section)
 * rather than step outputs.
 */
export declare function evaluateWorkflowOutputs(errors: string[], expect: ExpectBlock, workflowOutputs: Record<string, unknown> | undefined): void;
export declare function evaluateOutputs(errors: string[], expect: ExpectBlock, outputHistory: Record<string, unknown[]>): void;
export declare function evaluateCase(caseName: string, stats: ExecStats, recorder: {
    calls: Array<{
        provider: string;
        op: string;
        args: any;
        ts: number;
    }>;
}, slackRecorder: {
    calls: SlackRecordedCall[];
} | undefined, expect: ExpectBlock, strict: boolean, promptsByStep: Record<string, string[]>, _results: GroupedResults, outputHistory: Record<string, unknown[]>, workflowOutputs?: Record<string, unknown>): string[];
export {};
//# sourceMappingURL=evaluators.d.ts.map