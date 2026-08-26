/*
 * Internal snapshot store for incremental adoption of snapshot+scope execution.
 * Phase 0: journal only — no behavior change, used for future visibility work.
 */

import type { ReviewSummary } from './reviewer';
import type { EventTrigger } from './types/config';
import type { CandidateClaimInput } from './providers/check-provider.interface';
import {
  buildClaimPublishedEvent,
  canonicalJson,
  createInitialClaimProjection,
  exactActiveClaimIds,
  immutableCanonicalValue,
  immutableRuntimeEvent,
  ClaimKernelError,
  reduceClaimEvent,
  replayClaimEvents,
  sha256Canonical,
  type AttemptCompletedEvent,
  type AttemptFailedEvent,
  type AttemptStartedEvent,
  type CheckScheduledEvent,
  type ClaimProjection,
  type ClaimRuntimeEvent,
} from './state-machine/graph/claim-kernel';
import type { ClaimPlan } from './state-machine/graph/claim-plan';
import {
  createInitialInstanceProjection,
  deriveCatalogRequestId,
  canonicalCatalogKey,
  deriveControllerItemClaimId,
  deriveItemFingerprint,
  deriveManagedRunId,
  deriveNodeGenerationId,
  deriveNodeInstanceId,
  deriveSubgraphInstanceId,
  immutableInstanceEvent,
  queryReadyGenerations,
  reduceInstanceEvent,
  reduceInstanceEventBatch,
  replayInstanceEvents,
  projectExpansionCoverage,
  type CatalogReconciliationRequestedEvent,
  type CatalogRequestAttemptStartedEvent,
  type CatalogRequestCheckScheduledEvent,
  type InstanceProjection,
  type InstanceRuntimeEvent,
  type ExpansionCoverageProjection,
  type NodeGenerationProjection,
  type KeyedScopePath,
  type RootScopePath,
  type GeneratedAttemptStartedEvent,
  type GeneratedCheckScheduledEvent,
  type GeneratedClaimPublishedEvent,
  type ManagedRunAcquisitionFailureCode,
  type ManagedRunBindingV1,
  type ManagedRunCleanupStatus,
  type ManagedRunFailureCode,
} from './state-machine/graph/instance-kernel';
import {
  qualifiedNestedExpansionOwner,
  resolveJsonPointer,
  type CompiledExpansion,
} from './state-machine/graph/instance-plan';

export type ScopePath = Array<{ check: string; index: number }>;

type CatalogAttemptStartedEvent = AttemptStartedEvent & CatalogRequestAttemptStartedEvent;
type CatalogCheckScheduledEvent = CheckScheduledEvent & CatalogRequestCheckScheduledEvent;
type CatalogScheduleAuthority = Pick<
  CatalogRequestAttemptStartedEvent,
  'requestId' | 'attemptId' | 'fence'
>;
type GeneratedScheduleAuthority = Pick<
  GeneratedAttemptStartedEvent,
  'nodeGenerationId' | 'attemptId' | 'fence'
>;
type WithoutEventId<T> = T extends { readonly eventId: number } ? Omit<T, 'eventId'> : never;
type StagedInstanceRuntimeEvent = WithoutEventId<InstanceRuntimeEvent>;

export interface JournalEntry {
  commitId: number;
  sessionId: string;
  scope: ScopePath;
  checkId: string;
  event: EventTrigger | undefined;
  result: ReviewSummary & { output?: unknown; content?: string };
}

export class ExecutionJournal {
  private commit = 0;
  private entries: JournalEntry[] = [];
  private runtimeEvents: Array<ClaimRuntimeEvent | InstanceRuntimeEvent> = [];
  private claimProjection: ClaimProjection = createInitialClaimProjection();
  private instanceProjection: InstanceProjection = createInitialInstanceProjection();
  private nextFence = 0;
  private attemptOrdinals = new Map<string, number>();
  private requestOrdinals = new Map<string, number>();

  constructor(private readonly claimPlan?: ClaimPlan) {}

  beginSnapshot(): number {
    return this.commit;
  }

  commitEntry(entry: {
    sessionId: string;
    scope: ScopePath;
    checkId: string;
    result: ReviewSummary & { output?: unknown; content?: string };
    event?: EventTrigger;
  }): JournalEntry {
    const committed: JournalEntry = {
      sessionId: entry.sessionId,
      scope: entry.scope,
      checkId: entry.checkId,
      result: entry.result,
      event: entry.event,
      commitId: ++this.commit,
    };
    this.entries.push(committed);
    return committed;
  }

  readVisible(sessionId: string, commitMax: number, event?: EventTrigger): JournalEntry[] {
    return this.entries.filter(
      e =>
        e.sessionId === sessionId && e.commitId <= commitMax && (event ? e.event === event : true)
    );
  }

  private requireClaimPlan(): ClaimPlan {
    if (!this.claimPlan?.active) {
      throw new ClaimKernelError('CLAIM_MODE_INACTIVE', 'Runtime claim journal is inactive');
    }
    return this.claimPlan;
  }

  private appendRuntimeEvent<T extends ClaimRuntimeEvent>(event: T): T {
    const plan = this.requireClaimPlan();
    const stored = immutableRuntimeEvent(event);
    const projected = reduceClaimEvent(this.claimProjection, stored, plan);
    this.runtimeEvents.push(stored);
    this.claimProjection = projected;
    return stored;
  }

  private nextRuntimeEventId(): number {
    return Math.max(this.claimProjection.lastEventId, this.instanceProjection.lastEventId) + 1;
  }

  private appendInstanceEvent<T extends InstanceRuntimeEvent>(event: T): T {
    this.requireClaimPlan();
    const stored = immutableInstanceEvent(event);
    const projected = reduceInstanceEvent(this.instanceProjection, stored);
    this.runtimeEvents.push(stored);
    this.instanceProjection = projected;
    return stored;
  }

  requestCatalogReconciliation(input: {
    sessionId: string;
    ownerCheck: string;
  }): CatalogReconciliationRequestedEvent {
    const expansion = this.requireClaimPlan().expansionPlan?.byOwner[input.ownerCheck];
    if (!expansion) {
      throw new ClaimKernelError('UNKNOWN_EXPANSION_OWNER', `Unknown expansion owner ${input.ownerCheck}`);
    }
    const ordinal = (this.requestOrdinals.get(input.ownerCheck) || 0) + 1;
    this.requestOrdinals.set(input.ownerCheck, ordinal);
    return this.appendInstanceEvent({
      version: 1,
      type: 'CatalogReconciliationRequested',
      eventId: this.nextRuntimeEventId(),
      sessionId: input.sessionId,
      scope: [],
      requestId: deriveCatalogRequestId({
        sessionId: input.sessionId,
        expansionOwnerCheck: input.ownerCheck,
        ordinal,
      }),
      requestOrdinal: ordinal,
      expansionOwnerCheck: input.ownerCheck,
      status: 'pending',
    });
  }

  getOldestPendingCatalogRequest() {
    const id = this.instanceProjection.requestOrder.find(
      requestId => this.instanceProjection.requestsById[requestId].status === 'pending'
    );
    return id ? this.instanceProjection.requestsById[id] : undefined;
  }

  startCatalogRequestAttempt(requestId: string): CatalogAttemptStartedEvent {
    const request = this.instanceProjection.requestsById[requestId];
    if (!request || request.status !== 'pending') throw new ClaimKernelError('INVALID_REQUEST_STATE', `Request ${requestId} is not pending`);
    const scope: ScopePath & RootScopePath = [];
    const authority = { sessionId: request.sessionId, checkId: request.expansionOwnerCheck, scope };
    const ordinalKey = canonicalJson(authority); const ordinal=(this.attemptOrdinals.get(ordinalKey)||0)+1;
    this.attemptOrdinals.set(ordinalKey,ordinal); const fence=++this.nextFence;
    const event = immutableCanonicalValue<CatalogAttemptStartedEvent>({version:1,type:'AttemptStarted',eventId:this.nextRuntimeEventId(),...authority,attemptId:sha256Canonical({...authority,ordinal}),fence,requestId});
    const claim = reduceClaimEvent(this.claimProjection,event,this.requireClaimPlan());
    const instance = reduceInstanceEvent(this.instanceProjection,event);
    this.runtimeEvents.push(event); this.claimProjection=claim; this.instanceProjection=instance;
    return event;
  }

  scheduleCatalogRequestAttempt(input: CatalogScheduleAuthority): CatalogCheckScheduledEvent {
    const request = this.instanceProjection.requestsById[input.requestId];
    if (!request) {
      throw new ClaimKernelError('UNKNOWN_REQUEST', `Unknown catalog request ${input.requestId}`);
    }
    const scope: ScopePath & RootScopePath = [];
    const claimIds = exactActiveClaimIds(
      this.requireClaimPlan(),
      this.claimProjection,
      request.expansionOwnerCheck
    );
    const event = immutableCanonicalValue<CatalogCheckScheduledEvent>({
      version: 1,
      type: 'CheckScheduled',
      eventId: this.nextRuntimeEventId(),
      sessionId: request.sessionId,
      checkId: request.expansionOwnerCheck,
      scope,
      requestId: request.requestId,
      attemptId: input.attemptId,
      fence: input.fence,
      claimIds: [...claimIds],
    });
    const claim=reduceClaimEvent(this.claimProjection,event,this.requireClaimPlan());
    const instance=reduceInstanceEvent(this.instanceProjection,event);
    this.runtimeEvents.push(event); this.claimProjection=claim; this.instanceProjection=instance;
    return event;
  }

  startGeneratedAttempt(nodeGenerationId: string): GeneratedAttemptStartedEvent {
    const generation = this.instanceProjection.generationsById[nodeGenerationId];
    if (!generation || generation.status !== 'ready') {
      throw new ClaimKernelError('GENERATION_NOT_READY', `Generation ${nodeGenerationId} is not ready`);
    }
    const fence = ++this.nextFence;
    const ordinalKey = canonicalJson({ nodeGenerationId, scope: generation.scope });
    const ordinal = (this.attemptOrdinals.get(ordinalKey) || 0) + 1;
    this.attemptOrdinals.set(ordinalKey, ordinal);
    return this.appendInstanceEvent({
      version: 1,
      type: 'AttemptStarted',
      eventId: this.nextRuntimeEventId(),
      sessionId: this.instanceProjection.instancesById[generation.subgraphInstanceId].sessionId,
      checkId: generation.checkId,
      scope: generation.scope,
      attemptId: sha256Canonical({ nodeGenerationId, ordinal }),
      fence,
      nodeInstanceId: generation.nodeInstanceId,
      nodeGenerationId,
    });
  }

  scheduleGeneratedAttempt(input: GeneratedScheduleAuthority): GeneratedCheckScheduledEvent {
    const generation = this.instanceProjection.generationsById[input.nodeGenerationId];
    if (!generation) {
      throw new ClaimKernelError(
        'UNKNOWN_GENERATION',
        `Unknown generation ${input.nodeGenerationId}`
      );
    }
    const instance = this.instanceProjection.instancesById[generation.subgraphInstanceId];
    return this.appendInstanceEvent({
      version: 1,
      type: 'CheckScheduled',
      eventId: this.nextRuntimeEventId(),
      sessionId: instance.sessionId,
      checkId: generation.checkId,
      scope: generation.scope,
      attemptId: input.attemptId,
      fence: input.fence,
      nodeInstanceId: generation.nodeInstanceId,
      nodeGenerationId: generation.nodeGenerationId,
      claimIds: [...generation.activeInputClaimIds],
    });
  }

  private compiledExpansionForInstance(subgraphInstanceId: string): CompiledExpansion {
    const instance = this.instanceProjection.instancesById[subgraphInstanceId];
    if (!instance) {
      throw new ClaimKernelError('UNKNOWN_INSTANCE', `Unknown instance ${subgraphInstanceId}`);
    }
    const expansionPlan = this.requireClaimPlan().expansionPlan!;
    const expansion = instance.parentSubgraphInstanceId
      ? expansionPlan.byNestedOwner[instance.expansionOwnerCheck]
      : expansionPlan.byOwner[instance.expansionOwnerCheck];
    if (!expansion || expansion.expansionSpecDigest !== instance.expansionSpecDigest) {
      throw new ClaimKernelError(
        'INVALID_EXPANSION_AUTHORITY',
        `Instance ${subgraphInstanceId} is not bound to one exact compiled expansion`
      );
    }
    return expansion;
  }

  getGeneratedExecution(nodeGenerationId: string) {
    const generation = this.instanceProjection.generationsById[nodeGenerationId];
    if (!generation) throw new ClaimKernelError('UNKNOWN_GENERATION', `Unknown generation ${nodeGenerationId}`);
    const instance = this.instanceProjection.instancesById[generation.subgraphInstanceId];
    const expansion = this.compiledExpansionForInstance(instance.subgraphInstanceId);
    const node = expansion.template.nodesByKey[generation.templateNodeKey];
    const claims: Record<string, CandidateClaimInput> = {};
    for (const consumption of node.consumptions) {
      const claim = generation.activeInputClaimIds
        .map(id => this.instanceProjection.claimsById[id])
        .find(candidate => candidate?.claim === consumption.claim);
      if (!claim) throw new ClaimKernelError('CLAIM_NOT_READY', `Missing generated input ${consumption.claim}`);
      if (
        (claim.kind === 'controller-item' && !claim.controllerCatalogClaimId) ||
        (claim.kind === 'generated-output' &&
          (!claim.producerAttemptId || claim.producerFence === undefined))
      ) {
        throw new ClaimKernelError(
          'INVALID_CLAIM_PROVENANCE',
          `Claim ${claim.claimId} lacks authoritative producer provenance`
        );
      }
      const provenance = claim.kind === 'controller-item'
        ? {
            provenance: 'controller' as const,
            catalogClaimId: claim.controllerCatalogClaimId as string,
            incarnation: claim.incarnation,
          }
        : {
            provenance: 'attempt' as const,
            attemptId: claim.producerAttemptId as string,
            fence: claim.producerFence as number,
          };
      claims[consumption.as] = Object.freeze({
        claimId: claim.claimId,
        claim: claim.claim,
        payload: claim.payload,
        payloadFingerprint: claim.payloadFingerprint,
        producerCheckId: claim.producerCheckId,
        scope: claim.scope,
        parentClaimIds: claim.parentClaimIds,
        ...provenance,
      });
    }
    return Object.freeze({ generation, node, claims: Object.freeze(claims) });
  }

  deriveManagedRunBinding(attempt: GeneratedAttemptStartedEvent): ManagedRunBindingV1 {
    const generation = this.instanceProjection.generationsById[attempt.nodeGenerationId];
    const instance = generation
      ? this.instanceProjection.instancesById[generation.subgraphInstanceId]
      : undefined;
    if (
      !generation ||
      !instance ||
      generation.status !== 'running' ||
      !generation.scheduled ||
      generation.attemptId !== attempt.attemptId ||
      generation.fence !== attempt.fence ||
      generation.nodeInstanceId !== attempt.nodeInstanceId ||
      this.instanceProjection.attemptBindingsById[attempt.attemptId] !==
        generation.nodeGenerationId ||
      attempt.sessionId !== instance.sessionId ||
      attempt.checkId !== generation.checkId ||
      canonicalJson(attempt.scope) !== canonicalJson(generation.scope) ||
      attempt.nodeGenerationId !== generation.nodeGenerationId
    ) {
      throw new ClaimKernelError(
        'INVALID_MANAGED_BINDING',
        `Attempt ${attempt.attemptId} is not the current scheduled generated attempt`
      );
    }
    const authority: Omit<ManagedRunBindingV1, 'managedRunId'> = {
      sessionId: instance.sessionId,
      checkId: generation.checkId,
      scope: generation.scope,
      nodeInstanceId: generation.nodeInstanceId,
      nodeGenerationId: generation.nodeGenerationId,
      attemptId: generation.attemptId!,
      fence: generation.fence!,
    };
    return immutableCanonicalValue({
      managedRunId: deriveManagedRunId(authority),
      ...authority,
    });
  }

  private appendInstanceEventBatch(events: readonly InstanceRuntimeEvent[]): void {
    this.requireClaimPlan();
    const stored = events.map(event => immutableInstanceEvent(event));
    const projected = reduceInstanceEventBatch(this.instanceProjection, stored);
    this.runtimeEvents.push(...stored);
    this.instanceProjection = projected;
  }

  failManagedRunAcquisition(input: {
    attempt: GeneratedAttemptStartedEvent;
    binding: ManagedRunBindingV1;
    failureCode: ManagedRunAcquisitionFailureCode;
  }): void {
    const eventId = this.nextRuntimeEventId();
    this.appendInstanceEventBatch([
      {
        version: 1,
        type: 'ManagedRunAcquisitionFailed',
        eventId,
        sessionId: input.attempt.sessionId,
        scope: input.attempt.scope,
        binding: input.binding,
        failureCode: input.failureCode,
      },
      {
        ...input.attempt,
        type: 'AttemptFailed',
        eventId: eventId + 1,
        reason: input.failureCode,
      },
    ]);
  }

  recordManagedRunAcquired(binding: ManagedRunBindingV1): void {
    this.appendInstanceEvent({
      version: 1,
      type: 'ManagedRunAcquired',
      eventId: this.nextRuntimeEventId(),
      sessionId: binding.sessionId,
      scope: binding.scope,
      binding,
    });
  }

  recordManagedRunStarted(binding: ManagedRunBindingV1): void {
    this.appendInstanceEvent({
      version: 1,
      type: 'ManagedRunStarted',
      eventId: this.nextRuntimeEventId(),
      sessionId: binding.sessionId,
      scope: binding.scope,
      binding,
    });
  }

  recordManagedRunCancelRequested(binding: ManagedRunBindingV1): void {
    this.appendInstanceEvent({
      version: 1,
      type: 'ManagedRunCancelRequested',
      eventId: this.nextRuntimeEventId(),
      sessionId: binding.sessionId,
      scope: binding.scope,
      binding,
      reason: 'deadline',
    });
  }

  failManagedGeneratedAttempt(input: {
    attempt: GeneratedAttemptStartedEvent;
    binding: ManagedRunBindingV1;
    cleanupStatus: ManagedRunCleanupStatus;
    failureCode: ManagedRunFailureCode;
  }): void {
    const eventId = this.nextRuntimeEventId();
    this.appendInstanceEventBatch([
      {
        version: 1,
        type: 'ManagedRunTerminated',
        eventId,
        sessionId: input.attempt.sessionId,
        scope: input.attempt.scope,
        binding: input.binding,
        cleanupStatus: input.cleanupStatus,
        controllerDecision: 'failed',
        failureCode: input.failureCode,
      },
      {
        ...input.attempt,
        type: 'AttemptFailed',
        eventId: eventId + 1,
        reason: input.failureCode,
      },
    ]);
  }

  completeGeneratedAttempt(input: {
    attempt: GeneratedAttemptStartedEvent;
    payload: unknown;
  }): void {
    const staged = this.stageGeneratedCompletion(input);
    this.runtimeEvents.push(...staged.events);
    this.instanceProjection = staged.projection;
  }

  completeManagedGeneratedAttempt(input: {
    attempt: GeneratedAttemptStartedEvent;
    binding: ManagedRunBindingV1;
    payload: unknown;
  }): void {
    const terminal = immutableInstanceEvent({
      version: 1,
      type: 'ManagedRunTerminated',
      eventId: this.nextRuntimeEventId(),
      sessionId: input.binding.sessionId,
      scope: input.binding.scope,
      binding: input.binding,
      cleanupStatus: 'clean',
      controllerDecision: 'completed',
      failureCode: null,
    });
    const staged = this.stageGeneratedCompletion(input, [terminal]);
    this.runtimeEvents.push(...staged.events);
    this.instanceProjection = staged.projection;
  }

  private stageGeneratedCompletion(
    input: { attempt: GeneratedAttemptStartedEvent; payload: unknown },
    prefix: readonly InstanceRuntimeEvent[] = []
  ): { events: readonly InstanceRuntimeEvent[]; projection: InstanceProjection } {
    const { attempt, payload } = input;
    const before = this.instanceProjection;
    const generation = before.generationsById[attempt.nodeGenerationId];
    const instance = before.instancesById[generation.subgraphInstanceId];
    const expansion = this.compiledExpansionForInstance(instance.subgraphInstanceId);
    const node = expansion.template.nodesByKey[generation.templateNodeKey];
    const nestedOwner = qualifiedNestedExpansionOwner(
      expansion.template.name,
      generation.templateNodeKey
    );
    const nestedExpansion = this.requireClaimPlan().expansionPlan!.byNestedOwner[nestedOwner];
    let staged = before;
    const events: InstanceRuntimeEvent[] = [];
    const stage = (event: InstanceRuntimeEvent): void => {
      const stored = immutableInstanceEvent(event);
      staged = reduceInstanceEvent(staged, stored);
      events.push(stored);
    };
    for (const event of prefix) stage(event);
    const publications: GeneratedClaimPublishedEvent[] = [];
    for (const emission of node.emissions) {
      this.requireClaimPlan().validatorsByClaim[emission.claim](payload);
      const immutablePayload = immutableCanonicalValue(payload);
      const payloadFingerprint = sha256Canonical(immutablePayload);
      const parentClaimIds = [...generation.activeInputClaimIds].sort();
      const eventId =
        Math.max(this.claimProjection.lastEventId, staged.lastEventId) + publications.length + 1;
      const published: GeneratedClaimPublishedEvent = {
        version: 1, type: 'ClaimPublished', eventId,
        sessionId: attempt.sessionId, checkId: attempt.checkId, scope: attempt.scope,
        attemptId: attempt.attemptId, fence: attempt.fence,
        nodeInstanceId: attempt.nodeInstanceId, nodeGenerationId: attempt.nodeGenerationId,
        claim: emission.claim, payload: immutablePayload, payloadFingerprint,
        producerCheckId: attempt.checkId, parentClaimIds,
        claimId: sha256Canonical({ claim: emission.claim, payloadFingerprint,
          producerCheckId: attempt.checkId, scope: attempt.scope, attemptId: attempt.attemptId,
          fence: attempt.fence, parentClaimIds }),
      };
      publications.push(published);
    }
    const nestedCatalogPublications = nestedExpansion
      ? publications.filter(publication =>
          publication.claim === nestedExpansion.catalogClaimRef
        )
      : [];
    if (nestedExpansion && nestedCatalogPublications.length !== 1) {
      throw new ClaimKernelError(
        'INVALID_NESTED_CATALOG_AUTHORITY',
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
        expansionOwnerNodeInstanceId: generation.nodeInstanceId,
      });
      events.push(...reconciled.events);
      staged = reconciled.projection;
    }
    for (const nodeKey of expansion.template.topology) {
      const candidate = expansion.template.nodesByKey[nodeKey];
      const nodeInstanceId = instance.nodeInstanceIdsByTemplateNode[nodeKey];
      if (staged.activeGenerationIdByNode[nodeInstanceId]) continue;
      const dependenciesCompleted = candidate.dependencyNodeKeys.every(dependencyNodeKey => {
        const dependencyNodeId = instance.nodeInstanceIdsByTemplateNode[dependencyNodeKey];
        const dependencyGenerationId = staged.activeGenerationIdByNode[dependencyNodeId];
        const isCompletingGeneration =
          dependencyGenerationId === generation.nodeGenerationId &&
          generation.nodeInstanceId === attempt.nodeInstanceId &&
          generation.status === 'running' &&
          generation.scheduled &&
          generation.attemptId === attempt.attemptId &&
          generation.fence === attempt.fence;
        return (
          dependencyGenerationId !== undefined &&
          (isCompletingGeneration ||
            staged.generationsById[dependencyGenerationId]?.status === 'completed')
        );
      });
      if (!dependenciesCompleted) continue;
      const inputIds: string[] = [];
      let ready = true;
      for (const consumption of candidate.consumptions) {
        const claims = Object.values(staged.claimsById)
          .filter(value =>
            value.active &&
            value.subgraphInstanceId === instance.subgraphInstanceId &&
            value.incarnation === instance.incarnation &&
            value.claim === consumption.claim
          )
          .sort((left, right) => left.claimId.localeCompare(right.claimId));
        if (claims.length !== 1) {
          ready = false;
          break;
        }
        inputIds.push(claims[0].claimId);
      }
      if (!ready) continue;
      inputIds.sort();
      const item = instance.activeItemClaimId
        ? staged.claimsById[instance.activeItemClaimId]
        : undefined;
      if (!item?.active) {
        throw new ClaimKernelError(
          'INACTIVE_ITEM_CLAIM',
          `Instance ${instance.subgraphInstanceId} lacks an active item claim`
        );
      }
      const nodeGenerationId = deriveNodeGenerationId({ nodeInstanceId,
        incarnation: instance.incarnation, itemFingerprint: item.payloadFingerprint,
        executionConfigDigest: candidate.executionConfigDigest, activeInputClaimIds: inputIds });
      const nestedCatalogClaimRef = this.requireClaimPlan().expansionPlan!.byNestedOwner[
        qualifiedNestedExpansionOwner(expansion.template.name, nodeKey)
      ]?.catalogClaimRef;
      stage({ version: 1, type: 'NodeGenerationActivated',
        eventId: Math.max(this.claimProjection.lastEventId, staged.lastEventId) + 1,
        sessionId: attempt.sessionId, scope: instance.scope,
        subgraphInstanceId: instance.subgraphInstanceId, nodeInstanceId, nodeGenerationId,
        templateNodeKey: nodeKey, checkId: nodeKey, incarnation: instance.incarnation,
        itemFingerprint: item.payloadFingerprint, executionConfigDigest: candidate.executionConfigDigest,
        activeInputClaimIds: inputIds,
        ...(nestedCatalogClaimRef
          ? { nestedExpansionCatalogClaimRef: nestedCatalogClaimRef }
          : {}) });
    }
    stage({ ...attempt, type: 'AttemptCompleted',
      eventId: Math.max(this.claimProjection.lastEventId, staged.lastEventId) + 1 });
    return {
      events,
      projection: reduceInstanceEventBatch(before, events),
    };
  }

  failGeneratedAttempt(attempt: GeneratedAttemptStartedEvent, reason: string): void {
    this.appendInstanceEvent({ ...attempt, type: 'AttemptFailed', reason,
      eventId: this.nextRuntimeEventId() });
  }

  queryReadyWork(): readonly NodeGenerationProjection[] {
    return queryReadyGenerations(this.instanceProjection);
  }

  getInstanceProjection(): InstanceProjection {
    return immutableCanonicalValue(this.instanceProjection);
  }

  getExpansionCoverageProjection(requestId: string): ExpansionCoverageProjection {
    const request = this.instanceProjection.requestsById[requestId];
    const expansion = request
      ? this.requireClaimPlan().expansionPlan?.byOwner[request.expansionOwnerCheck]
      : undefined;
    if (!expansion) {
      throw new ClaimKernelError('UNKNOWN_COVERAGE_REQUEST', `Unknown coverage request ${requestId}`);
    }
    return projectExpansionCoverage(this.instanceProjection, expansion, requestId);
  }

  replayExpansionCoverageProjection(requestId: string): ExpansionCoverageProjection {
    const projection = this.replayInstanceProjection();
    const request = projection.requestsById[requestId];
    const expansion = request
      ? this.requireClaimPlan().expansionPlan?.byOwner[request.expansionOwnerCheck]
      : undefined;
    if (!expansion) {
      throw new ClaimKernelError('UNKNOWN_COVERAGE_REQUEST', `Unknown coverage request ${requestId}`);
    }
    return projectExpansionCoverage(projection, expansion, requestId);
  }

  replayInstanceProjection(): InstanceProjection {
    return replayInstanceEvents(
      this.runtimeEvents.filter(event =>
        [
          'CatalogReconciliationRequested',
          'SubgraphExpanded',
          'ControllerItemClaimPublished',
          'NodeGenerationInactivated',
          'NodeGenerationActivated',
          'SubgraphTombstoned',
          'ManagedRunAcquisitionFailed',
          'ManagedRunAcquired',
          'ManagedRunStarted',
          'ManagedRunCancelRequested',
          'ManagedRunTerminated',
        ].includes(event.type) ||
        'nodeGenerationId' in event || 'requestId' in event
      ) as InstanceRuntimeEvent[]
    );
  }

  startAttempt(input: {
    sessionId: string;
    checkId: string;
    scope: ScopePath;
  }): AttemptStartedEvent {
    const plan = this.requireClaimPlan();
    if (!Object.prototype.hasOwnProperty.call(plan.effectiveDependenciesByCheck, input.checkId)) {
      throw new ClaimKernelError('UNKNOWN_CHECK', `Unknown claim-mode check ${input.checkId}`);
    }
    const authoritativeInput = {
      sessionId: input.sessionId,
      checkId: input.checkId,
      scope: input.scope.map(part => ({ ...part })),
    };
    const ordinalKey = canonicalJson(authoritativeInput);
    const ordinal = (this.attemptOrdinals.get(ordinalKey) || 0) + 1;
    this.attemptOrdinals.set(ordinalKey, ordinal);
    const fence = ++this.nextFence;
    const attemptId = sha256Canonical({ ...authoritativeInput, ordinal });
    return this.appendRuntimeEvent({
      version: 1,
      type: 'AttemptStarted',
      eventId: this.nextRuntimeEventId(),
      ...authoritativeInput,
      attemptId,
      fence,
    });
  }

  scheduleCheck(input: {
    sessionId: string;
    checkId: string;
    scope: ScopePath;
    attemptId: string;
    fence: number;
  }): CheckScheduledEvent {
    const plan = this.requireClaimPlan();
    const claimIds = exactActiveClaimIds(plan, this.claimProjection, input.checkId);
    return this.appendRuntimeEvent({
      version: 1,
      type: 'CheckScheduled',
      eventId: this.nextRuntimeEventId(),
      sessionId: input.sessionId,
      checkId: input.checkId,
      scope: input.scope.map(part => ({ ...part })),
      attemptId: input.attemptId,
      fence: input.fence,
      claimIds: [...claimIds],
    });
  }

  private reconcileCatalog(input: {
    sessionId: string;
    expansion: CompiledExpansion;
    payload: unknown;
    catalogClaimId: string;
    startEventId: number;
    projection: InstanceProjection;
    parentSubgraphInstanceId: string | null;
    expansionOwnerNodeInstanceId?: string;
  }): { events: InstanceRuntimeEvent[]; projection: InstanceProjection } {
    const expansion = input.expansion;
    const nested = input.parentSubgraphInstanceId !== null;
    const parent = nested
      ? input.projection.instancesById[input.parentSubgraphInstanceId as string]
      : undefined;
    if (
      nested &&
      (!parent ||
        parent.status !== 'active' ||
        !input.expansionOwnerNodeInstanceId ||
        input.projection.nodesById[input.expansionOwnerNodeInstanceId]?.subgraphInstanceId !==
          parent.subgraphInstanceId)
    ) {
      throw new ClaimKernelError(
        'INVALID_NESTED_EXPANSION_OWNER',
        'Nested reconciliation requires one exact active parent and owner node'
      );
    }
    if (nested) {
      const catalog = input.projection.claimsById[input.catalogClaimId];
      const producer = catalog?.nodeGenerationId
        ? input.projection.generationsById[catalog.nodeGenerationId]
        : undefined;
      if (
        !catalog?.active ||
        catalog.kind !== 'generated-output' ||
        catalog.claim !== expansion.catalogClaimRef ||
        catalog.subgraphInstanceId !== parent!.subgraphInstanceId ||
        !producer ||
        producer.nodeInstanceId !== input.expansionOwnerNodeInstanceId ||
        producer.nestedExpansionCatalogClaimRef !== expansion.catalogClaimRef ||
        producer.status !== 'running' ||
        !producer.scheduled ||
        input.projection.activeGenerationIdByNode[producer.nodeInstanceId] !==
          producer.nodeGenerationId ||
        catalog.producerAttemptId !== producer.attemptId ||
        catalog.producerFence !== producer.fence
      ) {
        throw new ClaimKernelError(
          'INVALID_NESTED_CATALOG_LINEAGE',
          'Nested catalog must be the exact active output of its current fenced owner generation'
        );
      }
    }
    expansion.catalogValidator(input.payload);
    const rawItems = resolveJsonPointer(input.payload, expansion.itemsPointer);
    if (!Array.isArray(rawItems)) {
      throw new ClaimKernelError(
        'INVALID_CATALOG_ITEMS',
        'Catalog items pointer must resolve to an array'
      );
    }
    const items = new Map<string, unknown>();
    for (const item of rawItems) {
      expansion.itemValidator(item);
      const key = canonicalCatalogKey(resolveJsonPointer(item, expansion.keyPointer));
      if (items.has(key)) {
        throw new ClaimKernelError('DUPLICATE_CATALOG_KEY', `Duplicate catalog key ${key}`);
      }
      items.set(key, immutableCanonicalValue(item));
    }

    let projection = input.projection;
    const events: InstanceRuntimeEvent[] = [];
    let nextId = input.startEventId;
    const stage = (event: StagedInstanceRuntimeEvent): void => {
      const stored = immutableInstanceEvent({ ...event, eventId: nextId++ });
      projection = reduceInstanceEvent(projection, stored);
      events.push(stored);
    };

    const allByKey = new Map(
      Object.values(input.projection.instancesById)
        .filter(instance =>
          instance.expansionOwnerCheck === expansion.expansionOwnerCheck &&
          (instance.parentSubgraphInstanceId || null) === input.parentSubgraphInstanceId &&
          (!nested ||
            instance.expansionOwnerNodeInstanceId === input.expansionOwnerNodeInstanceId)
        )
        .map(instance => [instance.itemKey, instance] as const)
    );
    const active = [...allByKey.values()].filter(instance => instance.status === 'active');
    const sortedItems = [...items.entries()].sort(([left], [right]) => left.localeCompare(right));

    for (const [key] of sortedItems) {
      if (!nested && allByKey.get(key)?.status === 'tombstoned') {
        throw new ClaimKernelError(
          'TOMBSTONED_KEY_READD_UNSUPPORTED',
          `Key ${key} was tombstoned`
        );
      }
    }

    const changed = sortedItems.filter(([key, item]) => {
      const instance = allByKey.get(key);
      if (!instance?.activeItemClaimId || instance.status !== 'active') return false;
      return (
        input.projection.claimsById[instance.activeItemClaimId].payloadFingerprint !==
          deriveItemFingerprint(item) ||
        (nested && instance.catalogClaimId !== input.catalogClaimId)
      );
    });
    const revived = nested
      ? sortedItems.filter(([key]) => allByKey.get(key)?.status === 'tombstoned')
      : [];
    const added = sortedItems.filter(([key]) => !allByKey.has(key));

    const activateSources = (
      instanceId: string,
      itemFingerprint: string
    ): void => {
      const instance = projection.instancesById[instanceId];
      for (const nodeKey of expansion.template.sourceNodeKeys) {
        const node = expansion.template.nodesByKey[nodeKey];
        const nestedCatalogClaimRef = this.requireClaimPlan().expansionPlan!.byNestedOwner[
          qualifiedNestedExpansionOwner(expansion.template.name, nodeKey)
        ]?.catalogClaimRef;
        const inputIds: string[] = [];
        let ready = true;
        for (const consumption of node.consumptions) {
          const matches = Object.values(projection.claimsById)
            .filter(claim =>
              claim.active &&
              claim.subgraphInstanceId === instance.subgraphInstanceId &&
              claim.incarnation === instance.incarnation &&
              claim.claim === consumption.claim
            )
            .sort((left, right) => left.claimId.localeCompare(right.claimId));
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
          activeInputClaimIds: inputIds,
        });
        stage({
          version: 1,
          type: 'NodeGenerationActivated',
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
          ...(nestedCatalogClaimRef
            ? { nestedExpansionCatalogClaimRef: nestedCatalogClaimRef }
            : {}),
        });
      }
    };

    const publishItemAndActivateSources = (
      instanceId: string,
      key: string,
      item: unknown
    ): void => {
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
        scope: instance.scope,
      });
      stage({
        version: 1,
        type: 'ControllerItemClaimPublished',
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
        parentClaimIds: [input.catalogClaimId],
      });
      instance = projection.instancesById[instanceId];
      activateSources(instance.subgraphInstanceId, payloadFingerprint);
    };

    const tombstoneTree = (instanceId: string, sourceCatalogClaimId: string): void => {
      const descendants = Object.values(projection.instancesById)
        .filter(candidate =>
          candidate.status === 'active' &&
          candidate.parentSubgraphInstanceId === instanceId
        )
        .sort((left, right) => left.itemKey.localeCompare(right.itemKey));
      for (const descendant of descendants) {
        tombstoneTree(descendant.subgraphInstanceId, descendant.catalogClaimId);
      }
      const instance = projection.instancesById[instanceId];
      const generations = Object.values(projection.generationsById)
        .filter(generation =>
          generation.subgraphInstanceId === instance.subgraphInstanceId &&
          generation.status !== 'inactive'
        )
        .sort((left, right) => left.nodeGenerationId.localeCompare(right.nodeGenerationId));
      stage({
        version: 1,
        type: 'SubgraphTombstoned',
        sessionId: input.sessionId,
        scope: instance.scope,
        expansionOwnerCheck: instance.expansionOwnerCheck,
        sourceCatalogClaimId,
        itemKey: instance.itemKey,
        subgraphInstanceId: instance.subgraphInstanceId,
        lastIncarnation: instance.incarnation,
        nodeGenerationIds: generations.map(value => value.nodeGenerationId).sort(),
        outputClaimIds: generations.flatMap(value => value.completedOutputClaimIds).sort(),
      });
    };
    const tombstoneDescendants = (instanceId: string): void => {
      const descendants = Object.values(projection.instancesById)
        .filter(candidate =>
          candidate.status === 'active' &&
          candidate.parentSubgraphInstanceId === instanceId
        )
        .sort((left, right) => left.itemKey.localeCompare(right.itemKey));
      for (const descendant of descendants) {
        tombstoneTree(descendant.subgraphInstanceId, descendant.catalogClaimId);
      }
    };

    for (const instance of active
      .filter(candidate => !items.has(candidate.itemKey))
      .sort((left, right) => left.itemKey.localeCompare(right.itemKey))) {
      tombstoneTree(instance.subgraphInstanceId, input.catalogClaimId);
    }

    for (const [key, item] of changed) {
      let instance = projection.instancesById[allByKey.get(key)!.subgraphInstanceId];
      tombstoneDescendants(instance.subgraphInstanceId);
      for (const nodeKey of expansion.template.reverseTopology) {
        const nodeInstanceId = instance.nodeInstanceIdsByTemplateNode[nodeKey];
        const generationId = projection.activeGenerationIdByNode[nodeInstanceId];
        if (!generationId) continue;
        const generation = projection.generationsById[generationId];
        stage({
          version: 1,
          type: 'NodeGenerationInactivated',
          sessionId: input.sessionId,
          scope: instance.scope,
          subgraphInstanceId: instance.subgraphInstanceId,
          nodeInstanceId,
          nodeGenerationId: generationId,
          incarnation: generation.incarnation,
          outputClaimIds: [...generation.completedOutputClaimIds].sort(),
          reason: 'superseded',
        });
        instance = projection.instancesById[instance.subgraphInstanceId];
      }
      publishItemAndActivateSources(instance.subgraphInstanceId, key, item);
    }

    for (const [key, item] of revived) {
      const instance = projection.instancesById[allByKey.get(key)!.subgraphInstanceId];
      publishItemAndActivateSources(instance.subgraphInstanceId, key, item);
    }

    for (const [key, item] of added) {
      const subgraphInstanceId = nested
        ? deriveSubgraphInstanceId({
            graphSemanticDigest: expansion.graphSemanticDigest,
            parentSubgraphInstanceId: parent!.subgraphInstanceId,
            expansionOwnerNodeInstanceId: input.expansionOwnerNodeInstanceId as string,
            templateDigest: expansion.templateDigest,
            itemKey: key,
          })
        : deriveSubgraphInstanceId({
            graphSemanticDigest: expansion.graphSemanticDigest,
            expansionOwnerCheck: expansion.expansionOwnerCheck,
            parentSubgraphInstanceId: null,
            templateDigest: expansion.templateDigest,
            itemKey: key,
          });
      const scope: KeyedScopePath = Object.freeze([
        ...(nested ? parent!.scope : []),
        {
          kind: 'keyed' as const,
          expansionOwnerCheck: expansion.expansionOwnerCheck,
          key,
          subgraphInstanceId,
        },
      ]) as KeyedScopePath;
      stage({
        version: 1,
        type: 'SubgraphExpanded',
        sessionId: input.sessionId,
        scope,
        expansionOwnerCheck: expansion.expansionOwnerCheck,
        graphSemanticDigest: expansion.graphSemanticDigest,
        expansionSpecDigest: expansion.expansionSpecDigest,
        templateDigest: expansion.templateDigest,
        parentSubgraphInstanceId: input.parentSubgraphInstanceId,
        ...(nested
          ? {
              expansionOwnerNodeInstanceId: input.expansionOwnerNodeInstanceId as string,
              catalogClaimRef: expansion.catalogClaimRef,
            }
          : {}),
        catalogClaimId: input.catalogClaimId,
        itemKey: key,
        subgraphInstanceId,
        nodeInstanceIdsByTemplateNode: Object.fromEntries(
          expansion.template.templateNodeKeys.map(nodeKey => [
            nodeKey,
            deriveNodeInstanceId({ subgraphInstanceId, templateNodeKey: nodeKey }),
          ])
        ),
      });
      publishItemAndActivateSources(subgraphInstanceId, key, item);
    }

    return { events, projection };
  }

  completeAttempt(input: {
    sessionId: string;
    checkId: string;
    scope: ScopePath;
    attemptId: string;
    fence: number;
    payload: unknown;
  }): {
    readonly claims: readonly CandidateClaimInput[];
    readonly completed: AttemptCompletedEvent;
  } {
    const plan = this.requireClaimPlan();
    const scheduled = this.claimProjection.scheduled.find(
      event =>
        event.sessionId === input.sessionId &&
        event.checkId === input.checkId &&
        event.attemptId === input.attemptId &&
        event.fence === input.fence &&
        canonicalJson(event.scope) === canonicalJson(input.scope)
    );
    if (!scheduled) {
      throw new ClaimKernelError(
        'ATTEMPT_NOT_SCHEDULED',
        `Attempt ${input.attemptId} was not scheduled before terminal processing`
      );
    }

    let stagedProjection = this.claimProjection;
    const stagedEvents: ClaimRuntimeEvent[] = [];
    const claimIds: string[] = [];
    for (const emission of plan.emissionsByCheck[input.checkId] || []) {
      const built = buildClaimPublishedEvent({
        eventId: Math.max(stagedProjection.lastEventId, this.instanceProjection.lastEventId, ...stagedEvents.map(event => event.eventId)) + 1,
        sessionId: input.sessionId,
        checkId: input.checkId,
        scope: input.scope,
        attemptId: input.attemptId,
        fence: input.fence,
        claim: emission.claim,
        payload: input.payload,
        parentClaimIds: scheduled.claimIds,
        projection: stagedProjection,
        plan,
      });
      const event = immutableRuntimeEvent(built);
      stagedProjection = reduceClaimEvent(stagedProjection, event, plan);
      stagedEvents.push(event);
      claimIds.push(event.claimId);
    }

    const rootExpansion = plan.expansionPlan?.byOwner[input.checkId];
    const catalogClaimId = claimIds.find(id =>
      stagedProjection.claims[id]?.claim === rootExpansion?.catalogClaimRef
    );
    const reconciled = catalogClaimId && rootExpansion
      ? this.reconcileCatalog({
          sessionId: input.sessionId,
          expansion: rootExpansion,
          payload: input.payload,
          catalogClaimId,
          startEventId: Math.max(stagedProjection.lastEventId, this.instanceProjection.lastEventId) + 1,
          projection: this.instanceProjection,
          parentSubgraphInstanceId: null,
        })
      : { events: [] as InstanceRuntimeEvent[], projection: this.instanceProjection };
    const requestId = this.instanceProjection.attemptBindingsById[input.attemptId];
    const selectedItems = requestId
      ? Object.values(reconciled.projection.instancesById)
          .filter(instance =>
            instance.sessionId === input.sessionId &&
            instance.expansionOwnerCheck === input.checkId &&
            !instance.parentSubgraphInstanceId &&
            instance.status === 'active'
          )
          .map(instance => {
            const item = instance.activeItemClaimId
              ? reconciled.projection.claimsById[instance.activeItemClaimId]
              : undefined;
            if (!item?.active) {
              throw new ClaimKernelError('INACTIVE_ITEM_CLAIM',
                `Catalog request ${requestId} lacks active lineage for ${instance.itemKey}`);
            }
            return { key: instance.itemKey, itemFingerprint: item.payloadFingerprint };
          })
          .sort((left, right) => left.key.localeCompare(right.key))
      : undefined;
    if (requestId && !catalogClaimId) {
      throw new ClaimKernelError('INVALID_REQUEST_CATALOG',
        `Catalog request ${requestId} did not publish its configured catalog claim`);
    }

    const completed = immutableRuntimeEvent({
      version: 1,
      type: 'AttemptCompleted',
      eventId: Math.max(stagedProjection.lastEventId, reconciled.projection.lastEventId) + 1,
      sessionId: input.sessionId,
      checkId: input.checkId,
      scope: input.scope.map(part => ({ ...part })),
      attemptId: input.attemptId,
      fence: input.fence,
      ...(requestId
        ? { requestId, catalogClaimId: catalogClaimId as string, selectedItems: selectedItems! }
        : {}),
    });
    stagedProjection = reduceClaimEvent(stagedProjection, completed, plan);
    stagedEvents.push(completed);

    const finalInstanceProjection = requestId
      ? reduceInstanceEvent(reconciled.projection, completed as any)
      : reconciled.projection;

    this.runtimeEvents.push(...stagedEvents.slice(0, -1), ...reconciled.events, completed);
    this.claimProjection = stagedProjection;
    this.instanceProjection = finalInstanceProjection;
    return Object.freeze({
      claims: Object.freeze(claimIds.map(claimId => stagedProjection.claims[claimId])),
      completed,
    });
  }

  failAttempt(input: {
    sessionId: string;
    checkId: string;
    scope: ScopePath;
    attemptId: string;
    fence: number;
    reason: string;
  }): AttemptFailedEvent {
    const requestId = this.instanceProjection.attemptBindingsById[input.attemptId];
    const event = immutableRuntimeEvent({
      sessionId: input.sessionId,
      checkId: input.checkId,
      attemptId: input.attemptId,
      fence: input.fence,
      reason: input.reason,
      version: 1,
      type: 'AttemptFailed',
      eventId: this.nextRuntimeEventId(),
      scope: input.scope.map(part => ({ ...part })),
      ...(requestId ? { requestId } : {}),
    });
    const claim = reduceClaimEvent(this.claimProjection, event, this.requireClaimPlan());
    const instance = requestId
      ? reduceInstanceEvent(this.instanceProjection, event as any)
      : this.instanceProjection;
    this.runtimeEvents.push(event); this.claimProjection = claim; this.instanceProjection = instance;
    return event;
  }

  readRuntimeEvents(): readonly (ClaimRuntimeEvent | InstanceRuntimeEvent)[] {
    return immutableCanonicalValue(this.runtimeEvents);
  }

  getClaimProjection(): ClaimProjection {
    return immutableCanonicalValue(this.claimProjection);
  }

  replayClaimProjection(): ClaimProjection {
    return replayClaimEvents(
      this.readRuntimeEvents().filter(event =>
        ['AttemptStarted','ClaimPublished','CheckScheduled','AttemptCompleted','AttemptFailed'].includes(event.type) &&
        !('nodeGenerationId' in event)
      ) as ClaimRuntimeEvent[],
      this.requireClaimPlan()
    );
  }

  isCheckReady(checkId: string): boolean {
    try {
      exactActiveClaimIds(this.requireClaimPlan(), this.claimProjection, checkId);
      return true;
    } catch (error) {
      if (error instanceof ClaimKernelError && error.code === 'CLAIM_NOT_READY') return false;
      throw error;
    }
  }

  readCheckClaims(checkId: string): Readonly<Record<string, CandidateClaimInput>> {
    const plan = this.requireClaimPlan();
    const claimIds = exactActiveClaimIds(plan, this.claimProjection, checkId);
    const selected: Record<string, CandidateClaimInput> = {};
    for (const [index, consumption] of (plan.consumptionsByCheck[checkId] || []).entries()) {
      const claimId = claimIds[index];
      const claim = this.claimProjection.claims[claimId];
      if (claim) selected[consumption.claim] = claim;
    }
    return Object.freeze(selected);
  }

  // Lightweight helpers for debugging/metrics
  size(): number {
    return this.entries.length;
  }
}

export class ContextView {
  constructor(
    private journal: ExecutionJournal,
    private sessionId: string,
    private snapshotId: number,
    private scope: ScopePath,
    private event?: EventTrigger
  ) {}

  /** Return the nearest result for a check in this scope (exact item → ancestor → latest). */
  get(checkId: string): (ReviewSummary & { output?: unknown; content?: string }) | undefined {
    const visible = this.journal
      .readVisible(this.sessionId, this.snapshotId, this.event)
      .filter(e => e.checkId === checkId);
    if (visible.length === 0) return undefined;

    // exact scope match: prefer the most recent commit for this scope
    const exactMatches = visible.filter(e => this.sameScope(e.scope, this.scope));
    if (exactMatches.length > 0) {
      return exactMatches[exactMatches.length - 1].result;
    }

    // nearest ancestor (shortest distance)
    let best: { entry: JournalEntry; dist: number } | undefined;
    for (const e of visible) {
      const dist = this.ancestorDistance(e.scope, this.scope);
      if (dist >= 0 && (best === undefined || dist < best.dist)) {
        best = { entry: e, dist };
      }
    }
    if (best) return best.entry.result;

    // fallback to latest committed result
    return visible[visible.length - 1]?.result;
  }

  /** Return an aggregate (raw) result – the shallowest scope for this check. */
  getRaw(checkId: string): (ReviewSummary & { output?: unknown; content?: string }) | undefined {
    const visible = this.journal
      .readVisible(this.sessionId, this.snapshotId, this.event)
      .filter(e => e.checkId === checkId);
    if (visible.length === 0) return undefined;
    let shallow = visible[0];
    for (const e of visible) {
      if (e.scope.length < shallow.scope.length) shallow = e;
    }
    return shallow.result;
  }

  /** All results for a check up to this snapshot. */
  getHistory(checkId: string): Array<ReviewSummary & { output?: unknown; content?: string }> {
    return this.journal
      .readVisible(this.sessionId, this.snapshotId, this.event)
      .filter(e => e.checkId === checkId)
      .map(e => e.result);
  }

  private sameScope(a: ScopePath, b: ScopePath): boolean {
    return canonicalJson(a) === canonicalJson(b);
  }

  // distance from ancestor to current; -1 if not ancestor
  private ancestorDistance(ancestor: ScopePath, current: ScopePath): number {
    if ([...ancestor, ...current].some(segment => (segment as any).kind === 'keyed')) {
      return this.sameScope(ancestor, current) ? 0 : -1;
    }
    if (ancestor.length > current.length) return -1;
    // Treat root scope ([]) as non-ancestor for unrelated branches
    if (ancestor.length === 0 && current.length > 0) return -1;
    for (let i = 0; i < ancestor.length; i++) {
      if (ancestor[i].check !== current[i].check || ancestor[i].index !== current[i].index)
        return -1;
    }
    return current.length - ancestor.length;
  }
}
