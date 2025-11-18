# Criticality & Contracts — Implementation Tasks (Do‑It‑Right)

This file lists the remaining engineering tasks to fully implement the criticality model, contracts, and transitions as documented. Items are grouped and check‑listable. “(optional)” items can be phased in later.

## 1) Schema & Types
- [ ] Add `criticality` field to `CheckConfig` (`external | internal | policy | info`).
- [ ] (optional) Add `assume_mode: 'skip' | 'fail'` to control unmet preconditions handling.
- [ ] (optional) Add `retry_on: ['transient'] | ['transient','logical']` to narrow retry classes.
- [ ] Update JSON schema generator and `src/generated/config-schema.ts`.
- [ ] Update TypeScript types (`src/types/config.ts`, SDK exports).

## 2) Config Validation & Linting
- [ ] Validator: warn when `criticality` omitted on mutating providers (external inference) or forEach parents (control‑plane inference).
- [ ] Validator: warn when critical steps lack `assume`/`guarantee`.
- [ ] Validator: warn when `assume` references this step’s own `output`.
- [ ] Validator: warn when `guarantee` contains policy thresholds better modeled as `fail_if`.
- [ ] Validator: ensure `transitions[].to` targets exist (or null) and expressions compile.

## 3) Engine Policy Mapping
- [ ] Derive defaults from `criticality` at load time (but allow per‑check overrides):
      - external/control‑plane/policy: `continue_on_failure=false`, retries transient‑only (max 2–3), loop budgets tighter (e.g., 8), contracts required.
      - non‑critical: contracts optional, `continue_on_failure` may be true, default loop budget 10, retries standard.
- [ ] Enforce “no auto‑retry for logical failures” in critical modes (fail_if/guarantee violations).
- [ ] (optional) Per‑criticality loop budget override (e.g., control‑plane default 8).

## 4) Runtime Semantics (clarity & safety)
- [ ] Ensure `assume` is evaluated pre‑exec (no access to this step’s `output`), with clear error messaging.
- [ ] Ensure `guarantee` is evaluated post‑exec, with issues emitted as `contract/guarantee_failed`.
- [ ] Keep expressions sandboxed, pure, and short‑timed; log evaluation errors as fail‑secure decisions.
- [ ] Transitions precedence over `goto_js` when both present; loop budget enforcement per scope.
- [ ] (optional) forEach per‑item concurrency with default 1; cap via config.

## 5) Side‑Effect Classification
- [ ] Provider capability flags: identify mutating actions (GitHub ops except read‑only; HTTP methods ≠ GET/HEAD; file writes).
- [ ] For critical external steps: provide idempotency and/or compensation hooks (sagas) (optional roadmap).
- [ ] Suppress downstream mutating steps when contracts/fail_if fail in critical branches (via dependency gating).

## 6) CLI & Safety Switches
- [ ] `--safe-mode` flag to disable mutating providers (dry‑run all externals) for verification.
- [ ] (optional) `--safety-profile strict|standard` to adjust loop budgets and retry caps globally.

## 7) Telemetry & Observability
- [ ] Emit structured fault events: `fault.detected`, `fault.isolated`, `fault.recovery.{attempted,failed,succeeded}`.
- [ ] Metrics: retries attempted, logical vs transient failure counts, loop budget hits, contract violations by check.
- [ ] Journal: ensure all contract/transition decisions and expressions are captured with scope/timestamps.

## 8) Persistence
- [ ] Keep JSON snapshot export (done) and add (optional) debug‑resume path gated by a debug flag.

## 9) Defaults & Examples
- [ ] Update `defaults/visor.yaml` (and any bundled defaults) to declare `criticality` for relevant checks and prefer `transitions` over `goto_js` where applicable.
- [ ] Update `defaults/task-refinement.yaml` and `defaults/agent-builder.yaml` to use `criticality` and transitions where appropriate; ensure no `assume` refers to own output.
- [ ] Convert inline YAML arrays in defaults to block‑style lists for consistency.
- [ ] Add an annotated example block with all primitives (if, assume, guarantee, fail_if, transitions) and modes (reference the guides) in the defaults or examples folder.
- [ ] Verify defaults run green via dist CLI:
      - `npm run build:cli`
      - `node dist/index.js test defaults/visor.tests.yaml --progress compact`
      - Any other default suites (`task-refinement`, `agent-builder`) if present.

## 10) Tests
- [ ] Unit (engine/native):
      - `assume` skip vs guard‑step hard‑fail (no provider call on skip).
      - `guarantee` violation adds `contract/guarantee_failed` and does not double‑execute provider.
      - Transitions precedence over `goto_js`; undefined transition falls back to `goto`.
      - Loop budget enforcement per scope (error surfaced; routing halts in that scope).
      - Criticality policy mapping (external/control‑plane/policy/non‑critical) sets defaults (gating, retries, budgets).
- [ ] Integration:
      - Critical external step blocks downstream mutating side‑effects on contract/fail_if failure (dependents gated).
      - Control‑plane forEach parent respects tighter loop budget; no oscillation beyond cap.
      - Retry classifier: transient provider errors retried; logical (fail_if/guarantee) not auto‑retried in critical modes.
      - Non‑critical step with `continue_on_failure: true` does not block pipeline.
- [ ] YAML e2e / Defaults:
      - `defaults/visor.yaml` flow passes using transitions.
      - `defaults/task-refinement.yaml` and `defaults/agent-builder.yaml` pass with `criticality` declared.
      - Add a strict safety profile scenario (e.g., `safety: strict`) and ensure it passes.
- [ ] CI Gates:
      - Add a job to build CLI and run default YAML suites with `--progress compact`.
      - Run unit/integration on PR; block merges on regressions.

## 11) Docs (remaining polish)
- [ ] README or landing page: link to Criticality Modes and Fault Management guides.
- [ ] Ensure quick‑starts show `criticality` in at least one example (SDK & CLI done).
- [ ] Sweep older docs for inline arrays (`[a, b]`) and convert to block lists.
- [ ] Add “assume vs guarantee — do’s and don’ts” callout in any doc that introduces contracts (done for two guides).

## Acceptance Criteria
- [ ] All tests pass (unit/integration/YAML) with representative critical/non‑critical mixes.
- [ ] Config validator warns on unsafe/missing contracts and mis‑declared criticality.
- [ ] Engine enforces defaults per `criticality` while allowing explicit overrides.
- [ ] Logs have timestamps; debug gated; decisions visible in journal and metrics.
- [ ] No dist/ artifacts in commits.
- [ ] Updated defaults (`defaults/visor.yaml`, `defaults/task-refinement.yaml`, `defaults/agent-builder.yaml`) run green via dist CLI in CI.
