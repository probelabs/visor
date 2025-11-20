export type CountExpectation = {
    exactly?: number;
    at_least?: number;
    at_most?: number;
};
export interface CallsExpectation extends CountExpectation {
    step?: string;
    provider?: 'github' | string;
    op?: string;
    args?: Record<string, unknown>;
}
export interface PromptsExpectation {
    step: string;
    index?: number | 'first' | 'last';
    contains?: string[];
    not_contains?: string[];
    matches?: string;
    where?: {
        contains?: string[];
        not_contains?: string[];
        matches?: string;
    };
}
export interface OutputsExpectation {
    step: string;
    index?: number | 'first' | 'last';
    path: string;
    equals?: unknown;
    equalsDeep?: unknown;
    matches?: string;
    where?: {
        path: string;
        equals?: unknown;
        matches?: string;
    };
    contains_unordered?: unknown[];
}
export interface ExpectBlock {
    use?: string[];
    calls?: CallsExpectation[];
    prompts?: PromptsExpectation[];
    outputs?: OutputsExpectation[];
    no_calls?: Array<{
        step?: string;
        provider?: string;
        op?: string;
    }>;
    fail?: {
        message_contains?: string;
    };
    strict_violation?: {
        for_step?: string;
        message_contains?: string;
    };
}
export declare function validateCounts(exp: CountExpectation): void;
export declare function deepEqual(a: unknown, b: unknown): boolean;
export declare function containsUnordered(haystack: unknown[], needles: unknown[]): boolean;
//# sourceMappingURL=assertions.d.ts.map