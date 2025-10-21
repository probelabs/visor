# Execution Control for Live Mode

**Added**: 2025-10-17
**Status**: ✅ Fully Implemented

---

## Overview

The Debug Visualizer now supports **manual execution control** in live mode, giving you complete control over when and how visor execution proceeds. Instead of automatically starting when you run `visor --debug-server`, the execution now waits for you to explicitly click "Start" in the UI.

---

## Features

### 1. **Manual Start** ▶️
- **Behavior**: When you run `visor --debug-server`, the browser opens but execution is **paused**
- **UI Shows**: "Waiting to start..." status
- **Action**: Click the green **"▶ Start Execution"** button to begin
- **Server Behavior**: Visor queues all spans until you click Start, then processes them

### 2. **Pause During Execution** ⏸
- **Button**: **"⏸ Pause"** (visible while running)
- **Behavior**: Stops processing new spans, but keeps the connection alive
- **Use Case**: Take a closer look at current state without new updates flooding in
- **Queuing**: Any spans received while paused are queued for later

### 3. **Resume** ▶
- **Button**: **"▶ Resume"** (visible while paused)
- **Behavior**: Processes all queued spans and continues live updates
- **Visual**: Graph updates with all queued changes at once

### 4. **Stop** ⏹
- **Button**: **"⏹ Stop"** (visible while running/paused)
- **Behavior**: Stops execution completely and clears the message queue
- **Use Case**: Terminate a long-running execution early
- **After Stop**: Can use Reset to start fresh

### 5. **Reset** 🔄
- **Button**: **"🔄 Reset"** (visible after stop or completion)
- **Behavior**:
  - Clears all trace data
  - Resets the graph visualization
  - Hides the timeline
  - Returns to "Ready" state
- **Use Case**: Start a fresh execution run

---

## UI Layout

```
┌─────────────────────────────────────────────────────────────┐
│ 🔍 Visor Debug Visualizer                                   │
│                                                              │
│  ▶ Start Execution    ⏸ Pause    ⏹ Stop    🔄 Reset        │
│  Status: Waiting to start...                                │
└─────────────────────────────────────────────────────────────┘
```

**Button States**:
- **Initially**: Only "▶ Start Execution" is visible
- **While Running**: "⏸ Pause" and "⏹ Stop" are visible
- **While Paused**: "▶ Resume" and "⏹ Stop" are visible
- **After Stop/Complete**: "🔄 Reset" is visible

---

## Usage Examples

### Basic Workflow

```bash
# 1. Start visor with debug server
visor --debug-server --check all

# 2. Browser opens automatically showing:
#    "Live Mode - Connected - Click Start to begin execution"

# 3. Click "▶ Start Execution" button

# 4. Watch execution in real-time

# 5. Click "⏸ Pause" to freeze visualization

# 6. Click "▶ Resume" to continue

# 7. After completion, click "🔄 Reset" to start fresh
```

### Debugging Long Executions

```bash
# Start a complex check suite
visor --debug-server --check all

# In UI:
# 1. Click Start
# 2. Watch first few checks
# 3. Pause when you see something interesting
# 4. Inspect the node details
# 5. Resume when ready
# 6. Pause again at next interesting point
```

### Early Termination

```bash
# Start execution
visor --debug-server --check slow-check

# In UI:
# 1. Click Start
# 2. Realize this will take too long
# 3. Click Stop
# 4. Click Reset
# 5. Run a different check instead
```

---

## Message Flow

### Client → Server Messages

When you click a button, the UI sends control messages to the server:

```javascript
{
  "type": "control",
  "action": "start" | "pause" | "resume" | "stop" | "reset"
}
```

### Server → Client Responses

The server acknowledges each control action:

```javascript
{
  "type": "event",
  "data": {
    "message": "Execution started",
    "action": "start"
  },
  "timestamp": "2025-10-17T12:34:56.789Z"
}
```

### Span Queuing

**Without Start**:
```
Server emits span → UI queues it (doesn't display)
Server emits span → UI queues it (doesn't display)
...
User clicks Start → UI processes all queued spans at once
```

**With Pause**:
```
User clicks Pause
Server emits span → UI queues it (doesn't display)
Server emits span → UI queues it (doesn't display)
User clicks Resume → UI processes all queued spans
```

---

## Technical Implementation

### UI State Machine

```javascript
const liveMode = {
  isLive: false,      // Is this a live session?
  isRunning: false,   // Has user clicked Start?
  isPaused: false,    // Is execution paused?
  queuedMessages: [], // Buffered spans/events

  start() {
    this.isRunning = true;
    this.isPaused = false;
    this.processQueue(); // Process all queued spans
  },

  pause() {
    this.isPaused = true;
    // Future spans get queued
  },

  resume() {
    this.isPaused = false;
    this.processQueue(); // Process queued spans
  },

  stop() {
    this.isRunning = false;
    this.queuedMessages = []; // Clear queue
  },

  reset() {
    // Clear everything and return to initial state
  }
};
```

### Message Handling

```javascript
ws.onmessage = (event) => {
  const message = JSON.parse(event.data);

  // Queue if not started or paused
  if (!liveMode.isRunning || liveMode.isPaused) {
    liveMode.queuedMessages.push(message);
    return;
  }

  // Process immediately if running
  liveMode.handleMessage(message);
};
```

---

## Files Modified

### UI Changes
- **File**: `src/debug-visualizer/ui/index.html`
- **Changes**:
  - Added execution control buttons in header
  - Implemented `liveMode` state machine object
  - Added message queuing logic
  - Added button visibility management
  - Added status text updates

### Server Changes
- **File**: `src/debug-visualizer/ws-server.ts`
- **Changes**:
  - Implemented `handleClientMessage()` method
  - Added control message handling (start/pause/resume/stop/reset)
  - Added acknowledgment responses for each action

---

## Benefits

✅ **User Control**: You decide when execution starts, not the system
✅ **Inspection**: Pause at any point to examine state
✅ **Performance**: Queue spans instead of dropping them during inspection
✅ **Debugging**: Stop long-running executions early
✅ **Clean Slate**: Reset to try different scenarios

---

## Future Enhancements

Potential additions for future versions:

1. **Server-Side Pause**: Actually pause check execution on the server (not just UI)
2. **Step Mode**: Execute one check at a time with manual stepping
3. **Breakpoints**: Pause automatically when specific checks start
4. **Speed Control**: Slow down or speed up replay of queued spans
5. **Save/Load State**: Save current execution state and resume later

---

## Testing

To test the execution controls:

```bash
# 1. Build
npm run build

# 2. Run with debug server
./dist/index.js --debug-server --check all

# 3. In browser:
#    - Verify "Start Execution" button is visible
#    - Click it and verify execution begins
#    - Click Pause and verify it stops updating
#    - Click Resume and verify it continues
#    - Click Stop and verify it terminates
#    - Click Reset and verify graph clears
```

---

## Summary

The execution control feature transforms live mode from a passive observation tool into an **interactive debugging interface**. You now have precise control over execution timing, can pause to inspect state, and can restart cleanly - making it much easier to understand and debug complex check flows.

**Key Insight**: By queuing messages instead of auto-playing them, you get the best of both worlds:
- No lost data (everything is captured)
- Full control over when to process updates
- Ability to "catch up" when you resume
