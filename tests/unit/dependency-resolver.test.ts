import { DependencyResolver, DependencyGraph } from '../../src/dependency-resolver';

describe('DependencyResolver', () => {
  describe('buildDependencyGraph', () => {
    it('should build a simple dependency graph with no dependencies', () => {
      const dependencies = {
        security: [],
        performance: [],
        style: [],
      };

      const graph = DependencyResolver.buildDependencyGraph(dependencies);

      expect(graph.hasCycles).toBe(false);
      expect(graph.executionOrder).toHaveLength(1);
      expect(graph.executionOrder[0].level).toBe(0);
      expect(graph.executionOrder[0].parallel).toEqual(
        expect.arrayContaining(['security', 'performance', 'style'])
      );
      expect(graph.executionOrder[0].parallel).toHaveLength(3);
    });

    it('should build a linear dependency chain', () => {
      const dependencies = {
        security: [],
        performance: ['security'],
        style: ['performance'],
      };

      const graph = DependencyResolver.buildDependencyGraph(dependencies);

      expect(graph.hasCycles).toBe(false);
      expect(graph.executionOrder).toHaveLength(3);

      // Level 0: security (no dependencies)
      expect(graph.executionOrder[0].parallel).toEqual(['security']);
      expect(graph.executionOrder[0].level).toBe(0);

      // Level 1: performance (depends on security)
      expect(graph.executionOrder[1].parallel).toEqual(['performance']);
      expect(graph.executionOrder[1].level).toBe(1);

      // Level 2: style (depends on performance)
      expect(graph.executionOrder[2].parallel).toEqual(['style']);
      expect(graph.executionOrder[2].level).toBe(2);
    });

    it('should handle mixed parallel and sequential dependencies', () => {
      const dependencies = {
        security: [],
        performance: [],
        style: ['security', 'performance'],
        architecture: ['style'],
        documentation: ['security'],
      };

      const graph = DependencyResolver.buildDependencyGraph(dependencies);

      expect(graph.hasCycles).toBe(false);
      expect(graph.executionOrder).toHaveLength(3);

      // Level 0: security, performance (no dependencies)
      expect(graph.executionOrder[0].parallel).toEqual(
        expect.arrayContaining(['security', 'performance'])
      );
      expect(graph.executionOrder[0].parallel).toHaveLength(2);
      expect(graph.executionOrder[0].level).toBe(0);

      // Level 1: style, documentation (depend on level 0 checks)
      expect(graph.executionOrder[1].parallel).toEqual(
        expect.arrayContaining(['style', 'documentation'])
      );
      expect(graph.executionOrder[1].parallel).toHaveLength(2);
      expect(graph.executionOrder[1].level).toBe(1);

      // Level 2: architecture (depends on style)
      expect(graph.executionOrder[2].parallel).toEqual(['architecture']);
      expect(graph.executionOrder[2].level).toBe(2);
    });

    it('should detect circular dependencies', () => {
      const dependencies = {
        security: ['performance'],
        performance: ['style'],
        style: ['security'],
      };

      const graph = DependencyResolver.buildDependencyGraph(dependencies);

      expect(graph.hasCycles).toBe(true);
      expect(graph.cycleNodes).toEqual(
        expect.arrayContaining(['security', 'performance', 'style'])
      );
      expect(graph.executionOrder).toHaveLength(0);
    });

    it('should detect self-referencing dependency', () => {
      const dependencies = {
        security: ['security'],
      };

      const graph = DependencyResolver.buildDependencyGraph(dependencies);

      expect(graph.hasCycles).toBe(true);
      expect(graph.cycleNodes).toContain('security');
    });

    it('should throw error for missing dependency', () => {
      const dependencies = {
        security: ['nonexistent'],
      };

      expect(() => {
        DependencyResolver.buildDependencyGraph(dependencies);
      }).toThrow('Check "security" depends on "nonexistent" but "nonexistent" is not defined');
    });
  });

  describe('validateDependencies', () => {
    it('should validate correct dependencies', () => {
      const checkIds = ['security', 'performance', 'style'];
      const dependencies = {
        security: [],
        performance: ['security'],
        style: ['performance'],
      };

      const result = DependencyResolver.validateDependencies(checkIds, dependencies);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should detect missing check in available list', () => {
      const checkIds = ['security', 'performance'];
      const dependencies = {
        security: [],
        performance: ['security'],
        style: ['performance'], // style not in checkIds
      };

      const result = DependencyResolver.validateDependencies(checkIds, dependencies);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Check "style" is not in the list of available checks');
    });

    it('should detect missing dependency target', () => {
      const checkIds = ['security', 'performance'];
      const dependencies = {
        security: [],
        performance: ['style'], // style not in checkIds
      };

      const result = DependencyResolver.validateDependencies(checkIds, dependencies);

      expect(result.valid).toBe(false);
      expect(result.errors).toContain('Check "performance" depends on "style" which is not available');
    });
  });

  describe('getExecutionStats', () => {
    it('should calculate execution statistics correctly', () => {
      const dependencies = {
        security: [],
        performance: [],
        style: ['security', 'performance'],
        architecture: ['style'],
        documentation: ['security'],
      };

      const graph = DependencyResolver.buildDependencyGraph(dependencies);
      const stats = DependencyResolver.getExecutionStats(graph);

      expect(stats.totalChecks).toBe(5);
      expect(stats.parallelLevels).toBe(3);
      expect(stats.maxParallelism).toBe(2); // Level 0 and 1 both have 2 parallel checks
      expect(stats.averageParallelism).toBeCloseTo(5 / 3, 1);
      expect(stats.checksWithDependencies).toBe(3); // style, architecture, documentation
    });

    it('should handle single check with no dependencies', () => {
      const dependencies = {
        security: [],
      };

      const graph = DependencyResolver.buildDependencyGraph(dependencies);
      const stats = DependencyResolver.getExecutionStats(graph);

      expect(stats.totalChecks).toBe(1);
      expect(stats.parallelLevels).toBe(1);
      expect(stats.maxParallelism).toBe(1);
      expect(stats.averageParallelism).toBe(1);
      expect(stats.checksWithDependencies).toBe(0);
    });
  });

  describe('complex dependency scenarios', () => {
    it('should handle diamond dependency pattern', () => {
      const dependencies = {
        base: [],
        left: ['base'],
        right: ['base'],
        top: ['left', 'right'],
      };

      const graph = DependencyResolver.buildDependencyGraph(dependencies);

      expect(graph.hasCycles).toBe(false);
      expect(graph.executionOrder).toHaveLength(3);

      // Level 0: base
      expect(graph.executionOrder[0].parallel).toEqual(['base']);
      
      // Level 1: left, right (both depend on base)
      expect(graph.executionOrder[1].parallel).toEqual(
        expect.arrayContaining(['left', 'right'])
      );
      expect(graph.executionOrder[1].parallel).toHaveLength(2);
      
      // Level 2: top (depends on both left and right)
      expect(graph.executionOrder[2].parallel).toEqual(['top']);
    });

    it('should handle multiple independent chains', () => {
      const dependencies = {
        // Chain 1: A -> B -> C
        chainA1: [],
        chainA2: ['chainA1'],
        chainA3: ['chainA2'],
        // Chain 2: X -> Y
        chainB1: [],
        chainB2: ['chainB1'],
        // Independent
        independent: [],
      };

      const graph = DependencyResolver.buildDependencyGraph(dependencies);

      expect(graph.hasCycles).toBe(false);
      expect(graph.executionOrder).toHaveLength(3);

      // Level 0: chainA1, chainB1, independent
      expect(graph.executionOrder[0].parallel).toEqual(
        expect.arrayContaining(['chainA1', 'chainB1', 'independent'])
      );
      
      // Level 1: chainA2, chainB2
      expect(graph.executionOrder[1].parallel).toEqual(
        expect.arrayContaining(['chainA2', 'chainB2'])
      );
      
      // Level 2: chainA3
      expect(graph.executionOrder[2].parallel).toEqual(['chainA3']);
    });
  });
});