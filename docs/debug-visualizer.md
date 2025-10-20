# Debug Visualizer (Live Execution View)

The Debug Visualizer is a lightweight HTTP server that streams OpenTelemetry spans during a run and exposes simple control endpoints to pause, resume, stop, and reset execution. It is designed for local development and CI debugging.

## Quick Start

- Start the CLI with the debug server:
  - `node dist/index.js --config <path/to/.visor.yaml> --mode cli --output json --debug-server --debug-port 3456`
  - The server starts at `http://localhost:3456`. In headless CI, set `VISOR_NOBROWSER=true` to skip auto‑open.
- Click “Start Execution” in the UI or POST `POST /api/start` (see below) to begin.

## Control Endpoints

- `GET /api/status` — returns readiness and execution state.
- `GET /api/spans` — returns the current in‑memory spans (live stream view).
- `GET /api/config` — returns the current configuration object.
- `POST /api/config` — accepts a JSON body with configuration YAML (placeholder; acknowledgement only for now).
- `GET /api/results` — returns final results when available.
- `POST /api/start` — transitions server to “running”; the CLI proceeds from its start gate.
- `POST /api/pause` — transitions to “paused”; the CLI’s internal gate blocks scheduling new work.
- `POST /api/resume` — transitions back to “running” and unblocks the pause gate.
- `POST /api/stop` — transitions to “stopped”; prevents scheduling any new work. In‑flight tasks may complete.
- `POST /api/reset` — clears spans and results; returns to “idle”.

### Status shape (`GET /api/status`)
```json
{
  "isRunning": true,
  "executionState": "idle|running|paused|stopped",
  "isPaused": false,
  "spanCount": 0,
  "timestamp": "2025-01-01T00:00:00.000Z"
}
```

### Spans shape (`GET /api/spans`)
```json
{
  "spans": [
    {
      "traceId": "…",
      "spanId": "…",
      "parentSpanId": "…",
      "name": "visor.check.alpha",
      "startTime": [sec, nsec],
      "endTime": [sec, nsec],
      "duration": 829.2,
      "attributes": { "visor.check.id": "alpha" },
      "events": [],
      "status": "ok|error"
    }
  ],
  "total": 1,
  "timestamp": "2025-01-01T00:00:00.000Z",
  "executionState": "running"
}
```

## Pause/Stop Semantics

The engine checks a “pause gate” at key scheduling points:
- Between dependency levels.
- Before starting each check.
- Before scheduling each `forEach` item.

Effects:
- Pause: defers scheduling new work until resumed. In‑flight work is not canceled.
- Stop: prevents any further scheduling. In‑flight work may finish; no new checks/items start after stop.
- Reset: clears spans/results and returns the server to `idle`.

## Environment Variables

- `VISOR_NOBROWSER=true` — do not open the browser (CI/headless).
- `VISOR_TELEMETRY_ENABLED=true` — turn on telemetry explicitly (file sink by default).
- `VISOR_TELEMETRY_SINK=file|console|otlp` — telemetry sink. File sink writes NDJSON traces.
- `VISOR_TRACE_DIR=<dir>` — directory for trace output (e.g., `output/traces`).
- `VISOR_FALLBACK_TRACE_FILE=<file>` — explicit NDJSON trace path (set automatically per run by the CLI).
- `VISOR_DEBUG_START_TIMEOUT_MS=<ms>` — optional start‑gate timeout; auto‑proceeds if UI never signals start.
- `VISOR_E2E_FORCE_RUN=true` — tests‑only: allow `dist/index.js` to run under Jest.

## CLI Examples

- Start server headless on port 40000 and begin automatically from script:
  - `VISOR_NOBROWSER=true node dist/index.js --config .visor.yaml --mode cli --output json --debug-server --debug-port 40000`
  - Then: `curl -sSf -X POST http://localhost:40000/api/start`.
- Pause/Resume/Stop from a terminal:
  - `curl -sSf -X POST http://localhost:40000/api/pause`
  - `curl -sSf -X POST http://localhost:40000/api/resume`
  - `curl -sSf -X POST http://localhost:40000/api/stop`
- Inspect spans/status:
  - `curl -sSf http://localhost:40000/api/status | jq`  
  - `curl -sSf http://localhost:40000/api/spans | jq '.total'`

## Spans & State Capture

When telemetry is enabled (default file sink), Visor writes NDJSON traces. Attributes include:
- `visor.check.input.context` — serialized input (PR, outputs, env).
- `visor.check.output` — serialized normalized output.
- `visor.transform.*` — transform_js code/inputs/outputs when applicable.
- `visor.foreach.*` — details for forEach iteration.

You can parse NDJSON via the built‑in trace reader (`src/debug-visualizer/trace-reader.ts`) or your own scripts.

## E2E Tests

- Live mode control test: `tests/e2e/visualizer-live-mode-e2e.test.ts` asserts `/api/status` transitions and spans endpoint behavior.
- NDJSON state capture test: `tests/e2e/state-capture-e2e.test.ts` runs command checks and verifies span attributes.
- No manual env setup required; `tests/setup.ts` applies safe defaults (e.g., `VISOR_NOBROWSER=true`). E2E tests set `VISOR_E2E_FORCE_RUN=true` per spawn.

## Troubleshooting

- Server started but CLI doesn’t proceed: send `POST /api/start` or set a start timeout with `VISOR_DEBUG_START_TIMEOUT_MS`.
- No spans in file: confirm `VISOR_TELEMETRY_ENABLED=true` and `VISOR_TELEMETRY_SINK=file`. Check `VISOR_TRACE_DIR` exists.
- Duplicate OpenTelemetry context warning: benign; initialization is guarded, but concurrent runs can still log a warning.
