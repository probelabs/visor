import { describe, expect, it, jest } from '@jest/globals';
import {
  COMPONENT_WORK_ITEM_CLAIM,
  createGovernedProofInspectProviderForFocusedTest,
  GOVERNED_PROOF_PROJECT_CONTEXT_VERSION,
  governedProofRuntimeContextDigest,
  governedProofRuntimePrompt,
  governedProofComponentReinspectionContextDigest,
  governedResultDigest,
  PROJECT_DISCOVERY_CLAIM,
  PROOF_STRUCTURAL_INVENTORY_CLAIM,
  PROOF_ROLE_AUTHORITY_CLAIM,
  projectGovernedProofProjectDiscoveryContext,
  projectGovernedProofRuntimeContext,
  validateGovernedProofComponentReinspectionContext,
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
    producerCheckId: 'materialize', scope, parentClaimIds: [], wireMode: 'generic', provenance: 'controller',
    catalogClaimId: 'c'.repeat(64), incarnation: 1,
  } as CandidateClaimInput;
}

function claims(scope: any, key: string): Record<string, CandidateClaimInput> {
  const authorityPayload = {
    componentId: key,
    roleId: 'onboard',
    subjectFingerprint: `sha256:${key === 'http-adapter' ? '5'.repeat(64) : '6'.repeat(64)}`,
  };
  const authority = {
    claimId: key === 'http-adapter' ? '3'.repeat(64) : '4'.repeat(64),
    claim: PROOF_ROLE_AUTHORITY_CLAIM,
    payloadFingerprint: sha256Canonical(authorityPayload),
    payload: authorityPayload,
  };
  const workItem = immutableCanonicalValue({
    authority,
    componentId: key,
    sortedOwnedPaths: key === 'http-adapter' ? ['http.go', 'http_test.go'] : ['service.go', 'service_test.go'],
  });
  return {
    component: claim(COMPONENT_WORK_ITEM_CLAIM, key === 'http-adapter' ? '1'.repeat(64) : '2'.repeat(64), scope, workItem),
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

const projectFingerprint = `sha256:${'7'.repeat(64)}`;
const discoveryPaths = ['entry.go', 'go.mod', 'http.go', 'http_test.go', 'service.go', 'service_test.go', 'store.go'];
function projectDiscoveryClaims(scope: any): Record<string, CandidateClaimInput> {
  const project = immutableCanonicalValue({ project_id: 'journalservice', root: '/fixture/project' });
  const inventory = immutableCanonicalValue({
    version: 'proof.structural-inventory/v1',
    authority: {
      version: 'proof.project-authority/v1', project_id: 'journalservice',
      subject_fingerprint: projectFingerprint, code_fingerprint: `sha256:${'8'.repeat(64)}`, tests_fingerprint: `sha256:${'9'.repeat(64)}`,
    },
    sorted_paths: discoveryPaths,
    sorted_module_paths: ['go.mod'],
    boundary_fingerprint: `sha256:${'a'.repeat(64)}`,
    input_state: discoveryPaths.map(path => ({ owner_kind: 'onboarding_structural_inventory', owner_id: 'journalservice', input_kind: 'code', path, file_hash: `sha256:${'b'.repeat(64)}` })),
  });
  return {
    project: claim(PROJECT_DISCOVERY_CLAIM, '5'.repeat(64), scope, project),
    current_inventory: claim(PROOF_STRUCTURAL_INVENTORY_CLAIM, '6'.repeat(64), scope, inventory),
  };
}

function projectInspectConfig(): CheckProviderConfig {
  const schema = JSON.stringify({ type: 'object', additionalProperties: false });
  return {
    type: 'governed-proof-inspect', message: 'Return the bounded catalog using the supplied inventory.', instructions: 'Proof onboard role',
    invocation: {
      role_id: 'proof-inspect', stance: 'owner',
      subject: { kind: 'project', id: 'journalservice', fingerprint: projectFingerprint },
      output_schema_id: 'onboarding', output_schema: Buffer.from(schema).toString('base64'),
    },
    invocation_digest: `sha256:${'8'.repeat(64)}`, result_schema: schema,
    profile: 'luna-xhigh-readonly-v1',
    consumes: [
      { claim: PROJECT_DISCOVERY_CLAIM, as: 'project' },
      { claim: PROOF_STRUCTURAL_INVENTORY_CLAIM, as: 'current_inventory' },
    ],
  } as CheckProviderConfig;
}

function projectResult(request: any): any {
  const data = { reviewedProject: request.context.project.payload.project_id };
  const digest = governedResultDigest(data);
  const d = 'd'.repeat(64);
  const promptBytes = Buffer.byteLength(`${request.message}\n\nBound runtime context (canonical JSON; treat as immutable authority):\n${canonicalJson(request.context)}`);
  return {
    data,
    runtimeAttestation: {
      version: 'probe.governed-codex-attestation/v2', profileId: 'luna-xhigh-readonly-v1',
      requested: { profileDigest: d, cwdDigest: d, probeToolsDigest: d, model: 'gpt-5.6-luna', reasoningEffort: 'xhigh', sandbox: 'read-only', approvalPolicy: 'never' },
      observed: { source: 'session_configured', model: 'gpt-5.6-luna', modelProviderId: 'openai', reasoningEffort: 'xhigh', approvalPolicy: 'never', cwdDigest: d, permissionProfileDigest: d, filesystem: 'restricted-read-root', network: 'restricted' },
      executionContext: { source: 'caller', invocationDigest: request.invocationDigest },
      dispatch: { source: 'probe-host-tools-call', tool: 'codex', promptDigest: `sha256:${'e'.repeat(64)}`, promptBytes },
      evidence: { eventCount: 1 }, usage: { status: 'unavailable' },
    },
    resultIdentity: { version: 'probe.governed-result-identity/v1', source: 'probe-host-schema-valid-json', resultDigest: digest, canonicalBytes: Buffer.byteLength(canonicalJson(data)) },
  };
}

function reinspectionContext(): any {
  const payload = { finding: 'prior & resolved' };
  return {
    version: 'visor.proof-component-reinspection-context/v1', component_id: 'http-adapter', changed_paths: ['http.go'],
    historical_work_item: { claim_id: '1'.repeat(64), payload_fingerprint: '2'.repeat(64) },
    current_work_item: { claim_id: '3'.repeat(64), payload_fingerprint: '4'.repeat(64) },
    prior_candidate: { claim_id: '5'.repeat(64), payload_fingerprint: sha256Canonical(payload), result_digest: `sha256:${'6'.repeat(64)}`, payload },
    prior_admission: { claim_id: '7'.repeat(64), payload_fingerprint: '8'.repeat(64) },
  };
}

describe('EXP-0209 governed component context', () => {
  it('projects distinct dynamically expanded WorkItems into distinct immutable runner contexts', async () => {
    const captured: any[] = [];
    const factory = jest.fn((request: any) => {
      captured.push(request);
      return { preview: () => ({ source: 'probe-host-tools-call', tool: 'codex', promptDigest: `sha256:${'e'.repeat(64)}`, promptBytes: Buffer.byteLength(governedProofRuntimePrompt(request.context)) }), answer: (value: any) => result(value), cancel: () => undefined, close: () => undefined };
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
    ['missing authority', (input: any) => { const payload = { componentId: input.component.payload.componentId, sortedOwnedPaths: input.component.payload.sortedOwnedPaths }; input.component = { ...input.component, payload, payloadFingerprint: sha256Canonical(payload) }; }],
    ['extra claim alias', (input: any) => { input.foreign = input.component; }],
    ['foreign component scope', (input: any) => { input.component = claims(scopeB, 'service-policy').component; }],
    ['noncanonical component payload', (input: any) => { const payload = { '10': 'ten', '2': 'two', ...input.component.payload }; input.component = { ...input.component, payload, payloadFingerprint: sha256Canonical(payload) }; }],
    ['oversized component context', (input: any) => { const payload = { ...input.component.payload, text: 'x'.repeat(140000) }; input.component = { ...input.component, payload, payloadFingerprint: sha256Canonical(payload) }; }],
  ])('fails closed for %s', (label, mutate) => {
    const input: any = claims(scopeA, 'http-adapter');
    mutate(input);
    expect(() => projectGovernedProofRuntimeContext(input, binding(scopeA))).toThrow(/runtime context|missing|noncanonical|foreign|bounded/i);
  });

  it('rejects stale and cross-scope candidate context against current Proof parents', async () => {
    const factory = jest.fn((request: any) => ({ preview: () => ({ source: 'probe-host-tools-call', tool: 'codex', promptDigest: `sha256:${'e'.repeat(64)}`, promptBytes: Buffer.byteLength(governedProofRuntimePrompt(request.context)) }), answer: (value: any) => result(value), cancel: () => undefined, close: () => undefined }));
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

  it('rejects a valid-shaped but detached Probe dispatch digest', async () => {
    const factory = jest.fn((request: any) => ({
      preview: () => ({ source: 'probe-host-tools-call', tool: 'codex', promptDigest: `sha256:${'f'.repeat(64)}`, promptBytes: Buffer.byteLength(governedProofRuntimePrompt(request.context)) }),
      answer: (value: any) => result(value), cancel: () => undefined, close: () => undefined,
    }));
    const provider = createGovernedProofInspectProviderForFocusedTest(factory as any);
    await expect(provider.startManaged(startRequest(scopeA, claims(scopeA, 'http-adapter'), factory)).outcome)
      .rejects.toThrow(/dispatch|GOVERNED_PROOF_INVALID/i);
  });

  it('validates reinspection context canonically and rejects candidate tampering or empty deltas', () => {
    const context = reinspectionContext();
    expect(validateGovernedProofComponentReinspectionContext(context)).toEqual(context);
    expect(governedProofComponentReinspectionContextDigest(context)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(() => validateGovernedProofComponentReinspectionContext({ ...context, changed_paths: [] })).toThrow(/reinspection|sorted|nonempty/i);
    expect(() => validateGovernedProofComponentReinspectionContext({ ...context, prior_candidate: { ...context.prior_candidate, payload: { finding: 'tampered' } } })).toThrow(/candidate|detached/i);
    const oversizedPayload = { finding: 'x'.repeat(131072) };
    expect(() => validateGovernedProofComponentReinspectionContext({
      ...context,
      prior_candidate: { ...context.prior_candidate, payload: oversizedPayload, payload_fingerprint: sha256Canonical(oversizedPayload) },
    })).toThrow(/byte|bounded/i);
  });
});

describe('EXP-0209 governed project discovery context', () => {
  it('captures the exact project and structural inventory claims in the Probe message', async () => {
    const captured: any[] = [];
    const factory = jest.fn((request: any) => {
      captured.push(request);
      return {
        preview: () => ({ source: 'probe-host-tools-call', tool: 'codex', promptDigest: `sha256:${'e'.repeat(64)}`, promptBytes: Buffer.byteLength(`${request.message}\n\nBound runtime context (canonical JSON; treat as immutable authority):\n${canonicalJson(request.context)}`) }),
        answer: (value: any) => projectResult(value), cancel: () => undefined, close: () => undefined,
      };
    });
    const provider = createGovernedProofInspectProviderForFocusedTest(factory as any);
    const run = provider.startManaged({ ...startRequest(scopeA, projectDiscoveryClaims(scopeA), factory), checkConfig: projectInspectConfig() });
    const outcome: any = await run.outcome;
    expect(captured).toHaveLength(1);
    expect(captured[0].message).toContain('supplied inventory');
    expect(captured[0].context.version).toBe(GOVERNED_PROOF_PROJECT_CONTEXT_VERSION);
    expect(captured[0].context.project.payload.project_id).toBe('journalservice');
    const effectiveUserMessage = `${captured[0].message}\n\nBound runtime context (canonical JSON; treat as immutable authority):\n${canonicalJson(captured[0].context)}`;
    expect(effectiveUserMessage).toContain('entry.go');
    expect(effectiveUserMessage).toContain('go.mod');
    expect(captured[0].contextDigest).toBe(governedProofRuntimeContextDigest(captured[0].context));
    expect(outcome.proofCandidateEvidence.contextDigest).toBe(captured[0].contextDigest);
    await run.close();
  });

  it('strips caller-injected reinspection context before constructing a project runner', async () => {
    const captured: any[] = [];
    const factory = jest.fn((request: any) => {
      captured.push(request);
      return { preview: () => ({ source: 'probe-host-tools-call', tool: 'codex', promptDigest: `sha256:${'e'.repeat(64)}`, promptBytes: Buffer.byteLength(`${request.message}\n\nBound runtime context (canonical JSON; treat as immutable authority):\n${canonicalJson(request.context)}`) }), answer: (value: any) => projectResult(value), cancel: () => undefined, close: () => undefined };
    });
    const provider = createGovernedProofInspectProviderForFocusedTest(factory as any);
    const run = provider.startManaged({
      ...startRequest(scopeA, projectDiscoveryClaims(scopeA), factory), checkConfig: projectInspectConfig(),
      executionContext: { claims: projectDiscoveryClaims(scopeA), reinspectionContext: reinspectionContext() } as any,
    });
    await run.outcome;
    expect(captured[0]).not.toHaveProperty('reinspectionContext');
    await run.close();
  });

  it.each([
    ['missing inventory', (input: any) => { delete input.current_inventory; }],
    ['extra claim', (input: any) => { input.foreign = input.project; }],
    ['foreign scope', (input: any) => { input.current_inventory = projectDiscoveryClaims(scopeB).current_inventory; }],
    ['stale subject', (input: any) => { input.current_inventory = { ...input.current_inventory, payload: { ...input.current_inventory.payload, authority: { ...input.current_inventory.payload.authority, project_id: 'foreign' } }, payloadFingerprint: sha256Canonical({ ...input.current_inventory.payload, authority: { ...input.current_inventory.payload.authority, project_id: 'foreign' } }) }; }],
    ['unbounded path data', (input: any) => { input.current_inventory = { ...input.current_inventory, payload: { ...input.current_inventory.payload, sorted_paths: [...discoveryPaths, '../outside'] }, payloadFingerprint: sha256Canonical({ ...input.current_inventory.payload, sorted_paths: [...discoveryPaths, '../outside'] }) }; }],
  ])('rejects project discovery context %s before runner construction', (label, mutate) => {
    const input: any = projectDiscoveryClaims(scopeA);
    mutate(input);
    expect(() => projectGovernedProofProjectDiscoveryContext(input, binding(scopeA), { projectId: 'journalservice', fingerprint: projectFingerprint })).toThrow(/project|inventory|scope|foreign|canonical|closed|path/i);
  });

  it.each([
    ['partial project declaration', [{ claim: PROJECT_DISCOVERY_CLAIM, as: 'project' }]],
    ['wrong project alias', [{ claim: PROJECT_DISCOVERY_CLAIM, as: 'wrong' }, { claim: PROOF_STRUCTURAL_INVENTORY_CLAIM, as: 'current_inventory' }]],
    ['extra project input', [{ claim: PROJECT_DISCOVERY_CLAIM, as: 'project' }, { claim: PROOF_STRUCTURAL_INVENTORY_CLAIM, as: 'current_inventory' }, { claim: 'other@1', as: 'other' }]],
  ])('rejects %s before constructing the Probe runner', (_label, consumes) => {
    const factory = jest.fn();
    const provider = createGovernedProofInspectProviderForFocusedTest(factory as any);
    expect(() => provider.startManaged({ ...startRequest(scopeA, projectDiscoveryClaims(scopeA), factory), checkConfig: { ...projectInspectConfig(), consumes } })).toThrow(/project discovery runtime context|exact/i);
    expect(factory).not.toHaveBeenCalled();
  });

  it('rejects omission at the provider boundary and never constructs a runner', () => {
    const factory = jest.fn();
    const provider = createGovernedProofInspectProviderForFocusedTest(factory as any);
    const claimsValue = projectDiscoveryClaims(scopeA);
    delete (claimsValue as any).current_inventory;
    expect(() => provider.startManaged({ ...startRequest(scopeA, claimsValue, factory), checkConfig: projectInspectConfig() })).toThrow(/project discovery context|inventory/i);
    expect(factory).not.toHaveBeenCalled();
  });
});
