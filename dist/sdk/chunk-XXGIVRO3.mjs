import {
  ClaimKernelError,
  NATIVE_COMPONENT_REVIEWED_CLAIM,
  PROOF_ADMISSION_UNAVAILABLE,
  PROOF_ADMISSION_WIRE_FIELD,
  PROOF_ADMITTED_CATALOG_PROVIDER_TYPE,
  PROOF_ADMITTED_RECEIPT_CLAIM,
  PROOF_ADMIT_NODE_KEY,
  PROOF_CANDIDATE_CLAIM,
  PROOF_CATALOG_REVALIDATION_CLAIM,
  PROOF_CATALOG_REVALIDATION_PROVIDER_TYPE,
  PROOF_COMPONENT_SPEC_REVIEW_ADMITTED_RECEIPT_CLAIM,
  PROOF_COMPONENT_SPEC_REVIEW_CANDIDATE_CLAIM,
  PROOF_ONBOARDING_STAGE_CONTEXT_VERSION,
  PROOF_ONBOARDING_STAGE_MAX_BYTES,
  PROOF_ONBOARDING_STAGE_SPEC_REVIEW,
  PROOF_PROJECT_RECONCILE_NODE_KEY,
  PROOF_PROJECT_RECONCILE_PROVIDER_TYPE,
  PROOF_PROJECT_RECONCILIATION_RECEIPT_CLAIM,
  PROOF_STRUCTURAL_INVENTORY_CLAIM,
  attemptProjectionKey,
  buildClaimPublishedEvent,
  canonicalJson,
  compareProofStrings,
  createInitialClaimProjection,
  exactActiveClaimIds,
  extractProofAdmissionCandidate,
  goCompatibleProofJson,
  governedCanonicalJson,
  governedPayloadFingerprint,
  governedProofCandidateEvidenceJson,
  governedProofComponentReinspectionContextDigest,
  governedResultDigest,
  governedWireModeFromEvidence,
  immutableCanonicalValue,
  immutableGovernedValue,
  immutableProofCandidateEvidence,
  immutableProofCanonicalValue,
  immutableRuntimeEvent,
  init_claim_kernel,
  init_governed_proof_inspect_check_provider,
  init_instance_plan,
  init_proof_admission_cli_child,
  init_proof_catalog_check_providers,
  init_proof_wire,
  isGovernedProofComponentSelector,
  isGovernedProofProjectSelector,
  isGovernedProofSpecReviewSelector,
  proofAdmissionCapabilityValid,
  proofCandidateAdmissionRequestJson,
  proofCandidateEvidenceFingerprint,
  proofCatalogRevalidationReceiptIdentityJson,
  proofComponentCandidateEnvelopeJson,
  proofWorkItemDigestForReconciliation,
  qualifiedNestedExpansionOwner,
  reduceClaimEvent,
  replayClaimEvents,
  resolveJsonPointer,
  sha256Canonical,
  startProofManagedCliChild,
  validateGovernedProofComponentReinspectionContext,
  validateGovernedProofRuntimeContextAgainstClaims,
  validateOnboardingStageContext,
  validateProofCandidateAdmissionBinding,
  validateProofCandidateEvidence,
  validateProofCatalogRevalidationProjection,
  validateProofComponentAdmissionOutcome,
  validateProofComponentCandidateAdmissionBinding,
  validateProofComponentInvocationAuthority,
  validateProofCurrentCatalogAuthorityBytes
} from "./chunk-OEH4UJNW.mjs";
import {
  CheckProvider,
  init_check_provider_interface
} from "./chunk-326JA6WQ.mjs";
import {
  FailureConditionEvaluator,
  init_failure_condition_evaluator
} from "./chunk-TV6Z6UKZ.mjs";
import {
  addEvent,
  init_trace_helpers
} from "./chunk-GBGLIILP.mjs";
import {
  createExtendedLiquid,
  init_liquid_extensions
} from "./chunk-4HIWZA6M.mjs";
import {
  compileAndRun,
  createSecureSandbox,
  init_sandbox
} from "./chunk-LW3INISN.mjs";
import {
  MemoryStore,
  init_memory_store
} from "./chunk-4MHHELVZ.mjs";
import {
  init_logger,
  logger
} from "./chunk-6E625R3C.mjs";
import {
  __esm,
  __export,
  __toCommonJS
} from "./chunk-J7LXIPZS.mjs";

// src/state-machine/graph/instance-kernel.ts
function isGovernedCandidateClaim(claim) {
  return claim === PROOF_CANDIDATE_CLAIM || claim === PROOF_COMPONENT_SPEC_REVIEW_CANDIDATE_CLAIM;
}
function hasExactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}
function requireNonEmpty(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw new InstanceKernelError("INVALID_SCOPE", `${label} must be a non-empty string`);
  }
}
function canonicalCatalogKey(value) {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return canonicalJson(value);
  throw new InstanceKernelError(
    "INVALID_ITEM_KEY",
    "Catalog item key must be a non-empty string or finite number"
  );
}
function validateTaggedScopePath(value) {
  if (!Array.isArray(value)) {
    throw new InstanceKernelError("INVALID_SCOPE", "Scope path must be an array");
  }
  if (value.length === 0) return Object.freeze([]);
  const segments = value.map((candidate, position) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new InstanceKernelError("INVALID_SCOPE", `Scope segment ${position} must be an object`);
    }
    const segment = candidate;
    if (segment.kind === "indexed") {
      if (!hasExactKeys(segment, ["kind", "check", "index"])) {
        throw new InstanceKernelError("INVALID_SCOPE", "Indexed scope segment has unknown fields");
      }
      requireNonEmpty(segment.check, "Indexed scope check");
      if (typeof segment.index !== "number" || !Number.isSafeInteger(segment.index) || segment.index < 0) {
        throw new InstanceKernelError(
          "INVALID_SCOPE",
          "Indexed scope index must be a safe non-negative integer"
        );
      }
      return Object.freeze({ kind: "indexed", check: segment.check, index: segment.index });
    }
    if (segment.kind === "keyed") {
      if (!hasExactKeys(segment, [
        "kind",
        "expansionOwnerCheck",
        "key",
        "subgraphInstanceId"
      ])) {
        throw new InstanceKernelError("INVALID_SCOPE", "Keyed scope segment has unknown fields");
      }
      requireNonEmpty(segment.expansionOwnerCheck, "Keyed scope expansion owner");
      requireNonEmpty(segment.key, "Keyed scope key");
      if (typeof segment.subgraphInstanceId !== "string" || !SHA256_PATTERN.test(segment.subgraphInstanceId)) {
        throw new InstanceKernelError(
          "INVALID_SCOPE",
          "Keyed scope subgraph instance ID must be lowercase SHA-256"
        );
      }
      return Object.freeze({
        kind: "keyed",
        expansionOwnerCheck: segment.expansionOwnerCheck,
        key: segment.key,
        subgraphInstanceId: segment.subgraphInstanceId
      });
    }
    throw new InstanceKernelError("INVALID_SCOPE", `Scope segment ${position} is not tagged`);
  });
  const kinds = new Set(segments.map((segment) => segment.kind));
  if (kinds.size !== 1) {
    throw new InstanceKernelError("INVALID_SCOPE", "Indexed and keyed scope segments cannot mix");
  }
  if (segments[0].kind === "keyed") {
    const keyedSegments = segments;
    const instanceIds = keyedSegments.map((segment) => segment.subgraphInstanceId);
    if (new Set(instanceIds).size !== instanceIds.length) {
      throw new InstanceKernelError(
        "INVALID_SCOPE",
        "Keyed scope segments cannot repeat a subgraph instance ID"
      );
    }
  }
  return Object.freeze(segments);
}
function requireRootScopePath(value) {
  const scope = validateTaggedScopePath(value);
  if (scope.length !== 0) {
    throw new InstanceKernelError("INVALID_SCOPE", "Expected exact root scope");
  }
  return scope;
}
function requireKeyedScopePath(value, expected) {
  const scope = validateTaggedScopePath(value);
  if (scope.length < 1 || scope.some((segment) => segment.kind !== "keyed")) {
    throw new InstanceKernelError("INVALID_SCOPE", "Expected exact graph-v2 keyed scope");
  }
  const expectedScope = expected ? Array.isArray(expected) ? expected : [expected] : void 0;
  if (expectedScope && !scopePathEquals(scope, expectedScope)) {
    throw new InstanceKernelError(
      "INVALID_SCOPE",
      "Keyed scope does not match its complete projected ancestor chain"
    );
  }
  return scope;
}
function scopePathEquals(left, right) {
  return canonicalJson(validateTaggedScopePath(left)) === canonicalJson(validateTaggedScopePath(right));
}
function deriveSubgraphInstanceId(input) {
  return sha256Canonical({ v: 1, ...input });
}
function deriveNodeInstanceId(input) {
  return sha256Canonical({ v: 1, ...input });
}
function deriveItemFingerprint(payload) {
  return sha256Canonical(payload);
}
function deriveNodeGenerationId(input) {
  return sha256Canonical({
    v: 1,
    nodeInstanceId: input.nodeInstanceId,
    incarnation: input.incarnation,
    itemFingerprint: input.itemFingerprint,
    executionConfigDigest: input.executionConfigDigest,
    activeInputClaimIds: [...input.activeInputClaimIds].sort(),
    ...input.expansionBarrierDigest !== void 0 ? { expansionBarrierDigest: input.expansionBarrierDigest } : {}
  });
}
function deriveExpansionBarrierDigest(input) {
  const children = [...input.children].sort((left, right) => Buffer.from(left.itemKey, "utf8").compare(Buffer.from(right.itemKey, "utf8"))).map((child) => ({ ...child }));
  return sha256Canonical({
    v: 1,
    domain: "nested-expansion-completion-barrier/v1",
    expansionOwnerCheck: input.expansionOwnerCheck,
    terminalNode: input.terminalNode,
    nestedExpansionSpecDigest: input.nestedExpansionSpecDigest,
    nestedTemplateDigest: input.nestedTemplateDigest,
    nestedCatalogClaimId: input.nestedCatalogClaimId,
    children
  });
}
function deriveControllerItemClaimId(input) {
  return sha256Canonical({ v: 1, type: "controller-item", ...input });
}
function deriveCatalogRequestId(input) {
  return sha256Canonical({ v: 1, type: "catalog-reconciliation", ...input });
}
function deriveProofCurrentCatalogAuthorityId(input) {
  return sha256Canonical({
    v: 1,
    domain: "proof-current-catalog-authority/v1",
    sessionId: input.sessionId,
    scope: validateTaggedScopePath(input.scope),
    projectSubgraphInstanceId: input.projectSubgraphInstanceId,
    sourceCatalogClaimId: input.sourceCatalogClaimId,
    previousAuthorityId: input.previousAuthorityId,
    revalidationBytesBase64: input.revalidationBytesBase64,
    workItemsBytesBase64: input.workItemsBytesBase64
  });
}
function deriveProofCurrentCatalogAuthorityMutationDigest(input) {
  return sha256Canonical({
    v: 1,
    domain: "proof-current-catalog-authority-applied/v1",
    authorityId: input.authorityId,
    mutations: input.mutations.map((event) => {
      if (event.type === "ControllerItemClaimPublished") {
        return { ...event, payload: governedCanonicalJson(event.payload, "proof") };
      }
      return event;
    })
  });
}
function deriveManagedRunId(input) {
  return sha256Canonical({
    v: 1,
    type: "managed-run",
    sessionId: input.sessionId,
    checkId: input.checkId,
    scope: validateTaggedScopePath(input.scope),
    nodeInstanceId: input.nodeInstanceId,
    nodeGenerationId: input.nodeGenerationId,
    attemptId: input.attemptId,
    fence: input.fence
  });
}
function invalidProjectReconciliationParents(detail) {
  throw new InstanceKernelError("INVALID_PARENT_CLAIMS", detail);
}
function currentCompletedGeneratedOutput(projection, claim, checkId, subgraphInstanceId) {
  const generation = claim.nodeGenerationId ? projection.generationsById[claim.nodeGenerationId] : void 0;
  const node = generation ? projection.nodesById[generation.nodeInstanceId] : void 0;
  if (!claim.active || claim.kind !== "generated-output" || claim.producerCheckId !== checkId || claim.subgraphInstanceId !== subgraphInstanceId || !generation || generation.status !== "completed" || !generation.scheduled || generation.checkId !== checkId || generation.templateNodeKey !== checkId || generation.subgraphInstanceId !== subgraphInstanceId || !node || node.subgraphInstanceId !== subgraphInstanceId || node.templateNodeKey !== checkId || !scopePathEquals(node.scope, generation.scope) || !scopePathEquals(claim.scope, generation.scope) || projection.activeGenerationIdByNode[generation.nodeInstanceId] !== generation.nodeGenerationId || generation.completedOutputClaimIds.length !== 1 || generation.completedOutputClaimIds[0] !== claim.claimId || claim.producerAttemptId !== generation.attemptId || claim.producerFence !== generation.fence || !sameStrings(claim.parentClaimIds, generation.activeInputClaimIds)) {
    invalidProjectReconciliationParents(`${checkId} is not the exact current completed output`);
  }
  return generation;
}
function deriveProofProjectReconciliationParentClaimIds(projection, generation) {
  const stored = projection.generationsById[generation.nodeGenerationId];
  const project = projection.instancesById[generation.subgraphInstanceId];
  const reconciliationNode = projection.nodesById[generation.nodeInstanceId];
  if (!stored || canonicalJson(stored) !== canonicalJson(generation) || generation.templateNodeKey !== PROOF_PROJECT_RECONCILE_NODE_KEY || generation.checkId !== PROOF_PROJECT_RECONCILE_NODE_KEY || generation.status !== "ready" && generation.status !== "running" && generation.status !== "completed" || !generation.expansionBarrierDigest || !SHA256_PATTERN.test(generation.expansionBarrierDigest) || projection.activeGenerationIdByNode[generation.nodeInstanceId] !== generation.nodeGenerationId || !project || project.status !== "active" || project.parentSubgraphInstanceId !== void 0 || project.subgraphInstanceId !== generation.subgraphInstanceId || project.sessionId.length === 0 || project.nodeInstanceIdsByTemplateNode[PROOF_PROJECT_RECONCILE_NODE_KEY] !== generation.nodeInstanceId || !reconciliationNode || reconciliationNode.subgraphInstanceId !== project.subgraphInstanceId || reconciliationNode.templateNodeKey !== PROOF_PROJECT_RECONCILE_NODE_KEY || !scopePathEquals(reconciliationNode.scope, generation.scope) || !scopePathEquals(project.scope, generation.scope) || generation.scope.length !== 1 || generation.activeInputClaimIds.length !== 0) {
    invalidProjectReconciliationParents("Project reconciliation generation is inactive, stale, or detached");
  }
  const materializeNodeId = project.nodeInstanceIdsByTemplateNode.materialize_catalog;
  const materializeGenerationId = materializeNodeId ? projection.activeGenerationIdByNode[materializeNodeId] : void 0;
  const materializeGeneration = materializeGenerationId ? projection.generationsById[materializeGenerationId] : void 0;
  if (!materializeNodeId || !materializeGeneration || materializeGeneration.nodeInstanceId !== materializeNodeId || materializeGeneration.subgraphInstanceId !== project.subgraphInstanceId || materializeGeneration.checkId !== "materialize_catalog" || materializeGeneration.templateNodeKey !== "materialize_catalog" || materializeGeneration.status !== "completed" || !materializeGeneration.scheduled || materializeGeneration.completedOutputClaimIds.length !== 1) {
    invalidProjectReconciliationParents("Current materialize_catalog generation is missing or nonterminal");
  }
  const catalog = projection.claimsById[materializeGeneration.completedOutputClaimIds[0]];
  if (!catalog || catalog.claim !== "component.catalog@1" || !scopePathEquals(catalog.scope, project.scope)) {
    invalidProjectReconciliationParents("Current materialize_catalog output is not the component catalog");
  }
  const catalogGeneration = currentCompletedGeneratedOutput(
    projection,
    catalog,
    "materialize_catalog",
    project.subgraphInstanceId
  );
  if (catalogGeneration.nodeGenerationId !== materializeGeneration.nodeGenerationId) {
    invalidProjectReconciliationParents("Component catalog is detached from current materialize_catalog");
  }
  const currentRevalidations = Object.values(projection.claimsById).filter((claim) => claim.active && claim.claim === PROOF_CATALOG_REVALIDATION_CLAIM && claim.subgraphInstanceId === project.subgraphInstanceId);
  if (currentRevalidations.length !== 1 || !catalog.parentClaimIds.includes(currentRevalidations[0].claimId)) {
    invalidProjectReconciliationParents("Current project revalidation is missing or ambiguous");
  }
  const revalidation = currentRevalidations[0];
  currentCompletedGeneratedOutput(projection, revalidation, "revalidate_catalog", project.subgraphInstanceId);
  const children = Object.values(projection.instancesById).filter((instance) => instance.status === "active" && instance.parentSubgraphInstanceId === project.subgraphInstanceId);
  if (children.length === 0 || new Set(children.map((child) => child.itemKey)).size !== children.length || children.some((child) => child.catalogClaimId !== catalog.claimId || child.catalogProducerNodeGenerationId !== catalogGeneration.nodeGenerationId || child.expansionOwnerNodeInstanceId !== catalogGeneration.nodeInstanceId || child.catalogClaimRef !== catalog.claim || !child.activeItemClaimId || (() => {
    const item = child.activeItemClaimId ? projection.claimsById[child.activeItemClaimId] : void 0;
    return !item || !item.active || item.kind !== "controller-item" || item.subgraphInstanceId !== child.subgraphInstanceId || item.controllerCatalogClaimId !== catalog.claimId || item.parentClaimIds.length !== 1 || item.parentClaimIds[0] !== catalog.claimId;
  })())) {
    invalidProjectReconciliationParents("Selected component set is incomplete, foreign, or stale");
  }
  const admissionIds = children.map((child) => {
    const verifyNodeId = child.nodeInstanceIdsByTemplateNode.verify;
    const verifyGenerationId = verifyNodeId ? projection.activeGenerationIdByNode[verifyNodeId] : void 0;
    const verify = verifyGenerationId ? projection.generationsById[verifyGenerationId] : void 0;
    if (!verifyNodeId || !verify || verify.nodeInstanceId !== verifyNodeId || verify.subgraphInstanceId !== child.subgraphInstanceId || verify.templateNodeKey !== "verify" || verify.checkId !== "verify" || verify.status !== "completed" || !verify.scheduled || verify.activeInputClaimIds.length !== 2 && verify.activeInputClaimIds.length !== 4 || new Set(verify.activeInputClaimIds).size !== verify.activeInputClaimIds.length) {
      invalidProjectReconciliationParents(`Component ${child.itemKey} verify is not current and complete`);
    }
    const inputs = verify.activeInputClaimIds.map((claimId) => projection.claimsById[claimId]);
    if (inputs.length !== verify.activeInputClaimIds.length || inputs.some((claim) => !claim)) {
      invalidProjectReconciliationParents(`Component ${child.itemKey} verify has an unknown input claim`);
    }
    const staged = verify.activeInputClaimIds.length === 4;
    const candidate = inputs.find((claim) => claim?.claim === PROOF_CANDIDATE_CLAIM);
    const admission = inputs.find((claim) => claim?.claim === PROOF_ADMITTED_RECEIPT_CLAIM);
    const stageCandidate = inputs.find((claim) => claim?.claim === PROOF_COMPONENT_SPEC_REVIEW_CANDIDATE_CLAIM);
    const stageAdmission = inputs.find((claim) => claim?.claim === PROOF_COMPONENT_SPEC_REVIEW_ADMITTED_RECEIPT_CLAIM);
    const reviewedParent = candidate?.parentClaimIds.map((claimId) => projection.claimsById[claimId]).find((claim) => claim?.claim === NATIVE_COMPONENT_REVIEWED_CLAIM);
    const nativeReviewed = reviewedParent !== void 0;
    const expected = staged ? [candidate?.claimId, admission?.claimId, stageCandidate?.claimId, stageAdmission?.claimId] : [candidate?.claimId, admission?.claimId];
    if (!candidate || !admission || staged && (!stageCandidate || !stageAdmission) || !staged && (stageCandidate || stageAdmission) || expected.some((id) => id === void 0) || !sameStrings(verify.activeInputClaimIds, expected.sort())) {
      invalidProjectReconciliationParents(`Component ${child.itemKey} verify inputs are not the unique candidate and admission`);
    }
    const activeCandidates = Object.values(projection.claimsById).filter((claim) => claim.active && claim.subgraphInstanceId === child.subgraphInstanceId && claim.claim === PROOF_CANDIDATE_CLAIM);
    const activeAdmissions = Object.values(projection.claimsById).filter((claim) => claim.active && claim.subgraphInstanceId === child.subgraphInstanceId && claim.claim === PROOF_ADMITTED_RECEIPT_CLAIM);
    const activeStageCandidates = Object.values(projection.claimsById).filter((claim) => claim.active && claim.subgraphInstanceId === child.subgraphInstanceId && claim.claim === PROOF_COMPONENT_SPEC_REVIEW_CANDIDATE_CLAIM);
    const activeStageAdmissions = Object.values(projection.claimsById).filter((claim) => claim.active && claim.subgraphInstanceId === child.subgraphInstanceId && claim.claim === PROOF_COMPONENT_SPEC_REVIEW_ADMITTED_RECEIPT_CLAIM);
    if (activeCandidates.length !== 1 || activeAdmissions.length !== 1 || activeCandidates[0].claimId !== candidate.claimId || activeAdmissions[0].claimId !== admission.claimId) {
      invalidProjectReconciliationParents(`Component ${child.itemKey} verify inputs are not the unique candidate and admission`);
    }
    if (staged && (activeStageCandidates.length !== 1 || activeStageAdmissions.length !== 1 || activeStageCandidates[0].claimId !== stageCandidate?.claimId || activeStageAdmissions[0].claimId !== stageAdmission?.claimId) || !staged && (activeStageCandidates.length !== 0 || activeStageAdmissions.length !== 0)) {
      invalidProjectReconciliationParents(`Component ${child.itemKey} staged inputs are not the exact active pair`);
    }
    currentCompletedGeneratedOutput(projection, candidate, "inspect", child.subgraphInstanceId);
    const admissionGeneration = currentCompletedGeneratedOutput(projection, admission, "proof_admit", child.subgraphInstanceId);
    if (!child.activeItemClaimId || candidate.parentClaimIds.length !== (nativeReviewed ? 2 : 1) || !candidate.parentClaimIds.includes(child.activeItemClaimId) || nativeReviewed && (!reviewedParent || reviewedParent.subgraphInstanceId !== child.subgraphInstanceId || !reviewedParent.active || reviewedParent.kind !== "generated-output" || reviewedParent.producerCheckId !== "component-reviewed" || !candidate.parentClaimIds.includes(reviewedParent.claimId)) || !nativeReviewed && candidate.parentClaimIds.length !== 1 || !sameStrings(admissionGeneration.activeInputClaimIds, [candidate.claimId]) || !sameStrings(admission.parentClaimIds, [candidate.claimId])) {
      invalidProjectReconciliationParents(`Component ${child.itemKey} admission is detached from its candidate`);
    }
    if (nativeReviewed && reviewedParent) currentCompletedGeneratedOutput(projection, reviewedParent, "component-reviewed", child.subgraphInstanceId);
    if (!staged) return admission.claimId;
    if (!stageCandidate || !stageAdmission) {
      return invalidProjectReconciliationParents(`Component ${child.itemKey} staged inputs missing`);
    }
    currentCompletedGeneratedOutput(
      projection,
      stageCandidate,
      "spec_review",
      child.subgraphInstanceId
    );
    const stageAdmissionGeneration = currentCompletedGeneratedOutput(
      projection,
      stageAdmission,
      "spec_review_admit",
      child.subgraphInstanceId
    );
    if (!sameStrings(stageAdmissionGeneration.activeInputClaimIds, [stageCandidate.claimId]) || !sameStrings(stageAdmission.parentClaimIds, [stageCandidate.claimId]) || stageCandidate.parentClaimIds.length !== 3 || new Set(stageCandidate.parentClaimIds).size !== 3 || canonicalJson(stageCandidate.parentClaimIds) !== canonicalJson([...stageCandidate.parentClaimIds].sort())) {
      invalidProjectReconciliationParents(`Component ${child.itemKey} staged admission is detached from its candidate`);
    }
    const stageParents = stageCandidate.parentClaimIds.map((claimId) => projection.claimsById[claimId]);
    const component = stageParents.find((claim) => claim?.claim === "component.work_item@1");
    const priorCandidate = stageParents.find((claim) => claim?.claim === PROOF_CANDIDATE_CLAIM);
    const priorAdmission = stageParents.find((claim) => claim?.claim === PROOF_ADMITTED_RECEIPT_CLAIM);
    if (stageParents.length !== 3 || stageParents.some((claim) => !claim || !claim.active || claim.subgraphInstanceId !== child.subgraphInstanceId || canonicalJson(claim.scope) !== canonicalJson(stageCandidate.scope)) || !component || !priorCandidate || !priorAdmission || component.subgraphInstanceId !== child.subgraphInstanceId || priorCandidate.subgraphInstanceId !== child.subgraphInstanceId || priorAdmission.subgraphInstanceId !== child.subgraphInstanceId || component.kind !== "controller-item" || priorCandidate.kind !== "generated-output" || priorAdmission.kind !== "generated-output" || !child.activeItemClaimId || !sameStrings(component.parentClaimIds, [catalog.claimId]) || !sameStrings(stageCandidate.parentClaimIds, [child.activeItemClaimId, candidate.claimId, admission.claimId].sort()) || !sameStrings(priorAdmission.parentClaimIds, [priorCandidate.claimId]) || priorCandidate.producerCheckId !== "inspect" || priorAdmission.producerCheckId !== PROOF_ADMIT_NODE_KEY) {
      invalidProjectReconciliationParents(`Component ${child.itemKey} staged candidate parents are not the exact legacy lineage`);
    }
    return stageAdmission.claimId;
  });
  const parents = [revalidation.claimId, ...admissionIds].sort((left, right) => Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8")));
  if (new Set(parents).size !== parents.length) {
    invalidProjectReconciliationParents("Project reconciliation parents are duplicated");
  }
  return Object.freeze(parents);
}
function projectExpansionCoverage(claimProjection, projection, expansion, requestId) {
  const request = projection.requestsById[requestId];
  if (!request || request.expansionOwnerCheck !== expansion.expansionOwnerCheck) {
    throw new InstanceKernelError("UNKNOWN_COVERAGE_REQUEST", `Unknown coverage request ${requestId}`);
  }
  if (!expansion.coverage) {
    throw new InstanceKernelError("COVERAGE_NOT_CONFIGURED", `Expansion ${expansion.expansionOwnerCheck} has no coverage contract`);
  }
  const diagnostics = [];
  const denominator = [];
  const catalog = request.catalogClaimId ? claimProjection.claims[request.catalogClaimId] : void 0;
  const attempt = claimProjection.attempts[attemptProjectionKey(request.sessionId, request.expansionOwnerCheck, [])];
  const exactCatalog = catalog && catalog.claimId === request.catalogClaimId && catalog.claim === expansion.catalogClaimRef && catalog.producerCheckId === request.expansionOwnerCheck && catalog.attemptId === request.attemptId && catalog.fence === request.fence && catalog.scope.length === 0 && attempt?.sessionId === request.sessionId && attempt.checkId === request.expansionOwnerCheck && attempt.scope.length === 0 && attempt.attemptId === request.attemptId && attempt.fence === request.fence && attempt.status === "completed" && request.status === "completed";
  if (exactCatalog) {
    try {
      expansion.catalogValidator(catalog.payload);
      const rawItems = resolveJsonPointer(catalog.payload, expansion.itemsPointer);
      if (!Array.isArray(rawItems)) throw new Error("items-not-array");
      const seen = /* @__PURE__ */ new Set();
      for (const item of rawItems) {
        expansion.itemValidator(item);
        const key = canonicalCatalogKey(resolveJsonPointer(item, expansion.keyPointer));
        if (seen.has(key)) throw new Error("duplicate-key");
        seen.add(key);
        denominator.push({ key, itemFingerprint: deriveItemFingerprint(item) });
      }
      denominator.sort((left, right) => left.key.localeCompare(right.key));
    } catch {
      diagnostics.push("catalog:invalid");
    }
  } else diagnostics.push("catalog:lineage");
  const observedClaimIds = /* @__PURE__ */ new Set();
  const selectedKeys = new Set(denominator.map((item) => item.key));
  const items = denominator.map((selected) => {
    const instances = Object.values(projection.instancesById).filter(
      (instance2) => instance2.sessionId === request.sessionId && instance2.expansionOwnerCheck === request.expansionOwnerCheck && !instance2.parentSubgraphInstanceId && instance2.itemKey === selected.key
    );
    let terminalClass = null;
    let outcomeClaimId = null;
    let outcomePayloadFingerprint = null;
    const instance = instances.length === 1 ? instances[0] : void 0;
    const itemClaim = instance?.activeItemClaimId ? projection.claimsById[instance.activeItemClaimId] : void 0;
    if (!instance || instance.status !== "active" || !itemClaim?.active || itemClaim.payloadFingerprint !== selected.itemFingerprint) {
      diagnostics.push(`${selected.key}:lineage`);
      return { ...selected, terminalClass, outcomeClaimId, outcomePayloadFingerprint };
    }
    const emitterNodeId = instance.nodeInstanceIdsByTemplateNode[expansion.coverage.emitterNodeKey];
    const generationId = emitterNodeId ? projection.activeGenerationIdByNode[emitterNodeId] : void 0;
    const generation = generationId ? projection.generationsById[generationId] : void 0;
    if (!generation || generation.itemFingerprint !== selected.itemFingerprint) {
      diagnostics.push(`${selected.key}:lineage`);
      return { ...selected, terminalClass, outcomeClaimId, outcomePayloadFingerprint };
    }
    const outcomes = generation.completedOutputClaimIds.map((claimId) => projection.claimsById[claimId]).filter((claim) => claim?.active && claim.claim === expansion.coverage.outcomeClaimRef);
    outcomes.forEach((claim) => observedClaimIds.add(claim.claimId));
    const managed = generation.attemptId ? projection.managedRunsByAttemptId[generation.attemptId] : void 0;
    const cancelled = generation.status === "failed" && generation.reason === "MANAGED_DEADLINE_EXCEEDED" && managed?.status === "terminated" && managed.cleanupStatus === "clean" && managed.controllerDecision === "failed" && managed.failureCode === "MANAGED_DEADLINE_EXCEEDED" && managed.cancellationRequested === true && managed.binding.sessionId === request.sessionId && managed.binding.checkId === generation.checkId && managed.binding.nodeInstanceId === generation.nodeInstanceId && managed.binding.nodeGenerationId === generation.nodeGenerationId && managed.binding.attemptId === generation.attemptId && managed.binding.fence === generation.fence && scopePathEquals(managed.binding.scope, generation.scope);
    if (outcomes.length === 1 && generation.status === "completed") {
      try {
        const value = resolveJsonPointer(outcomes[0].payload, expansion.coverage.classPointer);
        if (typeof value === "string" && PROVIDER_COVERAGE_CLASSES.has(value)) {
          terminalClass = value;
          outcomeClaimId = outcomes[0].claimId;
          outcomePayloadFingerprint = outcomes[0].payloadFingerprint;
        } else diagnostics.push(`${selected.key}:invalid-class`);
      } catch {
        diagnostics.push(`${selected.key}:invalid-class`);
      }
    } else if (outcomes.length === 0 && cancelled) terminalClass = "cancelled";
    else if (outcomes.length === 0 && generation.status === "failed") terminalClass = "error";
    else if (outcomes.length > 1 || outcomes.length > 0 && generation.status !== "completed") {
      diagnostics.push(`${selected.key}:conflicting-terminal`);
    } else diagnostics.push(`${selected.key}:nonterminal`);
    return { ...selected, terminalClass, outcomeClaimId, outcomePayloadFingerprint };
  });
  for (const instance of Object.values(projection.instancesById)) {
    if (instance.sessionId !== request.sessionId || instance.expansionOwnerCheck !== request.expansionOwnerCheck || instance.parentSubgraphInstanceId || instance.status !== "active") continue;
    if (!selectedKeys.has(instance.itemKey)) diagnostics.push(`${instance.itemKey}:unknown`);
  }
  for (const claim of Object.values(projection.claimsById)) {
    if (!claim.active || claim.claim !== expansion.coverage.outcomeClaimRef) continue;
    const instance = projection.instancesById[claim.subgraphInstanceId];
    if (instance?.sessionId === request.sessionId && instance.expansionOwnerCheck === request.expansionOwnerCheck && !instance.parentSubgraphInstanceId && !observedClaimIds.has(claim.claimId)) {
      diagnostics.push(`${instance.itemKey}:unknown-terminal`);
    }
  }
  const canonicalDiagnostics = [...new Set(diagnostics)].sort();
  const terminalItems = items.filter((item) => item.terminalClass !== null).length;
  const closure = canonicalDiagnostics.length === 0 && terminalItems === items.length ? "closed" : "open";
  const classes = items.map((item) => item.terminalClass);
  const disposition = closure === "open" || classes.some(
    (value) => value === "error" || value === "guardrail_blocked" || value === "cancelled"
  ) ? "unverifiable" : classes.some((value) => value === "completed_with_findings") ? "findings" : "clean";
  const semantic = {
    expansionOwnerCheck: request.expansionOwnerCheck,
    denominator,
    outcomes: items.map((item) => ({
      key: item.key,
      terminalClass: item.terminalClass,
      outcomePayloadFingerprint: item.outcomePayloadFingerprint
    })),
    closure,
    disposition,
    terminalItems,
    diagnostics: canonicalDiagnostics
  };
  return immutableCanonicalValue({
    requestId,
    expansionOwnerCheck: request.expansionOwnerCheck,
    denominator,
    items,
    closure,
    disposition,
    terminalItems,
    diagnostics: canonicalDiagnostics,
    semanticDigest: sha256Canonical({ v: 2, ...semantic }),
    provenance: {
      ...request.catalogClaimId ? { catalogClaimId: request.catalogClaimId } : {},
      lastEventId: projection.lastEventId
    }
  });
}
function createInitialInstanceProjection() {
  return immutableCanonicalValue({
    lastEventId: 0,
    requestsById: {},
    requestOrder: [],
    instancesById: {},
    instanceIdByOwnerAndKey: {},
    nodesById: {},
    generationsById: {},
    activeGenerationIdByNode: {},
    claimsById: {},
    attemptBindingsById: {},
    managedRunsByAttemptId: {},
    currentProofCatalogAuthorityByProject: {},
    appliedProofCatalogAuthorityByProject: {},
    proofApplicationClaimIds: {}
  });
}
function immutableInstanceEvent(event) {
  const immutable = immutableCanonicalValue(event);
  if (event.type === "ClaimPublished" && "nodeGenerationId" in event) {
    return Object.freeze({
      ...immutable,
      payload: immutableGovernedValue(event.payload, event.wireMode),
      ...event.proofCandidateEvidence !== void 0 ? {
        proofCandidateEvidence: immutableProofCandidateEvidence(event.proofCandidateEvidence),
        proofCandidateEvidenceFingerprint: event.proofCandidateEvidenceFingerprint
      } : {}
    });
  }
  return immutable;
}
function immutableProofApplicationEvent(event) {
  const immutable = immutableInstanceEvent(event);
  if (event.type === "ControllerItemClaimPublished" && event.claim === "component.work_item@1") {
    return Object.freeze({
      ...immutable,
      payload: immutableGovernedValue(event.payload, "proof")
    });
  }
  return immutable;
}
function immutableInstanceProjectionInternal(projection, proofApplicationClaimIds) {
  const immutable = immutableCanonicalValue(projection);
  const trustedClaimIds = {
    ...projection.proofApplicationClaimIds || {}
  };
  for (const claimId of proofApplicationClaimIds || []) trustedClaimIds[claimId] = true;
  const claimsById = Object.fromEntries(Object.entries(projection.claimsById).map(([claimId, source]) => {
    const claim = { ...immutable.claimsById[claimId] };
    if (source.wireMode === "proof" || trustedClaimIds[claimId]) claim.payload = immutableGovernedValue(source.payload, "proof");
    if (source.proofCandidateEvidence !== void 0) claim.proofCandidateEvidence = immutableProofCandidateEvidence(source.proofCandidateEvidence);
    return [claimId, Object.freeze(claim)];
  }));
  const currentProofCatalogAuthorityByProject = Object.fromEntries(
    Object.entries(projection.currentProofCatalogAuthorityByProject || {}).map(([id, authority]) => [
      id,
      immutableGovernedValue(authority, "proof")
    ])
  );
  const appliedProofCatalogAuthorityByProject = Object.freeze({
    ...projection.appliedProofCatalogAuthorityByProject || {}
  });
  const persistedProofApplicationClaimIds = Object.freeze(trustedClaimIds);
  return Object.freeze({
    ...immutable,
    claimsById: Object.freeze(claimsById),
    currentProofCatalogAuthorityByProject: Object.freeze(currentProofCatalogAuthorityByProject),
    appliedProofCatalogAuthorityByProject,
    proofApplicationClaimIds: persistedProofApplicationClaimIds
  });
}
function immutableInstanceProjection(projection) {
  return immutableInstanceProjectionInternal(projection);
}
function ownerKey(expansionOwnerCheck, itemKey, parentSubgraphInstanceId = null, expansionOwnerNodeInstanceId) {
  return parentSubgraphInstanceId === null ? canonicalJson([expansionOwnerCheck, itemKey]) : canonicalJson([
    expansionOwnerCheck,
    parentSubgraphInstanceId,
    expansionOwnerNodeInstanceId,
    itemKey
  ]);
}
function sortedUnique(values, label) {
  if (values.some((value) => typeof value !== "string" || value.length === 0)) {
    throw new InstanceKernelError("INVALID_EVENT", `${label} must contain non-empty strings`);
  }
  const sorted = [...values].sort();
  if (new Set(sorted).size !== sorted.length) {
    throw new InstanceKernelError("INVALID_EVENT", `${label} must not contain duplicates`);
  }
  if (values.some((value, index) => value !== sorted[index])) {
    throw new InstanceKernelError("INVALID_EVENT", `${label} must be canonically sorted`);
  }
  return sorted;
}
function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function mutableProjection(projection) {
  return {
    lastEventId: projection.lastEventId,
    requestsById: { ...projection.requestsById },
    requestOrder: [...projection.requestOrder],
    instancesById: { ...projection.instancesById },
    instanceIdByOwnerAndKey: { ...projection.instanceIdByOwnerAndKey },
    nodesById: { ...projection.nodesById },
    generationsById: { ...projection.generationsById },
    activeGenerationIdByNode: { ...projection.activeGenerationIdByNode },
    claimsById: { ...projection.claimsById },
    attemptBindingsById: { ...projection.attemptBindingsById },
    managedRunsByAttemptId: { ...projection.managedRunsByAttemptId },
    currentProofCatalogAuthorityByProject: { ...projection.currentProofCatalogAuthorityByProject || {} },
    appliedProofCatalogAuthorityByProject: { ...projection.appliedProofCatalogAuthorityByProject || {} },
    proofApplicationClaimIds: { ...projection.proofApplicationClaimIds || {} }
  };
}
function currentAuthorityClaimView(claim) {
  if (claim.kind !== "generated-output" || claim.producerAttemptId === void 0 || claim.producerFence === void 0) {
    throw new InstanceKernelError("INVALID_PROOF_CURRENT_AUTHORITY", "Proof authority parent is not an attempt claim");
  }
  return {
    claimId: claim.claimId,
    claim: claim.claim,
    payload: claim.payload,
    payloadFingerprint: claim.payloadFingerprint,
    producerCheckId: claim.producerCheckId,
    scope: claim.scope,
    parentClaimIds: claim.parentClaimIds,
    wireMode: claim.wireMode,
    provenance: "attempt",
    attemptId: claim.producerAttemptId,
    fence: claim.producerFence,
    ...claim.proofCandidateEvidence ? { proofAdmission: claim.proofCandidateEvidence } : {}
  };
}
function validateProofAppliedHeader(event) {
  if (!hasExactKeys(event, [
    "version",
    "type",
    "eventId",
    "sessionId",
    "scope",
    "projectSubgraphInstanceId",
    "authorityId",
    "mutationEventCount",
    "mutationEventsDigest"
  ]) || event.version !== 1 || event.type !== "ProofCurrentCatalogAuthorityApplied" || typeof event.eventId !== "number" || !Number.isSafeInteger(event.eventId) || event.eventId < 1 || typeof event.sessionId !== "string" || event.sessionId.length === 0 || !SHA256_PATTERN.test(event.projectSubgraphInstanceId) || !SHA256_PATTERN.test(event.authorityId) || !Number.isSafeInteger(event.mutationEventCount) || event.mutationEventCount < 0 || !SHA256_PATTERN.test(event.mutationEventsDigest)) {
    throw new InstanceKernelError("INVALID_PROOF_CURRENT_APPLICATION", "Proof authority application header is invalid");
  }
  const scope = requireKeyedScopePath(event.scope);
  if (scope.length !== 1) throw new InstanceKernelError("INVALID_PROOF_CURRENT_APPLICATION", "Proof authority application requires a project scope");
}
function proofAuthoritySourceClaims(projection, authority) {
  const source = projection.claimsById[authority.sourceCatalogClaimId];
  const sourceGeneration = source?.nodeGenerationId ? projection.generationsById[source.nodeGenerationId] : void 0;
  if (!source || !source.active || source.claim !== "component.catalog@1" || source.kind !== "generated-output" || source.producerCheckId !== "materialize_catalog" || !sourceGeneration || sourceGeneration.status !== "completed" || sourceGeneration.checkId !== "materialize_catalog" || sourceGeneration.templateNodeKey !== "materialize_catalog" || !sourceGeneration.scheduled || sourceGeneration.completedOutputClaimIds.length !== 1 || sourceGeneration.completedOutputClaimIds[0] !== source.claimId || source.producerAttemptId !== sourceGeneration.attemptId || source.producerFence !== sourceGeneration.fence || projection.activeGenerationIdByNode[sourceGeneration.nodeInstanceId] !== sourceGeneration.nodeGenerationId) {
    throw new InstanceKernelError("INVALID_PROOF_CURRENT_APPLICATION", "Current Proof authority source catalog is unavailable");
  }
  const parents = source.parentClaimIds.map((claimId) => projection.claimsById[claimId]);
  const candidate = parents.find((claim) => claim?.claim === PROOF_CANDIDATE_CLAIM);
  const admission = parents.find((claim) => claim?.claim === PROOF_ADMITTED_RECEIPT_CLAIM);
  if (source.parentClaimIds.length !== 4 || new Set(source.parentClaimIds).size !== 4 || !source.parentClaimIds.every((claimId, index) => claimId === [...source.parentClaimIds].sort()[index]) || !candidate || !admission || parents.filter((claim) => claim?.claim === PROOF_CANDIDATE_CLAIM).length !== 1 || parents.filter((claim) => claim?.claim === PROOF_ADMITTED_RECEIPT_CLAIM).length !== 1) {
    throw new InstanceKernelError("INVALID_PROOF_CURRENT_APPLICATION", "Current Proof authority source lineage is incomplete");
  }
  return { candidate, admission };
}
function validateProofAppliedMutationBatch(projection, header, mutations) {
  validateProofAppliedHeader(header);
  const scope = requireKeyedScopePath(header.scope);
  const project = projection.instancesById[header.projectSubgraphInstanceId];
  const authority = projection.currentProofCatalogAuthorityByProject[header.projectSubgraphInstanceId];
  if (!project || project.status !== "active" || project.sessionId !== header.sessionId || !scopePathEquals(project.scope, scope) || !authority || authority.authorityId !== header.authorityId || projection.appliedProofCatalogAuthorityByProject[header.projectSubgraphInstanceId]?.authorityId === header.authorityId) {
    throw new InstanceKernelError("INVALID_PROOF_CURRENT_APPLICATION", "Proof authority application is stale or already applied");
  }
  const sourceClaims = proofAuthoritySourceClaims(projection, authority);
  let validated;
  try {
    validated = validateProofCurrentCatalogAuthorityBytes({
      revalidationBytesBase64: authority.revalidationBytesBase64,
      workItemsBytesBase64: authority.workItemsBytesBase64,
      candidate: currentAuthorityClaimView(sourceClaims.candidate),
      admission: currentAuthorityClaimView(sourceClaims.admission)
    });
  } catch (error) {
    throw new InstanceKernelError("INVALID_PROOF_CURRENT_APPLICATION", `Current Proof authority bytes are invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const changed = authority.components.filter((row) => row.comparison === "changed").sort((left, right) => Buffer.from(left.componentId, "utf8").compare(Buffer.from(right.componentId, "utf8")));
  if (changed.length === 0) {
    const sourceCatalog = projection.claimsById[authority.sourceCatalogClaimId];
    const baseline = sourceCatalog?.parentClaimIds.map((claimId) => projection.claimsById[claimId]).find((claim) => claim?.claim === PROOF_CATALOG_REVALIDATION_CLAIM);
    const baselineMatches = !!baseline && governedCanonicalJson(validated.revalidation, "proof") === governedCanonicalJson(baseline.payload, "proof");
    let appliedMatches = false;
    const previousApplied = projection.appliedProofCatalogAuthorityByProject[header.projectSubgraphInstanceId];
    if (previousApplied && previousApplied.sourceCatalogClaimId === authority.sourceCatalogClaimId) {
      try {
        const previous = validateProofCurrentCatalogAuthorityBytes({
          revalidationBytesBase64: previousApplied.revalidationBytesBase64,
          workItemsBytesBase64: previousApplied.workItemsBytesBase64,
          candidate: currentAuthorityClaimView(sourceClaims.candidate),
          admission: currentAuthorityClaimView(sourceClaims.admission)
        });
        appliedMatches = governedCanonicalJson(validated.revalidation, "proof") === governedCanonicalJson(previous.revalidation, "proof");
      } catch {
        appliedMatches = false;
      }
    }
    if (!baselineMatches && !appliedMatches) {
      throw new InstanceKernelError(
        "INVALID_PROOF_CURRENT_APPLICATION",
        "Applied Proof revalidation differs while no WorkItems changed"
      );
    }
  }
  let offset = 0;
  const projectNodeKeys = Object.keys(project.nodeInstanceIdsByTemplateNode).sort();
  const reconciliationNodeId = project.nodeInstanceIdsByTemplateNode[PROOF_PROJECT_RECONCILE_NODE_KEY];
  const exactReconciliationTopology = projectNodeKeys.length === 7 && canonicalJson(projectNodeKeys) === canonicalJson([
    "inspect",
    "materialize_catalog",
    PROOF_PROJECT_RECONCILE_NODE_KEY,
    PROOF_ADMIT_NODE_KEY,
    "revalidate_catalog",
    "structural_inventory",
    "verify"
  ].sort());
  const reconciliationGenerationId = reconciliationNodeId ? projection.activeGenerationIdByNode[reconciliationNodeId] : void 0;
  const reconciliationGeneration = reconciliationGenerationId ? projection.generationsById[reconciliationGenerationId] : void 0;
  if (changed.length > 0 && exactReconciliationTopology) {
    if (!reconciliationNodeId || !reconciliationGeneration || reconciliationGeneration.status !== "completed" || reconciliationGeneration.templateNodeKey !== PROOF_PROJECT_RECONCILE_NODE_KEY || reconciliationGeneration.checkId !== PROOF_PROJECT_RECONCILE_NODE_KEY || reconciliationGeneration.subgraphInstanceId !== project.subgraphInstanceId || !scopePathEquals(reconciliationGeneration.scope, project.scope) || !reconciliationGeneration.scheduled || reconciliationGeneration.completedOutputClaimIds.length !== 1) {
      throw new InstanceKernelError(
        "INVALID_PROOF_CURRENT_APPLICATION",
        "Current project reconciliation receipt is not an exact completed output"
      );
    }
    const receipt = projection.claimsById[reconciliationGeneration.completedOutputClaimIds[0]];
    if (!receipt || !receipt.active || receipt.kind !== "generated-output" || receipt.claim !== PROOF_PROJECT_RECONCILIATION_RECEIPT_CLAIM || receipt.nodeGenerationId !== reconciliationGeneration.nodeGenerationId || receipt.producerCheckId !== PROOF_PROJECT_RECONCILE_NODE_KEY || receipt.subgraphInstanceId !== project.subgraphInstanceId || !scopePathEquals(receipt.scope, project.scope) || receipt.producerAttemptId !== reconciliationGeneration.attemptId || receipt.producerFence !== reconciliationGeneration.fence) {
      throw new InstanceKernelError(
        "INVALID_PROOF_CURRENT_APPLICATION",
        "Current project reconciliation receipt is unavailable"
      );
    }
    const rootEvent = mutations[offset++];
    if (!rootEvent || rootEvent.type !== "NodeGenerationInactivated" || rootEvent.sessionId !== header.sessionId || !scopePathEquals(rootEvent.scope, project.scope) || rootEvent.subgraphInstanceId !== project.subgraphInstanceId || rootEvent.nodeInstanceId !== reconciliationGeneration.nodeInstanceId || rootEvent.nodeGenerationId !== reconciliationGeneration.nodeGenerationId || rootEvent.incarnation !== reconciliationGeneration.incarnation || rootEvent.reason !== "superseded" || canonicalJson(rootEvent.outputClaimIds) !== canonicalJson([...reconciliationGeneration.completedOutputClaimIds].sort())) {
      throw new InstanceKernelError(
        "INVALID_PROOF_CURRENT_APPLICATION",
        "Project reconciliation generation replacement is not the exact first mutation"
      );
    }
  }
  for (const row of changed) {
    const instance = projection.instancesById[row.subgraphInstanceId];
    if (!instance || instance.status !== "active" || instance.itemKey !== row.componentId || !instance.activeItemClaimId || instance.activeItemClaimId !== row.historicalItemClaimId || instance.catalogClaimId !== authority.sourceCatalogClaimId) {
      throw new InstanceKernelError("INVALID_PROOF_CURRENT_APPLICATION", `Historical component ${row.componentId} is stale or detached`);
    }
    const historical = projection.claimsById[instance.activeItemClaimId];
    if (!historical || !historical.active || historical.payloadFingerprint !== row.historicalItemFingerprint) {
      throw new InstanceKernelError("INVALID_PROOF_CURRENT_APPLICATION", `Historical WorkItem ${row.componentId} is stale`);
    }
    if (Object.values(projection.instancesById).some((candidate) => candidate.status === "active" && candidate.parentSubgraphInstanceId === instance.subgraphInstanceId)) {
      throw new InstanceKernelError("INVALID_PROOF_CURRENT_APPLICATION", `Component ${row.componentId} has active descendants`);
    }
    const currentItem = validated.items.find((item) => item.component_id === row.componentId);
    if (!currentItem || deriveItemFingerprint(currentItem) !== row.currentItemFingerprint || governedCanonicalJson(currentItem, "proof") === governedCanonicalJson(historical.payload, "proof")) {
      throw new InstanceKernelError("INVALID_PROOF_CURRENT_APPLICATION", `Current WorkItem ${row.componentId} is not a changed Proof item`);
    }
    const generations = Object.values(projection.generationsById).filter((generation) => generation.subgraphInstanceId === instance.subgraphInstanceId && generation.status !== "inactive").sort((left, right) => left.nodeGenerationId.localeCompare(right.nodeGenerationId));
    if (generations.some((generation) => generation.status === "ready" || generation.status === "running")) {
      throw new InstanceKernelError("INVALID_PROOF_CURRENT_APPLICATION", `Component ${row.componentId} has a nonterminal generation`);
    }
    for (const generation of generations) {
      const event = mutations[offset++];
      if (!event || event.type !== "NodeGenerationInactivated" || event.sessionId !== header.sessionId || !scopePathEquals(event.scope, instance.scope) || event.subgraphInstanceId !== instance.subgraphInstanceId || event.nodeInstanceId !== generation.nodeInstanceId || event.nodeGenerationId !== generation.nodeGenerationId || event.incarnation !== generation.incarnation || event.reason !== "superseded" || canonicalJson(event.outputClaimIds) !== canonicalJson([...generation.completedOutputClaimIds].sort())) {
        throw new InstanceKernelError("INVALID_PROOF_CURRENT_APPLICATION", `Component ${row.componentId} generation replacement is not exact`);
      }
    }
    const itemFingerprint = deriveItemFingerprint(currentItem);
    const incarnation = instance.incarnation + 1;
    const claimId = deriveControllerItemClaimId({
      claim: "component.work_item@1",
      payloadFingerprint: itemFingerprint,
      expansionSpecDigest: instance.expansionSpecDigest,
      catalogClaimId: authority.sourceCatalogClaimId,
      subgraphInstanceId: instance.subgraphInstanceId,
      incarnation,
      scope: instance.scope
    });
    const itemEvent = mutations[offset++];
    if (!itemEvent || itemEvent.type !== "ControllerItemClaimPublished" || itemEvent.sessionId !== header.sessionId || !scopePathEquals(itemEvent.scope, instance.scope) || itemEvent.expansionOwnerCheck !== instance.expansionOwnerCheck || itemEvent.expansionSpecDigest !== instance.expansionSpecDigest || itemEvent.catalogClaimId !== authority.sourceCatalogClaimId || itemEvent.itemKey !== row.componentId || itemEvent.subgraphInstanceId !== instance.subgraphInstanceId || itemEvent.incarnation !== incarnation || itemEvent.claim !== "component.work_item@1" || itemEvent.claimId !== claimId || itemEvent.payloadFingerprint !== itemFingerprint || itemEvent.parentClaimIds.length !== 1 || itemEvent.parentClaimIds[0] !== authority.sourceCatalogClaimId || governedCanonicalJson(itemEvent.payload, "proof") !== governedCanonicalJson(currentItem, "proof")) {
      throw new InstanceKernelError("INVALID_PROOF_CURRENT_APPLICATION", `Component ${row.componentId} WorkItem replacement is not exact Proof output`);
    }
    const inspectNodeId = instance.nodeInstanceIdsByTemplateNode.inspect;
    const previousGenerationId = inspectNodeId ? projection.activeGenerationIdByNode[inspectNodeId] : void 0;
    const previousGeneration = previousGenerationId ? projection.generationsById[previousGenerationId] : void 0;
    if (!inspectNodeId || !previousGeneration || previousGeneration.status === "ready" || previousGeneration.status === "running") {
      throw new InstanceKernelError("INVALID_PROOF_CURRENT_APPLICATION", `Component ${row.componentId} has no terminal inspect source`);
    }
    const activation = mutations[offset++];
    const expectedInputIds = previousGeneration.activeInputClaimIds.map((id) => id === historical.claimId ? claimId : id).sort();
    const expectedGenerationId = deriveNodeGenerationId({
      nodeInstanceId: inspectNodeId,
      incarnation,
      itemFingerprint,
      executionConfigDigest: previousGeneration.executionConfigDigest,
      activeInputClaimIds: expectedInputIds
    });
    if (!activation || activation.type !== "NodeGenerationActivated" || activation.sessionId !== header.sessionId || !scopePathEquals(activation.scope, instance.scope) || activation.subgraphInstanceId !== instance.subgraphInstanceId || activation.nodeInstanceId !== inspectNodeId || activation.nodeGenerationId !== expectedGenerationId || activation.templateNodeKey !== "inspect" || activation.checkId !== "inspect" || activation.incarnation !== incarnation || activation.itemFingerprint !== itemFingerprint || activation.executionConfigDigest !== previousGeneration.executionConfigDigest || canonicalJson(activation.activeInputClaimIds) !== canonicalJson(expectedInputIds) || previousGeneration.nestedExpansionCatalogClaimRef !== void 0 && activation.nestedExpansionCatalogClaimRef !== previousGeneration.nestedExpansionCatalogClaimRef || previousGeneration.nestedExpansionCatalogClaimRef === void 0 && "nestedExpansionCatalogClaimRef" in activation) {
      throw new InstanceKernelError("INVALID_PROOF_CURRENT_APPLICATION", `Component ${row.componentId} inspect replacement is not exact`);
    }
  }
  if (offset !== mutations.length) throw new InstanceKernelError("INVALID_PROOF_CURRENT_APPLICATION", "Proof authority application contains extra or reordered mutations");
}
function requireInstance(projection, subgraphInstanceId, scope, allowNestedTombstone = false) {
  const instance = projection.instancesById[subgraphInstanceId];
  if (!instance || instance.status !== "active" && !(allowNestedTombstone && instance.parentSubgraphInstanceId)) {
    throw new InstanceKernelError("INACTIVE_INSTANCE", `Instance ${subgraphInstanceId} is not active`);
  }
  const exactScope = requireKeyedScopePath(scope, instance.scope);
  const segment = exactScope[exactScope.length - 1];
  if (segment.expansionOwnerCheck !== instance.expansionOwnerCheck || segment.key !== instance.itemKey || segment.subgraphInstanceId !== instance.subgraphInstanceId) {
    throw new InstanceKernelError("INVALID_SCOPE", "Instance scope leaf is not exact");
  }
  if (instance.parentSubgraphInstanceId) {
    if (exactScope.length < 2 || !instance.expansionOwnerNodeInstanceId) {
      throw new InstanceKernelError("INVALID_SCOPE", "Nested instance lacks its exact parent chain");
    }
    const parent = projection.instancesById[instance.parentSubgraphInstanceId];
    const ownerNode = projection.nodesById[instance.expansionOwnerNodeInstanceId];
    const parentScope = exactScope.slice(0, -1);
    if (!parent || parent.status !== "active" || !scopePathEquals(parentScope, parent.scope) || !ownerNode || ownerNode.subgraphInstanceId !== parent.subgraphInstanceId || !scopePathEquals(ownerNode.scope, parent.scope)) {
      throw new InstanceKernelError("INVALID_SCOPE", "Nested instance ancestor chain is invalid");
    }
  } else if (exactScope.length !== 1) {
    throw new InstanceKernelError("INVALID_SCOPE", "Root-expanded instance scope must have one segment");
  }
  return instance;
}
function requireNestedCatalogAuthority(projection, input, context) {
  const parent = requireInstance(
    projection,
    input.parentSubgraphInstanceId,
    projection.instancesById[input.parentSubgraphInstanceId]?.scope
  );
  const ownerNode = projection.nodesById[input.expansionOwnerNodeInstanceId];
  const catalog = projection.claimsById[input.catalogClaimId];
  const generation = catalog?.nodeGenerationId ? projection.generationsById[catalog.nodeGenerationId] : void 0;
  if (!ownerNode || ownerNode.subgraphInstanceId !== parent.subgraphInstanceId || !generation || !generation.nestedExpansionCatalogClaimRef || !catalog.active || catalog.kind !== "generated-output" || catalog.claim !== generation.nestedExpansionCatalogClaimRef || catalog.subgraphInstanceId !== parent.subgraphInstanceId || catalog.nodeGenerationId !== generation.nodeGenerationId || generation.nodeInstanceId !== ownerNode.nodeInstanceId || generation.subgraphInstanceId !== parent.subgraphInstanceId || generation.status !== "running" && !(context !== void 0 && input.catalogClaimId === context.sourceCatalogClaimId && generation.status === "completed") || !generation.scheduled || projection.activeGenerationIdByNode[ownerNode.nodeInstanceId] !== generation.nodeGenerationId || catalog.producerAttemptId !== generation.attemptId || catalog.producerFence !== generation.fence || catalog.producerCheckId !== generation.checkId || !scopePathEquals(catalog.scope, parent.scope)) {
    throw new InstanceKernelError(
      "INVALID_NESTED_CATALOG_LINEAGE",
      "Nested catalog is not the exact active output of its current fenced owner generation"
    );
  }
  return generation;
}
function isReservedProofComponentLineage(projection, instance) {
  if (!instance || instance.status !== "active" || instance.parentSubgraphInstanceId === void 0 || !instance.catalogClaimId || !instance.activeItemClaimId) return false;
  const item = projection.claimsById[instance.activeItemClaimId];
  if (!item || !item.active || item.kind !== "controller-item" || item.claim !== "component.work_item@1" || item.controllerCatalogClaimId !== instance.catalogClaimId || item.parentClaimIds.length !== 1 || item.parentClaimIds[0] !== instance.catalogClaimId) return false;
  const project = projection.instancesById[instance.parentSubgraphInstanceId];
  const catalog = projection.claimsById[instance.catalogClaimId];
  const catalogGeneration = catalog?.nodeGenerationId ? projection.generationsById[catalog.nodeGenerationId] : void 0;
  if (!project || project.parentSubgraphInstanceId !== void 0 || project.scope.length !== 1 || !catalog || !catalog.active || catalog.kind !== "generated-output" || catalog.claim !== "component.catalog@1" || catalog.producerCheckId !== "materialize_catalog" || !scopePathEquals(catalog.scope, project.scope) || !catalogGeneration || catalogGeneration.status !== "completed" || catalogGeneration.checkId !== "materialize_catalog" || catalogGeneration.templateNodeKey !== "materialize_catalog" || !catalogGeneration.scheduled || catalogGeneration.subgraphInstanceId !== project.subgraphInstanceId || catalog.producerAttemptId !== catalogGeneration.attemptId || catalog.producerFence !== catalogGeneration.fence || projection.activeGenerationIdByNode[catalogGeneration.nodeInstanceId] !== catalogGeneration.nodeGenerationId || catalogGeneration.completedOutputClaimIds.length !== 1 || catalogGeneration.completedOutputClaimIds[0] !== catalog.claimId) return false;
  const parentIds = catalog.parentClaimIds;
  if (parentIds.length !== 4 || new Set(parentIds).size !== 4 || !parentIds.every((claimId, index) => claimId === [...parentIds].sort()[index])) return false;
  const parents = parentIds.map((claimId) => projection.claimsById[claimId]);
  const inventory = parents.find((parent) => parent?.claim === PROOF_STRUCTURAL_INVENTORY_CLAIM);
  const candidate = parents.find((parent) => parent?.claim === PROOF_CANDIDATE_CLAIM);
  const admission = parents.find((parent) => parent?.claim === PROOF_ADMITTED_RECEIPT_CLAIM);
  const revalidation = parents.find((parent) => parent?.claim === PROOF_CATALOG_REVALIDATION_CLAIM);
  if (!inventory || !candidate || !admission || !revalidation || parents.filter((parent) => parent?.claim === PROOF_STRUCTURAL_INVENTORY_CLAIM).length !== 1 || parents.filter((parent) => parent?.claim === PROOF_CANDIDATE_CLAIM).length !== 1 || parents.filter((parent) => parent?.claim === PROOF_ADMITTED_RECEIPT_CLAIM).length !== 1 || parents.filter((parent) => parent?.claim === PROOF_CATALOG_REVALIDATION_CLAIM).length !== 1 || [inventory, candidate, admission, revalidation].some(
    (parent) => !parent.active || parent.kind !== "generated-output" || !parent.nodeGenerationId || !scopePathEquals(parent.scope, catalog.scope) || projection.generationsById[parent.nodeGenerationId]?.status !== "completed" || !projection.generationsById[parent.nodeGenerationId]?.scheduled || !projection.generationsById[parent.nodeGenerationId]?.completedOutputClaimIds.includes(parent.claimId)
  ) || candidate.producerCheckId !== "inspect" || candidate.wireMode !== "proof" || admission.producerCheckId !== "proof_admit" || revalidation.producerCheckId !== "revalidate_catalog" || revalidation.wireMode !== "proof" || !project.activeItemClaimId || candidate.parentClaimIds.length !== 2 || !candidate.parentClaimIds.includes(project.activeItemClaimId) || !candidate.parentClaimIds.includes(inventory.claimId) || !candidate.parentClaimIds.every((claimId, index) => claimId === [...candidate.parentClaimIds].sort()[index]) || admission.parentClaimIds.length !== 1 || admission.parentClaimIds[0] !== candidate.claimId || revalidation.parentClaimIds.length !== 3 || canonicalJson(revalidation.parentClaimIds) !== canonicalJson([inventory.claimId, candidate.claimId, admission.claimId].sort())) return false;
  return true;
}
function isReservedProofProjectReconciliationLineage(projection, event) {
  const project = projection.instancesById[event.subgraphInstanceId];
  if (!project || project.status !== "active" || project.parentSubgraphInstanceId !== void 0 || project.scope.length !== 1) return false;
  const nodeKeys = Object.keys(project.nodeInstanceIdsByTemplateNode).sort();
  if (nodeKeys.length !== 7 || canonicalJson(nodeKeys) !== canonicalJson([
    "inspect",
    "materialize_catalog",
    PROOF_PROJECT_RECONCILE_NODE_KEY,
    PROOF_ADMIT_NODE_KEY,
    "revalidate_catalog",
    "structural_inventory",
    "verify"
  ].sort())) return false;
  const nodeInstanceId = project.nodeInstanceIdsByTemplateNode[PROOF_PROJECT_RECONCILE_NODE_KEY];
  const node = projection.nodesById[event.nodeInstanceId];
  const generation = projection.generationsById[event.nodeGenerationId];
  if (!nodeInstanceId || event.nodeInstanceId !== nodeInstanceId || !node || node.subgraphInstanceId !== project.subgraphInstanceId || node.templateNodeKey !== PROOF_PROJECT_RECONCILE_NODE_KEY || !scopePathEquals(node.scope, project.scope) || !generation || generation.nodeInstanceId !== nodeInstanceId || generation.subgraphInstanceId !== project.subgraphInstanceId || generation.templateNodeKey !== PROOF_PROJECT_RECONCILE_NODE_KEY || generation.checkId !== PROOF_PROJECT_RECONCILE_NODE_KEY || !scopePathEquals(generation.scope, project.scope) || projection.activeGenerationIdByNode[nodeInstanceId] !== generation.nodeGenerationId) return false;
  const materializeNodeId = project.nodeInstanceIdsByTemplateNode.materialize_catalog;
  const materializeGenerationId = materializeNodeId ? projection.activeGenerationIdByNode[materializeNodeId] : void 0;
  const materializeGeneration = materializeGenerationId ? projection.generationsById[materializeGenerationId] : void 0;
  const catalogClaimId = materializeGeneration?.completedOutputClaimIds.length === 1 ? materializeGeneration.completedOutputClaimIds[0] : void 0;
  const catalog = catalogClaimId ? projection.claimsById[catalogClaimId] : void 0;
  const catalogGeneration = catalog?.nodeGenerationId ? projection.generationsById[catalog.nodeGenerationId] : void 0;
  if (!materializeGeneration || materializeGeneration.status !== "completed" || materializeGeneration.nodeInstanceId !== materializeNodeId || materializeGeneration.checkId !== "materialize_catalog" || materializeGeneration.templateNodeKey !== "materialize_catalog" || !materializeGeneration.scheduled || !catalog || !catalog.active || catalog.kind !== "generated-output" || catalog.claim !== "component.catalog@1" || catalog.subgraphInstanceId !== project.subgraphInstanceId || !scopePathEquals(catalog.scope, project.scope) || catalog.nodeGenerationId !== materializeGeneration.nodeGenerationId || !catalogGeneration || catalogGeneration.status !== "completed" || catalogGeneration.nodeGenerationId !== materializeGeneration.nodeGenerationId || catalog.producerCheckId !== "materialize_catalog" || catalog.producerAttemptId !== materializeGeneration.attemptId || catalog.producerFence !== materializeGeneration.fence || materializeGeneration.completedOutputClaimIds[0] !== catalog.claimId) return false;
  const parentIds = catalog.parentClaimIds;
  if (parentIds.length !== 4 || new Set(parentIds).size !== 4 || !parentIds.every((claimId, index) => claimId === [...parentIds].sort()[index])) return false;
  const parents = parentIds.map((claimId) => projection.claimsById[claimId]);
  const inventory = parents.find((parent) => parent?.claim === PROOF_STRUCTURAL_INVENTORY_CLAIM);
  const candidate = parents.find((parent) => parent?.claim === PROOF_CANDIDATE_CLAIM);
  const admission = parents.find((parent) => parent?.claim === PROOF_ADMITTED_RECEIPT_CLAIM);
  const revalidation = parents.find((parent) => parent?.claim === PROOF_CATALOG_REVALIDATION_CLAIM);
  return !!inventory && !!candidate && !!admission && !!revalidation && parents.filter((parent) => parent?.claim === PROOF_STRUCTURAL_INVENTORY_CLAIM).length === 1 && parents.filter((parent) => parent?.claim === PROOF_CANDIDATE_CLAIM).length === 1 && parents.filter((parent) => parent?.claim === PROOF_ADMITTED_RECEIPT_CLAIM).length === 1 && parents.filter((parent) => parent?.claim === PROOF_CATALOG_REVALIDATION_CLAIM).length === 1 && [inventory, candidate, admission, revalidation].every(
    (parent) => parent.active && parent.kind === "generated-output" && !!parent.nodeGenerationId && scopePathEquals(parent.scope, project.scope) && projection.generationsById[parent.nodeGenerationId]?.status === "completed" && projection.generationsById[parent.nodeGenerationId]?.scheduled && projection.generationsById[parent.nodeGenerationId]?.completedOutputClaimIds.includes(parent.claimId)
  ) && candidate.producerCheckId === "inspect" && candidate.wireMode === "proof" && admission.producerCheckId === "proof_admit" && revalidation.producerCheckId === "revalidate_catalog" && revalidation.wireMode === "proof";
}
function requiresProofApplicationInactivation(projection, event) {
  return isReservedProofComponentLineage(projection, projection.instancesById[event.subgraphInstanceId]) || isReservedProofProjectReconciliationLineage(projection, event);
}
function requireGeneration(projection, event) {
  const generation = projection.generationsById[event.nodeGenerationId];
  if (!generation || generation.nodeInstanceId !== event.nodeInstanceId || !scopePathEquals(generation.scope, event.scope)) {
    throw new InstanceKernelError(
      "INVALID_GENERATION_BINDING",
      `Generation ${event.nodeGenerationId} is not bound to the supplied node and scope`
    );
  }
  if (projection.activeGenerationIdByNode[event.nodeInstanceId] !== event.nodeGenerationId) {
    throw new InstanceKernelError("STALE_GENERATION", `Generation ${event.nodeGenerationId} is inactive`);
  }
  return generation;
}
function requireAttemptBinding(projection, event) {
  const binding = projection.attemptBindingsById[event.attemptId];
  const expected = event.nodeGenerationId || event.requestId;
  if (!binding || binding !== expected) {
    throw new InstanceKernelError("INVALID_ATTEMPT_BINDING", `Attempt ${event.attemptId} is misbound`);
  }
  return binding;
}
function managedBindingEquals(left, right) {
  return left.managedRunId === right.managedRunId && left.sessionId === right.sessionId && left.checkId === right.checkId && scopePathEquals(left.scope, right.scope) && left.nodeInstanceId === right.nodeInstanceId && left.nodeGenerationId === right.nodeGenerationId && left.attemptId === right.attemptId && left.fence === right.fence;
}
function requireManagedRunBinding(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InstanceKernelError("INVALID_MANAGED_BINDING", "Managed run binding must be an object");
  }
  const binding = value;
  if (!hasExactKeys(binding, [
    "managedRunId",
    "sessionId",
    "checkId",
    "scope",
    "nodeInstanceId",
    "nodeGenerationId",
    "attemptId",
    "fence"
  ])) {
    throw new InstanceKernelError(
      "INVALID_MANAGED_BINDING",
      "Managed run binding must contain exactly eight authority fields"
    );
  }
  for (const field of [
    "managedRunId",
    "sessionId",
    "checkId",
    "nodeInstanceId",
    "nodeGenerationId",
    "attemptId"
  ]) {
    if (typeof binding[field] !== "string" || binding[field].length === 0) {
      throw new InstanceKernelError(
        "INVALID_MANAGED_BINDING",
        `Managed run binding ${field} must be a non-empty string`
      );
    }
  }
  if (!Number.isSafeInteger(binding.fence) || binding.fence < 1) {
    throw new InstanceKernelError(
      "INVALID_MANAGED_BINDING",
      "Managed run binding fence must be a positive safe integer"
    );
  }
  const scope = requireKeyedScopePath(binding.scope);
  const candidate = {
    managedRunId: binding.managedRunId,
    sessionId: binding.sessionId,
    checkId: binding.checkId,
    scope,
    nodeInstanceId: binding.nodeInstanceId,
    nodeGenerationId: binding.nodeGenerationId,
    attemptId: binding.attemptId,
    fence: binding.fence
  };
  if (deriveManagedRunId(candidate) !== candidate.managedRunId) {
    throw new InstanceKernelError(
      "INVALID_MANAGED_BINDING",
      "Managed run ID is not derived from its exact controller binding"
    );
  }
  return candidate;
}
function requireManagedEventShape(event) {
  const common = ["version", "type", "eventId", "sessionId", "scope", "binding"];
  const expected = event.type === "ManagedRunAcquisitionFailed" ? [...common, "failureCode"] : event.type === "ManagedRunCancelRequested" ? [...common, "reason"] : event.type === "ManagedRunTerminated" ? [...common, "cleanupStatus", "controllerDecision", "failureCode"] : common;
  if (!hasExactKeys(event, expected)) {
    throw new InstanceKernelError("INVALID_MANAGED_EVENT", `${event.type} has unknown or missing fields`);
  }
}
function requireCurrentManagedBinding(projection, event) {
  requireManagedEventShape(event);
  const binding = requireManagedRunBinding(event.binding);
  if (event.sessionId !== binding.sessionId || !scopePathEquals(event.scope, binding.scope)) {
    throw new InstanceKernelError(
      "INVALID_MANAGED_BINDING",
      "Managed lifecycle envelope does not match its complete binding"
    );
  }
  const generation = requireGeneration(projection, binding);
  const instance = requireInstance(projection, generation.subgraphInstanceId, binding.scope);
  if (projection.attemptBindingsById[binding.attemptId] !== binding.nodeGenerationId || instance.sessionId !== binding.sessionId || generation.checkId !== binding.checkId || generation.nodeInstanceId !== binding.nodeInstanceId || generation.nodeGenerationId !== binding.nodeGenerationId || generation.status !== "running" || generation.attemptId !== binding.attemptId || generation.fence !== binding.fence || !generation.scheduled) {
    throw new InstanceKernelError(
      "INVALID_MANAGED_BINDING",
      "Managed run binding is not the exact current scheduled running attempt"
    );
  }
  return binding;
}
function generatedAttemptMatchesManagedBinding(event, binding) {
  return event.sessionId === binding.sessionId && event.checkId === binding.checkId && scopePathEquals(event.scope, binding.scope) && event.nodeInstanceId === binding.nodeInstanceId && event.nodeGenerationId === binding.nodeGenerationId && event.attemptId === binding.attemptId && event.fence === binding.fence;
}
function reduceManagedRunLifecycle(projection, next, event) {
  const binding = requireCurrentManagedBinding(projection, event);
  const current = projection.managedRunsByAttemptId[binding.attemptId];
  if (current && !managedBindingEquals(current.binding, binding)) {
    throw new InstanceKernelError(
      "INVALID_MANAGED_BINDING",
      "Managed attempt index resolved to a different complete binding"
    );
  }
  if (event.type === "ManagedRunAcquisitionFailed") {
    if (current || !MANAGED_RUN_ACQUISITION_FAILURE_CODES.has(event.failureCode)) {
      throw new InstanceKernelError(
        current ? "MANAGED_RUN_ALREADY_ACQUIRED" : "INVALID_MANAGED_FAILURE_CODE",
        "Managed acquisition failure is duplicate or has an invalid stable code"
      );
    }
    next.managedRunsByAttemptId[binding.attemptId] = {
      binding,
      status: "acquisition_failed",
      controllerDecision: "failed",
      failureCode: event.failureCode
    };
    return;
  }
  if (event.type === "ManagedRunAcquired") {
    if (current) {
      throw new InstanceKernelError("MANAGED_RUN_ALREADY_ACQUIRED", "Managed run was already acquired");
    }
    next.managedRunsByAttemptId[binding.attemptId] = { binding, status: "acquired" };
    return;
  }
  if (!current || current.status === "acquisition_failed" || current.status === "terminated") {
    throw new InstanceKernelError(
      "INVALID_MANAGED_TRANSITION",
      "Managed lifecycle event requires one matching nonterminal acquired run"
    );
  }
  if (event.type === "ManagedRunStarted") {
    if (current.status !== "acquired") {
      throw new InstanceKernelError("INVALID_MANAGED_TRANSITION", "Managed run start is duplicate or late");
    }
    next.managedRunsByAttemptId[binding.attemptId] = { ...current, status: "started" };
    return;
  }
  if (event.type === "ManagedRunCancelRequested") {
    if (event.reason !== "deadline" || current.status === "cancel_requested") {
      throw new InstanceKernelError(
        "INVALID_MANAGED_TRANSITION",
        "Managed cancellation must be one current-fence deadline request"
      );
    }
    next.managedRunsByAttemptId[binding.attemptId] = {
      ...current,
      status: "cancel_requested",
      cancellationRequested: true
    };
    return;
  }
  const completed = event.controllerDecision === "completed";
  const failed = event.controllerDecision === "failed";
  const cleanupIsValid = event.cleanupStatus === "clean" || event.cleanupStatus === "unverified";
  const failureCodeIsValid = event.failureCode !== null && MANAGED_RUN_FAILURE_CODES.has(event.failureCode);
  const acquisitionCodeUsedAsTerminal = event.failureCode !== null && MANAGED_RUN_ACQUISITION_FAILURE_CODES.has(event.failureCode);
  const unverifiedCode = event.failureCode !== null && MANAGED_RUN_UNVERIFIED_CLEANUP_FAILURE_CODES.has(event.failureCode);
  const cancelPathCode = event.failureCode !== null && MANAGED_RUN_CANCEL_PATH_FAILURE_CODES.has(event.failureCode);
  const cancelOnlyCode = event.failureCode !== null && MANAGED_RUN_CANCEL_ONLY_FAILURE_CODES.has(event.failureCode);
  const cancelWasRequested = current.status === "cancel_requested";
  if (!cleanupIsValid || !completed && !failed || completed && (event.cleanupStatus !== "clean" || event.failureCode !== null || cancelWasRequested) || !completed && (!failureCodeIsValid || acquisitionCodeUsedAsTerminal || event.cleanupStatus === "unverified" !== unverifiedCode || (cancelWasRequested ? !cancelPathCode : cancelOnlyCode))) {
    throw new InstanceKernelError(
      "INVALID_MANAGED_TERMINAL",
      "Managed terminal cleanup, decision, and failure code are inconsistent"
    );
  }
  next.managedRunsByAttemptId[binding.attemptId] = {
    ...current,
    status: "terminated",
    cleanupStatus: event.cleanupStatus,
    controllerDecision: event.controllerDecision,
    ...event.failureCode === null ? {} : { failureCode: event.failureCode }
  };
}
function hasReadyOrRunningGeneration(projection) {
  return Object.values(projection.generationsById).some(
    (generation) => generation.status === "ready" || generation.status === "running"
  );
}
function hasActiveDescendantInstance(projection, generation) {
  return Object.values(projection.instancesById).some(
    (instance) => instance.status === "active" && instance.parentSubgraphInstanceId === generation.subgraphInstanceId && instance.expansionOwnerNodeInstanceId === generation.nodeInstanceId
  );
}
function reduceGeneratedAttemptRetry(projection, next, event) {
  const generation = requireGeneration(projection, event);
  const instance = requireInstance(projection, generation.subgraphInstanceId, event.scope);
  const expectedKeys = [
    "version",
    "type",
    "eventId",
    "sessionId",
    "scope",
    "nodeInstanceId",
    "nodeGenerationId",
    "checkId",
    "incarnation",
    "itemFingerprint",
    "executionConfigDigest",
    "activeInputClaimIds",
    "priorAttemptId",
    "priorFence",
    "priorFailureReason",
    "externalSideEffects"
  ];
  if (!hasExactKeys(event, expectedKeys)) {
    throw new InstanceKernelError("INVALID_RETRY", "Retry event has unknown or missing fields");
  }
  if (event.sessionId !== instance.sessionId || event.checkId !== generation.checkId || event.incarnation !== generation.incarnation || event.itemFingerprint !== generation.itemFingerprint || event.executionConfigDigest !== generation.executionConfigDigest || event.nodeInstanceId !== generation.nodeInstanceId || event.nodeGenerationId !== generation.nodeGenerationId || generation.status !== "failed" || generation.scheduled !== true || generation.attemptId !== event.priorAttemptId || generation.fence !== event.priorFence || generation.reason !== event.priorFailureReason || generation.completedOutputClaimIds.length !== 0 || event.externalSideEffects !== "absent" && event.externalSideEffects !== "safely_idempotent" && event.externalSideEffects !== "isolated_draft_replay") {
    throw new InstanceKernelError(
      "INVALID_RETRY",
      "Retry event is not bound to the exact failed generated attempt"
    );
  }
  const inputClaimIds = sortedUnique(event.activeInputClaimIds, "Retry input claim IDs");
  if (!sameStrings(inputClaimIds, generation.activeInputClaimIds)) {
    throw new InstanceKernelError("INVALID_RETRY", "Retry input claims are not the exact generation inputs");
  }
  for (const claimId of inputClaimIds) {
    const claim = projection.claimsById[claimId];
    if (!claim || !claim.active) {
      throw new InstanceKernelError("INVALID_RETRY", "Retry input claim is no longer active");
    }
  }
  if (hasActiveDescendantInstance(projection, generation)) {
    throw new InstanceKernelError("INVALID_RETRY", "Retry generation has active descendant instances");
  }
  const managed = projection.managedRunsByAttemptId[event.priorAttemptId];
  if (managed && (managed.status !== "terminated" || managed.cleanupStatus !== "clean")) {
    throw new InstanceKernelError("INVALID_RETRY", "Retry prior managed run is not cleanly terminal");
  }
  const {
    attemptId: _attemptId,
    fence: _fence,
    reason: _reason,
    ...withoutCurrentAttempt
  } = generation;
  void _attemptId;
  void _fence;
  void _reason;
  next.generationsById[event.nodeGenerationId] = {
    ...withoutCurrentAttempt,
    status: "ready",
    scheduled: false
  };
}
function reduceRequestLifecycle(projection, next, event) {
  requireRootScopePath(event.scope);
  const request = projection.requestsById[event.requestId];
  if (!request || request.expansionOwnerCheck !== event.checkId || request.sessionId !== event.sessionId) {
    throw new InstanceKernelError("INVALID_REQUEST_BINDING", `Request ${event.requestId} is misbound`);
  }
  if (event.type === "AttemptStarted") {
    if (request.status !== "pending") {
      throw new InstanceKernelError("INVALID_REQUEST_STATE", `Request ${event.requestId} is not pending`);
    }
    const oldestNonterminal = projection.requestOrder.find(
      (requestId) => {
        const status = projection.requestsById[requestId].status;
        return status === "pending" || status === "running";
      }
    );
    const hasRunningRequest = Object.values(projection.requestsById).some(
      (candidate) => candidate.status === "running"
    );
    if (oldestNonterminal !== event.requestId || hasRunningRequest || hasReadyOrRunningGeneration(projection)) {
      throw new InstanceKernelError(
        "GENERATED_WORK_PRECEDES_REQUEST",
        "Catalog request cannot start before older requests or generated work"
      );
    }
    if (projection.attemptBindingsById[event.attemptId]) {
      throw new InstanceKernelError("DUPLICATE_ATTEMPT", `Attempt ${event.attemptId} already exists`);
    }
    next.requestsById[event.requestId] = {
      ...request,
      status: "running",
      attemptId: event.attemptId,
      fence: event.fence
    };
    next.attemptBindingsById[event.attemptId] = event.requestId;
    return;
  }
  requireAttemptBinding(projection, event);
  if (request.status !== "running" || request.attemptId !== event.attemptId || request.fence !== event.fence) {
    throw new InstanceKernelError("INVALID_REQUEST_STATE", `Request ${event.requestId} is not running`);
  }
  if (event.type === "CheckScheduled") return;
  if (event.type === "AttemptCompleted") {
    if (!SHA256_PATTERN.test(event.catalogClaimId)) {
      throw new InstanceKernelError("INVALID_REQUEST_CATALOG", "Completed request catalog claim ID is invalid");
    }
    next.requestsById[event.requestId] = {
      ...request,
      status: "completed",
      catalogClaimId: event.catalogClaimId
    };
    return;
  }
  next.requestsById[event.requestId] = {
    ...request,
    status: "failed",
    reason: event.reason
  };
}
function reduceGeneratedLifecycle(projection, next, event) {
  const generation = requireGeneration(projection, event);
  const instance = requireInstance(projection, generation.subgraphInstanceId, event.scope);
  if (event.checkId !== generation.checkId || instance.incarnation !== generation.incarnation) {
    throw new InstanceKernelError("INVALID_GENERATION_BINDING", "Generated event has stale check or incarnation");
  }
  if (event.type === "AttemptStarted") {
    if (generation.status !== "ready") {
      throw new InstanceKernelError("GENERATION_NOT_READY", `Generation ${event.nodeGenerationId} is not ready`);
    }
    if (projection.attemptBindingsById[event.attemptId]) {
      throw new InstanceKernelError("DUPLICATE_ATTEMPT", `Attempt ${event.attemptId} already exists`);
    }
    next.generationsById[event.nodeGenerationId] = {
      ...generation,
      status: "running",
      attemptId: event.attemptId,
      fence: event.fence
    };
    next.attemptBindingsById[event.attemptId] = event.nodeGenerationId;
    return;
  }
  requireAttemptBinding(projection, event);
  if (generation.status !== "running" || generation.attemptId !== event.attemptId || generation.fence !== event.fence) {
    throw new InstanceKernelError("STALE_FENCE", `Attempt ${event.attemptId} is not current`);
  }
  if (event.type === "CheckScheduled") {
    const claimIds = sortedUnique(event.claimIds, "Scheduled claim IDs");
    if (!sameStrings(claimIds, generation.activeInputClaimIds)) {
      throw new InstanceKernelError(
        "INVALID_SCHEDULED_CLAIMS",
        "Generated check was not scheduled with its exact activated inputs"
      );
    }
    next.generationsById[event.nodeGenerationId] = { ...generation, scheduled: true };
    return;
  }
  if (!generation.scheduled) {
    throw new InstanceKernelError("ATTEMPT_NOT_SCHEDULED", `Attempt ${event.attemptId} is not scheduled`);
  }
  const managed = projection.managedRunsByAttemptId[event.attemptId];
  if (managed) {
    if (!generatedAttemptMatchesManagedBinding(
      event,
      managed.binding
    )) {
      throw new InstanceKernelError(
        "INVALID_MANAGED_BINDING",
        "Generated event does not match the complete managed run binding"
      );
    }
    if (event.type === "ClaimPublished") {
      if (managed.status !== "terminated" || managed.cleanupStatus !== "clean" || managed.controllerDecision !== "completed" || managed.failureCode !== void 0) {
        throw new InstanceKernelError(
          "MANAGED_TERMINAL_REQUIRED",
          "Managed claims require a clean controller-completed terminal fact"
        );
      }
    } else if (event.type === "AttemptCompleted") {
      if (managed.status !== "terminated" || managed.cleanupStatus !== "clean" || managed.controllerDecision !== "completed" || managed.failureCode !== void 0) {
        throw new InstanceKernelError(
          "MANAGED_TERMINAL_REQUIRED",
          "Managed completion requires a clean controller-completed terminal fact"
        );
      }
    } else if (event.type === "AttemptFailed") {
      if (managed.status !== "acquisition_failed" && managed.status !== "terminated" || managed.controllerDecision !== "failed" || managed.failureCode === void 0 || event.reason !== managed.failureCode) {
        throw new InstanceKernelError(
          "MANAGED_TERMINAL_REQUIRED",
          "Managed failure requires its controller-failed lifecycle terminal and stable code"
        );
      }
    }
  }
  if (event.type === "ClaimPublished") {
    if (event.wireMode !== "generic" && event.wireMode !== "proof") {
      throw new InstanceKernelError("INVALID_WIRE_MODE", "Generated claim wire mode is invalid");
    }
    if (event.producerCheckId !== generation.checkId) {
      throw new InstanceKernelError("INVALID_GENERATION_BINDING", "Generated claim has wrong producer");
    }
    const projectReconciliationPublication = generation.templateNodeKey === PROOF_PROJECT_RECONCILE_NODE_KEY && generation.checkId === PROOF_PROJECT_RECONCILE_NODE_KEY && event.checkId === PROOF_PROJECT_RECONCILE_NODE_KEY && event.producerCheckId === PROOF_PROJECT_RECONCILE_NODE_KEY && event.claim === PROOF_PROJECT_RECONCILIATION_RECEIPT_CLAIM;
    if (event.claim === PROOF_PROJECT_RECONCILIATION_RECEIPT_CLAIM && !projectReconciliationPublication) {
      throw new InstanceKernelError(
        "INVALID_GENERATION_BINDING",
        "Project reconciliation receipts are reserved for the exact project_reconcile generation"
      );
    }
    if (projectReconciliationPublication && event.wireMode !== "proof") {
      throw new InstanceKernelError(
        "INVALID_WIRE_MODE",
        "Project reconciliation receipts require Proof wire identity"
      );
    }
    const expectedParentClaimIds = projectReconciliationPublication ? deriveProofProjectReconciliationParentClaimIds(projection, generation) : generation.activeInputClaimIds;
    if (!sameStrings(event.parentClaimIds, expectedParentClaimIds)) {
      throw new InstanceKernelError("INVALID_PARENT_CLAIMS", "Generated claim has wrong exact parents");
    }
    const payloadFingerprint = governedPayloadFingerprint(event.payload, event.wireMode);
    if (payloadFingerprint !== event.payloadFingerprint) {
      throw new InstanceKernelError("INVALID_PAYLOAD_FINGERPRINT", "Generated claim fingerprint is invalid");
    }
    const hasEvidence = event.proofCandidateEvidence !== void 0 || event.proofCandidateEvidenceFingerprint !== void 0;
    const proofRevalidationPublication = event.claim === PROOF_CATALOG_REVALIDATION_CLAIM && event.checkId === "revalidate_catalog" && generation.templateNodeKey === "revalidate_catalog";
    const proofManagedPublication = proofRevalidationPublication || projectReconciliationPublication;
    if (proofManagedPublication) {
      const managedRun = projection.managedRunsByAttemptId[event.attemptId];
      if (!managedRun || managedRun.status !== "terminated" || managedRun.cleanupStatus !== "clean" || managedRun.controllerDecision !== "completed" || managedRun.failureCode !== void 0) {
        throw new InstanceKernelError("MANAGED_TERMINAL_REQUIRED", "Proof publications require a clean managed terminal");
      }
    }
    if (isGovernedCandidateClaim(event.claim)) {
      const stagedCandidate = event.claim === PROOF_COMPONENT_SPEC_REVIEW_CANDIDATE_CLAIM;
      if ((stagedCandidate ? generation.templateNodeKey !== "spec_review" || event.checkId !== "spec_review" : generation.templateNodeKey !== "inspect" || event.checkId !== "inspect") || event.proofCandidateEvidence === void 0 || typeof event.proofCandidateEvidenceFingerprint !== "string" || event.proofCandidateEvidenceFingerprint !== proofCandidateEvidenceFingerprint(event.proofCandidateEvidence)) {
        throw new InstanceKernelError("INVALID_PROOF_EVIDENCE", "Proof candidate publication requires its exact evidence sidecar");
      }
      try {
        const evidence = validateProofCandidateEvidence(event.proofCandidateEvidence);
        if (event.wireMode !== governedWireModeFromEvidence(evidence)) throw new Error("wire mode is detached from governed invocation");
        const parentClaims = generation.activeInputClaimIds.map((claimId2) => projection.claimsById[claimId2]).filter((claim) => claim !== void 0);
        if (parentClaims.length !== generation.activeInputClaimIds.length) throw new Error("activated parent claim is missing");
        if (stagedCandidate) {
          const invocation = evidence.role.invocation;
          if (invocation.role_id !== "spec-review" || invocation.stance !== "owner" || invocation.onboarding_stage === void 0 || !invocation.component_authority) throw new Error("staged candidate invocation is not the exact spec-review selector");
          const component = parentClaims.find((claim) => claim.claim === "component.work_item@1");
          const candidate = parentClaims.find((claim) => claim.claim === PROOF_CANDIDATE_CLAIM);
          const admission = parentClaims.find((claim) => claim.claim === PROOF_ADMITTED_RECEIPT_CLAIM);
          if (parentClaims.length !== 3 || !component || !candidate || !admission || new Set(parentClaims.map((claim) => claim.claimId)).size !== 3 || parentClaims.some((claim) => !claim.active || claim.subgraphInstanceId !== generation.subgraphInstanceId || canonicalJson(claim.scope) !== canonicalJson(generation.scope)) || component.kind !== "controller-item" || candidate.kind !== "generated-output" || admission.kind !== "generated-output" || component.parentClaimIds.length !== 1 || admission.parentClaimIds.length !== 1 || admission.parentClaimIds[0] !== candidate.claimId || candidate.producerCheckId !== "inspect" || admission.producerCheckId !== PROOF_ADMIT_NODE_KEY) throw new Error("staged candidate parent lineage is invalid");
          const componentInstance = projection.instancesById[generation.subgraphInstanceId];
          let componentOwner;
          try {
            componentOwner = JSON.parse(component.producerCheckId);
          } catch {
            componentOwner = void 0;
          }
          if (!Array.isArray(componentOwner) || componentOwner.length !== 2 || typeof componentOwner[0] !== "string" || componentOwner[0].length === 0 || componentOwner[1] !== "materialize_catalog" || component.producerCheckId !== componentInstance?.expansionOwnerCheck) throw new Error("staged component owner is not the exact materialize_catalog expansion");
          const stage = validateOnboardingStageContext(invocation.onboarding_stage);
          if (typeof stage.prior_candidate !== "string" || typeof stage.prior_admission !== "string" || stage.prior_admission_claim_id !== admission.claimId || stage.prior_admission_payload_fingerprint !== admission.payloadFingerprint) throw new Error("staged candidate predecessor context is detached");
          const priorEnvelope = JSON.parse(stage.prior_candidate);
          const publication = priorEnvelope.Publication;
          const admissionPayload = admission.payload;
          if (proofComponentCandidateEnvelopeJson(priorEnvelope) !== stage.prior_candidate || publication?.ClaimID !== candidate.claimId || publication.Claim !== candidate.claim || publication.PayloadFingerprint !== candidate.payloadFingerprint || canonicalJson(publication.ParentClaimIDs) !== canonicalJson(candidate.parentClaimIds) || admissionPayload[PROOF_ADMISSION_WIRE_FIELD] !== stage.prior_admission) throw new Error("staged candidate predecessor wire is detached");
          const componentPayload = component.payload;
          const componentSubject = componentPayload.proof_component_subject;
          const compactAuthority = componentPayload.authority;
          const invocationSubject = invocation.subject;
          const invocationAuthority = invocation.component_authority;
          if (!componentPayload || !componentSubject || !compactAuthority || !invocationSubject || !invocationAuthority || canonicalJson(invocationSubject) !== canonicalJson({ kind: "component", id: componentPayload.component_id, fingerprint: componentSubject.fingerprint }) || !invocationAuthority.subject || canonicalJson(invocationAuthority.subject) !== canonicalJson(componentSubject) || invocationAuthority.work_item_digest !== compactAuthority.work_item_digest) throw new Error("staged candidate component authority is detached");
          validateProofComponentCandidateAdmissionBinding(currentAuthorityClaimView(candidate), currentAuthorityClaimView(admission));
        } else {
          validateGovernedProofRuntimeContextAgainstClaims(evidence, parentClaims, {
            managedRunId: "kernel-validation",
            sessionId: event.sessionId,
            checkId: event.checkId,
            scope: event.scope,
            nodeInstanceId: event.nodeInstanceId,
            nodeGenerationId: event.nodeGenerationId,
            attemptId: event.attemptId,
            fence: event.fence
          });
        }
        const payloadJson = governedCanonicalJson(event.payload, event.wireMode);
        const identity = event.proofCandidateEvidence.probe.resultIdentity;
        if (identity.resultDigest !== governedResultDigest(event.payload, event.wireMode) || identity.canonicalBytes !== Buffer.byteLength(payloadJson, "utf8")) throw new Error("result identity is detached from canonical claim payload");
      } catch {
        throw new InstanceKernelError("INVALID_PROOF_EVIDENCE", "Proof candidate evidence is invalid or detached");
      }
      if (!managed || managed.status !== "terminated" || managed.cleanupStatus !== "clean" || managed.controllerDecision !== "completed" || managed.failureCode !== void 0) {
        throw new InstanceKernelError("MANAGED_TERMINAL_REQUIRED", "Proof candidate publication requires a clean managed terminal");
      }
    } else if (hasEvidence || !proofManagedPublication && event.wireMode !== "generic") {
      throw new InstanceKernelError("INVALID_PROOF_EVIDENCE", "Evidence sidecars are reserved for proof candidates");
    }
    const claimIdentity = {
      claim: event.claim,
      payloadFingerprint,
      producerCheckId: event.checkId,
      scope: event.scope,
      attemptId: event.attemptId,
      fence: event.fence,
      parentClaimIds: [...event.parentClaimIds].sort(),
      ...isGovernedCandidateClaim(event.claim) ? { proofCandidateEvidenceFingerprint: event.proofCandidateEvidenceFingerprint } : {}
    };
    const claimId = sha256Canonical(claimIdentity);
    if (claimId !== event.claimId || projection.claimsById[event.claimId]) {
      throw new InstanceKernelError("INVALID_CLAIM_ID", "Generated claim ID is invalid or duplicate");
    }
    next.claimsById[event.claimId] = {
      claimId: event.claimId,
      claim: event.claim,
      payload: immutableGovernedValue(event.payload, event.wireMode),
      payloadFingerprint,
      producerCheckId: event.producerCheckId,
      producerAttemptId: event.attemptId,
      producerFence: event.fence,
      parentClaimIds: [...event.parentClaimIds],
      wireMode: event.wireMode,
      scope: requireKeyedScopePath(event.scope, instance.scope),
      active: true,
      kind: "generated-output",
      subgraphInstanceId: instance.subgraphInstanceId,
      incarnation: generation.incarnation,
      nodeGenerationId: generation.nodeGenerationId,
      ...isGovernedCandidateClaim(event.claim) ? {
        proofCandidateEvidence: immutableProofCandidateEvidence(event.proofCandidateEvidence),
        proofCandidateEvidenceFingerprint: event.proofCandidateEvidenceFingerprint
      } : {}
    };
    next.generationsById[event.nodeGenerationId] = {
      ...generation,
      completedOutputClaimIds: [...generation.completedOutputClaimIds, event.claimId]
    };
    return;
  }
  if (event.type === "AttemptFailed" && generation.completedOutputClaimIds.length > 0) {
    throw new InstanceKernelError("PARTIAL_CLAIM_PUBLICATION", "Failed generation has published claims");
  }
  next.generationsById[event.nodeGenerationId] = {
    ...generation,
    status: event.type === "AttemptCompleted" ? "completed" : "failed",
    ...event.type === "AttemptFailed" ? { reason: event.reason } : {}
  };
}
function reduceInstanceEventInternal(projection, event, context) {
  if (event.version !== 1) {
    throw new InstanceKernelError("UNSUPPORTED_EVENT_VERSION", "Unsupported event version");
  }
  if (!Number.isSafeInteger(event.eventId) || event.eventId <= projection.lastEventId) {
    throw new InstanceKernelError("NON_MONOTONIC_EVENT", "C2 event IDs must advance monotonically");
  }
  validateTaggedScopePath(event.scope);
  const next = mutableProjection(projection);
  next.lastEventId = event.eventId;
  switch (event.type) {
    case "ProofCurrentCatalogAuthorityApplied":
      validateProofAppliedHeader(event);
      throw new InstanceKernelError("INVALID_PROOF_CURRENT_APPLICATION", "Proof authority application header requires its exact mutation batch");
    case "CatalogReconciliationRequested": {
      requireRootScopePath(event.scope);
      if (event.status !== "pending" || !Number.isSafeInteger(event.requestOrdinal) || event.requestOrdinal < 1 || event.requestId !== deriveCatalogRequestId({
        sessionId: event.sessionId,
        expansionOwnerCheck: event.expansionOwnerCheck,
        ordinal: event.requestOrdinal
      })) {
        throw new InstanceKernelError("INVALID_REQUEST_ID", "Catalog request identity is invalid");
      }
      if (projection.requestsById[event.requestId]) {
        throw new InstanceKernelError("DUPLICATE_REQUEST", `Request ${event.requestId} already exists`);
      }
      next.requestsById[event.requestId] = {
        requestId: event.requestId,
        requestOrdinal: event.requestOrdinal,
        sessionId: event.sessionId,
        expansionOwnerCheck: event.expansionOwnerCheck,
        status: "pending"
      };
      next.requestOrder.push(event.requestId);
      break;
    }
    case "SubgraphExpanded": {
      const itemKey = canonicalCatalogKey(event.itemKey);
      const commonKeys = [
        "version",
        "type",
        "eventId",
        "sessionId",
        "scope",
        "expansionOwnerCheck",
        "graphSemanticDigest",
        "expansionSpecDigest",
        "templateDigest",
        "parentSubgraphInstanceId",
        "catalogClaimId",
        "itemKey",
        "subgraphInstanceId",
        "nodeInstanceIdsByTemplateNode"
      ];
      const nested = event.parentSubgraphInstanceId !== null;
      if (!hasExactKeys(
        event,
        nested ? [...commonKeys, "expansionOwnerNodeInstanceId", "catalogClaimRef"] : commonKeys
      )) {
        throw new InstanceKernelError("INVALID_EXPANSION", "Expanded subgraph event shape is invalid");
      }
      let catalogProducer;
      let expectedId;
      let expectedScope;
      if (nested) {
        if (!event.expansionOwnerNodeInstanceId) {
          throw new InstanceKernelError("INVALID_INSTANCE_ID", "Nested owner node is required");
        }
        requireNonEmpty(event.catalogClaimRef, "Nested catalog claim reference");
        const parent = requireInstance(
          projection,
          event.parentSubgraphInstanceId,
          projection.instancesById[event.parentSubgraphInstanceId]?.scope
        );
        if (parent.sessionId !== event.sessionId) {
          throw new InstanceKernelError("INVALID_INSTANCE_ID", "Nested parent session is invalid");
        }
        catalogProducer = requireNestedCatalogAuthority(projection, {
          parentSubgraphInstanceId: parent.subgraphInstanceId,
          expansionOwnerNodeInstanceId: event.expansionOwnerNodeInstanceId,
          catalogClaimId: event.catalogClaimId
        });
        if (event.catalogClaimRef !== catalogProducer.nestedExpansionCatalogClaimRef) {
          throw new InstanceKernelError(
            "INVALID_NESTED_CATALOG_LINEAGE",
            "Nested child catalog declaration does not match its parent generation authority"
          );
        }
        expectedId = deriveSubgraphInstanceId({
          graphSemanticDigest: event.graphSemanticDigest,
          parentSubgraphInstanceId: parent.subgraphInstanceId,
          expansionOwnerNodeInstanceId: event.expansionOwnerNodeInstanceId,
          templateDigest: event.templateDigest,
          itemKey
        });
        expectedScope = Object.freeze([
          ...parent.scope,
          {
            kind: "keyed",
            expansionOwnerCheck: event.expansionOwnerCheck,
            key: itemKey,
            subgraphInstanceId: expectedId
          }
        ]);
      } else {
        expectedId = deriveSubgraphInstanceId({
          graphSemanticDigest: event.graphSemanticDigest,
          expansionOwnerCheck: event.expansionOwnerCheck,
          parentSubgraphInstanceId: null,
          templateDigest: event.templateDigest,
          itemKey
        });
        expectedScope = Object.freeze([{
          kind: "keyed",
          expansionOwnerCheck: event.expansionOwnerCheck,
          key: itemKey,
          subgraphInstanceId: expectedId
        }]);
      }
      const scope = requireKeyedScopePath(event.scope, expectedScope);
      if (event.subgraphInstanceId !== expectedId) {
        throw new InstanceKernelError("INVALID_INSTANCE_ID", "Subgraph instance identity is invalid");
      }
      const indexKey = ownerKey(
        event.expansionOwnerCheck,
        itemKey,
        event.parentSubgraphInstanceId,
        event.expansionOwnerNodeInstanceId
      );
      if (projection.instanceIdByOwnerAndKey[indexKey]) {
        throw new InstanceKernelError(
          "TOMBSTONED_KEY_READD_UNSUPPORTED",
          `Expansion key ${itemKey} was already observed`
        );
      }
      const entries = Object.entries(event.nodeInstanceIdsByTemplateNode).sort(
        ([a], [b]) => a.localeCompare(b)
      );
      if (entries.length === 0) {
        throw new InstanceKernelError("INVALID_EXPANSION", "Expanded subgraph must contain nodes");
      }
      for (const [templateNodeKey, nodeInstanceId] of entries) {
        requireNonEmpty(templateNodeKey, "Template node key");
        if (nodeInstanceId !== deriveNodeInstanceId({ subgraphInstanceId: expectedId, templateNodeKey }) || projection.nodesById[nodeInstanceId]) {
          throw new InstanceKernelError("INVALID_NODE_INSTANCE_ID", "Node instance identity is invalid");
        }
        next.nodesById[nodeInstanceId] = {
          nodeInstanceId,
          subgraphInstanceId: expectedId,
          templateNodeKey,
          scope
        };
      }
      next.instancesById[expectedId] = {
        sessionId: event.sessionId,
        expansionOwnerCheck: event.expansionOwnerCheck,
        graphSemanticDigest: event.graphSemanticDigest,
        expansionSpecDigest: event.expansionSpecDigest,
        templateDigest: event.templateDigest,
        itemKey,
        subgraphInstanceId: expectedId,
        scope,
        catalogClaimId: event.catalogClaimId,
        ...nested ? {
          parentSubgraphInstanceId: event.parentSubgraphInstanceId,
          expansionOwnerNodeInstanceId: event.expansionOwnerNodeInstanceId,
          catalogClaimRef: catalogProducer.nestedExpansionCatalogClaimRef,
          catalogProducerNodeGenerationId: catalogProducer.nodeGenerationId
        } : {},
        nodeInstanceIdsByTemplateNode: { ...event.nodeInstanceIdsByTemplateNode },
        status: "active",
        incarnation: 0
      };
      next.instanceIdByOwnerAndKey[indexKey] = expectedId;
      break;
    }
    case "ProofCurrentCatalogAuthorityRecorded": {
      if (!hasExactKeys(event, [
        "version",
        "type",
        "eventId",
        "sessionId",
        "scope",
        "projectSubgraphInstanceId",
        "sourceCatalogClaimId",
        "previousAuthorityId",
        "authorityId",
        "revalidationBytesBase64",
        "workItemsBytesBase64"
      ])) {
        throw new InstanceKernelError("INVALID_PROOF_CURRENT_AUTHORITY", "Current Proof authority event has unknown or missing fields");
      }
      const scope = requireKeyedScopePath(event.scope);
      if (scope.length !== 1 || typeof event.sessionId !== "string" || event.sessionId.length === 0 || !SHA256_PATTERN.test(event.projectSubgraphInstanceId) || !SHA256_PATTERN.test(event.sourceCatalogClaimId) || !SHA256_PATTERN.test(event.previousAuthorityId) || !SHA256_PATTERN.test(event.authorityId) || typeof event.revalidationBytesBase64 !== "string" || typeof event.workItemsBytesBase64 !== "string") {
        throw new InstanceKernelError("INVALID_PROOF_CURRENT_AUTHORITY", "Current Proof authority envelope is invalid");
      }
      const project = projection.instancesById[event.projectSubgraphInstanceId];
      if (!project || project.status !== "active" || project.sessionId !== event.sessionId || !scopePathEquals(project.scope, scope)) {
        throw new InstanceKernelError("INVALID_PROOF_CURRENT_AUTHORITY", "Current Proof authority is not bound to its exact project");
      }
      const source = projection.claimsById[event.sourceCatalogClaimId];
      const sourceGeneration = source?.nodeGenerationId ? projection.generationsById[source.nodeGenerationId] : void 0;
      if (!source || !source.active || source.claim !== "component.catalog@1" || source.kind !== "generated-output" || source.producerCheckId !== "materialize_catalog" || !scopePathEquals(source.scope, scope) || !sourceGeneration || sourceGeneration.status !== "completed" || sourceGeneration.checkId !== "materialize_catalog" || source.producerAttemptId !== sourceGeneration.attemptId || source.producerFence !== sourceGeneration.fence || !sourceGeneration.scheduled || projection.activeGenerationIdByNode[sourceGeneration.nodeInstanceId] !== sourceGeneration.nodeGenerationId || sourceGeneration.completedOutputClaimIds.length !== 1 || sourceGeneration.completedOutputClaimIds[0] !== source.claimId) {
        throw new InstanceKernelError("INVALID_PROOF_CURRENT_AUTHORITY", "Source catalog is not the exact completed materialize_catalog output");
      }
      const previous = (projection.currentProofCatalogAuthorityByProject || {})[event.projectSubgraphInstanceId];
      const expectedPrevious = previous?.authorityId || event.sourceCatalogClaimId;
      if (event.previousAuthorityId !== expectedPrevious || previous && previous.sourceCatalogClaimId !== event.sourceCatalogClaimId) {
        throw new InstanceKernelError("INVALID_PROOF_CURRENT_AUTHORITY", "Current Proof authority CAS predecessor is stale");
      }
      const parents = source.parentClaimIds;
      if (parents.length !== 4 || parents.some((id, index) => id !== [...parents].sort()[index]) || new Set(parents).size !== 4) {
        throw new InstanceKernelError("INVALID_PROOF_CURRENT_AUTHORITY", "Source catalog parent lineage is not exact");
      }
      const parentClaims = parents.map((id) => projection.claimsById[id]);
      if (parentClaims.some((parentClaim) => !parentClaim || !parentClaim.active || !scopePathEquals(parentClaim.scope, scope))) {
        throw new InstanceKernelError("INVALID_PROOF_CURRENT_AUTHORITY", "Source catalog has an inactive or foreign parent");
      }
      const candidate = parentClaims.find((parentClaim) => parentClaim?.claim === PROOF_CANDIDATE_CLAIM);
      const admission = parentClaims.find((parentClaim) => parentClaim?.claim === PROOF_ADMITTED_RECEIPT_CLAIM);
      const inventory = parentClaims.find((parentClaim) => parentClaim?.claim === PROOF_STRUCTURAL_INVENTORY_CLAIM);
      const revalidation = parentClaims.find((parentClaim) => parentClaim?.claim === PROOF_CATALOG_REVALIDATION_CLAIM);
      if (!candidate || !admission || !inventory || !revalidation || parentClaims.filter((parentClaim) => parentClaim?.claim === PROOF_CANDIDATE_CLAIM).length !== 1 || parentClaims.filter((parentClaim) => parentClaim?.claim === PROOF_ADMITTED_RECEIPT_CLAIM).length !== 1 || parentClaims.filter((parentClaim) => parentClaim?.claim === PROOF_STRUCTURAL_INVENTORY_CLAIM).length !== 1 || parentClaims.filter((parentClaim) => parentClaim?.claim === PROOF_CATALOG_REVALIDATION_CLAIM).length !== 1 || candidate.producerCheckId !== "inspect" || inventory.producerCheckId !== "structural_inventory" || revalidation.producerCheckId !== "revalidate_catalog" || admission.producerCheckId !== "proof_admit" || admission.parentClaimIds.length !== 1 || admission.parentClaimIds[0] !== candidate.claimId || candidate.parentClaimIds.length !== 2 || !candidate.parentClaimIds.includes(inventory.claimId) || !project.activeItemClaimId || !candidate.parentClaimIds.includes(project.activeItemClaimId) || candidate.parentClaimIds.some((id, index) => id !== [...candidate.parentClaimIds].sort()[index]) || revalidation.parentClaimIds.length !== 3 || canonicalJson(revalidation.parentClaimIds) !== canonicalJson([inventory.claimId, candidate.claimId, admission.claimId].sort())) {
        throw new InstanceKernelError("INVALID_PROOF_CURRENT_AUTHORITY", "Source catalog candidate/admission lineage is not exact");
      }
      for (const parentClaim of [candidate, admission, inventory, revalidation]) {
        const parentGeneration = parentClaim.nodeGenerationId ? projection.generationsById[parentClaim.nodeGenerationId] : void 0;
        if (parentClaim.kind !== "generated-output" || !parentGeneration || parentGeneration.status !== "completed" || !parentGeneration.scheduled || !parentGeneration.completedOutputClaimIds.includes(parentClaim.claimId)) {
          throw new InstanceKernelError("INVALID_PROOF_CURRENT_AUTHORITY", "Proof source parent is not a completed generated output");
        }
      }
      let validated;
      try {
        validated = validateProofCurrentCatalogAuthorityBytes({
          revalidationBytesBase64: event.revalidationBytesBase64,
          workItemsBytesBase64: event.workItemsBytesBase64,
          candidate: currentAuthorityClaimView(candidate),
          admission: currentAuthorityClaimView(admission)
        });
      } catch (error) {
        throw new InstanceKernelError("INVALID_PROOF_CURRENT_AUTHORITY", `Current Proof authority bytes are invalid: ${error instanceof Error ? error.message : String(error)}`);
      }
      const components = Object.values(projection.instancesById).filter((instance) => instance.status === "active" && instance.parentSubgraphInstanceId === project.subgraphInstanceId).sort((left, right) => Buffer.from(left.itemKey, "utf8").compare(Buffer.from(right.itemKey, "utf8")));
      if (components.length !== validated.components.length || new Set(components.map((instance) => instance.itemKey)).size !== components.length || components.some((instance) => instance.catalogClaimId !== source.claimId || instance.catalogProducerNodeGenerationId !== sourceGeneration.nodeGenerationId || instance.expansionOwnerNodeInstanceId !== sourceGeneration.nodeInstanceId || !instance.activeItemClaimId || projection.claimsById[instance.activeItemClaimId]?.controllerCatalogClaimId !== source.claimId || canonicalJson(projection.claimsById[instance.activeItemClaimId]?.parentClaimIds || []) !== canonicalJson([source.claimId])) || components.some((instance) => Object.values(projection.generationsById).some((generation) => generation.subgraphInstanceId === instance.subgraphInstanceId && (generation.status === "ready" || generation.status === "running")))) {
        throw new InstanceKernelError("INVALID_PROOF_CURRENT_AUTHORITY", "Current Proof authority requires the exact quiescent component set");
      }
      const rows = validated.components.map((component) => {
        const instance = components.find((candidateInstance) => candidateInstance.itemKey === component.componentId);
        if (!instance?.activeItemClaimId) throw new InstanceKernelError("INVALID_PROOF_CURRENT_AUTHORITY", `No active historical WorkItem for component ${component.componentId}`);
        const item = projection.claimsById[instance.activeItemClaimId];
        if (!item || !item.active || item.claim !== "component.work_item@1") throw new InstanceKernelError("INVALID_PROOF_CURRENT_AUTHORITY", `Historical WorkItem for component ${component.componentId} is invalid`);
        const workItem = validated.items.find((value) => !!value && typeof value === "object" && value.component_id === component.componentId);
        if (!workItem) throw new InstanceKernelError("INVALID_PROOF_CURRENT_AUTHORITY", `Current WorkItem for component ${component.componentId} is missing`);
        const currentItemFingerprint = deriveItemFingerprint(workItem);
        const sameProofBytes = governedCanonicalJson(workItem, "proof") === governedCanonicalJson(item.payload, "proof");
        return {
          componentId: component.componentId,
          subgraphInstanceId: instance.subgraphInstanceId,
          historicalItemClaimId: item.claimId,
          historicalItemFingerprint: item.payloadFingerprint,
          currentItemFingerprint,
          comparison: sameProofBytes ? "unchanged" : "changed"
        };
      });
      if (event.authorityId !== deriveProofCurrentCatalogAuthorityId({
        sessionId: event.sessionId,
        scope,
        projectSubgraphInstanceId: event.projectSubgraphInstanceId,
        sourceCatalogClaimId: event.sourceCatalogClaimId,
        previousAuthorityId: event.previousAuthorityId,
        revalidationBytesBase64: event.revalidationBytesBase64,
        workItemsBytesBase64: event.workItemsBytesBase64
      })) {
        throw new InstanceKernelError("INVALID_PROOF_CURRENT_AUTHORITY", "Current Proof authority identity is invalid");
      }
      next.currentProofCatalogAuthorityByProject[event.projectSubgraphInstanceId] = immutableGovernedValue({
        projectSubgraphInstanceId: event.projectSubgraphInstanceId,
        sourceCatalogClaimId: event.sourceCatalogClaimId,
        previousAuthorityId: event.previousAuthorityId,
        authorityId: event.authorityId,
        revalidationBytesBase64: event.revalidationBytesBase64,
        workItemsBytesBase64: event.workItemsBytesBase64,
        components: rows
      }, "proof");
      break;
    }
    case "ControllerItemClaimPublished": {
      const knownInstance = projection.instancesById[event.subgraphInstanceId];
      const instance = requireInstance(
        projection,
        event.subgraphInstanceId,
        event.scope,
        knownInstance?.status === "tombstoned"
      );
      let catalogProducer;
      if (instance.parentSubgraphInstanceId) {
        if (!instance.expansionOwnerNodeInstanceId || !instance.catalogClaimRef) {
          throw new InstanceKernelError(
            "INVALID_NESTED_CATALOG_LINEAGE",
            "Nested controller claim requires its immutable catalog authority binding"
          );
        }
        catalogProducer = requireNestedCatalogAuthority(projection, {
          parentSubgraphInstanceId: instance.parentSubgraphInstanceId,
          expansionOwnerNodeInstanceId: instance.expansionOwnerNodeInstanceId,
          catalogClaimId: event.catalogClaimId
        }, event.claim === "component.work_item@1" && context?.allowedControllerClaimIds.has(event.claimId) ? context : void 0);
        if (instance.catalogClaimRef !== catalogProducer.nestedExpansionCatalogClaimRef) {
          throw new InstanceKernelError(
            "INVALID_NESTED_CATALOG_LINEAGE",
            "Nested controller claim does not match the parent generation authority"
          );
        }
      }
      if (event.sessionId !== instance.sessionId || event.expansionOwnerCheck !== instance.expansionOwnerCheck || event.expansionSpecDigest !== instance.expansionSpecDigest || event.itemKey !== instance.itemKey || event.incarnation !== instance.incarnation + 1 || event.parentClaimIds.length !== 1 || event.parentClaimIds[0] !== event.catalogClaimId) {
        throw new InstanceKernelError("INVALID_ITEM_CLAIM", "Controller item claim authority is invalid");
      }
      if (Object.values(projection.generationsById).some(
        (generation) => generation.subgraphInstanceId === instance.subgraphInstanceId && generation.status !== "inactive"
      )) {
        throw new InstanceKernelError("EXPANSION_BUSY", "Old instance generations are still active");
      }
      const payloadFingerprint = deriveItemFingerprint(event.payload);
      const proofApplicationClaim = event.claim === "component.work_item@1" && context?.allowedControllerClaimIds.has(event.claimId) === true;
      const scope = requireKeyedScopePath(event.scope, instance.scope);
      const claimId = deriveControllerItemClaimId({
        claim: event.claim,
        payloadFingerprint,
        expansionSpecDigest: event.expansionSpecDigest,
        catalogClaimId: event.catalogClaimId,
        subgraphInstanceId: event.subgraphInstanceId,
        incarnation: event.incarnation,
        scope
      });
      if (event.payloadFingerprint !== payloadFingerprint || event.claimId !== claimId || projection.claimsById[event.claimId]) {
        throw new InstanceKernelError("INVALID_ITEM_CLAIM", "Controller item claim identity is invalid");
      }
      if (instance.activeItemClaimId) {
        next.claimsById[instance.activeItemClaimId] = {
          ...projection.claimsById[instance.activeItemClaimId],
          active: false
        };
      }
      next.claimsById[event.claimId] = {
        claimId,
        claim: event.claim,
        payload: proofApplicationClaim ? immutableGovernedValue(event.payload, "proof") : immutableCanonicalValue(event.payload),
        payloadFingerprint,
        producerCheckId: event.expansionOwnerCheck,
        controllerCatalogClaimId: event.catalogClaimId,
        parentClaimIds: [event.catalogClaimId],
        // This is trusted only for the exact replacement claim admitted by
        // the sealed Proof application batch.  Generic controller WorkItems
        // remain generic everywhere else.
        wireMode: proofApplicationClaim ? "proof" : "generic",
        scope,
        active: true,
        kind: "controller-item",
        subgraphInstanceId: instance.subgraphInstanceId,
        incarnation: event.incarnation
      };
      const { tombstoneCatalogClaimId: _tombstoneCatalogClaimId, ...reactivated } = instance;
      void _tombstoneCatalogClaimId;
      next.instancesById[instance.subgraphInstanceId] = {
        ...reactivated,
        ...catalogProducer ? {
          catalogClaimId: event.catalogClaimId,
          catalogProducerNodeGenerationId: catalogProducer.nodeGenerationId
        } : {},
        status: "active",
        incarnation: event.incarnation,
        activeItemClaimId: claimId
      };
      break;
    }
    case "NodeGenerationActivated": {
      const instance = requireInstance(projection, event.subgraphInstanceId, event.scope);
      const node = projection.nodesById[event.nodeInstanceId];
      if (event.nestedExpansionCatalogClaimRef !== void 0) {
        requireNonEmpty(
          event.nestedExpansionCatalogClaimRef,
          "Nested expansion catalog authority"
        );
      }
      if (event.expansionBarrierDigest !== void 0 && !SHA256_PATTERN.test(event.expansionBarrierDigest)) {
        throw new InstanceKernelError(
          "INVALID_GENERATION_BINDING",
          "Expansion barrier digest must be a lowercase SHA-256 identity"
        );
      }
      if (!node || node.subgraphInstanceId !== instance.subgraphInstanceId || node.templateNodeKey !== event.templateNodeKey || event.checkId !== event.templateNodeKey || event.incarnation !== instance.incarnation) {
        throw new InstanceKernelError("INVALID_GENERATION_BINDING", "Activation is bound to wrong node");
      }
      if (projection.activeGenerationIdByNode[event.nodeInstanceId]) {
        throw new InstanceKernelError("GENERATION_ALREADY_ACTIVE", "Node already has an active generation");
      }
      const inputIds = sortedUnique(event.activeInputClaimIds, "Active input claim IDs");
      for (const claimId of inputIds) {
        const claim = projection.claimsById[claimId];
        if (!claim?.active || claim.subgraphInstanceId !== instance.subgraphInstanceId) {
          throw new InstanceKernelError("INACTIVE_INPUT_CLAIM", `Input claim ${claimId} is not active`);
        }
      }
      const itemClaim = instance.activeItemClaimId ? projection.claimsById[instance.activeItemClaimId] : void 0;
      if (!itemClaim || itemClaim.payloadFingerprint !== event.itemFingerprint) {
        throw new InstanceKernelError("INVALID_ITEM_FINGERPRINT", "Activation item fingerprint is stale");
      }
      const generationId = deriveNodeGenerationId({
        nodeInstanceId: event.nodeInstanceId,
        incarnation: event.incarnation,
        itemFingerprint: event.itemFingerprint,
        executionConfigDigest: event.executionConfigDigest,
        activeInputClaimIds: inputIds,
        ...event.expansionBarrierDigest ? { expansionBarrierDigest: event.expansionBarrierDigest } : {}
      });
      if (event.nodeGenerationId !== generationId || projection.generationsById[generationId]) {
        throw new InstanceKernelError("INVALID_GENERATION_ID", "Node generation identity is invalid");
      }
      next.generationsById[generationId] = {
        nodeGenerationId: generationId,
        nodeInstanceId: node.nodeInstanceId,
        subgraphInstanceId: instance.subgraphInstanceId,
        templateNodeKey: node.templateNodeKey,
        checkId: event.checkId,
        scope: requireKeyedScopePath(event.scope, instance.scope),
        incarnation: event.incarnation,
        itemFingerprint: event.itemFingerprint,
        executionConfigDigest: event.executionConfigDigest,
        activeInputClaimIds: inputIds,
        ...event.nestedExpansionCatalogClaimRef ? { nestedExpansionCatalogClaimRef: event.nestedExpansionCatalogClaimRef } : {},
        ...event.expansionBarrierDigest ? { expansionBarrierDigest: event.expansionBarrierDigest } : {},
        status: "ready",
        scheduled: false,
        completedOutputClaimIds: []
      };
      next.activeGenerationIdByNode[node.nodeInstanceId] = generationId;
      break;
    }
    case "NodeGenerationInactivated": {
      if (requiresProofApplicationInactivation(projection, event) && (!context || !context.allowedInactivationGenerationIds.has(event.nodeGenerationId))) {
        throw new InstanceKernelError("INVALID_PROOF_CURRENT_APPLICATION", "Proof historical generation requires its authenticated application marker");
      }
      const generation = requireGeneration(projection, event);
      requireInstance(projection, event.subgraphInstanceId, event.scope);
      if (event.reason !== "superseded" || generation.subgraphInstanceId !== event.subgraphInstanceId || generation.incarnation !== event.incarnation || generation.status === "ready" || generation.status === "running") {
        throw new InstanceKernelError("EXPANSION_BUSY", "Generation cannot be inactivated now");
      }
      if (Object.values(projection.instancesById).some(
        (candidate) => candidate.status === "active" && candidate.catalogProducerNodeGenerationId === generation.nodeGenerationId
      )) {
        throw new InstanceKernelError(
          "ACTIVE_DESCENDANT",
          "Nested descendants must be tombstoned before their catalog producer is inactivated"
        );
      }
      const outputIds = sortedUnique(event.outputClaimIds, "Inactivated output claim IDs");
      const expectedOutputs = [...generation.completedOutputClaimIds].sort();
      if (!sameStrings(outputIds, expectedOutputs)) {
        throw new InstanceKernelError("INVALID_GENERATION_BINDING", "Inactivation output set is not exact");
      }
      next.generationsById[event.nodeGenerationId] = { ...generation, status: "inactive" };
      delete next.activeGenerationIdByNode[event.nodeInstanceId];
      for (const claimId of outputIds) {
        next.claimsById[claimId] = { ...projection.claimsById[claimId], active: false };
      }
      break;
    }
    case "SubgraphTombstoned": {
      const instance = requireInstance(projection, event.subgraphInstanceId, event.scope);
      if (event.expansionOwnerCheck !== instance.expansionOwnerCheck || event.itemKey !== instance.itemKey || event.lastIncarnation !== instance.incarnation) {
        throw new InstanceKernelError("INVALID_TOMBSTONE", "Tombstone identity is invalid");
      }
      if (Object.values(projection.instancesById).some(
        (candidate) => candidate.status === "active" && candidate.parentSubgraphInstanceId === instance.subgraphInstanceId
      )) {
        throw new InstanceKernelError(
          "ACTIVE_DESCENDANT",
          "Nested descendants must be tombstoned before their parent instance"
        );
      }
      const activeGenerations = Object.values(projection.generationsById).filter(
        (generation) => generation.subgraphInstanceId === instance.subgraphInstanceId && generation.status !== "inactive"
      ).sort((left, right) => left.nodeGenerationId.localeCompare(right.nodeGenerationId));
      if (activeGenerations.some((generation) => generation.status === "ready" || generation.status === "running")) {
        throw new InstanceKernelError("EXPANSION_BUSY", "Ready or running generation blocks tombstone");
      }
      const generationIds = sortedUnique(event.nodeGenerationIds, "Tombstone generation IDs");
      if (!sameStrings(generationIds, activeGenerations.map((generation) => generation.nodeGenerationId))) {
        throw new InstanceKernelError("INVALID_TOMBSTONE", "Tombstone generation set is not exact");
      }
      const expectedOutputs = activeGenerations.flatMap((generation) => generation.completedOutputClaimIds).sort();
      const outputIds = sortedUnique(event.outputClaimIds, "Tombstone output claim IDs");
      if (!sameStrings(outputIds, expectedOutputs)) {
        throw new InstanceKernelError("INVALID_TOMBSTONE", "Tombstone output set is not exact");
      }
      for (const generation of activeGenerations) {
        next.generationsById[generation.nodeGenerationId] = { ...generation, status: "inactive" };
        delete next.activeGenerationIdByNode[generation.nodeInstanceId];
      }
      for (const claimId of outputIds) {
        next.claimsById[claimId] = { ...projection.claimsById[claimId], active: false };
      }
      if (instance.activeItemClaimId) {
        next.claimsById[instance.activeItemClaimId] = {
          ...projection.claimsById[instance.activeItemClaimId],
          active: false
        };
      }
      next.instancesById[instance.subgraphInstanceId] = {
        ...instance,
        status: "tombstoned",
        tombstoneCatalogClaimId: event.sourceCatalogClaimId
      };
      break;
    }
    case "AttemptStarted":
    case "CheckScheduled":
    case "AttemptCompleted":
    case "AttemptFailed": {
      if ("requestId" in event) reduceRequestLifecycle(projection, next, event);
      else reduceGeneratedLifecycle(projection, next, event);
      break;
    }
    case "ClaimPublished":
      reduceGeneratedLifecycle(projection, next, event);
      break;
    case "AttemptRetryRequested":
      reduceGeneratedAttemptRetry(projection, next, event);
      break;
    case "ManagedRunAcquisitionFailed":
    case "ManagedRunAcquired":
    case "ManagedRunStarted":
    case "ManagedRunCancelRequested":
    case "ManagedRunTerminated":
      reduceManagedRunLifecycle(projection, next, event);
      break;
  }
  return immutableInstanceProjectionInternal(next, context?.allowedControllerClaimIds);
}
function reduceInstanceEvent(projection, event) {
  return reduceInstanceEventInternal(projection, event);
}
function isGeneratedAttemptTerminal(event) {
  return (event.type === "AttemptCompleted" || event.type === "AttemptFailed") && "nodeGenerationId" in event;
}
function requireMatchingAttemptTerminal(binding, event, expectedType, failureCode) {
  if (!event || !isGeneratedAttemptTerminal(event) || event.type !== expectedType || !generatedAttemptMatchesManagedBinding(event, binding) || event.type === "AttemptFailed" && event.reason !== failureCode) {
    throw new InstanceKernelError(
      "INVALID_MANAGED_BATCH",
      `Managed lifecycle terminal requires a matching ${expectedType} in the same batch`
    );
  }
}
function isNestedReconciliationEvent(event) {
  return event.type === "SubgraphExpanded" || event.type === "ControllerItemClaimPublished" || event.type === "NodeGenerationInactivated" || event.type === "SubgraphTombstoned";
}
function nestedCatalogClaimId(event) {
  if (event.type === "SubgraphExpanded" || event.type === "ControllerItemClaimPublished") {
    return event.catalogClaimId;
  }
  if (event.type === "SubgraphTombstoned") return event.sourceCatalogClaimId;
  return void 0;
}
function requireManagedNestedReconciliationAuthority(projection, event, binding, catalogClaimId) {
  const scope = requireKeyedScopePath(event.scope);
  const parentScope = scope.slice(0, binding.scope.length);
  const parentSegment = binding.scope[binding.scope.length - 1];
  if (scope.length !== binding.scope.length + 1 || !scopePathEquals(parentScope, binding.scope)) {
    throw new InstanceKernelError(
      "INVALID_MANAGED_BATCH",
      "Managed nested reconciliation scope must have the exact binding-scope prefix"
    );
  }
  if (!("subgraphInstanceId" in event)) {
    throw new InstanceKernelError(
      "INVALID_MANAGED_BATCH",
      "Managed nested reconciliation event lacks a child instance identity"
    );
  }
  const ownerGeneration = projection.generationsById[binding.nodeGenerationId];
  const catalogClaimRef = ownerGeneration?.nestedExpansionCatalogClaimRef;
  if (!catalogClaimRef) {
    throw new InstanceKernelError(
      "INVALID_MANAGED_BATCH",
      "Managed parent owner generation lacks nested catalog authority"
    );
  }
  if (event.type === "SubgraphExpanded") {
    if (event.parentSubgraphInstanceId !== parentSegment.subgraphInstanceId || event.expansionOwnerNodeInstanceId !== binding.nodeInstanceId || event.catalogClaimRef !== catalogClaimRef || event.catalogClaimId !== catalogClaimId) {
      throw new InstanceKernelError(
        "INVALID_MANAGED_BATCH",
        "Managed child expansion is bound to a foreign parent, owner node, or catalog"
      );
    }
  } else {
    const instance = projection.instancesById[event.subgraphInstanceId];
    if (!instance || instance.parentSubgraphInstanceId !== parentSegment.subgraphInstanceId || instance.expansionOwnerNodeInstanceId !== binding.nodeInstanceId || instance.catalogClaimRef !== catalogClaimRef) {
      throw new InstanceKernelError(
        "INVALID_MANAGED_BATCH",
        "Managed nested event is not bound to the exact parent instance and owner node"
      );
    }
    if (event.type === "ControllerItemClaimPublished" && event.catalogClaimId !== catalogClaimId) {
      throw new InstanceKernelError(
        "INVALID_MANAGED_BATCH",
        "Managed controller item claim is bound to a foreign catalog"
      );
    }
    if (event.type === "SubgraphTombstoned" && event.sourceCatalogClaimId !== catalogClaimId) {
      throw new InstanceKernelError(
        "INVALID_MANAGED_BATCH",
        "Managed child tombstone is bound to a foreign catalog"
      );
    }
  }
  const producer = requireNestedCatalogAuthority(projection, {
    parentSubgraphInstanceId: parentSegment.subgraphInstanceId,
    expansionOwnerNodeInstanceId: binding.nodeInstanceId,
    catalogClaimId
  });
  if (producer.nodeGenerationId !== binding.nodeGenerationId || producer.nodeInstanceId !== binding.nodeInstanceId || producer.attemptId !== binding.attemptId || producer.fence !== binding.fence || producer.checkId !== binding.checkId) {
    throw new InstanceKernelError(
      "INVALID_MANAGED_BATCH",
      "Managed nested catalog does not have the current complete fenced binding lineage"
    );
  }
}
function reduceInstanceEventBatch(projection, events) {
  const appliedIndex = events.findIndex((event) => event.type === "ProofCurrentCatalogAuthorityApplied");
  if (appliedIndex >= 0) {
    if (appliedIndex !== 0) throw new InstanceKernelError("INVALID_PROOF_CURRENT_APPLICATION", "Proof authority application header must begin its exact batch");
    const header = events[0];
    validateProofAppliedHeader(header);
    const mutations = events.slice(1);
    if (header.eventId <= projection.lastEventId || mutations.some((event, index) => event.type === "ProofCurrentCatalogAuthorityApplied" || event.eventId !== header.eventId + index + 1) || mutations.length !== header.mutationEventCount || deriveProofCurrentCatalogAuthorityMutationDigest({ authorityId: header.authorityId, mutations }) !== header.mutationEventsDigest) {
      throw new InstanceKernelError("INVALID_PROOF_CURRENT_APPLICATION", "Proof authority application mutation count or digest is invalid");
    }
    validateProofAppliedMutationBatch(projection, header, mutations);
    let projected = immutableInstanceProjection({
      ...mutableProjection(projection),
      lastEventId: header.eventId
    });
    const sourceCatalogClaimId = projection.currentProofCatalogAuthorityByProject[header.projectSubgraphInstanceId]?.sourceCatalogClaimId;
    if (!sourceCatalogClaimId) throw new InstanceKernelError("INVALID_PROOF_CURRENT_APPLICATION", "Proof authority source catalog is unavailable");
    const context = {
      sourceCatalogClaimId,
      allowedControllerClaimIds: new Set(
        mutations.filter((event) => event.type === "ControllerItemClaimPublished" && event.claim === "component.work_item@1").map((event) => event.claimId)
      ),
      allowedInactivationGenerationIds: new Set(
        mutations.filter((event) => event.type === "NodeGenerationInactivated").map((event) => event.nodeGenerationId)
      )
    };
    for (const mutation of mutations) {
      projected = reduceInstanceEventInternal(projected, mutation, context);
    }
    const next = mutableProjection(projected);
    const appliedAuthority = projection.currentProofCatalogAuthorityByProject[header.projectSubgraphInstanceId];
    if (!appliedAuthority || appliedAuthority.authorityId !== header.authorityId) {
      throw new InstanceKernelError("INVALID_PROOF_CURRENT_APPLICATION", "Proof authority application lost its authenticated authority");
    }
    next.appliedProofCatalogAuthorityByProject[header.projectSubgraphInstanceId] = immutableGovernedValue(appliedAuthority, "proof");
    return immutableInstanceProjection(next);
  }
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    if (event.type === "ManagedRunAcquisitionFailed") {
      if (index !== 0 || events.length !== 2) {
        throw new InstanceKernelError(
          "INVALID_MANAGED_BATCH",
          "Managed acquisition failure batch must contain exactly its two adjacent terminals"
        );
      }
      requireMatchingAttemptTerminal(
        event.binding,
        events[index + 1],
        "AttemptFailed",
        event.failureCode
      );
    } else if (event.type === "ManagedRunTerminated") {
      if (event.controllerDecision === "failed") {
        if (index !== 0 || events.length !== 2) {
          throw new InstanceKernelError(
            "INVALID_MANAGED_BATCH",
            "Managed failure batch must contain exactly its two adjacent terminals"
          );
        }
        requireMatchingAttemptTerminal(
          event.binding,
          events[index + 1],
          "AttemptFailed",
          event.failureCode || void 0
        );
      } else {
        if (index !== 0) {
          throw new InstanceKernelError(
            "INVALID_MANAGED_BATCH",
            "Managed completion lifecycle terminal must begin its atomic batch"
          );
        }
        const completionIndex = events.findIndex(
          (candidate, candidateIndex) => candidateIndex > index && isGeneratedAttemptTerminal(candidate) && candidate.attemptId === event.binding.attemptId
        );
        const completion = completionIndex < 0 ? void 0 : events[completionIndex];
        requireMatchingAttemptTerminal(event.binding, completion, "AttemptCompleted");
        if (completionIndex !== events.length - 1) {
          throw new InstanceKernelError(
            "INVALID_MANAGED_BATCH",
            "Managed AttemptCompleted must end its atomic terminal batch"
          );
        }
        const interior = events.slice(1, -1);
        const nestedEvents = interior.filter(
          (candidate) => isNestedReconciliationEvent(candidate) || candidate.type === "NodeGenerationActivated" && candidate.scope.length === event.binding.scope.length + 1
        );
        const nestedCatalogClaimIds = new Set(
          nestedEvents.map(nestedCatalogClaimId).filter((claimId) => claimId !== void 0)
        );
        if (nestedEvents.length > 0 && nestedCatalogClaimIds.size !== 1) {
          throw new InstanceKernelError(
            "INVALID_MANAGED_BATCH",
            "Managed nested reconciliation requires one exact catalog authority"
          );
        }
        const catalogClaimId = [...nestedCatalogClaimIds][0];
        let nonClaimObserved = false;
        let stagedProjection = reduceInstanceEvent(projection, event);
        for (const staged of interior) {
          if (staged.type === "ClaimPublished") {
            if (nonClaimObserved) {
              throw new InstanceKernelError(
                "INVALID_MANAGED_BATCH",
                "Managed completion claims must precede reconciliation and downstream activation"
              );
            }
            stagedProjection = reduceInstanceEvent(stagedProjection, staged);
            continue;
          }
          nonClaimObserved = true;
          const nested = isNestedReconciliationEvent(staged) || staged.type === "NodeGenerationActivated" && staged.scope.length === event.binding.scope.length + 1;
          if (nested && catalogClaimId) {
            requireManagedNestedReconciliationAuthority(
              stagedProjection,
              staged,
              event.binding,
              catalogClaimId
            );
            stagedProjection = reduceInstanceEvent(stagedProjection, staged);
            continue;
          }
          if (staged.type === "NodeGenerationActivated" && scopePathEquals(staged.scope, event.binding.scope) && staged.subgraphInstanceId === event.binding.scope[event.binding.scope.length - 1].subgraphInstanceId) {
            stagedProjection = reduceInstanceEvent(stagedProjection, staged);
            continue;
          }
          if (staged.type === "NodeGenerationActivated" && staged.expansionBarrierDigest !== void 0 && event.binding.scope.length > 1 && staged.scope.length === event.binding.scope.length - 1 && scopePathEquals(staged.scope, event.binding.scope.slice(0, -1)) && staged.subgraphInstanceId === event.binding.scope[event.binding.scope.length - 2].subgraphInstanceId) {
            stagedProjection = reduceInstanceEvent(stagedProjection, staged);
            continue;
          }
          throw new InstanceKernelError(
            "INVALID_MANAGED_BATCH",
            "Managed completion batch contains an event outside the exact nested reconciliation grammar"
          );
        }
      }
    }
  }
  for (const event of events) {
    if (!isGeneratedAttemptTerminal(event)) continue;
    const existing = projection.managedRunsByAttemptId[event.attemptId];
    const matchingLifecycle = events.find(
      (candidate) => (candidate.type === "ManagedRunAcquisitionFailed" || candidate.type === "ManagedRunTerminated") && generatedAttemptMatchesManagedBinding(event, candidate.binding)
    );
    if (existing && !matchingLifecycle) {
      throw new InstanceKernelError(
        "INVALID_MANAGED_BATCH",
        "Managed attempt terminal cannot bypass its same-batch lifecycle terminal"
      );
    }
  }
  return events.reduce(reduceInstanceEvent, projection);
}
function replayInstanceEvents(events) {
  let projection = createInitialInstanceProjection();
  let index = 0;
  while (index < events.length) {
    const event = events[index];
    if (event.type === "ProofCurrentCatalogAuthorityApplied") {
      const end = index + event.mutationEventCount + 1;
      if (end > events.length) throw new InstanceKernelError("INVALID_PROOF_CURRENT_APPLICATION", "Proof authority application batch is truncated");
      projection = reduceInstanceEventBatch(projection, events.slice(index, end));
      index = end;
      continue;
    }
    if (event.type === "ManagedRunAcquisitionFailed" || event.type === "ManagedRunTerminated" && event.controllerDecision === "failed") {
      projection = reduceInstanceEventBatch(projection, events.slice(index, index + 2));
      index += 2;
      continue;
    }
    if (event.type === "ManagedRunTerminated") {
      let terminalIndex = index + 1;
      while (terminalIndex < events.length) {
        const candidate = events[terminalIndex];
        if (isGeneratedAttemptTerminal(candidate) && candidate.attemptId === event.binding.attemptId) {
          break;
        }
        terminalIndex++;
      }
      projection = reduceInstanceEventBatch(
        projection,
        events.slice(index, Math.min(terminalIndex + 1, events.length))
      );
      index = terminalIndex + 1;
      continue;
    }
    projection = reduceInstanceEventBatch(projection, [event]);
    index++;
  }
  return projection;
}
function queryReadyGenerations(projection) {
  return Object.values(projection.generationsById).filter((generation) => generation.status === "ready").sort((left, right) => left.nodeGenerationId.localeCompare(right.nodeGenerationId));
}
var InstanceKernelError, SHA256_PATTERN, PROVIDER_COVERAGE_CLASSES, MANAGED_RUN_FAILURE_CODES, MANAGED_RUN_ACQUISITION_FAILURE_CODES, MANAGED_RUN_UNVERIFIED_CLEANUP_FAILURE_CODES, MANAGED_RUN_CANCEL_PATH_FAILURE_CODES, MANAGED_RUN_CANCEL_ONLY_FAILURE_CODES;
var init_instance_kernel = __esm({
  "src/state-machine/graph/instance-kernel.ts"() {
    "use strict";
    init_claim_kernel();
    init_instance_plan();
    init_instance_plan();
    init_governed_proof_inspect_check_provider();
    init_proof_catalog_check_providers();
    init_proof_admission_cli_child();
    init_proof_wire();
    InstanceKernelError = class extends Error {
      code;
      constructor(code, message) {
        super(message);
        this.name = "InstanceKernelError";
        this.code = code;
      }
    };
    SHA256_PATTERN = /^[0-9a-f]{64}$/;
    PROVIDER_COVERAGE_CLASSES = /* @__PURE__ */ new Set([
      "completed_clean",
      "completed_with_findings",
      "guardrail_blocked"
    ]);
    MANAGED_RUN_FAILURE_CODES = /* @__PURE__ */ new Set([
      "MANAGED_HANDLE_INVALID",
      "MANAGED_BINDING_MISMATCH",
      "MANAGED_START_FAILED",
      "MANAGED_STARTED_RECEIPT_INVALID",
      "MANAGED_OUTCOME_FAILED",
      "MANAGED_OUTCOME_RECEIPT_INVALID",
      "MANAGED_DEADLINE_EXCEEDED",
      "MANAGED_CANCEL_FAILED",
      "MANAGED_CANCEL_RECEIPT_INVALID",
      "MANAGED_CLOSE_FAILED",
      "MANAGED_CLEANUP_RECEIPT_INVALID",
      "MANAGED_SANDBOX_UNSUPPORTED",
      "MANAGED_DEBOUNCE_UNSUPPORTED",
      "MANAGED_FATAL_SUMMARY",
      "MANAGED_FAIL_IF",
      "MANAGED_HALT_EXECUTION",
      "MANAGED_CLAIM_VALIDATION_FAILED",
      "MANAGED_POST_PROVIDER_FAILED"
    ]);
    MANAGED_RUN_ACQUISITION_FAILURE_CODES = /* @__PURE__ */ new Set([
      "MANAGED_HANDLE_INVALID",
      "MANAGED_BINDING_MISMATCH",
      "MANAGED_START_FAILED",
      "MANAGED_SANDBOX_UNSUPPORTED",
      "MANAGED_DEBOUNCE_UNSUPPORTED"
    ]);
    MANAGED_RUN_UNVERIFIED_CLEANUP_FAILURE_CODES = /* @__PURE__ */ new Set(["MANAGED_CLOSE_FAILED", "MANAGED_CLEANUP_RECEIPT_INVALID"]);
    MANAGED_RUN_CANCEL_PATH_FAILURE_CODES = /* @__PURE__ */ new Set([
      "MANAGED_DEADLINE_EXCEEDED",
      "MANAGED_CANCEL_FAILED",
      "MANAGED_CANCEL_RECEIPT_INVALID",
      "MANAGED_CLOSE_FAILED",
      "MANAGED_CLEANUP_RECEIPT_INVALID"
    ]);
    MANAGED_RUN_CANCEL_ONLY_FAILURE_CODES = /* @__PURE__ */ new Set([
      "MANAGED_DEADLINE_EXCEEDED",
      "MANAGED_CANCEL_FAILED",
      "MANAGED_CANCEL_RECEIPT_INVALID"
    ]);
  }
});

// src/providers/proof-project-reconcile-check-provider.ts
function invalid(detail) {
  throw new Error(`PROOF_RECONCILIATION_INVALID: ${detail}`);
}
function unavailable() {
  throw new Error(PROOF_ADMISSION_UNAVAILABLE);
}
function plain(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
function exactKeys(value, keys) {
  if (!plain(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  return ownKeys.length === keys.length && ownKeys.every((key) => {
    if (typeof key !== "string" || !keys.includes(key)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return !!descriptor && "value" in descriptor && descriptor.enumerable;
  });
}
function validUtf8(value) {
  return Buffer.from(value, "utf8").toString("utf8") === value;
}
function digestSyntax(value) {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
}
function parseRequest(input) {
  if (input.length === 0 || !validUtf8(input)) invalid("request is not valid UTF-8 JSON");
  if (Buffer.byteLength(input, "utf8") > PROOF_PROJECT_RECONCILIATION_INPUT_MAX_BYTES) {
    unavailable();
  }
  let value;
  try {
    value = JSON.parse(input);
  } catch {
    invalid("request is not one JSON value");
  }
  if (!exactKeys(value, REQUEST_KEYS) || value.version !== PROOF_PROJECT_RECONCILIATION_REQUEST_VERSION || !plain(value.discovery_candidate) || !plain(value.discovery_admission) || !plain(value.catalog_revalidation) || !Array.isArray(value.outcomes)) {
    invalid("request envelope is invalid");
  }
}
function projectOutput(value) {
  if (!exactKeys(value, RECEIPT_KEYS) || value.version !== PROOF_PROJECT_RECONCILIATION_RECEIPT_VERSION || !plain(value.project_authority) || !plain(value.catalog_revalidation_receipt) || !Array.isArray(value.component_admissions) || !Array.isArray(value.covered_work_item_digests) || !digestSyntax(value.receipt_id)) {
    invalid("receipt envelope is invalid");
  }
  return value;
}
function createProofProjectReconcileProviderFromCapability(capability) {
  if (!proofAdmissionCapabilityValid(capability)) unavailable();
  return new ProofProjectReconcileCheckProvider(capability, INTERNAL);
}
var PROOF_PROJECT_RECONCILIATION_REQUEST_VERSION, PROOF_PROJECT_RECONCILIATION_RECEIPT_VERSION, PROOF_PROJECT_RECONCILIATION_INPUT_MAX_BYTES, PROOF_PROJECT_RECONCILIATION_OUTPUT_MAX_BYTES, INTERNAL, REQUEST_KEYS, RECEIPT_KEYS, ProofProjectReconcileCheckProvider;
var init_proof_project_reconcile_check_provider = __esm({
  "src/providers/proof-project-reconcile-check-provider.ts"() {
    "use strict";
    init_check_provider_interface();
    init_proof_admission_cli_child();
    init_instance_plan();
    init_instance_plan();
    PROOF_PROJECT_RECONCILIATION_REQUEST_VERSION = "proof.project-reconciliation-request/v1";
    PROOF_PROJECT_RECONCILIATION_RECEIPT_VERSION = "proof.project-reconciliation-receipt/v1";
    PROOF_PROJECT_RECONCILIATION_INPUT_MAX_BYTES = 32 * 1024 * 1024;
    PROOF_PROJECT_RECONCILIATION_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;
    INTERNAL = /* @__PURE__ */ Symbol("proof-project-reconcile-provider");
    REQUEST_KEYS = [
      "version",
      "discovery_candidate",
      "discovery_admission",
      "catalog_revalidation",
      "outcomes"
    ];
    RECEIPT_KEYS = [
      "version",
      "project_authority",
      "catalog_revalidation_receipt",
      "component_admissions",
      "covered_work_item_digests",
      "receipt_id"
    ];
    ProofProjectReconcileCheckProvider = class extends CheckProvider {
      capability;
      constructor(capability, token) {
        super();
        if (capability && (token !== INTERNAL || !proofAdmissionCapabilityValid(capability))) unavailable();
        this.capability = capability;
      }
      getName() {
        return PROOF_PROJECT_RECONCILE_PROVIDER_TYPE;
      }
      getDescription() {
        return "Sealed Proof whole-project reconciliation provider";
      }
      async validateConfig(config) {
        return plain(config) && config.type === PROOF_PROJECT_RECONCILE_PROVIDER_TYPE && Object.keys(config).every((key) => ["type", "depends_on", "consumes", "emits", "wait_for_expansion"].includes(key));
      }
      async execute(_pr, _config, _deps, _context) {
        unavailable();
      }
      getSupportedConfigKeys() {
        return ["type", "depends_on", "consumes", "emits", "wait_for_expansion"];
      }
      async isAvailable() {
        return this.capability !== void 0;
      }
      getRequirements() {
        return [PROOF_ADMISSION_UNAVAILABLE];
      }
      startManaged(request) {
        if (!this.capability || !proofAdmissionCapabilityValid(this.capability) || request.checkConfig.type !== PROOF_PROJECT_RECONCILE_PROVIDER_TYPE || typeof request.workingDirectory !== "string" || request.workingDirectory.length === 0 || !request.workingDirectory.startsWith("/") || typeof request.proofProjectReconciliationRequest !== "string" || request.proofProjectReconciliationRequest.length === 0 || request.proofAdmissionRequest !== void 0) {
          unavailable();
        }
        const claims = request.executionContext?.claims;
        if (claims !== void 0 && (!plain(claims) || Object.keys(claims).length !== 0)) {
          unavailable();
        }
        const input = request.proofProjectReconciliationRequest;
        parseRequest(input);
        return startProofManagedCliChild({
          binding: request.binding,
          workingDirectory: request.workingDirectory,
          command: ["onboarding", "reconcile"],
          input,
          inputLimit: PROOF_PROJECT_RECONCILIATION_INPUT_MAX_BYTES,
          outputLimit: PROOF_PROJECT_RECONCILIATION_OUTPUT_MAX_BYTES,
          outputCanonical: false,
          projectOutput
        }, this.capability);
      }
    };
  }
});

// src/snapshot-store.ts
var snapshot_store_exports = {};
__export(snapshot_store_exports, {
  ContextView: () => ContextView,
  ExecutionJournal: () => ExecutionJournal,
  GraphJournalCheckpointError: () => GraphJournalCheckpointError,
  canonicalGraphCheckpointJson: () => canonicalGraphCheckpointJson
});
import { createHash } from "crypto";
function isGovernedCandidateClaim2(claim) {
  return claim === PROOF_CANDIDATE_CLAIM || claim === PROOF_COMPONENT_SPEC_REVIEW_CANDIDATE_CLAIM;
}
function checkpointObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : void 0;
}
function checkpointHasExactKeys(value, expected) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}
function checkpointString(value, field) {
  if (typeof value !== "string" || value.length === 0) {
    throw new GraphJournalCheckpointError("INVALID_CHECKPOINT_ENVELOPE", `${field} must be a non-empty string`);
  }
}
function checkpointSafeInteger(value, field, minimum = 0) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
    throw new GraphJournalCheckpointError("INVALID_CHECKPOINT_ENVELOPE", `${field} must be a safe integer >= ${minimum}`);
  }
}
function checkpointExactEventKeys(event, expected) {
  if (!checkpointHasExactKeys(event, expected)) {
    throw new GraphJournalCheckpointError("INVALID_CHECKPOINT_PREFIX", `Runtime event ${String(event.type)} has unknown or missing fields`);
  }
}
function isRecord(value) {
  return !!checkpointObject(value);
}
function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}
function proofDomainDigest(domain, encoded) {
  const bytes = Buffer.from(encoded, "utf8");
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(bytes.length));
  return `sha256:${createHash("sha256").update(domain, "utf8").update(Buffer.from([0])).update(length).update(bytes).digest("hex")}`;
}
function proofStructJson(fields) {
  return `{${fields.map(([key, value]) => `${JSON.stringify(key)}:${value}`).join(",")}}`;
}
function proofStringJson(value) {
  return goCompatibleProofJson(value);
}
function proofScopeJson(scope) {
  return `[${scope.map((segment) => proofStructJson([
    ["kind", proofStringJson(segment.kind)],
    ["expansion_owner_check", proofStringJson(segment.expansion_owner_check)],
    ["key", proofStringJson(segment.key)],
    ["subgraph_instance_id", proofStringJson(segment.subgraph_instance_id)]
  ])).join(",")}]`;
}
function proofProjectReconciliationReceiptIdentityJson(value) {
  const authority = value.project_authority;
  const catalogReceipt = value.catalog_revalidation_receipt;
  const admissions = value.component_admissions;
  const covered = value.covered_work_item_digests;
  if (!isRecord(authority) || !isRecord(catalogReceipt) || !Array.isArray(admissions) || !Array.isArray(covered)) {
    throw new ClaimKernelError("INVALID_PROOF_RECONCILIATION", "Project reconciliation receipt identity is not closed");
  }
  const authorityJson = proofStructJson([
    ["version", proofStringJson(String(authority.version))],
    ["project_id", proofStringJson(String(authority.project_id))],
    ["subject_fingerprint", proofStringJson(String(authority.subject_fingerprint))],
    ["code_fingerprint", proofStringJson(String(authority.code_fingerprint))],
    ["tests_fingerprint", proofStringJson(String(authority.tests_fingerprint))]
  ]);
  const admissionJson = `[${admissions.map((value2) => {
    if (!isRecord(value2)) throw new ClaimKernelError("INVALID_PROOF_RECONCILIATION", "Component admission is not an object");
    return proofStructJson([
      ["component_id", proofStringJson(String(value2.component_id))],
      ["work_item_digest", proofStringJson(String(value2.work_item_digest))],
      ["candidate_id", proofStringJson(String(value2.candidate_id))],
      ["result_digest", proofStringJson(String(value2.result_digest))],
      ["operational_scope_digest", proofStringJson(String(value2.operational_scope_digest))]
    ]);
  }).join(",")}]`;
  return proofStructJson([
    ["version", proofStringJson(String(value.version))],
    ["project_authority", authorityJson],
    ["catalog_revalidation_receipt", proofCatalogRevalidationReceiptIdentityJson(catalogReceipt)],
    ["component_admissions", admissionJson],
    ["covered_work_item_digests", goCompatibleProofJson(covered)],
    ["receipt_id", proofStringJson("")]
  ]);
}
function exactJsonRecord(value, expected) {
  return isRecord(value) && Reflect.ownKeys(value).length === expected.length && Reflect.ownKeys(value).every((key) => typeof key === "string" && expected.includes(key) && !!Object.getOwnPropertyDescriptor(value, key)?.enumerable);
}
function reconciliationFailure(detail) {
  throw new ClaimKernelError("INVALID_PROOF_RECONCILIATION", detail);
}
function componentAuthorityFailure(detail) {
  throw new ClaimKernelError("INVALID_PROOF_COMPONENT_AUTHORITY", detail);
}
function exactParentIds(actual, expected, label) {
  const sorted = [...actual].sort();
  if (actual.length !== expected.length || new Set(actual).size !== actual.length || canonicalJson(actual) !== canonicalJson(sorted) || canonicalJson(actual) !== canonicalJson([...expected].sort())) {
    componentAuthorityFailure(`${label} parents are not the exact sorted lineage`);
  }
}
function claimAt(projection, claimId, label, expectedClaim) {
  const claim = projection.claimsById[claimId];
  if (!claim || !claim.active || claim.claim !== expectedClaim) {
    componentAuthorityFailure(`${label} is missing, inactive, or has the wrong claim`);
  }
  return claim;
}
function generatedClaimView(claim, label) {
  if (claim.kind !== "generated-output" || claim.producerAttemptId === void 0 || claim.producerFence === void 0) {
    componentAuthorityFailure(`${label} is not an attempt-produced claim`);
  }
  return {
    claimId: claim.claimId,
    claim: claim.claim,
    payload: claim.payload,
    payloadFingerprint: claim.payloadFingerprint,
    producerCheckId: claim.producerCheckId,
    scope: claim.scope,
    parentClaimIds: claim.parentClaimIds,
    wireMode: claim.wireMode,
    provenance: "attempt",
    attemptId: claim.producerAttemptId,
    fence: claim.producerFence,
    ...isGovernedCandidateClaim2(claim.claim) && claim.proofCandidateEvidence ? { proofAdmission: claim.proofCandidateEvidence } : {}
  };
}
function assembleProofComponentInvocationAuthority(projection, component, admissionRequest, currentAuthorityBytes) {
  if (!component.active || component.kind !== "controller-item" || component.claim !== "component.work_item@1" || !component.controllerCatalogClaimId || component.parentClaimIds.length !== 1 || component.parentClaimIds[0] !== component.controllerCatalogClaimId) {
    componentAuthorityFailure("activated component WorkItem is not bound to one controller catalog");
  }
  const catalog = claimAt(projection, component.controllerCatalogClaimId, "component catalog", "component.catalog@1");
  const parentScope = component.scope.slice(0, -1);
  const parentScopeSegment = parentScope[parentScope.length - 1];
  const catalogProducer = catalog.nodeGenerationId ? projection.generationsById[catalog.nodeGenerationId] : void 0;
  if (catalog.kind !== "generated-output" || catalog.producerCheckId !== "materialize_catalog" || canonicalJson(catalog.scope) !== canonicalJson(parentScope) || !parentScopeSegment || catalog.subgraphInstanceId !== parentScopeSegment.subgraphInstanceId || !catalogProducer || catalogProducer.checkId !== "materialize_catalog" || catalogProducer.status !== "completed" || !catalogProducer.completedOutputClaimIds.includes(catalog.claimId) || catalog.producerAttemptId !== catalogProducer.attemptId || catalog.producerFence !== catalogProducer.fence) {
    componentAuthorityFailure("component catalog is not the exact materialization parent");
  }
  const componentInstance = projection.instancesById[component.subgraphInstanceId];
  if (!componentInstance || componentInstance.status !== "active" || componentInstance.catalogClaimId !== catalog.claimId || componentInstance.catalogProducerNodeGenerationId !== catalogProducer.nodeGenerationId || componentInstance.expansionOwnerNodeInstanceId !== catalogProducer.nodeInstanceId) {
    componentAuthorityFailure("component instance is not bound to the exact materialization source");
  }
  const catalogParents = catalog.parentClaimIds;
  if (catalogParents.length !== 4 || new Set(catalogParents).size !== 4 || canonicalJson(catalogParents) !== canonicalJson([...catalogParents].sort())) {
    componentAuthorityFailure("component catalog parent set is not exact");
  }
  const parents = catalogParents.map((claimId) => projection.claimsById[claimId]);
  if (parents.some((parent) => !parent || !parent.active)) componentAuthorityFailure("component catalog has an inactive parent");
  const inventory = parents.find((parent) => parent.claim === PROOF_STRUCTURAL_INVENTORY_CLAIM);
  const candidate = parents.find((parent) => parent.claim === PROOF_CANDIDATE_CLAIM);
  const admission = parents.find((parent) => parent.claim === PROOF_ADMITTED_RECEIPT_CLAIM);
  const revalidation = parents.find((parent) => parent.claim === PROOF_CATALOG_REVALIDATION_CLAIM);
  if (!inventory || !candidate || !admission || !revalidation || [inventory, candidate, admission, revalidation].some((claim, index, all) => all.indexOf(claim) !== index)) {
    componentAuthorityFailure("component catalog does not have one exact Proof lineage parent of each kind");
  }
  for (const claim of [inventory, candidate, admission, revalidation]) {
    if (canonicalJson(claim.scope) !== canonicalJson(catalog.scope)) componentAuthorityFailure("Proof lineage scope is detached");
  }
  if (candidate.producerCheckId !== "inspect" || candidate.kind !== "generated-output" || candidate.proofCandidateEvidence === void 0 || governedWireModeFromEvidence(candidate.proofCandidateEvidence) !== "proof" || candidate.proofCandidateEvidence.role.invocation.output_schema_id !== "proof.component-catalog-candidate@1") {
    componentAuthorityFailure("catalog parent is not a governed Proof candidate");
  }
  if (candidate.parentClaimIds.length !== 2 || !candidate.parentClaimIds.includes(inventory.claimId) || candidate.parentClaimIds.some((parentId) => !projection.claimsById[parentId]?.active) || canonicalJson(candidate.parentClaimIds) !== canonicalJson([...candidate.parentClaimIds].sort())) {
    componentAuthorityFailure("candidate ancestry is not exact");
  }
  exactParentIds(admission.parentClaimIds, [candidate.claimId], "admission");
  if (admission.kind !== "generated-output" || admission.producerCheckId !== PROOF_ADMIT_NODE_KEY || canonicalJson(admission.scope) !== canonicalJson(candidate.scope)) {
    componentAuthorityFailure("admission is not the exact proof_admit result");
  }
  exactParentIds(revalidation.parentClaimIds, [inventory.claimId, candidate.claimId, admission.claimId], "revalidation");
  if (revalidation.kind !== "generated-output" || revalidation.producerCheckId !== "revalidate_catalog" || canonicalJson(revalidation.scope) !== canonicalJson(candidate.scope)) {
    componentAuthorityFailure("revalidation is not the exact current catalog projection");
  }
  let candidateEnvelope;
  try {
    const parsed = JSON.parse(admissionRequest);
    if (!parsed || typeof parsed !== "object" || !parsed.candidate || typeof parsed.candidate !== "object" || Array.isArray(parsed.candidate)) {
      componentAuthorityFailure("admission request has no candidate envelope");
    }
    candidateEnvelope = parsed.candidate;
  } catch (error) {
    if (error instanceof ClaimKernelError) throw error;
    componentAuthorityFailure("admission request is not valid JSON");
  }
  const candidateView = generatedClaimView(candidate, "candidate");
  const admissionView = generatedClaimView(admission, "admission");
  let admitted;
  try {
    admitted = validateProofCandidateAdmissionBinding(candidateView, admissionView);
  } catch (error) {
    componentAuthorityFailure(`candidate admission binding is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const publication = candidateEnvelope.Publication;
  if (!publication || typeof publication !== "object" || Array.isArray(publication) || publication.ClaimID !== candidate.claimId || publication.Claim !== candidate.claim || publication.PayloadFingerprint !== candidate.payloadFingerprint || canonicalJson(publication.ParentClaimIDs) !== canonicalJson(candidate.parentClaimIds)) {
    componentAuthorityFailure("admission candidate envelope is detached from the candidate claim");
  }
  const candidateID = proofDomainDigest("proof.role-result-candidate-envelope/id/v1", proofComponentCandidateEnvelopeJson(candidateEnvelope));
  if (admitted.receipt.CandidateID !== candidateID) {
    componentAuthorityFailure("admission receipt CandidateID is detached from the authenticated candidate envelope");
  }
  let revalidationProjection;
  const inventoryPayload = inventory.payload;
  const projectID = candidate.payload?.project_id;
  if (typeof projectID !== "string" || !inventoryPayload || typeof inventoryPayload !== "object") componentAuthorityFailure("Proof lineage project is unavailable");
  try {
    revalidationProjection = currentAuthorityBytes ? currentAuthorityBytes.revalidation : validateProofCatalogRevalidationProjection(
      revalidation.payload,
      inventoryPayload,
      admitted.candidate,
      admissionView,
      projectID,
      generatedClaimView(revalidation, "revalidation"),
      inventory.claimId
    );
  } catch (error) {
    componentAuthorityFailure(`current revalidation is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const componentPayload = component.payload;
  if (!componentPayload || typeof componentPayload !== "object" || Array.isArray(componentPayload)) componentAuthorityFailure("component WorkItem payload is invalid");
  const payload = componentPayload;
  const mapping = payload.proof_path_mapping;
  const subject = payload.proof_component_subject;
  const workItem = {
    version: payload.version,
    project_id: payload.project_id,
    component_id: payload.component_id,
    sorted_owned_paths: payload.sorted_owned_paths,
    sorted_dependency_closure: payload.sorted_dependency_closure,
    proof_path_mapping: mapping && { paths: mapping.paths, components: mapping.components, owner: mapping.owner, risk_tier: mapping.risk_tier, enforcement: mapping.enforcement },
    proof_input_state: Array.isArray(payload.proof_input_state) ? payload.proof_input_state.map((row2) => ({ owner_kind: row2.owner_kind, owner_id: row2.owner_id, input_kind: row2.input_kind, path: row2.path, file_hash: row2.file_hash })) : payload.proof_input_state,
    proof_component_subject: subject && { version: subject.version, project_id: subject.project_id, component_id: subject.component_id, sorted_owned_paths: subject.sorted_owned_paths, sorted_dependency_closure: subject.sorted_dependency_closure, fingerprint: subject.fingerprint }
  };
  const revalidationReceipt = revalidationProjection.receipt;
  const row = revalidationReceipt && typeof revalidationReceipt === "object" && !Array.isArray(revalidationReceipt) ? revalidationReceipt.component_authorities?.find((value) => value && typeof value === "object" && !Array.isArray(value) && value.component_id === payload.component_id) : void 0;
  const workItemDigest = `sha256:${createHash("sha256").update(goCompatibleProofJson(workItem), "utf8").digest("hex")}`;
  const compact = payload.authority;
  if (!row || !compact || typeof compact !== "object" || Array.isArray(compact) || canonicalJson(compact) !== canonicalJson({ component_id: row.component_id, work_item_digest: row.work_item_digest, subject: row.subject }) || row.work_item_digest !== workItemDigest || canonicalJson(row.subject) !== canonicalJson(subject)) {
    componentAuthorityFailure("component WorkItem compact authority is detached from current revalidation");
  }
  let admissionDecision;
  try {
    admissionDecision = JSON.parse(admitted.wire);
  } catch {
    componentAuthorityFailure("admission decision wire is not JSON");
  }
  return validateProofComponentInvocationAuthority({
    work_item_digest: row.work_item_digest,
    subject: row.subject,
    candidate: admitted.candidate.payload,
    // Preserve the complete authenticated decision (version/status/receipt/
    // reject_code), not just its receipt projection.
    admission: admissionDecision,
    work_item: workItem,
    catalog_revalidation_receipt: revalidationReceipt
  });
}
function validateComponentAdmissionProtocol(projection, subgraphInstanceId, protocol, requireCompleted, candidateRequest) {
  const generations = Object.values(projection.generationsById).filter((generation) => generation.subgraphInstanceId === subgraphInstanceId);
  const candidateClaimName = protocol === "spec_review" ? PROOF_COMPONENT_SPEC_REVIEW_CANDIDATE_CLAIM : PROOF_CANDIDATE_CLAIM;
  const candidateNode = protocol === "spec_review" ? "spec_review" : "inspect";
  const admissionNode = protocol === "spec_review" ? "spec_review_admit" : PROOF_ADMIT_NODE_KEY;
  const receiptClaimName = protocol === "spec_review" ? PROOF_COMPONENT_SPEC_REVIEW_ADMITTED_RECEIPT_CLAIM : PROOF_ADMITTED_RECEIPT_CLAIM;
  const candidateGenerations = generations.filter((generation) => generation.templateNodeKey === candidateNode && generation.status === "completed");
  if (candidateGenerations.length === 0) {
    if (requireCompleted) componentAuthorityFailure("component admission has no completed inspect candidate");
    return;
  }
  if (candidateGenerations.length !== 1) componentAuthorityFailure("component candidate lineage is ambiguous");
  const candidateGeneration = candidateGenerations[0];
  const candidateClaims = candidateGeneration.completedOutputClaimIds.map((claimId) => projection.claimsById[claimId]).filter((claim) => claim?.claim === candidateClaimName);
  if (candidateClaims.length !== 1) componentAuthorityFailure("component inspect has no unique candidate output");
  const candidate = candidateClaims[0];
  if (candidate.producerCheckId !== candidateNode || candidate.nodeGenerationId !== candidateGeneration.nodeGenerationId || !candidate.proofCandidateEvidence || candidateGeneration.completedOutputClaimIds.length !== 1 || !candidateGeneration.scheduled || !candidateGeneration.activeInputClaimIds.every((id) => candidate.parentClaimIds.includes(id)) || canonicalJson(candidate.parentClaimIds) !== canonicalJson([...candidateGeneration.activeInputClaimIds].sort())) {
    componentAuthorityFailure("component candidate is detached from its exact generated inputs");
  }
  const admitGenerations = generations.filter((generation) => generation.templateNodeKey === admissionNode && generation.status === "completed");
  if (admitGenerations.length === 0) {
    if (requireCompleted) componentAuthorityFailure("component admission has not completed");
    return;
  }
  if (admitGenerations.length !== 1) componentAuthorityFailure("component admission lineage is ambiguous");
  const admissionGeneration = admitGenerations[0];
  if (admissionGeneration.activeInputClaimIds.length !== 1 || admissionGeneration.activeInputClaimIds[0] !== candidate.claimId) {
    componentAuthorityFailure("component admission does not consume the exact child candidate");
  }
  const admissionClaims = admissionGeneration.completedOutputClaimIds.map((claimId) => projection.claimsById[claimId]).filter((claim) => claim?.claim === receiptClaimName);
  if (admissionClaims.length !== 1) componentAuthorityFailure("component admission has no unique receipt output");
  if (admissionGeneration.completedOutputClaimIds.length !== 1 || admissionGeneration.checkId !== admissionNode || admissionGeneration.completedOutputClaimIds[0] !== admissionClaims[0].claimId || admissionClaims[0].producerCheckId !== admissionNode || admissionClaims[0].nodeGenerationId !== admissionGeneration.nodeGenerationId || !admissionGeneration.scheduled || canonicalJson(admissionClaims[0].parentClaimIds) !== canonicalJson([candidate.claimId])) {
    componentAuthorityFailure("component admission receipt is detached from its exact candidate");
  }
  if (protocol === "legacy") {
    try {
      validateProofComponentCandidateAdmissionBinding(generatedClaimView(candidate, "component candidate"), generatedClaimView(admissionClaims[0], "component admission"));
    } catch (error) {
      componentAuthorityFailure(`component admission is detached from its resolved C0 invocation: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const admissionPayload = admissionClaims[0].payload;
  const admissionWire = isRecord(admissionPayload) && typeof admissionPayload[PROOF_ADMISSION_WIRE_FIELD] === "string" ? admissionPayload[PROOF_ADMISSION_WIRE_FIELD] : void 0;
  let validated;
  try {
    if (!admissionWire) throw new Error("admission wire is missing");
    const extracted = extractProofAdmissionCandidate(candidateRequest(admissionGeneration.nodeGenerationId));
    validated = validateProofComponentAdmissionOutcome(extracted.candidateRaw, admissionWire);
    const receipt = JSON.parse(admissionWire).receipt;
    const expectedPayload = { ...receipt, [PROOF_ADMISSION_WIRE_FIELD]: admissionWire };
    if (!isRecord(admissionPayload) || canonicalJson(admissionPayload) !== canonicalJson(expectedPayload) || canonicalJson(extracted.candidate.Publication) !== canonicalJson({
      ...extracted.candidate.Publication,
      ClaimID: candidate.claimId,
      Claim: candidate.claim,
      PayloadFingerprint: candidate.payloadFingerprint,
      ParentClaimIDs: candidate.parentClaimIds
    })) {
      throw new Error("published admission payload is detached from the validated receipt");
    }
    const evidence = candidate.proofCandidateEvidence;
    if (validated.resultDigest !== evidence.probe.resultIdentity.resultDigest || canonicalJson(validated.subject) !== canonicalJson(evidence.role.invocation.subject) || validated.scope.length !== candidate.scope.length || validated.scope.some((segment, index) => canonicalJson(segment) !== canonicalJson({
      kind: candidate.scope[index].kind,
      expansion_owner_check: candidate.scope[index].expansionOwnerCheck,
      key: candidate.scope[index].key,
      subgraph_instance_id: candidate.scope[index].subgraphInstanceId
    }))) throw new Error("validated admission projection is detached");
  } catch (error) {
    componentAuthorityFailure(`${protocol} admission receipt is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!validated) componentAuthorityFailure(`${protocol} admission receipt was not validated`);
  if (protocol !== "spec_review") return;
  const stageCandidate = candidate;
  const stageParents = stageCandidate.parentClaimIds.map((id) => projection.claimsById[id]);
  const component = stageParents.find((claim) => claim?.claim === "component.work_item@1");
  const priorCandidate = stageParents.find((claim) => claim?.claim === PROOF_CANDIDATE_CLAIM);
  const priorAdmission = stageParents.find((claim) => claim?.claim === PROOF_ADMITTED_RECEIPT_CLAIM);
  if (stageParents.length !== 3 || !component || !priorCandidate || !priorAdmission || new Set(stageCandidate.parentClaimIds).size !== 3 || canonicalJson(stageCandidate.parentClaimIds) !== canonicalJson([...stageCandidate.parentClaimIds].sort()) || stageParents.some((claim) => !claim || !claim.active || canonicalJson(claim.scope) !== canonicalJson(stageCandidate.scope)) || component.kind !== "controller-item" || component.parentClaimIds.length !== 1 || priorCandidate.kind !== "generated-output" || priorCandidate.producerCheckId !== "inspect" || priorAdmission.kind !== "generated-output" || priorAdmission.producerCheckId !== PROOF_ADMIT_NODE_KEY || canonicalJson(priorAdmission.parentClaimIds) !== canonicalJson([priorCandidate.claimId])) {
    componentAuthorityFailure("spec_review candidate parents are not the exact WorkItem/candidate/admission lineage");
  }
  if (!stageCandidate.proofCandidateEvidence) componentAuthorityFailure("spec_review candidate has no governed evidence");
  const invocation = stageCandidate.proofCandidateEvidence.role.invocation;
  const stage = invocation.onboarding_stage;
  if (!isRecord(stage) || typeof stage.prior_candidate !== "string" || typeof stage.prior_admission !== "string" || stage.prior_admission_claim_id !== priorAdmission.claimId || stage.prior_admission_payload_fingerprint !== priorAdmission.payloadFingerprint) {
    componentAuthorityFailure("spec_review onboarding context is detached from its admitted predecessor");
  }
  try {
    const priorEnvelope = JSON.parse(stage.prior_candidate);
    const publication = priorEnvelope.Publication;
    if (proofComponentCandidateEnvelopeJson(priorEnvelope) !== stage.prior_candidate || publication.ClaimID !== priorCandidate.claimId || publication.Claim !== priorCandidate.claim || publication.PayloadFingerprint !== priorCandidate.payloadFingerprint || canonicalJson(publication.ParentClaimIDs) !== canonicalJson(priorCandidate.parentClaimIds)) {
      componentAuthorityFailure("spec_review prior candidate wire is detached from its parent claim");
    }
    const admissionPayload2 = priorAdmission.payload;
    if (!isRecord(admissionPayload2) || admissionPayload2[PROOF_ADMISSION_WIRE_FIELD] !== stage.prior_admission) {
      componentAuthorityFailure("spec_review prior admission wire is detached from its parent claim");
    }
  } catch (error) {
    if (error instanceof ClaimKernelError) throw error;
    componentAuthorityFailure(`spec_review predecessor wire is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(component.payload) || !isRecord(component.payload.proof_component_subject) || !isRecord(component.payload.authority) || !isRecord(invocation.subject) || !isRecord(invocation.component_authority) || canonicalJson(invocation.subject) !== canonicalJson({ kind: "component", id: component.payload.component_id, fingerprint: component.payload.proof_component_subject.fingerprint }) || invocation.component_authority && (!isRecord(invocation.component_authority.subject) || canonicalJson(invocation.component_authority.subject) !== canonicalJson(component.payload.proof_component_subject) || invocation.component_authority.work_item_digest !== component.payload.authority.work_item_digest)) {
    componentAuthorityFailure("spec_review component authority is detached from its WorkItem parent");
  }
}
function validateComponentChildAdmission(projection, subgraphInstanceId, requireCompleted, candidateRequest) {
  validateComponentAdmissionProtocol(projection, subgraphInstanceId, "legacy", requireCompleted, candidateRequest);
  const hasStage = Object.values(projection.generationsById).some((generation) => generation.subgraphInstanceId === subgraphInstanceId && (generation.templateNodeKey === "spec_review" || generation.templateNodeKey === "spec_review_admit"));
  if (hasStage) validateComponentAdmissionProtocol(projection, subgraphInstanceId, "spec_review", false, candidateRequest);
}
function checkpointWrap(code, message, error) {
  if (error instanceof GraphJournalCheckpointError) return error;
  return new GraphJournalCheckpointError(code, message, { cause: error });
}
function eventHasNodeDiscriminator(event) {
  return hasOwn(event, "nodeInstanceId") || hasOwn(event, "nodeGenerationId");
}
function eventHasRequestDiscriminator(event) {
  return hasOwn(event, "requestId");
}
function validateCheckpointEventShape(value) {
  let event = checkpointObject(value);
  if (!event || typeof event.type !== "string") {
    throw new GraphJournalCheckpointError("INVALID_CHECKPOINT_PREFIX", "Runtime event must be an object with a discriminator");
  }
  if (event.type === "ClaimPublished" && eventHasNodeDiscriminator(event) && !hasOwn(event, "wireMode")) {
    let wireMode = "generic";
    if (typeof event.claim === "string" && isGovernedCandidateClaim2(event.claim)) {
      try {
        wireMode = governedWireModeFromEvidence(validateProofCandidateEvidence(event.proofCandidateEvidence));
      } catch (error) {
        throw checkpointWrap("INVALID_CHECKPOINT_PREFIX", "Legacy Proof candidate publication cannot derive its wire mode", error);
      }
    }
    event = { ...event, wireMode };
  }
  const exact = (keys) => checkpointExactEventKeys(event, keys);
  const base = () => {
    if (event.version !== 1 || typeof event.eventId !== "number" || !Number.isSafeInteger(event.eventId) || event.eventId < 1 || typeof event.sessionId !== "string" || event.sessionId.length === 0 || typeof event.scope === "undefined") {
      throw new GraphJournalCheckpointError("INVALID_CHECKPOINT_PREFIX", `Runtime event ${event.type} has invalid base fields`);
    }
  };
  switch (event.type) {
    case "CatalogReconciliationRequested":
      exact(["version", "type", "eventId", "sessionId", "scope", "requestId", "requestOrdinal", "expansionOwnerCheck", "status"]);
      base();
      if (typeof event.requestId !== "string" || typeof event.expansionOwnerCheck !== "string" || event.status !== "pending" || typeof event.requestOrdinal !== "number" || !Number.isSafeInteger(event.requestOrdinal) || event.requestOrdinal < 1) {
        throw new GraphJournalCheckpointError("INVALID_CHECKPOINT_PREFIX", "Catalog request event has invalid fields");
      }
      return event;
    case "SubgraphExpanded": {
      const nested = event.parentSubgraphInstanceId !== null;
      exact(nested ? ["version", "type", "eventId", "sessionId", "scope", "expansionOwnerCheck", "graphSemanticDigest", "expansionSpecDigest", "templateDigest", "parentSubgraphInstanceId", "expansionOwnerNodeInstanceId", "catalogClaimRef", "catalogClaimId", "itemKey", "subgraphInstanceId", "nodeInstanceIdsByTemplateNode"] : ["version", "type", "eventId", "sessionId", "scope", "expansionOwnerCheck", "graphSemanticDigest", "expansionSpecDigest", "templateDigest", "parentSubgraphInstanceId", "catalogClaimId", "itemKey", "subgraphInstanceId", "nodeInstanceIdsByTemplateNode"]);
      base();
      if (typeof event.expansionOwnerCheck !== "string" || typeof event.graphSemanticDigest !== "string" || typeof event.expansionSpecDigest !== "string" || typeof event.templateDigest !== "string" || nested && (typeof event.expansionOwnerNodeInstanceId !== "string" || typeof event.catalogClaimRef !== "string") || typeof event.catalogClaimId !== "string" || typeof event.itemKey !== "string" || typeof event.subgraphInstanceId !== "string" || !isRecord(event.nodeInstanceIdsByTemplateNode)) {
        throw new GraphJournalCheckpointError("INVALID_CHECKPOINT_PREFIX", "Expanded subgraph event has invalid fields");
      }
      return event;
    }
    case "ProofCurrentCatalogAuthorityRecorded":
      exact([
        "version",
        "type",
        "eventId",
        "sessionId",
        "scope",
        "projectSubgraphInstanceId",
        "sourceCatalogClaimId",
        "previousAuthorityId",
        "authorityId",
        "revalidationBytesBase64",
        "workItemsBytesBase64"
      ]);
      base();
      if (typeof event.projectSubgraphInstanceId !== "string" || typeof event.sourceCatalogClaimId !== "string" || typeof event.previousAuthorityId !== "string" || typeof event.authorityId !== "string" || typeof event.revalidationBytesBase64 !== "string" || typeof event.workItemsBytesBase64 !== "string") {
        throw new GraphJournalCheckpointError("INVALID_CHECKPOINT_PREFIX", "Proof rebase event has invalid fields");
      }
      for (const field of [
        "projectSubgraphInstanceId",
        "sourceCatalogClaimId",
        "previousAuthorityId",
        "authorityId"
      ]) {
        if (!CHECKPOINT_SHA256.test(event[field])) {
          throw new GraphJournalCheckpointError("INVALID_CHECKPOINT_PREFIX", `Proof rebase ${field} is not a SHA-256 identity`);
        }
      }
      return event;
    case "ProofCurrentCatalogAuthorityApplied":
      exact([
        "version",
        "type",
        "eventId",
        "sessionId",
        "scope",
        "projectSubgraphInstanceId",
        "authorityId",
        "mutationEventCount",
        "mutationEventsDigest"
      ]);
      base();
      if (typeof event.projectSubgraphInstanceId !== "string" || typeof event.authorityId !== "string" || typeof event.mutationEventCount !== "number" || !Number.isSafeInteger(event.mutationEventCount) || event.mutationEventCount < 0 || typeof event.mutationEventsDigest !== "string" || !CHECKPOINT_SHA256.test(event.projectSubgraphInstanceId) || !CHECKPOINT_SHA256.test(event.authorityId) || !CHECKPOINT_SHA256.test(event.mutationEventsDigest)) {
        throw new GraphJournalCheckpointError("INVALID_CHECKPOINT_PREFIX", "Proof authority application header has invalid fields");
      }
      return event;
    case "ControllerItemClaimPublished":
      exact(["version", "type", "eventId", "sessionId", "scope", "expansionOwnerCheck", "expansionSpecDigest", "catalogClaimId", "itemKey", "subgraphInstanceId", "incarnation", "claimId", "claim", "payload", "payloadFingerprint", "parentClaimIds"]);
      base();
      if (typeof event.expansionOwnerCheck !== "string" || typeof event.expansionSpecDigest !== "string" || typeof event.catalogClaimId !== "string" || typeof event.itemKey !== "string" || typeof event.subgraphInstanceId !== "string" || typeof event.incarnation !== "number" || !Number.isSafeInteger(event.incarnation) || event.incarnation < 1 || typeof event.claimId !== "string" || typeof event.claim !== "string" || typeof event.payloadFingerprint !== "string" || !Array.isArray(event.parentClaimIds)) throw new GraphJournalCheckpointError("INVALID_CHECKPOINT_PREFIX", "Controller item event has invalid fields");
      return event;
    case "NodeGenerationInactivated":
      exact(["version", "type", "eventId", "sessionId", "scope", "subgraphInstanceId", "nodeInstanceId", "nodeGenerationId", "incarnation", "outputClaimIds", "reason"]);
      base();
      if (typeof event.subgraphInstanceId !== "string" || typeof event.nodeInstanceId !== "string" || typeof event.nodeGenerationId !== "string" || typeof event.incarnation !== "number" || !Number.isSafeInteger(event.incarnation) || event.incarnation < 0 || !Array.isArray(event.outputClaimIds) || event.reason !== "superseded") {
        throw new GraphJournalCheckpointError("INVALID_CHECKPOINT_PREFIX", "Generation inactivation event has invalid fields");
      }
      return event;
    case "NodeGenerationActivated":
      exact([
        "version",
        "type",
        "eventId",
        "sessionId",
        "scope",
        "subgraphInstanceId",
        "nodeInstanceId",
        "nodeGenerationId",
        "templateNodeKey",
        "checkId",
        "incarnation",
        "itemFingerprint",
        "executionConfigDigest",
        "activeInputClaimIds",
        ...hasOwn(event, "nestedExpansionCatalogClaimRef") ? ["nestedExpansionCatalogClaimRef"] : [],
        ...hasOwn(event, "expansionBarrierDigest") ? ["expansionBarrierDigest"] : []
      ]);
      base();
      if (typeof event.subgraphInstanceId !== "string" || typeof event.nodeInstanceId !== "string" || typeof event.nodeGenerationId !== "string" || typeof event.templateNodeKey !== "string" || typeof event.checkId !== "string" || typeof event.incarnation !== "number" || !Number.isSafeInteger(event.incarnation) || event.incarnation < 0 || typeof event.itemFingerprint !== "string" || typeof event.executionConfigDigest !== "string" || !Array.isArray(event.activeInputClaimIds) || hasOwn(event, "nestedExpansionCatalogClaimRef") && typeof event.nestedExpansionCatalogClaimRef !== "string" || hasOwn(event, "expansionBarrierDigest") && (typeof event.expansionBarrierDigest !== "string" || !CHECKPOINT_SHA256.test(event.expansionBarrierDigest))) throw new GraphJournalCheckpointError("INVALID_CHECKPOINT_PREFIX", "Generation activation event has invalid fields");
      return event;
    case "SubgraphTombstoned":
      exact(["version", "type", "eventId", "sessionId", "scope", "expansionOwnerCheck", "sourceCatalogClaimId", "itemKey", "subgraphInstanceId", "lastIncarnation", "nodeGenerationIds", "outputClaimIds"]);
      base();
      if (typeof event.expansionOwnerCheck !== "string" || typeof event.sourceCatalogClaimId !== "string" || typeof event.itemKey !== "string" || typeof event.subgraphInstanceId !== "string" || typeof event.lastIncarnation !== "number" || !Number.isSafeInteger(event.lastIncarnation) || event.lastIncarnation < 0 || !Array.isArray(event.nodeGenerationIds) || !Array.isArray(event.outputClaimIds)) throw new GraphJournalCheckpointError("INVALID_CHECKPOINT_PREFIX", "Tombstone event has invalid fields");
      return event;
    case "ManagedRunAcquisitionFailed":
      exact(["version", "type", "eventId", "sessionId", "scope", "binding", "failureCode"]);
      base();
      if (!isRecord(event.binding) || typeof event.failureCode !== "string") throw new GraphJournalCheckpointError("INVALID_CHECKPOINT_PREFIX", "Managed acquisition event has invalid fields");
      return event;
    case "ManagedRunAcquired":
    case "ManagedRunStarted":
      exact(["version", "type", "eventId", "sessionId", "scope", "binding"]);
      base();
      if (!isRecord(event.binding)) throw new GraphJournalCheckpointError("INVALID_CHECKPOINT_PREFIX", "Managed lifecycle event has invalid binding");
      return event;
    case "ManagedRunCancelRequested":
      exact(["version", "type", "eventId", "sessionId", "scope", "binding", "reason"]);
      base();
      if (!isRecord(event.binding) || event.reason !== "deadline") throw new GraphJournalCheckpointError("INVALID_CHECKPOINT_PREFIX", "Managed cancel event has invalid fields");
      return event;
    case "ManagedRunTerminated":
      exact(["version", "type", "eventId", "sessionId", "scope", "binding", "cleanupStatus", "controllerDecision", "failureCode"]);
      base();
      if (!isRecord(event.binding) || event.cleanupStatus !== "clean" && event.cleanupStatus !== "unverified" || event.controllerDecision !== "completed" && event.controllerDecision !== "failed" || event.failureCode !== null && typeof event.failureCode !== "string") throw new GraphJournalCheckpointError("INVALID_CHECKPOINT_PREFIX", "Managed terminal event has invalid fields");
      return event;
    case "AttemptRetryRequested":
      exact([
        "version",
        "type",
        "eventId",
        "sessionId",
        "scope",
        "nodeInstanceId",
        "nodeGenerationId",
        "checkId",
        "incarnation",
        "itemFingerprint",
        "executionConfigDigest",
        "activeInputClaimIds",
        "priorAttemptId",
        "priorFence",
        "priorFailureReason",
        "externalSideEffects"
      ]);
      base();
      if (typeof event.nodeInstanceId !== "string" || typeof event.nodeGenerationId !== "string" || typeof event.checkId !== "string" || typeof event.incarnation !== "number" || !Number.isSafeInteger(event.incarnation) || event.incarnation < 0 || typeof event.itemFingerprint !== "string" || typeof event.executionConfigDigest !== "string" || !Array.isArray(event.activeInputClaimIds) || typeof event.priorAttemptId !== "string" || typeof event.priorFence !== "number" || !Number.isSafeInteger(event.priorFence) || event.priorFence < 1 || typeof event.priorFailureReason !== "string" || event.externalSideEffects !== "absent" && event.externalSideEffects !== "safely_idempotent" && event.externalSideEffects !== "isolated_draft_replay") {
        throw new GraphJournalCheckpointError("INVALID_CHECKPOINT_PREFIX", "Generated retry event has invalid fields");
      }
      return event;
    case "AttemptStarted":
    case "CheckScheduled":
    case "AttemptCompleted":
    case "AttemptFailed": {
      const node = eventHasNodeDiscriminator(event);
      const request = eventHasRequestDiscriminator(event);
      if (node && request) throw new GraphJournalCheckpointError("INVALID_CHECKPOINT_PREFIX", `${event.type} cannot carry request and node discriminators`);
      const keys = [...ATTEMPT_BASE_KEYS];
      if (node) keys.push("nodeInstanceId", "nodeGenerationId");
      else if (request) keys.push("requestId");
      if (event.type === "CheckScheduled") keys.push("claimIds");
      if (event.type === "AttemptCompleted" && request) keys.push("catalogClaimId");
      if (event.type === "AttemptFailed") keys.push("reason");
      exact(keys);
      base();
      if (typeof event.checkId !== "string" || typeof event.attemptId !== "string" || typeof event.fence !== "number" || !Number.isSafeInteger(event.fence) || event.fence < 1 || node && (typeof event.nodeInstanceId !== "string" || typeof event.nodeGenerationId !== "string") || request && typeof event.requestId !== "string" || event.type === "CheckScheduled" && !Array.isArray(event.claimIds) || event.type === "AttemptCompleted" && request && typeof event.catalogClaimId !== "string" || event.type === "AttemptFailed" && typeof event.reason !== "string") {
        throw new GraphJournalCheckpointError("INVALID_CHECKPOINT_PREFIX", `${event.type} has invalid fields`);
      }
      return event;
    }
    case "ClaimPublished": {
      const node = eventHasNodeDiscriminator(event);
      if (eventHasRequestDiscriminator(event)) throw new GraphJournalCheckpointError("INVALID_CHECKPOINT_PREFIX", "ClaimPublished cannot carry requestId");
      const claimStr = typeof event.claim === "string" ? event.claim : "";
      const sidecar = isGovernedCandidateClaim2(claimStr) && hasOwn(event, "proofCandidateEvidence");
      if (isGovernedCandidateClaim2(claimStr) && (!sidecar || !hasOwn(event, "proofCandidateEvidenceFingerprint")) || !isGovernedCandidateClaim2(claimStr) && (hasOwn(event, "proofCandidateEvidence") || hasOwn(event, "proofCandidateEvidenceFingerprint"))) throw new GraphJournalCheckpointError("INVALID_CHECKPOINT_PREFIX", "Proof evidence sidecar fields are not paired or reserved");
      const evidenceKeys = sidecar ? ["proofCandidateEvidence", "proofCandidateEvidenceFingerprint"] : [];
      const keys = node ? [...ATTEMPT_BASE_KEYS, "nodeInstanceId", "nodeGenerationId", "claimId", "claim", "payload", "payloadFingerprint", "producerCheckId", "parentClaimIds", "wireMode", ...evidenceKeys] : [...ATTEMPT_BASE_KEYS, "claimId", "claim", "payload", "payloadFingerprint", "producerCheckId", "parentClaimIds", ...evidenceKeys];
      exact(keys);
      base();
      if (typeof event.checkId !== "string" || typeof event.attemptId !== "string" || typeof event.fence !== "number" || !Number.isSafeInteger(event.fence) || event.fence < 1 || typeof event.claimId !== "string" || typeof event.claim !== "string" || typeof event.payloadFingerprint !== "string" || typeof event.producerCheckId !== "string" || !Array.isArray(event.parentClaimIds) || node && (typeof event.nodeInstanceId !== "string" || typeof event.nodeGenerationId !== "string" || event.wireMode !== "generic" && event.wireMode !== "proof") || sidecar && typeof event.proofCandidateEvidenceFingerprint !== "string") throw new GraphJournalCheckpointError("INVALID_CHECKPOINT_PREFIX", "Claim publication has invalid fields");
      return event;
    }
    default:
      throw new GraphJournalCheckpointError("INVALID_CHECKPOINT_PREFIX", `Unknown runtime event type ${event.type}`);
  }
}
function routeCheckpointEvent(event) {
  if (event.type === "ClaimPublished") return "nodeGenerationId" in event ? { claim: false, instance: true } : { claim: true, instance: false };
  if (event.type === "AttemptStarted" || event.type === "CheckScheduled" || event.type === "AttemptCompleted" || event.type === "AttemptFailed") {
    if ("nodeGenerationId" in event) return { claim: false, instance: true };
    if ("requestId" in event) return { claim: true, instance: true };
    return { claim: true, instance: false };
  }
  return { claim: false, instance: true };
}
function checkpointAuthorityFailure(message) {
  throw new GraphJournalCheckpointError("CHECKPOINT_PLAN_AUTHORITY_MISMATCH", message);
}
function isExactProofProjectReconciliationInactivation(projection, event) {
  if (!event || event.type !== "NodeGenerationInactivated") return false;
  const project = projection.instancesById[event.subgraphInstanceId];
  if (!project || project.status !== "active" || project.parentSubgraphInstanceId !== void 0 || project.scope.length !== 1) return false;
  const nodeKeys = Object.keys(project.nodeInstanceIdsByTemplateNode).sort();
  if (nodeKeys.length !== 7 || canonicalJson(nodeKeys) !== canonicalJson([
    "inspect",
    "materialize_catalog",
    PROOF_PROJECT_RECONCILE_NODE_KEY,
    PROOF_ADMIT_NODE_KEY,
    "revalidate_catalog",
    "structural_inventory",
    "verify"
  ].sort())) return false;
  const nodeInstanceId = project.nodeInstanceIdsByTemplateNode[PROOF_PROJECT_RECONCILE_NODE_KEY];
  const generation = projection.generationsById[event.nodeGenerationId];
  return !!nodeInstanceId && event.nodeInstanceId === nodeInstanceId && !!generation && generation.nodeInstanceId === nodeInstanceId && generation.subgraphInstanceId === project.subgraphInstanceId && generation.templateNodeKey === PROOF_PROJECT_RECONCILE_NODE_KEY && generation.checkId === PROOF_PROJECT_RECONCILE_NODE_KEY && projection.activeGenerationIdByNode[nodeInstanceId] === generation.nodeGenerationId;
}
function expansionForCheckpoint(plan, owner, nested) {
  const expansion = nested ? plan.expansionPlan?.byNestedOwner[owner] : plan.expansionPlan?.byOwner[owner];
  if (!expansion) checkpointAuthorityFailure(`Unknown compiled expansion owner ${owner}`);
  return expansion;
}
function proofProjectExpansionForPlan(plan, project) {
  if (!project || project.parentSubgraphInstanceId !== void 0 || project.scope.length !== 1) {
    checkpointAuthorityFailure("Proof current authority requires a root project instance");
  }
  const expansion = plan.expansionPlan?.byOwner[project.expansionOwnerCheck];
  const materialize = expansion?.template.nodesByKey.materialize_catalog;
  const nested = expansion ? plan.expansionPlan?.byNestedOwner[qualifiedNestedExpansionOwner(expansion.template.name, "materialize_catalog")] : void 0;
  if (!expansion || expansion.depth !== 1 || expansion.parentTemplateName !== null || expansion.parentTemplateNodeKey !== null || expansion.template.input.claim !== "project.discovery_item@1" || expansion.catalogClaimRef !== "project.catalog@1" || expansion.itemClaimRef !== "project.discovery_item@1" || !materialize || materialize.check.type !== PROOF_ADMITTED_CATALOG_PROVIDER_TYPE || materialize.emissions.length !== 1 || materialize.emissions[0].claim !== "component.catalog@1" || !nested || nested.depth !== 2 || nested.catalogClaimRef !== "component.catalog@1" || nested.itemClaimRef !== "component.work_item@1" || nested.template.input.claim !== "component.work_item@1") {
    checkpointAuthorityFailure("Proof current authority is not bound to the reserved project expansion");
  }
  return expansion;
}
function expansionBarrierForProjection(plan, projection, instance, node, completingGenerationId) {
  const wait = node.waitForExpansion;
  if (!wait) return { ownerCompleted: true, selectionAuthoritative: true, ready: true, digest: "" };
  const parentExpansion = instance.parentSubgraphInstanceId ? plan.expansionPlan?.byNestedOwner[instance.expansionOwnerCheck] : plan.expansionPlan?.byOwner[instance.expansionOwnerCheck];
  const nestedExpansion = parentExpansion ? plan.expansionPlan?.byNestedOwner[qualifiedNestedExpansionOwner(parentExpansion.template.name, wait.owner)] : void 0;
  if (!parentExpansion || !nestedExpansion) throw new Error("Wait barrier expansion owner is not compiled");
  if (parentExpansion.expansionSpecDigest !== instance.expansionSpecDigest) {
    throw new Error("Wait barrier instance is not bound to its compiled expansion");
  }
  const ownerNodeInstanceId = instance.nodeInstanceIdsByTemplateNode[wait.owner];
  const ownerGenerationId = ownerNodeInstanceId ? projection.activeGenerationIdByNode[ownerNodeInstanceId] : void 0;
  const ownerGeneration = ownerGenerationId ? projection.generationsById[ownerGenerationId] : void 0;
  const catalog = ownerGeneration?.nestedExpansionCatalogClaimRef === nestedExpansion.catalogClaimRef ? Object.values(projection.claimsById).find((claim) => claim.active && claim.kind === "generated-output" && claim.claim === nestedExpansion.catalogClaimRef && claim.nodeGenerationId === ownerGeneration.nodeGenerationId && claim.subgraphInstanceId === instance.subgraphInstanceId && scopePathEquals(claim.scope, instance.scope) && claim.producerCheckId === ownerGeneration.checkId && claim.producerAttemptId === ownerGeneration.attemptId && claim.producerFence === ownerGeneration.fence && ownerGeneration.completedOutputClaimIds.includes(claim.claimId)) : void 0;
  const ownerComplete = !!ownerGeneration && ownerGeneration.scheduled && (ownerGeneration.status === "completed" || ownerGeneration.nodeGenerationId === completingGenerationId);
  const selectedKeys = /* @__PURE__ */ new Set();
  if (catalog) {
    try {
      nestedExpansion.catalogValidator(catalog.payload);
      const rawItems = resolveJsonPointer(catalog.payload, nestedExpansion.itemsPointer);
      if (!Array.isArray(rawItems)) throw new Error("catalog items pointer is not an array");
      for (const item of rawItems) {
        nestedExpansion.itemValidator(item);
        const key = canonicalCatalogKey(resolveJsonPointer(item, nestedExpansion.keyPointer));
        if (selectedKeys.has(key)) throw new Error(`duplicate catalog key ${key}`);
        selectedKeys.add(key);
      }
    } catch (error) {
      throw new Error(`Wait barrier catalog is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  const allChildren = Object.values(projection.instancesById).filter((candidate) => candidate.status === "active" && candidate.parentSubgraphInstanceId === instance.subgraphInstanceId && candidate.expansionOwnerNodeInstanceId === ownerNodeInstanceId).sort((left, right) => Buffer.from(left.itemKey, "utf8").compare(Buffer.from(right.itemKey, "utf8")));
  const selectedChildren = allChildren.filter((child) => selectedKeys.has(child.itemKey));
  const exactSelection = ownerComplete && !!catalog && selectedChildren.length === selectedKeys.size && allChildren.length === selectedChildren.length && selectedChildren.every((child) => child.catalogClaimId === catalog.claimId);
  const children = selectedChildren.map((child) => {
    const item = child.activeItemClaimId ? projection.claimsById[child.activeItemClaimId] : void 0;
    const terminalNodeInstanceId = child.nodeInstanceIdsByTemplateNode[wait.terminal_node];
    const terminalGenerationId = terminalNodeInstanceId ? projection.activeGenerationIdByNode[terminalNodeInstanceId] : void 0;
    const terminalGeneration = terminalGenerationId ? projection.generationsById[terminalGenerationId] : void 0;
    return {
      itemKey: child.itemKey,
      workItemFingerprint: item?.active ? item.payloadFingerprint : null,
      terminalGenerationId: terminalGeneration?.nodeGenerationId || null,
      terminalGenerationStatus: !item?.active ? "detached" : !terminalGeneration ? "missing" : terminalGeneration.nodeGenerationId === completingGenerationId ? "completed" : terminalGeneration.status,
      nestedCatalogClaimId: child.catalogClaimId,
      nestedCatalogProducerGenerationId: child.catalogProducerNodeGenerationId || null
    };
  });
  return {
    ownerCompleted: ownerComplete,
    selectionAuthoritative: exactSelection,
    ready: exactSelection && children.every((child) => child.terminalGenerationStatus === "completed"),
    digest: deriveExpansionBarrierDigest({
      expansionOwnerCheck: nestedExpansion.expansionOwnerCheck,
      terminalNode: wait.terminal_node,
      nestedExpansionSpecDigest: nestedExpansion.expansionSpecDigest,
      nestedTemplateDigest: nestedExpansion.templateDigest,
      nestedCatalogClaimId: catalog?.claimId || "",
      children
    })
  };
}
function checkpointExpansionBarrier(plan, projection, instance, node, completingGenerationId) {
  try {
    return expansionBarrierForProjection(plan, projection, instance, node, completingGenerationId);
  } catch (error) {
    checkpointAuthorityFailure(error instanceof Error ? error.message : String(error));
  }
}
function validateCheckpointBarrierCompleteness(plan, projection) {
  for (const instance of Object.values(projection.instancesById)) {
    if (instance.status !== "active") continue;
    const expansion = instance.parentSubgraphInstanceId ? plan.expansionPlan?.byNestedOwner[instance.expansionOwnerCheck] : plan.expansionPlan?.byOwner[instance.expansionOwnerCheck];
    if (!expansion) continue;
    for (const nodeKey of expansion.template.templateNodeKeys) {
      const node = expansion.template.nodesByKey[nodeKey];
      if (!node.waitForExpansion) continue;
      const barrier = checkpointExpansionBarrier(plan, projection, instance, node);
      const nodeInstanceId = instance.nodeInstanceIdsByTemplateNode[nodeKey];
      const activeGenerationId = projection.activeGenerationIdByNode[nodeInstanceId];
      const activeGeneration = activeGenerationId ? projection.generationsById[activeGenerationId] : void 0;
      if (barrier.ownerCompleted && !barrier.selectionAuthoritative) {
        checkpointAuthorityFailure(`Wait barrier ${instance.subgraphInstanceId}.${nodeKey} has an incomplete catalog child selection`);
      }
      if (barrier.ready) {
        if (!activeGeneration || activeGeneration.expansionBarrierDigest !== barrier.digest) {
          checkpointAuthorityFailure(`Ready wait barrier ${instance.subgraphInstanceId}.${nodeKey} has no exact active generation`);
        }
      } else if (activeGeneration?.expansionBarrierDigest !== void 0) {
        checkpointAuthorityFailure(`Unready wait barrier ${instance.subgraphInstanceId}.${nodeKey} has an active generation`);
      }
    }
  }
}
function validateCheckpointPlanAuthority(event, plan, claimProjection, instanceProjection, legacyProofWireMode = false, completingGenerationId) {
  const expansionPlan = plan.expansionPlan;
  if (!expansionPlan?.active) checkpointAuthorityFailure("Checkpoint requires an active expansion plan");
  const asRecord = event;
  if (event.type === "CatalogReconciliationRequested") {
    expansionForCheckpoint(plan, event.expansionOwnerCheck, false);
    return;
  }
  if (event.type === "SubgraphExpanded") {
    const nested = event.parentSubgraphInstanceId !== null;
    const expansion = expansionForCheckpoint(plan, event.expansionOwnerCheck, nested);
    if (event.graphSemanticDigest !== expansion.graphSemanticDigest || event.expansionSpecDigest !== expansion.expansionSpecDigest || event.templateDigest !== expansion.templateDigest || event.catalogClaimId.length === 0 || event.itemKey.length === 0) {
      checkpointAuthorityFailure("Expanded subgraph does not match the compiled expansion authority");
    }
    const templateKeys = [...expansion.template.templateNodeKeys].sort();
    const eventKeys = Object.keys(event.nodeInstanceIdsByTemplateNode).sort();
    if (canonicalJson(templateKeys) !== canonicalJson(eventKeys)) {
      checkpointAuthorityFailure("Expanded subgraph node key set does not match the compiled template");
    }
    if (!nested) {
      const catalog = claimProjection.claims[event.catalogClaimId];
      if (!catalog || claimProjection.activeClaimIdsByRef[expansion.catalogClaimRef] !== event.catalogClaimId || catalog.claim !== expansion.catalogClaimRef || catalog.producerCheckId !== event.expansionOwnerCheck || catalog.scope.length !== 0) {
        checkpointAuthorityFailure("Root expansion catalog claim is not the exact projected authority");
      }
    }
    return;
  }
  if (event.type === "ProofCurrentCatalogAuthorityRecorded") {
    const project = instanceProjection.instancesById[event.projectSubgraphInstanceId];
    proofProjectExpansionForPlan(plan, project);
    if (!project || project.status !== "active" || canonicalJson(project.scope) !== canonicalJson(event.scope) || event.sessionId !== project.sessionId || event.authorityId !== deriveProofCurrentCatalogAuthorityId(event)) {
      checkpointAuthorityFailure("Proof rebase event is not bound to the exact compiled project authority");
    }
    return;
  }
  if (event.type === "ProofCurrentCatalogAuthorityApplied") {
    const project = instanceProjection.instancesById[event.projectSubgraphInstanceId];
    const authority = instanceProjection.currentProofCatalogAuthorityByProject[event.projectSubgraphInstanceId];
    proofProjectExpansionForPlan(plan, project);
    if (!project || project.status !== "active" || event.sessionId !== project.sessionId || canonicalJson(project.scope) !== canonicalJson(event.scope) || !authority || authority.authorityId !== event.authorityId) {
      checkpointAuthorityFailure("Proof authority application is not bound to the current compiled project authority");
    }
    return;
  }
  if (event.type === "AttemptRetryRequested") {
    const generation = instanceProjection.generationsById[event.nodeGenerationId];
    const instance = generation ? instanceProjection.instancesById[generation.subgraphInstanceId] : void 0;
    if (!generation || !instance || instance.status !== "active" || generation.templateNodeKey !== event.checkId || generation.nodeInstanceId !== event.nodeInstanceId || generation.subgraphInstanceId !== instance.subgraphInstanceId) {
      checkpointAuthorityFailure("Generated retry is not bound to the compiled active generation");
    }
    const expansion = expansionForCheckpoint(
      plan,
      instance.expansionOwnerCheck,
      !!instance.parentSubgraphInstanceId
    );
    const node = expansion.template.nodesByKey[event.checkId];
    if (!node || node.executionConfigDigest !== event.executionConfigDigest || event.activeInputClaimIds.some((claimId) => typeof claimId !== "string" || claimId.length === 0)) {
      checkpointAuthorityFailure("Generated retry does not match the compiled node authority");
    }
    return;
  }
  if (event.type === "ControllerItemClaimPublished") {
    const instance = instanceProjection.instancesById[event.subgraphInstanceId];
    if (!instance) checkpointAuthorityFailure("Controller item claim references an unknown instance");
    const nested = !!instance.parentSubgraphInstanceId;
    const expansion = expansionForCheckpoint(plan, event.expansionOwnerCheck, nested);
    if (instance.expansionOwnerCheck !== event.expansionOwnerCheck || event.expansionSpecDigest !== expansion.expansionSpecDigest || event.claim !== expansion.itemClaimRef) {
      checkpointAuthorityFailure("Controller item claim does not match the compiled expansion authority");
    }
    if (!nested) {
      const catalog = claimProjection.claims[event.catalogClaimId];
      if (!catalog || claimProjection.activeClaimIdsByRef[expansion.catalogClaimRef] !== event.catalogClaimId || catalog.claim !== expansion.catalogClaimRef) {
        checkpointAuthorityFailure("Controller item catalog claim is not the exact active plan authority");
      }
    }
    try {
      expansion.itemValidator(event.payload);
    } catch (error) {
      throw new GraphJournalCheckpointError("CHECKPOINT_PLAN_AUTHORITY_MISMATCH", "Controller item payload violates the compiled item validator", { cause: error });
    }
    return;
  }
  if (event.type === "NodeGenerationActivated") {
    const instance = instanceProjection.instancesById[event.subgraphInstanceId];
    if (!instance) checkpointAuthorityFailure("Generation activation references an unknown instance");
    const expansion = expansionForCheckpoint(plan, instance.expansionOwnerCheck, !!instance.parentSubgraphInstanceId);
    const node = expansion.template.nodesByKey[event.templateNodeKey];
    const nestedOwner = qualifiedNestedExpansionOwner(expansion.template.name, event.templateNodeKey);
    const nestedExpansion = expansionPlan.byNestedOwner[nestedOwner];
    if (!node || event.executionConfigDigest !== node.executionConfigDigest || (nestedExpansion ? event.nestedExpansionCatalogClaimRef !== nestedExpansion.catalogClaimRef : hasOwn(asRecord, "nestedExpansionCatalogClaimRef")) || (node.waitForExpansion ? !hasOwn(asRecord, "expansionBarrierDigest") : hasOwn(asRecord, "expansionBarrierDigest"))) {
      checkpointAuthorityFailure("Generation activation does not match the compiled template node authority");
    }
    if (node.waitForExpansion) {
      const barrier = checkpointExpansionBarrier(plan, instanceProjection, instance, node, completingGenerationId);
      if (!barrier.ready || event.expansionBarrierDigest !== barrier.digest) {
        checkpointAuthorityFailure("Generation activation does not match the current nested-expansion barrier");
      }
    }
    return;
  }
  if ("nodeGenerationId" in event && event.type === "ClaimPublished") {
    const generation = instanceProjection.generationsById[event.nodeGenerationId];
    if (!generation) checkpointAuthorityFailure("Generated claim references an unknown generation");
    const expansion = expansionForCheckpoint(plan, instanceProjection.instancesById[generation.subgraphInstanceId].expansionOwnerCheck, !!instanceProjection.instancesById[generation.subgraphInstanceId].parentSubgraphInstanceId);
    const node = expansion.template.nodesByKey[generation.templateNodeKey];
    if (!node || !node.emissions.some((emission) => emission.claim === event.claim)) checkpointAuthorityFailure("Generated claim is not declared by its compiled template node");
    const sidecar = isGovernedCandidateClaim2(event.claim);
    const compiledWireMode = compiledManagedProofWireMode(generation, node);
    if (event.wireMode !== "generic" && event.wireMode !== "proof") checkpointAuthorityFailure("Generated claim wire mode is invalid");
    if (compiledWireMode === "proof" && event.wireMode !== "proof" && !(legacyProofWireMode && event.wireMode === "generic" && event.claim === PROOF_CATALOG_REVALIDATION_CLAIM)) {
      checkpointAuthorityFailure("Proof catalog publication is not using its compiled Proof wire mode");
    }
    if (compiledWireMode !== "proof" && !isGovernedCandidateClaim2(event.claim) && event.wireMode !== "generic") checkpointAuthorityFailure("Proof wire mode is reserved for governed evidence");
    if (compiledWireMode === "proof") {
      const managed = generation.attemptId ? instanceProjection.managedRunsByAttemptId[generation.attemptId] : void 0;
      if (!managed || managed.status !== "terminated" || managed.cleanupStatus !== "clean" || managed.controllerDecision !== "completed" || managed.failureCode !== void 0) {
        checkpointAuthorityFailure("Proof catalog publication lacks a clean managed terminal");
      }
      if (event.claim === PROOF_CATALOG_REVALIDATION_CLAIM && (event.wireMode === "proof" || legacyProofWireMode && event.wireMode === "generic")) {
        validateProofRevalidationLineage(event, generation, instanceProjection);
      }
    }
    if (sidecar) {
      const stagedCandidate = event.claim === PROOF_COMPONENT_SPEC_REVIEW_CANDIDATE_CLAIM;
      if ((stagedCandidate ? generation.templateNodeKey !== "spec_review" : generation.templateNodeKey !== "inspect") || node.check.type !== "governed-proof-inspect" || !hasOwn(event, "proofCandidateEvidence") || !hasOwn(event, "proofCandidateEvidenceFingerprint") || event.proofCandidateEvidenceFingerprint !== proofCandidateEvidenceFingerprint(event.proofCandidateEvidence)) {
        checkpointAuthorityFailure("Generated proof candidate evidence is not bound to the compiled inspect authority");
      }
      try {
        const evidence = validateProofCandidateEvidence(event.proofCandidateEvidence);
        if (event.wireMode !== governedWireModeFromEvidence(evidence)) checkpointAuthorityFailure("Generated claim wire mode is detached from governed invocation");
        const candidatePayload = governedCanonicalJson(event.payload, event.wireMode);
        const componentSelector = !stagedCandidate && isGovernedProofComponentSelector(node.check.invocation);
        const projectSelector = !stagedCandidate && isGovernedProofProjectSelector(node.check.invocation);
        const selector = stagedCandidate ? isGovernedProofSpecReviewSelector(node.check.invocation) : componentSelector || projectSelector;
        const invocation = evidence.role.invocation;
        const selectorBound = projectSelector ? invocation.role_id === "onboard" && invocation.stance === "owner" && invocation.output_schema_id === node.check.invocation.output_schema_id && invocation.output_schema === node.check.invocation.output_schema && invocation.subject && typeof invocation.subject === "object" && invocation.subject.kind === "project" : selector && invocation.role_id === (stagedCandidate ? "spec-review" : "onboard") && invocation.stance === "owner" && invocation.output_schema_id === node.check.invocation.output_schema_id && invocation.output_schema === node.check.invocation.output_schema && !!invocation.component_authority && (!stagedCandidate || invocation.onboarding_stage !== void 0) && invocation.subject && typeof invocation.subject === "object" && invocation.subject.kind === "component";
        if (!selector && (evidence.role.invocationDigest !== node.check.invocation_digest || canonicalJson(evidence.role.invocation) !== canonicalJson(node.check.invocation)) || selector && !selectorBound || evidence.probe.resultIdentity.resultDigest !== governedResultDigest(event.payload, event.wireMode) || evidence.probe.resultIdentity.canonicalBytes !== Buffer.byteLength(candidatePayload, "utf8")) {
          checkpointAuthorityFailure("Generated proof candidate evidence is detached from compiled inspect or payload authority");
        }
      } catch (error) {
        if (error instanceof GraphJournalCheckpointError) throw error;
        throw new GraphJournalCheckpointError("CHECKPOINT_PLAN_AUTHORITY_MISMATCH", "Generated proof candidate evidence is invalid", { cause: error });
      }
    } else if (hasOwn(event, "proofCandidateEvidence") || hasOwn(event, "proofCandidateEvidenceFingerprint")) {
      checkpointAuthorityFailure("Generated evidence sidecars are reserved for proof candidates");
    }
    try {
      plan.validatorsByClaim[event.claim](event.payload);
    } catch (error) {
      throw new GraphJournalCheckpointError("CHECKPOINT_PLAN_AUTHORITY_MISMATCH", "Generated claim payload violates the compiled claim validator", { cause: error });
    }
  }
}
function checkpointBody(value) {
  return {
    kind: value.kind,
    version: value.version,
    sessionId: value.sessionId,
    graphSemanticDigest: value.graphSemanticDigest,
    frontier: value.frontier,
    events: value.events
  };
}
function canonicalGraphCheckpointJson(value) {
  const active = /* @__PURE__ */ new Set();
  const encode = (current, proofApplicationClaimIds = /* @__PURE__ */ new Set()) => {
    if (current === null || typeof current === "boolean" || typeof current === "string") return JSON.stringify(current);
    if (typeof current === "number") {
      if (!Number.isFinite(current)) throw new Error("non-finite number is not canonical JSON");
      return JSON.stringify(current);
    }
    if (current === void 0 || typeof current === "function" || typeof current === "symbol" || typeof current === "bigint") throw new Error("unsupported checkpoint JSON value");
    if (active.has(current)) throw new Error("checkpoint value is cyclic");
    active.add(current);
    try {
      if (Array.isArray(current)) {
        const suffixClaimIds = new Set(proofApplicationClaimIds);
        for (let index = 0; index < current.length; index++) {
          const marker = current[index];
          if (marker && typeof marker === "object" && !Array.isArray(marker) && marker.type === "ProofCurrentCatalogAuthorityApplied") {
            const count = marker.mutationEventCount;
            if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0) {
              for (const mutation of current.slice(index + 1, index + 1 + count)) {
                if (mutation && typeof mutation === "object" && !Array.isArray(mutation) && mutation.type === "ControllerItemClaimPublished" && mutation.claim === "component.work_item@1" && typeof mutation.claimId === "string") {
                  suffixClaimIds.add(mutation.claimId);
                }
              }
            }
          }
        }
        return `[${current.map((item) => encode(item, suffixClaimIds)).join(",")}]`;
      }
      const prototype = Object.getPrototypeOf(current);
      if (prototype !== Object.prototype && prototype !== null) throw new Error("checkpoint object is not plain");
      const record = current;
      const generated = record.type === "ClaimPublished" && hasOwn(record, "nodeGenerationId");
      const proofApplicationController = record.type === "ControllerItemClaimPublished" && record.claim === "component.work_item@1" && typeof record.claimId === "string" && proofApplicationClaimIds.has(record.claimId);
      return `{${Object.keys(record).sort().map((key) => {
        const encoded = generated && key === "payload" ? governedCanonicalJson(record[key], record.wireMode === "proof" ? "proof" : "generic") : proofApplicationController && key === "payload" ? governedCanonicalJson(record[key], "proof") : generated && key === "proofCandidateEvidence" ? governedProofCandidateEvidenceJson(record[key]) : encode(record[key], proofApplicationClaimIds);
        return `${JSON.stringify(key)}:${encoded}`;
      }).join(",")}}`;
    } finally {
      active.delete(current);
    }
  };
  return encode(value);
}
function sha256Checkpoint(value) {
  return createHash("sha256").update(canonicalGraphCheckpointJson(value), "utf8").digest("hex");
}
function immutableCheckpointValue(value) {
  const freeze = (current) => {
    if (current && typeof current === "object") {
      for (const child of Object.values(current)) freeze(child);
      Object.freeze(current);
    }
    return current;
  };
  return freeze(JSON.parse(canonicalGraphCheckpointJson(value)));
}
function parseGraphCheckpoint(input) {
  try {
    canonicalGraphCheckpointJson(input);
  } catch (error) {
    throw checkpointWrap("INVALID_CHECKPOINT_ENVELOPE", "Checkpoint is not canonical JSON", error);
  }
  const value = checkpointObject(input);
  if (!value || !checkpointHasExactKeys(value, ["kind", "version", "sessionId", "graphSemanticDigest", "frontier", "events", "integrity"])) {
    throw new GraphJournalCheckpointError("INVALID_CHECKPOINT_ENVELOPE", "Checkpoint envelope has unknown or missing fields");
  }
  if (value.kind !== "visor.graph-journal-checkpoint" || value.version !== 1) {
    throw new GraphJournalCheckpointError("INVALID_CHECKPOINT_ENVELOPE", "Unsupported checkpoint kind or version");
  }
  checkpointString(value.sessionId, "Checkpoint sessionId");
  checkpointString(value.graphSemanticDigest, "Checkpoint graphSemanticDigest");
  const frontier = checkpointObject(value.frontier);
  const integrity = checkpointObject(value.integrity);
  if (!frontier || !checkpointHasExactKeys(frontier, ["eventCount", "lastEventId"]) || !integrity || !checkpointHasExactKeys(integrity, ["algorithm", "digest"])) {
    throw new GraphJournalCheckpointError("INVALID_CHECKPOINT_ENVELOPE", "Checkpoint frontier or integrity shape is invalid");
  }
  checkpointSafeInteger(frontier.eventCount, "frontier.eventCount");
  checkpointSafeInteger(frontier.lastEventId, "frontier.lastEventId");
  if (integrity.algorithm !== "sha256" || typeof integrity.digest !== "string" || !CHECKPOINT_SHA256.test(integrity.digest)) {
    throw new GraphJournalCheckpointError("INVALID_CHECKPOINT_ENVELOPE", "Checkpoint integrity algorithm or digest is invalid");
  }
  if (!Array.isArray(value.events)) throw new GraphJournalCheckpointError("INVALID_CHECKPOINT_ENVELOPE", "Checkpoint events must be an array");
  const expectedDigest = sha256Checkpoint(checkpointBody(value));
  if (integrity.digest !== expectedDigest) {
    throw new GraphJournalCheckpointError("CHECKPOINT_INTEGRITY_MISMATCH", "Checkpoint integrity digest does not match its canonical body");
  }
  return value;
}
function validateCheckpointPrefix(checkpoint) {
  const frontier = checkpoint.frontier;
  const rawEvents = checkpoint.events;
  if (frontier.eventCount !== rawEvents.length || frontier.lastEventId !== (rawEvents.length === 0 ? 0 : rawEvents.length)) {
    throw new GraphJournalCheckpointError("INVALID_CHECKPOINT_PREFIX", "Checkpoint frontier does not describe the event prefix");
  }
  const events = rawEvents.map(validateCheckpointEventShape);
  for (const [index, event] of events.entries()) {
    if (event.eventId !== index + 1) throw new GraphJournalCheckpointError("INVALID_CHECKPOINT_PREFIX", "Checkpoint event IDs must be contiguous from 1");
    if (event.sessionId !== checkpoint.sessionId) throw new GraphJournalCheckpointError("CHECKPOINT_SESSION_MISMATCH", "Checkpoint event session differs from its envelope session");
  }
  return events;
}
function reconstructCheckpointAllocators(events) {
  let nextFence = 0;
  const attemptOrdinals = /* @__PURE__ */ new Map();
  const requestOrdinals = /* @__PURE__ */ new Map();
  const generatedAttemptOrdinals = /* @__PURE__ */ new Map();
  for (const event of events) {
    if (event.type === "CatalogReconciliationRequested") {
      const prior = requestOrdinals.get(event.expansionOwnerCheck) || 0;
      if (event.requestOrdinal !== prior + 1 || event.requestId !== deriveCatalogRequestId({
        sessionId: event.sessionId,
        expansionOwnerCheck: event.expansionOwnerCheck,
        ordinal: event.requestOrdinal
      })) {
        throw new GraphJournalCheckpointError("INVALID_CHECKPOINT_PREFIX", "Catalog request ordinal is not the next derived ordinal");
      }
      requestOrdinals.set(event.expansionOwnerCheck, event.requestOrdinal);
    }
    if (event.type !== "AttemptStarted") continue;
    nextFence++;
    if (event.fence !== nextFence) throw new GraphJournalCheckpointError("INVALID_CHECKPOINT_PREFIX", "Attempt fences must be one contiguous global sequence");
    if ("nodeGenerationId" in event) {
      const generatedKey = canonicalJson({ nodeGenerationId: event.nodeGenerationId, scope: event.scope });
      const ordinal2 = (generatedAttemptOrdinals.get(generatedKey) || 0) + 1;
      if (event.attemptId !== sha256Canonical({ nodeGenerationId: event.nodeGenerationId, ordinal: ordinal2 })) {
        throw new GraphJournalCheckpointError("INVALID_CHECKPOINT_PREFIX", "Generated attempt identity or ordinal is invalid");
      }
      generatedAttemptOrdinals.set(generatedKey, ordinal2);
      attemptOrdinals.set(generatedKey, ordinal2);
      continue;
    }
    const authority = { sessionId: event.sessionId, checkId: event.checkId, scope: event.scope };
    const key = canonicalJson(authority);
    const ordinal = (attemptOrdinals.get(key) || 0) + 1;
    if (event.attemptId !== sha256Canonical({ ...authority, ordinal })) {
      throw new GraphJournalCheckpointError("INVALID_CHECKPOINT_PREFIX", "Attempt identity is not derived from its reconstructed ordinal");
    }
    attemptOrdinals.set(key, ordinal);
  }
  return { nextFence, attemptOrdinals, requestOrdinals };
}
function ensureCheckpointQuiescent(claimProjection, instanceProjection) {
  if (Object.values(claimProjection.attempts).some((attempt) => attempt.status === "started")) {
    throw new GraphJournalCheckpointError("CHECKPOINT_NOT_QUIESCENT", "Checkpoint contains a started root or catalog attempt");
  }
  if (Object.values(instanceProjection.requestsById).some((request) => request.status === "pending" || request.status === "running")) {
    throw new GraphJournalCheckpointError("CHECKPOINT_NOT_QUIESCENT", "Checkpoint contains a pending or running catalog request");
  }
  if (Object.values(instanceProjection.generationsById).some((generation) => generation.status === "ready" || generation.status === "running")) {
    throw new GraphJournalCheckpointError("CHECKPOINT_NOT_QUIESCENT", "Checkpoint contains a ready or running generation");
  }
  if (Object.values(instanceProjection.managedRunsByAttemptId).some((run) => run.status === "acquired" || run.status === "started" || run.status === "cancel_requested")) {
    throw new GraphJournalCheckpointError("CHECKPOINT_NOT_QUIESCENT", "Checkpoint contains a nonterminal managed run");
  }
}
function ensureCheckpointExportable(claimProjection, instanceProjection) {
  if (Object.values(claimProjection.attempts).some((attempt) => attempt.status === "started")) {
    throw new GraphJournalCheckpointError("CHECKPOINT_NOT_QUIESCENT", "Checkpoint contains a started root or catalog attempt");
  }
  if (Object.values(instanceProjection.requestsById).some((request) => request.status === "pending" || request.status === "running")) {
    throw new GraphJournalCheckpointError("CHECKPOINT_NOT_QUIESCENT", "Checkpoint contains a pending or running catalog request");
  }
  if (Object.values(instanceProjection.generationsById).some((generation) => generation.status === "running" || generation.status === "ready" && (generation.scheduled || generation.attemptId !== void 0 || generation.fence !== void 0))) {
    throw new GraphJournalCheckpointError("CHECKPOINT_NOT_QUIESCENT", "Checkpoint contains a scheduled or running generation");
  }
  if (Object.values(instanceProjection.managedRunsByAttemptId).some((run) => run.status === "acquired" || run.status === "started" || run.status === "cancel_requested" || run.status === "terminated" && run.cleanupStatus !== "clean")) {
    throw new GraphJournalCheckpointError("CHECKPOINT_NOT_QUIESCENT", "Checkpoint contains a nonterminal managed run");
  }
}
function ensureReplayAuthorityEventsQuiescent(events, claimPlan) {
  let claimPrefix = createInitialClaimProjection();
  let instancePrefix = createInitialInstanceProjection();
  for (let index = 0; index < events.length; index++) {
    const event = events[index];
    const route = routeCheckpointEvent(event);
    if (route.claim) claimPrefix = reduceClaimEvent(claimPrefix, event, claimPlan);
    if (route.instance) {
      if (event.type === "ProofCurrentCatalogAuthorityApplied") {
        const end = index + event.mutationEventCount + 1;
        if (end > events.length) throw new GraphJournalCheckpointError("INVALID_CHECKPOINT_PREFIX", "Proof authority application batch is truncated");
        const group = events.slice(index, end);
        ensureCheckpointQuiescent(claimPrefix, instancePrefix);
        instancePrefix = reduceInstanceEventBatch(instancePrefix, group);
        index = end - 1;
        continue;
      }
      if (event.type === "ProofCurrentCatalogAuthorityRecorded") ensureCheckpointQuiescent(claimPrefix, instancePrefix);
      instancePrefix = reduceInstanceEvent(instancePrefix, event);
    }
  }
}
function compiledManagedProofWireMode(generation, node) {
  const projectReconciliation = generation.templateNodeKey === PROOF_PROJECT_RECONCILE_NODE_KEY && generation.checkId === PROOF_PROJECT_RECONCILE_NODE_KEY;
  const expectedClaim = projectReconciliation ? PROOF_PROJECT_RECONCILIATION_RECEIPT_CLAIM : generation.templateNodeKey === "revalidate_catalog" && generation.checkId === "revalidate_catalog" ? PROOF_CATALOG_REVALIDATION_CLAIM : void 0;
  const expectedType = projectReconciliation ? PROOF_PROJECT_RECONCILE_PROVIDER_TYPE : expectedClaim === PROOF_CATALOG_REVALIDATION_CLAIM ? PROOF_CATALOG_REVALIDATION_PROVIDER_TYPE : void 0;
  if (!expectedClaim || node.check.type !== expectedType || node.emissions.length !== 1) return "generic";
  const emission = node.emissions[0];
  const keys = Reflect.ownKeys(emission);
  return Object.getPrototypeOf(emission) === Object.prototype && keys.length === 2 && keys.includes("claim") && keys.includes("from") && emission.claim === expectedClaim && emission.from === "output" ? "proof" : "generic";
}
function validateProofRevalidationLineage(event, generation, instanceProjection) {
  const parents = generation.activeInputClaimIds.map((claimId) => instanceProjection.claimsById[claimId]);
  const inventory = parents.find((claim) => claim?.claim === PROOF_STRUCTURAL_INVENTORY_CLAIM);
  const candidate = parents.find((claim) => claim?.claim === PROOF_CANDIDATE_CLAIM);
  const admission = parents.find((claim) => claim?.claim === PROOF_ADMITTED_RECEIPT_CLAIM);
  if (!inventory || !candidate || !admission || !inventory.active || !candidate.active || !admission.active) {
    checkpointAuthorityFailure("Proof revalidation lacks its complete candidate/admission lineage");
  }
  const candidateView = generatedClaimView(candidate, "candidate");
  const admissionView = generatedClaimView(admission, "admission");
  const candidatePayload = candidate.payload;
  const projectID = candidatePayload && typeof candidatePayload.project_id === "string" ? candidatePayload.project_id : void 0;
  if (!projectID || !inventory.payload || typeof inventory.payload !== "object") {
    checkpointAuthorityFailure("Proof revalidation has no project-bound candidate/inventory");
  }
  const revalidationView = {
    claimId: event.claimId,
    claim: event.claim,
    payload: event.payload,
    payloadFingerprint: event.payloadFingerprint,
    producerCheckId: event.producerCheckId,
    scope: event.scope,
    parentClaimIds: event.parentClaimIds,
    wireMode: event.wireMode,
    provenance: "attempt",
    attemptId: event.attemptId,
    fence: event.fence
  };
  try {
    validateProofCatalogRevalidationProjection(
      event.payload,
      inventory.payload,
      candidateView,
      admissionView,
      projectID,
      revalidationView,
      inventory.claimId
    );
  } catch (error) {
    checkpointAuthorityFailure(`Proof revalidation failed strict lineage validation: ${error instanceof Error ? error.message : String(error)}`);
  }
}
var GraphJournalCheckpointError, CHECKPOINT_SHA256, ATTEMPT_BASE_KEYS, ExecutionJournal, ContextView;
var init_snapshot_store = __esm({
  "src/snapshot-store.ts"() {
    "use strict";
    init_claim_kernel();
    init_instance_kernel();
    init_instance_plan();
    init_proof_admission_cli_child();
    init_proof_wire();
    init_governed_proof_inspect_check_provider();
    init_proof_catalog_check_providers();
    init_proof_project_reconcile_check_provider();
    init_instance_plan();
    GraphJournalCheckpointError = class extends Error {
      code;
      constructor(code, message, options) {
        super(message, options);
        this.name = "GraphJournalCheckpointError";
        this.code = code;
      }
    };
    CHECKPOINT_SHA256 = /^[0-9a-f]{64}$/;
    ATTEMPT_BASE_KEYS = ["version", "type", "eventId", "sessionId", "checkId", "scope", "attemptId", "fence"];
    ExecutionJournal = class _ExecutionJournal {
      constructor(claimPlan) {
        this.claimPlan = claimPlan;
      }
      claimPlan;
      commit = 0;
      entries = [];
      runtimeEvents = [];
      claimProjection = createInitialClaimProjection();
      instanceProjection = createInitialInstanceProjection();
      nextFence = 0;
      attemptOrdinals = /* @__PURE__ */ new Map();
      requestOrdinals = /* @__PURE__ */ new Map();
      /**
       * Validate the self-authenticating checkpoint envelope before any external
       * authority or provider is consulted. Graph-plan authority is checked later
       * by restoreGraphCheckpoint once the trusted configuration is available.
       */
      static validateGraphCheckpointIntegrity(input) {
        return immutableCheckpointValue(parseGraphCheckpoint(input));
      }
      /** Export the immutable Graph-v2 runtime prefix and its canonical integrity digest. */
      exportGraphCheckpoint(sessionId) {
        checkpointString(sessionId, "sessionId");
        const plan = this.requireClaimPlan();
        if (!plan.expansionPlan?.active) {
          throw new GraphJournalCheckpointError("CHECKPOINT_GRAPH_MISMATCH", "Graph journal checkpoints require an active expansion plan");
        }
        const events = immutableCheckpointValue(this.runtimeEvents);
        if (events.some((event) => event.sessionId !== sessionId)) {
          throw new GraphJournalCheckpointError("CHECKPOINT_SESSION_MISMATCH", "Runtime event session differs from export session");
        }
        ensureCheckpointExportable(this.claimProjection, this.instanceProjection);
        const body = {
          kind: "visor.graph-journal-checkpoint",
          version: 1,
          sessionId,
          graphSemanticDigest: plan.expansionPlan.graphSemanticDigest,
          frontier: { eventCount: events.length, lastEventId: events.length === 0 ? 0 : events.length },
          events
        };
        return immutableCheckpointValue({
          ...body,
          integrity: { algorithm: "sha256", digest: sha256Checkpoint(body) }
        });
      }
      /** Restore a fresh journal only after complete envelope, authority, replay, and frontier validation. */
      static restoreGraphCheckpoint(claimPlan, input) {
        const checkpoint = parseGraphCheckpoint(input);
        if (!claimPlan || !claimPlan.active || !claimPlan.expansionPlan?.active) {
          throw new GraphJournalCheckpointError("CHECKPOINT_GRAPH_MISMATCH", "Checkpoint restore requires an active claim and expansion plan");
        }
        if (checkpoint.graphSemanticDigest !== claimPlan.expansionPlan.graphSemanticDigest) {
          throw new GraphJournalCheckpointError("CHECKPOINT_GRAPH_MISMATCH", "Checkpoint graph digest does not match the current compiled plan");
        }
        const validatedEvents = validateCheckpointPrefix(checkpoint);
        const events = immutableCheckpointValue(validatedEvents);
        const claimEvents = [];
        const instanceEvents = [];
        let claimPrefix = createInitialClaimProjection();
        let instancePrefix = createInitialInstanceProjection();
        for (let index = 0; index < events.length; index++) {
          const event = events[index];
          if (event.type === "ProofCurrentCatalogAuthorityApplied") {
            const groupEnd = index + event.mutationEventCount + 1;
            if (groupEnd > events.length) {
              throw new GraphJournalCheckpointError("INVALID_CHECKPOINT_PREFIX", "Proof authority application batch is truncated");
            }
            const group = events.slice(index, groupEnd);
            ensureCheckpointQuiescent(claimPrefix, instancePrefix);
            const beforeGroup = instancePrefix;
            for (const member of group) {
              const memberRoute = routeCheckpointEvent(member);
              if (memberRoute.claim || !memberRoute.instance) {
                throw new GraphJournalCheckpointError("INVALID_CHECKPOINT_PREFIX", "Proof authority application contains a non-instance mutation");
              }
              validateCheckpointPlanAuthority(member, claimPlan, claimPrefix, beforeGroup, false);
            }
            const firstMutation = group[1];
            if (isExactProofProjectReconciliationInactivation(beforeGroup, firstMutation)) {
              const generation = beforeGroup.generationsById[firstMutation.nodeGenerationId];
              const receipt = generation?.completedOutputClaimIds.length === 1 ? beforeGroup.claimsById[generation.completedOutputClaimIds[0]] : void 0;
              if (!receipt || !receipt.active || receipt.kind !== "generated-output" || receipt.claim !== PROOF_PROJECT_RECONCILIATION_RECEIPT_CLAIM || receipt.nodeGenerationId !== generation?.nodeGenerationId || receipt.producerCheckId !== PROOF_PROJECT_RECONCILE_NODE_KEY || receipt.subgraphInstanceId !== generation?.subgraphInstanceId || !scopePathEquals(receipt.scope, generation.scope) || receipt.producerAttemptId !== generation?.attemptId || receipt.producerFence !== generation?.fence) {
                checkpointAuthorityFailure("Checkpoint Proof authority application retires an unavailable project reconciliation receipt");
              }
              try {
                const prefixJournal = new _ExecutionJournal(claimPlan);
                prefixJournal.runtimeEvents = [...events.slice(0, index)];
                prefixJournal.claimProjection = claimPrefix;
                prefixJournal.instanceProjection = beforeGroup;
                const authority = prefixJournal.assembleProofProjectReconciliationAuthority(
                  generation.nodeGenerationId
                );
                prefixJournal.validateProofProjectReconciliationReceipt(receipt.payload, authority);
              } catch (error) {
                throw checkpointWrap(
                  "CHECKPOINT_PLAN_AUTHORITY_MISMATCH",
                  "Checkpoint Proof authority pre-application reconciliation lineage validation failed",
                  error
                );
              }
            }
            try {
              instancePrefix = reduceInstanceEventBatch(beforeGroup, group);
            } catch (error) {
              throw checkpointWrap("INVALID_CHECKPOINT_PREFIX", "Checkpoint Proof authority application replay failed", error);
            }
            instanceEvents.push(...group);
            index = groupEnd - 1;
            continue;
          }
          const route = routeCheckpointEvent(event);
          if (route.claim) {
            claimEvents.push(event);
            try {
              claimPrefix = reduceClaimEvent(claimPrefix, event, claimPlan);
            } catch (error) {
              throw checkpointWrap("INVALID_CHECKPOINT_PREFIX", "Checkpoint root claim replay failed", error);
            }
          }
          if (route.instance) {
            instanceEvents.push(event);
            const rawEvent = checkpoint.events[event.eventId - 1];
            const legacyProofWireMode = event.type === "ClaimPublished" && "nodeGenerationId" in event && event.claim === PROOF_CATALOG_REVALIDATION_CLAIM && event.wireMode === "generic" && !!rawEvent && (!hasOwn(rawEvent, "wireMode") || rawEvent.wireMode === "generic");
            if (event.type === "ProofCurrentCatalogAuthorityRecorded") {
              ensureCheckpointQuiescent(claimPrefix, instancePrefix);
            }
            const nextEvent = events[index + 1];
            const completingGenerationId = event.type === "NodeGenerationActivated" && event.expansionBarrierDigest !== void 0 && nextEvent?.type === "AttemptCompleted" && "nodeGenerationId" in nextEvent ? nextEvent.nodeGenerationId : void 0;
            validateCheckpointPlanAuthority(event, claimPlan, claimPrefix, instancePrefix, legacyProofWireMode, completingGenerationId);
            try {
              instancePrefix = reduceInstanceEvent(instancePrefix, event);
            } catch (error) {
              throw checkpointWrap("INVALID_CHECKPOINT_PREFIX", "Checkpoint instance replay failed", error);
            }
          }
        }
        let claimProjection;
        let instanceProjection;
        try {
          claimProjection = replayClaimEvents(claimEvents, claimPlan);
        } catch (error) {
          throw checkpointWrap("INVALID_CHECKPOINT_PREFIX", "Checkpoint root claim replay failed", error);
        }
        try {
          instanceProjection = replayInstanceEvents(instanceEvents);
        } catch (error) {
          throw checkpointWrap("INVALID_CHECKPOINT_PREFIX", "Checkpoint instance replay failed", error);
        }
        validateCheckpointBarrierCompleteness(claimPlan, instanceProjection);
        ensureCheckpointExportable(claimProjection, instanceProjection);
        const allocators = reconstructCheckpointAllocators(events);
        const restored = new _ExecutionJournal(claimPlan);
        restored.runtimeEvents = events.map((event) => immutableCheckpointValue(event));
        restored.claimProjection = immutableCanonicalValue(claimProjection);
        restored.instanceProjection = immutableInstanceProjection(instanceProjection);
        restored.nextFence = allocators.nextFence;
        restored.attemptOrdinals = allocators.attemptOrdinals;
        restored.requestOrdinals = allocators.requestOrdinals;
        try {
          restored.validateComponentAuthorityLineage();
        } catch (error) {
          throw checkpointWrap("CHECKPOINT_PLAN_AUTHORITY_MISMATCH", "Checkpoint component Proof authority replay failed", error);
        }
        return restored;
      }
      beginSnapshot() {
        return this.commit;
      }
      commitEntry(entry) {
        const committed = {
          sessionId: entry.sessionId,
          scope: entry.scope,
          checkId: entry.checkId,
          result: entry.result,
          event: entry.event,
          commitId: ++this.commit
        };
        this.entries.push(committed);
        return committed;
      }
      readVisible(sessionId, commitMax, event) {
        return this.entries.filter(
          (e) => e.sessionId === sessionId && e.commitId <= commitMax && (event ? e.event === event : true)
        );
      }
      requireClaimPlan() {
        if (!this.claimPlan?.active) {
          throw new ClaimKernelError("CLAIM_MODE_INACTIVE", "Runtime claim journal is inactive");
        }
        return this.claimPlan;
      }
      appendRuntimeEvent(event) {
        const plan = this.requireClaimPlan();
        const stored = immutableRuntimeEvent(event);
        const projected = reduceClaimEvent(this.claimProjection, stored, plan);
        this.runtimeEvents.push(stored);
        this.claimProjection = projected;
        return stored;
      }
      nextRuntimeEventId() {
        return Math.max(this.claimProjection.lastEventId, this.instanceProjection.lastEventId) + 1;
      }
      appendInstanceEvent(event) {
        this.requireClaimPlan();
        const stored = immutableInstanceEvent(event);
        const projected = reduceInstanceEvent(this.instanceProjection, stored);
        this.runtimeEvents.push(stored);
        this.instanceProjection = projected;
        return stored;
      }
      requestCatalogReconciliation(input) {
        const expansion = this.requireClaimPlan().expansionPlan?.byOwner[input.ownerCheck];
        if (!expansion) {
          throw new ClaimKernelError("UNKNOWN_EXPANSION_OWNER", `Unknown expansion owner ${input.ownerCheck}`);
        }
        const ordinal = (this.requestOrdinals.get(input.ownerCheck) || 0) + 1;
        this.requestOrdinals.set(input.ownerCheck, ordinal);
        return this.appendInstanceEvent({
          version: 1,
          type: "CatalogReconciliationRequested",
          eventId: this.nextRuntimeEventId(),
          sessionId: input.sessionId,
          scope: [],
          requestId: deriveCatalogRequestId({
            sessionId: input.sessionId,
            expansionOwnerCheck: input.ownerCheck,
            ordinal
          }),
          requestOrdinal: ordinal,
          expansionOwnerCheck: input.ownerCheck,
          status: "pending"
        });
      }
      getOldestPendingCatalogRequest() {
        const id = this.instanceProjection.requestOrder.find(
          (requestId) => this.instanceProjection.requestsById[requestId].status === "pending"
        );
        return id ? this.instanceProjection.requestsById[id] : void 0;
      }
      startCatalogRequestAttempt(requestId) {
        const request = this.instanceProjection.requestsById[requestId];
        if (!request || request.status !== "pending") throw new ClaimKernelError("INVALID_REQUEST_STATE", `Request ${requestId} is not pending`);
        const scope = [];
        const authority = { sessionId: request.sessionId, checkId: request.expansionOwnerCheck, scope };
        const ordinalKey = canonicalJson(authority);
        const ordinal = (this.attemptOrdinals.get(ordinalKey) || 0) + 1;
        this.attemptOrdinals.set(ordinalKey, ordinal);
        const fence = ++this.nextFence;
        const event = immutableCanonicalValue({ version: 1, type: "AttemptStarted", eventId: this.nextRuntimeEventId(), ...authority, attemptId: sha256Canonical({ ...authority, ordinal }), fence, requestId });
        const claim = reduceClaimEvent(this.claimProjection, event, this.requireClaimPlan());
        const instance = reduceInstanceEvent(this.instanceProjection, event);
        this.runtimeEvents.push(event);
        this.claimProjection = claim;
        this.instanceProjection = instance;
        return event;
      }
      scheduleCatalogRequestAttempt(input) {
        const request = this.instanceProjection.requestsById[input.requestId];
        if (!request) {
          throw new ClaimKernelError("UNKNOWN_REQUEST", `Unknown catalog request ${input.requestId}`);
        }
        const scope = [];
        const claimIds = exactActiveClaimIds(
          this.requireClaimPlan(),
          this.claimProjection,
          request.expansionOwnerCheck
        );
        const event = immutableCanonicalValue({
          version: 1,
          type: "CheckScheduled",
          eventId: this.nextRuntimeEventId(),
          sessionId: request.sessionId,
          checkId: request.expansionOwnerCheck,
          scope,
          requestId: request.requestId,
          attemptId: input.attemptId,
          fence: input.fence,
          claimIds: [...claimIds]
        });
        const claim = reduceClaimEvent(this.claimProjection, event, this.requireClaimPlan());
        const instance = reduceInstanceEvent(this.instanceProjection, event);
        this.runtimeEvents.push(event);
        this.claimProjection = claim;
        this.instanceProjection = instance;
        return event;
      }
      startGeneratedAttempt(nodeGenerationId) {
        const generation = this.instanceProjection.generationsById[nodeGenerationId];
        if (!generation || generation.status !== "ready") {
          throw new ClaimKernelError("GENERATION_NOT_READY", `Generation ${nodeGenerationId} is not ready`);
        }
        const fence = ++this.nextFence;
        const ordinalKey = canonicalJson({ nodeGenerationId, scope: generation.scope });
        const ordinal = (this.attemptOrdinals.get(ordinalKey) || 0) + 1;
        this.attemptOrdinals.set(ordinalKey, ordinal);
        return this.appendInstanceEvent({
          version: 1,
          type: "AttemptStarted",
          eventId: this.nextRuntimeEventId(),
          sessionId: this.instanceProjection.instancesById[generation.subgraphInstanceId].sessionId,
          checkId: generation.checkId,
          scope: generation.scope,
          attemptId: sha256Canonical({ nodeGenerationId, ordinal }),
          fence,
          nodeInstanceId: generation.nodeInstanceId,
          nodeGenerationId
        });
      }
      /**
       * Atomically reopen explicitly selected failed generated generations.  All
       * candidates are validated against the same immutable projection before any
       * retry event is appended, so a stale or mixed selection cannot partially
       * advance the journal.
       */
      retryFailedGeneratedAttempts(input) {
        this.requireClaimPlan();
        if (typeof input.sessionId !== "string" || input.sessionId.length === 0) {
          throw new ClaimKernelError("INVALID_RETRY", "Retry session ID is required");
        }
        if (input.externalSideEffects !== "absent" && input.externalSideEffects !== "safely_idempotent" && input.externalSideEffects !== "isolated_draft_replay") {
          throw new ClaimKernelError("INVALID_RETRY", "Retry requires an explicit side-effect disposition");
        }
        const generationIds = [...input.nodeGenerationIds].sort();
        if (generationIds.length === 0 || generationIds.some((id) => typeof id !== "string" || id.length === 0) || new Set(generationIds).size !== generationIds.length || input.nodeGenerationIds.some((id, index) => id !== generationIds[index])) {
          throw new ClaimKernelError("INVALID_RETRY", "Retry generation IDs must be non-empty, unique, and sorted");
        }
        const events = generationIds.map((nodeGenerationId) => {
          const generation = this.instanceProjection.generationsById[nodeGenerationId];
          const instance = generation ? this.instanceProjection.instancesById[generation.subgraphInstanceId] : void 0;
          if (!generation || !instance || instance.status !== "active" || instance.sessionId !== input.sessionId || generation.status !== "failed" || !generation.scheduled || generation.attemptId === void 0 || generation.fence === void 0 || generation.reason === void 0 || generation.completedOutputClaimIds.length !== 0) {
            throw new ClaimKernelError("INVALID_RETRY", `Generation ${nodeGenerationId} is not an eligible failed leaf`);
          }
          if (hasActiveDescendantInstance(this.instanceProjection, generation)) {
            throw new ClaimKernelError("INVALID_RETRY", `Generation ${nodeGenerationId} has active descendants`);
          }
          const managed = this.instanceProjection.managedRunsByAttemptId[generation.attemptId];
          if (managed && (managed.status !== "terminated" || managed.cleanupStatus !== "clean")) {
            throw new ClaimKernelError("INVALID_RETRY", `Generation ${nodeGenerationId} has an unclean prior managed run`);
          }
          return {
            version: 1,
            type: "AttemptRetryRequested",
            eventId: 0,
            sessionId: input.sessionId,
            scope: generation.scope,
            nodeInstanceId: generation.nodeInstanceId,
            nodeGenerationId: generation.nodeGenerationId,
            checkId: generation.checkId,
            incarnation: generation.incarnation,
            itemFingerprint: generation.itemFingerprint,
            executionConfigDigest: generation.executionConfigDigest,
            activeInputClaimIds: [...generation.activeInputClaimIds],
            priorAttemptId: generation.attemptId,
            priorFence: generation.fence,
            priorFailureReason: generation.reason,
            externalSideEffects: input.externalSideEffects
          };
        });
        let nextEventId = this.nextRuntimeEventId();
        const staged = events.map((event) => ({ ...event, eventId: nextEventId++ }));
        const projected = reduceInstanceEventBatch(
          this.instanceProjection,
          staged.map((event) => immutableInstanceEvent(event))
        );
        const stored = staged.map((event) => immutableInstanceEvent(event));
        this.runtimeEvents.push(...stored);
        this.instanceProjection = projected;
        return Object.freeze(stored);
      }
      scheduleGeneratedAttempt(input) {
        const generation = this.instanceProjection.generationsById[input.nodeGenerationId];
        if (!generation) {
          throw new ClaimKernelError(
            "UNKNOWN_GENERATION",
            `Unknown generation ${input.nodeGenerationId}`
          );
        }
        const instance = this.instanceProjection.instancesById[generation.subgraphInstanceId];
        return this.appendInstanceEvent({
          version: 1,
          type: "CheckScheduled",
          eventId: this.nextRuntimeEventId(),
          sessionId: instance.sessionId,
          checkId: generation.checkId,
          scope: generation.scope,
          attemptId: input.attemptId,
          fence: input.fence,
          nodeInstanceId: generation.nodeInstanceId,
          nodeGenerationId: generation.nodeGenerationId,
          claimIds: [...generation.activeInputClaimIds]
        });
      }
      compiledExpansionForInstance(subgraphInstanceId) {
        const instance = this.instanceProjection.instancesById[subgraphInstanceId];
        if (!instance) {
          throw new ClaimKernelError("UNKNOWN_INSTANCE", `Unknown instance ${subgraphInstanceId}`);
        }
        const expansionPlan = this.requireClaimPlan().expansionPlan;
        const expansion = instance.parentSubgraphInstanceId ? expansionPlan.byNestedOwner[instance.expansionOwnerCheck] : expansionPlan.byOwner[instance.expansionOwnerCheck];
        if (!expansion || expansion.expansionSpecDigest !== instance.expansionSpecDigest) {
          throw new ClaimKernelError(
            "INVALID_EXPANSION_AUTHORITY",
            `Instance ${subgraphInstanceId} is not bound to one exact compiled expansion`
          );
        }
        return expansion;
      }
      /**
       * Compute the readiness and semantic identity of a bounded nested
       * expansion barrier. The selected set is derived solely from the current
       * active catalog children of the parent owner; no caller can provide a
       * denominator or a completion claim list.
       */
      expansionBarrierForNode(projection, instance, node, completingGenerationId) {
        try {
          return expansionBarrierForProjection(
            this.requireClaimPlan(),
            projection,
            instance,
            node,
            completingGenerationId
          );
        } catch (error) {
          throw new ClaimKernelError(
            "INVALID_WAIT_FOR_EXPANSION",
            error instanceof Error ? error.message : String(error)
          );
        }
      }
      /** Revalidate every completed component selector against the current exact
       * WorkItem/catalog/Proof lineage. This is shared by normal replay and
       * checkpoint restore, so a rehashed substitution cannot survive projection
       * rebuilding. */
      validateComponentAuthorityLineage() {
        for (const generation of Object.values(this.instanceProjection.generationsById)) {
          if (generation.status !== "completed") continue;
          const instance = this.instanceProjection.instancesById[generation.subgraphInstanceId];
          if (!instance) componentAuthorityFailure("component generation instance is unavailable");
          if (instance.status !== "active") continue;
          const expansion = this.compiledExpansionForInstance(instance.subgraphInstanceId);
          const node = expansion.template.nodesByKey[generation.templateNodeKey];
          const componentInspect = node && node.check.type === "governed-proof-inspect" && isGovernedProofComponentSelector(node.check.invocation);
          const stagedInspect = node && generation.templateNodeKey === "spec_review" && node.check.type === "governed-proof-inspect" && isGovernedProofSpecReviewSelector(node.check.invocation);
          if (!componentInspect && !stagedInspect) continue;
          const authority = this.getProofComponentInvocationAuthority(generation.nodeGenerationId);
          const output = generation.completedOutputClaimIds.map((claimId) => this.instanceProjection.claimsById[claimId]).find((claim) => claim?.claim === (stagedInspect ? PROOF_COMPONENT_SPEC_REVIEW_CANDIDATE_CLAIM : PROOF_CANDIDATE_CLAIM));
          if (!output?.proofCandidateEvidence) componentAuthorityFailure("completed component inspect has no Proof evidence");
          const invocation = output.proofCandidateEvidence.role.invocation;
          if (!invocation.component_authority || governedCanonicalJson(invocation.component_authority, "proof") !== governedCanonicalJson(authority, "proof")) {
            componentAuthorityFailure("completed component inspect authority is detached from exact lineage");
          }
          if (stagedInspect) {
            const expectedStage = this.getProofComponentOnboardingStageContext(generation.nodeGenerationId);
            if (canonicalJson(invocation.onboarding_stage) !== canonicalJson(expectedStage)) componentAuthorityFailure("completed spec_review context is detached from exact lineage");
            validateComponentAdmissionProtocol(this.instanceProjection, instance.subgraphInstanceId, "spec_review", false, (nodeGenerationId) => this.getProofAdmissionRequest(nodeGenerationId));
            continue;
          }
          const expectedReinspection = this.getProofComponentReinspectionContext(generation.nodeGenerationId);
          const actualReinspection = output.proofCandidateEvidence.reinspectionContext;
          if (expectedReinspection === void 0 !== (actualReinspection === void 0) || expectedReinspection && (!actualReinspection || canonicalJson(expectedReinspection) !== canonicalJson(actualReinspection) || output.proofCandidateEvidence.reinspectionContextDigest !== governedProofComponentReinspectionContextDigest(expectedReinspection))) {
            componentAuthorityFailure("completed component reinspection context is detached from exact lineage");
          }
          validateComponentChildAdmission(this.instanceProjection, instance.subgraphInstanceId, false, (nodeGenerationId) => this.getProofAdmissionRequest(nodeGenerationId));
        }
        for (const generation of Object.values(this.instanceProjection.generationsById)) {
          if (generation.status !== "completed" || generation.templateNodeKey !== PROOF_PROJECT_RECONCILE_NODE_KEY) continue;
          const node = this.instanceProjection.nodesById[generation.nodeInstanceId];
          if (!node) reconciliationFailure("completed project reconciliation node is unavailable");
          const claim = generation.completedOutputClaimIds.length === 1 ? this.instanceProjection.claimsById[generation.completedOutputClaimIds[0]] : void 0;
          if (!claim || claim.claim !== PROOF_PROJECT_RECONCILIATION_RECEIPT_CLAIM) {
            reconciliationFailure("completed project reconciliation has no unique receipt");
          }
          const authority = this.assembleProofProjectReconciliationAuthority(generation.nodeGenerationId);
          this.validateProofProjectReconciliationReceipt(claim.payload, authority);
        }
      }
      currentProjectOutput(claim, checkId, project) {
        const generation = claim.nodeGenerationId ? this.instanceProjection.generationsById[claim.nodeGenerationId] : void 0;
        const node = generation ? this.instanceProjection.nodesById[generation.nodeInstanceId] : void 0;
        if (!claim.active || claim.kind !== "generated-output" || claim.claim === "" || claim.producerCheckId !== checkId || claim.subgraphInstanceId !== project.subgraphInstanceId || !generation || generation.status !== "completed" || !generation.scheduled || generation.checkId !== checkId || generation.templateNodeKey !== checkId || generation.subgraphInstanceId !== project.subgraphInstanceId || !node || node.subgraphInstanceId !== project.subgraphInstanceId || node.templateNodeKey !== checkId || !scopePathEquals(node.scope, generation.scope) || !scopePathEquals(claim.scope, generation.scope) || this.instanceProjection.activeGenerationIdByNode[generation.nodeInstanceId] !== generation.nodeGenerationId || generation.completedOutputClaimIds.length !== 1 || generation.completedOutputClaimIds[0] !== claim.claimId || claim.producerAttemptId !== generation.attemptId || claim.producerFence !== generation.fence) {
          reconciliationFailure(`${checkId} is not the exact current completed project output`);
        }
        return generation;
      }
      assembleProofProjectReconciliationAuthority(nodeGenerationId) {
        const generation = this.instanceProjection.generationsById[nodeGenerationId];
        if (!generation || generation.templateNodeKey !== PROOF_PROJECT_RECONCILE_NODE_KEY || generation.checkId !== PROOF_PROJECT_RECONCILE_NODE_KEY) {
          reconciliationFailure("project reconciliation generation is not the reserved node");
        }
        const project = this.instanceProjection.instancesById[generation.subgraphInstanceId];
        if (!project) reconciliationFailure("project reconciliation project instance is unavailable");
        try {
          deriveProofProjectReconciliationParentClaimIds(this.instanceProjection, generation);
        } catch (error) {
          if (error instanceof ClaimKernelError) throw error;
          reconciliationFailure(`project reconciliation parent lineage is invalid: ${error instanceof Error ? error.message : String(error)}`);
        }
        const materializeNodeId = project.nodeInstanceIdsByTemplateNode.materialize_catalog;
        const materializeGenerationId = materializeNodeId ? this.instanceProjection.activeGenerationIdByNode[materializeNodeId] : void 0;
        const materializeGeneration = materializeGenerationId ? this.instanceProjection.generationsById[materializeGenerationId] : void 0;
        if (!materializeGeneration || materializeGeneration.status !== "completed" || materializeGeneration.completedOutputClaimIds.length !== 1) {
          reconciliationFailure("project reconciliation materialize_catalog output is unavailable");
        }
        const catalog = this.instanceProjection.claimsById[materializeGeneration.completedOutputClaimIds[0]];
        if (!catalog || catalog.claim !== "component.catalog@1") reconciliationFailure("project reconciliation catalog is unavailable");
        const catalogGeneration = this.currentProjectOutput(catalog, "materialize_catalog", project);
        if (catalogGeneration.nodeGenerationId !== materializeGeneration.nodeGenerationId) {
          reconciliationFailure("project reconciliation catalog is detached from materialize_catalog");
        }
        const parentClaims = catalog.parentClaimIds.map((claimId) => this.instanceProjection.claimsById[claimId]);
        const inventory = parentClaims.find((claim) => claim?.claim === PROOF_STRUCTURAL_INVENTORY_CLAIM);
        const candidate = parentClaims.find((claim) => claim?.claim === PROOF_CANDIDATE_CLAIM);
        const admission = parentClaims.find((claim) => claim?.claim === PROOF_ADMITTED_RECEIPT_CLAIM);
        const revalidation = parentClaims.find((claim) => claim?.claim === PROOF_CATALOG_REVALIDATION_CLAIM);
        if (!inventory || !candidate || !admission || !revalidation || parentClaims.length !== 4 || new Set(parentClaims.map((claim) => claim?.claimId)).size !== 4 || canonicalJson(catalog.parentClaimIds) !== canonicalJson([...catalog.parentClaimIds].sort())) {
          reconciliationFailure("project reconciliation catalog lineage is incomplete");
        }
        for (const parent of [inventory, candidate, admission, revalidation]) {
          if (!parent.active || !scopePathEquals(parent.scope, project.scope)) {
            reconciliationFailure("project reconciliation lineage scope is detached");
          }
        }
        this.currentProjectOutput(inventory, "structural_inventory", project);
        const candidateGeneration = this.currentProjectOutput(candidate, "inspect", project);
        const admissionGeneration = this.currentProjectOutput(admission, PROOF_ADMIT_NODE_KEY, project);
        if (candidateGeneration.nodeGenerationId !== candidate.nodeGenerationId || admissionGeneration.nodeGenerationId !== admission.nodeGenerationId || canonicalJson(admission.parentClaimIds) !== canonicalJson([candidate.claimId])) {
          reconciliationFailure("project reconciliation discovery admission lineage is detached");
        }
        try {
          validateProofCandidateAdmissionBinding(
            generatedClaimView(candidate, "discovery candidate"),
            generatedClaimView(admission, "discovery admission")
          );
        } catch (error) {
          reconciliationFailure(`project discovery admission is invalid: ${error instanceof Error ? error.message : String(error)}`);
        }
        const candidatePayload = candidate.payload;
        const inventoryPayload = inventory.payload;
        const projectID = isRecord(candidatePayload) && typeof candidatePayload.project_id === "string" ? candidatePayload.project_id : void 0;
        if (!projectID || !isRecord(inventoryPayload)) reconciliationFailure("project reconciliation authority has no project identity");
        try {
          validateProofCatalogRevalidationProjection(
            revalidation.payload,
            inventoryPayload,
            generatedClaimView(candidate, "discovery candidate"),
            generatedClaimView(admission, "discovery admission"),
            projectID,
            generatedClaimView(revalidation, "catalog revalidation"),
            inventory.claimId
          );
        } catch (error) {
          reconciliationFailure(`project catalog revalidation is invalid: ${error instanceof Error ? error.message : String(error)}`);
        }
        let effectiveRevalidation = revalidation.payload;
        let effectiveAuthorityBytes;
        const appliedAuthorityRecord = this.instanceProjection.appliedProofCatalogAuthorityByProject[project.subgraphInstanceId];
        const appliedAuthority = appliedAuthorityRecord && appliedAuthorityRecord.sourceCatalogClaimId === catalog.claimId ? appliedAuthorityRecord : void 0;
        if (appliedAuthority) {
          if (appliedAuthority.projectSubgraphInstanceId !== project.subgraphInstanceId) {
            reconciliationFailure("applied Proof authority project binding is detached");
          }
          try {
            effectiveAuthorityBytes = validateProofCurrentCatalogAuthorityBytes({
              revalidationBytesBase64: appliedAuthority.revalidationBytesBase64,
              workItemsBytesBase64: appliedAuthority.workItemsBytesBase64,
              candidate: generatedClaimView(candidate, "discovery candidate"),
              admission: generatedClaimView(admission, "discovery admission")
            });
          } catch (error) {
            reconciliationFailure(`applied Proof authority bytes are invalid: ${error instanceof Error ? error.message : String(error)}`);
          }
          if (!effectiveAuthorityBytes) reconciliationFailure("applied Proof authority bytes are unavailable");
          effectiveRevalidation = effectiveAuthorityBytes.revalidation;
          const effectiveInventory = effectiveRevalidation.inventory;
          const effectiveProjectAuthority = isRecord(effectiveInventory) ? effectiveInventory.authority : void 0;
          if (!isRecord(effectiveInventory) || !isRecord(effectiveProjectAuthority) || effectiveProjectAuthority.project_id !== projectID) {
            reconciliationFailure("applied Proof project authority is detached from the active project");
          }
        }
        const children = Object.values(this.instanceProjection.instancesById).filter((instance) => instance.status === "active" && instance.parentSubgraphInstanceId === project.subgraphInstanceId).sort((left, right) => compareProofStrings(left.itemKey, right.itemKey));
        const parentIds = deriveProofProjectReconciliationParentClaimIds(this.instanceProjection, generation);
        const components = children.map((child) => {
          if (!child.activeItemClaimId) reconciliationFailure(`component ${child.itemKey} has no active WorkItem`);
          const item = this.instanceProjection.claimsById[child.activeItemClaimId];
          if (!item || !item.active || item.claim !== "component.work_item@1") reconciliationFailure(`component ${child.itemKey} WorkItem is unavailable`);
          validateComponentChildAdmission(
            this.instanceProjection,
            child.subgraphInstanceId,
            true,
            (nodeGenerationId2) => this.getProofAdmissionRequest(nodeGenerationId2)
          );
          const verifyNodeId = child.nodeInstanceIdsByTemplateNode.verify;
          const verifyGenerationId = verifyNodeId ? this.instanceProjection.activeGenerationIdByNode[verifyNodeId] : void 0;
          const verify = verifyGenerationId ? this.instanceProjection.generationsById[verifyGenerationId] : void 0;
          if (!verify || verify.status !== "completed" || verify.activeInputClaimIds.length !== 2 && verify.activeInputClaimIds.length !== 4 || new Set(verify.activeInputClaimIds).size !== verify.activeInputClaimIds.length) reconciliationFailure(`component ${child.itemKey} verify is incomplete`);
          const verifyClaims = verify.activeInputClaimIds.map((claimId) => this.instanceProjection.claimsById[claimId]);
          const staged = verify.activeInputClaimIds.length === 4;
          const candidateClaims = verifyClaims.filter((value) => value?.claim === (staged ? PROOF_COMPONENT_SPEC_REVIEW_CANDIDATE_CLAIM : PROOF_CANDIDATE_CLAIM));
          const admissionClaims = verifyClaims.filter((value) => value?.claim === (staged ? PROOF_COMPONENT_SPEC_REVIEW_ADMITTED_RECEIPT_CLAIM : PROOF_ADMITTED_RECEIPT_CLAIM));
          const componentCandidate = candidateClaims.length === 1 ? candidateClaims[0] : void 0;
          const componentAdmission = admissionClaims.length === 1 ? admissionClaims[0] : void 0;
          if (!componentCandidate || !componentAdmission || !componentCandidate.nodeGenerationId || !componentAdmission.nodeGenerationId) {
            reconciliationFailure(`component ${child.itemKey} candidate/admission is unavailable`);
          }
          if (!staged) {
            try {
              validateProofComponentCandidateAdmissionBinding(
                generatedClaimView(componentCandidate, `component ${child.itemKey} candidate`),
                generatedClaimView(componentAdmission, `component ${child.itemKey} admission`)
              );
            } catch (error) {
              reconciliationFailure(`component ${child.itemKey} admission is invalid: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
          const candidateRequest = this.getProofAdmissionRequest(componentAdmission.nodeGenerationId);
          const extracted = extractProofAdmissionCandidate(candidateRequest);
          const admissionPayload = componentAdmission.payload;
          const admissionWire = isRecord(admissionPayload) && typeof admissionPayload[PROOF_ADMISSION_WIRE_FIELD] === "string" ? admissionPayload[PROOF_ADMISSION_WIRE_FIELD] : void 0;
          if (!admissionWire) reconciliationFailure(`component ${child.itemKey} admission has no exact Proof wire`);
          let identity;
          try {
            identity = validateProofComponentAdmissionOutcome(extracted.candidateRaw, admissionWire);
          } catch (error) {
            reconciliationFailure(`component ${child.itemKey} admission identity is invalid: ${error instanceof Error ? error.message : String(error)}`);
          }
          let invocationAuthority;
          try {
            invocationAuthority = this.getProofComponentInvocationAuthority(componentCandidate.nodeGenerationId);
          } catch (error) {
            reconciliationFailure(`component ${child.itemKey} invocation authority is invalid: ${error instanceof Error ? error.message : String(error)}`);
          }
          const subject = isRecord(item.payload) ? item.payload.proof_component_subject : void 0;
          const expectedScope = child.scope.map((segment) => ({
            kind: segment.kind,
            expansion_owner_check: segment.expansionOwnerCheck,
            key: segment.key,
            subgraph_instance_id: segment.subgraphInstanceId
          }));
          const itemComponentId = isRecord(item.payload) ? item.payload.component_id : void 0;
          if (identity.subject.kind !== "component" || identity.subject.id !== child.itemKey || !isRecord(subject) || identity.subject.fingerprint !== subject.fingerprint || invocationAuthority.subject.component_id !== child.itemKey || governedCanonicalJson(invocationAuthority.subject, "proof") !== governedCanonicalJson(subject, "proof") || !isRecord(invocationAuthority.work_item) || invocationAuthority.work_item.component_id !== itemComponentId || canonicalJson(identity.scope) !== canonicalJson(expectedScope)) {
            reconciliationFailure(`component ${child.itemKey} admission is cross-scope or stale`);
          }
          let workItemDigest;
          try {
            workItemDigest = proofWorkItemDigestForReconciliation(
              invocationAuthority.work_item,
              projectID
            );
          } catch (error) {
            reconciliationFailure(`component ${child.itemKey} WorkItem digest is invalid: ${error instanceof Error ? error.message : String(error)}`);
          }
          if (effectiveAuthorityBytes) {
            const currentItem = effectiveAuthorityBytes.items.find((value) => value.component_id === child.itemKey);
            const currentRow = effectiveAuthorityBytes.components.find((value) => value.componentId === child.itemKey);
            if (!currentItem || !currentRow || governedCanonicalJson(currentItem, "proof") !== governedCanonicalJson(item.payload, "proof") || currentRow.workItemDigest !== workItemDigest || governedCanonicalJson(currentRow.subject, "proof") !== governedCanonicalJson(subject, "proof")) {
              reconciliationFailure(`component ${child.itemKey} WorkItem is detached from the applied Proof authority`);
            }
          }
          if (!parentIds.includes(componentAdmission.claimId)) reconciliationFailure(`component ${child.itemKey} admission is not a selected parent`);
          return {
            componentId: child.itemKey,
            item,
            candidate: componentCandidate,
            admission: componentAdmission,
            candidateRaw: extracted.candidateRaw,
            admissionWire,
            identity,
            workItemDigest
          };
        });
        if (components.length === 0 || canonicalJson(components.map((component) => component.admission.claimId).sort()) !== canonicalJson([...parentIds].filter((claimId) => claimId !== revalidation.claimId).sort())) {
          reconciliationFailure("project reconciliation component set does not close the parent barrier");
        }
        if (effectiveAuthorityBytes) {
          const childIds = children.map((child) => child.itemKey).sort(compareProofStrings);
          const currentItemIds = effectiveAuthorityBytes.items.map((item) => item.component_id).sort(compareProofStrings);
          const currentAuthorityIds = effectiveAuthorityBytes.components.map((component) => component.componentId).sort(compareProofStrings);
          if (currentItemIds.length !== childIds.length || currentAuthorityIds.length !== childIds.length || canonicalJson(currentItemIds) !== canonicalJson(childIds) || canonicalJson(currentAuthorityIds) !== canonicalJson(childIds)) {
            reconciliationFailure("applied Proof authority component set is detached from active children");
          }
        }
        return {
          generation,
          project,
          projectID,
          inventory,
          candidate,
          admission,
          revalidation,
          effectiveRevalidation,
          ...effectiveAuthorityBytes ? { effectiveAuthorityBytes } : {},
          components
        };
      }
      /** Return the exact Go Request bytes consumed by onboarding reconcile. */
      getProofProjectReconciliationRequest(nodeGenerationId) {
        const authority = this.assembleProofProjectReconciliationAuthority(nodeGenerationId);
        const candidateBytes = governedCanonicalJson(authority.candidate.payload, "proof");
        const revalidationBytes = governedCanonicalJson(authority.effectiveRevalidation, "proof");
        const admissionBinding = validateProofCandidateAdmissionBinding(
          generatedClaimView(authority.candidate, "discovery candidate"),
          generatedClaimView(authority.admission, "discovery admission")
        );
        const outcomes = authority.components.map((component) => `{${[
          `"component_id":${proofStringJson(component.componentId)}`,
          `"candidate":${component.candidateRaw.toString("utf8")}`,
          `"admission":${component.admissionWire}`
        ].join(",")}}`).join(",");
        return `{${[
          `"version":${proofStringJson(PROOF_PROJECT_RECONCILIATION_REQUEST_VERSION)}`,
          `"discovery_candidate":${candidateBytes}`,
          `"discovery_admission":${admissionBinding.wire}`,
          `"catalog_revalidation":${revalidationBytes}`,
          `"outcomes":[${outcomes}]`
        ].join(",")}}`;
      }
      validateProofProjectReconciliationReceipt(payload, authority) {
        const keys = ["version", "project_authority", "catalog_revalidation_receipt", "component_admissions", "covered_work_item_digests", "receipt_id"];
        if (!exactJsonRecord(payload, keys) || payload.version !== PROOF_PROJECT_RECONCILIATION_RECEIPT_VERSION || !isRecord(payload.project_authority) || !isRecord(payload.catalog_revalidation_receipt) || !Array.isArray(payload.component_admissions) || !Array.isArray(payload.covered_work_item_digests) || typeof payload.receipt_id !== "string") {
          reconciliationFailure("project reconciliation receipt envelope is invalid");
        }
        const effectiveInventory = authority.effectiveRevalidation.inventory;
        const projectAuthority = isRecord(effectiveInventory) ? effectiveInventory.authority : void 0;
        if (!projectAuthority || governedCanonicalJson(payload.project_authority, "proof") !== governedCanonicalJson(projectAuthority, "proof")) {
          reconciliationFailure("project reconciliation receipt authority is detached");
        }
        const expectedRevalidation = isRecord(authority.effectiveRevalidation) ? authority.effectiveRevalidation.receipt : void 0;
        if (!expectedRevalidation || governedCanonicalJson(payload.catalog_revalidation_receipt, "proof") !== governedCanonicalJson(expectedRevalidation, "proof")) {
          reconciliationFailure("project reconciliation receipt catalog authority is stale");
        }
        const expectedAdmissions = authority.components.map((component) => {
          const scopeDigest = proofDomainDigest(
            "proof.component-outcome-operational-scope/v1",
            proofScopeJson(component.identity.scope)
          );
          return {
            component_id: component.componentId,
            work_item_digest: component.workItemDigest,
            candidate_id: component.identity.candidateId,
            result_digest: component.identity.resultDigest,
            operational_scope_digest: scopeDigest
          };
        });
        const actualAdmissions = payload.component_admissions;
        if (actualAdmissions.length !== expectedAdmissions.length || actualAdmissions.some((value, index) => !exactJsonRecord(value, ["component_id", "work_item_digest", "candidate_id", "result_digest", "operational_scope_digest"]) || governedCanonicalJson(value, "proof") !== governedCanonicalJson(expectedAdmissions[index], "proof"))) {
          reconciliationFailure("project reconciliation component admissions are not exact");
        }
        const covered = authority.components.map((component) => component.workItemDigest).sort(compareProofStrings);
        if (payload.covered_work_item_digests.length !== covered.length || payload.covered_work_item_digests.some((value, index) => value !== covered[index])) {
          reconciliationFailure("project reconciliation covered WorkItems are not exact");
        }
        let expectedReceiptID;
        try {
          expectedReceiptID = proofDomainDigest(
            "proof.project-reconciliation-receipt/id/v1",
            proofProjectReconciliationReceiptIdentityJson(payload)
          );
        } catch (error) {
          reconciliationFailure(`project reconciliation receipt identity is invalid: ${error instanceof Error ? error.message : String(error)}`);
        }
        if (payload.receipt_id !== expectedReceiptID) reconciliationFailure("project reconciliation receipt ID is invalid");
      }
      getGeneratedExecution(nodeGenerationId) {
        const generation = this.instanceProjection.generationsById[nodeGenerationId];
        if (!generation) throw new ClaimKernelError("UNKNOWN_GENERATION", `Unknown generation ${nodeGenerationId}`);
        const instance = this.instanceProjection.instancesById[generation.subgraphInstanceId];
        const expansion = this.compiledExpansionForInstance(instance.subgraphInstanceId);
        const node = expansion.template.nodesByKey[generation.templateNodeKey];
        const claims = {};
        for (const consumption of node.consumptions) {
          const claim = generation.activeInputClaimIds.map((id) => this.instanceProjection.claimsById[id]).find((candidate) => candidate?.claim === consumption.claim);
          if (!claim) throw new ClaimKernelError("CLAIM_NOT_READY", `Missing generated input ${consumption.claim}`);
          if (claim.kind === "controller-item" && !claim.controllerCatalogClaimId || claim.kind === "generated-output" && (!claim.producerAttemptId || claim.producerFence === void 0)) {
            throw new ClaimKernelError(
              "INVALID_CLAIM_PROVENANCE",
              `Claim ${claim.claimId} lacks authoritative producer provenance`
            );
          }
          const provenance = claim.kind === "controller-item" ? {
            provenance: "controller",
            catalogClaimId: claim.controllerCatalogClaimId,
            incarnation: claim.incarnation
          } : {
            provenance: "attempt",
            attemptId: claim.producerAttemptId,
            fence: claim.producerFence
          };
          claims[consumption.as] = Object.freeze({
            claimId: claim.claimId,
            claim: claim.claim,
            payload: claim.payload,
            payloadFingerprint: claim.payloadFingerprint,
            producerCheckId: claim.producerCheckId,
            scope: claim.scope,
            parentClaimIds: claim.parentClaimIds,
            wireMode: claim.wireMode,
            ...provenance,
            ...isGovernedCandidateClaim2(claim.claim) && claim.proofCandidateEvidence && claim.proofCandidateEvidenceFingerprint ? { proofAdmission: claim.proofCandidateEvidence } : {}
          });
        }
        return Object.freeze({ generation, node, claims: Object.freeze(claims) });
      }
      isGovernedProofCandidateProducer(nodeGenerationId) {
        try {
          const execution = this.getGeneratedExecution(nodeGenerationId);
          const emissions = execution.node.emissions;
          return execution.node.check.type === "governed-proof-inspect" && emissions.length === 1 && emissions[0].from === "output" && isGovernedCandidateClaim2(emissions[0].claim);
        } catch {
          return false;
        }
      }
      /** Assemble the complete controller-owned authority for a component C0
       * activation. The catalog item carries only the compact subject/digest;
       * the raw candidate, admission, WorkItem and current receipt are recovered
       * from the journal's authenticated claims and Proof admission wire. */
      getProofComponentInvocationAuthority(nodeGenerationId) {
        const execution = this.getGeneratedExecution(nodeGenerationId);
        const componentView = execution.claims.component;
        if (!componentView || componentView.claim !== "component.work_item@1") componentAuthorityFailure("component WorkItem is missing from the exact component binding");
        const component = this.instanceProjection.claimsById[componentView.claimId];
        if (!component) componentAuthorityFailure("component WorkItem projection is unavailable");
        const componentInstance = this.instanceProjection.instancesById[component.subgraphInstanceId];
        if (!componentInstance?.parentSubgraphInstanceId) componentAuthorityFailure("component WorkItem is not nested under a project");
        const project = this.instanceProjection.instancesById[componentInstance.parentSubgraphInstanceId];
        if (!project) componentAuthorityFailure("component project instance is unavailable");
        proofProjectExpansionForPlan(this.requireClaimPlan(), project);
        if (!component.controllerCatalogClaimId) componentAuthorityFailure("component WorkItem has no catalog lineage");
        const catalog = this.instanceProjection.claimsById[component.controllerCatalogClaimId];
        if (!catalog) componentAuthorityFailure("component catalog projection is unavailable");
        const admission = catalog.parentClaimIds.map((claimId) => this.instanceProjection.claimsById[claimId]).find((claim) => claim?.claim === PROOF_ADMITTED_RECEIPT_CLAIM);
        if (!admission?.nodeGenerationId) componentAuthorityFailure("admission generation is unavailable");
        const request = this.getProofAdmissionRequest(admission.nodeGenerationId);
        const appliedAuthorityRecord = this.instanceProjection.appliedProofCatalogAuthorityByProject[project.subgraphInstanceId];
        const appliedAuthority = appliedAuthorityRecord && appliedAuthorityRecord.sourceCatalogClaimId === catalog.claimId ? appliedAuthorityRecord : void 0;
        const appliedRow = appliedAuthority?.components.find(
          (value) => value.subgraphInstanceId === component.subgraphInstanceId
        );
        const proofReplacementClaim = component.wireMode === "proof" || this.instanceProjection.proofApplicationClaimIds[component.claimId] === true;
        const currentAuthority = appliedAuthority && appliedRow && proofReplacementClaim && (appliedRow.comparison === "changed" && appliedRow.historicalItemClaimId !== component.claimId || appliedRow.comparison === "unchanged" && appliedRow.historicalItemClaimId === component.claimId) ? appliedAuthority : void 0;
        let currentAuthorityBytes;
        if (currentAuthority) {
          const row = currentAuthority.components.find((value) => value.subgraphInstanceId === component.subgraphInstanceId);
          if (!row || row.comparison === "changed" && row.historicalItemClaimId === component.claimId || row.comparison === "unchanged" && row.historicalItemClaimId !== component.claimId || row.comparison !== "changed" && row.comparison !== "unchanged") {
            componentAuthorityFailure("applied Proof authority does not match the active component WorkItem");
          }
          const sourceParents = catalog.parentClaimIds.map((claimId) => this.instanceProjection.claimsById[claimId]);
          const currentCandidate = sourceParents.find((value) => value?.claim === PROOF_CANDIDATE_CLAIM);
          const currentAdmission = sourceParents.find((value) => value?.claim === PROOF_ADMITTED_RECEIPT_CLAIM);
          if (!currentCandidate || !currentAdmission) componentAuthorityFailure("applied Proof authority source admission lineage is unavailable");
          currentAuthorityBytes = validateProofCurrentCatalogAuthorityBytes({
            revalidationBytesBase64: currentAuthority.revalidationBytesBase64,
            workItemsBytesBase64: currentAuthority.workItemsBytesBase64,
            candidate: generatedClaimView(currentCandidate, "candidate"),
            admission: generatedClaimView(currentAdmission, "admission")
          });
          const currentItem = currentAuthorityBytes.items.find((value) => value.component_id === componentInstance.itemKey);
          if (!currentItem || governedCanonicalJson(currentItem, "proof") !== governedCanonicalJson(component.payload, "proof") || governedPayloadFingerprint(currentItem, "proof") !== governedPayloadFingerprint(component.payload, "proof") || deriveItemFingerprint(currentItem) !== row.currentItemFingerprint || component.payloadFingerprint !== row.currentItemFingerprint) {
            componentAuthorityFailure("applied Proof WorkItems output is detached from the active component claim");
          }
        }
        const assembled = assembleProofComponentInvocationAuthority(this.instanceProjection, component, request, currentAuthorityBytes);
        if (!currentAuthorityBytes) return assembled;
        return validateProofComponentInvocationAuthority({
          ...assembled,
          catalog_revalidation_receipt: currentAuthorityBytes.revalidation.receipt
        });
      }
      /** Derive the exact predecessor evidence for the sole later component
       * onboarding stage.  This is journal authority, never an inherited
       * provider option: all three active aliases and their provenance are
       * checked before the bounded context is frozen. */
      getProofComponentOnboardingStageContext(nodeGenerationId) {
        const execution = this.getGeneratedExecution(nodeGenerationId);
        if (execution.generation.templateNodeKey !== "spec_review" || execution.generation.checkId !== "spec_review" || !isGovernedProofSpecReviewSelector(execution.node.check.invocation)) {
          componentAuthorityFailure("onboarding stage context is reserved for spec_review");
        }
        const aliases = Object.keys(execution.claims).sort();
        if (canonicalJson(aliases) !== canonicalJson(["admission", "candidate", "component"])) {
          componentAuthorityFailure("spec_review inputs are not the exact component/candidate/admission aliases");
        }
        const internalClaim = (alias, expected) => {
          const view = execution.claims[alias];
          const claim = view && this.instanceProjection.claimsById[view.claimId];
          if (!view || !claim || !claim.active || claim.claim !== expected || view.claimId !== claim.claimId || view.claim !== claim.claim || view.payloadFingerprint !== claim.payloadFingerprint || canonicalJson(view.scope) !== canonicalJson(claim.scope)) {
            componentAuthorityFailure(`spec_review ${alias} alias is detached from its active claim projection`);
          }
          return claim;
        };
        const component = internalClaim("component", "component.work_item@1");
        const candidate = internalClaim("candidate", PROOF_CANDIDATE_CLAIM);
        const admission = internalClaim("admission", PROOF_ADMITTED_RECEIPT_CLAIM);
        for (const claim of [component, candidate, admission]) {
          if (canonicalJson(claim.scope) !== canonicalJson(execution.generation.scope)) componentAuthorityFailure("spec_review inputs are outside the generated scope");
        }
        if (candidate.producerCheckId !== "inspect" || admission.producerCheckId !== PROOF_ADMIT_NODE_KEY) {
          componentAuthorityFailure("spec_review predecessor producers are not inspect/proof_admit");
        }
        exactParentIds(admission.parentClaimIds, [candidate.claimId], "spec_review admission");
        if (typeof admission.nodeGenerationId !== "string") componentAuthorityFailure("spec_review admission generation is unavailable");
        const authority = this.getProofComponentInvocationAuthority(nodeGenerationId);
        const request = this.getProofAdmissionRequest(admission.nodeGenerationId);
        const extracted = extractProofAdmissionCandidate(request);
        if (extracted.candidateRaw.length === 0 || proofComponentCandidateEnvelopeJson(extracted.candidate) !== extracted.candidateRaw.toString("utf8")) {
          componentAuthorityFailure("spec_review prior candidate bytes are not retained exactly");
        }
        const invocation = extracted.candidate.Invocation;
        const subject = extracted.candidate.Subject;
        const expectedSubject = { kind: "component", id: authority.subject.component_id, fingerprint: authority.subject.fingerprint };
        if (!isRecord(invocation) || !isRecord(subject) || canonicalJson(subject) !== canonicalJson(expectedSubject) || !isRecord(invocation.subject) || canonicalJson(invocation.subject) !== canonicalJson(expectedSubject) || !isRecord(invocation.component_authority) || governedCanonicalJson(invocation.component_authority, "proof") !== governedCanonicalJson(authority, "proof")) {
          componentAuthorityFailure("spec_review prior candidate subject or authority is detached");
        }
        let admissionWire;
        try {
          const payload = admission.payload;
          if (!isRecord(payload) || typeof payload[PROOF_ADMISSION_WIRE_FIELD] !== "string") throw new Error("missing admission wire");
          admissionWire = payload[PROOF_ADMISSION_WIRE_FIELD];
          JSON.parse(admissionWire);
        } catch (error) {
          componentAuthorityFailure(`spec_review admission wire is invalid: ${error instanceof Error ? error.message : String(error)}`);
        }
        const admissionView = generatedClaimView(admission, "spec_review admission");
        try {
          validateProofComponentCandidateAdmissionBinding(generatedClaimView(candidate, "spec_review candidate"), admissionView);
        } catch (error) {
          componentAuthorityFailure(`spec_review predecessor admission is invalid: ${error instanceof Error ? error.message : String(error)}`);
        }
        const publication = extracted.candidate.Publication;
        if (!isRecord(publication) || publication.ClaimID !== candidate.claimId || publication.Claim !== candidate.claim || publication.PayloadFingerprint !== candidate.payloadFingerprint || canonicalJson(publication.ParentClaimIDs) !== canonicalJson(candidate.parentClaimIds)) {
          componentAuthorityFailure("spec_review prior candidate coordinates are detached from the active claim");
        }
        const context = {
          version: PROOF_ONBOARDING_STAGE_CONTEXT_VERSION,
          stage_id: PROOF_ONBOARDING_STAGE_SPEC_REVIEW,
          prior_candidate: extracted.candidateRaw.toString("utf8"),
          prior_admission: admissionWire,
          prior_admission_claim_id: admission.claimId,
          prior_admission_payload_fingerprint: admission.payloadFingerprint
        };
        if (Buffer.byteLength(extracted.candidateRaw) + Buffer.byteLength(admissionWire) > PROOF_ONBOARDING_STAGE_MAX_BYTES) componentAuthorityFailure("spec_review context exceeds bounded exact-artifact envelope");
        try {
          return validateOnboardingStageContext(immutableProofCanonicalValue(context));
        } catch (error) {
          componentAuthorityFailure(`spec_review context is invalid: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      /** Derive the bounded prior-inspection context only for an authenticated
       * replacement generation. The inactive generation and its claims remain in
       * the journal, so no caller-supplied history can participate. */
      getProofComponentReinspectionContext(nodeGenerationId) {
        const generation = this.instanceProjection.generationsById[nodeGenerationId];
        if (!generation || generation.templateNodeKey !== "inspect" || generation.checkId !== "inspect") return void 0;
        const expansion = this.compiledExpansionForInstance(generation.subgraphInstanceId);
        const node = expansion.template.nodesByKey.inspect;
        if (!node || node.check.type !== "governed-proof-inspect" || !isGovernedProofComponentSelector(node.check.invocation)) return void 0;
        if (generation.incarnation <= 1) return void 0;
        const instance = this.instanceProjection.instancesById[generation.subgraphInstanceId];
        const currentItem = generation.activeInputClaimIds.map((id) => this.instanceProjection.claimsById[id]).find((claim) => claim?.claim === "component.work_item@1");
        if (!instance || !currentItem) componentAuthorityFailure("replacement inspect lacks its current WorkItem");
        const previous = Object.values(this.instanceProjection.generationsById).filter((value) => value.nodeInstanceId === generation.nodeInstanceId && value.templateNodeKey === "inspect" && value.checkId === "inspect" && value.incarnation === generation.incarnation - 1 && value.status === "inactive");
        if (previous.length !== 1) componentAuthorityFailure("replacement inspect lacks one prior superseded generation");
        const priorGeneration = previous[0];
        const priorActivation = this.runtimeEvents.findIndex((event) => event.type === "NodeGenerationActivated" && event.nodeGenerationId === priorGeneration.nodeGenerationId);
        const currentActivation = this.runtimeEvents.findIndex((event) => event.type === "NodeGenerationActivated" && event.nodeGenerationId === generation.nodeGenerationId);
        if (priorActivation < 0 || currentActivation <= priorActivation || this.runtimeEvents.slice(priorActivation + 1, currentActivation).some((event) => event.type === "NodeGenerationActivated" && event.nodeInstanceId === generation.nodeInstanceId && event.nodeGenerationId !== generation.nodeGenerationId)) componentAuthorityFailure("replacement inspect generations are not immediately adjacent");
        const priorCandidates = priorGeneration.completedOutputClaimIds.map((id) => this.instanceProjection.claimsById[id]).filter((claim) => claim?.claim === PROOF_CANDIDATE_CLAIM);
        if (priorGeneration.status !== "inactive" || priorCandidates.length !== 1) componentAuthorityFailure("prior inspect has no unique candidate output");
        const priorCandidate = priorCandidates[0];
        if (!priorCandidate.proofCandidateEvidence) componentAuthorityFailure("prior candidate has no governed evidence");
        const priorEvidence = validateProofCandidateEvidence(priorCandidate.proofCandidateEvidence);
        const admissions = Object.values(this.instanceProjection.claimsById).filter((claim) => claim.claim === PROOF_ADMITTED_RECEIPT_CLAIM && claim.producerCheckId === PROOF_ADMIT_NODE_KEY && canonicalJson(claim.scope) === canonicalJson(priorCandidate.scope) && canonicalJson(claim.parentClaimIds) === canonicalJson([priorCandidate.claimId]) && claim.nodeGenerationId !== void 0 && this.instanceProjection.generationsById[claim.nodeGenerationId]?.incarnation === priorGeneration.incarnation && this.instanceProjection.generationsById[claim.nodeGenerationId]?.subgraphInstanceId === priorGeneration.subgraphInstanceId && this.instanceProjection.generationsById[claim.nodeGenerationId]?.status === "inactive");
        if (admissions.length !== 1) componentAuthorityFailure("prior candidate has no unique admitted receipt");
        const priorAdmission = admissions[0];
        try {
          validateProofComponentCandidateAdmissionBinding(generatedClaimView(priorCandidate, "prior candidate"), generatedClaimView(priorAdmission, "prior admission"));
        } catch (error) {
          componentAuthorityFailure(`prior candidate admission is invalid: ${error instanceof Error ? error.message : String(error)}`);
        }
        const historicalItem = priorGeneration.activeInputClaimIds.map((id) => this.instanceProjection.claimsById[id]).find((claim) => claim?.claim === "component.work_item@1");
        if (!historicalItem || historicalItem.subgraphInstanceId !== currentItem.subgraphInstanceId || !isRecord(historicalItem.payload) || !isRecord(currentItem.payload) || historicalItem.payload.component_id !== currentItem.payload.component_id || currentItem.payload.component_id !== instance.itemKey) componentAuthorityFailure("replacement WorkItem lineage is detached");
        const rows = (payload) => {
          if (!Array.isArray(payload.proof_input_state) || !Array.isArray(payload.sorted_dependency_closure)) componentAuthorityFailure("replacement WorkItem input state is unavailable");
          const closure = payload.sorted_dependency_closure;
          if (closure.some((path) => typeof path !== "string") || rowsSeen(closure)) componentAuthorityFailure("replacement WorkItem closure is invalid");
          const seen = /* @__PURE__ */ new Set();
          return payload.proof_input_state.map((row) => {
            if (!isRecord(row) || typeof row.path !== "string" || seen.has(row.path) || !closure.includes(row.path)) componentAuthorityFailure("replacement WorkItem input state is detached");
            seen.add(row.path);
            return row;
          });
        };
        const rowsSeen = (paths) => paths.some((path, index) => index > 0 && Buffer.from(paths[index - 1], "utf8").compare(Buffer.from(path, "utf8")) >= 0);
        const historicalRows = rows(historicalItem.payload);
        const currentRows = rows(currentItem.payload);
        const historicalByPath = new Map(historicalRows.map((row) => [row.path, canonicalJson(row)]));
        const changedPaths = currentRows.filter((row) => historicalByPath.get(row.path) !== canonicalJson(row)).map((row) => row.path).sort((left, right) => Buffer.from(left, "utf8").compare(Buffer.from(right, "utf8")));
        return validateGovernedProofComponentReinspectionContext({
          version: "visor.proof-component-reinspection-context/v1",
          component_id: currentItem.payload.component_id,
          changed_paths: changedPaths,
          historical_work_item: { claim_id: historicalItem.claimId, payload_fingerprint: historicalItem.payloadFingerprint },
          current_work_item: { claim_id: currentItem.claimId, payload_fingerprint: currentItem.payloadFingerprint },
          prior_candidate: { claim_id: priorCandidate.claimId, payload_fingerprint: priorCandidate.payloadFingerprint, result_digest: priorEvidence.probe.resultIdentity.resultDigest, payload: priorCandidate.payload },
          prior_admission: { claim_id: priorAdmission.claimId, payload_fingerprint: priorAdmission.payloadFingerprint }
        });
      }
      /** Project the exact controller-owned candidate envelope consumed by Proof. */
      getProofAdmissionRequest(nodeGenerationId) {
        const execution = this.getGeneratedExecution(nodeGenerationId);
        const staged = execution.generation.templateNodeKey === "spec_review_admit" && execution.generation.checkId === "spec_review_admit";
        if (!staged && (execution.generation.templateNodeKey !== PROOF_ADMIT_NODE_KEY || execution.generation.checkId !== PROOF_ADMIT_NODE_KEY) || staged && execution.generation.templateNodeKey !== "spec_review_admit") {
          throw new ClaimKernelError("INVALID_PROOF_ADMISSION_PROJECTION", "Proof admission is reserved for proof_admit");
        }
        const expectedCandidateClaim = staged ? PROOF_COMPONENT_SPEC_REVIEW_CANDIDATE_CLAIM : PROOF_CANDIDATE_CLAIM;
        const candidateClaim = Object.values(execution.claims).find((claim) => claim.claim === expectedCandidateClaim);
        const evidence = candidateClaim?.proofAdmission;
        if (!candidateClaim || !evidence) throw new ClaimKernelError("INVALID_PROOF_ADMISSION_PROJECTION", "Proof candidate evidence is missing");
        const wireMode = governedWireModeFromEvidence(evidence);
        if (candidateClaim.wireMode !== wireMode) throw new ClaimKernelError("INVALID_PROOF_ADMISSION_PROJECTION", "Proof candidate wire mode is detached");
        if (candidateClaim.provenance !== "attempt" || typeof candidateClaim.attemptId !== "string" || !Number.isSafeInteger(candidateClaim.fence)) {
          throw new ClaimKernelError("INVALID_PROOF_ADMISSION_PROJECTION", "Proof candidate provenance is invalid");
        }
        const proofAttempts = this.runtimeEvents.filter(
          (event) => event.type === "AttemptStarted" && "nodeGenerationId" in event && event.nodeGenerationId === execution.generation.nodeGenerationId && event.checkId === (staged ? "spec_review_admit" : PROOF_ADMIT_NODE_KEY) && event.attemptId === execution.generation.attemptId && event.fence === execution.generation.fence
        );
        if (proofAttempts.length !== 1) throw new ClaimKernelError("INVALID_PROOF_ADMISSION_PROJECTION", "Proof admission attempt is ambiguous");
        const proofAttemptIndex = this.runtimeEvents.indexOf(proofAttempts[0]);
        const publications = this.runtimeEvents.filter(
          (event) => event.type === "ClaimPublished" && event.claim === expectedCandidateClaim && event.claimId === candidateClaim.claimId && event.attemptId === candidateClaim.attemptId && event.fence === candidateClaim.fence
        );
        if (publications.length !== 1) throw new ClaimKernelError("INVALID_PROOF_ADMISSION_PROJECTION", "Candidate publication is ambiguous");
        const publication = publications[0];
        const publicationIndex = this.runtimeEvents.indexOf(publication);
        if (publicationIndex < 0 || publicationIndex >= proofAttemptIndex || publication.producerCheckId !== candidateClaim.producerCheckId || publication.wireMode !== wireMode || publication.payloadFingerprint !== candidateClaim.payloadFingerprint || canonicalJson(publication.scope) !== canonicalJson(candidateClaim.scope) || canonicalJson(publication.parentClaimIds) !== canonicalJson(candidateClaim.parentClaimIds) || publication.attemptId !== candidateClaim.attemptId || publication.fence !== candidateClaim.fence || governedCanonicalJson(publication.payload, wireMode) !== governedCanonicalJson(candidateClaim.payload, wireMode)) {
          throw new ClaimKernelError("INVALID_PROOF_ADMISSION_PROJECTION", "Candidate publication is detached");
        }
        const terminations = this.runtimeEvents.filter(
          (event) => event.type === "ManagedRunTerminated" && event.binding.checkId === publication.checkId && event.binding.nodeGenerationId === publication.nodeGenerationId && event.binding.attemptId === publication.attemptId && event.binding.fence === publication.fence && event.controllerDecision === "completed"
        );
        if (terminations.length !== 1) {
          throw new ClaimKernelError("INVALID_PROOF_ADMISSION_PROJECTION", "Candidate managed termination is ambiguous");
        }
        const termination = terminations[0];
        const terminationIndex = this.runtimeEvents.indexOf(termination);
        if (terminationIndex < 0 || terminationIndex >= proofAttemptIndex || termination.cleanupStatus !== "clean" || termination.failureCode !== null || termination.sessionId !== publication.sessionId || canonicalJson(termination.scope) !== canonicalJson(publication.scope)) {
          throw new ClaimKernelError("INVALID_PROOF_ADMISSION_PROJECTION", "Candidate managed termination is not clean");
        }
        const scope = (value) => value.map((part) => ({
          Kind: part.kind,
          ExpansionOwnerCheck: part.expansionOwnerCheck,
          Key: part.key,
          SubgraphInstanceID: part.subgraphInstanceId
        }));
        const binding = {
          ManagedRunID: deriveManagedRunId({
            sessionId: publication.sessionId,
            checkId: publication.checkId,
            scope: publication.scope,
            nodeInstanceId: publication.nodeInstanceId,
            nodeGenerationId: publication.nodeGenerationId,
            attemptId: publication.attemptId,
            fence: publication.fence
          }),
          SessionID: publication.sessionId,
          CheckID: publication.checkId,
          Scope: scope(publication.scope),
          NodeInstanceID: publication.nodeInstanceId,
          NodeGenerationID: publication.nodeGenerationId,
          AttemptID: publication.attemptId,
          Fence: publication.fence
        };
        if (termination.binding.managedRunId !== binding.ManagedRunID || termination.binding.sessionId !== publication.sessionId || termination.binding.checkId !== publication.checkId || termination.binding.nodeInstanceId !== publication.nodeInstanceId || termination.binding.nodeGenerationId !== publication.nodeGenerationId || termination.binding.attemptId !== publication.attemptId || termination.binding.fence !== publication.fence || canonicalJson(termination.binding.scope) !== canonicalJson(publication.scope)) {
          throw new ClaimKernelError("INVALID_PROOF_ADMISSION_PROJECTION", "Candidate termination binding is detached");
        }
        const invocation = evidence.role.invocation;
        if (staged && invocation.onboarding_stage === void 0) {
          throw new ClaimKernelError("INVALID_PROOF_ADMISSION_PROJECTION", "Staged Proof candidate has no onboarding stage context");
        }
        const subject = invocation.subject;
        const invocationWire = {
          role_id: invocation.role_id,
          stance: invocation.stance,
          subject: { kind: subject.kind, id: subject.id, fingerprint: subject.fingerprint },
          ...invocation.component_authority !== void 0 ? { component_authority: invocation.component_authority } : {},
          ...staged ? { onboarding_stage: invocation.onboarding_stage } : {},
          output_schema_id: invocation.output_schema_id,
          output_schema: invocation.output_schema
        };
        const payloadBytes = Buffer.from(governedCanonicalJson(publication.payload, wireMode), "utf8");
        const candidate = {
          Version: "proof.role-result-candidate-envelope/v1",
          Invocation: invocationWire,
          InvocationDigest: evidence.role.invocationDigest,
          RoleID: invocation.role_id,
          Stance: invocation.stance,
          Subject: { kind: subject.kind, id: subject.id, fingerprint: subject.fingerprint },
          AttestationVersion: evidence.probe.attestation.version,
          ExecutionSource: "caller",
          ProbeInvocationDigest: evidence.probe.attestation.executionContext.invocationDigest,
          IdentityVersion: evidence.probe.resultIdentity.version,
          IdentitySource: evidence.probe.resultIdentity.source,
          ResultDigest: evidence.probe.resultIdentity.resultDigest,
          CanonicalBytes: evidence.probe.resultIdentity.canonicalBytes,
          ProbeResultBytes: payloadBytes.toString("base64"),
          VisorPayloadBytes: payloadBytes.toString("base64"),
          Publication: {
            Version: 1,
            Type: "ClaimPublished",
            SessionID: publication.sessionId,
            CheckID: publication.checkId,
            Scope: scope(publication.scope),
            NodeInstanceID: publication.nodeInstanceId,
            NodeGenerationID: publication.nodeGenerationId,
            AttemptID: publication.attemptId,
            Fence: publication.fence,
            ClaimID: publication.claimId,
            Claim: publication.claim,
            PayloadFingerprint: publication.payloadFingerprint,
            ProducerCheckID: publication.producerCheckId,
            Payload: payloadBytes.toString("base64"),
            ParentClaimIDs: [...publication.parentClaimIds]
          },
          Binding: binding,
          Termination: {
            Version: 1,
            Type: "ManagedRunTerminated",
            SessionID: termination.sessionId,
            Scope: scope(termination.scope),
            Binding: binding,
            CleanupStatus: termination.cleanupStatus,
            ControllerDecision: termination.controllerDecision,
            FailureCode: null
          }
        };
        return proofCandidateAdmissionRequestJson({ version: "proof.role-result-candidate-cli-request/v1", candidate });
      }
      deriveManagedRunBinding(attempt) {
        const generation = this.instanceProjection.generationsById[attempt.nodeGenerationId];
        const instance = generation ? this.instanceProjection.instancesById[generation.subgraphInstanceId] : void 0;
        if (!generation || !instance || generation.status !== "running" || !generation.scheduled || generation.attemptId !== attempt.attemptId || generation.fence !== attempt.fence || generation.nodeInstanceId !== attempt.nodeInstanceId || this.instanceProjection.attemptBindingsById[attempt.attemptId] !== generation.nodeGenerationId || attempt.sessionId !== instance.sessionId || attempt.checkId !== generation.checkId || canonicalJson(attempt.scope) !== canonicalJson(generation.scope) || attempt.nodeGenerationId !== generation.nodeGenerationId) {
          throw new ClaimKernelError(
            "INVALID_MANAGED_BINDING",
            `Attempt ${attempt.attemptId} is not the current scheduled generated attempt`
          );
        }
        const authority = {
          sessionId: instance.sessionId,
          checkId: generation.checkId,
          scope: generation.scope,
          nodeInstanceId: generation.nodeInstanceId,
          nodeGenerationId: generation.nodeGenerationId,
          attemptId: generation.attemptId,
          fence: generation.fence
        };
        return immutableCanonicalValue({
          managedRunId: deriveManagedRunId(authority),
          ...authority
        });
      }
      appendInstanceEventBatch(events) {
        this.requireClaimPlan();
        const stored = events.map((event) => immutableInstanceEvent(event));
        const projected = reduceInstanceEventBatch(this.instanceProjection, stored);
        this.runtimeEvents.push(...stored);
        this.instanceProjection = projected;
      }
      failManagedRunAcquisition(input) {
        const eventId = this.nextRuntimeEventId();
        this.appendInstanceEventBatch([
          {
            version: 1,
            type: "ManagedRunAcquisitionFailed",
            eventId,
            sessionId: input.attempt.sessionId,
            scope: input.attempt.scope,
            binding: input.binding,
            failureCode: input.failureCode
          },
          {
            ...input.attempt,
            type: "AttemptFailed",
            eventId: eventId + 1,
            reason: input.failureCode
          }
        ]);
      }
      recordManagedRunAcquired(binding) {
        this.appendInstanceEvent({
          version: 1,
          type: "ManagedRunAcquired",
          eventId: this.nextRuntimeEventId(),
          sessionId: binding.sessionId,
          scope: binding.scope,
          binding
        });
      }
      recordManagedRunStarted(binding) {
        this.appendInstanceEvent({
          version: 1,
          type: "ManagedRunStarted",
          eventId: this.nextRuntimeEventId(),
          sessionId: binding.sessionId,
          scope: binding.scope,
          binding
        });
      }
      recordManagedRunCancelRequested(binding) {
        this.appendInstanceEvent({
          version: 1,
          type: "ManagedRunCancelRequested",
          eventId: this.nextRuntimeEventId(),
          sessionId: binding.sessionId,
          scope: binding.scope,
          binding,
          reason: "deadline"
        });
      }
      failManagedGeneratedAttempt(input) {
        const eventId = this.nextRuntimeEventId();
        this.appendInstanceEventBatch([
          {
            version: 1,
            type: "ManagedRunTerminated",
            eventId,
            sessionId: input.attempt.sessionId,
            scope: input.attempt.scope,
            binding: input.binding,
            cleanupStatus: input.cleanupStatus,
            controllerDecision: "failed",
            failureCode: input.failureCode
          },
          {
            ...input.attempt,
            type: "AttemptFailed",
            eventId: eventId + 1,
            reason: input.failureCode
          }
        ]);
      }
      completeGeneratedAttempt(input) {
        const staged = this.stageGeneratedCompletion(input);
        this.runtimeEvents.push(...staged.events);
        this.instanceProjection = staged.projection;
      }
      completeManagedGeneratedAttempt(input) {
        const terminal = immutableInstanceEvent({
          version: 1,
          type: "ManagedRunTerminated",
          eventId: this.nextRuntimeEventId(),
          sessionId: input.binding.sessionId,
          scope: input.binding.scope,
          binding: input.binding,
          cleanupStatus: "clean",
          controllerDecision: "completed",
          failureCode: null
        });
        const staged = this.stageGeneratedCompletion(input, [terminal]);
        this.runtimeEvents.push(...staged.events);
        this.instanceProjection = staged.projection;
      }
      /**
       * Record one current Proof catalog authority without rewriting any
       * historical catalog, item, or generation. Inputs are snapshotted to bytes
       * before validation, so a caller cannot mutate a value between identity and
       * reducer validation. The reducer is staged before the journal is changed.
       */
      recordProofCurrentCatalogAuthority(input) {
        ensureCheckpointQuiescent(this.claimProjection, this.instanceProjection);
        const project = this.instanceProjection.instancesById[input.projectSubgraphInstanceId];
        if (!project || project.status !== "active" || project.scope.length !== 1) {
          throw new ClaimKernelError("INVALID_PROOF_CURRENT_AUTHORITY", "Proof authority requires one active project instance");
        }
        proofProjectExpansionForPlan(this.requireClaimPlan(), project);
        const sourceClaims = Object.values(this.instanceProjection.claimsById).filter((claim) => {
          if (!claim.active || claim.kind !== "generated-output" || claim.claim !== "component.catalog@1" || claim.producerCheckId !== "materialize_catalog" || claim.subgraphInstanceId !== project.subgraphInstanceId || !claim.nodeGenerationId || !scopePathEquals(claim.scope, project.scope)) return false;
          const generation = this.instanceProjection.generationsById[claim.nodeGenerationId];
          return !!generation && generation.status === "completed" && generation.checkId === "materialize_catalog" && generation.subgraphInstanceId === project.subgraphInstanceId && generation.templateNodeKey === "materialize_catalog" && generation.completedOutputClaimIds.length === 1 && generation.completedOutputClaimIds[0] === claim.claimId;
        });
        if (sourceClaims.length !== 1) {
          throw new ClaimKernelError("INVALID_PROOF_CURRENT_AUTHORITY", "Proof authority source catalog is ambiguous or unavailable");
        }
        const snapshotBytes = (value) => {
          const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
          return bytes.toString("base64");
        };
        const revalidationBytesBase64 = snapshotBytes(input.revalidationBytes);
        const workItemsBytesBase64 = snapshotBytes(input.workItemsBytes);
        const previousAuthorityId = this.instanceProjection.currentProofCatalogAuthorityByProject[input.projectSubgraphInstanceId]?.authorityId || sourceClaims[0].claimId;
        const event = immutableInstanceEvent({
          version: 1,
          type: "ProofCurrentCatalogAuthorityRecorded",
          eventId: this.nextRuntimeEventId(),
          sessionId: project.sessionId,
          scope: project.scope,
          projectSubgraphInstanceId: input.projectSubgraphInstanceId,
          sourceCatalogClaimId: sourceClaims[0].claimId,
          previousAuthorityId,
          authorityId: deriveProofCurrentCatalogAuthorityId({
            sessionId: project.sessionId,
            scope: project.scope,
            projectSubgraphInstanceId: input.projectSubgraphInstanceId,
            sourceCatalogClaimId: sourceClaims[0].claimId,
            previousAuthorityId,
            revalidationBytesBase64,
            workItemsBytesBase64
          }),
          revalidationBytesBase64,
          workItemsBytesBase64
        });
        const projected = reduceInstanceEvent(this.instanceProjection, event);
        this.runtimeEvents.push(event);
        this.instanceProjection = projected;
        return event;
      }
      /**
       * Atomically apply the latest authenticated Proof catalog authority to the
       * changed component instances.  The mutation suffix is built exclusively
       * from the current projection and the already-validated Proof WorkItems
       * bytes; callers cannot supply a disposition, item, or generation.
       */
      applyProofCurrentCatalogAuthority(input) {
        ensureCheckpointQuiescent(this.claimProjection, this.instanceProjection);
        const project = this.instanceProjection.instancesById[input.projectSubgraphInstanceId];
        if (!project || project.status !== "active" || project.scope.length !== 1) {
          throw new ClaimKernelError("INVALID_PROOF_CURRENT_APPLICATION", "Proof authority application requires one active project instance");
        }
        proofProjectExpansionForPlan(this.requireClaimPlan(), project);
        const authority = this.instanceProjection.currentProofCatalogAuthorityByProject[input.projectSubgraphInstanceId];
        if (!authority || authority.authorityId !== input.authorityId || this.instanceProjection.appliedProofCatalogAuthorityByProject[input.projectSubgraphInstanceId]?.authorityId === input.authorityId) {
          throw new ClaimKernelError("INVALID_PROOF_CURRENT_APPLICATION", "Proof authority application is stale or already applied");
        }
        const source = this.instanceProjection.claimsById[authority.sourceCatalogClaimId];
        if (!source || !source.active || source.claim !== "component.catalog@1" || source.kind !== "generated-output" || source.producerCheckId !== "materialize_catalog") {
          throw new ClaimKernelError("INVALID_PROOF_CURRENT_APPLICATION", "Proof authority source catalog is unavailable");
        }
        const sourceParents = source.parentClaimIds.map((claimId) => this.instanceProjection.claimsById[claimId]);
        const candidate = sourceParents.find((claim) => claim?.claim === PROOF_CANDIDATE_CLAIM);
        const admission = sourceParents.find((claim) => claim?.claim === PROOF_ADMITTED_RECEIPT_CLAIM);
        if (!candidate || !admission) {
          throw new ClaimKernelError("INVALID_PROOF_CURRENT_APPLICATION", "Proof authority source admission lineage is unavailable");
        }
        let validated;
        try {
          validated = validateProofCurrentCatalogAuthorityBytes({
            revalidationBytesBase64: authority.revalidationBytesBase64,
            workItemsBytesBase64: authority.workItemsBytesBase64,
            candidate: generatedClaimView(candidate, "candidate"),
            admission: generatedClaimView(admission, "admission")
          });
        } catch (error) {
          throw new ClaimKernelError("INVALID_PROOF_CURRENT_APPLICATION", `Current Proof authority bytes are invalid: ${error instanceof Error ? error.message : String(error)}`);
        }
        const components = authority.components.filter((row) => row.comparison === "changed").sort((left, right) => Buffer.from(left.componentId, "utf8").compare(Buffer.from(right.componentId, "utf8")));
        const events = [];
        const headerEventId = this.nextRuntimeEventId();
        let nextEventId = headerEventId + 1;
        const projectNodeKeys = Object.keys(project.nodeInstanceIdsByTemplateNode).sort();
        const reconciliationNodeId = project.nodeInstanceIdsByTemplateNode[PROOF_PROJECT_RECONCILE_NODE_KEY];
        const exactReconciliationTopology = projectNodeKeys.length === 7 && canonicalJson(projectNodeKeys) === canonicalJson([
          "inspect",
          "materialize_catalog",
          PROOF_PROJECT_RECONCILE_NODE_KEY,
          PROOF_ADMIT_NODE_KEY,
          "revalidate_catalog",
          "structural_inventory",
          "verify"
        ].sort());
        if (components.length > 0 && exactReconciliationTopology) {
          const reconciliationGenerationId = reconciliationNodeId ? this.instanceProjection.activeGenerationIdByNode[reconciliationNodeId] : void 0;
          const reconciliationGeneration = reconciliationGenerationId ? this.instanceProjection.generationsById[reconciliationGenerationId] : void 0;
          if (!reconciliationNodeId || !reconciliationGeneration || reconciliationGeneration.status !== "completed" || reconciliationGeneration.templateNodeKey !== PROOF_PROJECT_RECONCILE_NODE_KEY || reconciliationGeneration.checkId !== PROOF_PROJECT_RECONCILE_NODE_KEY || reconciliationGeneration.subgraphInstanceId !== project.subgraphInstanceId || !scopePathEquals(reconciliationGeneration.scope, project.scope) || !reconciliationGeneration.scheduled || reconciliationGeneration.completedOutputClaimIds.length !== 1) {
            throw new ClaimKernelError(
              "INVALID_PROOF_CURRENT_APPLICATION",
              "Current project reconciliation receipt is not an exact completed output"
            );
          }
          const reconciliationReceipt = this.instanceProjection.claimsById[reconciliationGeneration.completedOutputClaimIds[0]];
          if (!reconciliationReceipt || !reconciliationReceipt.active || reconciliationReceipt.kind !== "generated-output" || reconciliationReceipt.claim !== PROOF_PROJECT_RECONCILIATION_RECEIPT_CLAIM || reconciliationReceipt.nodeGenerationId !== reconciliationGeneration.nodeGenerationId || reconciliationReceipt.producerCheckId !== PROOF_PROJECT_RECONCILE_NODE_KEY || reconciliationReceipt.subgraphInstanceId !== project.subgraphInstanceId || !scopePathEquals(reconciliationReceipt.scope, project.scope) || reconciliationReceipt.producerAttemptId !== reconciliationGeneration.attemptId || reconciliationReceipt.producerFence !== reconciliationGeneration.fence) {
            throw new ClaimKernelError(
              "INVALID_PROOF_CURRENT_APPLICATION",
              "Current project reconciliation receipt is unavailable"
            );
          }
          const reconciliationAuthority = this.assembleProofProjectReconciliationAuthority(
            reconciliationGeneration.nodeGenerationId
          );
          this.validateProofProjectReconciliationReceipt(
            reconciliationReceipt.payload,
            reconciliationAuthority
          );
          events.push({
            version: 1,
            type: "NodeGenerationInactivated",
            eventId: nextEventId++,
            sessionId: project.sessionId,
            scope: project.scope,
            subgraphInstanceId: project.subgraphInstanceId,
            nodeInstanceId: reconciliationGeneration.nodeInstanceId,
            nodeGenerationId: reconciliationGeneration.nodeGenerationId,
            incarnation: reconciliationGeneration.incarnation,
            outputClaimIds: [...reconciliationGeneration.completedOutputClaimIds].sort(),
            reason: "superseded"
          });
        }
        for (const row of components) {
          const instance = this.instanceProjection.instancesById[row.subgraphInstanceId];
          if (!instance || instance.status !== "active" || instance.itemKey !== row.componentId || instance.catalogClaimId !== authority.sourceCatalogClaimId || !instance.activeItemClaimId || instance.activeItemClaimId !== row.historicalItemClaimId) {
            throw new ClaimKernelError("INVALID_PROOF_CURRENT_APPLICATION", `Historical component ${row.componentId} is stale or detached`);
          }
          const historical = this.instanceProjection.claimsById[instance.activeItemClaimId];
          const componentExpansion = this.compiledExpansionForInstance(instance.subgraphInstanceId);
          const item = validated.items.find((value) => value.component_id === row.componentId);
          if (!historical || !historical.active || historical.payloadFingerprint !== row.historicalItemFingerprint || !item || deriveItemFingerprint(item) !== row.currentItemFingerprint || governedCanonicalJson(item, "proof") === governedCanonicalJson(historical.payload, "proof")) {
            throw new ClaimKernelError("INVALID_PROOF_CURRENT_APPLICATION", `Current WorkItem ${row.componentId} is not an exact changed Proof item`);
          }
          const generations = Object.values(this.instanceProjection.generationsById).filter((generation) => generation.subgraphInstanceId === instance.subgraphInstanceId && generation.status !== "inactive").sort((left, right) => left.nodeGenerationId.localeCompare(right.nodeGenerationId));
          if (generations.some((generation) => generation.status === "ready" || generation.status === "running")) {
            throw new ClaimKernelError("INVALID_PROOF_CURRENT_APPLICATION", `Component ${row.componentId} has a nonterminal generation`);
          }
          if (Object.values(this.instanceProjection.instancesById).some((candidateInstance) => candidateInstance.status === "active" && candidateInstance.parentSubgraphInstanceId === instance.subgraphInstanceId)) {
            throw new ClaimKernelError("INVALID_PROOF_CURRENT_APPLICATION", `Component ${row.componentId} has active descendants`);
          }
          for (const generation of generations) {
            events.push({
              version: 1,
              type: "NodeGenerationInactivated",
              eventId: nextEventId++,
              sessionId: project.sessionId,
              scope: instance.scope,
              subgraphInstanceId: instance.subgraphInstanceId,
              nodeInstanceId: generation.nodeInstanceId,
              nodeGenerationId: generation.nodeGenerationId,
              incarnation: generation.incarnation,
              outputClaimIds: [...generation.completedOutputClaimIds].sort(),
              reason: "superseded"
            });
          }
          const itemFingerprint = deriveItemFingerprint(item);
          const incarnation = instance.incarnation + 1;
          const claimId = deriveControllerItemClaimId({
            claim: "component.work_item@1",
            payloadFingerprint: itemFingerprint,
            expansionSpecDigest: instance.expansionSpecDigest,
            catalogClaimId: authority.sourceCatalogClaimId,
            subgraphInstanceId: instance.subgraphInstanceId,
            incarnation,
            scope: instance.scope
          });
          events.push({
            version: 1,
            type: "ControllerItemClaimPublished",
            eventId: nextEventId++,
            sessionId: project.sessionId,
            scope: instance.scope,
            expansionOwnerCheck: componentExpansion.expansionOwnerCheck,
            expansionSpecDigest: instance.expansionSpecDigest,
            catalogClaimId: authority.sourceCatalogClaimId,
            itemKey: row.componentId,
            subgraphInstanceId: instance.subgraphInstanceId,
            incarnation,
            claimId,
            claim: "component.work_item@1",
            payload: item,
            payloadFingerprint: itemFingerprint,
            parentClaimIds: [authority.sourceCatalogClaimId]
          });
          const inspectNodeId = instance.nodeInstanceIdsByTemplateNode.inspect;
          const previousInspect = inspectNodeId ? Object.values(this.instanceProjection.generationsById).find((generation) => generation.nodeInstanceId === inspectNodeId && generation.status !== "inactive") : void 0;
          if (!inspectNodeId || !previousInspect || previousInspect.status === "ready" || previousInspect.status === "running") {
            throw new ClaimKernelError("INVALID_PROOF_CURRENT_APPLICATION", `Component ${row.componentId} has no terminal inspect generation`);
          }
          const inputIds = previousInspect.activeInputClaimIds.map((claim) => claim === historical.claimId ? claimId : claim).sort();
          const inspect = componentExpansion.template.nodesByKey.inspect;
          if (!inspect) throw new ClaimKernelError("INVALID_PROOF_CURRENT_APPLICATION", `Component ${row.componentId} inspect node is unavailable`);
          const nodeGenerationId = deriveNodeGenerationId({
            nodeInstanceId: inspectNodeId,
            incarnation,
            itemFingerprint,
            executionConfigDigest: inspect.executionConfigDigest,
            activeInputClaimIds: inputIds
          });
          events.push({
            version: 1,
            type: "NodeGenerationActivated",
            eventId: nextEventId++,
            sessionId: project.sessionId,
            scope: instance.scope,
            subgraphInstanceId: instance.subgraphInstanceId,
            nodeInstanceId: inspectNodeId,
            nodeGenerationId,
            templateNodeKey: "inspect",
            checkId: "inspect",
            incarnation,
            itemFingerprint,
            executionConfigDigest: inspect.executionConfigDigest,
            activeInputClaimIds: inputIds,
            ...previousInspect.nestedExpansionCatalogClaimRef ? { nestedExpansionCatalogClaimRef: previousInspect.nestedExpansionCatalogClaimRef } : {}
          });
        }
        const header = {
          version: 1,
          type: "ProofCurrentCatalogAuthorityApplied",
          eventId: headerEventId,
          sessionId: project.sessionId,
          scope: project.scope,
          projectSubgraphInstanceId: project.subgraphInstanceId,
          authorityId: authority.authorityId,
          mutationEventCount: events.length,
          mutationEventsDigest: deriveProofCurrentCatalogAuthorityMutationDigest({
            authorityId: authority.authorityId,
            mutations: events
          })
        };
        const stored = [immutableInstanceEvent(header), ...events.map((event) => immutableProofApplicationEvent(event))];
        const projected = reduceInstanceEventBatch(this.instanceProjection, stored);
        this.runtimeEvents.push(...stored);
        this.instanceProjection = projected;
        return stored[0];
      }
      stageGeneratedCompletion(input, prefix = []) {
        const { attempt, payload } = input;
        const before = this.instanceProjection;
        const generation = before.generationsById[attempt.nodeGenerationId];
        const instance = before.instancesById[generation.subgraphInstanceId];
        const expansion = this.compiledExpansionForInstance(instance.subgraphInstanceId);
        const node = expansion.template.nodesByKey[generation.templateNodeKey];
        const candidateEmissions = node.emissions.filter((emission) => isGovernedCandidateClaim2(emission.claim));
        const stagedCandidateEmission = candidateEmissions.some((emission) => emission.claim === PROOF_COMPONENT_SPEC_REVIEW_CANDIDATE_CLAIM);
        const compiledWireMode = compiledManagedProofWireMode(generation, node);
        if (compiledWireMode === "proof" || candidateEmissions.length > 0) {
          const terminal = prefix.filter((event) => event.type === "ManagedRunTerminated");
          if (terminal.length !== 1 || terminal[0].cleanupStatus !== "clean" || terminal[0].controllerDecision !== "completed" || terminal[0].failureCode !== null) {
            throw new ClaimKernelError("MANAGED_TERMINAL_REQUIRED", "Proof publication requires a clean managed terminal");
          }
        }
        if (input.executionConfigDigest !== void 0 && input.executionConfigDigest !== generation.executionConfigDigest) throw new ClaimKernelError("STALE_EXECUTION_CONFIG", "Managed completion does not match live generation authority");
        const nestedOwner = qualifiedNestedExpansionOwner(
          expansion.template.name,
          generation.templateNodeKey
        );
        const nestedExpansion = this.requireClaimPlan().expansionPlan.byNestedOwner[nestedOwner];
        if (candidateEmissions.length > 0) {
          if (input.executionConfigDigest !== generation.executionConfigDigest || (stagedCandidateEmission ? generation.templateNodeKey !== "spec_review" : generation.templateNodeKey !== "inspect") || node.check.type !== "governed-proof-inspect" || input.proofCandidateEvidence === void 0) {
            throw new ClaimKernelError("INVALID_PROOF_EVIDENCE", "Proof candidate completion requires governed inspect authority and an evidence sidecar");
          }
          try {
            const evidence = validateProofCandidateEvidence(input.proofCandidateEvidence);
            const candidateWireMode2 = governedWireModeFromEvidence(evidence);
            if (input.wireMode !== void 0 && input.wireMode !== candidateWireMode2) throw new Error("wire mode is detached from governed invocation");
            const componentSelector = !stagedCandidateEmission && isGovernedProofComponentSelector(node.check.invocation);
            const projectSelector = !stagedCandidateEmission && isGovernedProofProjectSelector(node.check.invocation);
            const selector = stagedCandidateEmission ? isGovernedProofSpecReviewSelector(node.check.invocation) : componentSelector || projectSelector;
            const invocation = evidence.role.invocation;
            const selectorBound = projectSelector ? invocation.role_id === "onboard" && invocation.stance === "owner" && invocation.output_schema_id === node.check.invocation.output_schema_id && invocation.output_schema === node.check.invocation.output_schema && invocation.subject && typeof invocation.subject === "object" && invocation.subject.kind === "project" : selector && invocation.role_id === (stagedCandidateEmission ? "spec-review" : "onboard") && invocation.stance === "owner" && invocation.output_schema_id === node.check.invocation.output_schema_id && invocation.output_schema === node.check.invocation.output_schema && !!invocation.component_authority && (!stagedCandidateEmission || invocation.onboarding_stage !== void 0) && invocation.subject && typeof invocation.subject === "object" && invocation.subject.kind === "component";
            if (!selector && (evidence.role.invocationDigest !== node.check.invocation_digest || canonicalJson(evidence.role.invocation) !== canonicalJson(node.check.invocation)) || selector && !selectorBound) {
              throw new Error("evidence invocation is detached from compiled inspect config");
            }
            if (selector && !projectSelector) {
              const authority = this.getProofComponentInvocationAuthority(generation.nodeGenerationId);
              if (governedCanonicalJson(invocation.component_authority, "proof") !== governedCanonicalJson(authority, "proof")) {
                throw new Error("component invocation authority is detached from the exact journal lineage");
              }
              const subject = invocation.subject;
              if (subject.id !== authority.subject.component_id || subject.fingerprint !== authority.subject.fingerprint) {
                throw new Error("component invocation subject is detached from the exact WorkItem authority");
              }
            }
            const expectedStage = stagedCandidateEmission ? this.getProofComponentOnboardingStageContext(generation.nodeGenerationId) : void 0;
            if (stagedCandidateEmission && canonicalJson(invocation.onboarding_stage) !== canonicalJson(expectedStage)) throw new Error("onboarding stage context is detached from the exact journal lineage");
            const expectedReinspection = componentSelector ? this.getProofComponentReinspectionContext(generation.nodeGenerationId) : void 0;
            const actualReinspection = evidence.reinspectionContext;
            if (expectedReinspection === void 0 !== (actualReinspection === void 0) || expectedReinspection && (!actualReinspection || canonicalJson(expectedReinspection) !== canonicalJson(actualReinspection) || evidence.reinspectionContextDigest !== governedProofComponentReinspectionContextDigest(expectedReinspection))) {
              throw new Error("reinspection context is detached from the exact journal generation");
            }
            const payloadJson = governedCanonicalJson(payload, candidateWireMode2);
            if (evidence.probe.resultIdentity.resultDigest !== governedResultDigest(payload, candidateWireMode2) || evidence.probe.resultIdentity.canonicalBytes !== Buffer.byteLength(payloadJson, "utf8")) {
              throw new Error("evidence result identity is detached from candidate payload");
            }
          } catch (error) {
            if (error instanceof ClaimKernelError) throw error;
            throw new ClaimKernelError("INVALID_PROOF_EVIDENCE", `Proof candidate evidence is invalid or detached: ${error instanceof Error ? error.message : String(error)}`);
          }
        } else if (input.proofCandidateEvidence !== void 0) {
          throw new ClaimKernelError("INVALID_PROOF_EVIDENCE", "Evidence sidecars are reserved for proof candidates");
        } else if (input.wireMode !== void 0 && input.wireMode !== compiledWireMode) {
          throw new ClaimKernelError("INVALID_PROOF_EVIDENCE", "Generated claim wire mode is detached from compiled check authority");
        }
        const projectReconciliation = generation.templateNodeKey === PROOF_PROJECT_RECONCILE_NODE_KEY && generation.checkId === PROOF_PROJECT_RECONCILE_NODE_KEY && node.check.type === PROOF_PROJECT_RECONCILE_PROVIDER_TYPE && node.emissions.length === 1 && node.emissions[0].claim === PROOF_PROJECT_RECONCILIATION_RECEIPT_CLAIM;
        if (projectReconciliation) {
          if (compiledWireMode !== "proof" || input.executionConfigDigest !== generation.executionConfigDigest) {
            throw new ClaimKernelError("INVALID_PROOF_RECONCILIATION", "Project reconciliation requires its exact Proof wire and execution authority");
          }
          const projectReconciliationAuthority = this.assembleProofProjectReconciliationAuthority(generation.nodeGenerationId);
          this.validateProofProjectReconciliationReceipt(payload, projectReconciliationAuthority);
        }
        let staged = before;
        const events = [];
        const stage = (event) => {
          const stored = immutableInstanceEvent(event);
          staged = reduceInstanceEvent(staged, stored);
          events.push(stored);
        };
        for (const event of prefix) stage(event);
        const publications = [];
        const candidateWireMode = input.proofCandidateEvidence ? governedWireModeFromEvidence(input.proofCandidateEvidence) : void 0;
        for (const emission of node.emissions) {
          this.requireClaimPlan().validatorsByClaim[emission.claim](payload);
          const proofCandidateEmission = isGovernedCandidateClaim2(emission.claim);
          const wireMode = proofCandidateEmission ? candidateWireMode || "generic" : compiledWireMode;
          const immutablePayload = immutableGovernedValue(payload, wireMode);
          const payloadFingerprint = governedPayloadFingerprint(payload, wireMode);
          const parentClaimIds = projectReconciliation ? [...deriveProofProjectReconciliationParentClaimIds(before, generation)] : [...generation.activeInputClaimIds].sort();
          const eventId = Math.max(this.claimProjection.lastEventId, staged.lastEventId) + publications.length + 1;
          const published = {
            version: 1,
            type: "ClaimPublished",
            eventId,
            sessionId: attempt.sessionId,
            checkId: attempt.checkId,
            scope: attempt.scope,
            attemptId: attempt.attemptId,
            fence: attempt.fence,
            nodeInstanceId: attempt.nodeInstanceId,
            nodeGenerationId: attempt.nodeGenerationId,
            claim: emission.claim,
            payload: immutablePayload,
            payloadFingerprint,
            producerCheckId: attempt.checkId,
            parentClaimIds,
            wireMode,
            claimId: sha256Canonical({
              claim: emission.claim,
              payloadFingerprint,
              producerCheckId: attempt.checkId,
              scope: attempt.scope,
              attemptId: attempt.attemptId,
              fence: attempt.fence,
              parentClaimIds,
              ...isGovernedCandidateClaim2(emission.claim) ? { proofCandidateEvidenceFingerprint: proofCandidateEvidenceFingerprint(input.proofCandidateEvidence) } : {}
            }),
            ...isGovernedCandidateClaim2(emission.claim) ? { proofCandidateEvidence: immutableProofCandidateEvidence(input.proofCandidateEvidence), proofCandidateEvidenceFingerprint: proofCandidateEvidenceFingerprint(input.proofCandidateEvidence) } : {}
          };
          publications.push(published);
        }
        const nestedCatalogPublications = nestedExpansion ? publications.filter(
          (publication) => publication.claim === nestedExpansion.catalogClaimRef
        ) : [];
        if (nestedExpansion && nestedCatalogPublications.length !== 1) {
          throw new ClaimKernelError(
            "INVALID_NESTED_CATALOG_AUTHORITY",
            `Nested expansion owner ${nestedOwner} requires exactly one catalog publication`
          );
        }
        for (const publication of publications) stage(publication);
        if (nestedExpansion) {
          const catalogPublication = nestedCatalogPublications[0];
          const reconciled = this.reconcileCatalog({
            sessionId: attempt.sessionId,
            expansion: nestedExpansion,
            payload: catalogPublication.payload,
            catalogClaimId: catalogPublication.claimId,
            startEventId: Math.max(this.claimProjection.lastEventId, staged.lastEventId) + 1,
            projection: staged,
            parentSubgraphInstanceId: instance.subgraphInstanceId,
            expansionOwnerNodeInstanceId: generation.nodeInstanceId
          });
          events.push(...reconciled.events);
          staged = reconciled.projection;
        }
        for (const nodeKey of expansion.template.topology) {
          const candidate = expansion.template.nodesByKey[nodeKey];
          const nodeInstanceId = instance.nodeInstanceIdsByTemplateNode[nodeKey];
          if (staged.activeGenerationIdByNode[nodeInstanceId]) continue;
          const dependenciesCompleted = candidate.dependencyNodeKeys.every((dependencyNodeKey) => {
            const dependencyNodeId = instance.nodeInstanceIdsByTemplateNode[dependencyNodeKey];
            const dependencyGenerationId = staged.activeGenerationIdByNode[dependencyNodeId];
            const isCompletingGeneration = dependencyGenerationId === generation.nodeGenerationId && generation.nodeInstanceId === attempt.nodeInstanceId && generation.status === "running" && generation.scheduled && generation.attemptId === attempt.attemptId && generation.fence === attempt.fence;
            return dependencyGenerationId !== void 0 && (isCompletingGeneration || staged.generationsById[dependencyGenerationId]?.status === "completed");
          });
          if (!dependenciesCompleted) continue;
          const barrier = candidate.waitForExpansion ? this.expansionBarrierForNode(staged, instance, candidate, generation.nodeGenerationId) : void 0;
          if (barrier && !barrier.ready) continue;
          const inputIds = [];
          let ready = true;
          for (const consumption of candidate.consumptions) {
            const claims = Object.values(staged.claimsById).filter(
              (value) => value.active && value.subgraphInstanceId === instance.subgraphInstanceId && value.incarnation === instance.incarnation && value.claim === consumption.claim
            ).sort((left, right) => left.claimId.localeCompare(right.claimId));
            if (claims.length !== 1) {
              ready = false;
              break;
            }
            inputIds.push(claims[0].claimId);
          }
          if (!ready) continue;
          inputIds.sort();
          const item = instance.activeItemClaimId ? staged.claimsById[instance.activeItemClaimId] : void 0;
          if (!item?.active) {
            throw new ClaimKernelError(
              "INACTIVE_ITEM_CLAIM",
              `Instance ${instance.subgraphInstanceId} lacks an active item claim`
            );
          }
          const nodeGenerationId = deriveNodeGenerationId({
            nodeInstanceId,
            incarnation: instance.incarnation,
            itemFingerprint: item.payloadFingerprint,
            executionConfigDigest: candidate.executionConfigDigest,
            activeInputClaimIds: inputIds,
            ...barrier ? { expansionBarrierDigest: barrier.digest } : {}
          });
          const nestedCatalogClaimRef = this.requireClaimPlan().expansionPlan.byNestedOwner[qualifiedNestedExpansionOwner(expansion.template.name, nodeKey)]?.catalogClaimRef;
          stage({
            version: 1,
            type: "NodeGenerationActivated",
            eventId: Math.max(this.claimProjection.lastEventId, staged.lastEventId) + 1,
            sessionId: attempt.sessionId,
            scope: instance.scope,
            subgraphInstanceId: instance.subgraphInstanceId,
            nodeInstanceId,
            nodeGenerationId,
            templateNodeKey: nodeKey,
            checkId: nodeKey,
            incarnation: instance.incarnation,
            itemFingerprint: item.payloadFingerprint,
            executionConfigDigest: candidate.executionConfigDigest,
            activeInputClaimIds: inputIds,
            ...barrier ? { expansionBarrierDigest: barrier.digest } : {},
            ...nestedCatalogClaimRef ? { nestedExpansionCatalogClaimRef: nestedCatalogClaimRef } : {}
          });
        }
        if (instance.parentSubgraphInstanceId) {
          const parent = staged.instancesById[instance.parentSubgraphInstanceId];
          if (parent?.status === "active") {
            const parentExpansion = this.compiledExpansionForInstance(parent.subgraphInstanceId);
            const parentOwnerNodeId = instance.expansionOwnerNodeInstanceId;
            for (const parentNodeKey of parentExpansion.template.topology) {
              const parentNode = parentExpansion.template.nodesByKey[parentNodeKey];
              const wait = parentNode.waitForExpansion;
              if (!wait || !parentOwnerNodeId || parent.nodeInstanceIdsByTemplateNode[wait.owner] !== parentOwnerNodeId) continue;
              const parentNodeId = parent.nodeInstanceIdsByTemplateNode[parentNodeKey];
              if (staged.activeGenerationIdByNode[parentNodeId]) continue;
              const dependenciesCompleted = parentNode.dependencyNodeKeys.every((dependencyNodeKey) => {
                const dependencyNodeId = parent.nodeInstanceIdsByTemplateNode[dependencyNodeKey];
                const dependencyGenerationId = staged.activeGenerationIdByNode[dependencyNodeId];
                return dependencyGenerationId !== void 0 && staged.generationsById[dependencyGenerationId]?.status === "completed";
              });
              if (!dependenciesCompleted) continue;
              const barrier = this.expansionBarrierForNode(
                staged,
                parent,
                parentNode,
                generation.nodeGenerationId
              );
              if (!barrier.ready) continue;
              const inputIds = parentNode.consumptions.map((consumption) => {
                const matches = Object.values(staged.claimsById).filter((claim) => claim.active && claim.subgraphInstanceId === parent.subgraphInstanceId && claim.incarnation === parent.incarnation && claim.claim === consumption.claim).sort((left, right) => left.claimId.localeCompare(right.claimId));
                if (matches.length !== 1) return void 0;
                return matches[0].claimId;
              });
              if (inputIds.some((value) => value === void 0)) continue;
              const sortedInputIds = inputIds;
              sortedInputIds.sort();
              const item = parent.activeItemClaimId ? staged.claimsById[parent.activeItemClaimId] : void 0;
              if (!item?.active) continue;
              const nodeGenerationId = deriveNodeGenerationId({
                nodeInstanceId: parentNodeId,
                incarnation: parent.incarnation,
                itemFingerprint: item.payloadFingerprint,
                executionConfigDigest: parentNode.executionConfigDigest,
                activeInputClaimIds: sortedInputIds,
                expansionBarrierDigest: barrier.digest
              });
              stage({
                version: 1,
                type: "NodeGenerationActivated",
                eventId: Math.max(this.claimProjection.lastEventId, staged.lastEventId) + 1,
                sessionId: parent.sessionId,
                scope: parent.scope,
                subgraphInstanceId: parent.subgraphInstanceId,
                nodeInstanceId: parentNodeId,
                nodeGenerationId,
                templateNodeKey: parentNodeKey,
                checkId: parentNodeKey,
                incarnation: parent.incarnation,
                itemFingerprint: item.payloadFingerprint,
                executionConfigDigest: parentNode.executionConfigDigest,
                activeInputClaimIds: sortedInputIds,
                expansionBarrierDigest: barrier.digest
              });
            }
          }
        }
        stage({
          ...attempt,
          type: "AttemptCompleted",
          eventId: Math.max(this.claimProjection.lastEventId, staged.lastEventId) + 1
        });
        const completedProjection = reduceInstanceEventBatch(before, events);
        if (generation.templateNodeKey === PROOF_ADMIT_NODE_KEY || generation.templateNodeKey === "spec_review_admit") {
          const inspectNode = expansion.template.nodesByKey.inspect;
          if (inspectNode && inspectNode.check.type === "governed-proof-inspect" && (isGovernedProofComponentSelector(inspectNode.check.invocation) || isGovernedProofSpecReviewSelector(inspectNode.check.invocation))) {
            validateComponentAdmissionProtocol(
              completedProjection,
              instance.subgraphInstanceId,
              generation.templateNodeKey === "spec_review_admit" ? "spec_review" : "legacy",
              true,
              (nodeGenerationId) => this.getProofAdmissionRequest(nodeGenerationId)
            );
          }
        }
        return {
          events,
          projection: completedProjection
        };
      }
      failGeneratedAttempt(attempt, reason) {
        this.appendInstanceEvent({
          ...attempt,
          type: "AttemptFailed",
          reason,
          eventId: this.nextRuntimeEventId()
        });
      }
      queryReadyWork() {
        return queryReadyGenerations(this.instanceProjection);
      }
      getInstanceProjection() {
        return immutableInstanceProjection(this.instanceProjection);
      }
      getExpansionCoverageProjection(requestId) {
        const request = this.instanceProjection.requestsById[requestId];
        const expansion = request ? this.requireClaimPlan().expansionPlan?.byOwner[request.expansionOwnerCheck] : void 0;
        if (!expansion) {
          throw new ClaimKernelError("UNKNOWN_COVERAGE_REQUEST", `Unknown coverage request ${requestId}`);
        }
        return projectExpansionCoverage(this.claimProjection, this.instanceProjection, expansion, requestId);
      }
      getExpansionCoverageRequestIds(ownerCheck) {
        return Object.freeze(this.instanceProjection.requestOrder.filter(
          (requestId) => ownerCheck === void 0 || this.instanceProjection.requestsById[requestId].expansionOwnerCheck === ownerCheck
        ));
      }
      replayExpansionCoverageProjection(requestId) {
        const instanceProjection = this.replayInstanceProjection();
        const claimProjection = this.replayClaimProjection();
        const request = instanceProjection.requestsById[requestId];
        const expansion = request ? this.requireClaimPlan().expansionPlan?.byOwner[request.expansionOwnerCheck] : void 0;
        if (!expansion) {
          throw new ClaimKernelError("UNKNOWN_COVERAGE_REQUEST", `Unknown coverage request ${requestId}`);
        }
        return projectExpansionCoverage(claimProjection, instanceProjection, expansion, requestId);
      }
      replayInstanceProjection() {
        ensureReplayAuthorityEventsQuiescent(this.runtimeEvents, this.requireClaimPlan());
        const projection = replayInstanceEvents(
          this.runtimeEvents.filter(
            (event) => [
              "CatalogReconciliationRequested",
              "SubgraphExpanded",
              "ProofCurrentCatalogAuthorityRecorded",
              "ProofCurrentCatalogAuthorityApplied",
              "ControllerItemClaimPublished",
              "NodeGenerationInactivated",
              "NodeGenerationActivated",
              "SubgraphTombstoned",
              "ManagedRunAcquisitionFailed",
              "ManagedRunAcquired",
              "ManagedRunStarted",
              "ManagedRunCancelRequested",
              "ManagedRunTerminated"
            ].includes(event.type) || "nodeGenerationId" in event || "requestId" in event
          )
        );
        const replayJournal = new _ExecutionJournal(this.requireClaimPlan());
        replayJournal.runtimeEvents = [...this.runtimeEvents];
        replayJournal.claimProjection = this.claimProjection;
        replayJournal.instanceProjection = projection;
        replayJournal.validateComponentAuthorityLineage();
        return projection;
      }
      startAttempt(input) {
        const plan = this.requireClaimPlan();
        if (!Object.prototype.hasOwnProperty.call(plan.effectiveDependenciesByCheck, input.checkId)) {
          throw new ClaimKernelError("UNKNOWN_CHECK", `Unknown claim-mode check ${input.checkId}`);
        }
        const authoritativeInput = {
          sessionId: input.sessionId,
          checkId: input.checkId,
          scope: input.scope.map((part) => ({ ...part }))
        };
        const ordinalKey = canonicalJson(authoritativeInput);
        const ordinal = (this.attemptOrdinals.get(ordinalKey) || 0) + 1;
        this.attemptOrdinals.set(ordinalKey, ordinal);
        const fence = ++this.nextFence;
        const attemptId = sha256Canonical({ ...authoritativeInput, ordinal });
        return this.appendRuntimeEvent({
          version: 1,
          type: "AttemptStarted",
          eventId: this.nextRuntimeEventId(),
          ...authoritativeInput,
          attemptId,
          fence
        });
      }
      scheduleCheck(input) {
        const plan = this.requireClaimPlan();
        const claimIds = exactActiveClaimIds(plan, this.claimProjection, input.checkId);
        return this.appendRuntimeEvent({
          version: 1,
          type: "CheckScheduled",
          eventId: this.nextRuntimeEventId(),
          sessionId: input.sessionId,
          checkId: input.checkId,
          scope: input.scope.map((part) => ({ ...part })),
          attemptId: input.attemptId,
          fence: input.fence,
          claimIds: [...claimIds]
        });
      }
      reconcileCatalog(input) {
        const expansion = input.expansion;
        const nested = input.parentSubgraphInstanceId !== null;
        const parent = nested ? input.projection.instancesById[input.parentSubgraphInstanceId] : void 0;
        if (nested && (!parent || parent.status !== "active" || !input.expansionOwnerNodeInstanceId || input.projection.nodesById[input.expansionOwnerNodeInstanceId]?.subgraphInstanceId !== parent.subgraphInstanceId)) {
          throw new ClaimKernelError(
            "INVALID_NESTED_EXPANSION_OWNER",
            "Nested reconciliation requires one exact active parent and owner node"
          );
        }
        if (nested) {
          const catalog = input.projection.claimsById[input.catalogClaimId];
          const producer = catalog?.nodeGenerationId ? input.projection.generationsById[catalog.nodeGenerationId] : void 0;
          if (!catalog?.active || catalog.kind !== "generated-output" || catalog.claim !== expansion.catalogClaimRef || catalog.subgraphInstanceId !== parent.subgraphInstanceId || !producer || producer.nodeInstanceId !== input.expansionOwnerNodeInstanceId || producer.nestedExpansionCatalogClaimRef !== expansion.catalogClaimRef || producer.status !== "running" || !producer.scheduled || input.projection.activeGenerationIdByNode[producer.nodeInstanceId] !== producer.nodeGenerationId || catalog.producerAttemptId !== producer.attemptId || catalog.producerFence !== producer.fence) {
            throw new ClaimKernelError(
              "INVALID_NESTED_CATALOG_LINEAGE",
              "Nested catalog must be the exact active output of its current fenced owner generation"
            );
          }
        }
        expansion.catalogValidator(input.payload);
        const rawItems = resolveJsonPointer(input.payload, expansion.itemsPointer);
        if (!Array.isArray(rawItems)) {
          throw new ClaimKernelError(
            "INVALID_CATALOG_ITEMS",
            "Catalog items pointer must resolve to an array"
          );
        }
        const items = /* @__PURE__ */ new Map();
        for (const item of rawItems) {
          expansion.itemValidator(item);
          const key = canonicalCatalogKey(resolveJsonPointer(item, expansion.keyPointer));
          if (items.has(key)) {
            throw new ClaimKernelError("DUPLICATE_CATALOG_KEY", `Duplicate catalog key ${key}`);
          }
          items.set(key, immutableCanonicalValue(item));
        }
        let projection = input.projection;
        const events = [];
        let nextId = input.startEventId;
        const stage = (event) => {
          const stored = immutableInstanceEvent({ ...event, eventId: nextId++ });
          projection = reduceInstanceEvent(projection, stored);
          events.push(stored);
        };
        const allByKey = new Map(
          Object.values(input.projection.instancesById).filter(
            (instance) => instance.expansionOwnerCheck === expansion.expansionOwnerCheck && (instance.parentSubgraphInstanceId || null) === input.parentSubgraphInstanceId && (!nested || instance.expansionOwnerNodeInstanceId === input.expansionOwnerNodeInstanceId)
          ).map((instance) => [instance.itemKey, instance])
        );
        const active = [...allByKey.values()].filter((instance) => instance.status === "active");
        const sortedItems = [...items.entries()].sort(([left], [right]) => left.localeCompare(right));
        for (const [key] of sortedItems) {
          if (!nested && allByKey.get(key)?.status === "tombstoned") {
            throw new ClaimKernelError(
              "TOMBSTONED_KEY_READD_UNSUPPORTED",
              `Key ${key} was tombstoned`
            );
          }
        }
        const changed = sortedItems.filter(([key, item]) => {
          const instance = allByKey.get(key);
          if (!instance?.activeItemClaimId || instance.status !== "active") return false;
          return input.projection.claimsById[instance.activeItemClaimId].payloadFingerprint !== deriveItemFingerprint(item) || nested && instance.catalogClaimId !== input.catalogClaimId;
        });
        const revived = nested ? sortedItems.filter(([key]) => allByKey.get(key)?.status === "tombstoned") : [];
        const added = sortedItems.filter(([key]) => !allByKey.has(key));
        const activateSources = (instanceId, itemFingerprint) => {
          const instance = projection.instancesById[instanceId];
          for (const nodeKey of expansion.template.sourceNodeKeys) {
            const node = expansion.template.nodesByKey[nodeKey];
            const nestedCatalogClaimRef = this.requireClaimPlan().expansionPlan.byNestedOwner[qualifiedNestedExpansionOwner(expansion.template.name, nodeKey)]?.catalogClaimRef;
            const inputIds = [];
            let ready = true;
            for (const consumption of node.consumptions) {
              const matches = Object.values(projection.claimsById).filter(
                (claim) => claim.active && claim.subgraphInstanceId === instance.subgraphInstanceId && claim.incarnation === instance.incarnation && claim.claim === consumption.claim
              ).sort((left, right) => left.claimId.localeCompare(right.claimId));
              if (matches.length !== 1) {
                ready = false;
                break;
              }
              inputIds.push(matches[0].claimId);
            }
            if (!ready) continue;
            inputIds.sort();
            const nodeInstanceId = instance.nodeInstanceIdsByTemplateNode[nodeKey];
            const nodeGenerationId = deriveNodeGenerationId({
              nodeInstanceId,
              incarnation: instance.incarnation,
              itemFingerprint,
              executionConfigDigest: node.executionConfigDigest,
              activeInputClaimIds: inputIds
            });
            stage({
              version: 1,
              type: "NodeGenerationActivated",
              sessionId: input.sessionId,
              scope: instance.scope,
              subgraphInstanceId: instance.subgraphInstanceId,
              nodeInstanceId,
              nodeGenerationId,
              templateNodeKey: nodeKey,
              checkId: nodeKey,
              incarnation: instance.incarnation,
              itemFingerprint,
              executionConfigDigest: node.executionConfigDigest,
              activeInputClaimIds: inputIds,
              ...nestedCatalogClaimRef ? { nestedExpansionCatalogClaimRef: nestedCatalogClaimRef } : {}
            });
          }
        };
        const publishItemAndActivateSources = (instanceId, key, item) => {
          let instance = projection.instancesById[instanceId];
          const payloadFingerprint = deriveItemFingerprint(item);
          const incarnation = instance.incarnation + 1;
          const claimId = deriveControllerItemClaimId({
            claim: expansion.itemClaimRef,
            payloadFingerprint,
            expansionSpecDigest: expansion.expansionSpecDigest,
            catalogClaimId: input.catalogClaimId,
            subgraphInstanceId: instance.subgraphInstanceId,
            incarnation,
            scope: instance.scope
          });
          stage({
            version: 1,
            type: "ControllerItemClaimPublished",
            sessionId: input.sessionId,
            scope: instance.scope,
            expansionOwnerCheck: expansion.expansionOwnerCheck,
            expansionSpecDigest: expansion.expansionSpecDigest,
            catalogClaimId: input.catalogClaimId,
            itemKey: key,
            subgraphInstanceId: instance.subgraphInstanceId,
            incarnation,
            claimId,
            claim: expansion.itemClaimRef,
            payload: item,
            payloadFingerprint,
            parentClaimIds: [input.catalogClaimId]
          });
          instance = projection.instancesById[instanceId];
          activateSources(instance.subgraphInstanceId, payloadFingerprint);
        };
        const tombstoneTree = (instanceId, sourceCatalogClaimId) => {
          const descendants = Object.values(projection.instancesById).filter(
            (candidate) => candidate.status === "active" && candidate.parentSubgraphInstanceId === instanceId
          ).sort((left, right) => left.itemKey.localeCompare(right.itemKey));
          for (const descendant of descendants) {
            tombstoneTree(descendant.subgraphInstanceId, descendant.catalogClaimId);
          }
          const instance = projection.instancesById[instanceId];
          const generations = Object.values(projection.generationsById).filter(
            (generation) => generation.subgraphInstanceId === instance.subgraphInstanceId && generation.status !== "inactive"
          ).sort((left, right) => left.nodeGenerationId.localeCompare(right.nodeGenerationId));
          stage({
            version: 1,
            type: "SubgraphTombstoned",
            sessionId: input.sessionId,
            scope: instance.scope,
            expansionOwnerCheck: instance.expansionOwnerCheck,
            sourceCatalogClaimId,
            itemKey: instance.itemKey,
            subgraphInstanceId: instance.subgraphInstanceId,
            lastIncarnation: instance.incarnation,
            nodeGenerationIds: generations.map((value) => value.nodeGenerationId).sort(),
            outputClaimIds: generations.flatMap((value) => value.completedOutputClaimIds).sort()
          });
        };
        const tombstoneDescendants = (instanceId) => {
          const descendants = Object.values(projection.instancesById).filter(
            (candidate) => candidate.status === "active" && candidate.parentSubgraphInstanceId === instanceId
          ).sort((left, right) => left.itemKey.localeCompare(right.itemKey));
          for (const descendant of descendants) {
            tombstoneTree(descendant.subgraphInstanceId, descendant.catalogClaimId);
          }
        };
        for (const instance of active.filter((candidate) => !items.has(candidate.itemKey)).sort((left, right) => left.itemKey.localeCompare(right.itemKey))) {
          tombstoneTree(instance.subgraphInstanceId, input.catalogClaimId);
        }
        for (const [key, item] of changed) {
          let instance = projection.instancesById[allByKey.get(key).subgraphInstanceId];
          tombstoneDescendants(instance.subgraphInstanceId);
          for (const nodeKey of expansion.template.reverseTopology) {
            const nodeInstanceId = instance.nodeInstanceIdsByTemplateNode[nodeKey];
            const generationId = projection.activeGenerationIdByNode[nodeInstanceId];
            if (!generationId) continue;
            const generation = projection.generationsById[generationId];
            stage({
              version: 1,
              type: "NodeGenerationInactivated",
              sessionId: input.sessionId,
              scope: instance.scope,
              subgraphInstanceId: instance.subgraphInstanceId,
              nodeInstanceId,
              nodeGenerationId: generationId,
              incarnation: generation.incarnation,
              outputClaimIds: [...generation.completedOutputClaimIds].sort(),
              reason: "superseded"
            });
            instance = projection.instancesById[instance.subgraphInstanceId];
          }
          publishItemAndActivateSources(instance.subgraphInstanceId, key, item);
        }
        for (const [key, item] of revived) {
          const instance = projection.instancesById[allByKey.get(key).subgraphInstanceId];
          publishItemAndActivateSources(instance.subgraphInstanceId, key, item);
        }
        for (const [key, item] of added) {
          const subgraphInstanceId = nested ? deriveSubgraphInstanceId({
            graphSemanticDigest: expansion.graphSemanticDigest,
            parentSubgraphInstanceId: parent.subgraphInstanceId,
            expansionOwnerNodeInstanceId: input.expansionOwnerNodeInstanceId,
            templateDigest: expansion.templateDigest,
            itemKey: key
          }) : deriveSubgraphInstanceId({
            graphSemanticDigest: expansion.graphSemanticDigest,
            expansionOwnerCheck: expansion.expansionOwnerCheck,
            parentSubgraphInstanceId: null,
            templateDigest: expansion.templateDigest,
            itemKey: key
          });
          const scope = Object.freeze([
            ...nested ? parent.scope : [],
            {
              kind: "keyed",
              expansionOwnerCheck: expansion.expansionOwnerCheck,
              key,
              subgraphInstanceId
            }
          ]);
          stage({
            version: 1,
            type: "SubgraphExpanded",
            sessionId: input.sessionId,
            scope,
            expansionOwnerCheck: expansion.expansionOwnerCheck,
            graphSemanticDigest: expansion.graphSemanticDigest,
            expansionSpecDigest: expansion.expansionSpecDigest,
            templateDigest: expansion.templateDigest,
            parentSubgraphInstanceId: input.parentSubgraphInstanceId,
            ...nested ? {
              expansionOwnerNodeInstanceId: input.expansionOwnerNodeInstanceId,
              catalogClaimRef: expansion.catalogClaimRef
            } : {},
            catalogClaimId: input.catalogClaimId,
            itemKey: key,
            subgraphInstanceId,
            nodeInstanceIdsByTemplateNode: Object.fromEntries(
              expansion.template.templateNodeKeys.map((nodeKey) => [
                nodeKey,
                deriveNodeInstanceId({ subgraphInstanceId, templateNodeKey: nodeKey })
              ])
            )
          });
          publishItemAndActivateSources(subgraphInstanceId, key, item);
        }
        return { events, projection };
      }
      completeAttempt(input) {
        const plan = this.requireClaimPlan();
        const scheduled = this.claimProjection.scheduled.find(
          (event) => event.sessionId === input.sessionId && event.checkId === input.checkId && event.attemptId === input.attemptId && event.fence === input.fence && canonicalJson(event.scope) === canonicalJson(input.scope)
        );
        if (!scheduled) {
          throw new ClaimKernelError(
            "ATTEMPT_NOT_SCHEDULED",
            `Attempt ${input.attemptId} was not scheduled before terminal processing`
          );
        }
        let stagedProjection = this.claimProjection;
        const stagedEvents = [];
        const claimIds = [];
        for (const emission of plan.emissionsByCheck[input.checkId] || []) {
          const built = buildClaimPublishedEvent({
            eventId: Math.max(stagedProjection.lastEventId, this.instanceProjection.lastEventId, ...stagedEvents.map((event2) => event2.eventId)) + 1,
            sessionId: input.sessionId,
            checkId: input.checkId,
            scope: input.scope,
            attemptId: input.attemptId,
            fence: input.fence,
            claim: emission.claim,
            payload: input.payload,
            parentClaimIds: scheduled.claimIds,
            projection: stagedProjection,
            plan
          });
          const event = immutableRuntimeEvent(built);
          stagedProjection = reduceClaimEvent(stagedProjection, event, plan);
          stagedEvents.push(event);
          claimIds.push(event.claimId);
        }
        const rootExpansion = plan.expansionPlan?.byOwner[input.checkId];
        const catalogClaimId = claimIds.find(
          (id) => stagedProjection.claims[id]?.claim === rootExpansion?.catalogClaimRef
        );
        const reconciled = catalogClaimId && rootExpansion ? this.reconcileCatalog({
          sessionId: input.sessionId,
          expansion: rootExpansion,
          payload: input.payload,
          catalogClaimId,
          startEventId: Math.max(stagedProjection.lastEventId, this.instanceProjection.lastEventId) + 1,
          projection: this.instanceProjection,
          parentSubgraphInstanceId: null
        }) : { events: [], projection: this.instanceProjection };
        const requestId = this.instanceProjection.attemptBindingsById[input.attemptId];
        if (requestId && !catalogClaimId) {
          throw new ClaimKernelError(
            "INVALID_REQUEST_CATALOG",
            `Catalog request ${requestId} did not publish its configured catalog claim`
          );
        }
        const completed = immutableRuntimeEvent({
          version: 1,
          type: "AttemptCompleted",
          eventId: Math.max(stagedProjection.lastEventId, reconciled.projection.lastEventId) + 1,
          sessionId: input.sessionId,
          checkId: input.checkId,
          scope: input.scope.map((part) => ({ ...part })),
          attemptId: input.attemptId,
          fence: input.fence,
          ...requestId ? { requestId, catalogClaimId } : {}
        });
        stagedProjection = reduceClaimEvent(stagedProjection, completed, plan);
        stagedEvents.push(completed);
        const finalInstanceProjection = requestId ? reduceInstanceEvent(reconciled.projection, completed) : reconciled.projection;
        this.runtimeEvents.push(...stagedEvents.slice(0, -1), ...reconciled.events, completed);
        this.claimProjection = stagedProjection;
        this.instanceProjection = finalInstanceProjection;
        return Object.freeze({
          claims: Object.freeze(claimIds.map((claimId) => stagedProjection.claims[claimId])),
          completed
        });
      }
      failAttempt(input) {
        const requestId = this.instanceProjection.attemptBindingsById[input.attemptId];
        const event = immutableRuntimeEvent({
          sessionId: input.sessionId,
          checkId: input.checkId,
          attemptId: input.attemptId,
          fence: input.fence,
          reason: input.reason,
          version: 1,
          type: "AttemptFailed",
          eventId: this.nextRuntimeEventId(),
          scope: input.scope.map((part) => ({ ...part })),
          ...requestId ? { requestId } : {}
        });
        const claim = reduceClaimEvent(this.claimProjection, event, this.requireClaimPlan());
        const instance = requestId ? reduceInstanceEvent(this.instanceProjection, event) : this.instanceProjection;
        this.runtimeEvents.push(event);
        this.claimProjection = claim;
        this.instanceProjection = instance;
        return event;
      }
      readRuntimeEvents() {
        const proofApplicationClaimIds = /* @__PURE__ */ new Set();
        for (let index = 0; index < this.runtimeEvents.length; index++) {
          const marker = this.runtimeEvents[index];
          if (marker.type !== "ProofCurrentCatalogAuthorityApplied") continue;
          for (const event of this.runtimeEvents.slice(index + 1, index + marker.mutationEventCount + 1)) {
            if (event.type === "ControllerItemClaimPublished" && event.claim === "component.work_item@1") {
              proofApplicationClaimIds.add(event.claimId);
            }
          }
          index += marker.mutationEventCount;
        }
        return Object.freeze(this.runtimeEvents.map(
          (event) => event.type === "ClaimPublished" && "nodeGenerationId" in event ? immutableInstanceEvent(event) : proofApplicationClaimIds.has("claimId" in event ? event.claimId : "") ? immutableProofApplicationEvent(event) : immutableCanonicalValue(event)
        ));
      }
      getClaimProjection() {
        return immutableCanonicalValue(this.claimProjection);
      }
      replayClaimProjection() {
        return replayClaimEvents(
          this.readRuntimeEvents().filter(
            (event) => ["AttemptStarted", "ClaimPublished", "CheckScheduled", "AttemptCompleted", "AttemptFailed"].includes(event.type) && !("nodeGenerationId" in event)
          ),
          this.requireClaimPlan()
        );
      }
      isCheckReady(checkId) {
        try {
          exactActiveClaimIds(this.requireClaimPlan(), this.claimProjection, checkId);
          return true;
        } catch (error) {
          if (error instanceof ClaimKernelError && error.code === "CLAIM_NOT_READY") return false;
          throw error;
        }
      }
      readCheckClaims(checkId) {
        const plan = this.requireClaimPlan();
        const claimIds = exactActiveClaimIds(plan, this.claimProjection, checkId);
        const selected = {};
        for (const [index, consumption] of (plan.consumptionsByCheck[checkId] || []).entries()) {
          const claimId = claimIds[index];
          const claim = this.claimProjection.claims[claimId];
          if (claim) selected[consumption.claim] = claim;
        }
        return Object.freeze(selected);
      }
      // Lightweight helpers for debugging/metrics
      size() {
        return this.entries.length;
      }
    };
    ContextView = class {
      constructor(journal, sessionId, snapshotId, scope, event) {
        this.journal = journal;
        this.sessionId = sessionId;
        this.snapshotId = snapshotId;
        this.scope = scope;
        this.event = event;
      }
      journal;
      sessionId;
      snapshotId;
      scope;
      event;
      /** Return the nearest result for a check in this scope (exact item → ancestor → latest). */
      get(checkId) {
        const visible = this.journal.readVisible(this.sessionId, this.snapshotId, this.event).filter((e) => e.checkId === checkId);
        if (visible.length === 0) return void 0;
        const exactMatches = visible.filter((e) => this.sameScope(e.scope, this.scope));
        if (exactMatches.length > 0) {
          return exactMatches[exactMatches.length - 1].result;
        }
        let best;
        for (const e of visible) {
          const dist = this.ancestorDistance(e.scope, this.scope);
          if (dist >= 0 && (best === void 0 || dist < best.dist)) {
            best = { entry: e, dist };
          }
        }
        if (best) return best.entry.result;
        return visible[visible.length - 1]?.result;
      }
      /** Return an aggregate (raw) result – the shallowest scope for this check. */
      getRaw(checkId) {
        const visible = this.journal.readVisible(this.sessionId, this.snapshotId, this.event).filter((e) => e.checkId === checkId);
        if (visible.length === 0) return void 0;
        let shallow = visible[0];
        for (const e of visible) {
          if (e.scope.length < shallow.scope.length) shallow = e;
        }
        return shallow.result;
      }
      /** All results for a check up to this snapshot. */
      getHistory(checkId) {
        return this.journal.readVisible(this.sessionId, this.snapshotId, this.event).filter((e) => e.checkId === checkId).map((e) => e.result);
      }
      sameScope(a, b) {
        return canonicalJson(a) === canonicalJson(b);
      }
      // distance from ancestor to current; -1 if not ancestor
      ancestorDistance(ancestor, current) {
        if ([...ancestor, ...current].some((segment) => segment.kind === "keyed")) {
          return this.sameScope(ancestor, current) ? 0 : -1;
        }
        if (ancestor.length > current.length) return -1;
        if (ancestor.length === 0 && current.length > 0) return -1;
        for (let i = 0; i < ancestor.length; i++) {
          if (ancestor[i].check !== current[i].check || ancestor[i].index !== current[i].index)
            return -1;
        }
        return current.length - ancestor.length;
      }
    };
  }
});

// src/state-machine/states/routing.ts
async function renderRouteArgs(args, output, dependencyResults, context) {
  if (!args || Object.keys(args).length === 0) {
    return args;
  }
  const liquid = createExtendedLiquid();
  const renderedArgs = {};
  const templateContext = {
    output,
    // Output of the step that triggered routing
    outputs: dependencyResults,
    // All dependency outputs
    env: process.env,
    inputs: context.executionContext?.workflowInputs || {}
  };
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string" && value.includes("{{")) {
      try {
        renderedArgs[key] = await liquid.parseAndRender(value, templateContext);
      } catch (error) {
        logger.warn(`[Routing] Failed to render template for arg ${key}: ${error}`);
        renderedArgs[key] = value;
      }
    } else {
      renderedArgs[key] = value;
    }
  }
  return renderedArgs;
}
function parseRunItem(item) {
  if (typeof item === "string") {
    return { target: item };
  }
  if ("step" in item) {
    const stepItem = item;
    return { target: stepItem.step, args: stepItem.with };
  }
  if ("workflow" in item) {
    const workflowItem = item;
    return { target: workflowItem.workflow, args: workflowItem.with };
  }
  return { target: String(item) };
}
function hasMapFanoutDependents(context, checkId) {
  const checks = context.config.checks || {};
  const reduceProviders = /* @__PURE__ */ new Set(["log", "memory", "script", "workflow", "noop"]);
  for (const [cid, cfg] of Object.entries(checks)) {
    if (cid === checkId) continue;
    const rawDeps = cfg.depends_on || [];
    const depList = Array.isArray(rawDeps) ? rawDeps : [rawDeps];
    let depends = false;
    for (const dep of depList) {
      if (typeof dep !== "string") continue;
      if (dep.includes("|")) {
        const opts = dep.split("|").map((s) => s.trim()).filter(Boolean);
        if (opts.includes(checkId)) {
          depends = true;
          break;
        }
      } else if (dep === checkId) {
        depends = true;
        break;
      }
    }
    if (!depends) continue;
    const explicit = cfg.fanout;
    if (explicit === "map") return true;
    if (explicit === "reduce") continue;
    const providerType = context.checks[cid]?.providerType || checks[cid]?.type || "";
    const inferred = reduceProviders.has(providerType) ? "reduce" : "map";
    if (inferred === "map") return true;
  }
  return false;
}
function classifyFailure(result) {
  const issues = result?.issues || [];
  if (!issues || issues.length === 0) return "none";
  let hasLogical = false;
  let hasExecution = false;
  for (const iss of issues) {
    const id = String(iss.ruleId || "");
    const msg = String(iss.message || "");
    const msgLower = msg.toLowerCase();
    if (id.endsWith("_fail_if") || id.includes("contract/guarantee_failed") || id.includes("contract/schema_validation_failed"))
      hasLogical = true;
    if (id.endsWith("/error") || id.includes("/execution_error") || id.includes("timeout") || msgLower.includes("timed out") || msg.includes("Command execution failed"))
      hasExecution = true;
    if (id.includes("forEach/execution_error") || msg.includes("sandbox_runner_error"))
      hasExecution = true;
  }
  if (hasLogical && !hasExecution) return "logical";
  if (hasExecution && !hasLogical) return "execution";
  return hasExecution ? "execution" : "logical";
}
function getCriticality(context, checkId) {
  const cfg = context.config.checks?.[checkId];
  return cfg && cfg.criticality || "policy";
}
function createMemoryHelpers() {
  const memoryStore = MemoryStore.getInstance();
  return {
    get: (key, ns) => memoryStore.get(key, ns),
    has: (key, ns) => memoryStore.has(key, ns),
    getAll: (ns) => memoryStore.getAll(ns),
    set: (key, value, ns) => {
      const nsName = ns || memoryStore.getDefaultNamespace();
      const data = memoryStore["data"];
      if (!data.has(nsName)) data.set(nsName, /* @__PURE__ */ new Map());
      data.get(nsName).set(key, value);
    },
    clear: (ns) => {
      const data = memoryStore["data"];
      if (ns) data.delete(ns);
      else data.clear();
    },
    increment: (key, amount = 1, ns) => {
      const nsName = ns || memoryStore.getDefaultNamespace();
      const data = memoryStore["data"];
      if (!data.has(nsName)) data.set(nsName, /* @__PURE__ */ new Map());
      const nsMap = data.get(nsName);
      const current = nsMap.get(key);
      const numCurrent = typeof current === "number" ? current : 0;
      const newValue = numCurrent + amount;
      nsMap.set(key, newValue);
      return newValue;
    }
  };
}
function getHistoryLimit() {
  const raw = process.env.VISOR_TEST_HISTORY_LIMIT || process.env.VISOR_OUTPUT_HISTORY_LIMIT;
  if (!raw) return void 0;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : void 0;
}
async function evaluateManagedRouting(context, state, routingContext) {
  const { checkId, result, checkConfig } = routingContext;
  const decision = await evaluateFailIf(
    checkId,
    result,
    checkConfig,
    context,
    state,
    routingContext.exactPreviousResults
  );
  if (decision.haltExecution) {
    const haltIssue = {
      file: "system",
      line: 0,
      ruleId: `${checkId}_halt_execution`,
      message: `Execution halted: ${decision.haltMessage || "Critical failure condition met"}`,
      severity: "error",
      category: "logic"
    };
    result.issues = [...result.issues || [], haltIssue];
  }
  return Object.freeze({
    failed: decision.failed,
    haltExecution: decision.haltExecution,
    ...decision.haltMessage ? { haltMessage: decision.haltMessage } : {}
  });
}
function applyManagedRoutingEffects(checkId, decision, transition, emitEvent) {
  if (!decision.haltExecution) return false;
  logger.error(
    `[Routing] HALTING EXECUTION due to critical failure in ${checkId}: ${decision.haltMessage}`
  );
  emitEvent({
    type: "Shutdown",
    error: {
      message: decision.haltMessage || `Execution halted by check ${checkId}`,
      name: "HaltExecution"
    }
  });
  transition("Error");
  return true;
}
function formatScopeLabel(scope) {
  if (!scope || scope.length === 0) return "";
  return scope.map((item) => `${item.check}:${item.index}`).join("|");
}
function recordRoutingEvent(args) {
  const attrs = {
    check_id: args.checkId,
    trigger: args.trigger,
    action: args.action
  };
  if (args.target) attrs.target = args.target;
  if (args.source) attrs.source = args.source;
  const scopeLabel = formatScopeLabel(args.scope);
  if (scopeLabel) attrs.scope = scopeLabel;
  if (args.gotoEvent) attrs.goto_event = args.gotoEvent;
  addEvent("visor.routing", attrs);
}
async function handleRouting(context, state, transition, emitEvent, routingContext) {
  const { checkId, scope, result, checkConfig, success } = routingContext;
  logger.info(`[Routing] Evaluating routing for check: ${checkId}, success: ${success}`);
  const failureResult = await evaluateFailIf(
    checkId,
    result,
    checkConfig,
    context,
    state,
    routingContext.exactPreviousResults
  );
  if (failureResult.haltExecution) {
    logger.error(
      `[Routing] HALTING EXECUTION due to critical failure in ${checkId}: ${failureResult.haltMessage}`
    );
    const haltIssue = {
      file: "system",
      line: 0,
      ruleId: `${checkId}_halt_execution`,
      message: `Execution halted: ${failureResult.haltMessage || "Critical failure condition met"}`,
      severity: "error",
      category: "logic"
    };
    result.issues = [...result.issues || [], haltIssue];
    emitEvent({
      type: "Shutdown",
      error: {
        message: failureResult.haltMessage || `Execution halted by check ${checkId}`,
        name: "HaltExecution"
      }
    });
    transition("Error");
    return true;
  }
  if (failureResult.failed) {
    if (context.debug) {
      logger.info(`[Routing] fail_if/failure_conditions triggered for ${checkId}`);
    }
    await processOnFail(checkId, scope, result, checkConfig, context, state, emitEvent);
  } else if (success) {
    await processOnSuccess(checkId, scope, result, checkConfig, context, state, emitEvent);
  } else {
    await processOnFail(checkId, scope, result, checkConfig, context, state, emitEvent);
  }
  const shouldProcessOnFinishHere = !!checkConfig.on_finish && (checkConfig.forEach !== true || !hasMapFanoutDependents(context, checkId));
  if (checkConfig.on_finish) {
    logger.info(
      `[Routing] on_finish decision for ${checkId}: forEach=${!!checkConfig.forEach}, processHere=${shouldProcessOnFinishHere}`
    );
  }
  if (shouldProcessOnFinishHere) {
    await processOnFinish(checkId, scope, result, checkConfig, context, state, emitEvent);
  }
  transition("WavePlanning");
  return false;
}
async function processOnFinish(checkId, scope, result, checkConfig, context, state, emitEvent) {
  const onFinish = checkConfig.on_finish;
  if (!onFinish) {
    return;
  }
  logger.info(`Processing on_finish for ${checkId}`);
  let queuedForward = false;
  if (onFinish.run && onFinish.run.length > 0) {
    const currentCheckIsForEach = checkConfig.forEach === true;
    const forEachItems = currentCheckIsForEach ? result.forEachItems : void 0;
    const hasForEachItems = Array.isArray(forEachItems) && forEachItems.length > 0;
    for (const targetCheck of onFinish.run) {
      if (checkLoopBudget(context, state, "on_finish", "run")) {
        const errorIssue = {
          file: "system",
          line: 0,
          ruleId: `${checkId}/routing/loop_budget_exceeded`,
          message: `Routing loop budget exceeded (max_loops=${context.config.routing?.max_loops ?? DEFAULT_MAX_LOOPS}) during on_finish run`,
          severity: "error",
          category: "logic"
        };
        result.issues = [...result.issues || [], errorIssue];
        return;
      }
      const targetConfig = context.config.checks?.[targetCheck];
      const fanoutMode = targetConfig?.fanout || "reduce";
      if (context.debug) {
        logger.info(
          `[Routing] on_finish.run: scheduling ${targetCheck} with fanout=${fanoutMode}, hasForEachItems=${hasForEachItems}`
        );
      }
      if (fanoutMode === "map" && hasForEachItems) {
        for (let itemIndex = 0; itemIndex < forEachItems.length; itemIndex++) {
          state.routingLoopCount++;
          const itemScope = [
            { check: checkId, index: itemIndex }
          ];
          recordRoutingEvent({
            checkId,
            trigger: "on_finish",
            action: "run",
            target: targetCheck,
            source: "run",
            scope: itemScope
          });
          emitEvent({
            type: "ForwardRunRequested",
            target: targetCheck,
            scope: itemScope,
            origin: "run"
          });
          queuedForward = true;
        }
      } else {
        state.routingLoopCount++;
        recordRoutingEvent({
          checkId,
          trigger: "on_finish",
          action: "run",
          target: targetCheck,
          source: "run",
          scope: []
        });
        emitEvent({
          type: "ForwardRunRequested",
          target: targetCheck,
          scope: [],
          origin: "run"
        });
        queuedForward = true;
      }
    }
  }
  if (onFinish.run_js) {
    const dynamicTargets = await evaluateRunJs(
      onFinish.run_js,
      checkId,
      checkConfig,
      result,
      context,
      state
    );
    for (const runItem of dynamicTargets) {
      const { target: targetCheck, args: runArgs } = parseRunItem(runItem);
      if (checkLoopBudget(context, state, "on_finish", "run")) {
        const errorIssue = {
          file: "system",
          line: 0,
          ruleId: `${checkId}/routing/loop_budget_exceeded`,
          message: `Routing loop budget exceeded (max_loops=${context.config.routing?.max_loops ?? DEFAULT_MAX_LOOPS}) during on_finish run`,
          severity: "error",
          category: "logic"
        };
        result.issues = [...result.issues || [], errorIssue];
        return;
      }
      if (context.debug) {
        logger.info(
          `[Routing] on_finish.run_js: scheduling ${targetCheck}${runArgs ? ", args=" + JSON.stringify(runArgs) : ""}`
        );
      }
      state.routingLoopCount++;
      recordRoutingEvent({
        checkId,
        trigger: "on_finish",
        action: "run",
        target: targetCheck,
        source: "run_js",
        scope
      });
      emitEvent({
        type: "ForwardRunRequested",
        target: targetCheck,
        scope,
        origin: "run_js",
        args: runArgs
      });
      queuedForward = true;
    }
  }
  const finishTransTarget = await evaluateTransitions(
    onFinish.transitions,
    checkId,
    checkConfig,
    result,
    context,
    state
  );
  if (finishTransTarget !== void 0) {
    if (finishTransTarget) {
      if (checkLoopBudget(context, state, "on_finish", "goto")) {
        const errorIssue = {
          file: "system",
          line: 0,
          ruleId: `${checkId}/routing/loop_budget_exceeded`,
          message: `Routing loop budget exceeded (max_loops=${context.config.routing?.max_loops ?? DEFAULT_MAX_LOOPS}) during on_finish goto`,
          severity: "error",
          category: "logic"
        };
        result.issues = [...result.issues || [], errorIssue];
        return;
      }
      state.routingLoopCount++;
      recordRoutingEvent({
        checkId,
        trigger: "on_finish",
        action: "goto",
        target: finishTransTarget.to,
        source: "transitions",
        scope,
        gotoEvent: finishTransTarget.goto_event
      });
      emitEvent({
        type: "ForwardRunRequested",
        target: finishTransTarget.to,
        scope,
        origin: "goto_js",
        gotoEvent: finishTransTarget.goto_event
      });
    }
    return;
  }
  const gotoTarget = await evaluateGoto(
    onFinish.goto_js,
    onFinish.goto,
    checkId,
    checkConfig,
    result,
    context,
    state
  );
  if (gotoTarget) {
    if (checkLoopBudget(context, state, "on_finish", "goto")) {
      const errorIssue = {
        file: "system",
        line: 0,
        ruleId: `${checkId}/routing/loop_budget_exceeded`,
        message: `Routing loop budget exceeded (max_loops=${context.config.routing?.max_loops ?? DEFAULT_MAX_LOOPS}) during on_finish goto`,
        severity: "error",
        category: "logic"
      };
      result.issues = [...result.issues || [], errorIssue];
      return;
    }
    if (context.debug) {
      logger.info(`[Routing] on_finish.goto: ${gotoTarget}`);
    }
    state.routingLoopCount++;
    recordRoutingEvent({
      checkId,
      trigger: "on_finish",
      action: "goto",
      target: gotoTarget,
      source: onFinish.goto_js ? "goto_js" : "goto",
      scope
    });
    emitEvent({
      type: "ForwardRunRequested",
      target: gotoTarget,
      scope,
      origin: "goto_js"
    });
    state.flags.forwardRunRequested = true;
  }
  if (queuedForward) {
    const guardKey = `waveRetry:on_finish:${checkId}:wave:${state.wave}`;
    if (!state.forwardRunGuards?.has(guardKey)) {
      state.forwardRunGuards?.add(guardKey);
      emitEvent({ type: "WaveRetry", reason: "on_finish" });
    }
  }
}
async function evaluateFailIf(checkId, result, checkConfig, context, state, exactPreviousResults) {
  const config = context.config;
  const globalFailIf = config.fail_if;
  const checkFailIf = checkConfig.fail_if;
  const globalFailureConditions = config.failure_conditions;
  const checkFailureConditions = checkConfig.failure_conditions;
  if (!globalFailIf && !checkFailIf && !globalFailureConditions && !checkFailureConditions) {
    return { failed: false, haltExecution: false };
  }
  const evaluator = new FailureConditionEvaluator();
  const outputsRecord = {};
  if (exactPreviousResults) {
    for (const [key, value] of exactPreviousResults) outputsRecord[key] = value;
  } else {
    for (const [key] of state.stats.entries()) {
      try {
        const snapshotId = context.journal.beginSnapshot();
        const contextView = new (init_snapshot_store(), __toCommonJS(snapshot_store_exports)).ContextView(
          context.journal,
          context.sessionId,
          snapshotId,
          [],
          context.event
        );
        const journalResult = contextView.get(key);
        if (journalResult) {
          outputsRecord[key] = journalResult;
        }
      } catch {
        outputsRecord[key] = { issues: [] };
      }
    }
  }
  const checkSchema = typeof checkConfig.schema === "object" ? "custom" : checkConfig.schema || "";
  const checkGroup = checkConfig.group || "";
  let anyFailed = false;
  let shouldHalt = false;
  let haltMessage;
  if (globalFailIf) {
    try {
      const failed = await evaluator.evaluateSimpleCondition(
        checkId,
        checkSchema,
        checkGroup,
        result,
        globalFailIf,
        outputsRecord
      );
      if (failed) {
        logger.warn(`[Routing] Global fail_if triggered for ${checkId}: ${globalFailIf}`);
        const failIssue = {
          file: "system",
          line: 0,
          ruleId: "global_fail_if",
          message: `Global failure condition met: ${globalFailIf}`,
          severity: "error",
          category: "logic"
        };
        result.issues = [...result.issues || [], failIssue];
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Routing] Error evaluating global fail_if: ${msg}`);
    }
  }
  if (checkFailIf) {
    try {
      const failed = await evaluator.evaluateSimpleCondition(
        checkId,
        checkSchema,
        checkGroup,
        result,
        checkFailIf,
        outputsRecord
      );
      if (failed) {
        logger.warn(`[Routing] Check fail_if triggered for ${checkId}: ${checkFailIf}`);
        const failIssue = {
          file: "system",
          line: 0,
          ruleId: `${checkId}_fail_if`,
          message: `Check failure condition met: ${checkFailIf}`,
          severity: "error",
          category: "logic"
        };
        result.issues = [...result.issues || [], failIssue];
        anyFailed = true;
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Routing] Error evaluating check fail_if: ${msg}`);
    }
  }
  if (globalFailureConditions || checkFailureConditions) {
    try {
      const conditionResults = await evaluator.evaluateConditions(
        checkId,
        checkSchema,
        checkGroup,
        result,
        globalFailureConditions,
        checkFailureConditions,
        outputsRecord
      );
      for (const condResult of conditionResults) {
        if (condResult.failed) {
          logger.warn(
            `[Routing] Failure condition '${condResult.conditionName}' triggered for ${checkId}: ${condResult.expression}`
          );
          const failIssue = {
            file: "system",
            line: 0,
            ruleId: `${checkId}_${condResult.conditionName}`,
            message: condResult.message || `Failure condition met: ${condResult.expression}`,
            severity: condResult.severity || "error",
            category: "logic"
          };
          result.issues = [...result.issues || [], failIssue];
          anyFailed = true;
          if (condResult.haltExecution) {
            shouldHalt = true;
            haltMessage = condResult.message || `Execution halted: condition '${condResult.conditionName}' triggered`;
            logger.error(
              `[Routing] HALT EXECUTION triggered by '${condResult.conditionName}' for ${checkId}`
            );
          }
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Routing] Error evaluating failure_conditions: ${msg}`);
    }
  }
  return { failed: anyFailed, haltExecution: shouldHalt, haltMessage };
}
function checkLoopBudget(context, state, origin, action) {
  const maxLoops = context.config.routing?.max_loops ?? DEFAULT_MAX_LOOPS;
  if (state.routingLoopCount >= maxLoops) {
    const msg = `Routing loop budget exceeded (max_loops=${maxLoops}) during ${origin} ${action}`;
    logger.error(`[Routing] ${msg}`);
    return true;
  }
  return false;
}
async function processOnSuccess(checkId, scope, result, checkConfig, context, state, emitEvent) {
  const onSuccess = checkConfig.on_success;
  if (!onSuccess) {
    return;
  }
  if (context.debug) {
    logger.info(`[Routing] Processing on_success for ${checkId}`);
  }
  if (onSuccess.run && onSuccess.run.length > 0) {
    const resForEachItems = result && result.forEachItems || void 0;
    const hasForEachItems = Array.isArray(resForEachItems) && resForEachItems.length > 0;
    const stepOutput = result?.output;
    const depResults = {};
    try {
      const snapshotId = context.journal.beginSnapshot();
      const allEntries = context.journal.readVisible(context.sessionId, snapshotId, context.event);
      for (const entry of allEntries) {
        if (entry.checkId && entry.result) {
          const r = entry.result;
          depResults[entry.checkId] = r.output !== void 0 ? r.output : r;
        }
      }
    } catch (e) {
      logger.warn(`[Routing] Failed to build dependency results for template rendering: ${e}`);
    }
    for (const runItem of onSuccess.run) {
      const { target: targetCheck, args: rawArgs } = parseRunItem(runItem);
      const runArgs = rawArgs ? await renderRouteArgs(rawArgs, stepOutput, depResults, context) : void 0;
      if (checkLoopBudget(context, state, "on_success", "run")) {
        const errorIssue = {
          file: "system",
          line: 0,
          ruleId: `${checkId}/routing/loop_budget_exceeded`,
          message: `Routing loop budget exceeded (max_loops=${context.config.routing?.max_loops ?? DEFAULT_MAX_LOOPS}) during on_success run`,
          severity: "error",
          category: "logic"
        };
        result.issues = [...result.issues || [], errorIssue];
        return;
      }
      const targetConfig = context.config.checks?.[targetCheck];
      const fanoutMode = targetConfig?.fanout || "reduce";
      if (context.debug) {
        logger.info(
          `[Routing] on_success.run: scheduling ${targetCheck} with fanout=${fanoutMode}, hasForEachItems=${hasForEachItems}${runArgs ? ", args=" + JSON.stringify(runArgs) : ""}`
        );
      }
      if (fanoutMode === "map" && hasForEachItems) {
        for (let itemIndex = 0; itemIndex < resForEachItems.length; itemIndex++) {
          state.routingLoopCount++;
          const itemScope = [
            { check: checkId, index: itemIndex }
          ];
          recordRoutingEvent({
            checkId,
            trigger: "on_success",
            action: "run",
            target: targetCheck,
            source: "run",
            scope: itemScope
          });
          emitEvent({
            type: "ForwardRunRequested",
            target: targetCheck,
            scope: itemScope,
            origin: "run",
            args: runArgs
          });
        }
      } else {
        state.routingLoopCount++;
        recordRoutingEvent({
          checkId,
          trigger: "on_success",
          action: "run",
          target: targetCheck,
          source: "run",
          scope
        });
        emitEvent({
          type: "ForwardRunRequested",
          target: targetCheck,
          scope,
          origin: "run",
          args: runArgs
        });
      }
    }
  }
  if (onSuccess.run_js) {
    const dynamicTargets = await evaluateRunJs(
      onSuccess.run_js,
      checkId,
      checkConfig,
      result,
      context,
      state
    );
    for (const runItem of dynamicTargets) {
      const { target: targetCheck, args: runArgs } = parseRunItem(runItem);
      if (checkLoopBudget(context, state, "on_success", "run")) {
        const errorIssue = {
          file: "system",
          line: 0,
          ruleId: `${checkId}/routing/loop_budget_exceeded`,
          message: `Routing loop budget exceeded (max_loops=${context.config.routing?.max_loops ?? 10}) during on_success run`,
          severity: "error",
          category: "logic"
        };
        result.issues = [...result.issues || [], errorIssue];
        return;
      }
      if (context.debug) {
        logger.info(
          `[Routing] on_success.run_js: scheduling ${targetCheck}${runArgs ? ", args=" + JSON.stringify(runArgs) : ""}`
        );
      }
      state.routingLoopCount++;
      recordRoutingEvent({
        checkId,
        trigger: "on_success",
        action: "run",
        target: targetCheck,
        source: "run_js",
        scope
      });
      emitEvent({
        type: "ForwardRunRequested",
        target: targetCheck,
        scope,
        origin: "run_js",
        args: runArgs
      });
    }
  }
  const successTransTarget = await evaluateTransitions(
    onSuccess.transitions,
    checkId,
    checkConfig,
    result,
    context,
    state
  );
  if (successTransTarget !== void 0) {
    if (successTransTarget) {
      if (checkLoopBudget(context, state, "on_success", "goto")) {
        const errorIssue = {
          file: "system",
          line: 0,
          ruleId: `${checkId}/routing/loop_budget_exceeded`,
          message: `Routing loop budget exceeded (max_loops=${context.config.routing?.max_loops ?? DEFAULT_MAX_LOOPS}) during on_success goto`,
          severity: "error",
          category: "logic"
        };
        result.issues = [...result.issues || [], errorIssue];
        return;
      }
      state.routingLoopCount++;
      recordRoutingEvent({
        checkId,
        trigger: "on_success",
        action: "goto",
        target: successTransTarget.to,
        source: "transitions",
        scope,
        gotoEvent: successTransTarget.goto_event
      });
      emitEvent({
        type: "ForwardRunRequested",
        target: successTransTarget.to,
        scope,
        origin: "goto_js",
        gotoEvent: successTransTarget.goto_event
      });
      state.flags.forwardRunRequested = true;
    }
    return;
  }
  const gotoTarget = await evaluateGoto(
    onSuccess.goto_js,
    onSuccess.goto,
    checkId,
    checkConfig,
    result,
    context,
    state
  );
  if (gotoTarget) {
    if (checkLoopBudget(context, state, "on_success", "goto")) {
      const errorIssue = {
        file: "system",
        line: 0,
        ruleId: `${checkId}/routing/loop_budget_exceeded`,
        message: `Routing loop budget exceeded (max_loops=${context.config.routing?.max_loops ?? 10}) during on_success goto`,
        severity: "error",
        category: "logic"
      };
      result.issues = [...result.issues || [], errorIssue];
      return;
    }
    if (context.debug) {
      logger.info(`[Routing] on_success.goto: ${gotoTarget}`);
    }
    state.routingLoopCount++;
    recordRoutingEvent({
      checkId,
      trigger: "on_success",
      action: "goto",
      target: gotoTarget,
      source: onSuccess.goto_js ? "goto_js" : "goto",
      scope,
      gotoEvent: onSuccess.goto_event
    });
    emitEvent({
      type: "ForwardRunRequested",
      target: gotoTarget,
      gotoEvent: onSuccess.goto_event,
      scope,
      origin: "goto_js"
    });
    state.flags.forwardRunRequested = true;
  }
}
async function processOnFail(checkId, scope, result, checkConfig, context, state, emitEvent) {
  const defaults = context.config.routing?.defaults?.on_fail || {};
  const onFail = checkConfig.on_fail ? { ...defaults, ...checkConfig.on_fail } : void 0;
  if (!onFail) {
    return;
  }
  if (context.debug) {
    logger.info(`[Routing] Processing on_fail for ${checkId}`);
  }
  if (onFail.run && onFail.run.length > 0) {
    const resForEachItems = result && result.forEachItems || void 0;
    const hasForEachItems = Array.isArray(resForEachItems) && resForEachItems.length > 0;
    for (const targetCheck of onFail.run) {
      if (checkLoopBudget(context, state, "on_fail", "run")) {
        const errorIssue = {
          file: "system",
          line: 0,
          ruleId: `${checkId}/routing/loop_budget_exceeded`,
          message: `Routing loop budget exceeded (max_loops=${context.config.routing?.max_loops ?? 10}) during on_fail run`,
          severity: "error",
          category: "logic"
        };
        result.issues = [...result.issues || [], errorIssue];
        return;
      }
      const targetConfig = context.config.checks?.[targetCheck];
      const fanoutMode = targetConfig?.fanout || "reduce";
      if (context.debug) {
        logger.info(
          `[Routing] on_fail.run: scheduling ${targetCheck} with fanout=${fanoutMode}, hasForEachItems=${hasForEachItems}`
        );
      }
      if (hasForEachItems) {
        for (let itemIndex = 0; itemIndex < resForEachItems.length; itemIndex++) {
          const itemOut = resForEachItems[itemIndex];
          if (itemOut && typeof itemOut === "object" && itemOut.__failed !== true && fanoutMode !== "map") {
            continue;
          }
          state.routingLoopCount++;
          const itemScope = [
            { check: checkId, index: itemIndex }
          ];
          recordRoutingEvent({
            checkId,
            trigger: "on_fail",
            action: "run",
            target: targetCheck,
            source: "run",
            scope: itemScope
          });
          emitEvent({
            type: "ForwardRunRequested",
            target: targetCheck,
            scope: itemScope,
            origin: "run",
            sourceCheck: checkId
            // The failed check that triggered on_fail.run
          });
        }
      } else {
        state.routingLoopCount++;
        recordRoutingEvent({
          checkId,
          trigger: "on_fail",
          action: "run",
          target: targetCheck,
          source: "run",
          scope
        });
        emitEvent({
          type: "ForwardRunRequested",
          target: targetCheck,
          scope,
          origin: "run",
          sourceCheck: checkId
          // The failed check that triggered on_fail.run
        });
      }
    }
  }
  if (onFail.run_js) {
    const dynamicTargets = await evaluateRunJs(
      onFail.run_js,
      checkId,
      checkConfig,
      result,
      context,
      state
    );
    for (const runItem of dynamicTargets) {
      const { target: targetCheck, args: runArgs } = parseRunItem(runItem);
      if (checkLoopBudget(context, state, "on_fail", "run")) {
        const errorIssue = {
          file: "system",
          line: 0,
          ruleId: `${checkId}/routing/loop_budget_exceeded`,
          message: `Routing loop budget exceeded (max_loops=${context.config.routing?.max_loops ?? 10}) during on_fail run`,
          severity: "error",
          category: "logic"
        };
        result.issues = [...result.issues || [], errorIssue];
        return;
      }
      if (context.debug) {
        logger.info(
          `[Routing] on_fail.run_js: scheduling ${targetCheck}${runArgs ? ", args=" + JSON.stringify(runArgs) : ""}`
        );
      }
      state.routingLoopCount++;
      recordRoutingEvent({
        checkId,
        trigger: "on_fail",
        action: "run",
        target: targetCheck,
        source: "run_js",
        scope
      });
      emitEvent({
        type: "ForwardRunRequested",
        target: targetCheck,
        scope,
        origin: "run_js",
        sourceCheck: checkId,
        // The failed check that triggered on_fail.run_js
        args: runArgs
      });
    }
  }
  if (onFail.retry && typeof onFail.retry.max === "number" && onFail.retry.max > 0) {
    const crit = getCriticality(context, checkId);
    const failureKind = classifyFailure(result);
    if ((crit === "external" || crit === "internal") && failureKind === "logical") {
      if (context.debug) {
        logger.info(
          `[Routing] on_fail.retry suppressed for ${checkId} (criticality=${crit}, failure=logical)`
        );
      }
    } else {
      const max = Math.max(0, onFail.retry.max || 0);
      if (!state.retryAttempts) state.retryAttempts = /* @__PURE__ */ new Map();
      const attemptsMap = state.retryAttempts;
      const makeKey = (sc) => {
        const keyScope = sc && sc.length > 0 ? JSON.stringify(sc) : "root";
        return `${checkId}::${keyScope}`;
      };
      const scheduleRetryForScope = (sc) => {
        const key = makeKey(sc);
        const used = attemptsMap.get(key) || 0;
        if (used >= max) return;
        attemptsMap.set(key, used + 1);
        state.routingLoopCount++;
        recordRoutingEvent({
          checkId,
          trigger: "on_fail",
          action: "retry",
          source: "retry",
          scope: sc || []
        });
        emitEvent({
          type: "ForwardRunRequested",
          target: checkId,
          scope: sc || [],
          origin: "run"
        });
      };
      const resForEachItems = result && result.forEachItems || void 0;
      const hasForEachItems = Array.isArray(resForEachItems) && resForEachItems.length > 0;
      if (hasForEachItems) {
        for (let i = 0; i < resForEachItems.length; i++) {
          const itemOut = resForEachItems[i];
          if (itemOut && typeof itemOut === "object" && itemOut.__failed === true) {
            const sc = [{ check: checkId, index: i }];
            scheduleRetryForScope(sc);
          }
        }
      } else {
        scheduleRetryForScope(scope);
      }
    }
  }
  const failTransTarget = await evaluateTransitions(
    onFail.transitions,
    checkId,
    checkConfig,
    result,
    context,
    state
  );
  if (failTransTarget !== void 0) {
    if (failTransTarget) {
      if (checkLoopBudget(context, state, "on_fail", "goto")) {
        const errorIssue = {
          file: "system",
          line: 0,
          ruleId: `${checkId}/routing/loop_budget_exceeded`,
          message: `Routing loop budget exceeded (max_loops=${context.config.routing?.max_loops ?? DEFAULT_MAX_LOOPS}) during on_fail goto`,
          severity: "error",
          category: "logic"
        };
        result.issues = [...result.issues || [], errorIssue];
        return;
      }
      state.routingLoopCount++;
      recordRoutingEvent({
        checkId,
        trigger: "on_fail",
        action: "goto",
        target: failTransTarget.to,
        source: "transitions",
        scope,
        gotoEvent: failTransTarget.goto_event
      });
      emitEvent({
        type: "ForwardRunRequested",
        target: failTransTarget.to,
        scope,
        origin: "goto_js",
        gotoEvent: failTransTarget.goto_event
      });
      state.flags.forwardRunRequested = true;
    }
    return;
  }
  const gotoTarget = await evaluateGoto(
    onFail.goto_js,
    onFail.goto,
    checkId,
    checkConfig,
    result,
    context,
    state
  );
  if (gotoTarget) {
    if (checkLoopBudget(context, state, "on_fail", "goto")) {
      const errorIssue = {
        file: "system",
        line: 0,
        ruleId: `${checkId}/routing/loop_budget_exceeded`,
        message: `Routing loop budget exceeded (max_loops=${context.config.routing?.max_loops ?? 10}) during on_fail goto`,
        severity: "error",
        category: "logic"
      };
      result.issues = [...result.issues || [], errorIssue];
      return;
    }
    if (context.debug) {
      logger.info(`[Routing] on_fail.goto: ${gotoTarget}`);
    }
    state.routingLoopCount++;
    recordRoutingEvent({
      checkId,
      trigger: "on_fail",
      action: "goto",
      target: gotoTarget,
      source: onFail.goto_js ? "goto_js" : "goto",
      scope,
      gotoEvent: onFail.goto_event
    });
    emitEvent({
      type: "ForwardRunRequested",
      target: gotoTarget,
      gotoEvent: onFail.goto_event,
      scope,
      origin: "goto_js"
    });
    state.flags.forwardRunRequested = true;
  }
}
function isValidRunItem(item) {
  if (typeof item === "string" && item) return true;
  if (typeof item === "object" && item !== null) {
    const obj = item;
    if (typeof obj.step === "string" && obj.step) return true;
    if (typeof obj.workflow === "string" && obj.workflow) return true;
  }
  return false;
}
async function evaluateRunJs(runJs, checkId, checkConfig, result, context, _state) {
  try {
    const sandbox = createSecureSandbox();
    const historyLimit = getHistoryLimit();
    const snapshotId = context.journal.beginSnapshot();
    const contextView = new (init_snapshot_store(), __toCommonJS(snapshot_store_exports)).ContextView(
      context.journal,
      context.sessionId,
      snapshotId,
      [],
      context.event
    );
    const outputsRecord = {};
    const outputsHistory = {};
    const allEntries = context.journal.readVisible(context.sessionId, snapshotId, context.event);
    const uniqueCheckIds = new Set(allEntries.map((e) => e.checkId));
    for (const checkIdFromJournal of uniqueCheckIds) {
      try {
        const journalResult = contextView.get(checkIdFromJournal);
        if (journalResult) {
          outputsRecord[checkIdFromJournal] = journalResult.output !== void 0 ? journalResult.output : journalResult;
        }
      } catch {
        outputsRecord[checkIdFromJournal] = { issues: [] };
      }
      try {
        const history = contextView.getHistory(checkIdFromJournal);
        if (history && history.length > 0) {
          const trimmed = historyLimit && history.length > historyLimit ? history.slice(history.length - historyLimit) : history;
          outputsHistory[checkIdFromJournal] = trimmed.map(
            (r) => r.output !== void 0 ? r.output : r
          );
        }
      } catch {
      }
    }
    outputsRecord.history = outputsHistory;
    let forEachMeta = void 0;
    try {
      const hist = outputsHistory[checkId] || [];
      const lastArr = hist.slice().reverse().find((x) => Array.isArray(x));
      if (checkConfig.forEach === true && Array.isArray(lastArr)) {
        forEachMeta = {
          is_parent: true,
          last_wave_size: lastArr.length,
          last_items: lastArr
        };
      }
    } catch {
    }
    const scopeObj = {
      step: {
        id: checkId,
        tags: checkConfig.tags || [],
        group: checkConfig.group
      },
      outputs: outputsRecord,
      outputs_history: outputsHistory,
      output: result?.output,
      memory: createMemoryHelpers(),
      event: {
        name: context.event || "manual"
      },
      forEach: forEachMeta
    };
    const code = `
      const step = scope.step;
      const outputs = scope.outputs;
      const outputs_history = scope.outputs_history;
      const output = scope.output;
      const memory = scope.memory;
      const event = scope.event;
      const forEach = scope.forEach;
      const log = (...args) => console.log('\u{1F50D} Debug:', ...args);
      const __fn = () => {
        ${runJs}
      };
      const __res = __fn();
      // Return as-is; validation happens after sandbox execution
      return Array.isArray(__res) ? __res : [];
    `;
    try {
      const evalResult = compileAndRun(
        sandbox,
        code,
        { scope: scopeObj },
        { injectLog: false, wrapFunction: false }
      );
      return Array.isArray(evalResult) ? evalResult.filter(isValidRunItem) : [];
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Routing] Error in run_js sandbox evaluation: ${msg}`);
      return [];
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(`[Routing] Error evaluating run_js: ${msg}`);
    return [];
  }
}
async function evaluateGoto(gotoJs, gotoStatic, checkId, checkConfig, result, context, _state) {
  if (gotoJs) {
    try {
      const sandbox = createSecureSandbox();
      const historyLimit = getHistoryLimit();
      const snapshotId = context.journal.beginSnapshot();
      const contextView = new (init_snapshot_store(), __toCommonJS(snapshot_store_exports)).ContextView(
        context.journal,
        context.sessionId,
        snapshotId,
        [],
        void 0
      );
      const outputsRecord = {};
      const outputsHistory = {};
      const allEntries = context.journal.readVisible(context.sessionId, snapshotId, void 0);
      const uniqueCheckIds = new Set(allEntries.map((e) => e.checkId));
      for (const checkIdFromJournal of uniqueCheckIds) {
        try {
          const journalResult = contextView.get(checkIdFromJournal);
          if (journalResult) {
            outputsRecord[checkIdFromJournal] = journalResult.output !== void 0 ? journalResult.output : journalResult;
          }
        } catch {
          outputsRecord[checkIdFromJournal] = { issues: [] };
        }
        try {
          const history = contextView.getHistory(checkIdFromJournal);
          if (history && history.length > 0) {
            const trimmed = historyLimit && history.length > historyLimit ? history.slice(history.length - historyLimit) : history;
            outputsHistory[checkIdFromJournal] = trimmed.map(
              (r) => r.output !== void 0 ? r.output : r
            );
          }
        } catch {
        }
      }
      outputsRecord.history = outputsHistory;
      let forEachMeta = void 0;
      try {
        const hist = outputsHistory[checkId] || [];
        const lastArr = hist.slice().reverse().find((x) => Array.isArray(x));
        if (checkConfig.forEach === true && Array.isArray(lastArr)) {
          forEachMeta = {
            is_parent: true,
            last_wave_size: lastArr.length,
            last_items: lastArr
          };
        }
      } catch {
      }
      const scopeObj = {
        step: {
          id: checkId,
          tags: checkConfig.tags || [],
          group: checkConfig.group
        },
        outputs: outputsRecord,
        outputs_history: outputsHistory,
        output: result?.output,
        memory: createMemoryHelpers(),
        event: {
          name: context.event || "manual"
        },
        forEach: forEachMeta
      };
      if (context.debug) {
        logger.info(
          `[Routing] evaluateGoto: checkId=${checkId}, outputs_history keys=${Object.keys(outputsHistory).join(",")}`
        );
        for (const [key, values] of Object.entries(outputsHistory)) {
          logger.info(`[Routing]   ${key}: ${values.length} items`);
        }
      }
      const code = `
        const step = scope.step;
        const outputs = scope.outputs;
        const outputs_history = scope.outputs_history;
        const output = scope.output;
        const memory = scope.memory;
        const event = scope.event;
        const forEach = scope.forEach;
        const log = (...args) => console.log('\u{1F50D} Debug:', ...args);
        ${gotoJs}
      `;
      try {
        const evalResult = compileAndRun(
          sandbox,
          code,
          { scope: scopeObj },
          { injectLog: false, wrapFunction: true }
        );
        if (context.debug) {
          logger.info(`[Routing] evaluateGoto result: ${evalResult}`);
        }
        if (typeof evalResult === "string" && evalResult) {
          return evalResult;
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.error(`[Routing] Error in goto_js sandbox evaluation: ${msg}`);
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error(`[Routing] Error evaluating goto_js: ${msg}`);
      if (gotoStatic) {
        logger.info(`[Routing] Falling back to static goto: ${gotoStatic}`);
        return gotoStatic;
      }
    }
  }
  return gotoStatic || null;
}
async function evaluateTransitions(transitions, checkId, checkConfig, result, context, _state) {
  if (!transitions || transitions.length === 0) return void 0;
  try {
    const sandbox = createSecureSandbox();
    const historyLimit = getHistoryLimit();
    const snapshotId = context.journal.beginSnapshot();
    const ContextView2 = (init_snapshot_store(), __toCommonJS(snapshot_store_exports)).ContextView;
    const view = new ContextView2(context.journal, context.sessionId, snapshotId, [], void 0);
    const outputsRecord = {};
    const outputsHistory = {};
    const allEntries = context.journal.readVisible(context.sessionId, snapshotId, void 0);
    const uniqueCheckIds = new Set(allEntries.map((e) => e.checkId));
    for (const cid of uniqueCheckIds) {
      try {
        const jr = view.get(cid);
        if (jr) outputsRecord[cid] = jr.output !== void 0 ? jr.output : jr;
      } catch {
      }
      try {
        const hist = view.getHistory(cid);
        if (hist && hist.length > 0) {
          const trimmed = historyLimit && hist.length > historyLimit ? hist.slice(hist.length - historyLimit) : hist;
          outputsHistory[cid] = trimmed.map((r) => r.output !== void 0 ? r.output : r);
        }
      } catch {
      }
    }
    outputsRecord.history = outputsHistory;
    const scopeObj = {
      step: { id: checkId, tags: checkConfig.tags || [], group: checkConfig.group },
      outputs: outputsRecord,
      outputs_history: outputsHistory,
      output: result?.output,
      memory: createMemoryHelpers(),
      event: { name: context.event || "manual" }
    };
    for (const rule of transitions) {
      const helpers = `
        const any = (arr, pred) => Array.isArray(arr) && arr.some(x => pred(x));
        const all = (arr, pred) => Array.isArray(arr) && arr.every(x => pred(x));
        const none = (arr, pred) => Array.isArray(arr) && !arr.some(x => pred(x));
        const count = (arr, pred) => Array.isArray(arr) ? arr.filter(x => pred(x)).length : 0;
      `;
      const code = `
        ${helpers}
        const step = scope.step;
        const outputs = scope.outputs;
        const outputs_history = scope.outputs_history;
        const output = scope.output;
        const memory = scope.memory;
        const event = scope.event;
        const __eval = () => { return (${rule.when}); };
        return __eval();
      `;
      let matched;
      try {
        matched = compileAndRun(
          sandbox,
          code,
          { scope: scopeObj },
          { injectLog: false, wrapFunction: false }
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        logger.warn(`[Routing] Error evaluating transition 'when' clause: ${msg}`);
        matched = false;
      }
      if (matched) {
        if (rule.to === null) return null;
        if (typeof rule.to === "string" && rule.to.length > 0) {
          return { to: rule.to, goto_event: rule.goto_event };
        }
        return null;
      }
    }
    return void 0;
  } catch (err) {
    logger.error(
      `[Routing] Error evaluating transitions: ${err instanceof Error ? err.message : String(err)}`
    );
    return void 0;
  }
}
var DEFAULT_MAX_LOOPS;
var init_routing = __esm({
  "src/state-machine/states/routing.ts"() {
    init_logger();
    init_trace_helpers();
    init_failure_condition_evaluator();
    init_sandbox();
    init_memory_store();
    init_liquid_extensions();
    DEFAULT_MAX_LOOPS = 10;
  }
});

export {
  requireKeyedScopePath,
  init_instance_kernel,
  ProofProjectReconcileCheckProvider,
  createProofProjectReconcileProviderFromCapability,
  init_proof_project_reconcile_check_provider,
  ExecutionJournal,
  snapshot_store_exports,
  init_snapshot_store,
  evaluateManagedRouting,
  applyManagedRoutingEffects,
  handleRouting,
  checkLoopBudget,
  evaluateGoto,
  evaluateTransitions,
  init_routing
};
//# sourceMappingURL=chunk-XXGIVRO3.mjs.map