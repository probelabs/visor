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
     * Get all transitive dependencies (ancestors) for a given check
     * This returns all checks that must complete before the given check can run,
     * not just the direct dependencies.
     *
     * For example, if A -> B -> C, then:
     * - getAllDependencies(C) returns [A, B]
     * - getAllDependencies(B) returns [A]
     * - getAllDependencies(A) returns []
     *
     * @param checkId The check to find dependencies for
     * @param nodes The dependency graph nodes
     * @returns Array of all transitive dependency IDs
     */
    static getAllDependencies(checkId: string, nodes: Map<string, CheckNode>): string[];
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
