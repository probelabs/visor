# Snapshot + Scope Execution Model — Plan & Tracker

Status: In progress
Last updated: 2025-10-20

This document captures an incremental plan to simplify Visor’s execution model using snapshot isolation (MVCC‑style) and scope‑aware output resolution, while preserving today’s routing semantics and recently added `on_finish` behavior (PR #146).

It also lists a set of quick wins we can land immediately to polish PR #146 and align docs/engine behavior.

---

## Status Dashboard

Priority scale: P0 = must‑have next; P1 = important; P2 = nice‑to‑have.

Overall progress: ~85% complete (Phases 0–3 done; Phases 2 and 4 now complete; Phase 5 pending).

| Phase | Priority | Status | % Complete | Notes |
|---|---|---:|---:|---|
| Phase 0 — Lay Hooks | P0 | ✅ Done | 100% | Journal + commits wired; unit coverage present. |
| Phase 1 — Snapshot Visibility | P0 | ✅ Done | 100% | Engine builds dependencyResults from snapshot. |
| Phase 2 — Outputs Surface | P1 | ✅ Done | 100% | outputs + outputs_history + outputs_raw shipped; docs updated with precedence matrix and examples. |
| Phase 3 — Unified Scheduling | P0 | ✅ Done | 100% | runNamedCheck added; routing uses it; loop budget uniform. |
| Phase 4 — Remove Per‑Item Map Cloning | P1 | ✅ Done | 100% | executeCheckInline and grouped forEach paths now use ScopePath + snapshot; minimal per-item overlay remains only within the same item’s inline descendant chain. |
| Phase 5 — Fan‑Out/Reduce Control | P2 | ⏳ Not Started | 0% | Add reduce/fanout flag; keep default single‑run. |

High‑priority backlog (outside phases)
- [P0] Journal Event Scoping: tag entries with event; filter ContextView by current/goto_event.
- [P1] Journal Performance Indexes: per‑(sessionId, checkId) indexes for readVisible.

## Goals
- Deterministic reads under concurrency: each step sees a point‑in‑time view of prior results in the current run/session.
- Scope‑aware outputs for forEach: nearest item wins, with explicit raw/history accessors.
- Unify inline/goto execution as scheduling in the same scope (no special contexts), with loop budgets enforced.
- Keep provider interfaces, routing model (`on_success`, `on_fail`, `on_finish`, `goto_event`), and CI behavior.

## Non‑Goals (for this iteration)
- Dataflow auto‑scheduling when a template references a not‑yet‑executed step.
- A new DSL for reduce/zip/cartesian across multiple forEach parents (we’ll add a minimal flag later if needed).

---

## Quick Wins For PR #146 (Low Risk)
- [x] Fix built-in schema lookup for Action runs (load from dist/output via __dirname with cwd fallback).

Checklist targets polish and parity; can be merged ahead of the snapshot work.

- [x] Expose `outputs.history` (or `outputs_history`) in `on_finish.goto_js` sandbox to match docs and examples.
- [x] Implement `on_finish.run_js` (docs mention it; engine currently ignores it).
- [x] Count `on_finish` routing toward `routing.max_loops` (prevent cycles); add tests.
- [x] Add `output_format` (command provider) to the config schema to remove warnings in examples.
- [ ] Keep `defaults/.visor.yaml` and `dist/defaults/.visor.yaml` in sync or clearly document source of truth. (tracked separately)

Acceptance checks
- [x] Unit/E2E: `on_finish.run_js` executes and merges with static `run` (order defined and tested). See `tests/e2e/on-finish-run-js-e2e.test.ts`.
- [x] E2E: `routing.max_loops` caps `on_finish` run/goto deterministically. See `tests/e2e/on-finish-loop-budget-e2e.test.ts`.
- [x] E2E: fact‑validator example runs without schema warnings. Manual run verified.

Target: by 2025-10-22

---

## Design At A Glance (Snapshot + Scope)

Primitives
```
type ScopePath = Array<{ check: string; index: number }>; // e.g., [{check:"comments", index:3}]

interface JournalEntry {
  commitId: number;     // strictly increasing per session
  sessionId: string;    // current run
  scope: ScopePath;     // where this result belongs
  checkId: string;      // producer
  result: ReviewSummary & { output?: unknown; content?: string };
}
```

ExecutionJournal
- `beginSnapshot()` → returns the highest visible commitId now.
- `commit(entry)` → stores a result with the next commitId.
- `readVisible(sessionId, commitMax)` → entries ≤ commitMax.

ContextView (what templates/routing read)
- `get(checkId)` → nearest item in current scope; else ancestor; else latest.
- `getRaw(checkId)` → aggregate output (e.g., full array for forEach parent).
- `getHistory(checkId)` → all results up to snapshot.

Resolution rules
1) If current scope includes `{check:X,index:i}`, then `outputs['X']` → item `i`.
2) Else prefer an ancestor scope entry for `X`.
3) Else the latest committed result of `X` in the snapshot.
4) `outputs_raw['X']` returns the aggregate parent output.
5) `outputs_history['X']` returns prior committed outputs.

---

## Phased Plan (Incremental)

Phase 0 — Lay Hooks (no behavior change)
- [x] Add `ExecutionJournal` and `ContextView` (internal module).
- [x] Commit every enriched result to the journal (in both normal and inline paths).
- [x] No feature flags — default-ready rollout.

Acceptance
- [x] Unit: journal commits monotonicity (see tests/unit/snapshot-store.test.ts).

Target: by 2025-10-24

Phase 1 — Snapshot‑based Visibility (minimal surface)
- [x] Build `dependencyResults` from a snapshot view instead of ad‑hoc `depends_on` maps in:
  - [x] `executeWithRouting(...)`
  - [x] `executeCheckInline(...)`
- [x] Keep dependency graph for ordering; this change affects visibility only.

Acceptance
- [x] Unit: parallel checks read only entries ≤ their snapshot; later commits are not visible. (covered by snapshot-store tests)
- [x] Integration: no‑deps visibility validated via snapshot with goto (see `tests/integration/snapshot-visibility-integration.test.ts`).

Target: by 2025-10-28

Phase 2 — Standardize Outputs Surface
- [x] Expose `outputs`, `outputs_history` consistently in:
  - [x] Liquid templates (providers: ai, command, log, memory)
  - [x] Routing sandboxes (`on_success.run_js`, `on_success.goto_js`, `on_fail.run_js`, `on_fail.goto_js`, `on_finish.goto_js`)
- [x] Expose `outputs_raw` for aggregate parent values (scope‑aware raw access)
- [x] Document precedence and examples (short snippet + table)

Acceptance
- [x] Unit/Integration: routing sandboxes read outputs_history (see tests/integration/output-history-integration.test.ts).
- [x] E2E: on_finish.goto_js can read outputs.history (see tests/e2e/on-finish-outputs-history-e2e.test.ts).
- [x] outputs_raw surfaced across providers and routing (tests/integration/outputs-raw-integration.test.ts).

Example: using outputs_raw

```
checks:
  list:
    type: command
    exec: echo '["a","b","c"]'
    forEach: true

  use-raw-memory:
    type: memory
    depends_on: [list]
    operation: exec_js
    memory_js: |
      const arr = outputs_raw["list"]; // → ["a","b","c"]
      return { count: arr.length };

  route-by-raw:
    type: memory
    depends_on: [list]
    operation: exec_js
    memory_js: |
      return 'ok';
    on_success:
      goto_js: |
        // Branch using the aggregate array
        return (outputs_raw["list"] || []).length >= 3 ? 'after-route' : null;

  after-route:
    type: log
    message: Reached after-route
```

Target: by 2025-10-31

Phase 3 — Unified Scheduling Helper (same scope)
- [x] Introduce `runNamedCheck(target, scope, opts)` used by inline/goto/on_finish.
- [x] Ensure routing transitions count toward `routing.max_loops` uniformly.
- [x] Preserve current single‑run semantics (no fan‑out yet).  
  Note: Fan‑out control is deferred to Phase 5.

Acceptance
- [x] Integration: on_success/on_fail loop budgets enforced uniformly (tests/integration/routing-loop-budget-uniformity.test.ts).
- [x] Integration: forEach item retry/remediation uses item context (tests/integration/routing-integration.test.ts).

Target: by 2025-11-01

Phase 4 — Remove Per‑Iteration Map Cloning
- [ ] Delete special “override resultsMap per iteration” code; rely on `ContextView` unwrapping.

Acceptance
- [ ] Unit: forEach dependent checks still see the correct per‑item output.

Target: by 2025-11-04

Phase 5 — Optional Fan‑Out/Reduce Control
- [ ] Add `fanout: map|reduce` (or `reduce: true`) on targets to control default behavior after forEach.
- [ ] Default remains current (single run) for backward compatibility.

Acceptance
- [ ] Unit/E2E: with `fanout: map`, target runs once per item; with `reduce: true`, runs once at parent.

Target: by 2025-11-06

---

## Engine Touchpoints (Where Changes Land)
- `src/check-execution-engine.ts`
  - Commit to journal after provider returns (both main and inline paths).
  - Build snapshot‑based `dependencyResults` (Phase 1, default, no flags).
  - Add `runNamedCheck(...)` and route `on_success`/`on_fail`/`on_finish` through it (Phase 3).
  - Count `on_finish` routing toward loop budgets (Quick Win).
- Routing sandbox init
  - Inject `outputs`, `outputs_raw`, `outputs_history` (Phase 2).
- Providers (AI/command/memory/log)
  - Use standardized outputs surface for templates (Phase 2).

---

## Event Scoping & Safety
- Journal entries should carry event context; default ContextView visibility is current event unless explicitly overridden by `goto_event`.
- Loop budgets: every routing transition (success/fail/finish) consumes the same `routing.max_loops` counter.

---

## Performance Notes
- Start with simple arrays; quickly add indexes by `(sessionId, checkId)`.
- Snapshot build: avoid O(N) scans by caching latest per checkId per snapshot when feasible.

---

## Test Plan (Highlights)
- Snapshot isolation under concurrency (parallel suites).
- Event elevation with `goto_event` (issue → PR context) does not leak across events.
- Fan‑out/Reduce behavior gated by explicit config.
- Loop budget exhaustion errors are deterministic and logged.

---

## Rollout & Backout
- Default rollout (no flags). Backout by reverting the engine changes if needed.

---

## Decision Log
- 2025-10-20: Adopt snapshot+scope plan incrementally; keep dependency graph for ordering; visibility moves to snapshots.
