export declare class MockManager {
    private mocks;
    private cursors;
    private consumed;
    constructor(mocks?: Record<string, unknown>);
    reset(overrides?: Record<string, unknown>): void;
    get(step: string): unknown;
    /** Returns true if the mock for this step was already consumed (scalar) or has no more items (array). */
    isExhausted(step: string): boolean;
    /** Returns true if a mock exists for this step (scalar or array). */
    has(step: string): boolean;
}
//# sourceMappingURL=mocks.d.ts.map