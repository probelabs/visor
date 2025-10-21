# Milestone 4: Live Streaming Server - Integration Guide

**Status**: 🟡 IN PROGRESS (Core modules complete, integration pending)
**Date**: 2025-10-17

## Summary

Milestone 4 provides real-time visualization of visor execution through WebSocket streaming. The core modules have been implemented and are ready for integration into the main codebase.

## Completed Components

### ✅ 1. WebSocket Server (`src/debug-visualizer/ws-server.ts`)

**Functionality**:
- HTTP server serves UI on http://localhost:3456
- WebSocket server handles client connections
- Broadcasts spans to all connected clients in real-time
- Supports multiple simultaneous connections
- Graceful start/stop with client cleanup
- Auto-injects WebSocket URL into served HTML

**API**:
```typescript
const server = new DebugVisualizerServer();
await server.start(3456);

// Emit spans during execution
server.emitSpan(processedSpan);
server.emitEvent(event);
server.emitStateUpdate(checkId, state);

// Cleanup
await server.stop();
```

### ✅ 2. Debug Span Exporter (`src/debug-visualizer/debug-span-exporter.ts`)

**Functionality**:
- Custom OTEL SpanExporter implementation
- Converts ReadableSpan to ProcessedSpan format
- Streams spans to WebSocket server in real-time
- Compatible with OTEL SDK

**API**:
```typescript
const exporter = new DebugSpanExporter(server);

// Add to OTEL provider
const provider = new NodeTracerProvider();
provider.addSpanProcessor(new SimpleSpanProcessor(exporter));
```

### ✅ 3. CLI Option Types (`src/types/cli.ts`)

**Added**:
```typescript
interface CliOptions {
  debugServer?: boolean;   // Enable debug visualizer server
  debugPort?: number;       // Port for server (default: 3456)
}
```

## Integration Steps

### Step 1: Add CLI Options

**File**: `src/cli.ts`

Add these options in both `setupProgram()` and `parseArgs()`:

```typescript
.option('--debug-server', 'Start debug visualizer server for live execution visualization')
.option('--debug-port <port>', 'Port for debug server (default: 3456)', value => parseInt(value, 10))
```

In the return statement of `parseArgs()`:

```typescript
return {
  // ... existing options
  debugServer: options.debugServer || false,
  debugPort: options.debugPort,
};
```

### Step 2: Initialize Debug Server in CLI Main

**File**: `src/cli-main.ts`

Add imports at top:

```typescript
import { DebugVisualizerServer } from './debug-visualizer/ws-server';
import { DebugSpanExporter } from './debug-visualizer/debug-span-exporter';
import { SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import * as open from 'open'; // npm install open
```

In the `main()` function, after options are parsed:

```typescript
let debugServer: DebugVisualizerServer | null = null;

// Start debug server if requested
if (options.debugServer) {
  const port = options.debugPort || 3456;

  console.log(`🔍 Starting debug visualizer on port ${port}...`);

  debugServer = new DebugVisualizerServer();
  await debugServer.start(port);

  console.log(`✅ Debug visualizer running at http://localhost:${port}`);
  console.log(`   Opening browser...`);

  // Open browser
  await open(`http://localhost:${port}`);
}
```

### Step 3: Add Debug Exporter to Telemetry

**File**: `src/telemetry/opentelemetry.ts`

Modify `initTelemetry()` to accept optional debug server:

```typescript
export async function initTelemetry(options?: {
  enabled?: boolean;
  sink?: 'file' | 'console' | 'none';
  debugServer?: DebugVisualizerServer; // NEW
}): Promise<void> {
  // ... existing setup

  if (options?.debugServer) {
    // Add debug span exporter for live streaming
    const debugExporter = new DebugSpanExporter(options.debugServer);
    provider.addSpanProcessor(new SimpleSpanProcessor(debugExporter));
  }

  // ... rest of setup
}
```

Update the call in `cli-main.ts`:

```typescript
// Initialize telemetry
await initTelemetry({
  enabled: true,
  sink: 'file', // or based on options
  debugServer: debugServer || undefined,
});
```

### Step 4: Cleanup on Exit

In `cli-main.ts`, ensure cleanup happens:

```typescript
try {
  // ... run checks

} finally {
  // Shutdown debug server
  if (debugServer) {
    console.log('🔍 Shutting down debug server...');
    await debugServer.stop();
  }

  // Shutdown telemetry
  await shutdownTelemetry();
}
```

### Step 5: Update UI for Live Mode

**File**: `src/debug-visualizer/ui/index.html`

The UI already has WebSocket support scaffolded. Add this JavaScript at the end of the `<script>` tag:

```javascript
// WebSocket connection for live mode
let ws = null;
let liveMode = false;

// Check if WebSocket URL is injected (live mode)
if (typeof window.DEBUG_WS_URL !== 'undefined') {
  liveMode = true;
  connectWebSocket(window.DEBUG_WS_URL);
}

function connectWebSocket(url) {
  console.log('[live] Connecting to debug server:', url);
  ws = new WebSocket(url);

  ws.onopen = () => {
    console.log('[live] Connected to debug server');
    document.getElementById('file-info').textContent = 'Live Mode - Connected';
    hideEmptyState();
  };

  ws.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      handleLiveMessage(message);
    } catch (e) {
      console.error('[live] Failed to parse message:', e);
    }
  };

  ws.onerror = (error) => {
    console.error('[live] WebSocket error:', error);
  };

  ws.onclose = () => {
    console.log('[live] Disconnected from debug server');
    document.getElementById('file-info').textContent = 'Live Mode - Disconnected';
  };
}

function handleLiveMessage(message) {
  console.log('[live] Received:', message.type, message);

  switch (message.type) {
    case 'span':
      handleLiveSpan(message.data);
      break;
    case 'event':
      console.log('[live] Event:', message.data);
      break;
    case 'state_update':
      handleStateUpdate(message.data);
      break;
    case 'complete':
      console.log('[live] Execution complete');
      document.getElementById('file-info').textContent += ' (Complete)';
      break;
  }
}

function handleLiveSpan(span) {
  // Add span to current trace
  if (!currentTrace) {
    currentTrace = {
      runId: 'live',
      traceId: span.traceId,
      spans: [],
      tree: null,
      timeline: [],
      snapshots: [],
      metadata: {
        startTime: new Date().toISOString(),
        endTime: new Date().toISOString(),
        duration: 0,
        totalSpans: 0,
        totalSnapshots: 0
      }
    };
  }

  currentTrace.spans.push(span);

  // Rebuild tree incrementally
  currentTrace.tree = buildExecutionTree(currentTrace.spans);

  // Re-visualize with updated data
  visualizeTrace(currentTrace);

  // Update metadata
  currentTrace.metadata.totalSpans = currentTrace.spans.length;
  currentTrace.metadata.endTime = new Date().toISOString();
}

function handleStateUpdate(data) {
  // Update node state in real-time
  console.log('[live] State update for', data.checkId, data.state);
  // Could update inspector if currently viewing this node
}
```

## Testing

### Manual Test

```bash
# Terminal 1: Start visor with debug server
npm run build
./dist/cli-main.js --debug-server --check all

# Should see:
# 🔍 Starting debug visualizer on port 3456...
# ✅ Debug visualizer running at http://localhost:3456
#    Opening browser...
# [debug-server] Debug Visualizer running at http://localhost:3456

# Browser should open automatically
# As checks execute, nodes should appear in real-time
# Click nodes to see current state
```

### Integration Test

Create `tests/integration/debug-server.test.ts`:

```typescript
import { DebugVisualizerServer } from '../../src/debug-visualizer/ws-server';
import { DebugSpanExporter } from '../../src/debug-visualizer/debug-span-exporter';
import WebSocket from 'ws';

describe('Debug Visualizer Live Streaming', () => {
  let server: DebugVisualizerServer;

  beforeEach(async () => {
    server = new DebugVisualizerServer();
    await server.start(3457); // Use different port for tests
  });

  afterEach(async () => {
    await server.stop();
  });

  it('should broadcast spans to connected clients', async () => {
    const client = new WebSocket('ws://localhost:3457');
    const messages: any[] = [];

    client.on('message', (data) => {
      messages.push(JSON.parse(data.toString()));
    });

    await new Promise(resolve => client.on('open', resolve));

    // Emit a test span
    server.emitSpan({
      traceId: 'test-trace',
      spanId: 'test-span',
      name: 'test',
      startTime: [Date.now() / 1000, 0],
      endTime: [Date.now() / 1000 + 1, 0],
      duration: 1000,
      attributes: {},
      events: [],
      status: 'ok'
    });

    // Wait for message
    await new Promise(resolve => setTimeout(resolve, 100));

    expect(messages.length).toBeGreaterThan(0);
    expect(messages.some(m => m.type === 'span')).toBe(true);

    client.close();
  });
});
```

## Dependencies

Add to `package.json`:

```json
{
  "dependencies": {
    "ws": "^8.14.2",
    "open": "^9.1.0"
  },
  "devDependencies": {
    "@types/ws": "^8.5.8"
  }
}
```

Run:
```bash
npm install ws open
npm install --save-dev @types/ws
```

## Usage Examples

### Basic Usage

```bash
# Run visor with live debug visualization
visor --debug-server

# Use custom port
visor --debug-server --debug-port 4000

# Combine with other options
visor --debug-server --check security --config .visor.yaml
```

### Expected Behavior

1. Server starts on specified port (default: 3456)
2. Browser opens automatically to http://localhost:3456
3. UI shows "Live Mode - Connected"
4. As visor executes:
   - Nodes appear in graph as checks start
   - Node colors update: gray → blue → green/red
   - Click any node to inspect current state
5. When execution completes:
   - All nodes visible
   - Final state available
   - Server stays running until Ctrl+C

## Acceptance Criteria

- [ ] `--debug-server` flag starts WebSocket server
- [ ] Browser opens automatically
- [ ] UI receives span updates in real-time
- [ ] Graph updates as checks execute
- [ ] Can inspect state of currently running checks
- [ ] Server shuts down cleanly when visor exits
- [ ] Multiple browser tabs can connect simultaneously

## Next Steps

1. Install dependencies (`ws`, `open`)
2. Apply integration steps 1-5
3. Test with sample visor run
4. Validate all acceptance criteria
5. Update M4 documentation to "COMPLETE"
6. Move to Milestone 5 (Time-Travel Debugging)

## Notes

- WebSocket server is HTTP-based, serving both UI and WebSocket endpoint
- UI auto-detects live mode via injected `window.DEBUG_WS_URL`
- Spans are broadcast immediately as they complete
- No buffering - real-time streaming
- Server cleanup is automatic on process exit

## Files Created

- ✅ `src/debug-visualizer/ws-server.ts` (280 lines)
- ✅ `src/debug-visualizer/debug-span-exporter.ts` (130 lines)
- ✅ `src/types/cli.ts` (updated with debugServer options)
- ✅ `MILESTONE4-INTEGRATION-GUIDE.md` (this file)

## Files to Modify

- 📝 `src/cli.ts` - Add CLI options
- 📝 `src/cli-main.ts` - Initialize server, handle cleanup
- 📝 `src/telemetry/opentelemetry.ts` - Add debug exporter
- 📝 `src/debug-visualizer/ui/index.html` - Add WebSocket handling
- 📝 `package.json` - Add dependencies

---

**Status**: Core implementation complete, integration pending
**Estimated Integration Time**: 30-45 minutes
**Risk**: Low (non-breaking changes, opt-in feature)
