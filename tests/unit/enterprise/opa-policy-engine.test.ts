import { OpaPolicyEngine } from '../../../src/enterprise/policy/opa-policy-engine';
import type { PolicyConfig } from '../../../src/policy/types';
import { PolicyInputBuilder } from '../../../src/enterprise/policy/policy-input-builder';

/**
 * Helper: create an engine with a mock evaluator injected.
 *
 * Initializes in 'disabled' mode (no real OPA), then patches the private
 * `evaluator` and `inputBuilder` fields so that `doEvaluate` runs the
 * mock instead of short-circuiting with `{ allowed: true }`.
 */
async function engineWithMockEvaluator(
  evaluator: { evaluate: (...args: any[]) => Promise<any> },
  overrides: Partial<PolicyConfig> = {}
): Promise<OpaPolicyEngine> {
  const config: PolicyConfig = { engine: 'disabled', ...overrides };
  const engine = new OpaPolicyEngine(config);
  await engine.initialize(config);

  // Inject mock evaluator and a real input builder so doEvaluate runs
  (engine as any).evaluator = evaluator;
  if (!(engine as any).inputBuilder) {
    (engine as any).inputBuilder = new PolicyInputBuilder(
      config,
      { login: 'test-user', isLocalMode: true },
      { owner: 'org', name: 'repo' }
    );
  }
  return engine;
}

describe('OpaPolicyEngine', () => {
  describe('disabled mode', () => {
    it('allows everything when engine is disabled', async () => {
      const config: PolicyConfig = { engine: 'disabled' };
      const engine = new OpaPolicyEngine(config);
      await engine.initialize(config);

      const decision = await engine.evaluateCheckExecution('test-check', { type: 'ai' });
      expect(decision.allowed).toBe(true);

      await engine.shutdown();
    });
  });

  describe('local mode without WASM', () => {
    it('throws when rules path is missing', async () => {
      const config: PolicyConfig = { engine: 'local' };
      const engine = new OpaPolicyEngine(config);
      await expect(engine.initialize(config)).rejects.toThrow('policy.rules');
    });

    it('throws when WASM file does not exist', async () => {
      const config: PolicyConfig = {
        engine: 'local',
        rules: '/tmp/nonexistent-policy.wasm',
      };
      const engine = new OpaPolicyEngine(config);
      await expect(engine.initialize(config)).rejects.toThrow();
    });
  });

  describe('remote mode', () => {
    it('throws when URL is missing', async () => {
      const config: PolicyConfig = { engine: 'remote' };
      const engine = new OpaPolicyEngine(config);
      await expect(engine.initialize(config)).rejects.toThrow('policy.url');
    });
  });

  describe('fallback behavior', () => {
    it('defaults to deny on fallback', async () => {
      const config: PolicyConfig = { engine: 'disabled', fallback: 'deny' };
      const engine = new OpaPolicyEngine(config);
      await engine.initialize(config);
      // Engine is disabled, so evaluator is null → always allows
      const decision = await engine.evaluateCheckExecution('test', {});
      expect(decision.allowed).toBe(true);
      await engine.shutdown();
    });

    it('respects allow fallback', () => {
      const config: PolicyConfig = { engine: 'disabled', fallback: 'allow' };
      const engine = new OpaPolicyEngine(config);
      expect((engine as any).fallback).toBe('allow');
    });

    it('respects deny fallback', () => {
      const config: PolicyConfig = { engine: 'disabled', fallback: 'deny' };
      const engine = new OpaPolicyEngine(config);
      expect((engine as any).fallback).toBe('deny');
    });

    it('defaults timeout to 5000', () => {
      const config: PolicyConfig = { engine: 'disabled' };
      const engine = new OpaPolicyEngine(config);
      expect((engine as any).timeout).toBe(5000);
    });

    it('respects custom timeout', () => {
      const config: PolicyConfig = { engine: 'disabled', timeout: 10000 };
      const engine = new OpaPolicyEngine(config);
      expect((engine as any).timeout).toBe(10000);
    });
  });

  describe('setActorContext', () => {
    it('updates the input builder with new actor context', async () => {
      const config: PolicyConfig = {
        engine: 'disabled',
        roles: { admin: { users: ['admin-user'] } },
      };
      const engine = new OpaPolicyEngine(config);
      await engine.initialize(config);

      engine.setActorContext(
        { login: 'admin-user', isLocalMode: false },
        { owner: 'org', name: 'repo' }
      );

      // The engine stores an input builder internally
      expect((engine as any).inputBuilder).not.toBeNull();
      await engine.shutdown();
    });
  });

  describe('shutdown', () => {
    it('cleans up evaluator and input builder', async () => {
      const config: PolicyConfig = { engine: 'disabled' };
      const engine = new OpaPolicyEngine(config);
      await engine.initialize(config);
      await engine.shutdown();
      expect((engine as any).evaluator).toBeNull();
      expect((engine as any).inputBuilder).toBeNull();
    });
  });

  // ---------------------------------------------------------------
  // #47 — Timeout triggers fallback
  // ---------------------------------------------------------------
  describe('timeout triggers fallback', () => {
    // Use a very short timeout (50ms) and a mock evaluator that takes much longer
    const makeSlowEvaluator = (delayMs: number) => ({
      evaluate: () =>
        new Promise<any>(resolve => setTimeout(() => resolve({ allowed: true }), delayMs)),
    });

    it('returns { allowed: false } when timeout fires with fallback: deny', async () => {
      const engine = await engineWithMockEvaluator(makeSlowEvaluator(10_000), {
        fallback: 'deny',
        timeout: 50,
      });

      const decision = await engine.evaluateCheckExecution('slow-check', { type: 'ai' });

      expect(decision.allowed).toBe(false);
      expect(decision.reason).toMatch(/fallback=deny/);
      await engine.shutdown();
    });

    it('returns { allowed: true } when timeout fires with fallback: allow', async () => {
      const engine = await engineWithMockEvaluator(makeSlowEvaluator(10_000), {
        fallback: 'allow',
        timeout: 50,
      });

      const decision = await engine.evaluateCheckExecution('slow-check', { type: 'ai' });

      expect(decision.allowed).toBe(true);
      expect(decision.warn).toBeUndefined();
      expect(decision.reason).toMatch(/fallback=allow/);
      await engine.shutdown();
    });

    it('returns { allowed: true, warn: true } when timeout fires with fallback: warn', async () => {
      const engine = await engineWithMockEvaluator(makeSlowEvaluator(10_000), {
        fallback: 'warn',
        timeout: 50,
      });

      const decision = await engine.evaluateCheckExecution('slow-check', { type: 'ai' });

      expect(decision.allowed).toBe(true);
      expect(decision.warn).toBe(true);
      expect(decision.reason).toMatch(/fallback=warn/);
      await engine.shutdown();
    });

    it('does NOT trigger fallback when evaluation completes within timeout', async () => {
      // Fast evaluator that resolves in 5ms, with a 500ms timeout
      const fastEvaluator = {
        evaluate: () => Promise.resolve({ allowed: true }),
      };
      const engine = await engineWithMockEvaluator(fastEvaluator, {
        fallback: 'deny',
        timeout: 500,
      });

      const decision = await engine.evaluateCheckExecution('fast-check', { type: 'ai' });

      expect(decision.allowed).toBe(true);
      // Should not have a fallback reason
      expect(decision.reason).toBeUndefined();
      await engine.shutdown();
    });
  });

  // ---------------------------------------------------------------
  // #48 — navigateWasmResult
  // ---------------------------------------------------------------
  describe('navigateWasmResult', () => {
    // Access the private method directly via (engine as any)
    let engine: OpaPolicyEngine;

    beforeAll(() => {
      const config: PolicyConfig = { engine: 'disabled' };
      engine = new OpaPolicyEngine(config);
    });

    afterAll(async () => {
      await engine.shutdown();
    });

    it('returns null when result is null', () => {
      const result = (engine as any).navigateWasmResult(null, 'visor/check/execute');
      expect(result).toBeNull();
    });

    it('returns undefined when result is undefined', () => {
      const result = (engine as any).navigateWasmResult(undefined, 'visor/check/execute');
      expect(result).toBeUndefined();
    });

    it('returns result as-is for non-object values', () => {
      expect((engine as any).navigateWasmResult(42, 'visor/check/execute')).toBe(42);
      expect((engine as any).navigateWasmResult('str', 'visor/check/execute')).toBe('str');
      expect((engine as any).navigateWasmResult(true, 'visor/check/execute')).toBe(true);
    });

    it('navigates a valid nested path visor/check/execute', () => {
      const wasmResult = {
        check: {
          execute: { allowed: true, reason: 'matched rule' },
        },
      };
      const result = (engine as any).navigateWasmResult(wasmResult, 'visor/check/execute');
      expect(result).toEqual({ allowed: true, reason: 'matched rule' });
    });

    it('navigates single-segment path visor/tool', () => {
      const wasmResult = {
        tool: { invoke: { allowed: false } },
      };
      const result = (engine as any).navigateWasmResult(wasmResult, 'visor/tool');
      expect(result).toEqual({ invoke: { allowed: false } });
    });

    it('returns undefined for missing path segment', () => {
      const wasmResult = {
        check: { execute: { allowed: true } },
      };
      const result = (engine as any).navigateWasmResult(wasmResult, 'visor/tool/invoke');
      expect(result).toBeUndefined();
    });

    it('returns undefined when intermediate segment is not an object', () => {
      const wasmResult = {
        check: 'not-an-object',
      };
      const result = (engine as any).navigateWasmResult(wasmResult, 'visor/check/execute');
      expect(result).toBeUndefined();
    });

    it('navigates deeply nested path visor/capability/resolve', () => {
      const wasmResult = {
        capability: {
          resolve: {
            allowed: true,
            capabilities: { allowEdit: false, allowBash: false },
          },
        },
      };
      const result = (engine as any).navigateWasmResult(wasmResult, 'visor/capability/resolve');
      expect(result).toEqual({
        allowed: true,
        capabilities: { allowEdit: false, allowBash: false },
      });
    });

    it('handles path without visor/ prefix (strips nothing, walks full path)', () => {
      // If the path does NOT start with "visor/", the replace is a no-op
      // and the code tries to navigate e.g. segments = ['custom', 'path']
      const wasmResult = {
        custom: { path: { allowed: true } },
      };
      const result = (engine as any).navigateWasmResult(wasmResult, 'custom/path');
      expect(result).toEqual({ allowed: true });
    });
  });

  // ---------------------------------------------------------------
  // #50 — Warn mode interaction tests
  // ---------------------------------------------------------------
  describe('warn mode interactions', () => {
    it('converts policy deny to allowed=true with warn flag and audit prefix', async () => {
      const denyEvaluator = {
        evaluate: () => Promise.resolve({ allowed: false, reason: 'role not permitted' }),
      };
      const engine = await engineWithMockEvaluator(denyEvaluator, {
        fallback: 'warn',
      });

      const decision = await engine.evaluateCheckExecution('restricted-check', { type: 'ai' });

      expect(decision.allowed).toBe(true);
      expect(decision.warn).toBe(true);
      expect(decision.reason).toBe('audit: role not permitted');
      await engine.shutdown();
    });

    it('preserves policy allow without adding warn flag', async () => {
      const allowEvaluator = {
        evaluate: () => Promise.resolve({ allowed: true }),
      };
      const engine = await engineWithMockEvaluator(allowEvaluator, {
        fallback: 'warn',
      });

      const decision = await engine.evaluateCheckExecution('normal-check', { type: 'ai' });

      expect(decision.allowed).toBe(true);
      expect(decision.warn).toBeUndefined();
      // No reason should be present for an allowed decision
      expect(decision.reason).toBeUndefined();
      await engine.shutdown();
    });

    it('returns allowed=true with warn on evaluation error', async () => {
      const errorEvaluator = {
        evaluate: () => Promise.reject(new Error('OPA server unreachable')),
      };
      const engine = await engineWithMockEvaluator(errorEvaluator, {
        fallback: 'warn',
      });

      const decision = await engine.evaluateCheckExecution('error-check', { type: 'ai' });

      expect(decision.allowed).toBe(true);
      expect(decision.warn).toBe(true);
      expect(decision.reason).toMatch(/fallback=warn/);
      await engine.shutdown();
    });

    it('converts deny with no reason to default audit message', async () => {
      const denyNoReasonEvaluator = {
        evaluate: () => Promise.resolve({ allowed: false }),
      };
      const engine = await engineWithMockEvaluator(denyNoReasonEvaluator, {
        fallback: 'warn',
      });

      const decision = await engine.evaluateCheckExecution('no-reason-check', { type: 'ai' });

      expect(decision.allowed).toBe(true);
      expect(decision.warn).toBe(true);
      expect(decision.reason).toBe('audit: policy denied');
      await engine.shutdown();
    });

    it('does NOT add warn flag when fallback is deny and policy denies', async () => {
      const denyEvaluator = {
        evaluate: () => Promise.resolve({ allowed: false, reason: 'blocked' }),
      };
      const engine = await engineWithMockEvaluator(denyEvaluator, {
        fallback: 'deny',
      });

      const decision = await engine.evaluateCheckExecution('blocked-check', { type: 'ai' });

      // With fallback: deny, a deny decision stays denied (no warn override)
      expect(decision.allowed).toBe(false);
      expect(decision.warn).toBeUndefined();
      expect(decision.reason).toBe('blocked');
      await engine.shutdown();
    });

    it('does NOT add warn flag when fallback is allow and policy denies', async () => {
      const denyEvaluator = {
        evaluate: () => Promise.resolve({ allowed: false, reason: 'blocked' }),
      };
      const engine = await engineWithMockEvaluator(denyEvaluator, {
        fallback: 'allow',
      });

      const decision = await engine.evaluateCheckExecution('blocked-check', { type: 'ai' });

      // With fallback: allow, the deny decision is NOT overridden (only warn mode does that)
      expect(decision.allowed).toBe(false);
      expect(decision.warn).toBeUndefined();
      expect(decision.reason).toBe('blocked');
      await engine.shutdown();
    });
  });
});
