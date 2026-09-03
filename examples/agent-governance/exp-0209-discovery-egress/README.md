# EXP-0209 discovery-egress checkpoint demo

This is a bounded, deterministic onboarding / re-onboarding demonstration. It
uses the existing two-process fixture at
`tests/fixtures/proof-current-catalog-checkpoint-child.ts`: process A builds a
quiescent three-component checkpoint, process B edits only `alpha.go` and
continues it with fresh Proof catalog bytes, and a repeat continuation checks
that the same authority is a no-op. The Probe answers are fake and the fixture
does not make model or network calls.

Run it from the repository root:

```sh
TS_NODE_TRANSPILE_ONLY=1 node -r ts-node/register/transpile-only \
  examples/agent-governance/exp-0209-discovery-egress/run-demo.ts \
  /tmp/visor-exp-0209-discovery-egress-demo
```

The caller-provided directory receives:

- `baseline.checkpoint.json`
- `continued.checkpoint.json`
- `demo-report.json`
- `demo-report.md`
- `visor.template.yaml` (the tracked human-readable operational graph template/source of truth)
- `effective-config.yaml` (the readable effective runtime config, including the fixture's injected temporary project root)
- `graph.dot`
- `graph.svg` and `graph.png` when the local `dot` executable is available

If no output directory is supplied, the runner uses a temporary directory
named `visor-exp-0209-discovery-egress-demo-<pid>` under the platform temp
directory. The runner stages the fixture's intermediate files in a separate
temporary directory and removes that staging directory after publication.

`visor.yaml` in the repository is the human-readable graph template/source of
truth. The runner bundles it as `visor.template.yaml`; `graph.dot` is generated
from that template's checks, dependencies, emissions, and expansion barriers.
The fixture injects an absolute temporary project root into its effective
runtime config, which is bundled separately as `effective-config.yaml` and is
the config whose graph digest is recorded in the checkpoints.

The checkpoint and report files are runtime evidence. Fresh-process pause/resume
is proven inside the bounded run, but the checkpoint is not independently
portable after the run: the fixture repository and absolute project root are
temporary and removed, and no path-rebinding feature is claimed.

The fixture builds the local Proof CLI from the exact commit
`b6662983f50d58c4fdede138fc0585627bd8cf8c`. By default, the source checkout is
the sibling `../reqforge` relative to this repository; override it with
`VISOR_PROOF_SOURCE_REPO=/path/to/reqforge`. The fixture verifies that commit
with `git cat-file`, archives that commit, and builds with `GOPROXY=off`,
`GOSUMDB=off`, and `GOTOOLCHAIN=local`, so the pinned source and dependencies
must already be available locally. No Proof binary path override or network
fetch is used.

## Live-demo preflight

The live runner exposes a zero-model preflight and a separate explicit live
baseline mode. Run the preflight from the repository root:

```sh
TS_NODE_TRANSPILE_ONLY=1 node -r ts-node/register/transpile-only \
  examples/agent-governance/exp-0209-discovery-egress/run-live-demo.ts \
  --preflight-only \
  --output /tmp/visor-exp-0209-live-preflight \
  --subject /Users/buger/go/src/reqforge-agent-governance-poc/experiments/agent-governance/poc-01-subject/subject \
  --evaluator /Users/buger/go/src/reqforge-agent-governance-poc/experiments/agent-governance/poc-01-subject/evaluator
```

`--subject` and `--evaluator` default to the paths shown above. The preflight
creates a private `workspace/`, copies only the seven subject source files and
a minimal `proof.yaml`, builds the pinned Proof CLI offline, runs the public Go
tests and the separate hidden baseline oracle, checks the evaluator patch,
resolves the shipped `onboard` role, and compiles the graph. It writes
`preflight.json` with the exact pins and evidence; governed/model dispatch
counts are zero, network dispatches are requested zero, and Go runs offline.
The evaluator copy and patch copy are temporary directories
outside the workspace.

The preflight command remains zero-model and does not invoke a governed role.

## Live baseline (explicit opt-in)

`--baseline-only` first runs the accepted preflight, writes the effective config,
then starts a fresh internal child with only the owned output directory and the
controller PID. Evaluator information is absent from the child argv, the
model-visible workspace/config/prompts; the retained preflight artifact is
controller evidence, not evaluator context. It executes the real sealed Proof
admission/provider path and may spend up to 4 live RoleRuns (one project
discovery and up to 3 component inspections), depending on discovery. Only
exactly four RoleRuns (three components) pass the baseline gate. The baseline
runner's run-scoped factory budget ceiling is four RoleRuns; retries are zero
and fallback is false.
Invoke it only when that live spend is explicitly intended:

```sh
TS_NODE_TRANSPILE_ONLY=1 node -r ts-node/register/transpile-only \
  examples/agent-governance/exp-0209-discovery-egress/run-live-demo.ts \
  --baseline-only \
  --output /tmp/visor-exp-0209-live-baseline \
  --subject /Users/buger/go/src/reqforge-agent-governance-poc/experiments/agent-governance/poc-01-subject/subject \
  --evaluator /Users/buger/go/src/reqforge-agent-governance-poc/experiments/agent-governance/poc-01-subject/evaluator
```

On success the owned output contains `baseline.checkpoint.json` and
`baseline-report.json`/`.md`, including controller and child PIDs, session,
component IDs, exact counts, the project receipt ID, and the passed gate. A
failed or incomplete run retains an honest `baseline-report.json` with partial
or unknown counts and never retries/resumes; safely exported rejected evidence
is written as `baseline-failure.checkpoint.json`.

`--preflight-only` remains the zero-model command documented above. Internal
`--baseline-child` is not a public invocation: it requires the controller PID
and the output directory produced by an accepted preflight.

## Live selective resume (explicit opt-in)

`--resume-only` requires an accepted baseline-only output directory and the
same pinned subject/evaluator inputs. The controller creates the exclusive
private `resume.started.json` marker before touching the workspace, checks the
exact evaluator patch, applies it, and requires that only `http.go` and
`http_test.go` differ. It runs the public Go tests offline, asks the pinned
Proof CLI for canonical revalidation and WorkItems bytes, and records hashes,
the changed component, and the diff digest without retaining evaluator or
patch paths in the child hand-off.

```sh
TS_NODE_TRANSPILE_ONLY=1 node -r ts-node/register/transpile-only \
  examples/agent-governance/exp-0209-discovery-egress/run-live-demo.ts \
  --resume-only \
  --output /tmp/visor-exp-0209-live-baseline \
  --subject /Users/buger/go/src/reqforge-agent-governance-poc/experiments/agent-governance/poc-01-subject/subject \
  --evaluator /Users/buger/go/src/reqforge-agent-governance-poc/experiments/agent-governance/poc-01-subject/evaluator
```

The private `--resume-child` receives only the owned output and controller PID.
It validates the marker, canonical Proof bytes, hashes, modes, and workspace
diff before bootstrapping the sealed Proof admission provider and making one
continuation call. A successful run writes `continued.checkpoint.json`,
`resume-report.json`/`.md`, and `resume.completed.json`; failures report honest
partial or unknown counts and never overwrite baseline or prior resume
evidence. Resume is one-shot: a marker or any resume evidence rejects a later
invocation.

## Live onboarding quality evaluation (controller-only)

`--evaluate-only` accepts an already completed baseline plus selective resume.
It requires the accepted baseline/resume checkpoints, reports, completion
markers, exact five-role gate (4 baseline + 1 replacement), and the pinned
subject/evaluator inputs. It performs no live-role child/bootstrap/engine/Probe/model or
network dispatch. The controller reads the pinned evaluator
`manual-baseline.json`, runs the hidden oracle in two fresh private offline Go
copies, and then evaluates seven equal-weight criteria: grouping, ownership,
coordinates, baseline HTTP defect, XSS false-positive handling, resumed HTTP
resolution, and the hidden oracle.

```sh
TS_NODE_TRANSPILE_ONLY=1 node -r ts-node/register/transpile-only \
  examples/agent-governance/exp-0209-discovery-egress/run-live-demo.ts \
  --evaluate-only \
  --output /tmp/visor-exp-0209-live-baseline \
  --subject /Users/buger/go/src/reqforge-agent-governance-poc/experiments/agent-governance/poc-01-subject/subject \
  --evaluator /Users/buger/go/src/reqforge-agent-governance-poc/experiments/agent-governance/poc-01-subject/evaluator
```

The one-shot output contains `evaluation.started.json`, `evaluation.json`,
`live-report.json`, `live-report.md`, `graph-source.yaml` (a copy of tracked
`visor.yaml`), and `evaluation.completed.json` published last. Reports record
the graph/config and input hashes, exact 4+1 RoleRuns, fanout, shared session
and prefix, changed/reused component closure, old/new receipts, oracle
outcomes, and every criterion score. Quality failures complete with status
`failed`; operational failures use status `error`. Evaluation never overwrites
prior evidence and does not copy the manual baseline into the workspace.
