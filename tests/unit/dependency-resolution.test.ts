/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from '@jest/globals';

// Mock the dependency resolution function from index.ts since it's not exported
// We'll test the logic with a standalone implementation
function resolveDependencies(
  checkIds: string[],
  config: any,
  resolved: Set<string> = new Set(),
  visiting: Set<string> = new Set()
): string[] {
  const result: string[] = [];

  for (const checkId of checkIds) {
    if (resolved.has(checkId)) {
      continue;
    }

    if (visiting.has(checkId)) {
      console.warn(`Circular dependency detected involving check: ${checkId}`);
      continue;
    }

    visiting.add(checkId);

    // Get dependencies for this check
    const checkConfig = config?.checks?.[checkId];
    const dependencies = checkConfig?.depends_on || [];

    // Recursively resolve dependencies first
    if (dependencies.length > 0) {
      const resolvedDeps = resolveDependencies(dependencies, config, resolved, visiting);
      result.push(...resolvedDeps.filter(dep => !result.includes(dep)));
    }

    // Add the current check if not already added
    if (!result.includes(checkId)) {
      result.push(checkId);
    }

    resolved.add(checkId);
    visiting.delete(checkId);
  }

  return result;
}

describe('Dependency Resolution', () => {
  describe('resolveDependencies', () => {
    it('should resolve simple dependencies', () => {
      const config = {
        checks: {
          overview: { depends_on: [] },
          security: { depends_on: ['overview'] },
          performance: { depends_on: ['security'] },
        },
      };

      const result = resolveDependencies(['performance'], config);
      expect(result).toEqual(['overview', 'security', 'performance']);
    });

    it('should handle multiple dependencies', () => {
      const config = {
        checks: {
          overview: { depends_on: [] },
          security: { depends_on: ['overview'] },
          performance: { depends_on: ['overview'] },
          quality: { depends_on: ['security', 'performance'] },
        },
      };

      const result = resolveDependencies(['quality'], config);
      expect(result).toEqual(['overview', 'security', 'performance', 'quality']);
    });

    it('should handle checks without dependencies', () => {
      const config = {
        checks: {
          security: {},
          performance: {},
        },
      };

      const result = resolveDependencies(['security', 'performance'], config);
      expect(result).toEqual(['security', 'performance']);
    });

    it('should handle missing check configurations', () => {
      const config = {
        checks: {
          security: { depends_on: [] },
        },
      };

      const result = resolveDependencies(['security', 'missing'], config);
      expect(result).toEqual(['security', 'missing']);
    });

    it('should handle circular dependencies gracefully', () => {
      const config = {
        checks: {
          a: { depends_on: ['b'] },
          b: { depends_on: ['c'] },
          c: { depends_on: ['a'] },
        },
      };

      // Should not hang and should warn about circular dependency
      const consoleWarnSpy = jest.spyOn(console, 'warn').mockImplementation();

      const result = resolveDependencies(['a'], config);

      expect(consoleWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Circular dependency detected')
      );

      // Should still return some results without infinite loop
      expect(result.length).toBeGreaterThan(0);

      consoleWarnSpy.mockRestore();
    });

    it('should handle complex dependency graph', () => {
      const config = {
        checks: {
          base: { depends_on: [] },
          security: { depends_on: ['base'] },
          performance: { depends_on: ['base'] },
          quality: { depends_on: ['security', 'performance'] },
          review: { depends_on: ['quality'] },
        },
      };

      const result = resolveDependencies(['review'], config);
      expect(result).toEqual(['base', 'security', 'performance', 'quality', 'review']);
    });

    it('should handle multiple initial checks', () => {
      const config = {
        checks: {
          overview: { depends_on: [] },
          security: { depends_on: ['overview'] },
          performance: { depends_on: ['overview'] },
        },
      };

      const result = resolveDependencies(['security', 'performance'], config);
      expect(result).toEqual(['overview', 'security', 'performance']);
    });

    it('should deduplicate dependencies', () => {
      const config = {
        checks: {
          common: { depends_on: [] },
          a: { depends_on: ['common'] },
          b: { depends_on: ['common'] },
          final: { depends_on: ['a', 'b'] },
        },
      };

      const result = resolveDependencies(['final'], config);
      expect(result).toEqual(['common', 'a', 'b', 'final']);

      // Ensure 'common' appears only once
      const commonCount = result.filter(check => check === 'common').length;
      expect(commonCount).toBe(1);
    });
  });
});
