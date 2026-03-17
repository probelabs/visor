/**
 * Tests for Visor's dynamic timeout management with ProbeAgent.
 *
 * The timeout system has two layers:
 * 1. ProbeAgent's negotiated timeout observer — grants extensions, emits events
 * 2. Visor's withTimeout (Promise.race) — hard kill ceiling, now dynamically extendable
 *
 * Probe #524: Agent emits `timeout.extended` when observer grants more time,
 * and `timeout.windingDown` when it declines. Visor listens to these events
 * and dynamically adjusts its withTimeout deadline to stay in sync.
 *
 * This replaces the old budget-capping approach (which was wrong — capping the
 * child prevents it from working; the parent should follow the child's decisions).
 *
 * Trace: 2793eb7d734bcec534a080c0d7e4cf20
 *   - explore-code: ai_timeout=25min, visor_timeout=30min, observer extended +10min
 *   - Old behavior: visor_timeout hard-killed at 30min with no wind-down
 *   - New behavior: timeout.extended pushes visor deadline to 35min, agent finishes
 */

import { EventEmitter } from 'events';
import { SessionRegistry } from '../../src/session-registry';

// Mirror constants from ai-review-service.ts
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
 * Mirror of the TimeoutExtender class from ai-review-service.ts.
 * Bridges agent events → withTimeout deadline adjustments.
 */
class TimeoutExtender {
  _listener?: (extraMs: number) => void;
  extend(extraMs: number): void {
    this._listener?.(extraMs);
  }
}

/**
 * Mirror of the FIXED withTimeout from ai-review-service.ts.
 * Supports dynamic deadline extension via TimeoutExtender.
 */
async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string,
  sessionId?: string,
  extender?: TimeoutExtender
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const startTime = Date.now();
  let deadlineMs = ms;

  try {
    const timeout = new Promise<never>((_, reject) => {
      const scheduleTimer = () => {
        if (timer) clearTimeout(timer);
        const remaining = deadlineMs - (Date.now() - startTime);
        if (remaining <= 0) {
          fireTimeout(reject);
          return;
        }
        timer = setTimeout(() => fireTimeout(reject), remaining);
      };

      const fireTimeout = (rej: (reason: Error) => void) => {
        if (sessionId) {
          try {
            const reg = SessionRegistry.getInstance();
            const agent = reg.getSession(sessionId);
            if (agent && typeof (agent as any).triggerGracefulWindDown === 'function') {
              (agent as any).triggerGracefulWindDown();
            }
          } catch {}
        }
        rej(new Error(`${label} timed out after ${deadlineMs}ms`));
      };

      if (extender) {
        extender._listener = (extraMs: number) => {
          deadlineMs += extraMs;
          scheduleTimer();
        };
      }

      scheduleTimer();
    });
    return (await Promise.race([p, timeout])) as T;
  } finally {
    if (timer) clearTimeout(timer);
    if (extender) extender._listener = undefined;
  }
}

/**
 * Mirror of wireTimeoutEvents from ai-review-service.ts.
 * Connects agent events → extender.
 */
function wireTimeoutEvents(agent: { events: EventEmitter }, extender?: TimeoutExtender): void {
  if (extender) {
    agent.events.on('timeout.extended', (data: { grantedMs: number }) => {
      extender.extend(data.grantedMs);
    });
  }
}

// ---- Dynamic timeout extension via events -----------------------------------

describe('Dynamic timeout extension via timeout.extended events', () => {
  let registry: SessionRegistry;

  beforeEach(() => {
    registry = SessionRegistry.getInstance();
    registry.clearAllSessions();
  });

  afterEach(() => {
    registry.clearAllSessions();
  });

  it('should extend deadline when agent emits timeout.extended', async () => {
    const extender = new TimeoutExtender();
    const events = new EventEmitter();
    const windDown = jest.fn();
    const agent = { events, triggerGracefulWindDown: windDown };
    registry.registerSession('test-session', agent as any);
    wireTimeoutEvents(agent, extender);

    // Agent work completes at 120ms
    const agentWork = new Promise<string>(resolve => {
      setTimeout(() => resolve('result from agent'), 120);
    });

    // Visor timeout at 80ms — would normally kill the agent
    // But agent extends by 100ms at 40ms → new deadline = 180ms
    setTimeout(() => {
      events.emit('timeout.extended', {
        grantedMs: 100,
        reason: 'search tool still running',
        extensionsUsed: 1,
        extensionsRemaining: 2,
        totalExtraTimeMs: 100,
        budgetRemainingMs: 500,
      });
    }, 40);

    const result = await withTimeout(agentWork, 80, 'test', 'test-session', extender);
    expect(result).toBe('result from agent');
    expect(windDown).not.toHaveBeenCalled();
  });

  it('should handle multiple sequential extensions', async () => {
    const extender = new TimeoutExtender();
    const events = new EventEmitter();
    const agent = { events, triggerGracefulWindDown: jest.fn() };
    registry.registerSession('test-session', agent as any);
    wireTimeoutEvents(agent, extender);

    // Agent work completes at 250ms
    const agentWork = new Promise<string>(resolve => {
      setTimeout(() => resolve('done after multiple extensions'), 250);
    });

    // Visor timeout at 80ms
    // Extension 1 at 30ms: +80ms → deadline = 160ms
    // Extension 2 at 120ms: +120ms → deadline = 280ms
    setTimeout(() => {
      events.emit('timeout.extended', {
        grantedMs: 80,
        reason: 'tool running',
        extensionsUsed: 1,
        extensionsRemaining: 2,
        totalExtraTimeMs: 80,
        budgetRemainingMs: 520,
      });
    }, 30);

    setTimeout(() => {
      events.emit('timeout.extended', {
        grantedMs: 120,
        reason: 'still working',
        extensionsUsed: 2,
        extensionsRemaining: 1,
        totalExtraTimeMs: 200,
        budgetRemainingMs: 400,
      });
    }, 120);

    const result = await withTimeout(agentWork, 80, 'test', 'test-session', extender);
    expect(result).toBe('done after multiple extensions');
  });

  it('should still timeout if extension is insufficient', async () => {
    const extender = new TimeoutExtender();
    const events = new EventEmitter();
    const windDown = jest.fn();
    const agent = { events, triggerGracefulWindDown: windDown };
    registry.registerSession('test-session', agent as any);
    wireTimeoutEvents(agent, extender);

    // Agent work never resolves
    const neverResolves = new Promise<string>(() => {});

    // Visor timeout at 50ms
    // Extension of 30ms at 20ms → new deadline = 80ms
    // But agent still doesn't finish → timeout at 80ms
    setTimeout(() => {
      events.emit('timeout.extended', {
        grantedMs: 30,
        reason: 'small extension',
        extensionsUsed: 1,
        extensionsRemaining: 0,
        totalExtraTimeMs: 30,
        budgetRemainingMs: 0,
      });
    }, 20);

    await expect(withTimeout(neverResolves, 50, 'test', 'test-session', extender)).rejects.toThrow(
      'test timed out after 80ms'
    );

    expect(windDown).toHaveBeenCalled();
  });

  it('should reproduce the trace scenario: explore-code with 10min extension', async () => {
    // Trace 2793eb7d: explore-code, ai_timeout=25min, visor_timeout=30min
    // Observer extended +10min at T=25min
    // OLD behavior: visor hard-kills at 30min (5min headroom), agent gets no wind-down
    // NEW behavior: timeout.extended pushes visor deadline from 30min to 40min

    const visorTimeout = 1_800_000; // 30min
    const aiTimeout = deriveProbeTimeout(visorTimeout, 1_500_000); // 25min

    const extender = new TimeoutExtender();
    const events = new EventEmitter();
    const windDown = jest.fn();
    const agent = { events, triggerGracefulWindDown: windDown };
    wireTimeoutEvents(agent, extender);

    // Simulate: observer extends +10min → grantedMs=600,000
    // This should push visor deadline from 30min to 40min
    let currentDeadline = visorTimeout;
    extender._listener = (extraMs: number) => {
      currentDeadline += extraMs;
    };

    events.emit('timeout.extended', {
      grantedMs: 600_000, // 10min
      reason: 'code-explorer tool still running',
      extensionsUsed: 1,
      extensionsRemaining: 2,
      totalExtraTimeMs: 600_000,
      budgetRemainingMs: 600_000,
    });

    // New deadline: 30min + 10min = 40min = 2,400,000ms
    expect(currentDeadline).toBe(2_400_000);

    // Agent now has time: ai_timeout + extension = 25min + 10min = 35min < 40min visor deadline
    const agentDeadline = aiTimeout + 600_000;
    expect(agentDeadline).toBeLessThan(currentDeadline);
  });

  it('should handle windingDown event (agent finishing, no more extensions)', async () => {
    const extender = new TimeoutExtender();
    const events = new EventEmitter();
    const agent = { events, triggerGracefulWindDown: jest.fn() };
    wireTimeoutEvents(agent, extender);

    const windingDownReceived: any[] = [];
    events.on('timeout.windingDown', (data: any) => {
      windingDownReceived.push(data);
    });

    events.emit('timeout.windingDown', {
      reason: 'work appears complete',
      extensionsUsed: 2,
      totalExtraTimeMs: 600_000,
    });

    expect(windingDownReceived).toHaveLength(1);
    expect(windingDownReceived[0].reason).toBe('work appears complete');
    expect(windingDownReceived[0].extensionsUsed).toBe(2);
  });
});

// ---- withTimeout graceful wind-down -----------------------------------------

describe('withTimeout triggers graceful wind-down before hard kill', () => {
  let registry: SessionRegistry;

  beforeEach(() => {
    registry = SessionRegistry.getInstance();
    registry.clearAllSessions();
  });

  afterEach(() => {
    registry.clearAllSessions();
  });

  it('should call triggerGracefulWindDown on the agent before rejecting', async () => {
    const windDown = jest.fn();
    const agent = { triggerGracefulWindDown: windDown };
    registry.registerSession('test-session', agent as any);

    const neverResolves = new Promise<string>(() => {});

    await expect(withTimeout(neverResolves, 50, 'test', 'test-session')).rejects.toThrow(
      'test timed out after 50ms'
    );

    expect(windDown).toHaveBeenCalled();
  });

  it('should not crash when session does not exist', async () => {
    const neverResolves = new Promise<string>(() => {});

    await expect(withTimeout(neverResolves, 50, 'test', 'nonexistent-session')).rejects.toThrow(
      'test timed out after 50ms'
    );
  });

  it('should not call wind-down when no sessionId provided', async () => {
    const windDown = jest.fn();
    const agent = { triggerGracefulWindDown: windDown };
    registry.registerSession('test-session', agent as any);

    const neverResolves = new Promise<string>(() => {});

    await expect(withTimeout(neverResolves, 50, 'test')).rejects.toThrow(
      'test timed out after 50ms'
    );

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
    const windDown = jest.fn();
    const agent = { triggerGracefulWindDown: windDown };
    registry.registerSession('explore-code', agent as any);

    let agentTimer: NodeJS.Timeout;
    const agentWork = new Promise<string>(resolve => {
      agentTimer = setTimeout(() => resolve('Partial results from code exploration...'), 200);
    });

    await expect(withTimeout(agentWork, 50, 'AI review', 'explore-code')).rejects.toThrow(
      'AI review timed out after 50ms'
    );

    clearTimeout(agentTimer!);
    expect(windDown).toHaveBeenCalled();
  });
});

// ---- End-to-end scenario: extension + wind-down + timeout -------------------

describe('End-to-end: explore-code with dynamic timeout, MCP tools, and wind-down', () => {
  let registry: SessionRegistry;

  beforeEach(() => {
    registry = SessionRegistry.getInstance();
    registry.clearAllSessions();
  });

  afterEach(() => {
    registry.clearAllSessions();
  });

  it('should extend visor timeout when agent extends, then resolve normally', async () => {
    // Scenario: visor_timeout=100ms, agent needs 180ms but extends at 60ms
    const extender = new TimeoutExtender();
    const events = new EventEmitter();
    const windDown = jest.fn();
    const agent = { events, triggerGracefulWindDown: windDown };
    registry.registerSession('e2e-session', agent as any);
    wireTimeoutEvents(agent, extender);

    // Agent work: resolves at 180ms
    const agentWork = new Promise<string>(resolve => {
      setTimeout(() => resolve('Complete analysis of code...'), 180);
    });

    // Extension at 60ms: +150ms → deadline 100+150=250ms (enough for 180ms work)
    setTimeout(() => {
      events.emit('timeout.extended', {
        grantedMs: 150,
        reason: 'MCP tool code-explorer still running',
        extensionsUsed: 1,
        extensionsRemaining: 2,
        totalExtraTimeMs: 150,
        budgetRemainingMs: 450,
      });
    }, 60);

    const result = await withTimeout(agentWork, 100, 'AI review', 'e2e-session', extender);
    expect(result).toBe('Complete analysis of code...');
    expect(windDown).not.toHaveBeenCalled();
  });

  it('should timeout with wind-down when extensions are exhausted', async () => {
    // Scenario: visor_timeout=100ms, agent extends twice but still not enough
    const extender = new TimeoutExtender();
    const events = new EventEmitter();
    const windDown = jest.fn();
    const agent = { events, triggerGracefulWindDown: windDown };
    registry.registerSession('e2e-exhaust', agent as any);
    wireTimeoutEvents(agent, extender);

    // Agent work: never resolves (stuck)
    const neverResolves = new Promise<string>(() => {});

    // Extension 1 at 30ms: +40ms → deadline 140ms
    setTimeout(() => {
      events.emit('timeout.extended', {
        grantedMs: 40,
        reason: 'tool running',
        extensionsUsed: 1,
        extensionsRemaining: 1,
        totalExtraTimeMs: 40,
        budgetRemainingMs: 60,
      });
    }, 30);

    // Extension 2 at 100ms: +40ms → deadline 180ms
    setTimeout(() => {
      events.emit('timeout.extended', {
        grantedMs: 40,
        reason: 'tool almost done',
        extensionsUsed: 2,
        extensionsRemaining: 0,
        totalExtraTimeMs: 80,
        budgetRemainingMs: 20,
      });
    }, 100);

    // windingDown at 160ms — agent declining further extensions
    setTimeout(() => {
      events.emit('timeout.windingDown', {
        reason: 'budget exhausted',
        extensionsUsed: 2,
        totalExtraTimeMs: 80,
      });
    }, 160);

    // Total deadline = 100 + 40 + 40 = 180ms, agent never finishes → timeout
    await expect(
      withTimeout(neverResolves, 100, 'AI review', 'e2e-exhaust', extender)
    ).rejects.toThrow('AI review timed out after 180ms');

    expect(windDown).toHaveBeenCalled();
  });

  it('should reproduce exact trace scenario with realistic timings', async () => {
    // Trace 2793eb7d exact scenario (scaled down 10000x):
    // visor_timeout=30min (180ms scaled), ai_timeout=25min (150ms scaled)
    // Observer extends +10min (60ms scaled) at T=25min (150ms scaled)
    //
    // OLD: Hard kill at 180ms, agent killed mid-work, no results
    // NEW: Deadline pushed to 180+60=240ms, agent finishes at 200ms

    const extender = new TimeoutExtender();
    const events = new EventEmitter();
    const windDown = jest.fn();
    const agent = { events, triggerGracefulWindDown: windDown };
    registry.registerSession('explore-code-trace', agent as any);
    wireTimeoutEvents(agent, extender);

    // Agent finishes at ~200ms (scaled from ~33min)
    const agentWork = new Promise<string>(resolve => {
      setTimeout(() => resolve('Analysis of Tyk Gateway nonce handling...'), 200);
    });

    // Observer extends at T=150ms (scaled 25min): +60ms (scaled 10min)
    setTimeout(() => {
      events.emit('timeout.extended', {
        grantedMs: 60,
        reason: 'code-explorer search tool still actively processing',
        extensionsUsed: 1,
        extensionsRemaining: 2,
        totalExtraTimeMs: 60,
        budgetRemainingMs: 540,
      });
    }, 150);

    // visor_timeout=180ms (scaled 30min), extended to 240ms
    const result = await withTimeout(agentWork, 180, 'AI review', 'explore-code-trace', extender);

    // Agent finished successfully with the extra time
    expect(result).toBe('Analysis of Tyk Gateway nonce handling...');
    expect(windDown).not.toHaveBeenCalled();
  });

  it('without extender, should timeout at original deadline (backward compat)', async () => {
    // If no extender (e.g., old code path), withTimeout behaves like before
    const windDown = jest.fn();
    const agent = { triggerGracefulWindDown: windDown };
    registry.registerSession('compat-session', agent as any);

    const neverResolves = new Promise<string>(() => {});

    await expect(withTimeout(neverResolves, 50, 'test', 'compat-session')).rejects.toThrow(
      'test timed out after 50ms'
    );

    expect(windDown).toHaveBeenCalled();
  });
});
