import { describe, it, expect } from '@jest/globals';
import { DependencyResolver } from '../../src/dependency-resolver';

/**
 * Unit Test: Transitive Dependency Outputs Access
 *
 * This test verifies that checks have access to outputs from ALL
 * transitive dependencies (ancestors), not just direct dependencies.
 *
 * Example chain: A -> B -> C
 * - Check C should have access to outputs from both B and A
 */
describe('Transitive Dependency Outputs Access', () => {
  it('should return all transitive dependencies for a check', () => {
    // Build a dependency chain: A -> B -> C
    const dependencies = {
      A: [],
      B: ['A'],
      C: ['B'],
    };

    const graph = DependencyResolver.buildDependencyGraph(dependencies);

    // Get all dependencies for C
    const allDepsC = DependencyResolver.getAllDependencies('C', graph.nodes);

    // C should have access to both B and A (its transitive dependencies)
    expect(allDepsC).toContain('B'); // Direct dependency
    expect(allDepsC).toContain('A'); // Transitive dependency (B depends on A)
    expect(allDepsC.length).toBe(2);
  });

  it('should return all transitive dependencies for a complex graph', () => {
    // Build a complex dependency graph:
    //   A
    //   |
    //   B
    //  / \
    // C   D
    //  \ /
    //   E
    const dependencies = {
      A: [],
      B: ['A'],
      C: ['B'],
      D: ['B'],
      E: ['C', 'D'],
    };

    const graph = DependencyResolver.buildDependencyGraph(dependencies);

    // Get all dependencies for E
    const allDepsE = DependencyResolver.getAllDependencies('E', graph.nodes);

    // E should have access to C, D (direct), B (via C and D), and A (via B)
    expect(allDepsE).toContain('C'); // Direct dependency
    expect(allDepsE).toContain('D'); // Direct dependency
    expect(allDepsE).toContain('B'); // Transitive dependency (via C and D)
    expect(allDepsE).toContain('A'); // Transitive dependency (via B)
    expect(allDepsE.length).toBe(4);
  });

  it('should return empty array for checks with no dependencies', () => {
    const dependencies = {
      A: [],
      B: ['A'],
    };

    const graph = DependencyResolver.buildDependencyGraph(dependencies);

    // A has no dependencies
    const allDepsA = DependencyResolver.getAllDependencies('A', graph.nodes);
    expect(allDepsA).toEqual([]);
  });

  it('should handle diamond dependency pattern', () => {
    // Diamond pattern:
    //     A
    //    / \
    //   B   C
    //    \ /
    //     D
    const dependencies = {
      A: [],
      B: ['A'],
      C: ['A'],
      D: ['B', 'C'],
    };

    const graph = DependencyResolver.buildDependencyGraph(dependencies);

    // Get all dependencies for D
    const allDepsD = DependencyResolver.getAllDependencies('D', graph.nodes);

    // D should have B, C, and A (without duplicates)
    expect(allDepsD).toContain('B');
    expect(allDepsD).toContain('C');
    expect(allDepsD).toContain('A');
    expect(allDepsD.length).toBe(3); // No duplicates despite A being reachable via both B and C
  });

  it('should handle long dependency chains', () => {
    // Long chain: A -> B -> C -> D -> E -> F
    const dependencies = {
      A: [],
      B: ['A'],
      C: ['B'],
      D: ['C'],
      E: ['D'],
      F: ['E'],
    };

    const graph = DependencyResolver.buildDependencyGraph(dependencies);

    // Get all dependencies for F
    const allDepsF = DependencyResolver.getAllDependencies('F', graph.nodes);

    // F should have access to all previous checks in the chain
    expect(allDepsF).toContain('E');
    expect(allDepsF).toContain('D');
    expect(allDepsF).toContain('C');
    expect(allDepsF).toContain('B');
    expect(allDepsF).toContain('A');
    expect(allDepsF.length).toBe(5);
  });

  it('should work with checks that have multiple direct dependencies', () => {
    // Complex pattern:
    //   A   B   C
    //    \ | /
    //      D
    const dependencies = {
      A: [],
      B: [],
      C: [],
      D: ['A', 'B', 'C'],
    };

    const graph = DependencyResolver.buildDependencyGraph(dependencies);

    // Get all dependencies for D
    const allDepsD = DependencyResolver.getAllDependencies('D', graph.nodes);

    // D should have access to A, B, and C
    expect(allDepsD).toContain('A');
    expect(allDepsD).toContain('B');
    expect(allDepsD).toContain('C');
    expect(allDepsD.length).toBe(3);
  });

  it('should handle mixed direct and transitive dependencies', () => {
    // Pattern:
    //   A -> B
    //   |    |
    //   v    v
    //   C <- D
    //   (D depends on B, C depends on both A and D)
    const dependencies = {
      A: [],
      B: ['A'],
      D: ['B'],
      C: ['A', 'D'],
    };

    const graph = DependencyResolver.buildDependencyGraph(dependencies);

    // Get all dependencies for C
    const allDepsC = DependencyResolver.getAllDependencies('C', graph.nodes);

    // C should have access to A (direct), D (direct), B (via D), and A (via D -> B -> A)
    expect(allDepsC).toContain('A'); // Direct dependency
    expect(allDepsC).toContain('D'); // Direct dependency
    expect(allDepsC).toContain('B'); // Transitive via D
    expect(allDepsC.length).toBe(3); // A appears only once despite multiple paths
  });
});
