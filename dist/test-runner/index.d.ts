export type TestCase = {
    name: string;
    description?: string;
    event?: string;
    flow?: Array<{
        name: string;
    }>;
};
export type TestHookDef = {
    exec: string;
    timeout?: number;
};
export type TestSuite = {
    version: string;
    extends?: string | string[];
    tests: {
        defaults?: Record<string, unknown>;
        hooks?: {
            before_all?: TestHookDef;
            after_all?: TestHookDef;
            before_each?: TestHookDef;
            after_each?: TestHookDef;
        };
        fixtures?: unknown[];
        cases: TestCase[];
    };
};
export interface DiscoverOptions {
    testsPath?: string;
    cwd?: string;
}
/**
 * Discover all YAML test suites under a directory or by glob pattern.
 * Rules:
 *  - Include files ending with .tests.yaml/.tests.yml
 *  - Include YAML files containing a top-level `tests:` key (embedded suites)
 */
export declare function discoverSuites(rootOrPattern?: string, cwd?: string): string[];
export declare function runSuites(files: string[], options: {
    only?: string;
    bail?: boolean;
    noMocks?: boolean;
    noMocksFor?: string[];
    maxParallelSuites?: number;
    maxParallel?: number;
}): Promise<{
    totalSuites: number;
    failedSuites: number;
    totalCases: number;
    failedCases: number;
    perSuite: Array<{
        file: string;
        failures: number;
        results: Array<{
            name: string;
            passed: boolean;
            errors?: string[];
            stages?: Array<{
                name: string;
                errors?: string[];
            }>;
        }>;
    }>;
}>;
export declare class VisorTestRunner {
    private readonly cwd;
    constructor(cwd?: string);
    private readonly isTTY;
    private color;
    private bold;
    private gray;
    private tagPass;
    private tagFail;
    private tagSkip;
    private line;
    /**
     * Execute a lifecycle hook (shell command). Returns true on success, false on failure.
     */
    private runHook;
    private setupTestCase;
    private executeTestCase;
    private printCaseHeader;
    private printStageHeader;
    private printSelectedChecks;
    /**
     * Compute workflow outputs from output definitions and step results.
     * Evaluates value_js and value (Liquid) expressions to produce output values.
     */
    private computeWorkflowOutputs;
    /**
     * Auto-propagate step outputs as workflow outputs when no explicit outputs defined.
     * Mirrors the logic in workflow-check-provider.ts for consistency.
     */
    private autoPropagateeWorkflowOutputs;
    /**
     * Locate a tests file: explicit path > ./.visor.tests.yaml > defaults/visor.tests.yaml
     */
    resolveTestsPath(explicit?: string): string;
    /**
     * Load and minimally validate tests YAML.
     */
    loadSuite(testsPath: string): TestSuite;
    /**
     * Pretty print discovered cases to stdout.
     */
    printDiscovery(testsPath: string, suite: TestSuite): void;
    /**
     * Execute non-flow cases with minimal assertions (Milestone 1 MVP).
     */
    runCases(testsPath: string, suite: TestSuite, options: {
        only?: string;
        bail?: boolean;
        noMocks?: boolean;
        noMocksFor?: string[];
        maxParallel?: number;
    }): Promise<{
        failures: number;
        results: Array<{
            name: string;
            passed: boolean;
            errors?: string[];
            stages?: Array<{
                name: string;
                errors?: string[];
            }>;
        }>;
    }>;
    private runFlowCase;
    /**
     * Extract the last response text from cumulative output history (for conversation sugar).
     * Looks for 'chat' step outputs with a 'text' field.
     */
    private extractLastResponseText;
    private mapEventFromFixtureName;
    private warnUnmockedProviders;
    private mapGithubOp;
    private computeChecksToRun;
    /**
     * Compute a flat list of human-readable diffs between a mock value and a real output.
     * Walks objects recursively; reports added/removed/changed keys.
     */
    private diffObjects;
    private printCoverage;
}
export declare function discoverAndPrint(options?: DiscoverOptions): Promise<void>;
export declare function runMvp(options: {
    testsPath?: string;
    only?: string;
    bail?: boolean;
    maxParallel?: number;
}): Promise<number>;
export declare function validateTestsOnly(options: {
    testsPath?: string;
}): Promise<number>;
//# sourceMappingURL=index.d.ts.map