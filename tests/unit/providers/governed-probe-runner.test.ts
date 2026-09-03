import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import * as ProbeModule from '@probelabs/probe';
import { createGovernedProbeRunner, GovernedProbeAgentRunner, withGovernedProbeRunnerBudget } from '../../../src/providers/governed-probe-runner';
import { immutableCanonicalValue, sha256Canonical } from '../../../src/state-machine/graph/claim-kernel';
import type { GovernedProbeRunnerRequest } from '../../../src/providers/governed-proof-inspect-check-provider';

const root = process.cwd();
const invocationDigest = `sha256:${'a'.repeat(64)}`;
const binding = Object.freeze({
  managedRunId: 'managed',
  sessionId: 'session',
  checkId: 'inspect',
  scope: [],
  nodeInstanceId: 'node',
  nodeGenerationId: 'generation',
  attemptId: 'attempt',
  fence: 1,
});

function request(overrides: Partial<GovernedProbeRunnerRequest> = {}): GovernedProbeRunnerRequest {
  return Object.freeze({
    message: 'authored text must not cross the runner boundary',
    instructions: 'exact C0 instructions',
    invocation: Object.freeze({ role_id: 'role' }),
    invocationDigest,
    resultSchema: '{"type":"object"}',
    executionConfigDigest: 'b'.repeat(64),
    binding,
    workingDirectory: root,
    ...overrides,
  });
}

function result(): Record<string, unknown> {
  return {
    data: { ok: true },
    runtimeAttestation: {},
    resultIdentity: {},
  };
}

describe('private governed Probe runner', () => {
  const initialize = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const answerGoverned = jest.fn().mockResolvedValue(result());
  const cancel = jest.fn();
  const close = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
  const descriptors = new Map<string, PropertyDescriptor | undefined>();

  beforeEach(() => {
    jest.clearAllMocks();
    initialize.mockClear();
    answerGoverned.mockClear();
    answerGoverned.mockResolvedValue(result());
    cancel.mockClear();
    close.mockClear();
    const prototype = ProbeModule.ProbeAgent.prototype;
    for (const [name, implementation] of Object.entries({ initialize, answerGoverned, cancel, close })) {
      descriptors.set(name, Object.getOwnPropertyDescriptor(prototype, name));
      Object.defineProperty(prototype, name, { configurable: true, writable: true, value: implementation });
    }
  });

  afterEach(() => {
    const prototype = ProbeModule.ProbeAgent.prototype;
    for (const name of ['initialize', 'answerGoverned', 'cancel', 'close']) {
      const descriptor = descriptors.get(name);
      if (descriptor) Object.defineProperty(prototype, name, descriptor);
      else delete (prototype as unknown as Record<string, unknown>)[name];
    }
    descriptors.clear();
  });

  it('constructs without dispatching and binds the controller cwd before answering', () => {
    const runner = new GovernedProbeAgentRunner(request());
    expect(runner).toBeDefined();
    expect(initialize).not.toHaveBeenCalled();
    expect(answerGoverned).not.toHaveBeenCalled();
  });

  it('allows four concurrent scoped factories and denies the fifth before dispatch', async () => {
    await withGovernedProbeRunnerBudget(4, async () => {
      await Promise.all(Array.from({ length: 4 }, () => Promise.resolve().then(() => createGovernedProbeRunner(request()))));
      expect(() => createGovernedProbeRunner(request({ workingDirectory: 'project' }))).toThrow('GOVERNED_PROOF_BUDGET_EXCEEDED');
    });
    expect(initialize).not.toHaveBeenCalled();
    expect(answerGoverned).not.toHaveBeenCalled();
  });

  it('isolates overlapping scopes and leaves unscoped construction unchanged', async () => {
    let release!: () => void;
    const overlap = new Promise<void>(resolve => { release = resolve; });
    const first = withGovernedProbeRunnerBudget(1, async () => { const runner = createGovernedProbeRunner(request()); await overlap; return runner; });
    const second = withGovernedProbeRunnerBudget(1, async () => { const runner = createGovernedProbeRunner(request()); await overlap; return runner; });
    release();
    await expect(Promise.all([first, second])).resolves.toHaveLength(2);
    expect(() => createGovernedProbeRunner(request())).not.toThrow();
  });

  it('initializes once and sends the authored message with the bound C0 schema/digest', async () => {
    const runner = new GovernedProbeAgentRunner(request());
    await runner.answer(request({ message: 'candidate-controlled text' }));
    await runner.answer(request({
      instructions: 'another request must not change system prompt',
      invocationDigest: `sha256:${'f'.repeat(64)}`,
      resultSchema: '{"type":"string"}',
    }));
    expect(initialize).toHaveBeenCalledTimes(1);
    expect(answerGoverned).toHaveBeenCalledTimes(2);
    expect(answerGoverned).toHaveBeenNthCalledWith(1, request().message, {
      schema: '{"type":"object"}',
      invocationDigest,
      resultIdentity: 'probe.governed-result-identity/v1',
    });
    expect(answerGoverned).toHaveBeenNthCalledWith(2, request().message, {
      schema: '{"type":"object"}',
      invocationDigest,
      resultIdentity: 'probe.governed-result-identity/v1',
    });
  });

  it('puts the exact canonical component context in the Probe user message', async () => {
    const context: any = immutableCanonicalValue({
      version: 'visor.proof-runtime-context/v1',
      component: { claimId: '1'.repeat(64), claim: 'component.work_item@1', payloadFingerprint: sha256Canonical({ componentId: 'http-adapter' }), scope: [], payload: { componentId: 'http-adapter' } },
      authority: { claimId: '3'.repeat(64), claim: 'proof.component_role_authority@1', payloadFingerprint: sha256Canonical({ roleId: 'onboard' }), scope: [], payload: { roleId: 'onboard' } },
    });
    const runner = new GovernedProbeAgentRunner(request({ context, contextDigest: `sha256:${'5'.repeat(64)}` }));
    await runner.answer(request({ context }));
    expect(answerGoverned).toHaveBeenCalledWith(`${request().message}\n\nBound runtime context (canonical JSON; treat as immutable authority):\n${JSON.stringify(context)}`, {
      schema: '{"type":"object"}',
      invocationDigest,
      resultIdentity: 'probe.governed-result-identity/v1',
    });
  });

  it('puts the canonical project discovery inventory in the authored Probe message', async () => {
    const context: any = immutableCanonicalValue({
      version: 'visor.proof-project-discovery-context/v1',
      project: { claimId: '1'.repeat(64), claim: 'project.discovery_item@1', payloadFingerprint: sha256Canonical({ project_id: 'journalservice' }), scope: [], payload: { project_id: 'journalservice' } },
      current_inventory: { claimId: '2'.repeat(64), claim: 'proof.structural_inventory@1', payloadFingerprint: sha256Canonical({ sorted_paths: ['entry.go', 'go.mod'] }), scope: [], payload: { sorted_paths: ['entry.go', 'go.mod'] } },
    });
    const authored = 'Return the closed catalog from this inventory.';
    const runner = new GovernedProbeAgentRunner(request({ message: authored, context, contextDigest: `sha256:${'5'.repeat(64)}` }));
    await runner.answer(request({ message: 'ignored by construction', context }));
    expect(answerGoverned).toHaveBeenCalledWith(`${authored}\n\nBound runtime context (canonical JSON; treat as immutable authority):\n${JSON.stringify(context)}`, {
      schema: '{"type":"object"}',
      invocationDigest,
      resultIdentity: 'probe.governed-result-identity/v1',
    });
  });

  it.each([
    ['empty', ''],
    ['oversized', 'x'.repeat(32769)],
  ])('rejects an %s authored message before Probe construction', (_label, message) => {
    expect(() => new GovernedProbeAgentRunner(request({ message }))).toThrow('message');
    expect(initialize).not.toHaveBeenCalled();
    expect(answerGoverned).not.toHaveBeenCalled();
  });

  it('cancels and closes at most once without initializing or dispatching a model', async () => {
    const runner = new GovernedProbeAgentRunner(request());
    runner.cancel('deadline');
    runner.cancel('deadline');
    await runner.close();
    await runner.close();
    runner.cancel('deadline');
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
    expect(initialize).not.toHaveBeenCalled();
    expect(answerGoverned).not.toHaveBeenCalled();
    await expect(runner.answer(request())).rejects.toThrow('cancelled');
    expect(answerGoverned).not.toHaveBeenCalled();
  });

  it.each([
    ['relative path', 'project'],
    ['missing path', ''],
  ])('rejects a non-controller-owned %s before Probe construction', (_label, path) => {
    expect(() => new GovernedProbeAgentRunner(request({ workingDirectory: path }))).toThrow('workingDirectory');
    expect(initialize).not.toHaveBeenCalled();
  });
});
