# EXP-0210 focused spec-review diagnostic

Status: CONSUMED_FAILED_TERMINAL; ZERO_MODEL_BOUNDARY_LOCALIZED;
PROBE_DIAGNOSTIC_PR_OPEN. The 13/13 zero-model harness gate passed and Sol
ACCEPT applies to that gate only, not to the live outcome. This record is
limited to the retained preflight and focused diagnostic artifacts; it grants
no live authority.

## Pins and retained evidence

- Visor base `025f53ce`; frozen head `a64238a975069ece644c566680fb0525802f9797`.
- YAML SHA-256 `12f04fbbd6625aae75e5ad9201b81b2841446ab001921bac59c9f54ac773b3b9`.
- Runner SHA-256 `b4e7c237aacca5033aed78c2b4c7d5e881cd308b16ea60a1cc75c884e220d165`.
- Proof `543994bd68f2b6d6217749c4c19be737021b993a`; Probe `0.6.0-rc334`; Codex `0.150.1`; profile `luna-xhigh-readonly-v1`.
- Subject baseline `cb835d480ac58e1b4be76afeac49e89ed651c3b5`, fix `3980c9c9b9919e643bd095fa4469bfa19e29f20c`, and 13 archived files.
- Historical root `f92c73d79e79102093bdb93bc0b75fc037900618`; lineage fingerprint `sha256:af892646ce4a1ccf206224987408c102bd140348931fcb1d2d378bf4887b3955`.
- Spec-review invocation digest `sha256:ca887cd69d9e97df6b825ef6126a941982eb2937fe2ea33d0f31e86c0c526fad`.
- Graph digest `306b074949f3975a5396dfffe74fc335790f7c6247f9b6c0ea90a5555d8fb212`; retained checkpoint SHA-256 `1c7a3a8ac34ad7059f2ff6343bd7f3038edf201c6936ee0177766a84c07fd249`.
- Retained preflight receipt SHA-256 `d46cd19eb7b7cc64165288caee36498591860da1d636a6f9bd2393ca07bb6507`.
- Focused preflight report SHA-256 `6e64c25fe77291e6ac57e5b8a193864c7429b6e3afea356d46d38dd569bd32e1`; focused run report SHA-256 `ad34968662db631ff380e473fb977c88c1a875f1c7d1f8dc22e82277ebb53105`.

The source/config contract is [the live runner](../../examples/agent-governance/exp-0210-jsonparser-staged/run-live-demo.ts), [the staged graph](../../examples/agent-governance/exp-0210-jsonparser-staged/visor.yaml), and [the zero-model preflight test](../../tests/integration/exp-0210-jsonparser-staged-live-preflight.test.ts).

## Zero-model preflight

The focused preflight restored the retained `parser-core` `spec_review`
generation with graph digest above, session `solid-swan-bfu7`, exact aliases
`admission`, `candidate`, `component`, authority digest
`sha256:5ebfb3434654b5917330cfb485c50309348e8160f274e234cac1a15b40492a26`,
and onboarding-stage digest
`sha256:2f405001713a0da5fad391d14a8de2db8e34ae8efe2567da2112fc13496eb339`.
It reported governed/model/network calls `0/0/0`, retries `0`, fallback
`false`, and clean historical termination (`MANAGED_OUTCOME_FAILED` with
cleanup `clean`).

The retained inputs are `/tmp/visor-exp0210-focused-preflight-final.eDTvPJ/output`
and `/tmp/visor-exp0210-focused-run-final.ULimhJ/output`.

## One-call focused outcome

The focused child consumed budget `1` and recorded one governed attempt. Its
timeline was `derived` → `managed_run_started` → `managed_run_outcome` →
`managed_run_closed`; close was clean, retries `0`, and fallback `false`.
Call ledger: budget `1`, runner constructions `unknown`, governed calls `1`,
model calls `unknown`, and network dispatches `unknown`.
The outcome was `provider_failed` with only the closed taxonomy
`answerFailureStage: unknown`; no candidate was produced. Stdio is represented
only by bounded byte counts/digests: stdout 33 bytes,
`sha256:c6c4f02b0c8066d8307658b947dd64cbe287c7d05897755d55ae987014d75a66`,
with the expected control line; stderr 0 bytes,
`sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`.
No raw prompt, output, error, or message is retained here.

## Zero-model localization and next step

The follow-up localizer at pushed Visor
`05b29f082107e46bf68e310d2cf03bbce69dd0a7` reused the retained
`parser-core/spec_review` request and real pinned Proof/provider construction,
but replaced `ProbeAgent.answerGoverned` with a closed sentinel before its
original invocation. Probe initialization completed, this provider correctly
performed no preview, the answer guard was hit exactly once, forbidden
process/network dispatch counts remained zero, and close completed cleanly.
The zero-model boundary test passed 1/1 and the focused suite passed 14/14.
This localizes the retained failure to the real `ProbeAgent.answerGoverned`
call, not a pre-answer acquisition/construction boundary or close. It does not
establish model/provider correctness, schema blame, or a successful candidate.
No new live/model call occurred.

Probe [PR #595](https://github.com/probelabs/probe/pull/595), pushed on
`codex/exp-0210-governed-diagnostics` at
`0fe631b9b244308c8a9c95eac2738b42ebd18811`, adds closed
`acquire`/`query`/`close` provider boundaries, `internal_contract`, and precise
invocation-attestation/native-capability predicates without replacing the
existing exact attestation predicates or exposing raw errors. Its focused
runtime and native-capability tests pass 54/54; independent Sol review returned
**ACCEPT**. The PR remains open, unmerged, and unreleased. Merge/publish requires
user approval; only afterward should Visor repin and, under separately granted
live authority, rerun this retained focused path. No fresh live run should occur
before the diagnostic build is integrated.
This observability step is necessary to the shortest north-star debugging loop,
not a graph-feature detour; no prompt, schema, scheduler, checkpoint, transport,
or authority change is indicated.
