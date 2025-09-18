/**
 * Dependency resolution and execution ordering for checks
 */
export interface CheckNode {
    id: string;
    dependencies: string[];
    dependents: string[];
    depth: number;
}
export interface ExecutionGroup {
    /** Checks that can run in parallel */
    parallel: string[];
    /** Execution level/wave (0 = no dependencies, 1 = depends on level 0, etc.) */
    level: number;
}
export interface DependencyGraph {
    nodes: Map<string, CheckNode>;
    executionOrder: ExecutionGroup[];
    hasCycles: boolean;
    cycleNodes?: string[];
}
export declare class DependencyResolver {
    /**
     * Build dependency graph from check dependencies
     */
    static buildDependencyGraph(checkDependencies: Record<string, string[]>): DependencyGraph;
    /**
     * Detect cycles in the dependency graph using DFS
     */
    private static detectCycles;
    /**
     * Perform topological sort to determine execution order
     * Groups checks that can run in parallel at each level
     */
    private static topologicalSort;
    /**
     * Validate that all dependencies exist
     */
    static validateDependencies(checkIds: string[], dependencies: Record<string, string[]>): {
        valid: boolean;
        errors: string[];
    };
    /**
     * Get execution statistics for debugging
     */
    static getExecutionStats(graph: DependencyGraph): {
        totalChecks: number;
        parallelLevels: number;
        maxParallelism: number;
        averageParallelism: number;
        checksWithDependencies: number;
    };
}
//# sourceMappingURL=dependency-resolver.d.ts.map