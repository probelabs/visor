# RFC: Proper Pause/Resume for State-Machine Engine (Event‑Bus + Snapshots)

Status: implemented

Owner: visor engine

Last updated: 2026-01-28

## Summary

We will add first‑class pause/resume to the state‑machine engine so long‑running or interactive workflows (e.g., human‑input in Slack) can suspend execution and later continue exactly where they left off, without re‑running completed work. The design builds on our event‑bus architecture and the existing ExecutionJournal. It introduces JSON snapshots of the engine’s RunState and journal, and a resume entrypoint that hydrates a new runner from a snapshot. Slack and other frontends trigger resume when the awaited user event arrives.

## Goals

- Pause a workflow at deterministic points (e.g., when HumanInputRequested is emitted) and resume later.
- Persist minimal, safe state; do not leak secrets.
- Avoid re‑executing completed checks; preserve outputs/history/routing.
- Keep the event‑driven integration pattern (no long‑lived in‑memory runs).
- Be robust to process restarts (snapshots on disk); work in CI and serverless.

## Non‑Goals (initial)

- Arbitrary mid‑provider checkpointing (we pause at well‑defined integration points).
- Time‑travel debugging; only last consistent snapshot is kept by default.

## Current State (as of this RFC)

- We already end the run on human‑input and rely on PromptState + a new event to re‑enter the workflow. This re‑entry currently performs a cold start and plans from scratch, which is acceptable but can be inefficient and can re‑visit guards.
- Engine has ExecutionJournal and experimental `saveSnapshotToFile()` that serializes RunState and journal; there is no hydrate/resume path.

## High‑Level Design

1) Snapshots (JSON)
- When the engine encounters a pause point (e.g., HumanInputRequested), it writes a snapshot JSON file containing:
  - `version`: number
  - `sessionId`, `event` (trigger), `wave`
  - `state`: serialized RunState (via a new `serializeRunState()` + `deserializeRunState()` pair)
  - `journal`: visible `JournalEntry[]` up to the snapshot
  - `requestedChecks`: string[]
  - `meta`: optional { checkId, channel, threadTs, threadKey, promptTs }

2) Pause Points
- Initial scope: provider‑level pause during HumanInputRequested (event‑bus). Other future pause points can hook the same API.

3) Resume Entry Point
- New `engine.resumeFromSnapshot(snapshot, overrides)` that:
  - Rebuilds `EngineContext` (config, requestedChecks, sessionId, event, journal)
  - Creates a new `StateMachineRunner`, calls `runner.setState(deserializedRunState)` (new API), and continues the main loop.
  - Applies overrides such as `webhookContext` to allow providers to consume the awaited input.

4) Frontends & PromptState
- Frontends (Slack) maintain the human prompt UI and store a pointer to the snapshot path in PromptState. On the awaited reply, frontends look up the snapshot and call `resumeFromSnapshot()` (via the socket/webhook path).

5) Storage & Retention
- Default snapshot directory: `${VISOR_SNAPSHOT_DIR || '.visor/snapshots'}`.
- File naming: `${threadKey}-${checkId}.json` where `threadKey = "${channel}:${threadTs}"`.
- Retention: delete on successful resume; background TTL cleanup (e.g., 24h) to reap orphans.

## Detailed Design

### A. RunState serialization/hydration

- Today we have `serializeRunState(state)` for JSON. We will:
  - Add `deserializeRunState(obj): RunState` (recreates Sets/Maps and ensures invariants).
  - Add `StateMachineRunner.setState(state: RunState)`; only valid before `run()`; asserts state consistency.
  - Ensure we never serialize provider internals or secrets; RunState contains only orchestration fields.

### B. Engine APIs

- `StateMachineExecutionEngine.saveSnapshotToFile(filePath)` already exists.
- Add `resumeFromSnapshot(snapshot: SnapshotJson, opts?: { webhookContext?: ..., debug?: boolean }): Promise<ExecutionResult>`
  - Recreate `EngineContext` using config and `snapshot.sessionId`.
  - Rehydrate journal into a fresh `ExecutionJournal` (push `snapshot.journal`).
  - Hydrate runner with `deserializeRunState(snapshot.state)` then continue.
  - Wire `eventBus` and frontends like a normal run so integrations keep working.

### C. Snapshot triggers & lifecycle

- Human‑input path:
  - Provider emits `HumanInputRequested(checkId, prompt, channel, threadTs, threadKey)` and returns.
  - Engine listens for `HumanInputRequested` during the run and immediately calls `saveSnapshotToFile()` to `${SNAP_DIR}/${threadKey}-${checkId}.json`.
  - Slack Frontend posts the prompt, also sets PromptState for `${threadKey}` with `snapshotPath`.
  - The run completes (no blocking).
  - On Slack reply in the same thread, the socket path looks up `${snapshotPath}` and calls `resumeFromSnapshot()` with the current `webhookContext`.
- After a successful resume (terminal StateTransition), engine deletes the snapshot file and clears PromptState.

### D. Idempotency & Safety

- Completed checks are recorded in RunState + journal; resuming does not re‑run them.
- We treat new inbound input as a new event; routing/guards continue from the hydrated state.
- If snapshot is missing or corrupted, we gracefully fall back to a cold run (today’s behavior).

### E. Security/Privacy

- Snapshots omit secrets and environment variables. Only engine orchestration and committed results are stored.
- Snapshot directory is local by default; users can relocate via `VISOR_SNAPSHOT_DIR`.

## File Layout

```
.visor/
  snapshots/
    C123:1700.55-ask.json   # example: threadKey+checkId
```

## Snapshot JSON (v1) — Example

```json
{
  "version": 1,
  "sessionId": "a1b2c3",
  "event": "issue_comment",
  "wave": 2,
  "state": { "currentState": "Routing", "wave": 2, "activeDispatches": [], "completedChecks": ["lint"], "stats": [], "historyLog": [], "forwardRunGuards": [], "currentLevelChecks": [], "pendingRunScopes": [] },
  "journal": [
    { "commitId": 1, "sessionId": "a1b2c3", "scope": [], "checkId": "lint", "event": "issue_comment", "result": { "issues": [] } }
  ],
  "requestedChecks": ["ask", "refine", "run-commands"],
  "meta": { "checkId": "ask", "channel": "C123", "threadTs": "1700.55", "threadKey": "C123:1700.55", "promptTs": "1700.66" }
}
```

## Slack Integration Flow (pause/resume)

1) Run emits `HumanInputRequested` → engine writes snapshot to `${threadKey}-${checkId}.json`.
2) Slack Frontend posts prompt and sets PromptState with `snapshotPath`.
3) User replies in same thread; socket receives the envelope, finds PromptState/snapshot.
4) Engine `resumeFromSnapshot(snapshot, { webhookContext })` continues the workflow.
5) On terminal state, snapshot is deleted and PromptState cleared.

## CLI/Config

- Env:
  - `VISOR_SNAPSHOT_DIR` — optional base directory for snapshots.
- Config (optional):
  - `limits.max_workflow_depth` continues to apply; pause/resume doesn’t alter nesting rules.
  - Future: `snapshots.enabled` (default true in Slack/webhook contexts), `snapshots.retentionHours`.

## Failure Modes & Recovery

- Missing snapshot: fall back to cold run.
- Corrupt snapshot: log, fall back to cold run.
- Multiple prompts in the same thread: last snapshot wins; older ones are overwritten.
- Process restart: snapshots survive; PromptState TTL means we rely on snapshot presence to resume.

## Testing Plan

1) Unit
- `deserializeRunState(serializeRunState(state))` round‑trip equals for non‑object identity fields.
- `resumeFromSnapshot` continues and does not re‑execute completed checks (assert via journal size).

2) Integration (Slack)
- First run → emits HumanInputRequested, snapshot written, prompt posted, run completes.
- Second run (reply) → loads snapshot, resumes, consumes reply, deletes snapshot.

3) Crash/Restart Simulation
- Save snapshot, reset in‑memory state, then `resumeFromSnapshot` from file.

## Rollout

- Phase 1 (behind feature switch in code): add hydrate APIs and write snapshots on HumanInputRequested; continue to cold‑run on reply but verify snapshot creation.
- Phase 2: wire socket path to call `resumeFromSnapshot`; delete snapshot on success.
- Phase 3: expand pause points if needed; add retention cleanup task.

## Work Items

- Runner
  - [x] Add `runner.setState()` - Implemented in `src/state-machine/runner.ts`
  - [~] Add `deserializeRunState()` - Not needed; resume uses fresh run with journal hydration
- Engine
  - [x] Add `resumeFromSnapshot()` - Implemented in `src/state-machine-execution-engine.ts`
  - [x] On HumanInputRequested → `saveSnapshotToFile()` (path via threadKey+checkId)
- Slack
  - [x] PromptState stores `snapshotPath` alongside prompt metadata - Implemented in `src/slack/prompt-state.ts`
  - [x] Socket runner loads snapshot and calls `resumeFromSnapshot()` on reply - Implemented in `src/slack/socket-runner.ts`
- Tests
  - [x] Unit: workspace initialization test in `tests/unit/resume-from-snapshot-workspace.test.ts`
  - [x] Integration: pause/resume tests in `tests/integration/slack-pause-resume-e2e.test.ts` and `tests/integration/slack-resume-from-snapshot.test.ts`
- Docs
  - [x] Human-input provider docs mention workflow pausing in `docs/human-input-provider.md`

## Alternatives Considered

- Keeping the runner alive across Slack replies → fragile in CI/serverless and ties up resources.
- Persisting only high‑level outputs and re‑planning on resume → simpler but can re‑emit side‑effects and re‑evaluate guards unexpectedly.

## Open Questions

- Should we also emit a `RunPaused` event for analytics/observability?
- Do we want a structured `output.awaiting = true` signal at pause for downstream guards?
- Snapshot encryption at rest (out of scope for now; directory is local/trusted).

