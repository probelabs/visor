import { describe, expect, it, jest } from '@jest/globals';
import {
  createGovernedProofInspectProviderForFocusedTest,
  GOVERNED_PROOF_INSPECT_MESSAGE,
  GOVERNED_PROBE_UNAVAILABLE,
  GovernedProofInspectCheckProvider,
  projectGovernedProofInspectConfig,
  validateProofCandidateEvidence,
  governedResultDigest,
} from '../../../src/providers/governed-proof-inspect-check-provider';
import { canonicalJson } from '../../../src/state-machine/graph/claim-kernel';

const binding: any = Object.freeze({
  managedRunId: 'managed', sessionId: 'session', checkId: 'inspect',
  scope: [{ kind: 'keyed', expansionOwnerCheck: 'discover', key: 'A', subgraphInstanceId: 'a'.repeat(64) }],
  nodeInstanceId: 'node', nodeGenerationId: 'generation', attemptId: 'attempt', fence: 1,
});

function config(): any {
  const outputSchema = '{"type":"object"}';
  return {
    type: 'governed-proof-inspect', message: 'Review the component', instructions: 'Return one JSON object',
    invocation: {
      role_id: 'proof-inspect', stance: 'owner',
      subject: { kind: 'project', id: 'fixture', fingerprint: `sha256:${'a'.repeat(64)}` },
      output_schema_id: 'result', output_schema: Buffer.from(outputSchema, 'utf8').toString('base64'),
    },
    invocation_digest: `sha256:${'b'.repeat(64)}`, result_schema: outputSchema,
    profile: 'luna-xhigh-readonly-v1',
  };
}

function attestation(invocationDigest: string): any {
  const digest = `sha256:${'c'.repeat(64)}`;
  const attestationDigest = 'c'.repeat(64);
  return {
    version: 'probe.governed-codex-attestation/v2', profileId: 'luna-xhigh-readonly-v1',
    requested: { profileDigest: attestationDigest, cwdDigest: attestationDigest, probeToolsDigest: attestationDigest, model: 'gpt-5.6-luna', reasoningEffort: 'xhigh', sandbox: 'read-only', approvalPolicy: 'never' },
    observed: { source: 'session_configured', model: 'gpt-5.6-luna', modelProviderId: 'openai', reasoningEffort: 'xhigh', approvalPolicy: 'never', cwdDigest: attestationDigest, permissionProfileDigest: attestationDigest, filesystem: 'restricted-read-root', network: 'restricted' },
    executionContext: { source: 'caller', invocationDigest },
    dispatch: { source: 'probe-host-tools-call', tool: 'codex', promptDigest: digest, promptBytes: 7 },
    evidence: { eventCount: 1 }, usage: { status: 'unavailable' },
  };
}

function runnerResult(): any {
  const data = { findingCount: 0, ok: true };
  return {
    data,
    runtimeAttestation: attestation(config().invocation_digest),
    resultIdentity: {
      version: 'probe.governed-result-identity/v1', source: 'probe-host-schema-valid-json',
      resultDigest: governedResultDigest(data), canonicalBytes: Buffer.byteLength(canonicalJson(data)),
    },
  };
}

function request(): any {
  return { prInfo: {}, checkConfig: config(), dependencyResults: new Map(), executionContext: {}, binding, executionConfigDigest: 'd'.repeat(64), workingDirectory: process.cwd() };
}

function componentSelector(): any {
  return {
    type: 'governed-proof-inspect', profile: 'luna-xhigh-readonly-v1',
    invocation: {
      role_id: 'onboard', stance: 'owner', subject: { kind: 'component' },
      output_schema_id: 'proof.findings/v1', output_schema: Buffer.from('{"type":"object"}', 'utf8').toString('base64'),
    },
    consumes: [{ claim: 'component.work_item@1', as: 'component' }],
  };
}

describe('governed Proof inspect provider', () => {
  it('is sealed unavailable in the product registry shape', async () => {
    const provider = new GovernedProofInspectCheckProvider();
    await expect(provider.isAvailable()).resolves.toBe(false);
    await expect(provider.execute({} as any, config())).rejects.toThrow(GOVERNED_PROBE_UNAVAILABLE);
    await expect(provider.validateConfig(config())).resolves.toBe(true);
    expect(provider.getRequirements()).toEqual([GOVERNED_PROBE_UNAVAILABLE]);
  });

  it('accepts only the closed authored config and rejects accessors/surrogates', async () => {
    expect(Object.keys(projectGovernedProofInspectConfig(config()))).toEqual([
      'instructions', 'invocation', 'invocation_digest', 'message', 'profile', 'result_schema', 'type',
    ]);
    const getter: any = config();
    Object.defineProperty(getter, 'message', { enumerable: true, get: () => 'secret' });
    await expect(new GovernedProofInspectCheckProvider().validateConfig(getter)).resolves.toBe(false);
    const surrogate: any = config();
    surrogate.instructions = String.fromCharCode(0xd800);
    expect(() => projectGovernedProofInspectConfig(surrogate)).toThrow('config fields are invalid');
    await expect(new GovernedProofInspectCheckProvider().validateConfig(surrogate)).resolves.toBe(false);
    const symbol: any = config(); symbol[Symbol('runtime')] = true;
    await expect(new GovernedProofInspectCheckProvider().validateConfig(symbol)).resolves.toBe(false);
    const base64: any = config(); base64.invocation.output_schema = 'eyJ0eXBlIjoib2JqZWN0In0';
    await expect(new GovernedProofInspectCheckProvider().validateConfig(base64)).resolves.toBe(false);
    expect(() => projectGovernedProofInspectConfig({ ...config(), runtime_unknown_enriched_key: true })).toThrow('unknown config key');
    expect(() => projectGovernedProofInspectConfig({ ...config(), consumes: [], emits: [] })).not.toThrow();
  });

  it('accepts controller timeout metadata but strips it from Proof authority', () => {
    const projected = projectGovernedProofInspectConfig({ ...config(), ai: { timeout: 600000 } });
    expect((projected as any).ai).toBeUndefined();
    expect(Object.keys(projected)).toEqual(['instructions', 'invocation', 'invocation_digest', 'message', 'profile', 'result_schema', 'type']);
  });

  it('accepts only the stable component selector and keeps its projected identity free of runtime authority', () => {
    const selector = componentSelector();
    const projected = projectGovernedProofInspectConfig(selector);
    expect(projected).toEqual(expect.objectContaining({ type: selector.type, profile: selector.profile, invocation: selector.invocation }));
    for (const field of ['instructions', 'invocation_digest', 'result_schema']) {
      expect(() => projectGovernedProofInspectConfig({ ...selector, [field]: 'forged' })).toThrow('component selector');
    }
    expect(() => projectGovernedProofInspectConfig({ ...selector, invocation: { ...selector.invocation, subject: { kind: 'component', id: 'forged', fingerprint: `sha256:${'a'.repeat(64)}` } } })).toThrow();
  });

  it('rejects a fully resolved authored component subject outside the selector form', () => {
    expect(() => projectGovernedProofInspectConfig({
      ...config(),
      invocation: {
        ...config().invocation,
        subject: { kind: 'component', id: 'forged', fingerprint: `sha256:${'a'.repeat(64)}` },
      },
    })).toThrow('invocation subject is invalid');
  });

  it('uses a focused-only runner seam and emits a frozen typed candidate outcome', async () => {
    const answer = jest.fn(() => runnerResult());
    const cancel = jest.fn();
    const close = jest.fn();
    let captured: any;
    const provider = createGovernedProofInspectProviderForFocusedTest(requestValue => {
      captured = requestValue;
      expect(Object.isFrozen(requestValue)).toBe(true);
      expect(Object.isFrozen(requestValue.binding)).toBe(true);
      return { answer, cancel, close };
    });
    const run = provider.startManaged(request());
    await expect(run.started).resolves.toMatchObject({ kind: 'started', binding });
    const outcome: any = await run.outcome;
    expect(outcome.kind).toBe('succeeded-proof-candidate');
    expect(captured.message).toBe(GOVERNED_PROOF_INSPECT_MESSAGE);
    expect(captured.instructions).toBe(config().instructions);
    expect(captured.invocation).toEqual(config().invocation);
    expect(captured.invocationDigest).toBe(config().invocation_digest);
    expect(captured.resultSchema).toBe(config().result_schema);
    expect(captured.workingDirectory).toBe(process.cwd());
    expect(Object.keys(outcome)).toEqual(['version', 'kind', 'binding', 'summary', 'proofCandidateEvidence', 'wireMode']);
    expect(outcome.wireMode).toBe('generic');
    expect(Object.isFrozen(outcome.proofCandidateEvidence)).toBe(true);
    expect(Object.isFrozen(outcome.proofCandidateEvidence.probe.attestation)).toBe(true);
    expect(answer).toHaveBeenCalledTimes(1);
    await expect(run.cancel('deadline', binding.fence)).resolves.toMatchObject({ kind: 'cancelled' });
    await expect(run.cancel('deadline', binding.fence)).resolves.toMatchObject({ kind: 'cancelled' });
    await run.close(); await run.close();
    expect(cancel).toHaveBeenCalledTimes(1); expect(close).toHaveBeenCalledTimes(1);
  });

  it('rejects a projection tamper before constructing or dispatching the runner', () => {
    const factory = jest.fn(() => ({
      answer: jest.fn(), cancel: jest.fn(), close: jest.fn(),
    }));
    const provider = createGovernedProofInspectProviderForFocusedTest(factory);
    expect(() => provider.startManaged({ ...request(), checkConfig: { ...config(), unexpected: true } })).toThrow('unknown config key');
    expect(factory).not.toHaveBeenCalled();
  });

  it('rejects noncanonical runner data and stale cancellation fences', async () => {
    const provider = createGovernedProofInspectProviderForFocusedTest(() => ({
      answer: () => ({ ...runnerResult(), data: { '10': 'ten', '2': 'two' } }),
      cancel: () => undefined, close: () => undefined,
    }));
    const run = provider.startManaged(request());
    await expect(run.outcome).rejects.toThrow('GOVERNED_PROOF_INVALID');
    await expect(run.cancel('deadline', binding.fence + 1)).rejects.toThrow('stale');
    await run.close();
  });

  it('binds invocation and result identity and rejects detached evidence', async () => {
    const detached = createGovernedProofInspectProviderForFocusedTest(() => ({
      answer: () => ({ ...runnerResult(), runtimeAttestation: attestation(`sha256:${'e'.repeat(64)}`) }),
      cancel: () => undefined, close: () => undefined,
    }));
    await expect(detached.startManaged(request()).outcome).rejects.toThrow('GOVERNED_PROOF_INVALID');
    const malformed = runnerResult(); malformed.data = { '10': 'ten', '2': 'two' };
    expect(() => validateProofCandidateEvidence({ ...malformed, proof: malformed })).toThrow('GOVERNED_PROOF_INVALID');
  });

  it('accepts rc332 bare attestation digests and rejects every alternate shape', async () => {
    const provider = createGovernedProofInspectProviderForFocusedTest(() => ({ answer: runnerResult, cancel: () => undefined, close: () => undefined }));
    const evidence: any = (await provider.startManaged(request()).outcome as any).proofCandidateEvidence;
    const fields = [['requested', 'profileDigest'], ['requested', 'cwdDigest'], ['requested', 'probeToolsDigest'], ['observed', 'cwdDigest'], ['observed', 'permissionProfileDigest']];
    const edit = (field: string[], change: (value: any, key: string) => void) => { const copy = JSON.parse(JSON.stringify(evidence)); change(copy.probe.attestation[field[0]], field[1]); return copy; };
    for (const [parent, key] of fields) {
      for (const value of ['0'.repeat(64), 'f'.repeat(64)]) expect(() => validateProofCandidateEvidence(edit([parent, key], (object, name) => { object[name] = value; }))).not.toThrow();
      for (const value of [`sha256:${'c'.repeat(64)}`, 'C'.repeat(64), 'c'.repeat(63), 'c'.repeat(65), 'g'.repeat(64), ' '.repeat(64), null, [], 42, true]) expect(() => validateProofCandidateEvidence(edit([parent, key], (object, name) => { object[name] = value; }))).toThrow('GOVERNED_PROOF_INVALID');
      expect(() => validateProofCandidateEvidence(edit([parent, key], (object, name) => { delete object[name]; }))).toThrow('GOVERNED_PROOF_INVALID');
      let accessed = false;
      expect(() => validateProofCandidateEvidence(edit([parent, key], (object, name) => { Object.defineProperty(object, name, { enumerable: true, get: () => { accessed = true; return 'c'.repeat(64); } }); }))).toThrow('GOVERNED_PROOF_INVALID');
      expect(accessed).toBe(false);
      expect(() => validateProofCandidateEvidence(edit([parent, key], (object, name) => { Object.setPrototypeOf(object, { [name]: 'c'.repeat(64) }); delete object[name]; }))).toThrow('GOVERNED_PROOF_INVALID');
      expect(() => validateProofCandidateEvidence(edit([parent, key], (object) => { object.extra = true; }))).toThrow('GOVERNED_PROOF_INVALID');
    }
  });
});
