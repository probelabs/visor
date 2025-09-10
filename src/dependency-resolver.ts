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

export class DependencyResolver {
  /**
   * Build dependency graph from check dependencies
   */
  static buildDependencyGraph(checkDependencies: Record<string, string[]>): DependencyGraph {
    const nodes = new Map<string, CheckNode>();
    
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
        
        const depNode = nodes.get(depId)!;
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
  private static detectCycles(nodes: Map<string, CheckNode>): { hasCycles: boolean; cycleNodes?: string[] } {
    const visited = new Set<string>();
    const recursionStack = new Set<string>();
    const cycleNodes: string[] = [];

    const dfs = (nodeId: string): boolean => {
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
  private static topologicalSort(nodes: Map<string, CheckNode>): ExecutionGroup[] {
    const remainingNodes = new Map(nodes);
    const executionGroups: ExecutionGroup[] = [];
    let level = 0;

    while (remainingNodes.size > 0) {
      // Find nodes with no remaining dependencies
      const readyNodes: string[] = [];
      
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
  static validateDependencies(
    checkIds: string[],
    dependencies: Record<string, string[]>
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
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
  static getExecutionStats(graph: DependencyGraph): {
    totalChecks: number;
    parallelLevels: number;
    maxParallelism: number;
    averageParallelism: number;
    checksWithDependencies: number;
  } {
    const totalChecks = graph.nodes.size;
    const parallelLevels = graph.executionOrder.length;
    const maxParallelism = Math.max(...graph.executionOrder.map(group => group.parallel.length));
    const averageParallelism = totalChecks / parallelLevels;
    const checksWithDependencies = Array.from(graph.nodes.values()).filter(
      node => node.dependencies.length > 0
    ).length;

    return {
      totalChecks,
      parallelLevels,
      maxParallelism,
      averageParallelism,
      checksWithDependencies,
    };
  }
}