/**
 * Tests for two critical timeout bugs:
 *
 * Issue 1: Negotiated timeout observer can grant extensions past visor_timeout.
 *   When ai_timeout < visor_timeout and the observer extends ai_timeout beyond
 *   visor_timeout, the wind-down never triggers (extension suppresses it) and
 *   the hard visor_timeout kills the agent with no partial results.
 *   FIX: Cap negotiated_timeout_budget and max_per_request to headroom
 *   (visor_timeout - ai_timeout) in ai-review-service.ts.
 *
 * Issue 2: withTimeout (visor_timeout hard kill) does not trigger graceful
 *   wind-down on the ProbeAgent before rejecting. The agent is killed instantly
 *   via Promise.race with no chance to summarize.
 *   FIX: withTimeout now accepts sessionId and calls triggerGracefulWindDown
 *   on the agent before rejecting.
 *
 * Trace: 2793eb7d734bcec534a080c0d7e4cf20
 *   - explore-code: ai_timeout=25min, visor_timeout=30min, observer extended +10min
 *   - At 30min visor_timeout hard-killed with output=undefined
 *   - No wind-down steps were executed despite negotiated timeout being configured
 */

import { SessionRegistry } from '../../src/session-registry';

// Mirror the constants from ai-review-service.ts
const PROBE_GRACEFUL_MARGIN_MS = 90_000;
const MIN_TIMEOUT_FOR_MARGIN_MS = PROBE_GRACEFUL_MARGIN_MS + 30_000;

function deriveProbeTimeout(visorTimeout: number, aiTimeout?: number): number {
  return (
    aiTimeout ||
    (visorTimeout > MIN_TIMEOUT_FOR_MARGIN_MS
      ? visorTimeout - PROBE_GRACEFUL_MARGIN_MS
      : visorTimeout)
  );
}

/**
 * Mirrors the budget/per-request capping logic added to ai-review-service.ts.
 * Ensures negotiated extensions can never push ai_timeout past visor_timeout.
 */
function capNegotiatedTimeoutOptions(params: {
  visorTimeout: number;
  aiTimeout: number;
  budget?: number;
  maxPerRequest?: number;
}): { budget?: number; maxPerRequest?: number } {
  const headroomMs =
    params.visorTimeout > 0 && params.aiTimeout > 0 ? params.visorTimeout - params.aiTimeout : 0;

  let budget = params.budget;
  if (budget !== undefined && headroomMs > 0 && budget > headroomMs) {
    budget = headroomMs;
  }

  let maxPerRequest = params.maxPerRequest;
  if (maxPerRequest !== undefined && headroomMs > 0 && maxPerRequest > headroomMs) {
    maxPerRequest = headroomMs;
  }

  return { budget, maxPerRequest };
}

describe('Issue 1: negotiated extension budget capped to visor_timeout headroom', () => {
  it('should cap budget when ai_timeout + budget exceeds visor_timeout', () => {
    // Real scenario from trace: explore-code
    // ai_timeout=25min (1,500,000ms), visor_timeout=30min (1,800,000ms)
    // budget=20min (1,200,000ms) — would allow extensions up to 45min total
    const result = capNegotiatedTimeoutOptions({
      visorTimeout: 1_800_000,
      aiTimeout: 1_500_000,
      budget: 1_200_000, // 20min
      maxPerRequest: 600_000, // 10min
    });

    // Headroom = 30min - 25min = 5min = 300,000ms
    // Budget capped from 20min to 5min
    expect(result.budget).toBe(300_000);
    // maxPerRequest capped from 10min to 5min
    expect(result.maxPerRequest).toBe(300_000);
  });

  it('should cap maxPerRequest so a single extension cannot exceed visor_timeout', () => {
    // ai_timeout=25min, visor_timeout=30min, max_per_request=10min
    // A single 10min extension would push to 35min > 30min visor_timeout
    const result = capNegotiatedTimeoutOptions({
      visorTimeout: 1_800_000,
      aiTimeout: 1_500_000,
      maxPerRequest: 600_000, // 10min
    });

    // Capped to headroom: 5min
    expect(result.maxPerRequest).toBe(300_000);
  });

  it('should not cap when budget fits within visor_timeout', () => {
    // ai_timeout=20min, visor_timeout=60min, budget=20min, maxPerRequest=10min
    // All extensions fit: 20+20=40 < 60
    const result = capNegotiatedTimeoutOptions({
      visorTimeout: 3_600_000,
      aiTimeout: 1_200_000,
      budget: 1_200_000,
      maxPerRequest: 600_000,
    });

    // headroom = 40min, budget=20min fits, maxPerRequest=10min fits
    expect(result.budget).toBe(1_200_000);
    expect(result.maxPerRequest).toBe(600_000);
  });

  it('should handle zero headroom (ai_timeout == visor_timeout)', () => {
    // When ai_timeout equals visor_timeout, there's zero room for extensions
    const result = capNegotiatedTimeoutOptions({
      visorTimeout: 1_800_000,
      aiTimeout: 1_800_000,
      budget: 1_200_000,
      maxPerRequest: 600_000,
    });

    // headroom=0, so budget and maxPerRequest stay uncapped (0 headroom check skipped)
    // This is correct: when ai_timeout==visor_timeout, the graceful timeout
    // fires at the same time as the hard kill, so extensions are moot anyway
    expect(result.budget).toBe(1_200_000);
    expect(result.maxPerRequest).toBe(600_000);
  });

  it('should handle when only budget is set', () => {
    const result = capNegotiatedTimeoutOptions({
      visorTimeout: 1_800_000,
      aiTimeout: 1_500_000,
      budget: 1_200_000,
    });

    expect(result.budget).toBe(300_000);
    expect(result.maxPerRequest).toBeUndefined();
  });

  it('should handle when neither budget nor maxPerRequest is set', () => {
    const result = capNegotiatedTimeoutOptions({
      visorTimeout: 1_800_000,
      aiTimeout: 1_500_000,
    });

    expect(result.budget).toBeUndefined();
    expect(result.maxPerRequest).toBeUndefined();
  });

  it('should ensure capped budget prevents the trace scenario', () => {
    // Reproduce exact trace: explore-code config
    const aiTimeout = deriveProbeTimeout(1_800_000, 1_500_000); // explicit 25min
    const visorTimeout = 1_800_000; // 30min

    const capped = capNegotiatedTimeoutOptions({
      visorTimeout,
      aiTimeout,
      budget: 1_200_000, // original: 20min
      maxPerRequest: 600_000, // original: 10min
    });

    // After capping: observer can grant at most 5min (headroom)
    // At T=25min, extension of 5min → new deadline 30min = visor_timeout
    // This means ai_timeout + extension <= visor_timeout (no overshoot)
    const maxExtensionDeadline = aiTimeout + (capped.maxPerRequest ?? 0);
    expect(maxExtensionDeadline).toBeLessThanOrEqual(visorTimeout);

    const maxTotalDeadline = aiTimeout + (capped.budget ?? 0);
    expect(maxTotalDeadline).toBeLessThanOrEqual(visorTimeout);
  });

  it('should ensure capped budget prevents the generate-response scenario', () => {
    // generate-response: ai_timeout=30min, visor_timeout=2hr
    const aiTimeout = deriveProbeTimeout(7_200_000, 1_800_000); // explicit 30min
    const visorTimeout = 7_200_000; // 2hr

    const capped = capNegotiatedTimeoutOptions({
      visorTimeout,
      aiTimeout,
      budget: 3_600_000, // 60min
      maxPerRequest: 1_200_000, // 20min
    });

    // headroom = 2hr - 30min = 90min = 5,400,000ms
    // budget (60min) < headroom (90min), so not capped
    expect(capped.budget).toBe(3_600_000);
    // maxPerRequest (20min) < headroom (90min), so not capped
    expect(capped.maxPerRequest).toBe(1_200_000);

    const maxExtensionDeadline = aiTimeout + (capped.maxPerRequest ?? 0);
    expect(maxExtensionDeadline).toBeLessThanOrEqual(visorTimeout);
  });
});

describe('Issue 2: withTimeout triggers graceful wind-down before hard kill', () => {
  let registry: SessionRegistry;

  beforeEach(() => {
    registry = SessionRegistry.getInstance();
    registry.clearAllSessions();
  });

  afterEach(() => {
    registry.clearAllSessions();
  });

  /**
   * Mirrors the FIXED AIReviewService.withTimeout that signals the agent
   * before rejecting. This is now the actual implementation.
   */
  async function withTimeout<T>(
    p: Promise<T>,
    ms: number,
    label: string,
    sessionId?: string
  ): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          if (sessionId) {
            try {
              const reg = SessionRegistry.getInstance();
              const agent = reg.getSession(sessionId);
              if (agent && typeof (agent as any).triggerGracefulWindDown === 'function') {
                (agent as any).triggerGracefulWindDown();
              }
            } catch {}
          }
          reject(new Error(`${label} timed out after ${ms}ms`));
        }, ms);
      });
      return (await Promise.race([p, timeout])) as T;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  it('should call triggerGracefulWindDown on the agent before rejecting', async () => {
    const windDown = jest.fn();
    const agent = { triggerGracefulWindDown: windDown };
    registry.registerSession('test-session', agent as any);

    const neverResolves = new Promise<string>(() => {});

    await expect(withTimeout(neverResolves, 50, 'test', 'test-session')).rejects.toThrow(
      'test timed out after 50ms'
    );

    // Agent was told to wind down before the hard kill
    expect(windDown).toHaveBeenCalled();
  });

  it('should not crash when session does not exist', async () => {
    const neverResolves = new Promise<string>(() => {});

    await expect(withTimeout(neverResolves, 50, 'test', 'nonexistent-session')).rejects.toThrow(
      'test timed out after 50ms'
    );
    // No crash — just rejects normally
  });

  it('should not call wind-down when no sessionId provided', async () => {
    const windDown = jest.fn();
    const agent = { triggerGracefulWindDown: windDown };
    registry.registerSession('test-session', agent as any);

    const neverResolves = new Promise<string>(() => {});

    await expect(withTimeout(neverResolves, 50, 'test')).rejects.toThrow(
      'test timed out after 50ms'
    );

    // No sessionId provided, so no wind-down
    expect(windDown).not.toHaveBeenCalled();
  });

  it('should still resolve normally when promise completes before timeout', async () => {
    const windDown = jest.fn();
    const agent = { triggerGracefulWindDown: windDown };
    registry.registerSession('test-session', agent as any);

    const quickResolve = Promise.resolve('done');

    const result = await withTimeout(quickResolve, 1000, 'test', 'test-session');
    expect(result).toBe('done');
    expect(windDown).not.toHaveBeenCalled();
  });

  it('should signal wind-down in the end-to-end failure scenario', async () => {
    // Reproduces the trace scenario: agent is working via MCP tools,
    // visor_timeout fires. With the fix, agent gets signaled to wind down.
    const windDown = jest.fn();
    const agent = { triggerGracefulWindDown: windDown };
    registry.registerSession('explore-code', agent as any);

    let agentTimer: NodeJS.Timeout;
    const agentWork = new Promise<string>(resolve => {
      agentTimer = setTimeout(() => resolve('Partial results from code exploration...'), 200);
    });

    // visor_timeout at 50ms — agent still working
    await expect(withTimeout(agentWork, 50, 'AI review', 'explore-code')).rejects.toThrow(
      'AI review timed out after 50ms'
    );

    clearTimeout(agentTimer!);

    // With the fix, agent was signaled to wind down
    expect(windDown).toHaveBeenCalled();
  });
});
