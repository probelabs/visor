# RFC: Event-Driven Integrations via Frontends (GitHub, Slack, …)

**Status**: Implemented (Phases 1-2 Complete)
**Created**: 2025-11-19
**Updated**: 2026-01-28
**Author**: Architecture Planning

## Abstract

This RFC proposes moving to a fully event‑driven architecture for integrations using a pluggable “frontends” system that reacts to neutral engine events. The legacy dependency‑injection (DI) GitHub path remains in the codebase for backward compatibility, but new functionality—including the new GitHub integration—will be implemented as frontends on the event bus.

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

### 1. Neutral Event Envelope & Taxonomy (Platform‑agnostic)

Instead of GitHub‑specific core events, define a neutral event payload taxonomy and wrap every payload in a common envelope that carries correlation/observability metadata.

```typescript
// Neutral domain payloads (core)
export type EngineEvent =
  // ... existing engine events (StateTransition, CheckScheduled, CheckCompleted, etc.) ...
  | {
      type: 'CheckStatusRequested';
      checkId?: string;            // stable id if available (external_id, run key)
      checkName: string;           // human name
      status: 'queued' | 'in_progress' | 'completed' | 'cancelled';
      conclusion?: 'success' | 'failure' | 'neutral' | 'skipped';
      output?: { title?: string; summary?: string; text?: string; annotations?: any[] };
      idempotencyKey?: string;     // required for side effects (see delivery policy)
    }
  | {
      type: 'CommentRequested';
      body: string;
      threadKey?: string;          // adapter can group updates by logical thread
      commentId?: string;          // update if present
      idempotencyKey?: string;     // for safe retries
    }
  // Adapter feedback (generic)
  | {
      type: 'CheckStatusCompleted';
      checkId?: string;
      success: boolean;
      error?: SerializedError;
    }
  | {
      type: 'CommentPosted';
      threadKey?: string;
      commentId: string;
      success: boolean;
      error?: SerializedError;
    };

// Event envelope (common metadata for all events)
export interface EventEnvelope<T extends EngineEvent = EngineEvent> {
  id: string;                 // uuid
  version: 1;                 // envelope version
  timestamp: string;          // ISO8601
  // Correlation
  runId: string;              // engine run id
  workflowId?: string;        // active workflow/config id
  caseId?: string;            // test/case id (when under runner)
  wave?: number;              // wave counter
  attempt?: number;           // retries for the check
  checkId?: string;           // convenience copy if available
  traceId?: string;           // tracing correlation
  spanId?: string;            // tracing correlation
  causationId?: string;       // which event caused this
  correlationId?: string;     // stable id for a log/thread/check group
  payload: T;                 // the actual domain event
}
```

Adapter‑specific payloads (e.g., GitHubCheckAnnotationRequested) should live under adapter namespaces and must be created by adapters in response to neutral core events, not emitted by the state machine core.

**Design Decisions**:
- Core stays platform‑agnostic (CheckStatusRequested, CommentRequested, …)
- Envelope carries correlation/idempotency/observability metadata
- Feedback events are generic (Completed/Posted) and do not leak provider names

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
  emit(event: EngineEvent | EventEnvelope): Promise<void>;

  /**
   * Emit and wait for completion event
   * Useful for request/response patterns
   */
  emitAndWait<T extends EngineEvent>(
    event: T | EventEnvelope<T>,
    completionType: EngineEvent['type'],
    timeout?: number
  ): Promise<EventEnvelope<Extract<EngineEvent, { type: typeof completionType }>>>;
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

    // NEW: Emit to event bus if available (wrapped in envelope)
    if (this.eventBus) {
      const envelope: EventEnvelope = {
        id: uuidv4(),
        version: 1,
        timestamp: new Date().toISOString(),
        runId: this.state.runId,
        workflowId: this.state.workflowId,
        wave: this.state.wave,
        payload: event,
      };
      this.eventBus.emit(envelope).catch(err => {
        logger.error(`[EventBus] Error emitting ${event.type}:`, err);
      });
    }

    if (this.context.debug && event.type !== 'StateTransition') {
      logger.debug(`[StateMachine] Event: ${event.type}`);
    }
  }
}
```

### 3. GitHub Frontend Implementation (example)

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
    // Subscribe to neutral request events
    this.subscriptions.push(
      this.eventBus.on('CheckStatusRequested', this.handleCheckStatus.bind(this))
    );
    this.subscriptions.push(
      this.eventBus.on('CommentRequested', this.handleCommentRequest.bind(this))
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

  private async handleCheckStatus(
    event: Extract<EngineEvent, { type: 'CheckStatusRequested' }>
  ): Promise<void> {
    try {
      // Map neutral request to GitHub API (create/update by external_id)
      await this.gitHubService.upsertCheck({
        externalId: event.checkId || event.idempotencyKey,
        name: event.checkName,
        status: event.status,
        conclusion: event.conclusion,
        output: event.output,
      });

      // Emit completion event
      await this.eventBus.emit({ type: 'CheckStatusCompleted', checkId: event.checkId, success: true });
    } catch (error) {
      await this.eventBus.emit({ type: 'CheckStatusCompleted', checkId: event.checkId, success: false, error: {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        name: error instanceof Error ? error.name : undefined,
      }});
    }
  }

  private async handleCommentRequest(
    event: Extract<EngineEvent, { type: 'CommentRequested' }>
  ): Promise<void> {
    try {
      const commentId = event.commentId
        ? await this.gitHubService.updateComment(event.commentId, event.body)
        : await this.gitHubService.createComment(event.body);
      await this.eventBus.emit({ type: 'CommentPosted', commentId, success: true });
    } catch (error) {
      await this.eventBus.emit({ type: 'CommentPosted', commentId: event.commentId || '', success: false, error: {
        message: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
        name: error instanceof Error ? error.name : undefined,
      }});
    }
  }

  private async handleStateTransition(
    event: Extract<EngineEvent, { type: 'StateTransition' }>
  ): Promise<void> {
    // Auto-update check status based on state transitions (derive names from context)
    if (event.to === 'CheckRunning') {
      await this.eventBus.emit({ type: 'CheckStatusRequested', checkName: event.checkName || 'run', status: 'in_progress', output: { title: 'Running checks...', summary: `State: ${event.to}` } });
    } else if (event.to === 'Completed') {
      await this.eventBus.emit({ type: 'CheckStatusRequested', checkName: event.checkName || 'run', status: 'completed', conclusion: 'success', output: { title: 'Completed', summary: 'All checks completed successfully' } });
    } else if (event.to === 'Error') {
      await this.eventBus.emit({ type: 'CheckStatusRequested', checkName: event.checkName || 'run', status: 'completed', conclusion: 'failure', output: { title: 'Failed', summary: 'Execution encountered an error' } });
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

#### 3.1 Comment Grouping & Incremental Updates (GitHub)

Goal: keep a single evolving PR comment that summarizes the run, grouped by check/step, and update it incrementally without spamming new comments.

Default strategy (no new knobs):

- Thread key: `threadKey = <repo>#<pull_number>@<head_sha>[:<workflowId>]` (or `runId` when PR metadata is unavailable).
- Hidden markers: the adapter renders HTML comment markers to delineate the “visor group” and each step section. GitHub preserves these markers but does not display them.
- Single comment policy: create once, then update in place using `commentId`. Adapter discovers an existing comment by scanning for the `visor:thread` header marker.
- Partial update (logical): the adapter parses the existing body into sections (by markers), replaces only changed sections in memory, and re-renders the full body for the GitHub update API call.
- Debounce & coalescing: updates are debounced (e.g., 300–500 ms) to batch bursts of events and respect rate limits.
- Idempotency: for each update, compute `idempotencyKey = hash(threadKey + revision)`. Retries reuse the same key.

Markers and layout:

```markdown
<!-- visor:thread={
  "key":"<threadKey>",
  "runId":"<runId>",
  "workflowId":"<workflowId>",
  "headSha":"<sha>",
  "revision": 7,
  "generatedAt": "2025-11-19T12:34:56Z"
} -->

## Visor Summary — <status icon> <conclusion>  
SHA: <shortSha> • Checks: <passed>/<total> • Duration: <h:mm:ss>

<!-- visor:section={"id":"overview","name":"overview"} -->
### Overview <status>
…overview summary…
<!-- visor:section-end id="overview" -->

<!-- visor:section={"id":"security","name":"security"} -->
### Security <status>
…security summary and key failures…
<!-- visor:section-end id="security" -->

<!-- visor:thread-end key="<threadKey>" -->
```

Aggregation model (maintained in adapter):

```ts
type StepStatus = 'queued'|'in_progress'|'completed';
type StepConclusion = 'success'|'failure'|'neutral'|'skipped'|undefined;

interface StepModel {
  name: string;
  status: StepStatus;
  conclusion?: StepConclusion;
  startedAt?: string;
  completedAt?: string;
  annotations?: number;  // count only
  summary?: string;      // brief human text
}

interface ThreadModel {
  threadKey: string;
  runId: string;
  workflowId?: string;
  headSha?: string;
  revision: number;      // increments on each render
  steps: Record<string, StepModel>;
  totals: { passed: number; failed: number; skipped: number; total: number };
}
```

Update cycle (pseudocode):

```ts
onEvent(envelope) {
  switch (envelope.payload.type) {
    case 'CheckStatusRequested':
    case 'CheckCompleted':
      updateThreadModel(model, envelope);  // update steps/totals
      scheduleRender(threadKey);
      break;
    case 'StateTransition':
      if (to === 'Completed' || to === 'Error') scheduleRender(threadKey);
  }
}

async renderThread(threadKey) {
  const comment = await findOrCreateComment(threadKey);          // scan once per run; cache commentId
  const existing = comment?.body || '';
  const parsed = parseSections(existing);                         // read markers into a dictionary
  const next = mergeSections(parsed, buildSectionsFromModel());   // replace only changed sections
  const body = serialize(next);                                   // full markdown body
  const idempotencyKey = hash(threadKey + model.revision);
  await github.updateComment(comment.id, body, { idempotencyKey });
  model.revision++;
}
```

Notes:

- findOrCreateComment: search the PR for a comment containing `<!-- visor:thread={..."key":"<threadKey>"...} -->`; if none found, create one and include the header marker.
- parseSections/mergeSections/serialize: simple utilities that treat the comment as a set of named blocks framed by section markers; unknown blocks are preserved unmodified.
- Failure safety: if parsing fails (e.g., user edited the comment and removed markers), the adapter falls back to re‑creating the comment with fresh markers and updates the cached `commentId`.
- Multiple workflows: include `workflowId` in `threadKey` to separate comments per workflow if desired; default behavior is one summary per PR/headSha.

##### 3.1.1 Section‑Level Metadata & Override Semantics

Each rendered section carries compact JSON metadata in the start marker to enable precise partial replacement without touching other sections. Recommended fields:

- `id`: stable logical id (e.g., step id: `overview`, `security`)
- `name`: human label (optional)
- `runId`: engine run id that produced this section
- `wave`: wave counter when the section was updated (optional)
- `revision`: monotonically increasing integer maintained by the adapter per section

Replacement rules:

- On each render, the adapter compares the incoming section’s `{ id, runId }` against what exists in the current comment body. If found, it replaces the entire block between `section` and `section-end`. If not found, it appends the new block before `thread-end`.
- The `revision` is incremented after a successful update and recorded in the marker JSON to support idempotent retries (same `{id, runId, revision}` should be a no‑op).
- When a step disappears (e.g., configuration change), the adapter may either preserve the last known block (default) or remove it if a `pruneMissingSections` policy is enabled.

Idempotency and dedupe:

- The update call uses `idempotencyKey = hash(threadKey + sectionId + revision)` to ensure safe retries.
- If GitHub returns 409/412 (conflict/precondition), the adapter re‑fetches, re‑parses, merges, and retries once.

Slack mapping:

- Use Slack thread messages with a single parent message keyed by `threadKey`; per‑section updates edit a dedicated child message whose `ts` is cached by `{threadKey, sectionId}`. This mirrors the GitHub marker approach without HTML comments.

#### 3.2 Frontends API (Pluggable Integrations)

Contracts (reference shapes to implement):

```ts
export interface Frontend {
  readonly name: string;                               // e.g., "github", "slack", "ndjson-sink"
  readonly subscriptions?: Array<EngineEvent['type']>; // optional; host may wire defaults
  start(ctx: FrontendContext): Promise<void> | void;
  stop(): Promise<void> | void;
}

export interface FrontendContext {
  eventBus: EventBus;
  logger: Logger;
  config: unknown; // decoded user config for this frontend only
  run: { runId: string; workflowId?: string; repo?: string; pr?: number; headSha?: string };
}

export interface FrontendSpec {
  name: string;            // "github"
  package?: string;        // external package name for discovery; omitted for built-ins
  config?: unknown;        // serialized config to hand to the frontend
  features?: string[];     // claims, e.g., ["checks","summary-comment","annotations"]
}

export class FrontendsHost {
  constructor(private bus: EventBus, private log: Logger) {}
  async load(specs: FrontendSpec[]): Promise<void> { /* resolve built-ins or dynamic import */ }
  async startAll(ctxFactory: () => FrontendContext): Promise<void> { /* wire subs; start */ }
  async stopAll(): Promise<void> { /* unsubscribe; stop */ }
}
```

Feature ownership and conflicts
- A single feature for a provider must have a single owner (e.g., exactly one GitHub frontend owns "checks").
- The host enforces exclusivity; the first claimant wins by config order and a warning is logged for subsequent claimants.
- Legacy DI is bypassed when a frontend claims a feature to prevent double posting.

Minimal default configuration (illustrative; no extra knobs needed):

```yaml
frontends:
  - name: github
    features: [checks, summary-comment]
    # config: {}    # optional, sane defaults
  - name: ndjson-sink
    # config: { file: ".visor-events.ndjson" } # optional
  # - name: slack   # example future frontend
  #   features: [notifications]
```

#### 3.3 Comment Markers — Mini Grammar & Utilities

Markers (regular expressions shown informally):
- Thread header: `<!--\s*visor:thread=(?<json>\{[^]*?\})\s*-->`
- Section start: `<!--\s*visor:section=(?<json>\{[^]*?\})\s*-->`
- Section end: `<!--\s*visor:section-end\s+id=\"(?<id>[^\"]+)\"\s*-->`
- Thread end: `<!--\s*visor:thread-end\s+key=\"(?<key>[^\"]+)\"\s*-->`

Utilities (sketch):

```ts
interface SectionDoc { header: ThreadHeader; sections: Record<string,string>; tail?: string }

function parseSections(body: string): SectionDoc { /* scan markers; collect text blocks by id */ }
function mergeSections(prev: SectionDoc, nextBlocks: Record<string,string>): SectionDoc { /* replace changed */ }
function serialize(doc: SectionDoc): string { /* stitch header + blocks + thread-end */ }
```

Persistence keys in header JSON:
- `key` (threadKey), `runId`, `workflowId`, `headSha`, `revision`, `generatedAt`.

NDJSON sink line shape (for reference):

```json
{ "id":"...", "ts":"2025-11-19T12:34:56Z", "runId":"...", "payload": { "type":"CheckStatusRequested", "checkName":"...", "status":"in_progress" }, "safe": true }
```


### 4. Delivery, Ordering, Idempotency & Failure Policy

Defaults (no extra knobs required):

- Quality of Service: in‑process, at‑least‑once delivery.
- Ordering: FIFO per `checkId` (or `checkName` fallback) and per `runId`.
- Idempotency: All side‑effecting requests MUST include `idempotencyKey` or a stable `checkId`. Adapters must deduplicate.
- Timeouts: `emitAndWait` defaults to 10s; failure triggers a non‑blocking warning for optional sinks and a retry for critical sinks.
- Retries: Exponential backoff with jitter for HTTP 5xx/429; up to 3 attempts. 4xx except 409/412 are not retried.
- Rate limits: Adapters throttle using provider budgets; surface “deferred” state via `CheckStatusRequested` with `queued`.
- Dead‑letter: A global hook `onEventDeliveryFailure(envelope, error)` logs NDJSON entries for forensics.

Critical vs optional adapters:

- Critical (GitHub checks/comments): fail fast after bounded retries → engine surfaces error.
- Optional (metrics, logs): never block engine; best‑effort with warnings.

### 5. Security & Redaction

- Redact tokens/PII by default in envelopes and adapter payloads.
- Provide `safeSummary`/`safeText` fields for public sinks; adapters prefer safe fields when present.
- Sampling for large payloads and bounded annotation batching.

### 6. Event Persistence & Replay

- Optional `EventSink` writes `EventEnvelope` to NDJSON (one line per envelope) with rotation.
- Replay modes:
  - Inspect‑only (no side effects): adapters ignore side‑effecting requests.
  - With‑effects (debug only): adapters re‑issue idempotent requests.
- Envelopes include `causationId`/`correlationId` enabling time‑travel visualization.

### 7. Frontend Contracts (GitHub example)

- Upsert check via `external_id` (prefer) or `(name+head_sha)`.
- Handle secondary rate limits and abuse detection by exponential backoff and budget throttling.
- Batch annotations to provider limits; retry partial failures.
- Error classification: 4xx (caller issue), 5xx/429 (transient).

### 8. Testing Utilities

- `captureEvents(eventBus)` returns in‑memory array of envelopes.
- `expectEvents(events).toContainInOrder([...])` asserts ordered subsequences per `checkId`.
- Use neutral events in tests; adapter unit tests validate mapping and idempotency.

### 9. Migration Strategy (to Full Event‑Driven via Frontends)

Phase 1 — Foundations (no breaking changes)
- Add `EventBus` + `EventEnvelope`.
- Introduce `FrontendsHost` and `Frontend` API; ship a built‑in NDJSON sink frontend.
- Keep legacy DI GitHub path untouched.

Phase 2 — Frontends‑first (opt‑in)
- Implement GitHub frontend (checks + summary comment) using neutral events, grouping, idempotency.
- Add Slack and Metrics frontends as examples.
- Configuration enables frontends mode; when the GitHub frontend is active, it owns checks/comments and the legacy DI is bypassed to avoid double posting.

Phase 3 — Default to frontends
- Make frontends mode the default once stable; legacy DI remains available but off by default.

Phase 4 — Remove legacy (future breaking change)
- After a deprecation window, remove the DI GitHub path and keep frontends as the single integration layer.

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

// After: Event assertion (clear, neutral)
it('should create GitHub check when entering CheckRunning state', async () => {
  const eventBus = new EventBus();
  const events: EventEnvelope[] = [];

  eventBus.onAny(env => events.push(env));

  const runner = new StateMachineRunner(context, undefined, eventBus);
  await runner.run();

  const checkCreateEvent = events.find(
    e => e.payload.type === 'CheckStatusRequested' && e.payload.status === 'in_progress'
  );

  expect(checkCreateEvent).toBeDefined();
  expect(checkCreateEvent?.payload.checkName).toBe('visor-review');
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

## Recommendation: Full Event‑Driven with Frontends

Adopt the event bus and frontends as the primary, pluggable integration layer. Keep the legacy DI GitHub code path in the repository for backward compatibility, but new functionality (GitHub and beyond) should be built as frontends. Roll out by enabling the GitHub frontend alongside the bus, then make it the default once stable.

## Open Questions

Kept intentionally small after adopting defaults above:

1. Should we persist envelopes by default in local dev (NDJSON) and disable in CI, or the reverse?
2. Per‑run adapters vs shared process‑wide adapters: we currently recommend shared with per‑run correlation; confirm for multi‑repo runners.
3. Priority delivery: do we need priority channels for UI feedback vs background telemetry?

## Implementation Checklist

### Phase 1: Foundation
- [x] Implement `EventBus` class with subscription management (`src/event-bus/event-bus.ts`)
- [x] Implement `EventEnvelope` and `IntegrationEvent` types (`src/event-bus/types.ts`)
- [x] Add `eventBus` optional parameter to `StateMachineRunner` (via `EngineContext`)
- [x] Implement `FrontendsHost` with `Frontend` API (`src/frontends/host.ts`)
- [x] Implement `NdjsonSink` frontend (`src/frontends/ndjson-sink.ts`)
- [ ] Add unit tests for `EventBus`

### Phase 2: GitHub Frontend
- [x] Implement `GitHubFrontend` with request handlers (`src/frontends/github-frontend.ts`)
- [x] Wire up adapter in `state-machine-execution-engine.ts`
- [x] Implement comment grouping with section markers
- [x] Implement debounce/coalescing for comment updates
- [x] Implement mutex-based serialization for updates
- [ ] Add feature flag `experimental.eventDrivenGitHub` (skipped - frontends are enabled by default)
- [ ] Add integration tests for dual-mode operation

### Phase 3: Multi-Platform Frontends
- [x] Implement `SlackFrontend` with direct replies (`src/frontends/slack-frontend.ts`)
- [x] Slack reaction management (acknowledgement and completion)
- [x] Mermaid diagram rendering and upload
- [x] Human input prompt handling via prompt-state
- [ ] Implement `MetricsEventAdapter` (example)
- [ ] Document adapter API and patterns

### Phase 4: Migration (Breaking Change)
- [ ] Remove `gitHubChecks` from `EngineContext` (legacy DI still present for backward compatibility)
- [ ] Make `eventBus` required parameter
- [ ] Update all state handlers to emit events
- [ ] Update all tests to new pattern

## References

- [State Machine RFC](./engine-state-machine-plan.md) - Section 5: Toward NASA-style guarantees
- [Debug Visualizer RFC](./debug-visualizer-rfc.md) - Event streaming for time-travel debugging
- [Telemetry Tracing RFC](./telemetry-tracing-rfc.md) - Observability integration

## Conclusion

Move integrations to a fully event‑driven model using neutral events and pluggable frontends. Keep the legacy DI path for compatibility but direct new development to frontends. This gives a clean core, scales to additional platforms (Slack, metrics) without touching the engine, and unlocks robust replay and observability.
