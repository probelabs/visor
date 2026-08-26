import fs from 'fs';
import path from 'path';
import * as yaml from 'js-yaml';
import { StateMachineExecutionEngine } from '../../src/state-machine-execution-engine';
import { ExecutionJournal } from '../../src/snapshot-store';
import { compileClaimPlan } from '../../src/state-machine/graph/claim-plan';
import {
  projectExpansionCoverage,
  replayInstanceEvents,
  type ExpansionCoverageClass,
} from '../../src/state-machine/graph/instance-kernel';
import { sha256Canonical } from '../../src/state-machine/graph/claim-kernel';
import type { VisorConfig } from '../../src/types/config';

type Mode = ExpansionCoverageClass | 'running';
type Item = { id: string; mode: Mode; revision: number };

function config(): VisorConfig {
  const fixture = path.join(__dirname, '../fixtures/graph-v2/expansion-coverage.yaml');
  return yaml.load(fs.readFileSync(fixture, 'utf8')) as VisorConfig;
}

function startJournal(): ExecutionJournal {
  return new ExecutionJournal(compileClaimPlan(config()));
}

function runRequest(
  journal: ExecutionJournal,
  items: Item[],
  completionOrder = items.map(item => item.id)
): string {
  const request = journal.requestCatalogReconciliation({
    sessionId: 'exp-0147',
    ownerCheck: 'discover-operations',
  });
  const catalogAttempt = journal.startCatalogRequestAttempt(request.requestId);
  journal.scheduleCatalogRequestAttempt(catalogAttempt);
  journal.completeAttempt({
    ...catalogAttempt,
    payload: { operations: items },
  });
  const byKey = new Map(items.map(item => [item.id, item]));
  const ready = new Map(
    journal
      .queryReadyWork()
      .map(generation => [generation.scope[generation.scope.length - 1].key, generation])
  );
  for (const key of completionOrder) {
    const item = byKey.get(key)!;
    const generation = ready.get(key);
    if (!generation) continue;
    const attempt = journal.startGeneratedAttempt(generation.nodeGenerationId);
    journal.scheduleGeneratedAttempt(attempt);
    if (item.mode === 'running') continue;
    if (item.mode === 'error') {
      journal.failGeneratedAttempt(attempt, 'DETERMINISTIC_ERROR');
      continue;
    }
    if (item.mode === 'cancelled') {
      const binding = journal.deriveManagedRunBinding(attempt);
      journal.recordManagedRunAcquired(binding);
      journal.recordManagedRunStarted(binding);
      journal.recordManagedRunCancelRequested(binding);
      journal.failManagedGeneratedAttempt({
        attempt,
        binding,
        cleanupStatus: 'clean',
        failureCode: 'MANAGED_DEADLINE_EXCEEDED',
      });
      continue;
    }
    journal.completeGeneratedAttempt({ attempt, payload: { class: item.mode } });
  }
  return request.requestId;
}

function expectReplay(journal: ExecutionJournal, requestId: string) {
  const live = journal.getExpansionCoverageProjection(requestId);
  expect(journal.replayExpansionCoverageProjection(requestId)).toEqual(live);
  return live;
}

describe('EXP-0147 expansion coverage projection', () => {
  it('compiles only a declared sink outcome and strict class pointer', () => {
    const valid = compileClaimPlan(config()).expansionPlan.byOwner['discover-operations'];
    expect(valid.coverage).toMatchObject({
      outcomeClaimRef: 'operation.outcome@1',
      emitterNodeKey: 'assess',
      classPointer: { source: '/class', tokens: ['class'] },
    });

    const invalidPointer = config();
    invalidPointer.checks!['discover-operations'].expand!.coverage!.class_pointer = 'class';
    expect(() => compileClaimPlan(invalidPointer)).toThrow(
      expect.objectContaining({ code: 'INVALID_JSON_POINTER' })
    );

    const nonSink = config();
    nonSink.subgraphs!['assess-operation'].checks.after = {
      type: 'noop',
      consumes: [{ claim: 'operation.outcome@1', as: 'outcome' }],
    };
    expect(() => compileClaimPlan(nonSink)).toThrow(
      expect.objectContaining({ code: 'INVALID_COVERAGE_OUTCOME_EMITTER' })
    );
  });

  it('exposes a closed clean two-item projection through the public engine and replay APIs', () => {
    const journal = startJournal();
    const requestId = runRequest(journal, [
      { id: 'A', mode: 'completed_clean', revision: 1 },
      { id: 'B', mode: 'completed_clean', revision: 1 },
    ]);
    const engine = new StateMachineExecutionEngine();
    (engine as any)._lastContext = { journal };
    const live = engine.getExpansionCoverageProjection(requestId);
    expect(live).toMatchObject({ closure: 'closed', disposition: 'clean', terminalItems: 2 });
    expect(live.items.map(item => item.key)).toEqual(['A', 'B']);
    expect(journal.replayExpansionCoverageProjection(requestId)).toEqual(live);
  });

  it('accounts for every terminal class with fail-closed disposition precedence', () => {
    const journal = startJournal();
    const classes: ExpansionCoverageClass[] = [
      'completed_clean',
      'completed_with_findings',
      'error',
      'guardrail_blocked',
      'cancelled',
    ];
    const requestId = runRequest(
      journal,
      classes.map((mode, index) => ({ id: String(index), mode, revision: 1 }))
    );
    const projection = expectReplay(journal, requestId);
    expect(projection).toMatchObject({
      closure: 'closed',
      disposition: 'unverifiable',
      terminalItems: 5,
    });
    expect(projection.items.map(item => item.terminalClass)).toEqual(classes);
  });

  it('is open for running work, order-independent, and closes an empty catalog cleanly', () => {
    const running = startJournal();
    const runningId = runRequest(running, [{ id: 'A', mode: 'running', revision: 1 }]);
    expect(expectReplay(running, runningId)).toMatchObject({
      closure: 'open',
      disposition: 'unverifiable',
    });

    const items: Item[] = [
      { id: 'A', mode: 'completed_clean', revision: 1 },
      { id: 'B', mode: 'completed_with_findings', revision: 1 },
    ];
    const forward = startJournal();
    const reverse = startJournal();
    const forwardProjection = expectReplay(forward, runRequest(forward, items, ['A', 'B']));
    const reverseProjection = expectReplay(reverse, runRequest(reverse, items, ['B', 'A']));
    expect(reverseProjection.semanticDigest).toBe(forwardProjection.semanticDigest);
    expect(reverseProjection.items).toEqual(forwardProjection.items);

    const empty = startJournal();
    const emptyId = runRequest(empty, []);
    expect(empty.queryReadyWork()).toHaveLength(0);
    expect(expectReplay(empty, emptyId)).toMatchObject({
      closure: 'closed',
      disposition: 'clean',
      terminalItems: 0,
    });
  });

  it('fails closed for unknown, mismatched-lineage, missing, and duplicate terminal facts', () => {
    const unknown = startJournal();
    const oldUnknownId = runRequest(unknown, [{ id: 'A', mode: 'completed_clean', revision: 1 }]);
    runRequest(unknown, [
      { id: 'A', mode: 'completed_clean', revision: 1 },
      { id: 'B', mode: 'completed_clean', revision: 1 },
    ]);
    expect(expectReplay(unknown, oldUnknownId).closure).toBe('open');

    const mismatch = startJournal();
    const oldMismatchId = runRequest(mismatch, [{ id: 'A', mode: 'completed_clean', revision: 1 }]);
    runRequest(mismatch, [{ id: 'A', mode: 'completed_clean', revision: 2 }]);
    expect(expectReplay(mismatch, oldMismatchId).diagnostics).toContain('A:lineage');

    const missing = startJournal();
    const missingId = runRequest(missing, [{ id: 'A', mode: 'running', revision: 1 }]);
    expect(expectReplay(missing, missingId).closure).toBe('open');

    const duplicate = startJournal();
    const duplicateId = runRequest(duplicate, [{ id: 'A', mode: 'completed_clean', revision: 1 }]);
    const events = (duplicate.readRuntimeEvents() as readonly any[]).filter(
      event =>
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
        'nodeGenerationId' in event ||
        'requestId' in event
    );
    const claimIndex = events.findIndex(
      event => event.type === 'ClaimPublished' && event.claim === 'operation.outcome@1'
    );
    const original = events[claimIndex];
    const payload = { class: 'completed_with_findings' };
    const payloadFingerprint = sha256Canonical(payload);
    const extra = {
      ...original,
      eventId: original.eventId + 1,
      payload,
      payloadFingerprint,
      claimId: sha256Canonical({
        claim: original.claim,
        payloadFingerprint,
        producerCheckId: original.checkId,
        scope: original.scope,
        attemptId: original.attemptId,
        fence: original.fence,
        parentClaimIds: original.parentClaimIds,
      }),
    };
    const replayed = replayInstanceEvents([
      ...events.slice(0, claimIndex + 1),
      extra,
      ...events.slice(claimIndex + 1).map(event => ({ ...event, eventId: event.eventId + 1 })),
    ]);
    const expansion = compileClaimPlan(config()).expansionPlan.byOwner['discover-operations'];
    expect(projectExpansionCoverage(replayed, expansion, duplicateId)).toMatchObject({
      closure: 'open',
      disposition: 'unverifiable',
    });
  });
});
