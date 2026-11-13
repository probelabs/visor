# Live Telemetry Plan

## Status

This document is now implemented enough for merge, with only optional follow-ups deferred.

### Implemented

- Parent-side lifecycle spans for core Visor checks are live.
- Sandbox routing lifecycle spans are live.
- Sandbox child lifecycle spans are live.
- Sandbox child trace files are tailed incrementally while the child is still running.
- Final sweep and dedup for sandbox child trace ingestion are implemented.
- Probe tool lifecycle markers are live.
- `createToolSpan` support exists in the Visor Probe tracer adapter.
- Replayed sandbox child spans keep their original names instead of synthetic `child: ...` names.
- `tasks trace` rendering was updated to handle lifecycle spans and child spans correctly.
- Trace lookup now follows the current Visor telemetry configuration:
  - file-mode prefers local trace files first
  - OTLP/Grafana setups prefer remote backends first
  - missing `trace_id` values can be recovered from stored trace files

### Deferred

- optional direct child OTLP export mode for network-enabled sandboxes

### Merge Readiness

The core goal of this plan is met:

- traces are materially more live than before
- sandbox child work no longer waits until process exit to appear
- task trace rendering and backend selection follow the new model
- host-mode and engineer lifecycle visibility are explicit enough in realistic Oel runs

The remaining deferred item is an optimization, not a blocker.

## Goal

Make telemetry appear live for:

- Visor workflow/check spans
- Probe AI/delegate/tool activity
- sandboxed child checks

Keep the final duration spans for accuracy, but surface start/progress markers immediately.

Engineer-specific constraint:

- If engineer runs inside a sandbox, it is acceptable for deep child details to remain deferred initially.
- The parent trace must still show immediately that engineer started, which sandbox was selected, and that Visor is waiting on child execution.

## Non-Goal

Do not rely on open spans becoming visible in Tempo/Grafana before they end. That is not how the current exporter model behaves.

The practical solution is:

- emit short-lived lifecycle spans that end immediately
- keep long final spans for duration
- stream sandbox child telemetry back to the parent while the child is still running

## Current Behavior

### Host-mode Visor / Probe

- Most long-running spans are created with normal OTel span lifecycles and appear only after `span.end()`.
- Some Probe events are intentionally promoted into short-lived child spans and appear almost immediately.
- Slack and some long-running frontends call `forceFlushTelemetry()`, which helps only for spans that already ended.

### Sandboxed checks

- Child `--run-check` execution writes telemetry to a file via `VISOR_FALLBACK_TRACE_FILE`.
- Parent ingests that file only after child process completion.
- Result: sandbox child spans appear only at the end.

This is the main reason sandbox work is not live today.

## Design Principles

1. Prefer lifecycle spans over waiting for long spans to finish.
2. Treat sandbox telemetry as a transport problem.
3. Do not require network access inside the sandbox.
4. Support both:
   - local file-based tracing
   - remote OTLP/Grafana tracing
5. Keep one implementation path that works even for `network: false` sandboxes.

## Target Architecture

### 1. Parent-side lifecycle spans

For every expensive operation, emit immediate short-lived spans:

- `*.started`
- `*.progress`
- `*.completed`
- `*.failed`

These should be used for:

- `visor.check.*`
- sandbox routing decisions
- Probe AI request start
- Probe delegated search start
- Probe tool execution start/completion
- engineer parent lifecycle

Status:

- Implemented for the intended baseline
- `started` / `completed` / `failed` / `progress` coverage exists for the main Visor check path
- sandbox routing and sandbox child lifecycle markers exist
- engineer-specific parent lifecycle markers exist

These spans should end immediately and be flushed aggressively enough to appear within 1-2 seconds.

### 2. Keep final duration spans

Do not remove:

- `visor.check.<id>`
- `visor.ai_check`
- `ai.request`
- `search.delegate`

These remain the authoritative duration spans and will still appear after completion.

Status:

- Implemented

### 3. Sandbox child telemetry transport

Sandbox child telemetry must support two modes.

#### Mode A: Host-mediated live relay (default)

Use when:

- local file tracing
- remote OTLP/Grafana
- sandbox has no network
- sandbox network policy is unknown

Flow:

1. Parent creates child trace file path in mounted workspace.
2. Child writes spans incrementally to that file.
3. Parent starts a live tailer immediately after child launch.
4. Parent ingests appended span records continuously while child is running.
5. Parent re-emits them into its own OTel pipeline.
6. Parent performs one final sweep after child exit.

This mode works without sandbox network access.

Status:

- Implemented as the default path

#### Mode B: Direct child OTLP export (optional optimization)

Use only when:

- sandbox network is enabled
- OTLP endpoint is reachable from container/sandbox
- required auth/env can be passed safely

Flow:

1. Parent propagates trace context and OTLP config into child.
2. Child exports directly to OTLP.
3. Parent still emits lifecycle spans locally.
4. Optional file fallback remains available if child export fails.

This must not be the only supported sandbox strategy.

Status:

- Deferred

## Local Setup Plan

Local setup means:

- `VISOR_TELEMETRY_SINK=file`
- NDJSON/file tracing
- local debug visualizer or local trace inspection

### Desired behavior

- Parent lifecycle spans show immediately.
- Probe lifecycle spans show immediately.
- Sandboxed child spans begin appearing while child is still running.

Status:

- Implemented

### Required work

1. Keep current file exporter.
2. Add a streaming/tailing ingester for `VISOR_FALLBACK_TRACE_FILE`.
3. Ingest only newly appended lines, not full file replay on each poll.
4. Re-emit each parsed child span to the active parent trace.
5. Finalize with one last pass after child exit.
6. Deduplicate records so final sweep does not duplicate already streamed spans.

Status:

- Implemented

### Notes

- This is the most important path for local debugging.
- It is also the safest path for all sandbox engines.

## Remote OTLP / Grafana Plan

Remote setup means:

- `VISOR_TELEMETRY_SINK=otlp`
- Grafana Tempo / Jaeger / OTLP collector

### Desired behavior

- Parent lifecycle spans appear within 1-2 seconds.
- Host-mode Probe lifecycle spans appear within 1-2 seconds.
- Sandboxed child spans appear live even if the child cannot access OTLP directly.

Status:

- Implemented through the file-tail relay baseline

### Required baseline

Use the same host-mediated live relay as local mode.

That gives:

- child writes local file
- parent tails file
- parent re-emits child spans into parent OTel SDK
- parent OTel exporter sends to Grafana/Tempo

This avoids any dependency on sandbox network reachability.

### Optional optimization

Direct child OTLP export may be enabled later for Docker/network-enabled environments, but it must remain optional.

Status:

- Deferred

## Detailed Work Plan

### Phase 1: Improve live visibility for host-mode spans

#### 1.1 Add standard lifecycle span helper

Add a helper that creates an immediate child span and ends it immediately.

Use it for:

- check scheduled
- check started
- provider selected
- sandbox selected
- child spawned
- waiting on child
- completed
- failed

Status:

- Implemented for the main helper path

#### 1.2 Apply to Visor check execution

Emit lifecycle spans around:

- state-machine dispatch
- provider execution start
- sandbox routing decision
- provider completion/failure

Status:

- Implemented for the intended baseline
- main check `started` / `completed` / `failed` / `progress` coverage exists

#### 1.3 Extend Probe tracer adapter

Current adapter already creates immediate spans for some events.

Extend it so it consistently emits immediate lifecycle spans for:

- `probe.ai_request.started`
- `probe.search_delegate.started`
- `probe.tool.started`
- `probe.tool.completed`
- `probe.tool.failed`

Also implement `createToolSpan` in the adapter so Probe DSL / `execute_plan` paths are visible too.

Status:

- Implemented for the intended baseline
- `probe.tool.started/completed/failed` exist
- `createToolSpan` exists
- explicit `probe.ai_request.started` / `probe.search_delegate.started` exist

#### 1.4 Add throttled flush

For long-running frontends:

- flush after critical lifecycle markers
- optionally periodic flush every 5-10 seconds while a run is active

This should be rate-limited to avoid exporter pressure.

Status:

- Implemented with throttled non-blocking flush requests on immediate lifecycle spans

### Phase 2: Replace end-of-process-only sandbox ingestion

#### 2.1 Build a tailing child trace ingester

Requirements:

- open child trace file after launch
- read appended NDJSON lines incrementally
- tolerate partial writes
- maintain file offset
- parse only complete lines
- ignore malformed partial fragments until completed

Status:

- Implemented

#### 2.2 Re-emit child spans continuously

As lines arrive:

- parse span record
- skip fallback markers / duplicates
- emit to parent OTel tracer immediately

Child span attributes should include:

- `visor.sandbox.child_span = true`
- child metadata such as check id / sandbox name / source file if available

Status:

- Implemented
- child spans now keep original span names and carry child-origin metadata

#### 2.3 Final sweep

After child exit:

- read remaining bytes
- parse remaining complete lines
- ingest anything missed

Status:

- Implemented

#### 2.4 Deduplication

Need a stable dedup key:

- child `traceId + spanId`
- or file offset + hash fallback if trace ids are unavailable

Without dedup, streaming plus final sweep will duplicate spans.

Status:

- Implemented

### Phase 3: Engineer parent lifecycle

Engineer-specific requirement:

- parent should show immediate visibility even if inner engineer details are deferred

Emit immediate spans:

- `engineer-task.started`
- `engineer-task.sandbox_resolved`
- `engineer-task.child_spawned`
- `engineer-task.waiting_on_child`
- `engineer-task.completed`
- `engineer-task.failed`

If engineer is not sandboxed, host-mode Probe improvements will automatically apply.

Status:

- Implemented for the intended baseline
- generic check/sandbox lifecycle markers already make engineer runs visible
- dedicated engineer-specific markers exist for:
  - started
  - sandbox resolved
  - child spawned
  - waiting on child
  - completed
  - failed
  - progress

### Phase 4: Optional direct child OTLP mode

Only after host relay is stable.

Requirements:

- explicit enablement
- health/reachability check
- propagate trace context
- fallback to file relay automatically if unavailable

This is an optimization, not the default design.

Status:

- Deferred

## Acceptance Criteria

### Host-mode checks

Within 1-2 seconds after start, Grafana/debug viewer should show:

- check started
- provider selected
- Probe AI request started
- delegated search started

### Sandboxed checks

Within 1-3 seconds after child spawn, Grafana/debug viewer should show:

- parent sandbox lifecycle markers immediately
- streamed child spans beginning before child exit

### Engineer in sandbox

Within 1-2 seconds after start:

- engineer task started
- sandbox selection
- child spawned / waiting marker

Deep child details may remain deferred initially.

## Failure Modes To Handle

1. Child file does not exist yet
- tailer should retry

2. Child writes partial JSON line
- buffer until newline

3. Child file never grows
- still keep parent lifecycle markers visible

4. Read-only sandbox
- file relay may be unavailable
- parent must still emit sandbox lifecycle markers
- final child detail may be absent unless direct OTLP is available

5. Parent process crashes during streaming
- already-emitted spans remain available
- child may keep writing file for postmortem recovery

6. OTLP endpoint unavailable
- file/local behavior still works

## Rollout Order

1. lifecycle span helper
2. host-mode Visor lifecycle markers
3. Probe tracer adapter lifecycle markers + `createToolSpan`
4. throttled flush in long-running frontends
5. sandbox live tailer + incremental ingester
6. final sweep + dedup
7. engineer parent lifecycle markers
8. optional direct child OTLP mode

## Recommendation

Do not start with direct sandbox OTLP export.

Start with:

- lifecycle spans everywhere
- host-mediated streaming relay for sandbox children

That solves both:

- local file tracing
- remote Grafana/OTLP tracing

with one robust design that does not depend on sandbox network reachability.
