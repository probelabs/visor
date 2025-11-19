# RFC: Event-Driven GitHub Integration

**Status**: Proposed
**Created**: 2025-11-19
**Author**: Architecture Planning

## Abstract

This RFC proposes an event-driven architecture for GitHub integration with the state machine engine, replacing the current dependency injection pattern. The goal is to enable multi-platform support, improve testability, and align with the observability and replay goals outlined in the state machine RFC (Section 5).

## Motivation

### Current Architecture

The state machine currently uses **dependency injection** for GitHub integration:

- `GitHubCheckService` is created externally by main engine
- Service is injected via `EngineContext.gitHubChecks`
- State handlers call service methods directly (e.g., `context.gitHubChecks.createCheck()`)
- Main engine handles initialization and finalization

**Advantages**:
- Simple and direct
- Easy to trace control flow
- Minimal complexity for single integration point

**Limitations**:
- Tight coupling to GitHub as the only platform
- Testing requires mocking service methods
- No natural extension point for additional platforms (Slack, webhooks, metrics)
- GitHub-specific code leaks into state machine logic

### Goals of Event-Driven Approach

1. **Platform Agnostic**: State machine emits generic events; adapters translate to platform-specific operations
2. **Multi-Platform Support**: Add Slack, webhooks, metrics without modifying state machine
3. **Improved Testability**: Assert on events instead of mocking service calls
4. **Replay Support**: Event log becomes complete audit trail for time-travel debugging
5. **Observability**: Central event bus for logging, metrics, tracing

## Proposed Architecture

### 1. Event Schema Design

Extend `EngineEvent` type in `src/types/engine.ts` with GitHub-specific events:

```typescript
// Request events (emitted by state machine)
export type EngineEvent =
  // ... existing events ...
  | {
      type: 'GitHubCheckCreateRequested';
      checkName: string;
      status: 'queued' | 'in_progress';
      output?: {
        title: string;
        summary: string;
      };
    }
  | {
      type: 'GitHubCheckUpdateRequested';
      checkName: string;
      status: 'in_progress' | 'completed' | 'cancelled';
      conclusion?: 'success' | 'failure' | 'neutral' | 'skipped';
      output?: {
        title: string;
        summary: string;
        text?: string;
        annotations?: any[];
      };
    }
  | {
      type: 'GitHubCommentRequested';
      body: string;
      commentId?: string; // for updates
    }
  // Completion events (emitted by adapters back to state machine)
  | {
      type: 'GitHubCheckCompleted';
      checkName: string;
      success: boolean;
      error?: SerializedError;
    }
  | {
      type: 'GitHubCommentPosted';
      commentId: string;
      success: boolean;
      error?: SerializedError;
    };
```

**Design Decisions**:
- **Request/Response Pattern**: Separate "Requested" (state machine → adapter) from "Completed" (adapter → state machine)
- **Platform Agnostic Core**: State machine emits generic check/comment requests
- **Error Feedback Loop**: Adapters emit completion events for retry logic

### 2. Event Bus Architecture

**File**: `src/event-bus/event-bus.ts`

```typescript
export type EventHandler<T extends EngineEvent> = (event: T) => void | Promise<void>;
export type EventFilter<T extends EngineEvent> = (event: T) => boolean;

export interface Subscription {
  unsubscribe(): void;
}

export class EventBus {
  private handlers: Map<string, Set<EventHandler<any>>> = new Map();
  private globalHandlers: Set<EventHandler<any>> = new Set();

  /**
   * Subscribe to specific event type
   */
  on<T extends EngineEvent['type']>(
    eventType: T,
    handler: EventHandler<Extract<EngineEvent, { type: T }>>,
    filter?: EventFilter<Extract<EngineEvent, { type: T }>>
  ): Subscription;

  /**
   * Subscribe to all events
   */
  onAny(handler: EventHandler<EngineEvent>): Subscription;

  /**
   * Emit event (handles both sync and async handlers)
   */
  emit(event: EngineEvent): Promise<void>;

  /**
   * Emit and wait for completion event
   * Useful for request/response patterns
   */
  emitAndWait<T extends EngineEvent>(
    event: T,
    completionType: EngineEvent['type'],
    timeout?: number
  ): Promise<Extract<EngineEvent, { type: typeof completionType }>>;
}
```

**Integration with StateMachineRunner**:

Modify `src/state-machine/runner.ts`:

```typescript
export class StateMachineRunner {
  private context: EngineContext;
  private state: RunState;
  private debugServer?: DebugVisualizerServer;
  private eventBus?: EventBus; // NEW: optional for backward compatibility

  constructor(
    context: EngineContext,
    debugServer?: DebugVisualizerServer,
    eventBus?: EventBus // NEW
  ) {
    this.context = context;
    this.state = this.initializeState();
    this.debugServer = debugServer;
    this.eventBus = eventBus;
  }

  private emitEvent(event: EngineEvent): void {
    // Existing behavior
    this.state.historyLog.push(event);

    if (event.type === 'ForwardRunRequested' || event.type === 'WaveRetry') {
      this.state.eventQueue.push(event);
    }

    if (this.debugServer) {
      try {
        this.streamEventToDebugServer(event);
      } catch (_err) {}
    }

    // NEW: Emit to event bus if available
    if (this.eventBus) {
      this.eventBus.emit(event).catch(err => {
        logger.error(`[EventBus] Error emitting ${event.type}:`, err);
      });
    }

    if (this.context.debug && event.type !== 'StateTransition') {
      logger.debug(`[StateMachine] Event: ${event.type}`);
    }
  }
}
```

### 3. GitHub Adapter Implementation

**File**: `src/event-bus/adapters/github-adapter.ts`

```typescript
export class GitHubEventAdapter {
  private eventBus: EventBus;
  private gitHubService: GitHubCheckService;
  private subscriptions: Subscription[] = [];

  constructor(eventBus: EventBus, gitHubService: GitHubCheckService) {
    this.eventBus = eventBus;
    this.gitHubService = gitHubService;
  }

  start(): void {
    // Subscribe to GitHub-related request events
    this.subscriptions.push(
      this.eventBus.on('GitHubCheckCreateRequested', this.handleCheckCreate.bind(this))
    );
    this.subscriptions.push(
      this.eventBus.on('GitHubCheckUpdateRequested', this.handleCheckUpdate.bind(this))
    );
    this.subscriptions.push(
      this.eventBus.on('GitHubCommentRequested', this.handleCommentRequest.bind(this))
    );

    // Subscribe to state transitions for automatic status updates
    this.subscriptions.push(
      this.eventBus.on('StateTransition', this.handleStateTransition.bind(this))
    );
    this.subscriptions.push(
      this.eventBus.on('CheckCompleted', this.handleCheckCompleted.bind(this))
    );
  }

  stop(): void {
    this.subscriptions.forEach(sub => sub.unsubscribe());
    this.subscriptions = [];
  }

  private async handleCheckCreate(
    event: Extract<EngineEvent, { type: 'GitHubCheckCreateRequested' }>
  ): Promise<void> {
    try {
      await this.gitHubService.createCheck({
        name: event.checkName,
        status: event.status,
        output: event.output,
      });

      // Emit completion event
      await this.eventBus.emit({
        type: 'GitHubCheckCompleted',
        checkName: event.checkName,
        success: true,
      });
    } catch (error) {
      await this.eventBus.emit({
        type: 'GitHubCheckCompleted',
        checkName: event.checkName,
        success: false,
        error: {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          name: error instanceof Error ? error.name : undefined,
        },
      });
    }
  }

  private async handleCheckUpdate(
    event: Extract<EngineEvent, { type: 'GitHubCheckUpdateRequested' }>
  ): Promise<void> {
    try {
      await this.gitHubService.updateCheck({
        name: event.checkName,
        status: event.status,
        conclusion: event.conclusion,
        output: event.output,
      });

      await this.eventBus.emit({
        type: 'GitHubCheckCompleted',
        checkName: event.checkName,
        success: true,
      });
    } catch (error) {
      await this.eventBus.emit({
        type: 'GitHubCheckCompleted',
        checkName: event.checkName,
        success: false,
        error: {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          name: error instanceof Error ? error.name : undefined,
        },
      });
    }
  }

  private async handleCommentRequest(
    event: Extract<EngineEvent, { type: 'GitHubCommentRequested' }>
  ): Promise<void> {
    try {
      const commentId = event.commentId
        ? await this.gitHubService.updateComment(event.commentId, event.body)
        : await this.gitHubService.createComment(event.body);

      await this.eventBus.emit({
        type: 'GitHubCommentPosted',
        commentId,
        success: true,
      });
    } catch (error) {
      await this.eventBus.emit({
        type: 'GitHubCommentPosted',
        commentId: event.commentId || '',
        success: false,
        error: {
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          name: error instanceof Error ? error.name : undefined,
        },
      });
    }
  }

  private async handleStateTransition(
    event: Extract<EngineEvent, { type: 'StateTransition' }>
  ): Promise<void> {
    // Auto-update GitHub check status based on state transitions
    if (event.to === 'CheckRunning') {
      await this.eventBus.emit({
        type: 'GitHubCheckUpdateRequested',
        checkName: 'visor-review',
        status: 'in_progress',
        output: {
          title: 'Running checks...',
          summary: `State: ${event.to}`,
        },
      });
    } else if (event.to === 'Completed') {
      await this.eventBus.emit({
        type: 'GitHubCheckUpdateRequested',
        checkName: 'visor-review',
        status: 'completed',
        conclusion: 'success',
        output: {
          title: 'Review completed',
          summary: 'All checks completed successfully',
        },
      });
    } else if (event.to === 'Error') {
      await this.eventBus.emit({
        type: 'GitHubCheckUpdateRequested',
        checkName: 'visor-review',
        status: 'completed',
        conclusion: 'failure',
        output: {
          title: 'Review failed',
          summary: 'Execution encountered an error',
        },
      });
    }
  }

  private async handleCheckCompleted(
    event: Extract<EngineEvent, { type: 'CheckCompleted' }>
  ): Promise<void> {
    // Optionally update GitHub with individual check results
    // This would aggregate results and post comments/annotations
  }
}
```

### 4. Migration Strategy

**Phase 1: Additive Changes (No Breaking Changes)**

1. Add `EventBus` class alongside existing code
2. Make `eventBus` optional parameter in `StateMachineRunner` constructor
3. Keep existing `GitHubCheckService` in `EngineContext`
4. Add event emission in `emitEvent()` method (non-blocking)
5. Both direct calls AND events work simultaneously

**Phase 2: Dual-Mode Operation**

1. Add feature flag: `context.config.experimental?.eventDrivenGitHub`
2. When enabled:
   - Remove `gitHubChecks` from `EngineContext`
   - Pass `EventBus` to runner
   - Create `GitHubEventAdapter` in main engine
3. When disabled (default):
   - Keep current dependency injection pattern
4. All tests pass in both modes

**Phase 3: Full Migration (Breaking Change)**

1. Remove `gitHubChecks` from `EngineContext` interface entirely
2. Make `eventBus` required in `StateMachineRunner`
3. Remove all direct `context.gitHubChecks` calls from state handlers
4. Replace with event emissions
5. Update all state files:
   - `init.ts`: Emit `GitHubCheckCreateRequested` instead of checking `context.gitHubChecks`
   - `completed.ts`: Remove GitHub finalization (adapter handles it)
   - Other states emit events as needed

**Backward Compatibility During Migration**:

```typescript
// In state-machine-execution-engine.ts
const eventBus = context.config.experimental?.eventDrivenGitHub
  ? new EventBus()
  : undefined;

const gitHubAdapter = eventBus && gitHubCheckService
  ? new GitHubEventAdapter(eventBus, gitHubCheckService)
  : undefined;

if (gitHubAdapter) {
  gitHubAdapter.start();
}

const runner = new StateMachineRunner(
  context,
  this.debugServer,
  eventBus // optional, undefined in legacy mode
);

await runner.run();

if (gitHubAdapter) {
  gitHubAdapter.stop();
}
```

## Benefits

### Multi-Platform Support

Add new platforms without touching state machine:

```typescript
// Slack adapter
export class SlackEventAdapter {
  constructor(eventBus: EventBus, slackClient: SlackClient) { }

  start(): void {
    this.eventBus.on('CheckCompleted', this.postSummaryToSlack.bind(this));
    this.eventBus.on('StateTransition', this.updateSlackThread.bind(this));
  }
}

// Metrics adapter
export class MetricsEventAdapter {
  constructor(eventBus: EventBus, metricsClient: PrometheusClient) { }

  start(): void {
    this.eventBus.on('CheckCompleted', this.recordCheckDuration.bind(this));
    this.eventBus.on('StateTransition', this.recordStateTransition.bind(this));
  }
}
```

### Testing Improvements

Replace mock-based testing with assertion-based testing:

```typescript
// Before: Mock-based (brittle)
it('should create GitHub check when entering CheckRunning state', async () => {
  const mockGitHub = {
    createCheck: jest.fn(),
  };
  const context = { gitHubChecks: mockGitHub };

  await runner.run();

  expect(mockGitHub.createCheck).toHaveBeenCalledWith({
    name: 'visor-review',
    status: 'in_progress',
  });
});

// After: Event assertion (clear)
it('should create GitHub check when entering CheckRunning state', async () => {
  const eventBus = new EventBus();
  const events: EngineEvent[] = [];

  eventBus.onAny(event => events.push(event));

  const runner = new StateMachineRunner(context, undefined, eventBus);
  await runner.run();

  const checkCreateEvent = events.find(
    e => e.type === 'GitHubCheckCreateRequested'
  );

  expect(checkCreateEvent).toBeDefined();
  expect(checkCreateEvent.checkName).toBe('visor-review');
});
```

### Replay/Resume Support

- `historyLog` already captures all events
- To resume: replay events through `EventBus`
- Adapters can be idempotent (skip already-created GitHub checks)
- Enables time-travel debugging

### Observability

- Central point to add logging, metrics, tracing
- Debug visualizer becomes an adapter that subscribes to all events
- Prometheus metrics adapter counts event types
- Audit logger writes events to file

## Trade-offs

### Pros

- ✅ Clean separation: state machine focuses on workflow logic, adapters handle I/O
- ✅ Testability: assert on events instead of mocking services
- ✅ Extensibility: add new platforms without modifying state machine
- ✅ Replay: `historyLog` becomes complete audit trail
- ✅ Future-proof: aligns with RFC Section 5 goals

### Cons

- ❌ Increased complexity: event bus, subscription management, adapter lifecycle
- ❌ Asynchronous errors harder to handle (adapter fails, how does state machine know?)
- ❌ Timing issues: what if GitHub check creation fails mid-execution?
- ❌ Debugging: event flow harder to trace than direct calls
- ❌ Performance: extra layer of indirection

### When This Makes Sense

- ✅ Multiple output destinations (GitHub + Slack + webhooks + metrics)
- ✅ Complex retry/resilience requirements
- ✅ Need for event replay/time-travel debugging
- ✅ Strict platform-agnostic requirements

### When Current Pattern Is Better

- ✅ Single integration point (GitHub only)
- ✅ Simple success/failure reporting
- ✅ Direct control flow easier to reason about
- ✅ Team unfamiliar with event-driven patterns

## Recommendation: Hybrid Approach

Instead of full migration, consider **targeted event-driven features**:

1. **Keep dependency injection for core GitHub integration**
   - GitHub check creation/updates stay in handlers
   - Simpler error handling
   - Easier to debug

2. **Add EventBus for observability only**
   - Debug visualizer subscribes to events
   - Metrics adapter tracks execution statistics
   - Audit logger writes events to file

3. **Use events for cross-cutting concerns**
   - Progress reporting
   - Telemetry
   - Error tracking

4. **Direct calls for critical path**
   - GitHub operations remain synchronous
   - Clearer control flow

This gives you event benefits (observability, extensibility) without event costs (complexity, async error handling).

## Open Questions

1. **Error Handling**: How should state machine react to adapter failures?
   - Option A: Adapters emit error events, state machine retries
   - Option B: Adapters handle retries internally, state machine ignores failures
   - Option C: Critical adapters (GitHub) fail fast, optional adapters (metrics) fail silently

2. **Event Ordering**: Should event bus guarantee delivery order?
   - Option A: FIFO queue per subscriber
   - Option B: Best effort, no guarantees
   - Option C: Priority-based delivery

3. **Adapter Lifecycle**: When should adapters be created/destroyed?
   - Option A: One adapter per state machine run (created in constructor, destroyed after run)
   - Option B: Long-lived adapters shared across runs
   - Option C: Lazy initialization on first event

4. **Event Persistence**: Should events be persisted for replay?
   - Option A: Yes, write to disk/database for full audit trail
   - Option B: No, `historyLog` in memory is sufficient
   - Option C: Configurable persistence strategy

## Implementation Checklist

### Phase 1: Foundation
- [ ] Implement `EventBus` class with subscription management
- [ ] Add `eventBus` optional parameter to `StateMachineRunner`
- [ ] Modify `emitEvent()` to publish to event bus
- [ ] Add unit tests for `EventBus`

### Phase 2: GitHub Adapter
- [ ] Implement `GitHubEventAdapter` with request handlers
- [ ] Add feature flag `experimental.eventDrivenGitHub`
- [ ] Wire up adapter in `state-machine-execution-engine.ts`
- [ ] Add integration tests for dual-mode operation

### Phase 3: Multi-Platform Examples
- [ ] Implement `SlackEventAdapter` (example)
- [ ] Implement `MetricsEventAdapter` (example)
- [ ] Document adapter API and patterns

### Phase 4: Migration (Breaking Change)
- [ ] Remove `gitHubChecks` from `EngineContext`
- [ ] Make `eventBus` required parameter
- [ ] Update all state handlers to emit events
- [ ] Update all tests to new pattern

## References

- [State Machine RFC](./engine-state-machine-plan.md) - Section 5: Toward NASA-style guarantees
- [Debug Visualizer RFC](./debug-visualizer-rfc.md) - Event streaming for time-travel debugging
- [Telemetry Tracing RFC](./telemetry-tracing-rfc.md) - Observability integration

## Conclusion

Event-driven GitHub integration offers significant benefits for multi-platform support, testability, and observability. However, the current dependency injection pattern is simpler and sufficient for single-platform (GitHub) use cases.

**Recommended approach**: Start with **hybrid model** (event bus for observability, direct calls for GitHub) to gain benefits without complexity costs. Migrate to full event-driven architecture only if/when multi-platform support becomes a real requirement.
