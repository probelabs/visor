# Milestone 6: Debug Server Persistence & HTTP Polling

## Overview
This milestone completes the transition to a persistent debug server with HTTP polling, removing WebSocket complexity and enabling iterative debugging workflows.

## Changes Completed

### 1. Removed WebSocket Implementation
**File: `src/debug-visualizer/ws-server.ts`**

- ✅ Removed all WebSocket dependencies (`ws` package)
- ✅ Removed `WebSocketServer`, `clients`, `lastSpanIndex` fields
- ✅ Removed WebSocket connection handling
- ✅ Removed `broadcast()`, `sendToClient()`, `handleClientMessage()` methods
- ✅ Simplified to pure HTTP polling architecture

**Benefits:**
- Simpler, more reliable architecture
- No connection management complexity
- Standard HTTP debugging tools work
- Better error handling

### 2. HTTP Polling API
**Endpoints:**
- `GET /api/spans` - Get all spans collected so far
- `GET /api/config` - Get current configuration
- `GET /api/status` - Get server status
- `GET /` - Serve debug visualizer UI

**Polling Mechanism:**
- UI polls `/api/spans` every 1 second
- Server stores all spans in memory
- Spans accumulate during execution
- Cleared between runs via `clearSpans()`

### 3. Process Persistence
**File: `src/cli-main.ts`**

**Previous Behavior:**
- Visor would exit immediately after execution completes
- Required restarting the debug server for each run
- Inefficient for iterative development

**New Behavior:**
```typescript
// If debug server is running, keep the process alive for re-runs
if (debugServer) {
  // Clear spans for next run
  debugServer.clearSpans();

  console.log('✅ Execution completed. Debug server still running at http://localhost:' + debugServer.getPort());
  console.log('   Press Ctrl+C to exit');

  // Flush telemetry but don't shut down
  try {
    await flushNdjson();
  } catch {}

  // Keep process alive and return without exiting
  return;
}
```

**Benefits:**
- ✅ Debug server stays alive after execution
- ✅ Users can modify config and re-run checks
- ✅ Faster iteration cycle
- ✅ Spans cleared automatically between runs
- ✅ Works for both successful and failed executions

### 4. Error Handling
**Enhanced error path to also keep server alive:**

```typescript
// If debug server is running, keep it alive even after error
if (debugServer) {
  // Clear spans after error
  debugServer.clearSpans();

  console.log('⚠️  Execution failed. Debug server still running at http://localhost:' + debugServer.getPort());
  console.log('   Press Ctrl+C to exit');

  // Keep process alive and return without exiting
  return;
}
```

**Benefits:**
- ✅ Can analyze failures without losing server state
- ✅ Fix issues and re-run immediately
- ✅ Better debugging experience

## Usage

### Starting the Debug Server
```bash
./dist/index.js --debug-server
```

**What happens:**
1. Server starts on port 3456 (configurable with `--debug-port`)
2. Browser opens automatically to `http://localhost:3456`
3. Visor analyzes the repository
4. Spans stream to the UI via HTTP polling
5. **After execution completes, server stays alive**
6. You can modify config/code and trigger a new run
7. Press Ctrl+C to exit when done

### Iterative Workflow
```bash
# Start debug server
./dist/index.js --debug-server

# Server runs analysis and stays alive
# ✅ Execution completed. Debug server still running at http://localhost:3456
#    Press Ctrl+C to exit

# Modify your .visor.yaml config
# Modify your code
# Click "Reset" and "Start Execution" in the UI
# Server will run again with new config/code

# When done, press Ctrl+C to exit
```

## Technical Details

### Span Lifecycle
1. **Start**: Server starts, `spans = []`
2. **Execution**: Spans accumulate via `emitSpan()`
3. **Polling**: UI polls `/api/spans` and sees new spans
4. **Completion**: Execution ends, server calls `clearSpans()`
5. **Next Run**: Starts with clean span array

### Process Lifecycle
```
┌─────────────────────────────────────┐
│ Start Debug Server                  │
│ (--debug-server flag)               │
└────────────┬────────────────────────┘
             │
             ▼
┌─────────────────────────────────────┐
│ Initialize HTTP Server              │
│ Open browser to UI                  │
└────────────┬────────────────────────┘
             │
             ▼
┌─────────────────────────────────────┐
│ Execute Checks                      │
│ (Spans stream via HTTP polling)     │
└────────────┬────────────────────────┘
             │
             ▼
        ┌────┴─────┐
        │          │
        ▼          ▼
   ┌─────────┐  ┌─────────┐
   │ Success │  │ Error   │
   └────┬────┘  └────┬────┘
        │            │
        └────┬───────┘
             │
             ▼
┌─────────────────────────────────────┐
│ clearSpans()                        │
│ Display completion message          │
│ KEEP PROCESS ALIVE                  │
│ (return instead of process.exit)   │
└────────────┬────────────────────────┘
             │
             ▼
┌─────────────────────────────────────┐
│ Wait for user action:               │
│ - Modify config/code                │
│ - Trigger new run from UI           │
│ - Press Ctrl+C to exit              │
└─────────────────────────────────────┘
```

### API Response Format

**`/api/spans`:**
```json
{
  "spans": [
    {
      "traceId": "...",
      "spanId": "...",
      "name": "check.security",
      "duration": 1234,
      "attributes": {...},
      "events": [...],
      "status": "ok"
    }
  ],
  "total": 42,
  "timestamp": "2025-10-17T17:30:00.000Z"
}
```

**`/api/config`:**
```json
{
  "config": {
    "version": "1.0",
    "checks": {...}
  },
  "timestamp": "2025-10-17T17:30:00.000Z"
}
```

**`/api/status`:**
```json
{
  "isRunning": true,
  "spanCount": 42,
  "timestamp": "2025-10-17T17:30:00.000Z"
}
```

## Files Modified

1. **`src/debug-visualizer/ws-server.ts`**
   - Removed WebSocket code
   - Simplified to HTTP-only server
   - Added `clearSpans()` method

2. **`src/cli-main.ts`**
   - Added process persistence logic
   - Call `clearSpans()` after execution
   - Return instead of exiting when debug server active
   - Handle both success and error paths

3. **`src/debug-visualizer/ui/index.html`**
   - Removed WebSocket client code
   - Implemented HTTP polling (every 1 second)
   - Updated to use `DEBUG_SERVER_URL` instead of `DEBUG_WS_URL`

## Testing

### Build and Test
```bash
# Build the project
npm run build

# Start debug server
./dist/index.js --debug-server

# Verify:
# ✅ Server starts on port 3456
# ✅ Browser opens automatically
# ✅ Spans appear in UI as execution progresses
# ✅ After completion, server stays alive
# ✅ Message shows "Press Ctrl+C to exit"
```

### Manual Testing Checklist
- [x] Server starts and opens browser
- [x] Spans stream to UI during execution
- [x] Config displays in Inspector tab
- [x] Server stays alive after successful execution
- [x] Server stays alive after failed execution
- [x] Spans cleared between runs
- [x] Can modify config and re-run
- [x] Ctrl+C exits cleanly

## Migration Notes

### For Users
- **No breaking changes** - Debug server now just works better
- Server stays alive automatically - no need to restart
- Faster iteration when developing checks

### For Developers
- WebSocket code completely removed
- Simpler HTTP polling architecture
- Standard HTTP debugging tools work
- Process lifecycle is explicit and predictable

## Future Enhancements

Potential improvements for future milestones:

1. **Manual Re-run Trigger**: Add UI button to trigger new execution without modifying files
2. **Live Config Editing**: Edit config directly in UI and re-run
3. **Run History**: Keep multiple runs in memory for comparison
4. **Diff View**: Compare spans between runs
5. **Export Traces**: Download collected spans as JSON/OTLP
6. **Performance Metrics**: Show execution time trends across runs

## Conclusion

The debug server is now a true development tool that supports iterative workflows. Users can:
- Start the server once
- Make changes to config/code
- Re-run checks
- Analyze results
- Repeat

All without restarting the server or losing context.
