import { describe, expect, it, jest } from '@jest/globals';
import {
  COMPONENT_WORK_ITEM_CLAIM,
  createGovernedProofInspectProviderForFocusedTest,
  governedProofRuntimeContextDigest,
  governedProofRuntimePrompt,
  governedResultDigest,
  PROOF_ROLE_AUTHORITY_CLAIM,
  projectGovernedProofRuntimeContext,
  validateGovernedProofRuntimeContextAgainstClaims,
} from '../../../src/providers/governed-proof-inspect-check-provider';
import type { CandidateClaimInput, CheckProviderConfig } from '../../../src/providers/check-provider.interface';
import { canonicalJson, immutableCanonicalValue, sha256Canonical } from '../../../src/state-machine/graph/claim-kernel';

const scopeA: any = immutableCanonicalValue([{ kind: 'keyed', expansionOwnerCheck: 'discover', key: 'http-adapter', subgraphInstanceId: 'a'.repeat(64) }]);
const scopeB: any = immutableCanonicalValue([{ kind: 'keyed', expansionOwnerCheck: 'discover', key: 'service-policy', subgraphInstanceId: 'b'.repeat(64) }]);

function binding(scope: any): any {
  return {
    managedRunId: `managed-${scope[0].key}`,
    sessionId: 'session', checkId: 'inspect', scope,
    nodeInstanceId: `node-${scope[0].key}`, nodeGenerationId: `generation-${scope[0].key}`,
    attemptId: `attempt-${scope[0].key}`, fence: 1,
  };
}

function claim(claimName: string, id: string, scope: any, payload: unknown): CandidateClaimInput {
  return {
    claimId: id, claim: claimName, payload, payloadFingerprint: sha256Canonical(payload),
    producerCheckId: 'materialize', scope, parentClaimIds: [], provenance: 'controller',
    catalogClaimId: 'c'.repeat(64), incarnation: 1,
  } as CandidateClaimInput;
}

function claims(scope: any, key: string): Record<string, CandidateClaimInput> {
  return {
    component: claim(COMPONENT_WORK_ITEM_CLAIM, key === 'http-adapter' ? '1'.repeat(64) : '2'.repeat(64), scope, {
      componentId: key, sortedOwnedPaths: key === 'http-adapter' ? ['http.go', 'http_test.go'] : ['service.go', 'service_test.go'],
    }),
    authority: claim(PROOF_ROLE_AUTHORITY_CLAIM, key === 'http-adapter' ? '3'.repeat(64) : '4'.repeat(64), scope, {
      componentId: key, roleId: 'onboard', subjectFingerprint: `sha256:${key === 'http-adapter' ? '5'.repeat(64) : '6'.repeat(64)}`,
    }),
  };
}

function inspectConfig(): CheckProviderConfig {
  const schema = JSON.stringify({ type: 'object', additionalProperties: false });
  return {
    type: 'governed-proof-inspect', message: 'ignored', instructions: 'Inspect the bound component',
    invocation: {
      role_id: 'onboard', stance: 'owner',
      subject: { kind: 'project', id: 'journalservice', fingerprint: `sha256:${'7'.repeat(64)}` },
      output_schema_id: 'onboarding', output_schema: Buffer.from(schema).toString('base64'),
    },
    invocation_digest: `sha256:${'8'.repeat(64)}`, result_schema: schema,
    profile: 'luna-xhigh-readonly-v1',
    consumes: [
      { claim: COMPONENT_WORK_ITEM_CLAIM, as: 'component' },
      { claim: PROOF_ROLE_AUTHORITY_CLAIM, as: 'authority' },
    ],
  } as CheckProviderConfig;
}

function result(request: any): any {
  const data = { reviewedComponent: request.context.component.payload.componentId };
  const digest = governedResultDigest(data);
  const d = 'd'.repeat(64);
  return {
    data,
    runtimeAttestation: {
      version: 'probe.governed-codex-attestation/v2', profileId: 'luna-xhigh-readonly-v1',
      requested: { profileDigest: d, cwdDigest: d, probeToolsDigest: d, model: 'gpt-5.6-luna', reasoningEffort: 'xhigh', sandbox: 'read-only', approvalPolicy: 'never' },
      observed: { source: 'session_configured', model: 'gpt-5.6-luna', modelProviderId: 'openai', reasoningEffort: 'xhigh', approvalPolicy: 'never', cwdDigest: d, permissionProfileDigest: d, filesystem: 'restricted-read-root', network: 'restricted' },
      executionContext: { source: 'caller', invocationDigest: request.invocationDigest },
      dispatch: { source: 'probe-host-tools-call', tool: 'codex', promptDigest: `sha256:${'e'.repeat(64)}`, promptBytes: Buffer.byteLength(governedProofRuntimePrompt(request.context)) },
      evidence: { eventCount: 1 }, usage: { status: 'unavailable' },
    },
    resultIdentity: { version: 'probe.governed-result-identity/v1', source: 'probe-host-schema-valid-json', resultDigest: digest, canonicalBytes: Buffer.byteLength(canonicalJson(data)) },
  };
}

function startRequest(scope: any, inputClaims: Record<string, CandidateClaimInput>, factory: jest.Mock): any {
  return {
    prInfo: {}, checkConfig: inspectConfig(), dependencyResults: new Map(), executionContext: { claims: inputClaims },
    binding: binding(scope), executionConfigDigest: 'f'.repeat(64), workingDirectory: process.cwd(),
    factory,
  };
}

describe('EXP-0209 governed component context', () => {
  it('projects distinct dynamically expanded WorkItems into distinct immutable runner contexts', async () => {
    const captured: any[] = [];
    const factory = jest.fn((request: any) => {
      captured.push(request);
      return { answer: (value: any) => result(value), cancel: () => undefined, close: () => undefined };
    });
    const provider = createGovernedProofInspectProviderForFocusedTest(factory as any);
    const runA = provider.startManaged(startRequest(scopeA, claims(scopeA, 'http-adapter'), factory));
    const runB = provider.startManaged(startRequest(scopeB, claims(scopeB, 'service-policy'), factory));
    const [outcomeA, outcomeB]: any[] = await Promise.all([runA.outcome, runB.outcome]);
    expect(captured).toHaveLength(2);
    expect(captured[0].context.component.payload.componentId).toBe('http-adapter');
    expect(captured[1].context.component.payload.componentId).toBe('service-policy');
    expect(captured[0].contextDigest).not.toBe(captured[1].contextDigest);
    expect(captured[0].contextDigest).toBe(governedProofRuntimeContextDigest(captured[0].context));
    expect(captured[0].context).not.toBe(captured[1].context);
    expect(outcomeA.proofCandidateEvidence.contextDigest).toBe(captured[0].contextDigest);
    expect(outcomeB.proofCandidateEvidence.contextDigest).toBe(captured[1].contextDigest);
    expect(governedProofRuntimePrompt(captured[0].context)).toContain('http-adapter');
    await Promise.all([runA.close(), runB.close()]);
  });

  it.each([
    ['missing authority', (input: any) => { delete input.authority; }],
    ['extra claim alias', (input: any) => { input.foreign = input.component; }],
    ['foreign component scope', (input: any) => { input.component = claims(scopeB, 'service-policy').component; }],
    ['noncanonical component payload', (input: any) => { input.component = { ...input.component, payload: { '10': 'ten', '2': 'two' }, payloadFingerprint: sha256Canonical({ '10': 'ten', '2': 'two' }) }; }],
    ['oversized component context', (input: any) => { const payload = { componentId: 'http-adapter', text: 'x'.repeat(140000) }; input.component = { ...input.component, payload, payloadFingerprint: sha256Canonical(payload) }; }],
  ])('fails closed for %s', (label, mutate) => {
    const input: any = claims(scopeA, 'http-adapter');
    mutate(input);
    expect(() => projectGovernedProofRuntimeContext(input, binding(scopeA))).toThrow(/runtime context|noncanonical|foreign|bounded/i);
  });

  it('rejects stale and cross-scope candidate context against current Proof parents', async () => {
    const factory = jest.fn(() => ({ answer: (value: any) => result(value), cancel: () => undefined, close: () => undefined }));
    const provider = createGovernedProofInspectProviderForFocusedTest(factory as any);
    const run = provider.startManaged(startRequest(scopeA, claims(scopeA, 'http-adapter'), factory));
    const outcome: any = await run.outcome;
    const evidence = outcome.proofCandidateEvidence;
    expect(() => validateGovernedProofRuntimeContextAgainstClaims(evidence, Object.values(claims(scopeB, 'service-policy')), binding(scopeB))).toThrow(/parent|stale|foreign/i);
    const stale = claims(scopeA, 'http-adapter');
    stale.component = { ...stale.component, payloadFingerprint: '9'.repeat(64) } as any;
    expect(() => validateGovernedProofRuntimeContextAgainstClaims(evidence, Object.values(stale), binding(scopeA))).toThrow(/stale|foreign/i);
    await run.close();
  });
});
