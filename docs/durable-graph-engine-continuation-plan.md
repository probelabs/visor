# Durable Graph Engine Continuation — Phase 2

## North Star and stop condition

Phase 1 made a quiescent Graph v2 runtime-event prefix portable. Phase 2 must
connect that proof to the real scheduler: after the producing process exits, a
new OS process accepts the JSON checkpoint, runs one changed catalog owner and
only the affected keyed closure, and returns the next portable checkpoint. That
is the smallest causal proof that durable graph evidence produces incremental
work reuse rather than merely reconstructing an in-memory projection.

Stop instead of widening the feature if one bounded child-process test cannot
prove same-prefix continuation through the existing journal, claim scheduler,
and provider path. Do not add generic runner serialization, lease recovery, a
second projection format, or process supervision to make the test pass.

## Measurable outcome

One implementation PR adds an engine-level continuation operation which:

- restores an accepted, quiescent `GraphJournalCheckpointV1` in a genuinely
  fresh OS process under the exact compiled graph;
- retains the checkpoint session and its complete event prefix, including all
  existing instance, claim, node, and generation IDs;
- queues exactly one reconciliation request for one compiled root expansion
  owner;
- enters a fresh `StateMachineRunner` at `LevelDispatch`, wave 1, so the owner
  runs once and the journal releases only newly ready affected generations;
- never starts a completed unchanged generation;
- appends event IDs, request/root-attempt ordinals, generated attempt IDs, and
  global fences monotonically from the restored prefix; and
- returns the `ExecutionResult`, request ID, and a quiescent checkpoint which
  can be JSON-round-tripped and continued again by another fresh process.

“Changed catalog” means changed provider output under the same compiled graph,
not a changed `VisorConfig` or `graphSemanticDigest`. There is no separate
journal-ID field to preserve; the durable identity is the exact event prefix,
its session, and the IDs carried by that prefix.

## Public contract

Add one narrowly named method to the already SDK-exported
`StateMachineExecutionEngine`:

```ts
export interface GraphCheckpointContinuationInput {
  checkpoint: unknown;
  expansionOwnerCheck: string;
  config: VisorConfig;
  prInfo: PRInfo;
  debug?: boolean;
  maxParallelism?: number;
  failFast?: boolean;
}

export interface GraphCheckpointContinuationResult {
  requestId: string;
  result: ExecutionResult;
  checkpoint: GraphJournalCheckpointV1;
}

continueGraphCheckpoint(
  input: GraphCheckpointContinuationInput
): Promise<GraphCheckpointContinuationResult>;
```

The method is intentionally not named `resume`: it performs exactly one root
catalog reconciliation from a completed Graph checkpoint. It does not accept a
serialized `RunState`, requested checks, multiple owners, or a legacy journal.
Export the input/result types and `GraphJournalCheckpointV1` from `src/sdk.ts`
only as type exports; add no second SDK execution wrapper.

## Production scope

- `src/state-machine/context/build-engine-context.ts`
  - accept a private optional Graph-checkpoint bootstrap;
  - compile the supplied config first, restore with
    `ExecutionJournal.restoreGraphCheckpoint`, then read the now-validated
    checkpoint session and bind both journal and `sessionId`;
  - perform that binding before creating `MemoryStore` or the shared
    `FairConcurrencyLimiter`, whose closures capture `sessionId`.
- `src/state-machine-execution-engine.ts`
  - add the public operation and its private continuation bootstrap;
  - place all checkpoint/owner gates before custom-tool registration, memory or
    workspace initialization, sandbox/policy/frontend setup, provider execution,
    or installation of `_lastContext`/`_lastRunner`;
  - reuse the existing post-context setup, runner, and cleanup path rather than
    copying a second engine lifecycle;
  - seed the fresh runner and export the returned checkpoint after it drains.
- `src/state-machine/runner.ts`
  - make the initial observer event a self-transition of the actual seeded
    state, not the hard-coded `Init -> Init` event.
- `src/sdk.ts`
  - type-only exports for the new engine contract and checkpoint type.

Test scope:

- `tests/engine/durable-graph-engine-continuation.test.ts`
- `tests/fixtures/durable-graph-engine-continuation-child.ts`

Do not change `src/snapshot-store.ts`, the reducers, `wave-planning.ts`,
`level-dispatch.ts`, provider implementations, legacy snapshot functions, or
`RunState`. The `src/sdk.ts` change is type-only; no facade or runtime export
logic is added. Any need to change scheduler/reducer behavior triggers the stop
condition and a separate review rather than scope growth.

## Restore and fail-fast transaction

Use this exact order for the continuation branch:

1. Deep-clone config and compile the exact claim/expansion plan as today.
2. Call `ExecutionJournal.restoreGraphCheckpoint(claimPlan, input.checkpoint)`.
   Do not duplicate envelope, integrity, graph, replay, quiescence, or allocator
   validation in the engine.
3. Only after restore succeeds, read `sessionId` from the validated checkpoint,
   install that journal/session in the local context, and then create any
   session-capturing limiter. Never build with a generated session and overwrite
   it later.
4. Immediately call the restored journal's
   `requestCatalogReconciliation({ sessionId, ownerCheck })` once. This reuses
   the compiled-plan owner check and its `UNKNOWN_EXPANSION_OWNER` error and
   records the request as the first suffix event. Do not call the public runner
   request API, which correctly rejects an inactive runner.
5. Retain the returned `requestId` in the per-call bootstrap result. There must
   be no second request insertion in the runner or scheduler.
6. Only after steps 1–5 succeed, initialize `context.memory` explicitly (the
   continuation skips `Init`), run `initializeWorkspace(context)`, and perform
   the existing custom-tool, sandbox, policy, frontend, and execution-context
   setup.
7. Construct a fresh runner, seed only the fixed continuation state below, then
   install `_lastContext` and `_lastRunner` immediately before `run()`.
8. Reuse the normal `finally` cleanup for frontends, sessions, policy, workspace,
   and sandboxes. Once the runner finishes, export with
   `context.journal.exportGraphCheckpoint(context.sessionId)` and return it with
   the request ID and execution result.

The post-context engine lifecycle may be mechanically extracted into one private
helper so normal execution and continuation share setup/cleanup. Its normal-run
branch must be behavior-preserving. Do not introduce an externally visible
optional continuation argument on `executeGroupedChecks`, mutable engine-wide
bootstrap state, or a second copied lifecycle.

On corrupt, graph-mismatched, nonquiescent, or unknown-owner input:

- preserve the existing exact error code;
- make zero provider calls;
- do not initialize memory or workspace;
- do not register tools or start sandbox, policy, or frontend services; and
- leave `_lastContext` and `_lastRunner` unset, so projection/reconciliation
  access still fails with `RUN_NOT_ACTIVE`.

## Fixed runner entry

Create a new `StateMachineRunner(context)` and derive the continuation state
from its fresh default, changing only:

```ts
currentState: 'LevelDispatch'
wave: 1
```

Before `setState`, assert/construct the rest of the state as the fresh empty
frontier: empty `levelQueue`, `eventQueue`, dispatch maps, completion sets,
stats/history, routing guards, current-level sets, and pending scopes, with the
normal default flags. This is a fixed engine bootstrap, not deserialization of
arbitrary checkpoint state.

`WavePlanning` is not a safe entry. At wave 0 it needs a dependency graph and
queues the initial roots, relaunching completed work; at wave 1 with no levels it
can complete without servicing the pending catalog request. `LevelDispatch`
with an empty queue enters the active claim scheduler, sees no ready work in the
quiescent prefix, launches the single pending catalog owner, then drains only
generations made ready by reconciliation. Its transition back to
`WavePlanning` at wave 1 completes normally without reconstructing the original
dependency graph.

Correct `StateMachineRunner.run()` to emit
`{ type: 'StateTransition', from: currentState, to: currentState }` at entry.
Normal runs still report `Init -> Init`; continuation truthfully reports
`LevelDispatch -> LevelDispatch`. This is only an observer correction. The plan
does not claim that Phase 1 journal checkpoints preserve pre-checkpoint observer
history or restore an observer timeline.

## Why unchanged work cannot relaunch

The continuation adds no scheduler policy. Existing authorities supply the
proof:

- checkpoint restore admits only a quiescent replayed projection;
- reconciliation fingerprints keyed catalog items and leaves identical items'
  active completed generations unchanged;
- changed/added/revived items inactivate superseded generations and activate
  new generation IDs for the affected compiled template closure; and
- `queryReadyWork()` returns only generations whose replayed status is `ready`.

Therefore the empty `LevelDispatch` has no root level to replay and no old
completed generation to launch. The test must falsify this with provider-call
and `AttemptStarted` evidence; projection equality alone is insufficient.

Allocator authority also remains solely in the restored event prefix. The
engine must not copy counters. The first suffix event ID is
`checkpoint.frontier.lastEventId + 1`; the owner request uses the next per-owner
request ordinal; root and catalog attempts continue their shared ordinal; every
new generation starts at generated ordinal 1; and every start consumes the next
global fence reconstructed by Phase 1.

## Genuine fresh-process fixture

The focused Jest file invokes the fixture with `execFile`/`spawnSync` and
`process.execPath`, for example:

```sh
node -r ts-node/register/transpile-only \
  tests/fixtures/durable-graph-engine-continuation-child.ts <mode> <artifact-dir>
```

Use argument arrays, a bounded timeout, a temporary artifact directory, and
JSON files/stdout only. Do not share an engine, registry singleton, module cache,
closure, or private in-memory journal between invocations. Record and assert
different PIDs for producer and continuations.

The fixture registers a deterministic in-process test provider and uses one
root catalog owner with two keyed items, `A` and `B`, each having an existing
two-node affected closure (`inspect -> summarize`):

1. `produce` runs the ordinary engine to full quiescence with `A@1` and `B@1`,
   writes the JSON-round-tripped checkpoint, event/identity summary, and call
   log, then exits.
2. `continue-a` starts in a new process, reads only those JSON artifacts, returns
   `A@2` and unchanged `B@1` from the owner, invokes
   `continueGraphCheckpoint`, and writes its result, checkpoint, projection,
   transition history, PID, and provider calls.
3. `continue-b` starts in a third process from the checkpoint returned by step
   2, returns unchanged `A@2` and changed `B@2`, and writes the same evidence.

The happy-path assertions are exact:

- each returned checkpoint begins with a byte/canonical-equal prior event
  prefix and all suffix events use the original session;
- all pre-checkpoint instance, claim, node, and generation IDs survive; the
  unchanged item's claims/nodes/completed generation slice is deeply equal;
- `continue-a` provider calls are exactly owner, `A.inspect`, `A.summarize`, and
  contain no `B` call; `continue-b` is exactly owner plus the `B` closure and
  contains no `A` generated call;
- no suffix `AttemptStarted` names any generation completed before that input
  checkpoint; changed items retain stable keyed subgraph/node identity while
  superseded generations become inactive and replacements get new IDs;
- suffix event IDs are contiguous, request and shared root/catalog ordinals are
  the canonical next values, new generated attempts use ordinal 1, and global
  fences start at the reconstructed next fence with no gap or regression;
- the first observer event in both continuation processes is exactly
  `LevelDispatch -> LevelDispatch`;
- provider context observes the original `sessionId` and the workspace-adjusted
  working directory; and
- both returned checkpoints survive `JSON.stringify`/`JSON.parse`, restore to
  live/replay-equal projections, and are quiescent. Step 3 proves the checkpoint
  returned by step 2 is itself a repeatable continuation frontier.

The child process is the process-durability proof. Creating two engine objects
inside one Jest process is not an acceptable substitute.

## Focused failure and ordering tests

In the same focused test file, cover this matrix before the happy path:

| Input | Exact rejection | Required negative evidence |
| --- | --- | --- |
| Event/payload changed without re-hashing | `CHECKPOINT_INTEGRITY_MISMATCH` | no provider marker, memory/workspace init, or installed context |
| Valid checkpoint with a semantically different config | `CHECKPOINT_GRAPH_MISMATCH` | same |
| Validly hashed prefix with a pending request/attempt, ready/running generation, or managed lease | `CHECKPOINT_NOT_QUIESCENT` | same |
| Valid checkpoint and same graph, unknown owner | `UNKNOWN_EXPANSION_OWNER` | same and no request suffix |

Use a child-written provider marker for cross-process negative evidence and
focused Jest spies on `MemoryStore.initialize` and `initializeWorkspace` for
ordering. After each failure, `getInstanceProjection()` and
`requestCatalogReconciliation()` must still fail with `RUN_NOT_ACTIVE`. Re-hash
fixtures intended to reach graph/quiescence gates; otherwise the integrity test
would give false confidence by masking the target branch.

Also assert setup on success: memory initializes once, workspace initialization
runs before the first provider call, and the provider receives the resulting
`workingDirectory`. Workspace contents and memory values are fresh process
services; they are not restored from the graph checkpoint.

## Implementation sequence and gates

1. Add the builder bootstrap and unit-level ordering assertions. Prove restored
   session binding reaches the shared limiter before adding runner logic.
2. Add the engine contract, direct one-request insertion, and fail-fast tests.
3. Add the fixed `LevelDispatch`/wave-1 seed and the isolated initial-observer
   correction.
4. Add the three-process deterministic fixture and exact prefix, call-set,
   identity, allocator, and repeatability assertions.
5. Build the SDK declarations and confirm the method and types are usable from
   `@probelabs/visor/sdk`; do not add a facade if the class export suffices.

Required focused gates:

```sh
npx jest tests/engine/durable-graph-engine-continuation.test.ts --runInBand
npx jest tests/unit/snapshot-store.test.ts --runInBand
npm run build:sdk
```

Review must reject the change if it introduces a new checkpoint schema, trusts
stored projections/counters, starts at `Init`/wave 0, calls a provider before all
restore/owner gates, relaunches an unchanged completed generation, or proves
“freshness” without a separate PID. No broad suite or recovery machinery is a
Phase 2 prerequisite.

## Explicit nonclaims

- No restore of legacy `JournalEntry[]`, `SnapshotJson`, `saveSnapshotToFile`,
  `resumeFromSnapshot`, or old runner snapshots.
- No arbitrary runner state, dependency graph, queue, stats, result history,
  routing history, observer history, or memory-value restoration.
- No continuation from active root/catalog/generated attempts, pending/running
  requests, ready/running generations, or acquired/started/cancel-requested
  managed runs.
- No provider session, model stream, workflow child, managed handle, lease,
  sandbox/container, timer, cancellation, cleanup, or external-resource resume.
- No graph migration, changed `graphSemanticDigest`, renamed owner, unknown
  legacy event, partial prefix, or checkpoint compaction.
- No multiple owners, queued reconciliation batch, daemon/event-loop process
  recovery, multi-writer coordination, or crash-atomic checkpoint storage.
- No cryptographic authenticity or protection from a writer able to mutate and
  re-hash the checkpoint.
- No claim that normal engine results, frontends, output history, or memory are
  durable. Phase 2 proves only exact Graph journal continuation and affected
  generated-work reuse across a clean quiescent process boundary.
