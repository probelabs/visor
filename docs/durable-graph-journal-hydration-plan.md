# Durable Graph Journal Hydration — Phase 1

## Outcome

In one implementation PR, make a completed Graph v2 `ExecutionJournal` portable
through one canonical JSON checkpoint and restorable into a fresh journal with:

- the exact runtime-event prefix;
- live claim and instance projections equal to pure replay;
- the original session, instance, claim, and generation identities; and
- the next fence, attempt ordinal, and catalog-request ordinal derived only from
  the validated prefix.

Phase 1 is complete when the focused unit suite below passes and the production
diff is limited to `src/snapshot-store.ts`. A type may be exported from that file
for its tests; no SDK, engine, runner, provider, or config surface changes belong
in this phase.

## Why this boundary

`ExecutionJournal` already owns the ordered `ClaimRuntimeEvent |
InstanceRuntimeEvent` stream and already proves live/replay equality through
`replayClaimEvents` and `replayInstanceEvents`. Instance identity is bound to the
compiled expansion's `graphSemanticDigest`; payloads and IDs already use
`canonicalJson`/`sha256Canonical`. Reusing those authorities keeps Phase 1 small
and falsifiable.

Engine snapshot v1 currently stores result-history entries and runner state, not
the Graph v2 runtime prefix or its allocator frontier. Folding engine or process
resume into this change would make a journal-corruption bug indistinguishable
from scheduling, provider, or lease behavior. Those consumers stay outside view
until the journal can independently round-trip and continue.

## Scope

Production owner:

- `src/snapshot-store.ts`

Test owner:

- `tests/unit/snapshot-store.test.ts`

No other file changes are planned. If TypeScript requires a separately exported
checkpoint type, export it from `src/snapshot-store.ts`; do not add an SDK export.

## Checkpoint v1

Add an immutable JSON value with this exact shape:

```ts
interface GraphJournalCheckpointV1 {
  kind: 'visor.graph-journal-checkpoint';
  version: 1;
  sessionId: string;
  graphSemanticDigest: string;
  frontier: {
    eventCount: number;
    lastEventId: number;
  };
  events: readonly (ClaimRuntimeEvent | InstanceRuntimeEvent)[];
  integrity: {
    algorithm: 'sha256';
    digest: string;
  };
}
```

The integrity digest is `sha256Canonical` of every field except `integrity`.
Export and restore accept no unknown keys, non-JSON values, alternate versions,
or alternate algorithms. `sessionId` is explicit because a future engine layer
must retain it; every event in a non-empty prefix must carry that exact session.

`frontier.eventCount` must equal `events.length`. Event IDs must be contiguous
from 1, and `frontier.lastEventId` must be 0 for an empty prefix or the final
event ID otherwise. These are observations, not trusted allocator state.

The checkpoint binds to `claimPlan.expansionPlan.graphSemanticDigest`. Restore
requires an active claim and expansion plan and exact digest equality before it
may install any state. SHA-256 here detects accidental corruption and wrong
artifacts; it is not a signature against an attacker who can rewrite and
re-hash the checkpoint.

## Journal API and validation order

Add `journal.exportGraphCheckpoint(sessionId)` and
`ExecutionJournal.restoreGraphCheckpoint(claimPlan, input: unknown)`. Export
returns deeply immutable canonical data; restore returns a new
`ExecutionJournal` only after every gate passes.

Restore must fail fast, without partially mutating a returned or caller-owned
journal, in this order:

1. Validate exact envelope shape, JSON/canonical representability, kind, version,
   algorithm, session, and frontier scalar ranges.
2. Recompute and compare the integrity digest.
3. Compare the checkpoint and current-plan `graphSemanticDigest`.
4. Validate contiguous event IDs and the exact single-session prefix.
5. Replay root claim events with `replayClaimEvents(events, claimPlan)` using the
   journal's existing root-event filter.
6. Replay instance events with `replayInstanceEvents(events)` using the journal's
   existing instance-event filter and atomic managed-run batch grammar.
7. Require a quiescent frontier: no started root attempt, pending/running catalog
   request, ready/running node generation, or acquired/started/cancel-requested
   managed run. Phase 1 checkpoints completed expansion state only.
8. Reconstruct allocator maps and the next fence from the ordered events, then
   atomically install the immutable prefix, both replayed projections, and the
   derived allocators in the fresh journal.

Use a dedicated checkpoint error with these stable codes:
`INVALID_CHECKPOINT_ENVELOPE`, `CHECKPOINT_INTEGRITY_MISMATCH`,
`CHECKPOINT_GRAPH_MISMATCH`, `INVALID_CHECKPOINT_PREFIX`,
`CHECKPOINT_SESSION_MISMATCH`, and `CHECKPOINT_NOT_QUIESCENT`. Preserve specific
claim/instance kernel failures as causes; never turn invalid replay into an empty
journal or partial success.

## Deterministic allocator reconstruction

Stored counters are forbidden. Derive all authority from validated events:

- `nextFence`: scan `AttemptStarted` events in event order. Their fences must be
  the journal-produced strict sequence `1..N`; set the restored frontier to `N`.
- Root and catalog attempt ordinals: group non-generated `AttemptStarted` events
  by `canonicalJson({ sessionId, checkId, scope })`, count them in event order,
  and verify each `attemptId` equals
  `sha256Canonical({ sessionId, checkId, scope, ordinal })`.
- Generated attempt ordinals: group generated `AttemptStarted` events by
  `canonicalJson({ nodeGenerationId, scope })`, count them in event order, and
  verify each `attemptId` equals
  `sha256Canonical({ nodeGenerationId, ordinal })`.
- Catalog request ordinals: group `CatalogReconciliationRequested` events by
  `expansionOwnerCheck`, require the event ordinal to be the next count, and
  retain the existing derived request-ID validation.

Reject gaps, regressions, duplicates, unsafe integers, or an attempt/request ID
that does not match its reconstructed ordinal. After restore, existing start and
request methods must allocate exactly the next ordinal and a fence of `N + 1`.

## Focused tests

Add table-driven tests beside the existing journal replay tests. Each assertion
must operate through the new checkpoint/restore surface rather than assigning
private fields.

1. **Exact JSON round trip.** Build a completed keyed expansion with generated
   claims, checkpoint it, pass it through `JSON.stringify`/`JSON.parse`, restore,
   and require exact event equality, identical claim/instance projections,
   live/replay equality, recursive immutability, and byte-identical canonical
   re-export including the integrity digest.
2. **Integrity and graph binding.** Independently alter an event payload, digest,
   `graphSemanticDigest`, kind/version, add an unknown key, and restore under a
   semantically different compiled graph. Each case must synchronously reject
   with its exact code before a journal is returned.
3. **Frontier grammar.** Cover empty and completed prefixes, mismatched
   event-count/last-event metadata, non-contiguous event IDs, mixed sessions,
   a prefix cut inside an atomic managed terminal batch, and otherwise valid
   prefixes ending with started attempts, pending/running requests, or
   ready/running generations. Only empty or quiescent completed prefixes restore.
4. **Stale fence remains stale.** Restore a completed prefix, begin the next
   authorized attempt, then submit a schedule/terminal operation carrying a
   pre-checkpoint attempt ID or fence. Require `STALE_FENCE` and no appended
   runtime event.
5. **Exact next fence and ordinals.** Restore a prefix containing the initial
   catalog attempt, generated attempts, and at least one reconciliation request.
   Require the next request ordinal/ID, next root/catalog attempt ordinal/ID,
   next generated attempt ordinal/ID, and every new fence to match canonical
   derivation from the prefix. Re-export/restore again and repeat once to exclude
   hidden process-local allocator state.

The implementation gate is:

```sh
npx jest tests/unit/snapshot-store.test.ts --runInBand
```

Also require the focused file to type-check under the repository's normal test
compilation. No broad suite is required until a later engine integration phase.

## Fail-fast review gates

- No counter, projection, or integrity digest supplied by the checkpoint is
  trusted without reconstruction or replay.
- No provider, model, network, filesystem, timer, or engine callback is invoked.
- Restore is all-or-nothing and does not mutate the input checkpoint.
- Existing live/replay reducers remain the sole projection authority; do not add
  a second reducer or deserialize projections directly.
- Existing canonical hashing and `graphSemanticDigest` remain the sole identity
  and graph-binding authorities.
- The production/test file allowlist is enforced in review.

## Nonclaims deferred beyond Phase 1

- No `StateMachineExecutionEngine`, `StateMachineRunner`, wave, or process resume.
- No integration with `saveSnapshotToFile`, `loadSnapshotFromFile`, Slack, or SDK.
- No mid-attempt/provider resume and no managed handle, sandbox, lease, cancel,
  cleanup, or external-resource resurrection.
- No multi-writer journal, locking, replication, storage adapter, compaction, or
  partial-prefix streaming.
- No graph migration or compatibility across a changed `graphSemanticDigest`.
- No cryptographic authenticity, confidentiality, secret storage, or key
  management.
- No claim that a restored journal alone makes a completed engine run live; that
  is the explicit subject of a later integration phase.
