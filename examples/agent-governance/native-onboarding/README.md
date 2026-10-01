# Current: native Proof checklist loop (standard Visor CLI)

The canonical onboarding entry is the ordinary Visor configuration
[`visor-native-checklist-loop.yaml`](./visor-native-checklist-loop.yaml). It
uses native Proof checklist state as its authority: a bootstrap/native-state
read, an editable role-driven author, an independent full Proof audit, and a
native checklist readback. The audit and readback can route the author once;
`routing.max_loops: 1` and `limits.max_runs_per_check: 2` make exhaustion a
terminal failure rather than approval. No custom runner or stage table is
part of the current path.

When the native checklist's current role is `spec-review`, the same YAML uses
Graph-v2 catalogs and template-local barriers: the live Proof requirement
catalog is grouped by component, byte-sorted, and split into batches of at
most five IDs. Each batch re-reads the current native role and exact component
slice before its isolated writer runs. Batch writers may make role-permitted
native Proof authoring changes and append review evidence, but they do not
confirm the checklist row. A parent finisher reloads the built-in role and
native checklist; only a confirmed structured readback can end the role.
Bootstrap and non-review roles continue through the existing generic author
path.

For a bounded Graph-v2 run, pair the compiled dispatch owner with a positive
instance limit and an absolute checkpoint path in an existing real private
`0700` parent directory; the new checkpoint file is published with mode
`0600`. For example:
`--graph-dispatch-owner '["native-component","enumerate-native-batches"]'
--graph-dispatch-limit 1 --graph-checkpoint-out
/absolute/path/to/existing-private-0700-checkpoint-dir/checkpoint-a.json`.
The qualified owner used by the CLI is derived from the compiled expansion
plan; do not invent a different owner string. The resulting checkpoint is a
paused frontier, not terminal workflow completion. A fresh process may use
`--graph-resume-ready --graph-checkpoint-in
/absolute/path/to/existing-private-0700-checkpoint-dir/checkpoint-a.json
--graph-checkpoint-out
/absolute/path/to/existing-private-0700-checkpoint-dir/checkpoint-b.json` to drain the ready
frontier, repeating the same dispatch owner and limit when the continuation
must remain bounded. Ready resume without those dispatch flags is intentionally
unbounded. Ready resume does not automatically invalidate prior completed work
or reconcile external subject freshness; the native Proof role/checklist
remains authoritative.

The standard CLI invocation keeps one explicit check and emits public JSON; use
the compiled owner printed by validation for the selected graph:

```sh
TARGET_ROOT=/absolute/path/to/existing-disposable-subject \
PROOF_BIN=/absolute/path/to/proof \
TS_NODE_TRANSPILE_ONLY=1 node -r ./node_modules/ts-node/register/transpile-only \
  ./src/index.ts \
  --config examples/agent-governance/native-onboarding/visor-native-checklist-loop.yaml \
  --check native-project-dispatch --event manual --output json \
  --graph-dispatch-owner '["native-component","enumerate-native-batches"]' \
  --graph-dispatch-limit 1 \
  --graph-checkpoint-out /absolute/path/to/existing-private-0700-checkpoint-dir/checkpoint-a.json

TARGET_ROOT=/absolute/path/to/existing-disposable-subject \
PROOF_BIN=/absolute/path/to/proof \
TS_NODE_TRANSPILE_ONLY=1 node -r ./node_modules/ts-node/register/transpile-only \
  ./src/index.ts \
  --config examples/agent-governance/native-onboarding/visor-native-checklist-loop.yaml \
  --check native-project-dispatch --event manual --output json --graph-resume-ready \
  --graph-dispatch-owner '["native-component","enumerate-native-batches"]' \
  --graph-dispatch-limit 1 \
  --graph-checkpoint-in /absolute/path/to/existing-private-0700-checkpoint-dir/checkpoint-a.json \
  --graph-checkpoint-out /absolute/path/to/existing-private-0700-checkpoint-dir/checkpoint-b.json
```

Run it from a separate disposable control repository while selecting the existing
disposable subject checkout with `TARGET_ROOT`. The target may retain its native
Proof state; this flow does not create a linked worktree or require re-onboarding
or a reset. Keep the protected/original checkout elsewhere and do not point
`TARGET_ROOT` at it. The standard target-binding check validates the selected
checkout, binds the editable author to its exact path, and all Proof commands
execute there. The author has a 600-second AI budget inside a 660-second check
budget, with one bounded reroute (at most two author/audit attempts). Supply the
pinned absolute Proof binary and the standard Visor source entrypoint. Native
roles may invoke bare `proof` commands; ensure `PATH` resolves the same pinned
Proof version, without adding a wrapper.

Each full Proof audit attempt is retained as target-local stdout JSONL and
stderr artifacts. The retry prompt receives only a small terminal receipt and
relative artifact paths, so inspect the referenced artifact for detailed findings
rather than pasting the full audit stream into model context.

```sh
cd /absolute/path/to/disposable-control-repo
TARGET_ROOT=/absolute/path/to/existing-disposable-subject
VISOR_ROOT=/absolute/path/to/visor-exp-0208-product-native-demo-pack
OUTPUT=/absolute/path/to/public-onboarding-output.json
mkdir -p "$(dirname "$OUTPUT")"
env -u CODEX_HOME \
  -u VISOR_ORIGINAL_WORKDIR \
  -u VISOR_WORKSPACE_ROOT \
  -u VISOR_WORKSPACE_MAIN_PROJECT \
  -u VISOR_WORKSPACE_MAIN_PROJECT_NAME \
  -u VISOR_WORKSPACE_INCLUDE_MAIN_PROJECT \
  TARGET_ROOT="$TARGET_ROOT" \
  PROOF_BIN=/absolute/path/to/proof \
  USE_CODEX=true FORCE_PROVIDER=codex MODEL_NAME=gpt-5.6-luna \
  DISABLE_FALLBACK=1 \
  VISOR_TRACE_DIR="$(dirname "$OUTPUT")/traces" \
  TS_NODE_TRANSPILE_ONLY=1 \
  TS_NODE_PROJECT="$VISOR_ROOT/tsconfig.json" \
  node -r "$VISOR_ROOT/node_modules/ts-node/register/transpile-only" \
    "$VISOR_ROOT/src/index.ts" \
    --config "$VISOR_ROOT/examples/agent-governance/native-onboarding/visor-native-checklist-loop.yaml" \
    --check native-completion --event manual --output json \
    --output-file "$OUTPUT" --timeout 7200000 --max-parallelism 1
```

For a subsequent run, `--task-tracking --verbose` may be appended to expose
public execution/task lifecycle metadata. Inspect tracked tasks during or
after a tracked run with the standard CLI:

```sh
env -u CODEX_HOME TS_NODE_TRANSPILE_ONLY=1 \
  TS_NODE_PROJECT="$VISOR_ROOT/tsconfig.json" \
  node -r "$VISOR_ROOT/node_modules/ts-node/register/transpile-only" \
  "$VISOR_ROOT/src/index.ts" tasks list --all --output table
```

Task tracking and `tasks list` report public lifecycle state only; they are not
token, approval, or model-liveness signals. `PROBE_PATH` is intentionally not
set here: provide a pinned absolute Probe path only when the selected source
configuration explicitly requires it.

### Read-only checklist display

After a bounded Graph-v2 invocation has produced a private 0600 checkpoint,
the retained renderer can make a display-only JSON/text/HTML readback. The
output directory must already be a real absolute 0700 directory and the three
output files must not exist:

```sh
TS_NODE_TRANSPILE_ONLY=1 node -r ./node_modules/ts-node/register/transpile-only \
  ./examples/agent-governance/native-onboarding/native-checklist-progress.ts display \
  --config /absolute/path/to/visor-native-checklist-loop.yaml \
  --checkpoint /absolute/path/to/checkpoint-a.json \
  --proof-bin /absolute/path/to/pinned/proof \
  --target-root /absolute/path/to/existing-disposable-subject \
  --output-dir /absolute/path/to/existing-private-0700-output-dir
```

This command restores and validates the checkpoint, fresh-reads
`proof checklist show onboard_v1 --format json` in `TARGET_ROOT`, and writes
only the three absent display files. It never dispatches, resumes, confirms,
invokes AI, or claims workflow completion; omit `--resumed` unless an external
caller has independently established that a resume actually executed.

For zero-model checks, validate the config and run the adjacent native YAML
mock suite:

```sh
TS_NODE_TRANSPILE_ONLY=1 node -r ./node_modules/ts-node/register/transpile-only \
  ./src/index.ts validate \
  --config examples/agent-governance/native-onboarding/visor-native-checklist-loop.yaml
TS_NODE_TRANSPILE_ONLY=1 node -r ./node_modules/ts-node/register/transpile-only \
  ./src/index.ts test \
  --config examples/agent-governance/native-onboarding/visor-native-checklist-loop.tests.yaml
```

The former bespoke onboarding launchers, policy helpers, and historical YAML
profiles were removed from the working tree. Their source remains available in
the [pre-removal Git revision `31ad54bd`](https://github.com/probelabs/visor/tree/31ad54bd525d80dc43241d4fffabe96702838aed/examples/agent-governance/native-onboarding)
for provenance and historical reproduction; the supported operational path is
the standard Visor CLI and the canonical YAML above. The command's process cwd
is the disposable control repository; `TARGET_ROOT` is the only selected
subject checkout.

The retained report/progress helpers are generic renderers and do not own Proof
completion. Their focused tests can be run with:

```sh
npx jest --runInBand \
  tests/unit/native-checklist-progress.test.ts \
  tests/unit/native-campaign-report.test.ts
```
