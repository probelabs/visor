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

The live runner currently exposes only a zero-model preflight. Run it from the
repository root:

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

Live baseline/resume/evaluation mode is not implemented yet. Any mode other
than `--preflight-only` is rejected.
