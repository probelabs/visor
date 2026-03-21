/**
 * Tests for the negotiated timeout observer grantedMs scoping bug fix.
 *
 * Bug: In ProbeAgent's negotiated timeout observer, `grantedMs` and `grantedMin`
 * were declared with `const` inside the `if (decision.extend && decision.minutes > 0)`
 * block, but referenced in the return statement outside that block scope.
 * This caused a ReferenceError ("grantedMs is not defined") when the observer
 * granted an extension and the return statement tried to include grant details.
 *
 * The bundler (ncc) renamed the block-scoped `grantedMs` to `grantedMs2` inside
 * the if-block, but the outer-scope reference remained `grantedMs`, making the
 * bug manifest as a crash at runtime.
 *
 * Fix: Declare `grantedMs` and `grantedMin` with `let` before the if-block so
 * they are accessible in the return statement.
 */

import { EventEmitter } from 'events';

/**
 * Reproduces the exact observer function logic from ProbeAgent to verify
 * the scoping fix. This mirrors the code in:
 *   node_modules/@probelabs/probe/src/agent/ProbeAgent.js (lines ~3791-3882)
 */
function simulateObserverDecision(
  decision: {
    extend: boolean;
    minutes?: number;
    reason?: string;
  },
  config: {
    maxPerReqMin: number;
    remainingBudgetMs: number;
    maxPerRequestMs: number;
    extensionsUsed: number;
    maxRequests: number;
    totalExtraTimeMs: number;
  }
): {
  decision: string;
  reason: string;
  granted_ms?: number;
  granted_min?: number;
  budget_remaining_ms?: number;
  extensions_used: number;
  max_requests: number;
  total_extra_time_ms: number;
} {
  const { maxPerReqMin, remainingBudgetMs, maxPerRequestMs } = config;
  let { extensionsUsed, totalExtraTimeMs } = config;

  // FIXED: declare with `let` before the if-block so they are in scope for the return
  let grantedMs = 0;
  let grantedMin = 0;

  if (decision.extend && (decision.minutes ?? 0) > 0) {
    const requestedMs = Math.min(decision.minutes!, maxPerReqMin) * 60000;
    grantedMs = Math.min(requestedMs, remainingBudgetMs, maxPerRequestMs);
    grantedMin = Math.round((grantedMs / 60000) * 10) / 10;

    extensionsUsed++;
    totalExtraTimeMs += grantedMs;
  }

  // This return statement references grantedMs/grantedMin which were previously
  // block-scoped inside the if statement above -- causing a ReferenceError
  return {
    decision: decision.extend ? 'extended' : 'declined',
    reason: decision.reason || '',
    ...(decision.extend
      ? {
          granted_ms: grantedMs,
          granted_min: grantedMin,
          budget_remaining_ms: remainingBudgetMs - grantedMs,
        }
      : {}),
    extensions_used: extensionsUsed,
    max_requests: config.maxRequests,
    total_extra_time_ms: totalExtraTimeMs,
  };
}

/**
 * BUGGY version -- reproduces the original scoping bug where const is inside
 * the if-block but referenced in the return.
 */
function simulateObserverDecisionBuggy(
  decision: {
    extend: boolean;
    minutes?: number;
    reason?: string;
  },
  config: {
    maxPerReqMin: number;
    remainingBudgetMs: number;
    maxPerRequestMs: number;
    extensionsUsed: number;
    maxRequests: number;
    totalExtraTimeMs: number;
  }
): any {
  const { maxPerReqMin, remainingBudgetMs, maxPerRequestMs } = config;
  let { extensionsUsed, totalExtraTimeMs } = config;

  if (decision.extend && (decision.minutes ?? 0) > 0) {
    const requestedMs = Math.min(decision.minutes!, maxPerReqMin) * 60000;
    // BUG: these are const inside the if-block
    const grantedMs = Math.min(requestedMs, remainingBudgetMs, maxPerRequestMs);
    const grantedMin = Math.round((grantedMs / 60000) * 10) / 10;

    extensionsUsed++;
    totalExtraTimeMs += grantedMs;

    // Within the block, grantedMs works fine
    void grantedMs;
    void grantedMin;
  }

  // Outside the block, grantedMs is not defined -- this would throw ReferenceError
  // We access it via eval to avoid TypeScript catching the error at compile time
  return {
    decision: decision.extend ? 'extended' : 'declined',
    reason: decision.reason || '',
    // Use eval to bypass TypeScript type checking and reproduce the runtime error
    ...(decision.extend
      ? (() => {
          try {
            // This simulates what happens at runtime: the variable is not in scope
            return eval('({ granted_ms: grantedMs })');
          } catch (e) {
            throw e; // Re-throw the ReferenceError
          }
        })()
      : {}),
    extensions_used: extensionsUsed,
    max_requests: config.maxRequests,
    total_extra_time_ms: totalExtraTimeMs,
  };
}

describe('Negotiated timeout observer grantedMs scoping fix', () => {
  const defaultConfig = {
    maxPerReqMin: 10,
    remainingBudgetMs: 600_000, // 10 min
    maxPerRequestMs: 600_000,
    extensionsUsed: 0,
    maxRequests: 3,
    totalExtraTimeMs: 0,
  };

  describe('FIXED observer: grantedMs declared with let before if-block', () => {
    it('should return grant details when observer extends', () => {
      const result = simulateObserverDecision(
        { extend: true, minutes: 5, reason: 'tool still running' },
        defaultConfig
      );

      expect(result.decision).toBe('extended');
      expect(result.granted_ms).toBe(300_000); // 5 min
      expect(result.granted_min).toBe(5);
      expect(result.budget_remaining_ms).toBe(300_000);
      expect(result.extensions_used).toBe(1);
      expect(result.reason).toBe('tool still running');
    });

    it('should not crash when observer grants an extension (the original bug)', () => {
      // This is the exact scenario that caused the crash: observer says extend=true
      // and the return statement tries to access grantedMs
      expect(() => {
        simulateObserverDecision(
          { extend: true, minutes: 3, reason: 'search in progress' },
          defaultConfig
        );
      }).not.toThrow();
    });

    it('should cap grantedMs to remaining budget', () => {
      const result = simulateObserverDecision(
        { extend: true, minutes: 10, reason: 'need more time' },
        { ...defaultConfig, remainingBudgetMs: 120_000 } // only 2 min remaining
      );

      expect(result.granted_ms).toBe(120_000); // capped to budget
      expect(result.granted_min).toBe(2);
      expect(result.budget_remaining_ms).toBe(0);
    });

    it('should cap grantedMs to maxPerRequestMs', () => {
      const result = simulateObserverDecision(
        { extend: true, minutes: 10, reason: 'need more time' },
        { ...defaultConfig, maxPerRequestMs: 180_000 } // max 3 min per request
      );

      expect(result.granted_ms).toBe(180_000); // capped to max per request
      expect(result.granted_min).toBe(3);
    });

    it('should cap requested minutes to maxPerReqMin', () => {
      const result = simulateObserverDecision(
        { extend: true, minutes: 20, reason: 'need lots of time' },
        { ...defaultConfig, maxPerReqMin: 5 } // max 5 min per request
      );

      // requestedMs = min(20, 5) * 60000 = 300_000
      expect(result.granted_ms).toBe(300_000);
      expect(result.granted_min).toBe(5);
    });

    it('should return no grant details when observer declines', () => {
      const result = simulateObserverDecision(
        { extend: false, reason: 'work appears complete' },
        defaultConfig
      );

      expect(result.decision).toBe('declined');
      expect(result.granted_ms).toBeUndefined();
      expect(result.granted_min).toBeUndefined();
      expect(result.budget_remaining_ms).toBeUndefined();
      expect(result.extensions_used).toBe(0);
    });

    it('should handle extend=true but minutes=0 (edge case)', () => {
      // Observer says extend but gives 0 minutes -- if-block is NOT entered
      // but return still checks decision.extend which is truthy
      const result = simulateObserverDecision(
        { extend: true, minutes: 0, reason: 'confused observer' },
        defaultConfig
      );

      // decision.extend is true, so grant details are included (with 0 values)
      expect(result.decision).toBe('extended');
      expect(result.granted_ms).toBe(0);
      expect(result.granted_min).toBe(0);
    });

    it('should accumulate totalExtraTimeMs across extensions', () => {
      const result = simulateObserverDecision(
        { extend: true, minutes: 3, reason: 'extension 2' },
        { ...defaultConfig, extensionsUsed: 1, totalExtraTimeMs: 300_000 }
      );

      expect(result.extensions_used).toBe(2);
      expect(result.total_extra_time_ms).toBe(480_000); // 300k + 180k
    });
  });

  describe('BUGGY observer: const grantedMs scoped inside if-block', () => {
    it('should throw ReferenceError when observer grants extension (reproducing the bug)', () => {
      // This reproduces the exact crash from the trace
      expect(() => {
        simulateObserverDecisionBuggy(
          { extend: true, minutes: 5, reason: 'tool still running' },
          defaultConfig
        );
      }).toThrow(ReferenceError);
    });

    it('should NOT crash when observer declines (bug only manifests on extend)', () => {
      // When extend=false, the spread is {} so grantedMs is never accessed
      expect(() => {
        simulateObserverDecisionBuggy({ extend: false, reason: 'work complete' }, defaultConfig);
      }).not.toThrow();
    });
  });

  describe('Integration: timeout.extended event carries correct grantedMs', () => {
    it('should emit timeout.extended with correct grantedMs after observer grants', () => {
      const events = new EventEmitter();
      const received: any[] = [];

      events.on('timeout.extended', (data: any) => {
        received.push(data);
      });

      // Simulate what ProbeAgent does after the observer grants
      const decision = simulateObserverDecision(
        { extend: true, minutes: 5, reason: 'tool running' },
        defaultConfig
      );

      // The agent emits with the granted amount
      events.emit('timeout.extended', {
        grantedMs: decision.granted_ms,
        reason: 'tool running',
        extensionsUsed: decision.extensions_used,
        extensionsRemaining: defaultConfig.maxRequests - decision.extensions_used,
        totalExtraTimeMs: decision.total_extra_time_ms,
        budgetRemainingMs: decision.budget_remaining_ms,
      });

      expect(received).toHaveLength(1);
      expect(received[0].grantedMs).toBe(300_000);
      expect(received[0].extensionsUsed).toBe(1);
      expect(received[0].budgetRemainingMs).toBe(300_000);
    });

    it('should propagate grantedMs through TimeoutExtender to adjust deadline', () => {
      // Mirror of TimeoutExtender from ai-review-service.ts
      class TimeoutExtender {
        _listener?: (extraMs: number) => void;
        extend(extraMs: number): void {
          this._listener?.(extraMs);
        }
      }

      const extender = new TimeoutExtender();
      let deadlineMs = 1_800_000; // 30 min

      extender._listener = (extraMs: number) => {
        deadlineMs += extraMs;
      };

      const events = new EventEmitter();
      events.on('timeout.extended', (data: { grantedMs: number }) => {
        extender.extend(data.grantedMs);
      });

      // Observer grants 5 minutes
      const decision = simulateObserverDecision(
        { extend: true, minutes: 5, reason: 'tool running' },
        defaultConfig
      );

      events.emit('timeout.extended', {
        grantedMs: decision.granted_ms,
        reason: 'tool running',
      });

      // Deadline should have been extended by 5 min (300_000ms)
      expect(deadlineMs).toBe(2_100_000); // 30 min + 5 min = 35 min
    });
  });
});
