# Graph-v2 bounded dispatch from the CLI

The CLI exposes two distinct checkpoint paths:

- `--graph-checkpoint-in` with the existing `--graph-checkpoint-owner` performs
  catalog continuation and reconciliation. This remains the default behavior.
- `--graph-resume-ready` imports a checkpoint and dispatches only the ready
  frontier. Optionally pair it with `--graph-dispatch-owner` and
  `--graph-dispatch-limit` to bound keyed instances; the dispatch owner must
  exactly match a compiled expansion owner, including qualified nested owners.

Use `--graph-checkpoint-out` for every bounded run. A bounded run admits whole
keyed instances, then stops at a quiescent frontier when its instance budget is
exhausted. Its JSON result includes a `__graph_checkpoint` control result with
`state: "paused"` and `resume is required`; this is not terminal workflow
completion. A ready-only follow-up can export the next checkpoint. The
`drained-without-defer` state only describes the admitted frontier and likewise
does not assert that the overall workflow is complete. Ready-only resume may be
used without a bound, but pairing `--graph-resume-ready` with the dispatch owner
and limit enables the bounded-instance behavior described here.

For example, a bounded initial run uses:

```sh
TS_NODE_TRANSPILE_ONLY=1 node -r ./node_modules/ts-node/register/transpile-only ./src/index.ts \
  --config ./config.yaml --check discover --output json \
  --graph-dispatch-owner '["project","materialize"]' \
  --graph-dispatch-limit 1 --graph-checkpoint-out /absolute/path/checkpoint-a.json
```

In a fresh process, the follow-up adds `--graph-resume-ready`, passes checkpoint
A via `--graph-checkpoint-in`, and writes a different new checkpoint B:

```sh
TS_NODE_TRANSPILE_ONLY=1 node -r ./node_modules/ts-node/register/transpile-only ./src/index.ts \
  --config ./config.yaml --check discover --output json \
  --graph-dispatch-owner '["project","materialize"]' \
  --graph-dispatch-limit 1 --graph-resume-ready \
  --graph-checkpoint-in /absolute/path/checkpoint-a.json \
  --graph-checkpoint-out /absolute/path/checkpoint-b.json
```

Checkpoint validation and graph/config digest checks run before provider
dispatch. Ready-only resume does not reconcile external subject freshness or
retry failed leaves; workflow policy and native Proof remain responsible for
those decisions.
