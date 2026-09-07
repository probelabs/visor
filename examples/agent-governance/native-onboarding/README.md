# Milestone A: native Proof onboarding

This example is a bounded, one-component slice of the Product-Native Proof
Governance plan. It uses a normal Visor `command -> ai` DAG:

1. fail-closed checkout preflight and `proof init`;
2. built-in `onboard` role rendering;
3. an editable Luna worker that authors native Proof requirements, variables,
   annotations, and traces;
4. persisted audit/checklist evidence;
5. independent built-in `spec-review` rendering and editable review worker;
6. a non-empty native-requirement gate and final evidence capture.

The YAML contains operational dependencies and prompts only. Role doctrine is
resolved at runtime with `proof role show`; it is not copied into the graph.
The AI workers use the normal `ai` provider. They do not use the read-only
`governed-proof-inspect` provider.

## Launch

Prepare an isolated, session-owned checkout from a verified *unannotated*
historical commit first. The current jsonparser HEAD already contains native
Proof files and is intentionally rejected by the preflight; never run this
example from the original source checkout:

The demonstrated runtime used local Probe source `36c6cf04`, which contains
[Probe PR #597](https://github.com/probelabs/probe/pull/597). This is a source
fix, not an npm release: the package metadata's historical `0.6.0-rc332`
base (tagged here as `rc337`) does not publish that fix. Use a Probe source or
build containing that change before launching; older packages retain a hard
`600000` ms inner Codex request cap even when the outer Visor timeout is larger.
The wrapper inherits `REQUEST_TIMEOUT` from its environment and adds no timeout
control of its own. The reproducible budget below sets the Probe request cap to
`1400000` ms, below each worker's `ai.timeout` of `1500000` ms and the outer
Visor timeout of `1800000` ms.

```sh
git clone --no-hardlinks /path/to/jsonparser /tmp/jsonparser-native-onboarding
git -C /tmp/jsonparser-native-onboarding checkout --detach <verified-unannotated-commit>
REQUEST_TIMEOUT=1400000 node examples/agent-governance/native-onboarding/run-demo.cjs \
  --subject-root /tmp/jsonparser-native-onboarding \
  --original-root /path/to/jsonparser \
  --proof-bin /absolute/path/to/proof \
  --visor /path/to/visor/src/index.ts \
  --timeout 1800000 \
  --output /tmp/jsonparser-native-onboarding-run
```

The launcher requires an absolute, executable `--proof-bin` and passes its
resolved path to commands and the dynamic Bash allow-list. It forces
`USE_CODEX=true`, disables provider fallback, and runs Visor with the subject
checkout as its process cwd. For a source Visor entrypoint, the helper uses
`ts-node/register/transpile-only`; a built entrypoint can be supplied instead.
The parent session must provide the private Luna/Codex authentication through
its own `CODEX_HOME` (with Luna, xhigh reasoning, workspace-write, and network
disabled); this example neither copies nor prints auth. Set
`SUBJECT_BASELINE_REVISION` when the launcher should enforce an exact pinned
commit.

For a zero-model preflight/init check:

```sh
node examples/agent-governance/native-onboarding/run-demo.cjs \
  --subject-root /tmp/jsonparser-native-onboarding \
  --original-root /path/to/jsonparser \
  --proof-bin /absolute/path/to/proof --preflight-only
```

`--preflight-only` mutates only the isolated subject by creating its Proof
project and recording the post-init requirement baseline. It must report a
run-owned `preflight-complete` marker; a clean process exit without that marker
is a failure. Use a fresh subject for a fresh campaign. `proof init` is not a
recovery or resume protocol.

## Inspect output

The output directory is created outside both subject and original roots. It
contains incremental `visor.stdout.log` and `visor.stderr.log`, a redacted
`launch.json`, `report.json`, and command-specific Proof streams/artifacts.
The `native/` bundle is deliberately whitelisted: regular `*.req.yaml` and
`*.vars.yaml` files under `specs/stakeholder`, `specs/system`,
`specs/software`, and `specs/integration`; direct `proof/checklists/*.state.yaml`;
direct `proof/reviews/*.yaml`; `proof.yaml`; and
`docs/get-string-requirements.md`. Symlinks, `.proof`, and unrelated repository
files are excluded, except an in-scope leaf `*.vars.yaml` projection whose
canonical regular target is also selected under an approved specs root; that
projection is preserved as a relative symlink to the copied canonical file.
`source-annotations.patch` is a separate bounded diff for `.gitignore`,
`parser.go`, and `parser_test.go`, so source annotations remain inspectable even
when native collection fails.
The subject checkout contains the readable native files, annotations, traces,
and Proof state. Inspect `report.json` first, then the native diff and selected
audit/checklist output. Failed commands retain their diagnostics; an exit code
of zero is not a declaration of full success.

The report distinguishes materialized requirement files from validated and
reviewed state. The gate rejects an empty native requirement set even when the
AI process exits zero. Unresolved audit findings are allowed for this demo and
must remain visible.

The current evidence was recovered by manually tailing a retained subject and
its output after the run stopped. It is not evidence of a successful
uninterrupted fresh run, and it does not demonstrate durable B resume or
recovery. Treat the retained Proof files, traces, and logs as the curated
evidence to inspect; use a fresh subject for a new run.

## Milestone B: Graph-v2 review progression

`visor-milestone-b.yaml` is a small read-only review prototype over the same
native subject. It uses ordinary command and AI providers, Graph-v2 keyed
`expand`, nested per-requirement scopes, and the existing
`wait_for_expansion` fan-in. It does not use legacy `forEach`, a workflow
barrier, governed-proof-inspect, Proof admission, or a second scheduler.

The thin SDK runner has three explicit modes. `prepare` is zero-model: it
renders the built-in `spec-review` role and collects the actual component
catalog, each requirement's `req show` result (including Proof's computed
file hash), and its focused spec graph. Read-only AI workers review one exact
item in parallel; the post-AI command persists a review-candidate packet with
that scheduled snapshot, not observed current Proof state. The component
fan-in then serially re-lists/re-shows every item and runs Proof validation,
audits, checklist, and status, keeping warnings and incompleteness visible.
`pause` holds one natural generated requirement at the ready frontier while
other dispatched work may progress and exports the existing canonical Graph
checkpoint. `resume` is a new process invocation: it re-fetches each Proof
file hash, rejects stale inputs, then calls the existing
`resumeGraphCheckpoint` API. Use an isolated subject and a private caller-
provided read-only `CODEX_HOME` for the latter modes; this example never
copies or prints authentication.

For this B workflow, provide `REQUEST_TIMEOUT=480000`; Milestone A retains its
separate longer budget. Each B review has an AI timebox of 480000 ms and a
540000 ms check envelope. These are execution timeboxes and scope guidance,
not a guarantee that an external provider or sandbox will honor an outer
timeout. The reviewer is asked to aim for about three minutes and return a
concise candidate; this is not a fixed call quota or a success gate. The
phase-specific brief keeps the worker on one supplied Proof snapshot: it uses
the recorded `req_show`/`spec_graph`, targeted read-only source/test/vars/
annotation reads, and reports unresolved evidence rather than rescanning
`.proof` internals, history, global checks, builds, tests, or vet.

```sh
export REQUEST_TIMEOUT=480000
node -r ./node_modules/ts-node/register/transpile-only \
  examples/agent-governance/native-onboarding/run-milestone-b.ts prepare \
  --subject-root /path/to/isolated-subject \
  --original-root /path/to/protected-original \
  --proof-bin /absolute/path/to/proof \
  --output /tmp/native-onboarding-b

node -r ./node_modules/ts-node/register/transpile-only \
  examples/agent-governance/native-onboarding/run-milestone-b.ts pause \
  --subject-root /path/to/isolated-subject \
  --original-root /path/to/protected-original \
  --proof-bin /absolute/path/to/proof \
  --output /tmp/native-onboarding-b

node -r ./node_modules/ts-node/register/transpile-only \
  examples/agent-governance/native-onboarding/run-milestone-b.ts resume \
  --subject-root /path/to/isolated-subject \
  --original-root /path/to/protected-original \
  --proof-bin /absolute/path/to/proof \
  --output /tmp/native-onboarding-b
```

Inspect `prepare/`, `paused/`, `resumed/`, and incremental `commands/` output.
The runner also preserves post-execution checkpoint/observation diagnostics
under `diagnostic/` when a mechanical assertion fails. For a no-model
integration check only, set `NODE_ENV=test VISOR_NATIVE_B_ZERO_MODEL_TEST=true`;
this explicitly swaps the nested reviewer for the built-in mock and writes
rendered prompt witnesses under `diagnostic/zero-model-prompts/`. The flag is
rejected outside test mode and is never part of the live Luna path.
Candidate review prose, materialized native state, Proof validation/audit/
checklist results, and execution completion remain separate. A ready-frontier
pause is not in-flight overlap or demonstrated interruption recovery. This
prototype does not claim concurrent per-spec Proof validation; selective
reruns, project reconciliation, and full-campaign admission remain deferred.

## Fresh native onboarding flow

`visor-onboarding.yaml` is the bounded fresh-project flow. Its launcher accepts
generic absolute roots, checks the unannotated subject and protected original,
requires a caller-provided private `CODEX_HOME` with no MCP/plugin/hook or
subject-local Codex overrides, then runs `proof init` in the subject before
loading the graph. It records only safe preflight facts; it never copies or
prints authentication or raw Codex configuration.

The isolated-writer flow requires the reviewed Probe source at commit
`8bc0cc88` (currently installed from a clean local archive); this is not a new
published package release. Earlier Probe pins describe historical runs, not
the isolated-writer configuration. The bounded real-Luna writer exercise passed;
the complete newly wired onboarding flow still needs its end-to-end run.

```sh
SUBJECT_BASELINE_REVISION=cb835d480ac58e1b4be76afeac49e89ed651c3b5 \
REQUEST_TIMEOUT=480000 \
TS_NODE_TRANSPILE_ONLY=1 npx ts-node examples/agent-governance/native-onboarding/run-onboarding.ts \
  --subject-root /absolute/path/to/fresh-subject \
  --original-root /absolute/path/to/jsonparser \
  --proof-bin /private/tmp/proof-native-graph-tools.0B8QnO/proof \
  --output /absolute/path/to/fresh-onboarding-output \
  --timeout 1800000
```

`REQUEST_TIMEOUT` is required to be smaller than the outer timeout. The
launcher sets `USE_CODEX=true`, `DISABLE_FALLBACK=1`, and `AUTO_FALLBACK=0`
before any provider dispatch.

For a zero-model boundary check on a disposable fresh subject, append
`--preflight-only`; it still initializes Proof, resolves the real inventory and
onboard role invocation, and strictly validates the actual registered providers,
but does not dispatch Visor checks or AI workers.

The runner commits initialized native Proof files as a separate runtime
baseline, retaining the original source revision. The graph lets Proof discover
natural components and supplies each exact native WorkItem to a distinct,
persistent checkout of that initialized baseline. Luna authors can progress
independently under the isolated writer profile. Only ownership-checked
promotion, canonical requirement enumeration, and native validation use the
shared `proof-workspace-mutation` resource. Promotion validates staged native
files through Proof, preserves sibling ownership, and rejects conflicting
changes; an interruption after writes start is a failure, not an unchanged
rejection. It does not claim crash-atomic application or recovery.

After promotion, the graph re-lists native requirements and focused graphs,
runs separate Luna/xhigh read-only review, persists review packets, and records
native validation/audit/checklist/status. Review output is evidence only;
authoring, Git promotion, and review never become native approval. Independent
author/reviewer overlap is enabled by this wiring but remains to be measured
in the real flow.

The current Graph-v2 compiler permits one nested expansion owner. This flow
uses that owner for natural component scopes, so the output explicitly records
the open step “per-requirement Graph-v2 expansion” while the component packet
still contains every real requirement snapshot. The output `summary.json`,
`checkpoint.json`, `postflight.json`, and retained command streams distinguish
discovery candidate/admission, reviewed packets, native validation, and the
uncompleted component-admission/project-reconciliation boundary. No approval
is inferred when that boundary remains open.

## Historical single-component milestone scope

The slice is parser iteration/extraction, selected from the actual checkout by
the worker. Implementation behavior must remain unchanged; source comments and
Proof artifacts are permitted. DeFi-only obligation classes are inspected for
applicability and skipped with an honest disposition when irrelevant.

This is not full onboarding. Hazard analysis, broad coverage, history mining,
interruption/recovery, selective reruns, parallel component scheduling,
continuous maintenance, and full-campaign admission are deferred. The helper
does not claim candidate prose is materialized, does not synthesize semantic
fixtures, and does not claim Milestone B completion or introduce a new
protocol.
