import { describe, expect, it } from '@jest/globals';
import { sha256Canonical } from '../../../../src/state-machine/graph/claim-kernel';
import {
  createInitialInstanceProjection,
  deriveProofProjectReconciliationParentClaimIds,
  InstanceKernelError,
  reduceInstanceEvent,
  type GeneratedClaimPublishedEvent,
  type InstanceClaimProjection,
  type InstanceProjection,
  type KeyedScopePath,
  type NodeGenerationProjection,
  type NodeInstanceProjection,
  type SubgraphInstanceProjection,
} from '../../../../src/state-machine/graph/instance-kernel';
import {
  PROOF_ADMITTED_RECEIPT_CLAIM,
  PROOF_CANDIDATE_CLAIM,
  PROOF_CATALOG_REVALIDATION_CLAIM,
  PROOF_COMPONENT_SPEC_REVIEW_ADMITTED_RECEIPT_CLAIM,
  PROOF_COMPONENT_SPEC_REVIEW_CANDIDATE_CLAIM,
  PROOF_PROJECT_RECONCILIATION_RECEIPT_CLAIM,
} from '../../../../src/state-machine/graph/instance-plan';
import {
  PROOF_ADMISSION_WIRE_FIELD,
  proofComponentCandidateEnvelopeJson,
} from '../../../../src/providers/proof-admission-cli-child';

const sessionId = 'project-reconciliation-test';
const id = (label: string): string => sha256Canonical({ label });

function generatedClaim(input: {
  claimId: string;
  claim: string;
  producerCheckId: string;
  subgraphInstanceId: string;
  scope: KeyedScopePath;
  generation: NodeGenerationProjection;
  parentClaimIds: readonly string[];
}): InstanceClaimProjection {
  return {
    claimId: input.claimId,
    claim: input.claim,
    payload: { id: input.claimId },
    payloadFingerprint: sha256Canonical({ id: input.claimId }),
    producerCheckId: input.producerCheckId,
    producerAttemptId: input.generation.attemptId,
    producerFence: input.generation.fence,
    parentClaimIds: input.parentClaimIds,
    wireMode: 'generic',
    scope: input.scope,
    active: true,
    kind: 'generated-output',
    subgraphInstanceId: input.subgraphInstanceId,
    incarnation: input.generation.incarnation,
    nodeGenerationId: input.generation.nodeGenerationId,
  };
}

function completedGeneration(input: {
  label: string;
  checkId: string;
  subgraphInstanceId: string;
  scope: KeyedScopePath;
  activeInputClaimIds: readonly string[];
  completedOutputClaimIds?: readonly string[];
}): NodeGenerationProjection {
  return {
    nodeGenerationId: id(`${input.label}-generation`),
    nodeInstanceId: id(`${input.label}-node`),
    subgraphInstanceId: input.subgraphInstanceId,
    templateNodeKey: input.checkId,
    checkId: input.checkId,
    scope: input.scope,
    incarnation: 1,
    itemFingerprint: id(`${input.label}-item`),
    executionConfigDigest: id(`${input.label}-config`),
    activeInputClaimIds: input.activeInputClaimIds,
    status: 'completed',
    attemptId: id(`${input.label}-attempt`),
    fence: 1,
    scheduled: true,
    completedOutputClaimIds: input.completedOutputClaimIds || [],
  };
}

function fixture(reverseRecords = false): {
  projection: InstanceProjection;
  generation: NodeGenerationProjection;
  parentClaimIds: readonly string[];
} {
  const projectId = id('project-instance');
  const projectScope: KeyedScopePath = [{
    kind: 'keyed',
    expansionOwnerCheck: 'discover',
    key: 'project',
    subgraphInstanceId: projectId,
  }];
  const revalidationId = id('revalidation-claim');
  const catalogId = id('catalog-claim');
  const revalidation = completedGeneration({
    label: 'revalidation',
    checkId: 'revalidate_catalog',
    subgraphInstanceId: projectId,
    scope: projectScope,
    activeInputClaimIds: [],
    completedOutputClaimIds: [revalidationId],
  });
  const materialize = completedGeneration({
    label: 'materialize',
    checkId: 'materialize_catalog',
    subgraphInstanceId: projectId,
    scope: projectScope,
    activeInputClaimIds: [revalidationId],
    completedOutputClaimIds: [catalogId],
  });
  const reconciliation: NodeGenerationProjection = {
    nodeGenerationId: id('reconciliation-generation'),
    nodeInstanceId: id('reconciliation-node'),
    subgraphInstanceId: projectId,
    templateNodeKey: 'project_reconcile',
    checkId: 'project_reconcile',
    scope: projectScope,
    incarnation: 1,
    itemFingerprint: id('project-item'),
    executionConfigDigest: id('reconciliation-config'),
    activeInputClaimIds: [],
    expansionBarrierDigest: id('barrier'),
    status: 'running',
    attemptId: id('reconciliation-attempt'),
    fence: 1,
    scheduled: true,
    completedOutputClaimIds: [],
  };

  const claims: Record<string, InstanceClaimProjection> = {};
  const generations: Record<string, NodeGenerationProjection> = {
    [revalidation.nodeGenerationId]: revalidation,
    [materialize.nodeGenerationId]: materialize,
    [reconciliation.nodeGenerationId]: reconciliation,
  };
  const nodes: Record<string, NodeInstanceProjection> = Object.fromEntries(
    [revalidation, materialize, reconciliation].map(generation => [generation.nodeInstanceId, {
      nodeInstanceId: generation.nodeInstanceId,
      subgraphInstanceId: projectId,
      templateNodeKey: generation.templateNodeKey,
      scope: projectScope,
    }])
  );
  const activeGenerations: Record<string, string> = {
    [revalidation.nodeInstanceId]: revalidation.nodeGenerationId,
    [materialize.nodeInstanceId]: materialize.nodeGenerationId,
    [reconciliation.nodeInstanceId]: reconciliation.nodeGenerationId,
  };
  claims[revalidationId] = generatedClaim({
    claimId: revalidationId,
    claim: PROOF_CATALOG_REVALIDATION_CLAIM,
    producerCheckId: 'revalidate_catalog',
    subgraphInstanceId: projectId,
    scope: projectScope,
    generation: revalidation,
    parentClaimIds: [],
  });
  claims[catalogId] = generatedClaim({
    claimId: catalogId,
    claim: 'component.catalog@1',
    producerCheckId: 'materialize_catalog',
    subgraphInstanceId: projectId,
    scope: projectScope,
    generation: materialize,
    parentClaimIds: [revalidationId],
  });

  const project: SubgraphInstanceProjection = {
    sessionId,
    expansionOwnerCheck: 'discover',
    graphSemanticDigest: id('graph'),
    expansionSpecDigest: id('project-expansion'),
    templateDigest: id('project-template'),
    itemKey: 'project',
    subgraphInstanceId: projectId,
    scope: projectScope,
    catalogClaimId: id('root-catalog'),
    nodeInstanceIdsByTemplateNode: {
      revalidate_catalog: revalidation.nodeInstanceId,
      materialize_catalog: materialize.nodeInstanceId,
      project_reconcile: reconciliation.nodeInstanceId,
    },
    status: 'active',
    incarnation: 1,
  };
  const instances: Record<string, SubgraphInstanceProjection> = { [projectId]: project };
  const admissionIds: string[] = [];

  for (const component of ['alpha', 'βeta']) {
    const childId = id(`${component}-instance`);
    const childScope: KeyedScopePath = [projectScope[0], {
      kind: 'keyed',
      expansionOwnerCheck: 'materialize_catalog',
      key: component,
      subgraphInstanceId: childId,
    }];
    const itemId = id(`${component}-item-claim`);
    const candidateId = id(`${component}-candidate-claim`);
    const admissionId = id(`${component}-admission-claim`);
    admissionIds.push(admissionId);
    const inspect = completedGeneration({
      label: `${component}-inspect`,
      checkId: 'inspect',
      subgraphInstanceId: childId,
      scope: childScope,
      activeInputClaimIds: [itemId],
      completedOutputClaimIds: [candidateId],
    });
    const admission = completedGeneration({
      label: `${component}-admission`,
      checkId: 'proof_admit',
      subgraphInstanceId: childId,
      scope: childScope,
      activeInputClaimIds: [candidateId],
      completedOutputClaimIds: [admissionId],
    });
    const verify = completedGeneration({
      label: `${component}-verify`,
      checkId: 'verify',
      subgraphInstanceId: childId,
      scope: childScope,
      activeInputClaimIds: [candidateId, admissionId].sort(),
    });
    for (const generation of [inspect, admission, verify]) {
      generations[generation.nodeGenerationId] = generation;
      activeGenerations[generation.nodeInstanceId] = generation.nodeGenerationId;
      nodes[generation.nodeInstanceId] = {
        nodeInstanceId: generation.nodeInstanceId,
        subgraphInstanceId: childId,
        templateNodeKey: generation.templateNodeKey,
        scope: childScope,
      };
    }
    claims[itemId] = {
      claimId: itemId,
      claim: 'component.work_item@1',
      payload: { component },
      payloadFingerprint: id(`${component}-item`),
      producerCheckId: 'materialize_catalog',
      controllerCatalogClaimId: catalogId,
      parentClaimIds: [catalogId],
      wireMode: 'proof',
      scope: childScope,
      active: true,
      kind: 'controller-item',
      subgraphInstanceId: childId,
      incarnation: 1,
    };
    claims[candidateId] = generatedClaim({
      claimId: candidateId,
      claim: PROOF_CANDIDATE_CLAIM,
      producerCheckId: 'inspect',
      subgraphInstanceId: childId,
      scope: childScope,
      generation: inspect,
      parentClaimIds: [itemId],
    });
    claims[admissionId] = generatedClaim({
      claimId: admissionId,
      claim: PROOF_ADMITTED_RECEIPT_CLAIM,
      producerCheckId: 'proof_admit',
      subgraphInstanceId: childId,
      scope: childScope,
      generation: admission,
      parentClaimIds: [candidateId],
    });
    instances[childId] = {
      sessionId,
      expansionOwnerCheck: 'materialize_catalog',
      graphSemanticDigest: id('graph'),
      expansionSpecDigest: id('component-expansion'),
      templateDigest: id('component-template'),
      itemKey: component,
      subgraphInstanceId: childId,
      scope: childScope,
      catalogClaimId: catalogId,
      parentSubgraphInstanceId: projectId,
      expansionOwnerNodeInstanceId: materialize.nodeInstanceId,
      catalogClaimRef: 'component.catalog@1',
      catalogProducerNodeGenerationId: materialize.nodeGenerationId,
      nodeInstanceIdsByTemplateNode: {
        inspect: inspect.nodeInstanceId,
        proof_admit: admission.nodeInstanceId,
        verify: verify.nodeInstanceId,
      },
      status: 'active',
      incarnation: 1,
      activeItemClaimId: itemId,
    };
  }

  const maybeReverse = <T>(record: Record<string, T>): Record<string, T> =>
    reverseRecords ? Object.fromEntries(Object.entries(record).reverse()) : record;
  const initial = createInitialInstanceProjection();
  const projection = {
    ...initial,
    lastEventId: 10,
    instancesById: maybeReverse(instances),
    nodesById: maybeReverse(nodes),
    generationsById: maybeReverse(generations),
    activeGenerationIdByNode: maybeReverse(activeGenerations),
    claimsById: maybeReverse(claims),
    attemptBindingsById: {
      [reconciliation.attemptId!]: reconciliation.nodeGenerationId,
    },
    managedRunsByAttemptId: {
      [reconciliation.attemptId!]: {
        binding: {
          managedRunId: id('reconciliation-managed-run'),
          sessionId,
          checkId: reconciliation.checkId,
          scope: reconciliation.scope,
          nodeInstanceId: reconciliation.nodeInstanceId,
          nodeGenerationId: reconciliation.nodeGenerationId,
          attemptId: reconciliation.attemptId!,
          fence: reconciliation.fence!,
        },
        status: 'terminated',
        cleanupStatus: 'clean',
        controllerDecision: 'completed',
      },
    },
  } as InstanceProjection;
  const parentClaimIds = [revalidationId, ...admissionIds]
    .sort((left, right) => Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8')));
  return { projection, generation: reconciliation, parentClaimIds };
}

function stagedFixture(reverseRecords = false): {
  projection: InstanceProjection;
  generation: NodeGenerationProjection;
  parentClaimIds: readonly string[];
  stageCandidateIds: readonly string[];
  stageAdmissionIds: readonly string[];
} {
  const base = fixture(reverseRecords);
  const projectId = base.generation.subgraphInstanceId;
  const projection = {
    ...base.projection,
    instancesById: { ...base.projection.instancesById },
    nodesById: { ...base.projection.nodesById },
    generationsById: { ...base.projection.generationsById },
    activeGenerationIdByNode: { ...base.projection.activeGenerationIdByNode },
    claimsById: { ...base.projection.claimsById },
  } as InstanceProjection;
  const writable = projection as any;
  const stageCandidateIds: string[] = [];
  const stageAdmissionIds: string[] = [];

  for (const child of Object.values(base.projection.instancesById).filter(instance =>
    instance.parentSubgraphInstanceId === projectId)) {
    const itemId = child.activeItemClaimId!;
    const inspectGenerationId = writable.activeGenerationIdByNode[child.nodeInstanceIdsByTemplateNode.inspect!];
    const admissionGenerationId = writable.activeGenerationIdByNode[child.nodeInstanceIdsByTemplateNode.proof_admit!];
    const verifyGenerationId = writable.activeGenerationIdByNode[child.nodeInstanceIdsByTemplateNode.verify!];
    const inspect = writable.generationsById[inspectGenerationId];
    const admission = writable.generationsById[admissionGenerationId];
    const verify = writable.generationsById[verifyGenerationId];
    if (!inspect || !admission || !verify) throw new Error(`staged fixture missing legacy nodes for ${child.itemKey}`);
    const candidateId = inspect.completedOutputClaimIds[0];
    const admissionId = admission.completedOutputClaimIds[0];
    const stageCandidateId = id(`${child.itemKey}-stage-candidate-claim`);
    const stageAdmissionId = id(`${child.itemKey}-stage-admission-claim`);
    const priorCandidate = writable.claimsById[candidateId];
    const priorAdmission = writable.claimsById[admissionId];
    const priorCandidateWire = proofComponentCandidateEnvelopeJson({
      Publication: {
        ClaimID: candidateId,
        Claim: priorCandidate.claim,
        PayloadFingerprint: priorCandidate.payloadFingerprint,
        ParentClaimIDs: priorCandidate.parentClaimIds,
      },
    });
    const priorAdmissionWire = '{"status":"ADMITTED"}';
    writable.claimsById[admissionId] = {
      ...priorAdmission,
      payload: { ...(priorAdmission.payload as Record<string, unknown>), [PROOF_ADMISSION_WIRE_FIELD]: priorAdmissionWire },
    };
    const stageContext = {
      version: 'proof.onboarding-stage-context/v1',
      stage_id: 'spec_review',
      prior_candidate: priorCandidateWire,
      prior_admission: priorAdmissionWire,
      prior_admission_claim_id: admissionId,
      prior_admission_payload_fingerprint: priorAdmission.payloadFingerprint,
    };
    const stageCandidate = completedGeneration({
      label: `${child.itemKey}-spec-review`,
      checkId: 'spec_review',
      subgraphInstanceId: child.subgraphInstanceId,
      scope: child.scope,
      activeInputClaimIds: [itemId, candidateId, admissionId].sort(),
      completedOutputClaimIds: [stageCandidateId],
    });
    const stageAdmission = completedGeneration({
      label: `${child.itemKey}-spec-review-admit`,
      checkId: 'spec_review_admit',
      subgraphInstanceId: child.subgraphInstanceId,
      scope: child.scope,
      activeInputClaimIds: [stageCandidateId],
      completedOutputClaimIds: [stageAdmissionId],
    });
    const stageEvidence = {
      role: {
        invocation: {
          role_id: 'spec-review',
          stance: 'owner',
          onboarding_stage: stageContext,
        },
        invocationDigest: id(`${child.itemKey}-spec-review-invocation`),
      },
    };
    const stageCandidateParents = [itemId, candidateId, admissionId].sort((left, right) =>
      Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8')));
    writable.generationsById[stageCandidate.nodeGenerationId] = stageCandidate;
    writable.generationsById[stageAdmission.nodeGenerationId] = stageAdmission;
    writable.generationsById[verify.nodeGenerationId] = {
      ...verify,
      activeInputClaimIds: [candidateId, admissionId, stageCandidateId, stageAdmissionId].sort(),
    };
    for (const generation of [stageCandidate, stageAdmission]) {
      writable.nodesById[generation.nodeInstanceId] = {
        nodeInstanceId: generation.nodeInstanceId,
        subgraphInstanceId: child.subgraphInstanceId,
        templateNodeKey: generation.templateNodeKey,
        scope: child.scope,
      };
      writable.activeGenerationIdByNode[generation.nodeInstanceId] = generation.nodeGenerationId;
    }
    writable.instancesById[child.subgraphInstanceId] = {
      ...child,
      nodeInstanceIdsByTemplateNode: {
        ...child.nodeInstanceIdsByTemplateNode,
        spec_review: stageCandidate.nodeInstanceId,
        spec_review_admit: stageAdmission.nodeInstanceId,
      },
    };
    writable.claimsById[stageCandidateId] = {
      ...generatedClaim({
      claimId: stageCandidateId,
      claim: PROOF_COMPONENT_SPEC_REVIEW_CANDIDATE_CLAIM,
      producerCheckId: 'spec_review',
      subgraphInstanceId: child.subgraphInstanceId,
      scope: child.scope,
      generation: stageCandidate,
      parentClaimIds: stageCandidateParents,
      }),
      proofCandidateEvidence: stageEvidence,
    } as any;
    writable.claimsById[stageAdmissionId] = generatedClaim({
      claimId: stageAdmissionId,
      claim: PROOF_COMPONENT_SPEC_REVIEW_ADMITTED_RECEIPT_CLAIM,
      producerCheckId: 'spec_review_admit',
      subgraphInstanceId: child.subgraphInstanceId,
      scope: child.scope,
      generation: stageAdmission,
      parentClaimIds: [stageCandidateId],
    });
    stageCandidateIds.push(stageCandidateId);
    stageAdmissionIds.push(stageAdmissionId);
  }

  const revalidationId = Object.values(base.projection.claimsById).find(claim =>
    claim.claim === PROOF_CATALOG_REVALIDATION_CLAIM)!.claimId;
  const parentClaimIds = [
    revalidationId,
    ...stageAdmissionIds,
  ].sort((left, right) => Buffer.from(left, 'utf8').compare(Buffer.from(right, 'utf8')));
  return {
    projection,
    generation: base.generation,
    parentClaimIds,
    stageCandidateIds,
    stageAdmissionIds,
  };
}

function publication(
  projection: InstanceProjection,
  generation: NodeGenerationProjection,
  claim: string,
  parentClaimIds: readonly string[],
): GeneratedClaimPublishedEvent {
  const payload = { reconciled: true };
  const payloadFingerprint = sha256Canonical(payload);
  return {
    version: 1,
    type: 'ClaimPublished',
    eventId: projection.lastEventId + 1,
    sessionId,
    scope: generation.scope,
    checkId: generation.checkId,
    attemptId: generation.attemptId!,
    fence: generation.fence!,
    nodeInstanceId: generation.nodeInstanceId,
    nodeGenerationId: generation.nodeGenerationId,
    claimId: sha256Canonical({
      claim,
      payloadFingerprint,
      producerCheckId: generation.checkId,
      scope: generation.scope,
      attemptId: generation.attemptId,
      fence: generation.fence,
      parentClaimIds: [...parentClaimIds].sort(),
    }),
    claim,
    payload,
    payloadFingerprint,
    producerCheckId: generation.checkId,
    parentClaimIds,
    wireMode: claim === PROOF_PROJECT_RECONCILIATION_RECEIPT_CLAIM ? 'proof' : 'generic',
  };
}

function expectKernelCode(run: () => unknown, code: string): void {
  try {
    run();
    throw new Error(`Expected InstanceKernelError ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(InstanceKernelError);
    expect((error as InstanceKernelError).code).toBe(code);
  }
}

function expectInvalid(run: () => unknown): void {
  expectKernelCode(run, 'INVALID_PARENT_CLAIMS');
}

describe('project reconciliation dynamic parents', () => {
  it('derives the UTF-8 sorted revalidation and child admission set independent of record order', () => {
    const normal = fixture();
    const reversed = fixture(true);
    const normalParents = deriveProofProjectReconciliationParentClaimIds(normal.projection, normal.generation);
    const reversedParents = deriveProofProjectReconciliationParentClaimIds(reversed.projection, reversed.generation);
    expect(normalParents).toEqual(normal.parentClaimIds);
    expect(reversedParents).toEqual(normal.parentClaimIds);
    expect(JSON.stringify(reversedParents)).toBe(JSON.stringify(normalParents));
  });

  it('derives staged reconciliation parents from revalidation and terminal stage admissions', () => {
    const normal = stagedFixture();
    const reversed = stagedFixture(true);
    const normalParents = deriveProofProjectReconciliationParentClaimIds(normal.projection, normal.generation);
    const reversedParents = deriveProofProjectReconciliationParentClaimIds(reversed.projection, reversed.generation);
    expect(normalParents).toEqual(normal.parentClaimIds);
    expect(reversedParents).toEqual(normal.parentClaimIds);
    expect(JSON.stringify(reversedParents)).toBe(JSON.stringify(normalParents));
    expect(normalParents).toEqual(expect.arrayContaining(normal.stageAdmissionIds));
    expect(normalParents).not.toEqual(expect.arrayContaining(
      normal.stageCandidateIds,
    ));
    expect(normal.stageAdmissionIds.every(claimId =>
      normal.projection.claimsById[claimId].claim === PROOF_COMPONENT_SPEC_REVIEW_ADMITTED_RECEIPT_CLAIM,
    )).toBe(true);
    for (const child of Object.values(normal.projection.instancesById).filter(instance =>
      instance.parentSubgraphInstanceId === normal.generation.subgraphInstanceId)) {
      const verify = normal.projection.generationsById[
        normal.projection.activeGenerationIdByNode[child.nodeInstanceIdsByTemplateNode.verify!]
      ];
      expect(verify.activeInputClaimIds).toHaveLength(4);
      expect(verify.activeInputClaimIds).toEqual(expect.arrayContaining([
        child.nodeInstanceIdsByTemplateNode.spec_review &&
          normal.projection.generationsById[normal.projection.activeGenerationIdByNode[child.nodeInstanceIdsByTemplateNode.spec_review]].completedOutputClaimIds[0],
        child.nodeInstanceIdsByTemplateNode.spec_review_admit &&
          normal.projection.generationsById[normal.projection.activeGenerationIdByNode[child.nodeInstanceIdsByTemplateNode.spec_review_admit]].completedOutputClaimIds[0],
      ]));
    }
  });

  it.each<{
    name: string;
    mutate: (value: ReturnType<typeof stagedFixture>) => void;
  }>([
    {
      name: 'missing stage admission',
      mutate: value => {
        delete (value.projection as any).claimsById[value.stageAdmissionIds[0]];
      },
    },
    {
      name: 'extra stage admission',
      mutate: value => {
        const source = value.projection.claimsById[value.stageAdmissionIds[0]];
        const extraId = id('extra-stage-admission');
        (value.projection as any).claimsById[extraId] = { ...source, claimId: extraId };
      },
    },
    {
      name: 'duplicate verify parent',
      mutate: value => {
        const child = Object.values(value.projection.instancesById).find(instance =>
          instance.parentSubgraphInstanceId === value.generation.subgraphInstanceId)!;
        const verify = value.projection.generationsById[
          value.projection.activeGenerationIdByNode[child.nodeInstanceIdsByTemplateNode.verify!]
        ];
        (value.projection as any).generationsById[verify.nodeGenerationId] = {
          ...verify,
          activeInputClaimIds: [...verify.activeInputClaimIds, verify.activeInputClaimIds[3]],
        };
      },
    },
    {
      name: 'cross-wired stage admission',
      mutate: value => {
        const source = value.projection.claimsById[value.stageAdmissionIds[0]];
        (value.projection as any).claimsById[value.stageAdmissionIds[0]] = {
          ...source,
          parentClaimIds: [value.stageCandidateIds[1]],
        };
      },
    },
  ])('rejects staged reconciliation parent corruption: $name', ({ mutate }) => {
    const value = stagedFixture();
    mutate(value);
    expectInvalid(() => deriveProofProjectReconciliationParentClaimIds(value.projection, value.generation));
  });

  it('admits only the exact reconciliation receipt publication with dynamic parents', () => {
    const value = fixture();
    const event = publication(
      value.projection,
      value.generation,
      PROOF_PROJECT_RECONCILIATION_RECEIPT_CLAIM,
      value.parentClaimIds,
    );
    const next = reduceInstanceEvent(value.projection, event);
    expect(next.claimsById[event.claimId].parentClaimIds).toEqual(value.parentClaimIds);

    expectKernelCode(() => reduceInstanceEvent(value.projection, {
      ...event,
      wireMode: 'generic',
    }), 'INVALID_WIRE_MODE');

    expectKernelCode(() => reduceInstanceEvent({
      ...value.projection,
      managedRunsByAttemptId: {},
    } as InstanceProjection, event), 'MANAGED_TERMINAL_REQUIRED');

    expectInvalid(() => reduceInstanceEvent(
      value.projection,
      publication(value.projection, value.generation, 'ordinary.result@1', value.parentClaimIds),
    ));

    const ordinaryGeneration: NodeGenerationProjection = {
      ...value.generation,
      templateNodeKey: 'ordinary',
      checkId: 'ordinary',
    };
    const ordinaryProjection = {
      ...value.projection,
      generationsById: {
        ...value.projection.generationsById,
        [ordinaryGeneration.nodeGenerationId]: ordinaryGeneration,
      },
      nodesById: {
        ...value.projection.nodesById,
        [ordinaryGeneration.nodeInstanceId]: {
          ...value.projection.nodesById[ordinaryGeneration.nodeInstanceId],
          templateNodeKey: 'ordinary',
        },
      },
      managedRunsByAttemptId: {},
    } as InstanceProjection;
    expectKernelCode(() => reduceInstanceEvent(
      ordinaryProjection,
      publication(
        ordinaryProjection,
        ordinaryGeneration,
        PROOF_PROJECT_RECONCILIATION_RECEIPT_CLAIM,
        [],
      ),
    ), 'INVALID_GENERATION_BINDING');
  });

  it('fails closed for omitted, foreign, and nonterminal child authority', () => {
    const omitted = fixture();
    const omittedAdmission = omitted.parentClaimIds.find(claimId =>
      omitted.projection.claimsById[claimId]?.claim === PROOF_ADMITTED_RECEIPT_CLAIM)!;
    const omittedProjection = {
      ...omitted.projection,
      claimsById: Object.fromEntries(Object.entries(omitted.projection.claimsById)
        .filter(([claimId]) => claimId !== omittedAdmission)),
    } as InstanceProjection;
    expectInvalid(() => deriveProofProjectReconciliationParentClaimIds(omittedProjection, omitted.generation));

    const foreign = fixture();
    const foreignAdmission = foreign.parentClaimIds.find(claimId =>
      foreign.projection.claimsById[claimId]?.claim === PROOF_ADMITTED_RECEIPT_CLAIM)!;
    const foreignProjection = {
      ...foreign.projection,
      claimsById: {
        ...foreign.projection.claimsById,
        [foreignAdmission]: {
          ...foreign.projection.claimsById[foreignAdmission],
          subgraphInstanceId: id('foreign-instance'),
        },
      },
    } as InstanceProjection;
    expectInvalid(() => deriveProofProjectReconciliationParentClaimIds(foreignProjection, foreign.generation));

    const nonterminal = fixture();
    const verify = Object.values(nonterminal.projection.generationsById)
      .find(generation => generation.checkId === 'verify')!;
    const nonterminalProjection = {
      ...nonterminal.projection,
      generationsById: {
        ...nonterminal.projection.generationsById,
        [verify.nodeGenerationId]: { ...verify, status: 'running' },
      },
    } as InstanceProjection;
    expectInvalid(() => deriveProofProjectReconciliationParentClaimIds(nonterminalProjection, nonterminal.generation));
  });
});
