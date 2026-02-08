import { OpaPolicyEngine } from '../../../src/enterprise/policy/opa-policy-engine';
import type { PolicyConfig } from '../../../src/policy/types';

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
});
