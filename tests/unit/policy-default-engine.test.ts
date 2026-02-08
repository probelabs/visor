import { DefaultPolicyEngine } from '../../src/policy/default-engine';

describe('DefaultPolicyEngine', () => {
  let engine: DefaultPolicyEngine;

  beforeEach(() => {
    engine = new DefaultPolicyEngine();
  });

  it('initialize is a no-op', async () => {
    await expect(engine.initialize({ engine: 'disabled' })).resolves.toBeUndefined();
  });

  it('evaluateCheckExecution always allows', async () => {
    const decision = await engine.evaluateCheckExecution('my-check', { type: 'ai' });
    expect(decision.allowed).toBe(true);
  });

  it('evaluateToolInvocation always allows', async () => {
    const decision = await engine.evaluateToolInvocation('server', 'method', 'stdio');
    expect(decision.allowed).toBe(true);
  });

  it('evaluateCapabilities always allows', async () => {
    const decision = await engine.evaluateCapabilities('check', {
      allowEdit: true,
      allowBash: true,
      allowedTools: ['search'],
    });
    expect(decision.allowed).toBe(true);
    expect(decision.capabilities).toBeUndefined();
  });

  it('shutdown is a no-op', async () => {
    await expect(engine.shutdown()).resolves.toBeUndefined();
  });
});
