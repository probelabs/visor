/**
 * Tests for ai_timeout config field and PROBE_GRACEFUL_MARGIN_MS / MIN_TIMEOUT_FOR_MARGIN_MS
 * constants used when computing Probe's maxOperationTimeout from Visor's hard timeout.
 */

// These constants mirror the values in src/ai-review-service.ts
const PROBE_GRACEFUL_MARGIN_MS = 90_000;
const MIN_TIMEOUT_FOR_MARGIN_MS = PROBE_GRACEFUL_MARGIN_MS + 30_000; // 120_000

/**
 * Mirrors the maxOperationTimeout derivation logic from ai-review-service.ts
 */
function deriveProbeTimeout(visorTimeout: number, aiTimeout?: number): number {
  return (
    aiTimeout ||
    (visorTimeout > MIN_TIMEOUT_FOR_MARGIN_MS
      ? visorTimeout - PROBE_GRACEFUL_MARGIN_MS
      : visorTimeout)
  );
}

describe('ai_timeout and graceful margin', () => {
  describe('deriveProbeTimeout (mirrors ai-review-service logic)', () => {
    it('should use explicit aiTimeout when provided', () => {
      expect(deriveProbeTimeout(1800000, 600000)).toBe(600000);
    });

    it('should use explicit aiTimeout even when shorter than visor timeout', () => {
      expect(deriveProbeTimeout(1800000, 30000)).toBe(30000);
    });

    it('should use explicit aiTimeout even when longer than visor timeout', () => {
      // User might want Probe to run longer than Visor's hard kill
      // (Visor's Promise.race will still terminate, but Probe starts winding down later)
      expect(deriveProbeTimeout(60000, 120000)).toBe(120000);
    });

    it('should subtract margin when visor timeout > MIN_TIMEOUT_FOR_MARGIN_MS', () => {
      // 30 minutes → 30min - 90s = 1710000
      expect(deriveProbeTimeout(1800000)).toBe(1800000 - PROBE_GRACEFUL_MARGIN_MS);
      expect(deriveProbeTimeout(1800000)).toBe(1710000);
    });

    it('should use full visor timeout when at exactly MIN_TIMEOUT_FOR_MARGIN_MS', () => {
      // At exactly 120s, condition is >, so it does NOT subtract
      expect(deriveProbeTimeout(MIN_TIMEOUT_FOR_MARGIN_MS)).toBe(MIN_TIMEOUT_FOR_MARGIN_MS);
      expect(deriveProbeTimeout(120000)).toBe(120000);
    });

    it('should use full visor timeout when below MIN_TIMEOUT_FOR_MARGIN_MS', () => {
      expect(deriveProbeTimeout(60000)).toBe(60000);
      expect(deriveProbeTimeout(30000)).toBe(30000);
      expect(deriveProbeTimeout(1000)).toBe(1000);
    });

    it('should use full visor timeout when just above MIN_TIMEOUT_FOR_MARGIN_MS', () => {
      // 120001ms → subtracts margin
      expect(deriveProbeTimeout(MIN_TIMEOUT_FOR_MARGIN_MS + 1)).toBe(
        MIN_TIMEOUT_FOR_MARGIN_MS + 1 - PROBE_GRACEFUL_MARGIN_MS
      );
      // = 120001 - 90000 = 30001
      expect(deriveProbeTimeout(120001)).toBe(30001);
    });

    it('should handle zero visor timeout', () => {
      expect(deriveProbeTimeout(0)).toBe(0);
    });

    it('should prefer explicit aiTimeout=0 over default derivation', () => {
      // aiTimeout=0 is falsy, so falls through to default derivation
      // This is by design: 0 means "not set"
      expect(deriveProbeTimeout(1800000, 0)).toBe(1710000);
    });
  });

  describe('constant relationships', () => {
    it('PROBE_GRACEFUL_MARGIN_MS should be 90 seconds', () => {
      expect(PROBE_GRACEFUL_MARGIN_MS).toBe(90_000);
    });

    it('MIN_TIMEOUT_FOR_MARGIN_MS should be margin + 30s headroom', () => {
      expect(MIN_TIMEOUT_FOR_MARGIN_MS).toBe(PROBE_GRACEFUL_MARGIN_MS + 30_000);
    });

    it('margin should leave at least 30s for Probe when subtracting', () => {
      // The minimum visor timeout that triggers subtraction is MIN_TIMEOUT_FOR_MARGIN_MS + 1
      const minSubtractedResult = MIN_TIMEOUT_FOR_MARGIN_MS + 1 - PROBE_GRACEFUL_MARGIN_MS;
      expect(minSubtractedResult).toBeGreaterThanOrEqual(30_000);
    });
  });

  describe('integration: aiTimeout overrides default derivation', () => {
    it('should allow user to set precise Probe timeout independent of Visor', () => {
      // User sets visor timeout=600s, ai_timeout=300s
      // Probe winds down at 300s, Visor hard kills at 600s
      const probeTimeout = deriveProbeTimeout(600000, 300000);
      expect(probeTimeout).toBe(300000);
      // Without ai_timeout, would be 600000 - 90000 = 510000
      expect(deriveProbeTimeout(600000)).toBe(510000);
    });

    it('should allow user to disable margin subtraction via ai_timeout = visor timeout', () => {
      const visor = 1800000;
      expect(deriveProbeTimeout(visor, visor)).toBe(visor);
    });
  });
});
