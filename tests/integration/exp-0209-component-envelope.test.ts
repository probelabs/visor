import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as yaml from 'js-yaml';
import { ExecutionJournal } from '../../src/snapshot-store';
import { compileClaimPlan } from '../../src/state-machine/graph/claim-plan';
import {
  createGovernedProofInspectProviderForFocusedTest,
  governedProofRuntimePrompt,
  governedResultDigest,
} from '../../src/providers/governed-proof-inspect-check-provider';
import { canonicalJson, sha256Canonical } from '../../src/state-machine/graph/claim-kernel';

const PROFILE = resolve(__dirname, '../../examples/agent-governance/exp-0209-component-envelope/visor.yaml');

describe('EXP-0209 authored component envelope', () => {
  it('compiles the authored profile, expands a WorkItem, and executes its generated inspect node', async () => {
    const authored: any = yaml.load(readFileSync(PROFILE, 'utf8'));
    authored.checks.discover.value.components[0].authority.payloadFingerprint = sha256Canonical(
      authored.checks.discover.value.components[0].authority.payload
    );
    const plan = compileClaimPlan(authored);
    const journal = new ExecutionJournal(plan);
    const sessionId = 'exp-0209-envelope-test';
    const request = journal.requestCatalogReconciliation({ sessionId, ownerCheck: 'discover' });
    const catalogAttempt = journal.startCatalogRequestAttempt(request.requestId);
    journal.scheduleCatalogRequestAttempt({
      requestId: request.requestId,
      attemptId: catalogAttempt.attemptId,
      fence: catalogAttempt.fence,
    });
    journal.completeAttempt({
      sessionId,
      checkId: 'discover',
      scope: [],
      attemptId: catalogAttempt.attemptId,
      fence: catalogAttempt.fence,
      payload: authored.checks.discover.value,
    });

    const [ready] = journal.queryReadyWork();
    expect(ready).toBeDefined();
    const execution = journal.getGeneratedExecution(ready.nodeGenerationId);
    expect(Object.keys(execution.claims)).toEqual(['component']);
    expect(execution.claims.component.claim).toBe('component.work_item@1');
    expect(execution.claims.component.payload.authority.claim).toBe('proof.component_role_authority@1');

    const generatedAttempt = journal.startGeneratedAttempt(ready.nodeGenerationId);
    journal.scheduleGeneratedAttempt({
      nodeGenerationId: generatedAttempt.nodeGenerationId,
      attemptId: generatedAttempt.attemptId,
      fence: generatedAttempt.fence,
    });
    const binding = journal.deriveManagedRunBinding(generatedAttempt);
    journal.recordManagedRunAcquired(binding);
    journal.recordManagedRunStarted(binding);
    const preview = {
      source: 'probe-host-tools-call' as const,
      tool: 'codex' as const,
      promptDigest: `sha256:${'e'.repeat(64)}`,
      promptBytes: 13,
    };
    let captured: any;
    const provider = createGovernedProofInspectProviderForFocusedTest((request: any) => {
      captured = request;
      return {
        preview: () => preview,
        answer: () => {
          const data = { componentId: request.context.component.payload.component_id, decision: 'accept' };
          const dataJson = canonicalJson(data);
          return {
            data,
            runtimeAttestation: {
              version: 'probe.governed-codex-attestation/v2', profileId: 'luna-xhigh-readonly-v1',
              requested: { profileDigest: 'a'.repeat(64), cwdDigest: 'a'.repeat(64), probeToolsDigest: 'a'.repeat(64), model: 'gpt-5.6-luna', reasoningEffort: 'xhigh', sandbox: 'read-only', approvalPolicy: 'never' },
              observed: { source: 'session_configured', model: 'gpt-5.6-luna', modelProviderId: 'openai', reasoningEffort: 'xhigh', approvalPolicy: 'never', cwdDigest: 'a'.repeat(64), permissionProfileDigest: 'a'.repeat(64), filesystem: 'restricted-read-root', network: 'restricted' },
              executionContext: { source: 'caller', invocationDigest: request.invocationDigest },
              dispatch: preview,
              evidence: { eventCount: 1 }, usage: { status: 'unavailable' },
            },
            resultIdentity: {
              version: 'probe.governed-result-identity/v1', source: 'probe-host-schema-valid-json',
              resultDigest: governedResultDigest(data), canonicalBytes: Buffer.byteLength(dataJson),
            },
          };
        },
        cancel: () => undefined,
        close: () => undefined,
      };
    });
    const run = provider.startManaged({
      prInfo: {},
      checkConfig: execution.node.check,
      dependencyResults: new Map(),
      executionContext: { claims: execution.claims },
      binding,
      executionConfigDigest: execution.node.executionConfigDigest,
      workingDirectory: process.cwd(),
    });
    const outcome: any = await run.outcome;
    expect(captured.context.component.payload.component_id).toBe('http-adapter');
    expect(captured.context.authority.claim).toBe('proof.component_role_authority@1');
    await run.close();
    journal.completeManagedGeneratedAttempt({
      attempt: generatedAttempt,
      binding,
      payload: outcome.summary.output,
      executionConfigDigest: execution.node.executionConfigDigest,
      proofCandidateEvidence: outcome.proofCandidateEvidence,
    });
    expect(journal.queryReadyWork().map(value => value.templateNodeKey)).toEqual(['proof_admit']);
    expect(journal.getInstanceProjection()).toEqual(journal.replayInstanceProjection());
  });
});
