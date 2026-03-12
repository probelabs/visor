/**
 * Tests for deadline-based budget propagation through execution context.
 *
 * When a parent check sets a deadline, sub-workflows should have their
 * effective timeout capped to the remaining time budget.
 */

/**
 * Mirrors the logic from execution-invoker.ts for computing effective timeout
 */
function computeEffectiveTimeout(
  checkConfig: { timeout?: number; ai?: { timeout?: number } },
  parentDeadline?: number
): { effectiveTimeout: number; deadline: number } {
  const configTimeout = checkConfig.timeout || checkConfig.ai?.timeout || 1800000;
  let effectiveTimeout = configTimeout;
  if (parentDeadline) {
    const remaining = parentDeadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`Parent deadline exceeded: no time remaining`);
    }
    effectiveTimeout = Math.min(effectiveTimeout, remaining);
  }
  const deadline = Date.now() + effectiveTimeout;
  return { effectiveTimeout, deadline };
}

describe('deadline budget propagation', () => {
  describe('effective timeout computation', () => {
    it('should cap effective timeout to remaining parent budget', () => {
      const parentDeadline = Date.now() + 60000; // 60s remaining
      const { effectiveTimeout } = computeEffectiveTimeout(
        { timeout: 1800000 }, // 30 min config
        parentDeadline
      );
      expect(effectiveTimeout).toBeLessThanOrEqual(60100); // small tolerance for test execution time
      expect(effectiveTimeout).toBeGreaterThan(59000);
    });

    it('should use config timeout when no parent deadline exists', () => {
      const { effectiveTimeout } = computeEffectiveTimeout({ timeout: 1800000 }, undefined);
      expect(effectiveTimeout).toBe(1800000);
    });

    it('should throw when parent deadline is already exceeded', () => {
      const parentDeadline = Date.now() - 1000; // 1 second ago
      expect(() => computeEffectiveTimeout({ timeout: 1800000 }, parentDeadline)).toThrow(
        'Parent deadline exceeded'
      );
    });

    it('should throw when parent deadline is exactly now', () => {
      const parentDeadline = Date.now() - 1; // just passed
      expect(() => computeEffectiveTimeout({ timeout: 1800000 }, parentDeadline)).toThrow(
        'Parent deadline exceeded'
      );
    });

    it('should use config timeout when shorter than remaining budget', () => {
      const parentDeadline = Date.now() + 300000; // 5 min remaining
      const { effectiveTimeout } = computeEffectiveTimeout(
        { timeout: 30000 }, // 30s config — shorter than budget
        parentDeadline
      );
      expect(effectiveTimeout).toBe(30000);
    });

    it('should fall back to ai.timeout when no check-level timeout', () => {
      const { effectiveTimeout } = computeEffectiveTimeout(
        { ai: { timeout: 600000 } }, // 10 min AI timeout
        undefined
      );
      expect(effectiveTimeout).toBe(600000);
    });

    it('should fall back to default 1800000 when no timeout configured', () => {
      const { effectiveTimeout } = computeEffectiveTimeout({}, undefined);
      expect(effectiveTimeout).toBe(1800000);
    });

    it('should cap ai.timeout against parent deadline', () => {
      const parentDeadline = Date.now() + 30000; // 30s remaining
      const { effectiveTimeout } = computeEffectiveTimeout(
        { ai: { timeout: 600000 } }, // 10 min AI timeout
        parentDeadline
      );
      expect(effectiveTimeout).toBeLessThanOrEqual(30100);
      expect(effectiveTimeout).toBeGreaterThan(29000);
    });

    it('should handle very small remaining budget', () => {
      const parentDeadline = Date.now() + 100; // 100ms remaining
      const { effectiveTimeout } = computeEffectiveTimeout({ timeout: 1800000 }, parentDeadline);
      expect(effectiveTimeout).toBeLessThanOrEqual(200);
      expect(effectiveTimeout).toBeGreaterThan(0);
    });
  });

  describe('deadline propagation through nested contexts', () => {
    it('should propagate deadline through execution context to child', () => {
      // Parent sets a 60s deadline
      const { deadline: parentDeadline } = computeEffectiveTimeout({ timeout: 60000 }, undefined);

      const executionContext = { deadline: parentDeadline };

      // Child reads parent deadline — its 30-min config gets capped
      const { effectiveTimeout: childTimeout } = computeEffectiveTimeout(
        { timeout: 1800000 },
        executionContext.deadline
      );

      expect(childTimeout).toBeLessThanOrEqual(60100);
      expect(childTimeout).toBeGreaterThan(59000);
    });

    it('should propagate budget through multiple nesting levels', () => {
      // Level 0: 2 minute budget
      const { deadline: l0Deadline } = computeEffectiveTimeout({ timeout: 120000 }, undefined);

      // Level 1: inherits from level 0, configured at 5 min (capped to ~2 min)
      const { deadline: l1Deadline, effectiveTimeout: l1Timeout } = computeEffectiveTimeout(
        { timeout: 300000 },
        l0Deadline
      );
      expect(l1Timeout).toBeLessThanOrEqual(120100);

      // Level 2: inherits from level 1, configured at 30 min (capped to ~2 min)
      const { effectiveTimeout: l2Timeout } = computeEffectiveTimeout(
        { timeout: 1800000 },
        l1Deadline
      );
      expect(l2Timeout).toBeLessThanOrEqual(120100);
      expect(l2Timeout).toBeGreaterThan(0);
    });

    it('should shrink budget at each nesting level as time elapses', async () => {
      // Level 0: 500ms budget
      const { deadline: l0Deadline } = computeEffectiveTimeout({ timeout: 500 }, undefined);

      // Simulate 200ms of work
      await new Promise(resolve => setTimeout(resolve, 200));

      // Level 1: should have ~300ms remaining
      const { effectiveTimeout: l1Timeout } = computeEffectiveTimeout(
        { timeout: 1800000 },
        l0Deadline
      );
      expect(l1Timeout).toBeLessThanOrEqual(350);
      expect(l1Timeout).toBeGreaterThan(200);
    });

    it('should fail fast when parent budget exhausted between levels', async () => {
      // Level 0: 100ms budget
      const { deadline: l0Deadline } = computeEffectiveTimeout({ timeout: 100 }, undefined);

      // Simulate 150ms of work — exceeds budget
      await new Promise(resolve => setTimeout(resolve, 150));

      // Level 1: should throw
      expect(() => computeEffectiveTimeout({ timeout: 1800000 }, l0Deadline)).toThrow(
        'Parent deadline exceeded'
      );
    });
  });

  describe('check-level timeout takes precedence over check.ai.timeout', () => {
    it('should prefer check timeout over ai timeout', () => {
      const { effectiveTimeout } = computeEffectiveTimeout(
        { timeout: 60000, ai: { timeout: 300000 } },
        undefined
      );
      // check.timeout is truthy, so it wins
      expect(effectiveTimeout).toBe(60000);
    });
  });
});
