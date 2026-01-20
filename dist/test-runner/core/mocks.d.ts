export declare class MockManager {
    private mocks;
    private cursors;
    constructor(mocks?: Record<string, unknown>);
    reset(overrides?: Record<string, unknown>): void;
    get(step: string): unknown;
}
//# sourceMappingURL=mocks.d.ts.map