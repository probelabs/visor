# Engine State Machine (v2) Research

This note captures the current execution flow of the Visor engine, the surfaces where a feature flag can live, and an initial proposal for a bespoke state-machine-based Runner v2. The user-provided research artifact referenced in the request is not available inside this workspace yet, so there are a few open questions that we should fill in once we can read it.

> Safety Model & Criticality (Summary)
>
> The engine follows a NASA‑style safety model. Every check participates in a safety policy that depends on its criticality:
>
> - criticality (field on each check): external | control-plane | policy | non-critical
>   - external: mutates outside world (e.g., GitHub ops, HTTP methods ≠ GET/HEAD)
>   - control-plane: alters routing/fan‑out (forEach parents, on_* with goto/run, memory used by guards)
>   - policy: enforces permissions/policy (strong fail_if/guarantee)
>   - non-critical: read‑only compute
>
> Defaults derived from criticality:
> - Critical (external/control‑plane/policy): require `assume` (preconditions) and `guarantee` (postconditions); `continue_on_failure: false`; retries only for transient faults; tighter loop budgets; suppress downstream side‑effects when contracts fail.
> - Non‑critical: contracts recommended; may allow `continue_on_failure: true`; standard budgets and retry bounds.
>
> Expressions apply at distinct phases:
> - `if` (plan-time scheduling) → `assume` (pre‑exec) → provider → `guarantee`/`fail_if` (post‑exec) → transitions/goto.
>
> See also: docs/guides/fault-management-and-contracts.md for the full checklist and examples.

## 1. Current Engine Map

### 1.1 Entry points & global state
- `CheckExecutionEngine` wires together the git analyzer, provider registry, failure evaluator, snapshot journal, memory store, telemetry, and GitHub clients (`src/check-execution-engine.ts:228-332`).
- Per-run state is stored in multiple mutable maps/sets such as `forwardRunGuards`, `executionStats`, `outputHistory`, `runCounters`, and `journal`; `resetPerRunState` must be called before each grouped execution to avoid leakage (`src/check-execution-engine.ts:258-306`).
- `executeChecks` is the legacy CLI-style entry point that still routes through the PR reviewer after a repo scan; it loads memory, tags, GitHub checks, and eventually calls `executeReviewChecks` (`src/check-execution-engine.ts:3645-3815`).

### 1.2 Config-driven execution
- Modern callers (CLI, GitHub Action, SDK, test runner) invoke `executeGroupedChecks` which handles tag/event filtering, debug visualization and GitHub context capture (`src/check-execution-engine.ts:3964-4250`).
- `executeGroupedChecks` chooses between three paths:
  1. `executeDependencyAwareChecks` when every requested check has config (`src/check-execution-engine.ts:3976-3986`).
  2. `executeSingleGroupedCheck` when exactly one configured check remains (`src/check-execution-engine.ts:4291-4470`).
  3. Provider fallbacks (`src/check-execution-engine.ts:3990-4079`) or reviewer fallback for legacy “focus” runs.
- GitHub Action mode adds grouped comment posting and per-check CheckRun updates via `GitHubCheckService`.

### 1.3 Dependency-aware runner
- `executeDependencyAwareChecks` orchestrates “waves” of checks:
  1. Expand the requested set with transitive dependencies, event/tag filters, and session reuse metadata (`src/check-execution-engine.ts:5132-5320`).
  2. Build/validate the dependency graph using `DependencyResolver` (`src/check-execution-engine.ts:5321-5368`, `src/dependency-resolver.ts:1-150`).
  3. Maintain `wave` counters that reschedule plan execution whenever routing (`on_fail`, `on_finish`, `goto`) requests a forward run. A wave resets dedupe state and replays the DAG (`src/check-execution-engine.ts:5384-5440`).
  4. For each topological level, spawn tasks up to `maxParallelism`, honoring session reuse barriers, fail-fast, and debug pauses (`src/check-execution-engine.ts:5442-6188`).
  5. After each pass, inspect flags like `onFailForwardRunSeen`/`onFinishForwardRunSeen` and rebuild the graph if goto changed the event or dependency set (`src/check-execution-engine.ts:6824-7072`).
- Supporting helpers:
  - `executeWithLimitedParallelism` implements the generic async task pool (`src/check-execution-engine.ts:3861-3926`).
  - `shouldFailFast` inspects issue severities to stop the pool early (`src/check-execution-engine.ts:8942-8958`).

### 1.4 Check lifecycle & routing
- `runNamedCheck` is the central dispatcher used by dependency levels, routing hooks, and inline executions. It evaluates `if` guards, enforces per-scope run caps, calls `executeCheckInline`, evaluates `fail_if`, records stats/history, and schedules routing targets (`src/check-execution-engine.ts:1516-2050`).
- `executeCheckInline` ensures dependencies are materialized (recursively running missing ancestors), handles forEach fan-out, commits results into the execution journal, and records output history (`src/check-execution-engine.ts:1047-1513`).
- `scheduleForwardRun` is the goto implementation that replans subsets of the DAG, filtering by event triggers and respecting per-run dedupe guards (`src/check-execution-engine.ts:412-520`).
- `on_finish` orchestration is split into `runOnFinishChildren`, `decideRouting`, and `computeAllValid` helpers under `src/engine/on-finish/*`. The main engine wires them up after all forEach items and dependents settle, reusing snapshot projections for context (`src/check-execution-engine.ts:2200-2350`).
- `shouldRunCheck` (and the `FailureConditionEvaluator`) power `if`, `fail_if`, and manual gating for forEach dependents (`src/check-execution-engine.ts:4801-4870`).

### 1.5 Supporting services
- `MemoryStore` and helper functions provide scriptable scratch storage for checks and on_finish contexts (see injections in `composeOnFinishContext`, `src/check-execution-engine.ts:900-1010` and `src/engine/on-finish/utils.ts:1-160`).
- `ExecutionJournal`/`ContextView` capture per-scope results for snapshot-based dependency evaluation; journals are reset each grouped run (`src/check-execution-engine.ts:170-210` and `src/snapshot-store.ts`).
- Telemetry emitters (`emitNdjsonSpanWithEvents`, OTEL spans, `addEvent`) are sprinkled through `runNamedCheck`, forEach loops, and failure evaluators.
- GitHub Check integration wires into `executeChecks` and `executeGroupedChecks` to create/update CheckRuns and annotate output (`src/check-execution-engine.ts:3670-3780`, `src/github-check-service.ts`).

### 1.6 Observed pain points
- Engine state is scattered across mutable maps/sets, which makes it hard to reason about transitions (e.g., `forwardRunGuards`, `postOnFinishGuards`, `gotoSuppressedChecks`).
- Waves are implicit booleans rather than explicit states; nested goto/forward-run flows toggle flags that outer loops poll (`src/check-execution-engine.ts:5384-5455`, `src/check-execution-engine.ts:6824-6880`).
- Routing logic (on_success/on_fail/on_finish) is interwoven with execution; suppression guards (one-shot tags, goto suppression when re-running for dependents) make control flow difficult to extend.
- Debug visualizer and telemetry rely on ad-hoc hooks inside loops, increasing the risk of regressions when adjusting flow control.

### 1.7 Capability coverage checklist
| Capability / nuance | Current implementation | State machine accommodation |
| --- | --- | --- |
| Per-check `if` / `fail_if` gating | `shouldRunCheck`, `evaluateFailureConditions` (`src/check-execution-engine.ts:1516-2050`, `8975-9057`) | Model as routing sub-states: every `CheckCompleted` event flows through a deterministic `Routing` state that evaluates conditions before enqueuing follow-up events. |
| forEach fan-out & `on_finish` loops | `executeCheckInline` + on_finish helpers (`src/check-execution-engine.ts:1047-1513`, `2200-2350`; `src/engine/on-finish/*`) | Represent forEach items as scoped dispatch records; let `WavePlanning` schedule per-item events and treat `on_finish` as a specialized routing transition capable of emitting `WaveRetry`. |
| `goto` / `goto_event` / forward-run dedupe | `scheduleForwardRun` + guard sets (`src/check-execution-engine.ts:412-520`) | Replace guard sets with queue-level deduping: before enqueuing `ForwardRunRequested`, consult a hashed tuple `(target, event, scope)` to avoid re-scheduling. |
| Session reuse & provider contexts | Session metadata assembled in `executeDependencyAwareChecks`; enforced via `runNamedCheck` sessionInfo | Store session provider relationships inside `EngineContext.checks` metadata so the dispatcher can force sequential execution whenever checks share a session. |
| Memory store & outputs history | `MemoryStore`, `ExecutionJournal`, scoped snapshots threaded through the legacy engine | Keep `memory`/`journal` in `EngineContext`; have state transitions commit snapshots, ensuring history is still authoritative for `on_finish`, forEach gating, and goto history queries. |
| Debug visualizer pause/resume | `pauseGate`/`DebugVisualizerServer` gating inside `executeGroupedChecks` (`src/cli-main.ts:820-880`) | Have `LevelDispatch` consult a pause controller before spawning tasks and mirror all `EngineEvent`s to the debug server for visualization. |
| GitHub CheckRuns & PR comments | `initializeGitHubChecks`, `completeGitHubChecks*`, `reviewer.postReviewComment` | Treat these as side effects of `Init` and `Completed` states so both engines emit identical updates; attach `engine_mode` metadata to CheckRuns for observability. |
| Human input provider prompts | CLI message plumbing + provider execution context | ExecutionContext plumbing is untouched; state machine just continues passing it into providers. |
| Nested workflows | Workflow provider executing its own DAG (`src/providers/workflow-check-provider.ts`) | Covered in §3.6 — the state machine will compile workflows into child graphs and run them under the same scheduler. |
| Telemetry spans / metrics | `emitNdjsonSpanWithEvents`, OTEL instrumentation sprinkled through current engine | Emit spans when entering/exiting each state (`state_from`, `state_to`, `engine_mode` attrs) so trace density stays similar but more structured. |

## 2. Feature-flag surfaces

### 2.1 CLI
- Commander definition lives in `src/cli.ts`; new flags are added to both `setupProgram` and `parseArgs` builders (`src/cli.ts:19-141`).
- Parsed options are consumed in `src/cli-main.ts`: after config discovery the engine is instantiated and `executeGroupedChecks` is called (`src/cli-main.ts:784-910`).
- `CliOptions` type in `src/types/cli.ts` must include any new flag (`src/types/cli.ts:17-74`).

### 2.2 GitHub Action
- `src/index.ts` creates a `CheckExecutionEngine` around line 716 and always runs grouped execution (`src/index.ts:680-820`).
- Inputs are read via `@actions/core.getInput`; introducing an input such as `state-machine` or honoring `VISOR_STATE_MACHINE` would happen alongside other inputs near the top of `run()` (`src/index.ts:40-140`).

### 2.3 SDK & tooling
- The published SDK (`src/sdk.ts:1-120`) exposes `runChecks` which instantiates the engine directly and calls `executeChecks`.
- Dev/test scripts (`scripts/dev-run.ts`, `scripts/simulate-gh-run.ts`) and sample SDK programs also instantiate the engine manually (see `rg "new CheckExecutionEngine"`).
- The YAML test runner (`src/test-runner/index.ts:100-220` and `:780+`) needs a flip to point at the new engine when the flag is turned on so regression suites can exercise both paths.

### 2.4 Proposed gating strategy
- Introduce an `EngineMode = 'legacy' | 'state-machine'` option accepted by `CheckExecutionEngine` (constructor or `execute*` methods). Default stays `'legacy'`.
- CLI: add `--state-machine` (and env `VISOR_STATE_MACHINE=1`) that sets `engineMode` before instantiating the engine. The flag needs to propagate to **all** CLI commands (`visor`, `visor test`, `visor validate`, etc.), so `handleTestCommand` in `src/cli-main.ts` should accept/pass it through to the YAML test runner, ensuring regression suites exercise both engines.
- GitHub Action: follow the CLI behavior if either a new input (`state-machine: true`) or `VISOR_STATE_MACHINE` env var is present; bubble the mode into the Action comment/telemetry payload so we can detect it in logs.
- SDK/test runner/scripts: accept an optional `engineMode` option so programmatic callers can participate in canaries without CLI flags.
- Telemetry/debug: add the mode to spans (e.g., `visor.run.engine_mode`) to keep traces filterable.
- Initial implementation can keep mode selection localized to a helper such as `createExecutionEngine({ mode })` so that non-flagged call sites continue using the current class.

## 3. State machine proposal

### 3.1 Goals
1. Make control flow explicit (well-defined states, transitions, and events).
2. Preserve existing semantics (dependency gating, forEach fan-out, routing) while simplifying mental load.
3. Unlock incremental features (pause/resume, deterministic tracing, easier retries) without relying on xstate or third-party interpreters.

### 3.2 Candidate states & transitions
| State | Responsibility | Exits |
| --- | --- | --- |
| `Init` | Capture CLI/action options, hydrate config, construct helpers, reset journals. | `PlanReady` once config + inputs validated. |
| `PlanReady` | Build dependency graph, expand checks, compute per-step metadata (tags, sessions, fan-out). | `WavePlanning` (success) / `Error`. |
| `WavePlanning` | Inspect outstanding events (forward runs, goto, manual triggers) and queue the next wave’s DAG snapshot. | `LevelDispatch` when a wave is ready, `Completed` when no work remains. |
| `LevelDispatch` | Pop the next topological level, spawn tasks up to `maxParallelism`, hand them to `CheckRunning`. | `CheckRunning` for each task, `WavePlanning` once the level finishes. |
| `CheckRunning` | Run provider + check logic, emit stats, assemble `CheckResult`. | `Routing` with success/failure payload, or `Error`. |
| `Routing` | Evaluate `fail_if`, `on_success`, `on_fail`, `on_finish` triggers; enqueue new events (`ForwardRun`, `WaveRetry`, `GotoEvent`). | `WavePlanning` when new work scheduled, `Completed` if this was the final sink. |
| `Completed` | Finalize stats, flush telemetry/CheckRuns, surface grouped results. | terminal |
| `Error` | Capture fatal issues and unwind (shielding CLI/action from partial states). | terminal |

Events flowing between states include: `PlanBuilt`, `WaveRequested`, `LevelDepleted`, `CheckComplete`, `CheckErrored`, `ForwardRunRequested`, `OnFinishLoop`, and `Shutdown`.

### 3.3 Runtime data model
- `EngineContext` struct holding: immutable config snapshot, dependency graph, check metadata (tags, triggers, session provider, fan-out mode), `ExecutionJournal`, output/memory stores, telemetry sinks, and persistence hooks.
- `RunState` struct capturing: current engine mode, pending events queue, active wave number, active levels, outstanding tasks, global flags (e.g., `failFastTriggered`), GitHub check bookkeeping, and debug server hooks. The struct is designed to be serializable so we can persist/resume executions.
- `DispatchRecord` capturing per-check data (scope path, provider id, start ts, attempts, forEach item index) to tie stats/telemetry to state transitions.
- Event queue implementation (simple array or deque) so routing can push `ForwardRun`/`GotoEvent` events instead of toggling booleans. The queue doubles as the source for a structured event log, enabling time-travel debugging.

TypeScript sketch:

```ts
type EngineMode = 'legacy' | 'state-machine';

interface EngineContext {
  mode: EngineMode;
  config: VisorConfig;
  dependencyGraph: DependencyGraph;
  checks: Record<string, {
    tags: string[];
    triggers: EventTrigger[];
    group?: string;
    sessionProvider?: string;
    fanout?: 'map' | 'reduce';
    providerType: string;
  }>;
  journal: ExecutionJournal;
  memory: MemoryStore;
  telemetry: TelemetrySink;
  gitHubChecks?: GitHubCheckService;
  persistence?: {
    saveState: (state: SerializedRunState) => Promise<void>;
    loadState?: () => Promise<SerializedRunState | null>;
  };
}

interface RunState {
  wave: number;
  levelQueue: ExecutionGroup[];
  eventQueue: EngineEvent[];
  activeDispatches: Map<string, DispatchRecord>;
  flags: {
    failFastTriggered: boolean;
    forwardRunRequested: boolean;
  };
  stats: Map<string, CheckExecutionStats>;
  historyLog: EngineEvent[]; // append-only log for time-travel debugging
}

type EngineEvent =
  | { type: 'ForwardRunRequested'; target: string; gotoEvent?: EventTrigger; scope?: ScopePath }
  | { type: 'WaveRetry'; reason: 'on_fail' | 'on_finish' | 'external' }
  | { type: 'CheckScheduled'; checkId: string; scope: ScopePath }
  | { type: 'CheckCompleted'; checkId: string; scope: ScopePath; result: ReviewSummary }
  | { type: 'CheckErrored'; checkId: string; scope: ScopePath; error: SerializedError }
  | { type: 'StateTransition'; from: EngineStateId; to: EngineStateId }
  | { type: 'Shutdown'; error?: SerializedError };

interface DispatchRecord {
  id: string;
  scope: ScopePath;
  provider: string;
  startMs: number;
  attempts: number;
  foreachIndex?: number;
  sessionInfo?: { parent?: string; reuse?: boolean };
}

type SerializedRunState = {
  wave: number;
  levelQueue: ExecutionGroup[];
  eventQueue: EngineEvent[];
  flags: RunState['flags'];
  stats: CheckExecutionStats[];
  historyLog: EngineEvent[];
};
```

Persistence/time-travel strategy (debugger-only for now):
- When the debug visualizer is enabled, after every state transition the engine appends to `historyLog`, streams the event over the WebSocket, mirrors it to `output/debug-events/<session>.jsonl`, and (optionally) flushes the minimal `SerializedRunState` via `persistence.saveState`. By default we persist under `tmp/visor-state/<session>.json` (override via config/env if needed). Outside of debugger mode we skip persistence/log mirroring to avoid overhead.
- During a debug resume, the engine loads the last serialized state, reconstructs in-memory maps, and continues dequeuing events, ensuring retries and routing decisions survive restarts within the debugging session.

### 3.4 Migration strategy
1. **Scaffolding:** introduce `EngineMode` flag plus a skeleton `StateMachineExecutionEngine` that simply proxies to the legacy runner; wire the flag through CLI/Action/SDK/tests.
2. **State-core:** implement new state machine that supports dependency execution without routing (no goto/on_finish yet) and hide it behind the flag for targeted tests.
3. **Routing parity:** port `scheduleForwardRun`, `runNamedCheck`, and `on_finish` semantics into state transitions; reuse existing helper functions where practical to avoid regressions.
4. **Observability:** add structured tracing for state transitions so we can debug the new engine with the debug visualizer and OTEL spans.
5. **Canary & cleanup:** run regression suites in both modes, flip CI to exercise the state machine on dedicated jobs, and deprecate legacy-only code once parity is proven.

### 3.5 Open questions / follow-ups
- Need access to the user’s research doc (currently outside the workspace) to reconcile requirements or additional tasks that were listed there.
- Confirm how the debug visualizer wants to tap into the new state transitions (current server polls spans in `executeGroupedChecks`). We likely need a small event bus that mirrors `EngineEvent`s to the WebSocket server and OTEL spans (e.g., `visorevent.state_transition` with `{ from, to, checkId }` attributes).
- Decide whether GitHub Action inputs should expose a first-class `state-machine` boolean or rely on env vars.
- Determine whether we want to version the engine externally (e.g., `engine: v2` in config) once the flag stabilizes, or keep CLI-only toggles.

Once the missing research document is accessible we should merge those findings into this plan, update the open questions list, and refine the migration steps accordingly.

### 3.6 Nested workflows and reusable DAGs
Visor already supports nested workflows via `type: 'workflow'` checks and the `WorkflowRegistry`/`WorkflowExecutor` (`src/workflow-registry.ts`, `src/providers/workflow-check-provider.ts`). Today those executions run entirely inside the provider, which means:

- The outer engine treats the workflow check as a single node even though the workflow definition contains its own dependency graph, inputs, overrides, and potentially recursive workflow references.
- Nested workflow iterations cannot benefit from core-engine features like pause/resume, telemetry, or goto semantics unless the workflow provider re-implements them.

For the state-machine engine we should:

1. Expose a “subgraph” capability so a workflow definition can be compiled into an internal DAG and scheduled as a child `EngineContext`. That keeps a single state abstraction whether we are running top-level checks or workflow steps.
2. Carry parent scope into the child `RunState` so results from workflow steps register under meaningful journal scopes (`workflow:stepA@item1`).
3. Allow workflows to emit their own `ForwardRunRequested`/`WaveRetry` events that bubble up to the parent queue. This prevents nested workflows from deadlocking when they need to re-run ancestor steps.
4. Document limits (depth, fan-out) so that arbitrarily nested workflows do not starve the scheduler. We can enforce a `maxWorkflowDepth` (default 3) in `RunState.flags`.

Implementation strategy:
- Start by projecting a workflow definition into the same `DependencyGraph` structure the main engine uses (the registry already validates steps and dependencies).
- When the workflow provider is invoked in state-machine mode, hand the projected graph to the engine instead of running it privately; the provider becomes a thin adapter that returns the child engine’s aggregated `ReviewSummary`.
- For compatibility, keep the current “self-contained workflow execution” path in legacy mode until all workflows are verified under the state machine.

## 4. Rollout & testing milestones

| Milestone | Description | Test strategy |
| --- | --- | --- |
| **M0 – Flag plumbing & proxy** ✅ DONE | Add `EngineMode`, CLI flag/env plumbing (including `visor test`), and a proxy state-machine runner that simply delegates to the legacy engine so tooling can toggle the mode. | Update Jest/YAML harnesses to accept `engineMode`. CI continues running legacy-only while we ensure the flag wires through all commands. |
| **M1 – Core state machine (no routing)** ✅ DONE | Implement Init → Plan → Wave → Level → Check → Completed transitions covering dependency expansion, fail-fast, stats, GitHub checks, debug pause, but still delegate routing (`goto`, `on_finish`) to legacy helpers. | Run the entire suite twice (legacy + state-machine) via a CI matrix; YAML tests remain unchanged—they're just invoked under both modes. Add targeted unit tests for queue/dispatch logic. |
| **M2 – Routing & forEach parity** ✅ DONE | Port `scheduleForwardRun`, `on_fail`, `on_success`, `on_finish`, and full forEach fan-out into the state machine; ensure flags/guards map to structured events. | Keep dual-mode CI. Add focused e2e tests covering routing loops, fail_if gating, and forEach retries, plus assertions on emitted `EngineEvent`s. |
| **M3 – Nested workflows** ✅ DONE | Allow the workflow provider to hand child DAGs to the state machine, enforce depth/fan-out limits, propagate journal scopes. | Re-run existing workflow YAML suites under both modes; add a couple of dedicated unit tests that assert depth enforcement and parent/child event propagation. |
| **M4 – Observability & default flip** ✅ DONE | Stream `EngineEvent`s to the debug visualizer, enrich OTEL spans/check runs with `engine_mode`, remove legacy guard maps, and make the state machine the default once confidence is high. | Continue running a reduced legacy suite in CI until full deprecation; monitor telemetry dashboards for regressions before removing legacy mode entirely. |

### Test philosophy
- YAML-based regression suites **must not change**; they encode behavior, not engine internals. We simply re-run them with `--state-machine` (e.g., `node scripts/run-visor-tests.js --state-machine`) during rollout to prove parity.
- Jest/unit/integration tests remain authoritative; we only add a handful of state-machine-specific cases (event queue ordering, wave retry limits) instead of duplicating every scenario.
- CI should eventually run in a matrix (`ENGINE_MODE=legacy` vs `state-machine`) so every PR exercises both engines until we flip the default. This is easier than maintaining a completely separate test suite.

## 5. Toward structured, NASA-style guarantees

One of the driving reasons for this rewrite is to reach NASA-like rigor: strong separation of concerns, declarative control flow, and statically checkable contracts. The state machine gives us the runtime substrate; we’ll complement it with two configuration-level enhancements.

### 5.1 Declarative transitions instead of ad-hoc `goto`
We will keep `goto` / `goto_js` fully functional for backwards compatibility—nothing is removed—but we’ll introduce a structured transition DSL that offers better static guarantees. Example:

```yaml
on_finish:
  transitions:
    - when: "wave('validate-fact').invalid_count > 0 && event.name == 'issue_opened'"
      to: issue-assistant
    - when: "wave('validate-fact').invalid_count > 0 && event.name == 'issue_comment'"
      to: comment-assistant
    - when: "wave('validate-fact').invalid_count == 0"
      to: null
```

Plan:
1. Extend the config schema with optional `transitions[]` entries (fields: `when`, `to`, optional metadata). During the `Routing` state, the engine evaluates `when` expressions in priority order and enqueues the resulting transition.
2. Build a static validator that ensures each `to` refers to an existing check (or `null`), expressions only use approved helpers (`wave`, `event`, `outputs`, `memory`, etc.), and that transitions either cover all cases or explicitly fall back to `null`.
3. When both `goto`/`goto_js` and `transitions` are present, the state machine honors `transitions` first (still executing the others as a fallback) and logs a warning so we can gradually migrate built-in configs away from dynamic `goto_js` without breaking existing flows.

### 5.2 Assume/guarantee contracts
To support design-by-contract we’ll let checks declare assumptions about their inputs and guarantees about their outputs:

```yaml
extract-facts:
  guarantee:
    - "Array.isArray(output) && output.every(f => f.id && f.claim)"

validate-fact:
  assume:
    - "typeof extract-facts.item.id === 'string'"
  guarantee:
    - "typeof output.fact_id === 'string' && output.fact_id === extract-facts.item.id"
```

Execution steps:
1. Extend `CheckConfig` with optional `assume[]` and `guarantee[]` arrays. Before executing a provider, the state machine evaluates `assume` expressions using dependency outputs (and forEach item context); failures short-circuit execution with a structured issue referencing the violated assumption. After execution, it evaluates `guarantee` expressions against the check’s output and records fatal issues if they fail.
2. Add compile-time validation: parse each expression and ensure it only references known symbols. For example, `assume` can read `dependencyName.output`, `dependencyName.item`, or `memory` but cannot mutate state; `guarantee` can read outputs but not future steps.
3. Emit telemetry (`engine.contract.assume_failed`, `engine.contract.guarantee_failed`) so CI and runtime monitoring can flag contract regressions.

By lifting control flow into `transitions` and correctness rules into `assume`/`guarantee`, we make configurations statically analyzable, reduce reliance on imperative `goto_js`, and move closer to NASA-inspired static validation goals while still honoring legacy constructs for advanced scenarios.
## 5. Routing and Loops (spec to impl status)

- on_success/on_fail evaluate `run`, `run_js`, and `goto` (with optional `goto_event`).
- on_finish for forEach parents is processed after children complete; loop budget enforced.

### 5.1 Declarative transitions (implemented)

In addition to `goto`/`goto_js`, checks can use declarative transitions on `on_success`, `on_fail`, and `on_finish`:

```
on_finish:
  transitions:
    - when: "any(outputs_history['validate-fact'], v => v.is_valid === false) && event.name === 'issue_opened'"
      to: issue-assistant
    - when: "any(outputs_history['validate-fact'], v => v.is_valid === false) && event.name === 'issue_comment'"
      to: comment-assistant
```

- Rules evaluate in order; first true wins. Use `to: null` to explicitly do nothing.
- Backward compatible: if `transitions` is omitted or none match, the engine falls back to `goto_js/goto`.
- Helpers available: `outputs`, `outputs_history`, `output`, `event`, `memory`, plus `any/all/none/count`.

### 5.2 Assume/Guarantee contracts (implemented)

Per-check contracts:

```
assume:
  - "env.NODE_ENV === 'ci'"                 # preconditions – if any is false, skip with skipReason=assume
guarantee:
  - "Array.isArray(output.items)"           # postconditions – violations add error issues (contract/guarantee_failed)
```

- `assume` is evaluated pre-execution; skipped checks are recorded and visible in stats/history.
- `guarantee` is evaluated post-execution; violations are non-fatal by default (routing unaffected) but produce issues.
