"use strict";
/**
 * Dependency resolution and execution ordering for checks
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.DependencyResolver = void 0;
class DependencyResolver {
    /**
     * Build dependency graph from check dependencies
     */
    static buildDependencyGraph(checkDependencies) {
        const nodes = new Map();
        // Initialize all nodes
        for (const checkId of Object.keys(checkDependencies)) {
            nodes.set(checkId, {
                id: checkId,
                dependencies: checkDependencies[checkId] || [],
                dependents: [],
                depth: 0,
            });
        }
        // Build bidirectional relationships
        for (const [checkId, dependencies] of Object.entries(checkDependencies)) {
            for (const depId of dependencies || []) {
                if (!nodes.has(depId)) {
                    throw new Error(`Check "${checkId}" depends on "${depId}" but "${depId}" is not defined`);
                }
                const depNode = nodes.get(depId);
                depNode.dependents.push(checkId);
            }
        }
        // Detect cycles using DFS
        const cycleDetection = this.detectCycles(nodes);
        if (cycleDetection.hasCycles) {
            return {
                nodes,
                executionOrder: [],
                hasCycles: true,
                cycleNodes: cycleDetection.cycleNodes,
            };
        }
        // Calculate execution order using topological sort
        const executionOrder = this.topologicalSort(nodes);
        return {
            nodes,
            executionOrder,
            hasCycles: false,
        };
    }
    /**
     * Detect cycles in the dependency graph using DFS
     */
    static detectCycles(nodes) {
        const visited = new Set();
        const recursionStack = new Set();
        const cycleNodes = [];
        const dfs = (nodeId) => {
            if (recursionStack.has(nodeId)) {
                cycleNodes.push(nodeId);
                return true;
            }
            if (visited.has(nodeId)) {
                return false;
            }
            visited.add(nodeId);
            recursionStack.add(nodeId);
            const node = nodes.get(nodeId);
            if (node) {
                for (const depId of node.dependencies) {
                    if (dfs(depId)) {
                        cycleNodes.push(nodeId);
                        return true;
                    }
                }
            }
            recursionStack.delete(nodeId);
            return false;
        };
        for (const nodeId of nodes.keys()) {
            if (!visited.has(nodeId)) {
                if (dfs(nodeId)) {
                    return { hasCycles: true, cycleNodes: [...new Set(cycleNodes)] };
                }
            }
        }
        return { hasCycles: false };
    }
    /**
     * Perform topological sort to determine execution order
     * Groups checks that can run in parallel at each level
     */
    static topologicalSort(nodes) {
        const remainingNodes = new Map(nodes);
        const executionGroups = [];
        let level = 0;
        while (remainingNodes.size > 0) {
            // Find nodes with no remaining dependencies
            const readyNodes = [];
            for (const [nodeId, node] of remainingNodes.entries()) {
                const unmetDependencies = node.dependencies.filter(depId => remainingNodes.has(depId));
                if (unmetDependencies.length === 0) {
                    readyNodes.push(nodeId);
                }
            }
            if (readyNodes.length === 0) {
                // This shouldn't happen if cycle detection worked correctly
                throw new Error('Unable to resolve dependencies - possible circular dependency detected');
            }
            // Add this group to execution order
            executionGroups.push({
                parallel: readyNodes,
                level,
            });
            // Remove processed nodes
            for (const nodeId of readyNodes) {
                remainingNodes.delete(nodeId);
            }
            level++;
        }
        return executionGroups;
    }
    /**
     * Validate that all dependencies exist
     */
    static validateDependencies(checkIds, dependencies) {
        const errors = [];
        const checkIdSet = new Set(checkIds);
        for (const [checkId, deps] of Object.entries(dependencies)) {
            if (!checkIdSet.has(checkId)) {
                errors.push(`Check "${checkId}" is not in the list of available checks`);
                continue;
            }
            for (const depId of deps || []) {
                if (!checkIdSet.has(depId)) {
                    errors.push(`Check "${checkId}" depends on "${depId}" which is not available`);
                }
            }
        }
        return {
            valid: errors.length === 0,
            errors,
        };
    }
    /**
     * Get execution statistics for debugging
     */
    static getExecutionStats(graph) {
        const totalChecks = graph.nodes.size;
        const parallelLevels = graph.executionOrder.length;
        const maxParallelism = Math.max(...graph.executionOrder.map(group => group.parallel.length));
        const averageParallelism = totalChecks / parallelLevels;
        const checksWithDependencies = Array.from(graph.nodes.values()).filter(node => node.dependencies.length > 0).length;
        return {
            totalChecks,
            parallelLevels,
            maxParallelism,
            averageParallelism,
            checksWithDependencies,
        };
    }
}
exports.DependencyResolver = DependencyResolver;
//# sourceMappingURL=dependency-resolver.js.map