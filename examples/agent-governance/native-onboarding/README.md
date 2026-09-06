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

```sh
git clone --no-hardlinks /path/to/jsonparser /tmp/jsonparser-native-onboarding
git -C /tmp/jsonparser-native-onboarding checkout --detach <verified-unannotated-commit>
node examples/agent-governance/native-onboarding/run-demo.cjs \
  --subject-root /tmp/jsonparser-native-onboarding \
  --original-root /path/to/jsonparser \
  --proof-bin /absolute/path/to/proof \
  --visor /path/to/visor/src/index.ts \
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
must remain visible. A known runtime limitation is that an inner Probe/Codex
tool call may impose a ten-minute cap; the outer launcher timeout does not
promise to override that inner cap.

## Scope and deferred risk

The slice is parser iteration/extraction, selected from the actual checkout by
the worker. Implementation behavior must remain unchanged; source comments and
Proof artifacts are permitted. DeFi-only obligation classes are inspected for
applicability and skipped with an honest disposition when irrelevant.

This is not full onboarding. Hazard analysis, broad coverage, history mining,
interruption/recovery, selective reruns, parallel component scheduling,
continuous maintenance, and full-campaign admission are deferred. The helper
does not claim candidate prose is materialized, does not synthesize semantic
fixtures, and does not implement Milestone B recovery or a new protocol.
