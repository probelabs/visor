export type TestCase = {
    name: string;
    description?: string;
    event?: string;
    flow?: Array<{
        name: string;
    }>;
};
export type TestSuite = {
    version: string;
    extends?: string | string[];
    tests: {
        defaults?: Record<string, unknown>;
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
    maxParallelSuites?: number;
    maxParallel?: number;
    promptMaxChars?: number;
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
    private setupTestCase;
    private executeTestCase;
    private printCaseHeader;
    private printStageHeader;
    private printSelectedChecks;
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
        maxParallel?: number;
        promptMaxChars?: number;
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
    private mapEventFromFixtureName;
    private warnUnmockedProviders;
    private mapGithubOp;
    private computeChecksToRun;
    private printCoverage;
}
export declare function discoverAndPrint(options?: DiscoverOptions): Promise<void>;
export declare function runMvp(options: {
    testsPath?: string;
    only?: string;
    bail?: boolean;
    maxParallel?: number;
    promptMaxChars?: number;
}): Promise<number>;
export declare function validateTestsOnly(options: {
    testsPath?: string;
}): Promise<number>;
//# sourceMappingURL=index.d.ts.map