import type { PRInfo } from '../../pr-analyzer';
import type { ReviewSummary } from '../../reviewer';
import type { VisorConfig, CheckConfig, OnFinishConfig } from '../../types/config';
export declare function buildProjectionFrom(results: Map<string, ReviewSummary>, historySnapshot: Record<string, unknown[]>): {
    outputsForContext: Record<string, unknown>;
    outputsHistoryForContext: Record<string, unknown[]>;
};
export interface OnFinishContext {
    step: {
        id: string;
        tags: string[];
        group?: string;
    };
    attempt: number;
    loop: number;
    outputs: Record<string, unknown>;
    outputs_history: Record<string, unknown[]>;
    outputs_raw: Record<string, unknown>;
    forEach: unknown;
    memory: {
        get: (key: string, ns?: string) => unknown;
        has: (key: string, ns?: string) => boolean;
        getAll: (ns?: string) => Record<string, unknown>;
        set: (key: string, value: unknown, ns?: string) => void;
        clear: (ns?: string) => void;
        increment: (key: string, amount?: number, ns?: string) => number;
    };
    pr: {
        number: number;
        title?: string;
        author?: string;
        branch?: string;
        base?: string;
    };
    files?: unknown;
    env: Record<string, string | undefined>;
    event: {
        name: string;
    };
}
export declare function composeOnFinishContext(_memoryConfig: VisorConfig['memory'] | undefined, checkName: string, checkConfig: CheckConfig, outputsForContext: Record<string, unknown>, outputsHistoryForContext: Record<string, unknown[]>, forEachStats: any, prInfo: PRInfo): OnFinishContext;
export declare function evaluateOnFinishGoto(onFinish: NonNullable<OnFinishConfig>, onFinishContext: any, debug: boolean, log: (msg: string) => void): string | null;
export declare function recomputeAllValidFromHistory(history: Record<string, unknown[]>, forEachItemsCount: number): boolean | undefined;
//# sourceMappingURL=utils.d.ts.map