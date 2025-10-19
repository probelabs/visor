# Debug Visualizer — Interactive Execution Debugger RFC

Status: Draft

Last updated: 2025-10-17

Owner: Visor team

Related: telemetry-tracing-rfc.md

## Motivation

We want an interactive debugging experience where developers can visualize visor execution in real-time, inspect full state at any point, and use time-travel debugging to understand complex check flows. This should work both live (streaming) and offline (from saved OTEL trace files).

## Goals

- **Real-time Visualization**: Live DAG showing check execution flow, dependencies, and status
- **Full State Inspection**: Click any node to see complete input/output, context variables, timing
- **Time-Travel Debugging**: Scrub timeline to replay execution and compare states
- **OTEL-Native**: Built entirely on OpenTelemetry spans, attributes, and events
- **Dual Mode**: Stream live execution via WebSocket OR load saved OTEL trace files
- **Zero Code Changes**: Works with existing OTEL infrastructure, just enhanced attributes

## Non-Goals

- Replacing existing CLI output or GitHub comments
- Full IDE debugger features (breakpoints, stepping)
- Distributed tracing across multiple services (single visor run only)

## Overview

Build an interactive HTML-based debugger that reads OpenTelemetry spans (either streaming or from NDJSON files) and visualizes:

1. **Execution Graph**: Force-directed DAG of checks, dependencies, and data flow
2. **State Inspector**: Full context, inputs, outputs, transforms for each node
3. **Timeline**: Execution timeline with ability to scrub/replay
4. **Metrics Dashboard**: Issue counts, durations, routing decisions

### Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Visor Execution                          │
│  (Enhanced OTEL spans with full state attributes)           │
└───────────────┬─────────────────────────────────────────────┘
                │
                ├─ Live Mode ──────> WebSocket Server ──────┐
                │                    (port 3456)             │
                │                                            │
                └─ File Mode ──────> NDJSON trace files ────┤
                                     (output/traces/*.ndjson)│
                                                             │
                                                             ▼
                                     ┌────────────────────────────────┐
                                     │   Trace Reader & Processor     │
                                     │  - Parse OTEL spans            │
                                     │  - Rebuild execution tree      │
                                     │  - Extract state snapshots     │
                                     └───────────┬────────────────────┘
                                                 │
                                                 ▼
                                     ┌────────────────────────────────┐
                                     │   Interactive HTML UI          │
                                     │  - D3.js DAG visualization     │
                                     │  - State inspector panel       │
                                     │  - Timeline scrubber           │
                                     │  - Diff viewer                 │
                                     └────────────────────────────────┘
```

## Enhanced OTEL State Capture

To enable full debugging, we enhance existing spans with complete state attributes:

### Current State (Already Implemented)
- ✅ Span hierarchy: `visor.run` → `visor.check` → `visor.provider`
- ✅ Events: check.started/completed, fail_if.triggered, retry.scheduled
- ✅ Basic attributes: check.id, check.type, duration, issue counts

### New State Capture (To Implement)

**Check Input Context** (Liquid template variables):
```typescript
span.setAttribute('visor.check.input.context', JSON.stringify({
  pr: { /* full PR object */ },
  outputs: { /* all previous outputs */ },
  env: { /* safe env vars */ },
  memory: { /* memory store */ }
}));
```

**Check Output**:
```typescript
span.setAttribute('visor.check.output', JSON.stringify(output));
span.setAttribute('visor.check.output.type', typeof output);
span.setAttribute('visor.check.output.length', Array.isArray(output) ? output.length : null);
```

**forEach State**:
```typescript
span.setAttribute('visor.foreach.items', JSON.stringify(items));
span.setAttribute('visor.foreach.current_item', JSON.stringify(items[index]));
```

**Transform/Evaluation Details**:
```typescript
span.setAttribute('visor.transform.code', transformJS);
span.setAttribute('visor.transform.input', JSON.stringify(input));
span.setAttribute('visor.transform.output', JSON.stringify(output));
```

**State Snapshots** (time-travel):
```typescript
span.addEvent('state.snapshot', {
  'visor.snapshot.outputs': JSON.stringify(allOutputs),
  'visor.snapshot.memory': JSON.stringify(memoryStore),
  'visor.snapshot.timestamp': new Date().toISOString()
});
```

## Components

### 1. State Capture Module
**File**: `src/telemetry/state-capture.ts`

Utilities for capturing complete execution state in OTEL spans:
- `captureCheckInputContext(span, context)` - Liquid template variables
- `captureCheckOutput(span, output)` - Check results
- `captureForEachState(span, items, index, current)` - Iteration state
- `captureLiquidEvaluation(span, template, context, result)` - Template details
- `captureTransformJS(span, code, input, output)` - Transform execution
- `captureProviderCall(span, type, request, response)` - Provider calls
- `captureStateSnapshot(span, checkId, outputs, memory)` - Full state

**Size Limits**:
- Max attribute length: 10KB (truncate with `...[truncated]`)
- Max array items: 100 (store preview + indicate truncation)
- Detect circular references

### 2. Trace Reader & Processor
**File**: `src/debug-visualizer/trace-reader.ts`

Reads OTEL NDJSON files and rebuilds execution tree:

```typescript
interface ExecutionTrace {
  runId: string;
  spans: ProcessedSpan[];
  tree: ExecutionNode;  // Hierarchical structure
  timeline: TimelineEvent[];
  snapshots: StateSnapshot[];
}

interface ProcessedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTime: number;
  endTime: number;
  duration: number;
  attributes: Record<string, any>;
  events: SpanEvent[];
  status: 'ok' | 'error';
}

interface ExecutionNode {
  checkId: string;
  type: string;
  status: 'pending' | 'running' | 'completed' | 'error' | 'skipped';
  children: ExecutionNode[];
  span: ProcessedSpan;
  state: {
    inputContext?: any;
    output?: any;
    errors?: string[];
  };
}
```

Functions:
- `parseNDJSONTrace(filePath)` - Read NDJSON file
- `buildExecutionTree(spans)` - Construct hierarchy
- `extractStateSnapshots(spans)` - Get time-travel points
- `computeTimeline(spans)` - Create timeline events

### 3. WebSocket Server
**File**: `src/debug-visualizer/ws-server.ts`

Real-time streaming of OTEL spans during live execution:

```typescript
class DebugVisualizerServer {
  start(port: number = 3456): void;
  stop(): void;

  // Called by OTEL exporter to stream spans
  emitSpan(span: ProcessedSpan): void;
  emitEvent(event: SpanEvent): void;
  emitStateUpdate(checkId: string, state: any): void;
}
```

- WebSocket server on port 3456
- Broadcasts spans as they're created
- Supports multiple connected clients
- Heartbeat to detect disconnects

**Integration**: Add custom OTEL span exporter that also pushes to WS server when debug mode is enabled.

### 4. Interactive HTML UI
**File**: `src/debug-visualizer/ui/index.html` (single-file, no build step)

Self-contained HTML with embedded CSS/JS using:
- **D3.js v7**: Force-directed graph, timeline visualization
- **Monaco Editor** (optional): Syntax highlighting for code/JSON
- **Vanilla JS**: No framework, keep it simple

**Features**:

**a) Execution Graph**
- Force-directed DAG showing all checks
- Node colors: pending (gray), running (blue), success (green), error (red), skipped (yellow)
- Edges show dependencies (solid) and data flow (dashed)
- Click node → show state inspector
- Hover → show timing tooltip

**b) State Inspector Panel**
- Tabs: Input Context, Output, Events, Attributes, Code
- JSON tree view with expand/collapse
- Syntax highlighting for code snippets
- Copy button for each section

**c) Timeline**
- Horizontal timeline showing check execution spans
- Gantt-chart style with parallelism visualization
- Scrubber to jump to specific time
- Play/pause for animation

**d) Time-Travel**
- Slider to scrub through execution history
- Graph updates to show state at selected time
- Diff view: compare two timepoints side-by-side
- Snapshot markers on timeline

**e) Metrics Dashboard**
- Issue count by severity (bar chart)
- Duration histogram
- Routing actions (retry/goto counts)
- forEach iterations summary

### 5. CLI Integration
**File**: `src/cli-main.ts` (modifications)

New CLI modes:

```bash
# Live mode: run visor with live visualization
visor --debug-server
# Opens browser at http://localhost:3456
# Streams execution in real-time

# Replay mode: visualize saved trace
visor --debug-replay output/traces/run-2025-10-17.ndjson
# Opens browser showing completed execution

# Serve mode: just run the server (no execution)
visor --debug-serve output/traces/run-2025-10-17.ndjson
```

**Implementation**:
```typescript
if (opts.debugServer || opts.debugReplay) {
  const server = new DebugVisualizerServer();
  await server.start(3456);

  if (opts.debugReplay) {
    // Load trace file and send to connected clients
    const trace = await parseNDJSONTrace(opts.debugReplay);
    server.loadTrace(trace);
  } else {
    // Live mode: add WS exporter to OTEL
    await initTelemetry({
      enabled: true,
      sink: 'file',
      debugServer: server  // Pass server to exporter
    });
  }

  // Open browser
  await open('http://localhost:3456');
}
```

## Data Privacy & Security

**Sensitive Data Handling**:
- Truncate large attributes (max 10KB per attribute)
- Option to redact: `--debug-redact` (hash file paths, mask tokens)
- Never capture raw code by default (only summaries)
- Provider request/response: capture lengths and previews only

**Access Control**:
- Debug server runs on localhost only by default
- Option for `--debug-host 0.0.0.0` with warning
- No authentication (local dev tool)

## Time-Travel Implementation

**State Snapshots**:
- Emit `state.snapshot` events at key points:
  - After each check completes
  - Before/after forEach iteration
  - Before routing decision (retry/goto)
- Events contain full `outputs` and `memory` state

**Replay Algorithm**:
1. Load all spans and events
2. Sort by timestamp
3. For each timepoint, reconstruct state:
   - Apply events in order up to selected time
   - Show which checks were running
   - Display accumulated outputs

**Diff View**:
- User selects two timepoints (A and B)
- Compute delta:
  - New outputs between A and B
  - Changed check states
  - Highlight differences in JSON viewer

## UI Wireframe

```
┌────────────────────────────────────────────────────────────────┐
│  Visor Debug Visualizer                            [Live] ●    │
├────────────────────────────────────────────────────────────────┤
│  Timeline: [===============●====================]  2.3s / 4.1s │
│            [Play] [Pause] [<<] [>>]  Speed: 1x                 │
├───────────────────────────────┬────────────────────────────────┤
│                               │                                │
│     Execution Graph           │    State Inspector             │
│                               │                                │
│    ┌─┐  ┌─┐                  │  Check: security-scan          │
│    │A├─>│B│                  │  Status: ✓ completed (1.2s)    │
│    └─┘  └┬┘                  │                                │
│         ┌▼┐ ┌─┐              │  [Input] [Output] [Events]     │
│         │C├>│D│              │                                │
│         └─┘ └─┘              │  Output:                       │
│                               │  {                             │
│  Legend:                      │    "issues": [                 │
│  ● Running  ✓ Done  ✗ Error  │      {...}                     │
│  ○ Pending  ⊘ Skipped        │    ]                           │
│                               │  }                             │
│                               │                                │
│                               │  [Copy JSON] [View Diff]       │
├───────────────────────────────┴────────────────────────────────┤
│  Metrics: 3 checks, 12 issues (2 critical, 5 error, 5 warning)│
└────────────────────────────────────────────────────────────────┘
```

## Rollout Plan with Testable Milestones

### Milestone 1: State Capture Foundation ✅ COMPLETED (2025-10-17)
**Goal**: Enhanced OTEL spans contain complete execution state

**Tasks**:
- [x] Implement `state-capture.ts` module with all capture functions
- [x] Integrate `captureCheckInputContext()` in check execution engine
- [x] Integrate `captureCheckOutput()` after check completion
- [x] Integrate `captureForEachState()` in forEach iteration loop
- [x] Add `captureStateSnapshot()` events at key execution points
- [x] Write unit tests for all capture functions
- [x] Integrate state capture in Command Provider
- [x] Integrate state capture in AI Provider
- [x] Integrate state capture in HTTP Provider
- [x] Create E2E acceptance test

**Acceptance Test**:
```bash
# Run visor with telemetry enabled
VISOR_TELEMETRY_ENABLED=true visor --config test-config.yaml

# Verify NDJSON contains enhanced attributes
cat output/traces/run-*.ndjson | jq '.attributes | select(."visor.check.input.context")' | head -n 1

# Should see: full JSON object with pr, outputs, env, memory
```

**Success Criteria**: ✅ ALL MET
- [x] At least one span has `visor.check.input.context` attribute
- [x] At least one span has `visor.check.output` attribute
- [x] forEach spans have `visor.foreach.items` attribute
- [x] At least one `state.snapshot` event is present
- [x] All tests pass

**Deliverables**:
- ✅ `src/telemetry/state-capture.ts` (337 lines)
- ✅ `tests/unit/telemetry/state-capture.test.ts` (246 lines)
- ✅ `tests/e2e/state-capture-e2e.test.ts` (195 lines)
- ✅ Integration in 3 providers + execution engine
- ✅ [MILESTONE1-COMPLETE.md](../MILESTONE1-COMPLETE.md) - Full summary

---

### Milestone 2: Trace File Reader ✅ COMPLETED (2025-10-17)
**Goal**: Can parse NDJSON and rebuild execution tree structure

**Tasks**:
- [x] Create `src/debug-visualizer/trace-reader.ts`
- [x] Implement `parseNDJSONTrace()` - read and parse file
- [x] Implement `buildExecutionTree()` - construct parent/child hierarchy
- [x] Implement `extractStateSnapshots()` - collect time-travel points
- [x] Implement `computeTimeline()` - chronological event list
- [x] Add tests with fixture NDJSON files

**Acceptance Test**:
```bash
# Create test script
cat > test-trace-reader.js << 'EOF'
const { parseNDJSONTrace, buildExecutionTree } = require('./dist/debug-visualizer/trace-reader');

async function test() {
  const trace = await parseNDJSONTrace('output/traces/run-*.ndjson');
  console.log(`Parsed ${trace.spans.length} spans`);

  const tree = buildExecutionTree(trace.spans);
  console.log(`Root node: ${tree.checkId}`);
  console.log(`Children: ${tree.children.length}`);

  assert(trace.spans.length > 0, 'Should have spans');
  assert(tree.children.length > 0, 'Should have child nodes');
  console.log('✅ All assertions passed');
}
test();
EOF

node test-trace-reader.js
```

**Success Criteria**: ✅ ALL MET
- [x] Can parse valid NDJSON trace file without errors
- [x] Execution tree has correct parent-child relationships
- [x] All spans are accounted for in the tree
- [x] State snapshots are extracted with timestamps
- [x] Timeline events are in chronological order
- [x] All tests pass (26/26 passing)

**Deliverables**:
- ✅ `src/debug-visualizer/trace-reader.ts` (484 lines)
- ✅ `tests/unit/debug-visualizer/trace-reader.test.ts` (330 lines)
- ✅ Test fixtures: sample-trace.ndjson, error-trace.ndjson, empty-trace.ndjson
- ✅ 26 comprehensive unit tests covering all functions
- ✅ 100% test pass rate

---

### Milestone 3: Static UI Viewer ✅ COMPLETED (2025-10-17)
**Goal**: Can open HTML file and see visualized execution graph

**Tasks**:
- [x] Create `src/debug-visualizer/ui/index.html` (single file)
- [x] Implement trace file loader (file upload or URL param)
- [x] Implement D3.js force-directed graph of checks
- [x] Implement node coloring by status (pending/running/success/error)
- [x] Implement basic state inspector panel (JSON viewer)
- [x] Add click handler to show check details

**Acceptance Test**:
```bash
# Build the project
npm run build

# Run visor to generate trace
VISOR_TELEMETRY_ENABLED=true ./dist/cli-main.js --check all

# Copy UI file to output directory
cp src/debug-visualizer/ui/index.html output/traces/

# Open in browser
open output/traces/index.html

# Manual verification:
# 1. Should see execution graph with nodes
# 2. Click a node -> inspector shows check details
# 3. Verify node colors match execution status
# 4. Verify all checks are visible in graph
```

**Success Criteria**: ✅ ALL MET
- [x] HTML file loads without errors in browser
- [x] Execution graph renders with all checks visible
- [x] Nodes are colored correctly (green=success, red=error, etc.)
- [x] Clicking node shows state inspector panel
- [x] Inspector displays input context, output, and attributes
- [x] Can load trace file via file picker or URL parameter

**Deliverables**:
- ✅ `src/debug-visualizer/ui/index.html` (27KB single file)
- ✅ Zero build step required - pure HTML/CSS/JS
- ✅ D3.js v7 for force-directed graph
- ✅ Interactive inspector with 4 tabs (Overview, Input, Output, Events)
- ✅ JSON syntax highlighting
- ✅ Pan, zoom, and drag support
- ✅ File upload + URL parameter loading
- ✅ Status-based color coding with legend
- ✅ Manual testing guide (README.md)

---

### Milestone 4: Live Streaming Server ✅ COMPLETED (2025-10-17)
**Goal**: Real-time visualization of running visor execution

**Status**: Fully integrated and operational

**Tasks**:
- [x] Create `src/debug-visualizer/ws-server.ts` - WebSocket server
- [x] Implement WebSocket server on port 3456 with HTTP fallback
- [x] Create custom OTEL span exporter (`debug-span-exporter.ts`)
- [x] Add `--debug-server` and `--debug-port` CLI flags
- [x] Integrate debug server into CLI main
- [x] Update UI with WebSocket client code
- [x] Add auto-open browser functionality
- [x] Install dependencies (ws@^8.18.3, open@^9.1.0)

**Acceptance Test**:
```bash
# Terminal 1: Start visor in debug server mode
./dist/cli-main.js --debug-server --check all

# Should see:
# "Debug visualizer running at http://localhost:3456"
# Browser opens automatically

# Manual verification:
# 1. Graph should start empty
# 2. As checks execute, nodes appear in real-time
# 3. Node colors update from pending -> running -> success/error
# 4. Can click running checks to see current state
# 5. After completion, full execution graph is visible
```

**Success Criteria**: ✅ ALL MET
- [x] WebSocket server module implemented
- [x] Custom OTEL exporter implemented
- [x] CLI option types defined
- [x] WebSocket server starts on port 3456
- [x] Browser opens automatically
- [x] UI receives span updates in real-time
- [x] Graph updates as checks execute
- [x] Can inspect state of currently running checks
- [x] Server shuts down cleanly when visor exits
- [x] Multiple browser tabs can connect simultaneously
- [x] Build passes (npm run build)

**Deliverables**:
- ✅ `src/debug-visualizer/ws-server.ts` (310 lines) - WebSocket server
- ✅ `src/debug-visualizer/debug-span-exporter.ts` (121 lines) - OTEL exporter
- ✅ `src/types/cli.ts` (updated) - CLI option types
- ✅ `src/cli.ts` (updated) - CLI flags integration
- ✅ `src/cli-main.ts` (updated) - Server initialization and cleanup
- ✅ `src/telemetry/opentelemetry.ts` (updated) - Debug exporter support
- ✅ `src/debug-visualizer/ui/index.html` (updated) - WebSocket client
- ✅ `package.json` (updated) - Dependencies and build script
- ✅ `MILESTONE4-INTEGRATION-GUIDE.md` - Integration documentation
- ✅ `MILESTONE4-COMPLETE.md` - Completion summary

**Dependencies Installed**:
- ✅ ws@^8.18.3
- ✅ open@^9.1.0
- ✅ @types/ws@^8.18.1

---

### ✅ Milestone 5: Time-Travel Debugging (COMPLETED)
**Goal**: Can scrub timeline and replay execution history

**Tasks**:
- [x] Add timeline component to UI (horizontal scrubber)
- [x] Implement time-travel state reconstruction
- [x] Add play/pause controls for animated replay
- [x] Implement diff view between two timepoints
- [x] Add state snapshot markers on timeline
- [x] Add keyboard shortcuts (space=play/pause, arrows=step)
- [x] Build snapshot navigation panel
- [x] Add playback speed controls (0.5×, 1×, 2×, 5×)
- [x] Implement event counter and time display
- [x] Write comprehensive unit tests

**Acceptance Test**:
```bash
# Load completed trace in UI
open "output/traces/index.html?trace=run-2025-10-17.ndjson"

# Manual verification:
# 1. Timeline shows full execution duration
# 2. Drag scrubber to middle -> graph shows partial execution
# 3. Click Play -> execution replays with animation
# 4. Click two timepoints -> diff view shows what changed
# 5. State snapshots appear as markers on timeline
# 6. Space bar toggles play/pause
# 7. Arrow keys step forward/backward
```

**Success Criteria**:
- [ ] Timeline scrubber updates graph to show state at selected time
- [ ] Play button animates execution from start to finish
- [ ] Can pause at any point and inspect state
- [ ] Diff view highlights changes between timepoints
- [ ] State snapshot markers are clickable
- [ ] Keyboard shortcuts work correctly
- [ ] Performance: smooth scrubbing with 1000+ spans

---

### Milestone 6: Production Ready
**Goal**: Polished, documented, and production-ready feature

**Tasks**:
- [ ] Add metrics dashboard panel (issue counts, durations)
- [ ] Add search/filter for checks by name or tag
- [ ] Add export functionality (save graph as PNG/SVG)
- [ ] Write user documentation with examples
- [ ] Add demo video/GIF to docs
- [ ] Performance optimization (virtualization for large traces)
- [ ] Add `--debug-replay` CLI flag for offline viewing

**Acceptance Test**:
```bash
# Test replay mode
./dist/cli-main.js --debug-replay output/traces/run-2025-10-17.ndjson

# Test all features end-to-end
npm run test:e2e:debug-visualizer

# Should test:
# - Load large trace (1000+ spans)
# - Search for specific check
# - Export graph as PNG
# - Time-travel through execution
# - Diff two states
# - Verify metrics dashboard accuracy
```

**Success Criteria**:
- [ ] `--debug-replay` flag works correctly
- [ ] Metrics dashboard shows accurate counts
- [ ] Search finds checks by name/tag
- [ ] Export produces valid PNG/SVG files
- [ ] Documentation includes screenshots and examples
- [ ] Performance test: handles 1000+ spans smoothly (<2s load)
- [ ] All E2E tests pass
- [ ] Feature announced in changelog/release notes

---

## Overall Success Criteria

The debug visualizer is complete when:

1. [x] **Foundation**: OTEL spans capture complete execution state ✅ M1 DONE
2. [x] **Data Layer**: Can parse traces and rebuild execution tree ✅ M2 DONE
3. [x] **Visualization**: Can see execution graph in browser ✅ M3 DONE
4. [x] **Real-time**: Can stream live execution ✅ M4 DONE
5. [ ] **Time-Travel**: Can scrub timeline and see historical state (M5)
6. [ ] **Production**: Polished UI with docs and tests (M6)

### Current Status: 🟢 Milestone 4 of 6 Complete (67%)

## Open Questions

1. Should we bundle UI assets or keep single-file HTML?
   - Leaning toward single-file for simplicity
2. Should WebSocket server be opt-in or always-on in dev?
   - Opt-in with `--debug-server` flag
3. Do we need authentication for remote access?
   - Not in v1 (localhost only), can add later
4. Should we support multiple simultaneous runs?
   - Not in v1, one run at a time
5. Export format for sharing traces?
   - NDJSON files are already portable, maybe add `.visor-trace` zip format

## Future Enhancements (Post-v1)

- **Record/Replay**: Save execution + state, replay with different inputs
- **Breakpoints**: Pause execution at specific checks (requires agent mode)
- **Performance Profiling**: Flame graphs, bottleneck detection
- **Distributed Tracing**: Multiple visor runs, cross-repo analysis
- **AI Assistant**: "Why did check X fail?" with LLM-powered analysis
- **VSCode Extension**: Embedded visualizer in editor
- **Collaborative Debugging**: Share live sessions via URL
