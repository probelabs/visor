jest.unmock('child_process');
import { describe, expect, it } from '@jest/globals';
import { resolve } from 'path';
import { CLI } from '../../src/cli';
import { ConfigManager } from '../../src/config';
import { StateMachineExecutionEngine } from '../../src/state-machine-execution-engine';
import { canonicalJson } from '../../src/state-machine/graph/claim-kernel';
import { CheckProviderRegistry } from '../../src/providers/check-provider-registry';
import { createGovernedProofInspectProviderForFocusedTest, governedResultDigest, GOVERNED_PROOF_INSPECT_MESSAGE } from '../../src/providers/governed-proof-inspect-check-provider';
import { createProofAdmissionCapability, goCompatibleProofJson, resolveProofRoleInvocation } from '../../src/providers/proof-admission-cli-child';
import type { GovernedProbeRunnerRequest } from '../../src/providers/governed-proof-inspect-check-provider';
import type { CheckProvider } from '../../src/providers/check-provider.interface';
import type { PRInfo } from '../../src/pr-analyzer';

const PROJECT = resolve(__dirname, '../../examples/agent-governance/one-component');
const PROOF = '/tmp/exp0207b-proof-plain-retry/proof-db183bff';
const FINGERPRINT = 'sha256:2d734abe14567b9dc1ebc65b47ccb01493c31f14bdf97ca1a336d66cda0f1170';
const SCHEMA = 'eyJ0eXBlIjoib2JqZWN0IiwiYWRkaXRpb25hbFByb3BlcnRpZXMiOmZhbHNlLCJyZXF1aXJlZCI6WyJkZWNpc2lvbiJdLCJwcm9wZXJ0aWVzIjp7ImRlY2lzaW9uIjp7InR5cGUiOiJzdHJpbmciLCJlbnVtIjpbImFjY2VwdCJdfX19';
const prInfo = { number: 1, title: 'EXP-0208', author: 'test', base: 'main', head: 'demo', files: [], totalAdditions: 0, totalDeletions: 0, eventType: 'manual' } as PRInfo;

function invocation() { return { role_id: 'spec-review', stance: 'owner', subject: { kind: 'requirement', id: 'SYS-REQ-001', fingerprint: FINGERPRINT }, output_schema_id: 'proof.findings/v1', output_schema: SCHEMA }; }
function fakeAnswer(request: GovernedProbeRunnerRequest) {
  const data = { decision: 'accept' }; const digest = governedResultDigest(data); const d = 'c'.repeat(64);
  return { data, runtimeAttestation: { version: 'probe.governed-codex-attestation/v2', profileId: 'luna-xhigh-readonly-v1', requested: { profileDigest: d, cwdDigest: d, probeToolsDigest: d, model: 'gpt-5.6-luna', reasoningEffort: 'xhigh', sandbox: 'read-only', approvalPolicy: 'never' }, observed: { source: 'session_configured', model: 'gpt-5.6-luna', modelProviderId: 'openai', reasoningEffort: 'xhigh', approvalPolicy: 'never', cwdDigest: d, permissionProfileDigest: d, filesystem: 'restricted-read-root', network: 'restricted' }, executionContext: { source: 'caller', invocationDigest: request.invocationDigest }, dispatch: { source: 'probe-host-tools-call', tool: 'codex', promptDigest: digest, promptBytes: 0 }, evidence: { eventCount: 1 }, usage: { status: 'unavailable' } }, resultIdentity: { version: 'probe.governed-result-identity/v1', source: 'probe-host-schema-valid-json', resultDigest: digest, canonicalBytes: Buffer.byteLength(canonicalJson(data)) } };
}

describe('EXP-0208 product-native demo pack', () => {
  it('parses --proof-bin and projects canonical C0 before final config validation', async () => {
    const options = new CLI().parseArgs(['node', 'visor', '--config', 'visor.yaml', '--proof-bin', PROOF]);
    expect(options.proofBin).toBe(PROOF);
    const capability = createProofAdmissionCapability(PROOF);
    const c0 = await resolveProofRoleInvocation(capability, invocation(), PROJECT) as any;
    expect(Object.keys(c0)).toEqual(['version', 'role_id', 'role_source', 'stance', 'subject', 'authority', 'output_schema_id', 'output_schema', 'output_schema_digest', 'instructions', 'role_text_digest', 'invocation_digest']);
    const compact = goCompatibleProofJson(c0);
    expect(compact).toBe(goCompatibleProofJson(JSON.parse(compact)));
    expect(c0.subject).toEqual(invocation().subject);
  });

  it('runs one catalog item through focused inspect, real Proof admission, and noop activation', async () => {
    const manager = new ConfigManager(); const raw: any = await manager.loadConfig(resolve(PROJECT, 'visor.yaml'), { validate: false, mergeDefaults: false });
    const c0 = await resolveProofRoleInvocation(createProofAdmissionCapability(PROOF), invocation(), PROJECT) as any;
    const inspect = raw.subgraphs['one-component'].checks.inspect; inspect.message = GOVERNED_PROOF_INSPECT_MESSAGE; inspect.instructions = c0.instructions; inspect.invocation_digest = c0.invocation_digest; inspect.result_schema = Buffer.from(c0.output_schema, 'base64').toString(); raw.memory.namespace = `exp0208-${Date.now()}`;
    manager.validateConfig(raw); const config: any = await manager.loadConfigFromObject(raw, { validate: false, mergeDefaults: true, baseDir: PROJECT });
    const registry = CheckProviderRegistry.getInstance(); const descriptor = Object.getOwnPropertyDescriptor(registry as any, 'providers')!; const map = descriptor.value as Map<string, CheckProvider>; const original = [...map.entries()]; const capability = createProofAdmissionCapability(PROOF); registry.bootstrapProofAdmission(capability);
    const focused = createGovernedProofInspectProviderForFocusedTest(() => ({ answer: fakeAnswer, cancel: () => {}, close: () => {} })); map.set('governed-proof-inspect', focused);
    try {
      const engine = new StateMachineExecutionEngine(PROJECT); const result = await engine.executeGroupedChecks(prInfo, ['discover'], undefined, config, 'json', false, 1); const journal = (engine as any)._lastContext.journal; const events = (journal.readRuntimeEvents() as any[]).filter(event => event.scope?.[0]?.key === 'A');
      const candidate = events.filter(event => event.type === 'ClaimPublished' && event.claim === 'proof.candidate@1'); const receipt = events.filter(event => event.type === 'ClaimPublished' && event.claim === 'proof.admitted_receipt@1'); const verify = events.find(event => event.type === 'NodeGenerationActivated' && event.checkId === 'verify');
      expect(result.statistics.failedExecutions).toBe(0); expect(candidate).toHaveLength(1); expect(receipt).toHaveLength(1); expect(events.filter(event => event.type === 'NodeGenerationActivated').map(event => event.checkId)).toEqual(['inspect', 'proof_admit', 'verify']);
      expect([...verify.activeInputClaimIds].sort()).toEqual([candidate[0].claimId, receipt[0].claimId].sort()); expect(journal.getInstanceProjection()).toEqual(journal.replayInstanceProjection());
    } finally { map.clear(); for (const entry of original) map.set(entry[0], entry[1]); CheckProviderRegistry.clearInstance(); }
  });
});
