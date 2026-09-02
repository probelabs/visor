import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as yaml from 'js-yaml';
import { ExecutionJournal } from '../../src/snapshot-store';
import { compileClaimPlan } from '../../src/state-machine/graph/claim-plan';
import {
  canonicalJson,
  immutableCanonicalValue,
  sha256Canonical,
} from '../../src/state-machine/graph/claim-kernel';
import {
  governedResultDigest,
  type ProofCandidateEvidenceV1,
} from '../../src/providers/governed-proof-inspect-check-provider';
import { ProofAdmittedCatalogCheckProvider } from '../../src/providers/proof-admitted-catalog-check-provider';
import {
  PROOF_ADMITTED_RECEIPT_CLAIM,
} from '../../src/state-machine/graph/instance-plan';

const PROFILE = resolve(__dirname, '../../examples/agent-governance/exp-0209-discovery-egress/visor.yaml');

function discoveryEvidence(execution: any, payload: unknown): ProofCandidateEvidenceV1 {
  const payloadBytes = Buffer.from(canonicalJson(payload), 'utf8');
  const preview = {
    source: 'probe-host-tools-call' as const,
    tool: 'codex' as const,
    promptDigest: `sha256:${'e'.repeat(64)}`,
    promptBytes: 17,
  };
  const invocation = execution.node.check.invocation;
  return immutableCanonicalValue({
    version: 'visor.proof-candidate-evidence/v1',
    role: { invocation, invocationDigest: execution.node.check.invocation_digest },
    probe: {
      attestation: {
        version: 'probe.governed-codex-attestation/v2',
        profileId: 'luna-xhigh-readonly-v1',
        requested: {
          profileDigest: 'a'.repeat(64),
          cwdDigest: 'a'.repeat(64),
          probeToolsDigest: 'a'.repeat(64),
          model: 'gpt-5.6-luna',
          reasoningEffort: 'xhigh',
          sandbox: 'read-only',
          approvalPolicy: 'never',
        },
        observed: {
          source: 'session_configured',
          model: 'gpt-5.6-luna',
          modelProviderId: 'openai',
          reasoningEffort: 'xhigh',
          approvalPolicy: 'never',
          cwdDigest: 'a'.repeat(64),
          permissionProfileDigest: 'a'.repeat(64),
          filesystem: 'restricted-read-root',
          network: 'restricted',
        },
        executionContext: { source: 'caller', invocationDigest: execution.node.check.invocation_digest },
        dispatch: preview,
        evidence: { eventCount: 1 },
        usage: { status: 'unavailable' },
      },
      resultIdentity: {
        version: 'probe.governed-result-identity/v1',
        source: 'probe-host-schema-valid-json',
        resultDigest: governedResultDigest(payload),
        canonicalBytes: payloadBytes.length,
      },
    },
  });
}

function workItem(componentId: string, projectId = 'journalservice') {
  const authorityPayload = {
    componentId,
    roleId: 'onboard',
    subjectFingerprint: `sha256:${'1'.repeat(64)}`,
  };
  return {
    project_id: projectId,
    component_id: componentId,
    sorted_owned_paths: [`${componentId}.go`],
    sorted_dependency_closure: [`${componentId}.go`],
    proof_path_mapping: [],
    proof_input_state: [],
    proof_component_subject: {
      kind: 'component',
      id: componentId,
      fingerprint: `sha256:${'2'.repeat(64)}`,
    },
    authority: {
      claimId: '3'.repeat(64),
      claim: 'proof.component_role_authority@1',
      payloadFingerprint: sha256Canonical(authorityPayload),
      payload: authorityPayload,
    },
  };
}

describe('EXP-0209 admitted discovery egress', () => {
  it('admits project discovery before fanout and advances discovered keys independently', async () => {
    const config: any = yaml.load(readFileSync(PROFILE, 'utf8'));
    const plan = compileClaimPlan(config);
    const journal = new ExecutionJournal(plan);
    const sessionId = 'exp-0209-discovery-egress';

    // The only authored root input is the manually selected project.  The
    // component catalog is produced by the governed discovery subgraph.
    const request = journal.requestCatalogReconciliation({ sessionId, ownerCheck: 'project' });
    const projectAttempt = journal.startCatalogRequestAttempt(request.requestId);
    journal.scheduleCatalogRequestAttempt({
      requestId: request.requestId,
      attemptId: projectAttempt.attemptId,
      fence: projectAttempt.fence,
    });
    journal.completeAttempt({
      sessionId,
      checkId: 'project',
      scope: [],
      attemptId: projectAttempt.attemptId,
      fence: projectAttempt.fence,
      payload: config.checks.project.value,
    });

    const projectInspect = journal.queryReadyWork().find(value => value.templateNodeKey === 'inspect');
    expect(projectInspect).toBeDefined();
    const discoveryExecution = journal.getGeneratedExecution(projectInspect!.nodeGenerationId);
    const candidatePayload = {
      components: [
        { component_id: 'alpha', responsibility: 'alpha domain' },
        { component_id: 'beta', responsibility: 'beta domain' },
        { component_id: 'gamma', responsibility: 'gamma domain' },
      ],
    };
    const discoveryAttempt = journal.startGeneratedAttempt(projectInspect!.nodeGenerationId);
    journal.scheduleGeneratedAttempt({
      nodeGenerationId: discoveryAttempt.nodeGenerationId,
      attemptId: discoveryAttempt.attemptId,
      fence: discoveryAttempt.fence,
    });
    const discoveryBinding = journal.deriveManagedRunBinding(discoveryAttempt);
    journal.recordManagedRunAcquired(discoveryBinding);
    journal.recordManagedRunStarted(discoveryBinding);
    journal.completeManagedGeneratedAttempt({
      attempt: discoveryAttempt,
      binding: discoveryBinding,
      payload: candidatePayload,
      executionConfigDigest: discoveryExecution.node.executionConfigDigest,
      proofCandidateEvidence: discoveryEvidence(discoveryExecution, candidatePayload),
    });

    const admissionGeneration = journal.queryReadyWork().find(value => value.templateNodeKey === 'proof_admit');
    expect(admissionGeneration).toBeDefined();
    const admissionExecution = journal.getGeneratedExecution(admissionGeneration!.nodeGenerationId);
    const candidate = admissionExecution.claims.candidate;
    const admissionAttempt = journal.startGeneratedAttempt(admissionGeneration!.nodeGenerationId);
    journal.scheduleGeneratedAttempt({
      nodeGenerationId: admissionAttempt.nodeGenerationId,
      attemptId: admissionAttempt.attemptId,
      fence: admissionAttempt.fence,
    });
    const admissionBinding = journal.deriveManagedRunBinding(admissionAttempt);
    journal.recordManagedRunAcquired(admissionBinding);
    journal.recordManagedRunStarted(admissionBinding);
    journal.completeManagedGeneratedAttempt({
      attempt: admissionAttempt,
      binding: admissionBinding,
      payload: {
        Status: 'ADMITTED',
        ClaimID: candidate.claimId,
        Claim: candidate.claim,
        PayloadFingerprint: candidate.payloadFingerprint,
        ProducerCheckID: admissionGeneration!.checkId,
        ParentClaimIDs: candidate.parentClaimIds,
        receipt_id: '4'.repeat(64),
      },
      executionConfigDigest: admissionExecution.node.executionConfigDigest,
    });

    // Admission alone and the no-op verify are not a fanout authority.
    const verifyGeneration = journal.queryReadyWork().find(value => value.templateNodeKey === 'verify');
    expect(verifyGeneration).toBeDefined();
    const beforeAdmissionEgress = journal.getInstanceProjection();
    expect(Object.values(beforeAdmissionEgress.instancesById).filter((value: any) => value.scope.length === 2)).toHaveLength(0);
    const verifyAttempt = journal.startGeneratedAttempt(verifyGeneration!.nodeGenerationId);
    journal.scheduleGeneratedAttempt({
      nodeGenerationId: verifyAttempt.nodeGenerationId,
      attemptId: verifyAttempt.attemptId,
      fence: verifyAttempt.fence,
    });
    journal.completeGeneratedAttempt({ attempt: verifyAttempt, payload: {} });
    expect(Object.values(journal.getInstanceProjection().instancesById).filter((value: any) => value.scope.length === 2)).toHaveLength(0);

    const revalidateGeneration = journal.queryReadyWork().find(value => value.templateNodeKey === 'revalidate_catalog');
    expect(revalidateGeneration).toBeDefined();
    const revalidationExecution = journal.getGeneratedExecution(revalidateGeneration!.nodeGenerationId);
    const revalidationAttempt = journal.startGeneratedAttempt(revalidateGeneration!.nodeGenerationId);
    journal.scheduleGeneratedAttempt({
      nodeGenerationId: revalidationAttempt.nodeGenerationId,
      attemptId: revalidationAttempt.attemptId,
      fence: revalidationAttempt.fence,
    });
    const admissionClaim = revalidationExecution.claims.receipt;
    const revalidationPayload = {
      version: 'proof.catalog-revalidation/v1',
      status: 'ACCEPTED',
      candidate_claim_id: candidate.claimId,
      admission_receipt_claim_id: admissionClaim.claimId,
      candidate_payload_fingerprint: candidate.payloadFingerprint,
      revision_fingerprint: '5'.repeat(64),
      work_items: ['alpha', 'beta', 'gamma'].map(id => workItem(id)),
    };
    journal.completeGeneratedAttempt({ attempt: revalidationAttempt, payload: revalidationPayload });

    const materializeGeneration = journal.queryReadyWork().find(value => value.templateNodeKey === 'materialize_catalog');
    expect(materializeGeneration).toBeDefined();
    const materializeExecution = journal.getGeneratedExecution(materializeGeneration!.nodeGenerationId);
    const materializer = new ProofAdmittedCatalogCheckProvider();
    const materialized = await materializer.execute(
      {} as any,
      materializeExecution.node.check,
      new Map(),
      { claims: materializeExecution.claims },
    ) as any;
    const materializeAttempt = journal.startGeneratedAttempt(materializeGeneration!.nodeGenerationId);
    journal.scheduleGeneratedAttempt({
      nodeGenerationId: materializeAttempt.nodeGenerationId,
      attemptId: materializeAttempt.attemptId,
      fence: materializeAttempt.fence,
    });
    journal.completeGeneratedAttempt({ attempt: materializeAttempt, payload: materialized.output });

    const finalProjection = journal.getInstanceProjection();
    const componentInstances = Object.values(finalProjection.instancesById)
      .filter((value: any) => value.scope.length === 2);
    expect(componentInstances.map((value: any) => value.itemKey).sort()).toEqual(['alpha', 'beta', 'gamma']);
    expect(journal.replayInstanceProjection()).toEqual(finalProjection);

    const componentWork = journal.queryReadyWork().filter(value => value.scope.length === 2);
    expect(componentWork).toHaveLength(3);
    const componentA = componentWork.find(value => value.scope[1].key === 'alpha')!;
    const aAttempt = journal.startGeneratedAttempt(componentA.nodeGenerationId);
    journal.scheduleGeneratedAttempt({
      nodeGenerationId: aAttempt.nodeGenerationId,
      attemptId: aAttempt.attemptId,
      fence: aAttempt.fence,
    });
    journal.completeGeneratedAttempt({ attempt: aAttempt, payload: { component_id: 'alpha' } });
    const remaining = journal.queryReadyWork().filter(value => value.scope.length === 2);
    expect(remaining.map(value => value.scope[1].key).sort()).toEqual(['beta', 'gamma']);

    const events: readonly any[] = journal.readRuntimeEvents() as readonly any[];
    const admissionIndex = events.findIndex(event => event.type === 'ClaimPublished' && event.claim === PROOF_ADMITTED_RECEIPT_CLAIM);
    const revalidationIndex = events.findIndex(event => event.type === 'ClaimPublished' && event.claim === 'proof.catalog_revalidation@1');
    const catalogIndex = events.findIndex(event => event.type === 'ClaimPublished' && event.claim === 'component.catalog@1');
    const fanoutIndex = events.findIndex(event => event.type === 'SubgraphExpanded' && event.scope.length === 2);
    expect(admissionIndex).toBeGreaterThan(-1);
    expect(revalidationIndex).toBeGreaterThan(admissionIndex);
    expect(catalogIndex).toBeGreaterThan(revalidationIndex);
    expect(fanoutIndex).toBeGreaterThan(catalogIndex);
  });
});
