/**
 * Tests for global AI concurrency limiter in Visor
 * Covers: buildEngineContextForRun creates sharedConcurrencyLimiter,
 * and ai-check-provider propagates limiter from _parentContext.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

import { buildEngineContextForRun } from '../../src/state-machine/context/build-engine-context';
import { AICheckProvider } from '../../src/providers/ai-check-provider';
import { DelegationManager } from '@probelabs/probe';
import * as AIReviewService from '../../src/ai-review-service';
import type { VisorConfig } from '../../src/types/config';
import type { PRInfo } from '../../src/pr-analyzer';

jest.mock('../../src/ai-review-service');

jest.mock('../../src/logger', () => ({
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));

jest.mock('../../src/utils/command-executor', () => ({
  commandExecutor: {
    execute: jest.fn(),
  },
}));

const mockPRInfo: PRInfo = {
  number: 1,
  title: 'Test PR',
  body: 'Test description',
  author: 'testuser',
  base: 'main',
  head: 'feature',
  files: [],
  totalAdditions: 0,
  totalDeletions: 0,
} as any;

describe('Global AI Concurrency Limiter (Visor)', () => {
  describe('buildEngineContextForRun creates sharedConcurrencyLimiter', () => {
    it('creates limiter when max_ai_concurrency is set', () => {
      const cfg: VisorConfig = {
        version: '1',
        output: { format: 'json' },
        checks: {},
        max_ai_concurrency: 5,
      } as any;

      const ctx = buildEngineContextForRun('/tmp/test', cfg, mockPRInfo);

      expect(ctx.sharedConcurrencyLimiter).toBeDefined();
      expect(ctx.sharedConcurrencyLimiter.getStats().maxConcurrent).toBe(5);

      // Cleanup
      ctx.sharedConcurrencyLimiter.cleanup();
    });

    it('does not create limiter when max_ai_concurrency is not set', () => {
      const cfg: VisorConfig = {
        version: '1',
        output: { format: 'json' },
        checks: {},
      } as any;

      const ctx = buildEngineContextForRun('/tmp/test', cfg, mockPRInfo);

      expect(ctx.sharedConcurrencyLimiter).toBeUndefined();
    });

    it('limiter works with max_ai_concurrency: 1', () => {
      const cfg: VisorConfig = {
        version: '1',
        output: { format: 'json' },
        checks: {},
        max_ai_concurrency: 1,
      } as any;

      const ctx = buildEngineContextForRun('/tmp/test', cfg, mockPRInfo);

      expect(ctx.sharedConcurrencyLimiter).toBeDefined();
      const stats = ctx.sharedConcurrencyLimiter.getStats();
      expect(stats.maxConcurrent).toBe(1);

      // Cleanup
      ctx.sharedConcurrencyLimiter.cleanup();
    });
  });

  describe('ai-check-provider propagates limiter from _parentContext', () => {
    let provider: AICheckProvider;

    beforeEach(() => {
      provider = new AICheckProvider();
    });

    it('passes concurrencyLimiter from _parentContext to AIReviewService', async () => {
      const mockLimiter = new DelegationManager({ maxConcurrent: 3 });

      const mockReview = {
        overallScore: 90,
        totalIssues: 0,
        criticalIssues: 0,
        comments: [],
        issues: [],
      };

      const mockService = {
        executeReview: jest.fn().mockResolvedValue(mockReview),
      };

      let capturedConfig: any;
      (AIReviewService as any).AIReviewService = jest.fn().mockImplementation((config: any) => {
        capturedConfig = config;
        return mockService;
      });

      const config = {
        type: 'ai',
        prompt: 'security',
      };

      const sessionInfo = {
        _parentContext: {
          sharedConcurrencyLimiter: mockLimiter,
          workingDirectory: '/tmp',
        },
      };

      await provider.execute(mockPRInfo, config, undefined, sessionInfo as any);

      expect(capturedConfig).toBeDefined();
      expect(capturedConfig.concurrencyLimiter).toBe(mockLimiter);

      mockLimiter.cleanup();
    });

    it('does not set concurrencyLimiter when _parentContext has no limiter', async () => {
      const mockReview = {
        overallScore: 90,
        totalIssues: 0,
        criticalIssues: 0,
        comments: [],
        issues: [],
      };

      const mockService = {
        executeReview: jest.fn().mockResolvedValue(mockReview),
      };

      let capturedConfig: any;
      (AIReviewService as any).AIReviewService = jest.fn().mockImplementation((config: any) => {
        capturedConfig = config;
        return mockService;
      });

      const config = {
        type: 'ai',
        prompt: 'security',
      };

      const sessionInfo = {
        _parentContext: {
          workingDirectory: '/tmp',
        },
      };

      await provider.execute(mockPRInfo, config, undefined, sessionInfo as any);

      expect(capturedConfig).toBeDefined();
      expect(capturedConfig.concurrencyLimiter).toBeUndefined();
    });
  });
});
