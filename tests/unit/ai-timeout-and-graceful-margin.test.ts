/**
 * Tests for ai_timeout config field and PROBE_GRACEFUL_MARGIN_MS / MIN_TIMEOUT_FOR_MARGIN_MS
 * constants used when computing Probe's maxOperationTimeout from Visor's hard timeout.
 */

import { EventEmitter } from 'node:events';
import { AIReviewService } from '../../src/ai-review-service';
import { logger } from '../../src/logger';
import * as traceHelpers from '../../src/telemetry/trace-helpers';
import { ProbeAgent } from '@probelabs/probe';

jest.mock('@probelabs/probe', () => ({
  ProbeAgent: jest.fn(),
}));
jest.mock('../../src/telemetry/trace-helpers', () => ({
  ...jest.requireActual('../../src/telemetry/trace-helpers'),
  addEvent: jest.fn(),
}));

const timeoutPrInfo = {
  number: 1,
  title: 'timeout request event test',
  body: '',
  author: 'test',
  base: 'main',
  head: 'feature',
  files: [],
  totalAdditions: 0,
  totalDeletions: 0,
};

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

    it('should derive the native onboarding author and reviewer request budgets', () => {
      // The YAML keeps the check timeout larger than the inner AI budget;
      // governed profiles receive these derived values as Probe requestTimeout.
      expect(deriveProbeTimeout(1500000)).toBe(1410000);
      expect(deriveProbeTimeout(480000)).toBe(390000);
    });

    it.each([1000, 3600000])('should preserve Probe request boundary %s', requestTimeout => {
      expect(deriveProbeTimeout(1800000, requestTimeout)).toBe(requestTimeout);
    });
  });

  describe('negotiated timeout config fields', () => {
    /**
     * Simulates the YAML → AIReviewConfig mapping done by ai-check-provider.ts
     */
    function parseNegotiatedTimeoutConfig(yamlObj: Record<string, unknown>) {
      const config: Record<string, unknown> = {};
      if (yamlObj.timeout_behavior !== undefined) {
        config.timeoutBehavior = yamlObj.timeout_behavior;
      }
      if (yamlObj.negotiated_timeout_budget !== undefined) {
        config.negotiatedTimeoutBudget = Number(yamlObj.negotiated_timeout_budget);
      }
      if (yamlObj.negotiated_timeout_max_requests !== undefined) {
        config.negotiatedTimeoutMaxRequests = Number(yamlObj.negotiated_timeout_max_requests);
      }
      if (yamlObj.negotiated_timeout_max_per_request !== undefined) {
        config.negotiatedTimeoutMaxPerRequest = Number(yamlObj.negotiated_timeout_max_per_request);
      }
      if (yamlObj.graceful_stop_deadline !== undefined) {
        config.gracefulStopDeadline = Number(yamlObj.graceful_stop_deadline);
      }
      return config;
    }

    it('should parse all negotiated timeout fields from YAML', () => {
      const yaml = {
        timeout_behavior: 'negotiated',
        negotiated_timeout_budget: 120000,
        negotiated_timeout_max_requests: 3,
        negotiated_timeout_max_per_request: 60000,
        graceful_stop_deadline: 30000,
      };

      const config = parseNegotiatedTimeoutConfig(yaml);
      expect(config).toEqual({
        timeoutBehavior: 'negotiated',
        negotiatedTimeoutBudget: 120000,
        negotiatedTimeoutMaxRequests: 3,
        negotiatedTimeoutMaxPerRequest: 60000,
        gracefulStopDeadline: 30000,
      });
    });

    it('should parse graceful timeout_behavior', () => {
      const config = parseNegotiatedTimeoutConfig({ timeout_behavior: 'graceful' });
      expect(config.timeoutBehavior).toBe('graceful');
    });

    it('should handle string numbers from YAML', () => {
      const yaml = {
        negotiated_timeout_budget: '120000',
        negotiated_timeout_max_requests: '5',
      };
      const config = parseNegotiatedTimeoutConfig(yaml);
      expect(config.negotiatedTimeoutBudget).toBe(120000);
      expect(config.negotiatedTimeoutMaxRequests).toBe(5);
    });

    it('should return empty config when no fields set', () => {
      const config = parseNegotiatedTimeoutConfig({});
      expect(config).toEqual({});
    });

    it('should handle partial config (only some fields set)', () => {
      const config = parseNegotiatedTimeoutConfig({
        timeout_behavior: 'negotiated',
        graceful_stop_deadline: 15000,
      });
      expect(config).toEqual({
        timeoutBehavior: 'negotiated',
        gracefulStopDeadline: 15000,
      });
    });
  });
});

describe('safe Probe request timeout events', () => {
  let warningLog: jest.SpyInstance;
  let addEvent: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    warningLog = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    addEvent = traceHelpers.addEvent as jest.Mock;
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    ['initialize', 'acquire'],
    ['tools/call', 'query'],
  ])('records only the safe %s/%s request timeout event', async (method, boundary) => {
    const events = new EventEmitter();
    const record = {
      category: 'request_timeout',
      method,
      boundary,
      timeout_ms: 123456,
      profileId: 'luna-xhigh-readonly-v1',
      sessionId: 'session-safe-1',
    };
    (ProbeAgent as jest.Mock).mockImplementation(() => ({
      events,
      initialize: jest.fn().mockResolvedValue(undefined),
      answer: jest.fn().mockImplementation(async () => {
        events.emit('timeout.request', record);
        return JSON.stringify({ issues: [] });
      }),
    }));

    const service = new AIReviewService({
      codexExecutionProfile: 'luna-xhigh-readonly-v1',
      path: process.cwd(),
    });
    await expect(service.executeReview(timeoutPrInfo, 'inspect')).resolves.toEqual(
      expect.objectContaining({ issues: [] })
    );

    const timeoutLines = warningLog.mock.calls
      .map(([message]) => message)
      .filter((message): message is string => message.startsWith('timeout.request '));
    expect(timeoutLines).toEqual([`timeout.request ${JSON.stringify(record)}`]);
    expect(addEvent.mock.calls.filter(([name]) => name === 'visor.provider_request_timeout')).toEqual([
      ['visor.provider_request_timeout', record],
    ]);
  });

  it('ignores malformed timeout events without logging unsafe fields', async () => {
    const events = new EventEmitter();
    const malformed = {
      category: 'request_timeout',
      method: 'tools/call',
      boundary: 'acquire',
      timeout_ms: 123456,
      profileId: 'luna-xhigh-readonly-v1',
      sessionId: 'session-safe-1',
      params: { secret: 'must-not-be-logged' },
    };
    (ProbeAgent as jest.Mock).mockImplementation(() => ({
      events,
      initialize: jest.fn().mockResolvedValue(undefined),
      answer: jest.fn().mockImplementation(async () => {
        events.emit('timeout.request', malformed);
        return JSON.stringify({ issues: [] });
      }),
    }));

    const service = new AIReviewService({
      codexExecutionProfile: 'luna-xhigh-readonly-v1',
      path: process.cwd(),
    });
    await expect(service.executeReview(timeoutPrInfo, 'inspect')).resolves.toEqual(
      expect.objectContaining({ issues: [] })
    );

    expect(
      warningLog.mock.calls.filter(([message]) =>
        typeof message === 'string' && message.startsWith('timeout.request ')
      )
    ).toHaveLength(0);
    expect(addEvent.mock.calls.some(([name]) => name === 'visor.provider_request_timeout')).toBe(
      false
    );
    expect(warningLog.mock.calls.flat().join(' ')).not.toContain('must-not-be-logged');
  });
});

describe('public governed raw-item failure warning', () => {
  let warningLog: jest.SpyInstance;
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    warningLog = jest.spyOn(logger, 'warn').mockImplementation(() => undefined);
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('logs one fixed warning with the governed raw-item predicate and invocation identity', async () => {
    const failure = Object.assign(new Error('raw model payload must not be public'), {
      answerFailureStage: 'native_event_grammar',
      nativeEventFailureBoundary: 'raw_item_predicate',
      nativeEventFailureRawItemPredicate: 'call_output_pairing',
    });
    (ProbeAgent as jest.Mock).mockImplementation(() => ({
      initialize: jest.fn().mockResolvedValue(undefined),
      answer: jest.fn().mockRejectedValue(failure),
    }));

    const service = new AIReviewService({ provider: 'mock', model: 'mock' });
    await expect(
      service.executeReview(
        timeoutPrInfo,
        'inspect',
        undefined,
        'spec_review',
        undefined,
        'generation-123'
      )
    ).rejects.toThrow('raw model payload must not be public');

    expect(warningLog).toHaveBeenCalledTimes(1);
    expect(warningLog).toHaveBeenCalledWith(
      JSON.stringify({
        category: 'probe_governed_failure',
        checkName: 'spec_review',
        nodeGenerationId: 'generation-123',
        stage: 'native_event_grammar',
        boundary: 'raw_item_predicate',
        predicate: 'call_output_pairing',
      })
    );
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  it('does not normalize an unknown predicate or leak hostile error data', async () => {
    const failure = Object.assign(new Error('secret raw payload /private/project'), {
      name: 'SecretError',
      answerFailureStage: 'native_event_grammar',
      nativeEventFailureBoundary: 'raw_item_predicate',
      nativeEventFailureRawItemPredicate: 'secret_predicate',
      payload: { token: 'secret-token' },
    });
    (ProbeAgent as jest.Mock).mockImplementation(() => ({
      initialize: jest.fn().mockResolvedValue(undefined),
      answer: jest.fn().mockRejectedValue(failure),
    }));

    const service = new AIReviewService({ provider: 'mock', model: 'mock' });
    await expect(
      service.executeReview(
        timeoutPrInfo,
        'inspect',
        undefined,
        'spec_review',
        undefined,
        'generation-123'
      )
    ).rejects.toThrow('secret raw payload /private/project');

    expect(warningLog).not.toHaveBeenCalled();
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  it('preserves the wrapped Probe failure when warning logging throws', async () => {
    const failure = Object.assign(new Error('original governed failure'), {
      answerFailureStage: 'native_event_grammar',
      nativeEventFailureBoundary: 'raw_item_predicate',
      nativeEventFailureRawItemPredicate: 'shape',
    });
    warningLog.mockImplementation(() => {
      throw new Error('warning sink failed');
    });
    (ProbeAgent as jest.Mock).mockImplementation(() => ({
      initialize: jest.fn().mockResolvedValue(undefined),
      answer: jest.fn().mockRejectedValue(failure),
    }));

    const service = new AIReviewService({ provider: 'mock', model: 'mock' });
    await expect(
      service.executeReview(
        timeoutPrInfo,
        'inspect',
        undefined,
        'spec_review',
        undefined,
        'generation-123'
      )
    ).rejects.toThrow('original governed failure');
    expect(warningLog).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalledTimes(1);
  });
});
