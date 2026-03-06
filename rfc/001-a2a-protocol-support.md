# RFC-001: Agent Interoperability Protocol Support for Visor

**Status:** Draft
**Author:** ProbeLabs
**Created:** 2026-03-06
**Target:** Visor EE

---

## TL;DR

Add a protocol-agnostic agent interoperability layer to Visor, making every Visor
workflow deployable as a discoverable, standards-compliant AI agent. The first
protocol binding is **A2A** (Google's Agent-to-Agent protocol), but the internal
primitives — task registry, state machine, message/artifact types — are designed
to support future protocols (ACP, AAIF, etc.) without schema or type changes.
Simultaneously, allow Visor checks to call external agents as a new provider type.

---

## WHY

### The Problem

Visor workflows today are powerful but isolated. They can only be triggered through
a fixed set of entry points: Slack messages, GitHub events, CLI invocations, webhooks,
and MCP tool calls. Each integration requires custom frontend code. Each new consumer
requires new wiring.

Meanwhile, the AI agent ecosystem is converging on two complementary standards:
- **MCP** for agent-to-tool communication (Visor already supports this)
- **A2A** for agent-to-agent communication (Visor does not support this)

Without A2A, Visor workflows cannot participate in multi-agent systems. An external
orchestrator cannot discover that "ProbeLabs has a code review agent" and delegate
work to it. A compliance agent running on a different platform cannot ask Visor's
security scanner to analyze a PR. Teams cannot compose agents from different vendors
into unified workflows.

### Why Now

1. **A2A hit v0.3** (stable, under Linux Foundation, Apache 2.0) with 50+ partners
   including Google, Salesforce, SAP, LangChain. It's becoming the standard.

2. **Visor is architecturally ready.** The state machine engine, EventBus, frontend
   abstraction, provider registry, and database layer all exist. A2A maps cleanly
   onto these existing primitives. The gap is protocol, not architecture.

3. **MCP alone is insufficient.** MCP treats Visor as a tool (stateless function call).
   A2A treats Visor as an agent (stateful, autonomous, multi-turn). For complex
   workflows like the engineer or code-explorer, the agent model is the right
   abstraction.

4. **Network effects.** Every Visor workflow that becomes an A2A agent is
   automatically callable by every A2A client in the ecosystem. Every external
   A2A agent becomes usable inside Visor workflows. The value compounds.

### Why This Approach

The design follows three principles:

- **Reuse over rebuild.** The state machine engine, EventBus, provider registry,
  and SQLite database layer already solve the hard problems. A2A support is a new
  frontend + a new provider, not a rewrite.

- **Agent Card is manual, not generated.** Internal skill routing (intents.yaml,
  skills.yaml) serves the classifier. External A2A skills serve discovery. Different
  audiences, different granularity, different lifecycle. The Agent Card is a product
  artifact, hand-authored like an API contract.

- **Protocol-agnostic foundation.** Internal types (`AgentTask`, `AgentMessage`,
  `AgentPart`, `AgentArtifact`), database tables (`agent_tasks`), and config keys
  (`agent_protocol:`) use generic naming. A2A is the first protocol binding, but
  nothing in the task registry, state machine, or core types is A2A-specific. If
  ACP (IBM), AAIF, or another protocol emerges, we add a new frontend binding
  without changing the database schema, core types, or internal plumbing.

- **Async-first, sync-compatible.** A2A defaults to async (return task ID immediately,
  notify on completion). Visor currently runs synchronously. We add a task registry
  and polling queue on top of the existing database layer, then existing frontends
  (Slack, GitHub) become A2A clients internally.

---

## BACKGROUND

### A2A Protocol Summary (v0.3)

A2A (Agent-to-Agent) is an open protocol under the Linux Foundation that enables
opaque AI agents to discover and collaborate. Key primitives:

| Concept | Description |
|---------|-------------|
| **Agent Card** | JSON at `/.well-known/agent-card.json` declaring name, skills, endpoints, auth |
| **Task** | Stateful work unit: `SUBMITTED` -> `WORKING` -> `INPUT_REQUIRED` -> `COMPLETED`/`FAILED` |
| **Message** | Communication turn (role: `user`/`agent`) containing Parts. Has `message_id`, optional `context_id`, optional `task_id`, `extensions`, and `reference_task_ids` |
| **Part** | Content unit: `text` / `raw` (bytes) / `url` / `data` (structured JSON), with `media_type` and `filename` |
| **Artifact** | Task output with `artifact_id`, `name`, `description`, Parts, and `metadata` |
| **Context** | Groups related tasks via `context_id` (like a session) |

Communication uses HTTP REST endpoints (not raw JSON-RPC). The A2A proto defines
these HTTP bindings:

| HTTP Method | Path | A2A Operation |
|-------------|------|---------------|
| `POST` | `/message:send` | SendMessage |
| `POST` | `/message:stream` | SendStreamingMessage (SSE response) |
| `GET` | `/tasks/{id}` | GetTask |
| `GET` | `/tasks` | ListTasks |
| `POST` | `/tasks/{id}:cancel` | CancelTask |
| `GET` | `/tasks/{id}:subscribe` | SubscribeToTask (SSE response) |
| `POST` | `/tasks/{task_id}/pushNotificationConfigs` | CreatePushNotificationConfig |
| `GET` | `/tasks/{task_id}/pushNotificationConfigs/{id}` | GetPushNotificationConfig |
| `GET` | `/tasks/{task_id}/pushNotificationConfigs` | ListPushNotificationConfigs |
| `DELETE` | `/tasks/{task_id}/pushNotificationConfigs/{id}` | DeletePushNotificationConfig |
| `GET` | `/extendedAgentCard` | GetExtendedAgentCard |

All routes optionally support a `/{tenant}/` prefix for multi-tenancy.

### Task State Machine

A2A defines a strict state machine for tasks:

```
                 ┌──────────────────────────────────────────────┐
                 │                                              │
                 v                                              │
SUBMITTED ──> WORKING ──> COMPLETED (terminal)                  │
    │            │                                              │
    │            ├──> FAILED (terminal)                         │
    │            │                                              │
    │            ├──> CANCELED (terminal)                       │
    │            │                                              │
    │            ├──> INPUT_REQUIRED ──> WORKING (resumed)      │
    │            │                       │                      │
    │            │                       ├──> CANCELED           │
    │            │                       └──> FAILED             │
    │            │                                              │
    │            └──> AUTH_REQUIRED ──> WORKING (resumed) ──────┘
    │                                   │
    │                                   ├──> CANCELED
    │                                   └──> FAILED
    │
    ├──> CANCELED (terminal)
    └──> REJECTED (terminal)
```

Valid transitions:
- `SUBMITTED` -> `WORKING`, `CANCELED`, `REJECTED`
- `WORKING` -> `COMPLETED`, `FAILED`, `CANCELED`, `INPUT_REQUIRED`, `AUTH_REQUIRED`
- `INPUT_REQUIRED` -> `WORKING`, `CANCELED`, `FAILED`
- `AUTH_REQUIRED` -> `WORKING`, `CANCELED`, `FAILED`
- Terminal states (`COMPLETED`, `FAILED`, `CANCELED`, `REJECTED`) -> no further transitions

### SendMessage Response

The `SendMessageResponse` is a **oneof**: it returns either a `Task` object OR a
direct `Message`. Simple interactions may return a Message without creating a task.
Long-running work returns a Task with status.

### A2A vs MCP

| | MCP | A2A |
|--|-----|-----|
| Model | Agent -> Tool (function call) | Agent -> Agent (task delegation) |
| State | Stateless | Stateful tasks with lifecycle |
| Input | Typed JSON schema | Natural language + structured data |
| Output | Typed return value | Artifacts (multi-part, streaming) |
| Discovery | Tool listing | Agent Card with skills |

They compose: an agent uses MCP internally for tools, A2A externally for collaboration.
Visor already speaks MCP. This RFC adds A2A.

### Visor Architecture Mapping

| A2A Concept | Visor Equivalent | Status |
|-------------|-----------------|--------|
| Agent Card | `SERVER_INFO` in mcp-server.ts | Partial (no skills, no discovery endpoint) |
| Task | Engine RunState + check lifecycle | Exists but in-memory, not persistent |
| Task states | Check states (running/succeeded/failed) | No protocol-level exposure |
| Messages | Slack messages / GitHub comments | Frontend-specific, not standardized |
| Artifacts | Journal entries + check outputs | In-memory, not queryable after run |
| Context | Slack thread / session registry | Not protocol-level |
| Push notifications | Webhook server (outbound http) | Not A2A-formatted |
| Streaming | SSE in MCP provider | Not A2A TaskStatusUpdateEvent format |
| Task queue | Scheduler with SQLite + polling | Exists for schedules, not for ad-hoc tasks |
| Database | SQLite (better-sqlite3) / Knex (enterprise) | Ready to extend |
| Frontend abstraction | FrontendsHost + EventBus | Ready for new A2A frontend |
| Provider registry | CheckProviderRegistry (15 providers) | Ready for new A2A provider |

### A2A Features We Are Explicitly Deferring

- **gRPC protocol binding** — JSON-RPC over HTTP is sufficient for v1
- **Multi-tenancy** — `/{tenant}/` prefix routes are not implemented
- **Extended Agent Card** — post-auth cards with additional skills
- **Agent Card signing** — JWS signatures on the Agent Card
- **Protocol extensions** — the `extensions` field on Messages, Artifacts, and AgentCapabilities
- **`reference_task_ids`** — cross-task references in Messages
- **OAuth2 / OIDC auth** — start with bearer token only (server and client)

---

## DETAILED DESIGN

### Architecture Overview

```
External A2A Clients          Slack            GitHub           CLI
        |                       |                |               |
        v                       v                v               v
┌──────────────┐   ┌────────────────┐  ┌────────────────┐  ┌─────────┐
│ A2A Frontend │   │ Slack Frontend │  │ GitHub Frontend│  │ CLI     │
│   (new)      │   │  (existing)    │  │  (existing)    │  │(existing│
└──────┬───────┘   └───────┬────────┘  └───────┬────────┘  └────┬────┘
       │                   │                   │               │
       │    ┌──────────────┴───────────────────┴───────────────┘
       │    │
       │    v
       │  EventBus (existing)
       │    ^
       │    │ emits CheckCompleted, CheckErrored,
       │    │ HumanInputRequested, StateTransition
       │    │
       v    │
┌──────────────┐       ┌──────────────────────────────────┐
│ Task Registry│<──────>│  State Machine Engine (existing)  │
│   (new)      │       │  - Receives tasks from queue      │
│  SQLite DB   │       │  - Emits events via EventBus      │
└──────┬───────┘       │  - Runs checks via providers      │
       │               └──────────────┬───────────────────┘
       │                              │
       v                              v
┌──────────────┐       ┌──────────────────────────────────┐
│ Task Queue   │       │  Provider Registry (existing)     │
│ (new)        │       │                                   │
│ polls DB,    │       │  AI │ MCP │ Command │ HTTP │ ...  │
│ claims tasks,│       │                                   │
│ feeds engine │       │  + A2A Provider (new)              │
└──────────────┘       │    calls external A2A agents      │
                       └──────────────────────────────────┘
```

Data flow for an async A2A request:
1. A2A Frontend receives `POST /message:send`
2. Creates Task in Task Registry (state: `SUBMITTED`), returns Task immediately
3. Task Queue polls DB, claims task, sets state: `WORKING`
4. Task Queue calls State Machine Engine with workflow inputs
5. Engine runs checks, emits events via EventBus
6. A2A Frontend listens to EventBus, updates Task Registry
7. Client calls `GET /tasks/{id}` to check status
8. When done, Task has `COMPLETED` state + artifacts

Data flow for a blocking A2A request:
1. A2A Frontend receives `POST /message:send` with `blocking: true`
2. Creates Task in Task Registry (state: `SUBMITTED`)
3. A2A Frontend calls engine directly (no queue), sets state: `WORKING`
4. Engine runs to completion
5. A2A Frontend updates Task with artifacts, sets state: `COMPLETED`
6. Returns full Task in response

### Component Breakdown

The implementation has 5 components, each a milestone:

1. **Task Registry** — persistent task storage in SQLite
2. **A2A Frontend** — HTTP server + Agent Card endpoint
3. **A2A Provider** — call external A2A agents from checks
4. **Async Task Queue** — decouple request from execution
5. **Streaming & Push Notifications** — real-time task updates

### CLI Entrypoint

The agent protocol server starts via a new CLI mode:

```bash
# Start agent protocol server (loads config, starts engine + A2A frontend)
visor serve --agent-protocol --config probelabs-assistant.yaml

# Or combined with Slack (both frontends active)
visor --slack --agent-protocol --config probelabs-assistant.yaml

# Port override
visor serve --agent-protocol --agent-protocol-port 9000 --config probelabs-assistant.yaml
```

The `--agent-protocol` flag enables the agent protocol frontend in the
FrontendsHost, alongside any other active frontends (Slack, GitHub, etc).
The specific protocol binding (A2A) is determined by `agent_protocol.protocol`
in the config file.

---

## MILESTONES

### Milestone 1: Task Registry

**Goal:** Persistent task storage that survives process restarts and supports
querying by ID, context, and state.

**Why this first:** Everything else depends on having a place to store and query
tasks. The task registry is the foundation for async execution, the A2A frontend,
and the A2A provider.

**What it is:** A new SQLite table (reusing the existing `better-sqlite3` database
layer from scheduler) that stores A2A-compatible task records.

#### Database Location

Reuse the existing scheduler database file. The scheduler already uses
`better-sqlite3` with WAL mode. The `agent_tasks` table lives in the same DB, opened
via the same connection factory in `scheduler/store/sqlite-store.ts`.

For enterprise (Knex), the table is added via a migration in
`enterprise/agent-protocol/knex-task-store.ts` following the same pattern as
`enterprise/scheduler/knex-store.ts`.

#### Schema

```sql
CREATE TABLE IF NOT EXISTS agent_tasks (
  -- Identity
  id TEXT PRIMARY KEY,                    -- UUID, server-generated
  context_id TEXT NOT NULL,               -- Groups related tasks (session/user)
  state TEXT NOT NULL DEFAULT 'submitted',
    -- Valid values: submitted, working, completed, failed, canceled, rejected,
    -- input_required, auth_required

  -- Timestamps
  created_at TEXT NOT NULL,               -- ISO 8601
  updated_at TEXT NOT NULL,               -- ISO 8601

  -- Request (immutable after creation)
  request_message TEXT NOT NULL,          -- JSON: the SendMessageRequest.message
  request_config TEXT,                    -- JSON: SendMessageConfiguration
                                          --   (blocking, accepted_output_modes, history_length)
  request_metadata TEXT,                  -- JSON: SendMessageRequest.metadata (arbitrary k/v)

  -- Response (updated during execution)
  status_message TEXT,                    -- JSON: current TaskStatus.message (from agent)
  artifacts TEXT DEFAULT '[]',            -- JSON array of Artifact objects
  history TEXT DEFAULT '[]',              -- JSON array of Message objects (conversation turns)

  -- Execution tracking
  workflow_id TEXT,                       -- Which Visor workflow is handling this task
  run_id TEXT,                            -- Visor engine run ID (correlates to RunState)

  -- Queue management (used by Milestone 4)
  claimed_by TEXT,                        -- Worker ID that claimed this task
  claimed_at TEXT,                        -- ISO 8601: when claimed (for stale detection)

  -- Cleanup
  expires_at TEXT                         -- ISO 8601: when to garbage-collect (nullable = never)
);

-- Indexes for common query patterns
CREATE INDEX IF NOT EXISTS idx_agent_tasks_context ON agent_tasks(context_id);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_state ON agent_tasks(state);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_updated ON agent_tasks(updated_at);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_claim ON agent_tasks(state, claimed_by, claimed_at);
CREATE INDEX IF NOT EXISTS idx_agent_tasks_expires ON agent_tasks(expires_at);
```

#### State Transition Enforcement

The `TaskStore` enforces valid state transitions per the A2A spec:

```typescript
const VALID_TRANSITIONS: Record<TaskState, TaskState[]> = {
  submitted:      ['working', 'canceled', 'rejected'],
  working:        ['completed', 'failed', 'canceled', 'input_required', 'auth_required'],
  input_required: ['working', 'canceled', 'failed'],
  auth_required:  ['working', 'canceled', 'failed'],
  // Terminal states: no outgoing transitions
  completed:      [],
  failed:         [],
  canceled:       [],
  rejected:       [],
};

function assertValidTransition(from: TaskState, to: TaskState): void {
  if (!VALID_TRANSITIONS[from].includes(to)) {
    throw new InvalidStateTransitionError(from, to);
  }
}
```

#### TypeScript Types

New file: `src/agent-protocol/types.ts`

```typescript
// Protocol-agnostic task state (maps to A2A TaskState, ACP AgentStatus, etc.)
type TaskState =
  | 'submitted'
  | 'working'
  | 'completed'
  | 'failed'
  | 'canceled'
  | 'rejected'
  | 'input_required'
  | 'auth_required';

// Protocol-agnostic content part (maps to A2A Part, etc.)
interface AgentPart {
  text?: string;
  raw?: string;         // base64-encoded bytes
  url?: string;
  data?: unknown;       // arbitrary JSON value
  metadata?: Record<string, unknown>;
  filename?: string;
  media_type?: string;
}

// Protocol-agnostic message (maps to A2A Message, etc.)
interface AgentMessage {
  message_id: string;   // client-generated UUID
  context_id?: string;
  task_id?: string;
  role: 'user' | 'agent';
  parts: AgentPart[];
  metadata?: Record<string, unknown>;
  extensions?: string[];
  reference_task_ids?: string[];
}

// Protocol-agnostic artifact (maps to A2A Artifact, etc.)
interface AgentArtifact {
  artifact_id: string;
  name?: string;
  description?: string;
  parts: AgentPart[];
  metadata?: Record<string, unknown>;
}

// Protocol-agnostic task (maps to A2A Task, etc.)
interface AgentTask {
  id: string;
  context_id: string;
  status: {
    state: TaskState;
    message?: AgentMessage;
    timestamp: string;    // ISO 8601
  };
  artifacts: AgentArtifact[];
  history: AgentMessage[];
  metadata?: Record<string, unknown>;
}

// Protocol-agnostic send configuration (maps to A2A SendMessageConfiguration)
interface AgentSendMessageConfig {
  accepted_output_modes?: string[];
  task_push_notification_config?: AgentPushNotificationConfig;
  history_length?: number;
  blocking?: boolean;
}

// Protocol-agnostic send request (maps to A2A SendMessageRequest)
interface AgentSendMessageRequest {
  message: AgentMessage;
  configuration?: AgentSendMessageConfig;
  metadata?: Record<string, unknown>;
}

// Protocol-agnostic response: Task OR Message
type AgentSendMessageResponse =
  | { task: AgentTask }
  | { message: AgentMessage };
```

#### TaskStore Interface

```typescript
interface TaskStore {
  // --- CRUD ---
  createTask(params: {
    contextId: string;           // Required. Server generates if client omits.
    requestMessage: AgentMessage;
    requestConfig?: AgentSendMessageConfig;
    requestMetadata?: Record<string, unknown>;
    workflowId?: string;
    expiresAt?: string;          // ISO 8601, null = no expiry
  }): AgentTask;

  getTask(taskId: string): AgentTask | null;

  listTasks(filter: {
    contextId?: string;
    state?: TaskState[];
    limit?: number;              // Default: 50, max: 200
    offset?: number;             // For pagination
  }): { tasks: AgentTask[]; total: number };

  // --- State mutations ---
  updateTaskState(
    taskId: string,
    newState: TaskState,
    statusMessage?: AgentMessage,  // Optional agent message explaining the state
  ): void;                       // Throws InvalidStateTransitionError if invalid

  addArtifact(taskId: string, artifact: AgentArtifact): void;

  appendHistory(taskId: string, message: AgentMessage): void;

  setRunId(taskId: string, runId: string): void;

  // --- Queue operations (Milestone 4) ---
  claimNextSubmitted(workerId: string): AgentTask | null;
  releaseClaim(taskId: string): void;

  // --- Cleanup ---
  deleteExpiredTasks(): number;  // Returns count deleted
  deleteTask(taskId: string): void;
}
```

#### Context ID Management

Per the A2A spec:
- Client MAY provide `context_id` in the Message. If provided, the task is
  associated with that context.
- If client provides `task_id` but no `context_id`, server infers context from
  the existing task.
- If client provides neither, server generates a new `context_id` (UUID).
- If client provides both, they must match (the task's context_id must equal the
  provided one). Server returns error if they don't match.

Implementation in `createTask()`:
```typescript
function resolveContextId(message: AgentMessage): string {
  if (message.context_id && message.task_id) {
    const existingTask = this.getTask(message.task_id);
    if (existingTask && existingTask.context_id !== message.context_id) {
      throw new ContextMismatchError(message.context_id, existingTask.context_id);
    }
    return message.context_id;
  }
  if (message.task_id) {
    const existingTask = this.getTask(message.task_id);
    return existingTask?.context_id ?? crypto.randomUUID();
  }
  return message.context_id ?? crypto.randomUUID();
}
```

#### Task Cleanup

A background sweep runs periodically (default: every hour) to delete expired tasks:

```typescript
// Configurable via agent_protocol.task_ttl (default: 7 days)
// Tasks with expires_at < now() are deleted
// Tasks without expires_at are never auto-deleted
```

The `deleteExpiredTasks()` method also cascades to `agent_push_configs` (Milestone 5).

#### Implementation Files

- `src/agent-protocol/types.ts` — All A2A wire format types + TaskState enum
- `src/agent-protocol/task-store.ts` — SQLite implementation of TaskStore
- `src/agent-protocol/state-transitions.ts` — Valid transition map + enforcement
- `enterprise/agent-protocol/knex-task-store.ts` — Knex variant for PostgreSQL/MySQL
- `tests/unit/agent-protocol/task-store.test.ts` — Unit tests

#### Tests

- Create task, verify all fields populated (id, context_id, timestamps)
- Get task by ID (found and not-found cases)
- List tasks: by context, by state, pagination (limit + offset + total)
- State transitions: every valid transition succeeds
- State transitions: every invalid transition throws `InvalidStateTransitionError`
- Add artifact, verify appended to task
- Append history, verify ordered
- Context ID resolution: all 4 cases (both, task_id only, context_id only, neither)
- Context mismatch throws error
- Claim and release (for Milestone 4)
- Expired task cleanup
- Concurrent create (unique ID guarantee)

#### Definition of Done

- [ ] Protocol-agnostic types in `src/agent-protocol/types.ts` (AgentTask, AgentMessage, etc.)
- [ ] `TaskStore` interface with all CRUD + queue + cleanup methods
- [ ] SQLite implementation with auto-creating schema
- [ ] State transition enforcement with valid transition map
- [ ] Context ID resolution per A2A spec rules
- [ ] Task TTL and cleanup sweep
- [ ] Unit tests: all CRUD, state transitions, context resolution, cleanup
- [ ] Pagination in listTasks (limit, offset, total count)

---

### Milestone 2: A2A Frontend (Server-Side)

**Goal:** Visor serves as an A2A-compliant agent that external clients can discover
and send tasks to.

**Why this second:** With the task registry in place, we can accept tasks and store
them. This milestone makes Visor discoverable and callable via the standard A2A
protocol.

**What it is:** A new frontend (like `slack-frontend.ts` and `github-frontend.ts`)
that serves the Agent Card at the well-known URL and handles A2A HTTP endpoints.

#### Agent Card

Served at `GET /.well-known/agent-card.json`. Loaded from a file on disk (not
auto-generated). The file path is configured via `agent_protocol.agent_card`.

The Agent Card URL field (`supported_interfaces[].url`) must match the actual
server address. This is configured explicitly:

```yaml
agent_protocol:
  enabled: true
  protocol: a2a                 # Protocol binding (currently only "a2a")
  agent_card: "agent-card.json"
  public_url: "https://assistant.probelabs.com"  # Used in Agent Card URL field
  port: 9000
  host: "0.0.0.0"
```

At startup, the frontend reads the Agent Card file and **patches**
`supported_interfaces[].url` with the configured `public_url` + path. This avoids
hardcoding URLs in the JSON file:

```typescript
agentCard.supported_interfaces[0].url = `${config.publicUrl}/a2a`;
```

If `public_url` is not set, defaults to `http://{host}:{port}`.

Example `agent-card.json`:

```json
{
  "name": "ProbeLabs Assistant",
  "description": "AI assistant for code exploration, engineering, and GitHub operations across ProbeLabs projects.",
  "version": "1.0.0",
  "provider": {
    "organization": "ProbeLabs",
    "url": "https://probelabs.com"
  },
  "supported_interfaces": [
    {
      "url": "__PATCHED_AT_STARTUP__",
      "protocol_binding": "JSONRPC",
      "protocol_version": "0.3"
    }
  ],
  "capabilities": {
    "streaming": false,
    "push_notifications": false
  },
  "default_input_modes": ["text/plain", "application/json"],
  "default_output_modes": ["text/plain", "text/markdown", "application/json"],
  "security_schemes": {
    "bearer": {
      "http_auth_security_scheme": {
        "scheme": "Bearer",
        "description": "Bearer token authentication"
      }
    }
  },
  "security_requirements": [
    { "schemes": { "bearer": { "list": [] } } }
  ],
  "skills": [
    {
      "id": "code-exploration",
      "name": "Code Exploration",
      "description": "Explore and answer questions about any ProbeLabs project codebase.",
      "tags": ["code", "search", "architecture", "documentation"],
      "examples": [
        "How does Probe's AST parser work?",
        "Where is the Visor check execution engine implemented?"
      ]
    },
    {
      "id": "engineering",
      "name": "Code Engineering",
      "description": "Implement features, fix bugs, and create PRs across ProbeLabs repositories.",
      "tags": ["engineering", "pr", "implementation", "bugfix"],
      "examples": [
        "Add file type exclusion filter to Probe",
        "Fix the failing test in Visor's check engine"
      ]
    },
    {
      "id": "github-ops",
      "name": "GitHub Operations",
      "description": "Browse PRs, issues, releases, debug CI/CD across all ProbeLabs repos.",
      "tags": ["github", "pr", "issues", "ci", "actions"],
      "examples": [
        "What PRs are open on probe?",
        "Why is CI failing on visor#234?"
      ]
    }
  ]
}
```

Note: `capabilities.streaming` and `capabilities.push_notifications` start as
`false`. They are set to `true` only when Milestone 5 is completed.

#### Full Configuration

```yaml
agent_protocol:
  enabled: true
  protocol: a2a                        # Protocol binding (currently only "a2a")
  agent_card: "agent-card.json"        # Path to Agent Card file (required for A2A)
  public_url: "https://assistant.probelabs.com"  # Public-facing URL for Agent Card
  port: 9000                           # Agent protocol server port
  host: "0.0.0.0"                      # Bind address
  tls:                                 # Optional TLS
    cert: /path/to/cert.pem
    key: /path/to/key.pem
  auth:                                # Server-side auth validation
    type: bearer                       # bearer | api_key | none
    token_env: "AGENT_AUTH_TOKEN"      # Env var holding the expected token
  default_workflow: "assistant"        # Workflow to run for incoming tasks
  skill_routing:                       # Optional: route skills to specific workflows
    engineering: "engineer"            # skill_id -> workflow name
    # All other skills -> default_workflow
  task_ttl: "7d"                       # Auto-delete tasks older than this
  queue:                               # Queue config (used by Milestone 4)
    poll_interval: 1000                # ms
    max_concurrent: 5
    stale_claim_timeout: 300000        # ms
```

#### HTTP Endpoints

The A2A frontend creates its own HTTP server (separate from the webhook server)
on the configured port. Routes:

| Route | Method | Handler | Notes |
|-------|--------|---------|-------|
| `/.well-known/agent-card.json` | GET | Serve Agent Card | Public, no auth |
| `/message:send` | POST | HandleSendMessage | Auth required |
| `/message:stream` | POST | HandleSendStreamingMessage | Milestone 5 |
| `/tasks/{id}` | GET | HandleGetTask | Auth required |
| `/tasks` | GET | HandleListTasks | Auth required |
| `/tasks/{id}:cancel` | POST | HandleCancelTask | Auth required |
| `/tasks/{id}:subscribe` | GET | HandleSubscribeToTask | Milestone 5 |
| `/tasks/{id}/pushNotificationConfigs` | POST | HandleCreatePushConfig | Milestone 5 |
| `/tasks/{id}/pushNotificationConfigs` | GET | HandleListPushConfigs | Milestone 5 |
| `/tasks/{id}/pushNotificationConfigs/{cid}` | GET | HandleGetPushConfig | Milestone 5 |
| `/tasks/{id}/pushNotificationConfigs/{cid}` | DELETE | HandleDeletePushConfig | Milestone 5 |

Routes marked "Milestone 5" return `501 Not Implemented` (or A2A
`UnsupportedOperationError`) until that milestone is complete.

#### Authentication

Request validation follows the Agent Card's `security_schemes`:

```typescript
function validateAuth(req: IncomingMessage, config: AgentProtocolConfig): boolean {
  if (config.auth.type === 'none') return true;
  if (config.auth.type === 'bearer') {
    const header = req.headers['authorization'];
    if (!header?.startsWith('Bearer ')) return false;
    const token = header.slice(7);
    const expected = process.env[config.auth.tokenEnv];
    return timingSafeEqual(token, expected);
  }
  if (config.auth.type === 'api_key') {
    const key = req.headers[config.auth.headerName] ?? req.url?.searchParams.get(config.auth.paramName);
    const expected = process.env[config.auth.keyEnv];
    return timingSafeEqual(key, expected);
  }
  return false;
}
```

Uses `crypto.timingSafeEqual` to prevent timing attacks.

#### Error Responses

A2A error format (JSON-RPC style):

```json
{
  "error": {
    "code": -32001,
    "message": "Task not found",
    "data": { "task_id": "abc-123" }
  }
}
```

Standard error codes:
| Code | Name | When |
|------|------|------|
| -32700 | ParseError | Malformed JSON body |
| -32600 | InvalidRequest | Missing required fields |
| -32601 | MethodNotFound | Unknown route |
| -32001 | TaskNotFound | GET/CANCEL for non-existent task |
| -32002 | UnsupportedOperation | Streaming/push when not enabled |
| -32003 | InvalidStateTransition | e.g., canceling a completed task |
| 401 | Unauthorized | Invalid/missing auth credentials |

#### HandleSendMessage (the core handler)

```typescript
async function handleSendMessage(
  req: AgentSendMessageRequest,
  config: AgentProtocolConfig,
  taskStore: TaskStore,
  engine: StateMachineExecutionEngine,
): Promise<AgentSendMessageResponse> {

  // 1. Validate request
  if (!req.message?.parts?.length) {
    throw new InvalidRequestError('Message must contain at least one part');
  }

  // 2. Check if this is a follow-up to an existing task
  const existingTaskId = req.message.task_id;
  if (existingTaskId) {
    return handleFollowUpMessage(existingTaskId, req, taskStore, engine);
  }

  // 3. Resolve context
  const contextId = req.message.context_id ?? crypto.randomUUID();

  // 4. Determine target workflow via skill routing
  const workflowId = resolveWorkflow(req, config);

  // 5. Create task
  const task = taskStore.createTask({
    contextId,
    requestMessage: req.message,
    requestConfig: req.configuration,
    requestMetadata: req.metadata,
    workflowId,
  });

  // 6. Append the user message to history
  taskStore.appendHistory(task.id, req.message);

  // 7. Execute (blocking or async)
  const blocking = req.configuration?.blocking ?? false;

  if (blocking) {
    // Execute synchronously, wait for result
    await executeTaskDirectly(task, taskStore, engine);
    const finalTask = taskStore.getTask(task.id)!;

    // Respect history_length: trim history in response
    const historyLength = req.configuration?.history_length;
    if (historyLength !== undefined) {
      finalTask.history = finalTask.history.slice(-historyLength);
    }

    return { task: finalTask };
  } else {
    // Return immediately, queue picks it up (Milestone 4)
    // Before Milestone 4: execute synchronously anyway, but return task ID first
    // After Milestone 4: task stays SUBMITTED, queue claims it
    return { task: taskStore.getTask(task.id)! };
  }
}
```

#### Follow-Up Messages (Multi-Turn)

When a client sends a message with `task_id` set, it's continuing an existing task:

```typescript
async function handleFollowUpMessage(
  taskId: string,
  req: AgentSendMessageRequest,
  taskStore: TaskStore,
  engine: StateMachineExecutionEngine,
): Promise<AgentSendMessageResponse> {

  const task = taskStore.getTask(taskId);
  if (!task) throw new TaskNotFoundError(taskId);

  // Only INPUT_REQUIRED and AUTH_REQUIRED tasks accept follow-up messages
  if (task.status.state !== 'input_required' && task.status.state !== 'auth_required') {
    throw new InvalidStateTransitionError(
      task.status.state, 'working',
      'Task is not awaiting input'
    );
  }

  // Validate context match
  if (req.message.context_id && req.message.context_id !== task.context_id) {
    throw new ContextMismatchError(req.message.context_id, task.context_id);
  }

  // Append follow-up to history
  taskStore.appendHistory(taskId, req.message);

  // Transition to WORKING
  taskStore.updateTaskState(taskId, 'working');

  // Resume execution
  // The engine needs to receive this follow-up input. This is handled by
  // injecting the message into the HumanInput resolution mechanism:
  //   1. The original workflow is paused at a HumanInputRequested check
  //   2. The follow-up message is written to the pending input store
  //   3. The engine's HumanInputCheckProvider resolves with the new input
  //   4. Execution continues
  //
  // Implementation: A2AFrontend publishes a 'HumanInputReceived' event on
  // the EventBus with { taskId, checkId, message }. The HumanInputCheckProvider
  // subscribes to this event and resolves its pending promise.
  await resumeTaskExecution(taskId, req.message, taskStore, engine);

  const blocking = req.configuration?.blocking ?? false;
  if (blocking) {
    // Wait for next terminal or interrupted state
    const finalTask = await waitForTaskSettled(taskId, taskStore);
    return { task: finalTask };
  }

  return { task: taskStore.getTask(taskId)! };
}
```

**Critical design decision: How engine pausing works.**

When the engine hits a `human-input` check during an A2A task:

1. `HumanInputCheckProvider.execute()` returns a Promise that doesn't resolve immediately
2. The A2A frontend receives `HumanInputRequested` event via EventBus
3. Frontend updates task state to `INPUT_REQUIRED` with the prompt
4. The engine's check runner is suspended (Promise pending)
5. When follow-up arrives, frontend publishes `HumanInputReceived` on EventBus
6. `HumanInputCheckProvider` resolves its Promise with the input text
7. Engine continues executing remaining checks

This maps to how the existing Slack frontend handles `HumanInputRequested`:
Slack posts a message and waits for a reply. A2A does the same but via protocol.

#### Skill Routing

The `skill_routing` config maps A2A skill IDs to Visor workflows. When a message
arrives, the frontend determines the workflow:

```typescript
function resolveWorkflow(req: AgentSendMessageRequest, config: AgentProtocolConfig): string {
  // If no skill routing configured, use default
  if (!config.skillRouting || Object.keys(config.skillRouting).length === 0) {
    return config.defaultWorkflow;
  }

  // Option A: Client provides a hint via metadata
  const requestedSkill = req.metadata?.skill_id as string | undefined;
  if (requestedSkill && config.skillRouting[requestedSkill]) {
    return config.skillRouting[requestedSkill];
  }

  // Option B: Use default workflow (which has its own internal intent routing)
  // The assistant workflow already classifies intents internally, so in most
  // cases we route everything to the default workflow and let it figure out
  // the right internal skill.
  return config.defaultWorkflow;
}
```

**Key insight:** Skill routing at the A2A level is coarse. The assistant workflow
already has its own intent router with fine-grained classification. For most
deployments, all messages go to `default_workflow: "assistant"` and the assistant's
internal `intents.yaml` + `skills.yaml` handles routing. The `skill_routing` config
exists for cases where you want to bypass the assistant and call a specific workflow
directly (e.g., `engineering` -> `engineer` workflow).

#### Message-to-Workflow Translation

The A2A `Message` (with Parts) needs to become workflow input:

```typescript
function messageToWorkflowInput(
  message: AgentMessage,
  task: AgentTask,
  config: AgentProtocolConfig,
): Record<string, unknown> {
  // Extract text parts
  const textContent = message.parts
    .filter(p => p.text != null)
    .map(p => p.text)
    .join('\n');

  // Extract structured data parts
  const dataParts = message.parts.filter(p => p.data != null);
  const structuredData = dataParts.length === 1
    ? dataParts[0].data
    : dataParts.length > 1
      ? dataParts.map(p => p.data)
      : undefined;

  // Extract file parts
  const fileParts = message.parts.filter(p => p.url != null || p.raw != null);

  return {
    // Standard workflow inputs
    question: textContent,           // For assistant workflow (chat)
    task: textContent,               // For engineer workflow
    data: structuredData,            // Structured input if provided
    files: fileParts.length > 0 ? fileParts : undefined,

    // Agent protocol context (available in Liquid templates as inputs._agent)
    _agent: {
      task_id: task.id,
      context_id: task.context_id,
      message_id: message.message_id,
      metadata: message.metadata,
      accepted_output_modes: task.status.state === 'submitted'
        ? (config as any)?.requestConfig?.accepted_output_modes
        : undefined,
    },
  };
}
```

#### Workflow-Output-to-Artifact Translation

When the workflow completes, its output becomes A2A Artifacts:

```typescript
function resultToArtifacts(result: ExecutionResult): AgentArtifact[] {
  const artifacts: AgentArtifact[] = [];

  // The engine returns an AnalysisResult with check results
  // Each check that produced a meaningful output becomes an artifact

  for (const [checkId, checkResult] of Object.entries(result.checkResults ?? {})) {
    if (!checkResult || checkResult.status === 'skipped') continue;

    const parts: AgentPart[] = [];

    // Text output (most common: AI response, command stdout)
    if (typeof checkResult.output === 'string') {
      parts.push({
        text: checkResult.output,
        media_type: 'text/markdown',
      });
    }

    // Structured output (JSON data, issue lists)
    if (typeof checkResult.output === 'object' && checkResult.output !== null) {
      // If it has a 'text' field, extract as text part
      if ('text' in checkResult.output && typeof checkResult.output.text === 'string') {
        parts.push({
          text: checkResult.output.text,
          media_type: 'text/markdown',
        });
      }

      // Always include the full structured output as data part
      parts.push({
        data: checkResult.output,
        media_type: 'application/json',
      });
    }

    // Issues found (code review results)
    if (checkResult.issues?.length > 0) {
      parts.push({
        data: checkResult.issues,
        media_type: 'application/json',
      });
    }

    if (parts.length > 0) {
      artifacts.push({
        artifact_id: crypto.randomUUID(),
        name: checkId,
        description: `Output from check: ${checkId}`,
        parts,
      });
    }
  }

  // If no individual check artifacts, create one summary artifact
  if (artifacts.length === 0 && result.summary) {
    artifacts.push({
      artifact_id: crypto.randomUUID(),
      name: 'summary',
      description: 'Workflow execution summary',
      parts: [{ text: result.summary, media_type: 'text/markdown' }],
    });
  }

  return artifacts;
}
```

#### Respecting `accepted_output_modes`

If the client sends `accepted_output_modes: ["text/plain"]`, the agent should only
return text parts (no JSON data parts). The `resultToArtifacts` function filters:

```typescript
if (config.accepted_output_modes?.length) {
  for (const artifact of artifacts) {
    artifact.parts = artifact.parts.filter(p =>
      config.accepted_output_modes!.some(mode =>
        (p.media_type ?? 'text/plain').startsWith(mode)
      )
    );
  }
  // Remove empty artifacts
  return artifacts.filter(a => a.parts.length > 0);
}
```

#### Observability

A2A requests create OpenTelemetry spans (using the existing telemetry module):

```typescript
const span = tracer.startSpan('agent.task', {
  attributes: {
    'agent.task.id': task.id,
    'agent.task.context_id': task.context_id,
    'agent.task.workflow': workflowId,
    'agent.request.blocking': blocking,
    'agent.request.message_id': req.message.message_id,
  },
});
```

The span is passed to the engine as part of the execution context, so check spans
become children of the A2A task span.

#### Frontend Implementation

New file: `src/agent-protocol/a2a-frontend.ts`

```typescript
class A2AFrontend implements Frontend {
  name = 'a2a';

  private server: http.Server | https.Server;
  private taskStore: TaskStore;
  private agentCard: AgentCard;
  private config: AgentProtocolConfig;

  async start(ctx: FrontendContext): Promise<void> {
    // 1. Load and validate agent card from file
    this.agentCard = loadAgentCard(this.config.agentCardPath);
    this.agentCard.supported_interfaces[0].url = `${this.config.publicUrl}`;

    // 2. Initialize TaskStore (reuse DB from scheduler)
    this.taskStore = new SqliteTaskStore(ctx.dbPath);

    // 3. Create HTTP server with TLS if configured
    this.server = createServer(this.config, this.handleRequest.bind(this));

    // 4. Subscribe to EventBus for engine -> task state mapping
    ctx.eventBus.on('CheckCompleted', this.onCheckCompleted.bind(this));
    ctx.eventBus.on('CheckErrored', this.onCheckErrored.bind(this));
    ctx.eventBus.on('HumanInputRequested', this.onHumanInputRequested.bind(this));
    ctx.eventBus.on('StateTransition', this.onStateTransition.bind(this));
    ctx.eventBus.on('Shutdown', this.onShutdown.bind(this));

    // 5. Start cleanup sweep timer
    this.startCleanupSweep();

    // 6. Listen
    await listen(this.server, this.config.port, this.config.host);
    logger.info(`A2A server listening on ${this.config.host}:${this.config.port}`);
  }

  async stop(): Promise<void> {
    this.stopCleanupSweep();
    await closeServer(this.server);
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url!, `http://${req.headers.host}`);

    // Agent Card: public, no auth
    if (url.pathname === '/.well-known/agent-card.json' && req.method === 'GET') {
      return this.serveAgentCard(res);
    }

    // All other routes: require auth
    if (!validateAuth(req, this.config)) {
      return sendError(res, 401, 'Unauthorized');
    }

    // Route dispatch
    try {
      if (url.pathname === '/message:send' && req.method === 'POST') {
        return await this.handleSendMessage(req, res);
      }
      if (url.pathname === '/message:stream' && req.method === 'POST') {
        return sendError(res, 501, 'UnsupportedOperation', -32002); // Milestone 5
      }

      const taskMatch = url.pathname.match(/^\/tasks\/([^/:]+)$/);
      if (taskMatch && req.method === 'GET') {
        return this.handleGetTask(taskMatch[1], req, res);
      }
      if (url.pathname === '/tasks' && req.method === 'GET') {
        return this.handleListTasks(url.searchParams, res);
      }

      const cancelMatch = url.pathname.match(/^\/tasks\/([^/:]+):cancel$/);
      if (cancelMatch && req.method === 'POST') {
        return await this.handleCancelTask(cancelMatch[1], res);
      }

      const subscribeMatch = url.pathname.match(/^\/tasks\/([^/:]+):subscribe$/);
      if (subscribeMatch && req.method === 'GET') {
        return sendError(res, 501, 'UnsupportedOperation', -32002); // Milestone 5
      }

      // Push notification routes -> Milestone 5
      if (url.pathname.includes('/pushNotificationConfigs')) {
        return sendError(res, 501, 'UnsupportedOperation', -32002);
      }

      sendError(res, 404, 'MethodNotFound', -32601);
    } catch (err) {
      if (err instanceof TaskNotFoundError) {
        return sendError(res, 404, err.message, -32001);
      }
      if (err instanceof InvalidStateTransitionError) {
        return sendError(res, 409, err.message, -32003);
      }
      if (err instanceof InvalidRequestError) {
        return sendError(res, 400, err.message, -32600);
      }
      logger.error('A2A request error', err);
      sendError(res, 500, 'Internal error');
    }
  }
}
```

#### Tests

- Agent Card served at `/.well-known/agent-card.json` with correct content
- Agent Card URL patched from `public_url` config
- Auth: valid bearer token accepted, invalid rejected, missing rejected
- Auth: `type: none` accepts all requests
- `POST /message:send`: creates task, returns Task with SUBMITTED state
- `POST /message:send` + `blocking: true`: returns Task with COMPLETED state
- `POST /message:send` with `task_id`: follow-up message for INPUT_REQUIRED task
- `POST /message:send` with `task_id` on COMPLETED task: error
- `GET /tasks/{id}`: returns task, 404 for unknown
- `GET /tasks`: list with filters (context_id, state), pagination
- `POST /tasks/{id}:cancel`: transitions to CANCELED, error for terminal tasks
- `history_length` respected in response
- `accepted_output_modes` filters artifact parts
- Error responses match A2A format
- Unsupported routes return 501 (streaming, push)
- Skill routing: metadata.skill_id routes to configured workflow
- Skill routing: no skill_id routes to default_workflow
- OTel span created with correct attributes
- Cleanup sweep deletes expired tasks

#### Definition of Done

- [ ] `A2AFrontend` implements `Frontend` interface
- [ ] Agent Card served from file, URL patched from config
- [ ] All non-streaming HTTP endpoints implemented (send, get, list, cancel)
- [ ] Auth validation with timing-safe comparison
- [ ] Message -> workflow input translation (text, data, file parts)
- [ ] Workflow output -> A2A Artifact translation with concrete mapping logic
- [ ] `accepted_output_modes` filtering
- [ ] `history_length` support in responses
- [ ] Follow-up message handling for INPUT_REQUIRED tasks
- [ ] HumanInputRequested -> INPUT_REQUIRED mapping via EventBus
- [ ] HumanInputReceived -> resume execution via EventBus
- [ ] Blocking mode: synchronous execution end-to-end
- [ ] A2A error format with standard error codes
- [ ] Skill routing (metadata hint + fallback to default workflow)
- [ ] OTel span integration
- [ ] Task cleanup sweep
- [ ] Streaming/push routes return 501 until Milestone 5
- [ ] Registered in FrontendsHost (loaded when `agent_protocol.enabled: true`)
- [ ] CLI flag: `--agent-protocol` enables agent protocol frontend
- [ ] Integration test: full request/response cycle
- [ ] Integration test: multi-turn (send -> INPUT_REQUIRED -> follow-up -> COMPLETED)

---

### Milestone 3: A2A Provider (Client-Side)

**Goal:** Visor checks can call external A2A agents as a provider type, just like
they call MCP tools or HTTP endpoints today.

**Why this third:** With the server side working, we add the client side. This lets
Visor workflows compose with external agents. A security check can delegate to an
external compliance agent. An assistant can call a specialized code review agent
running elsewhere.

**What it is:** A new check provider type `a2a` in the provider registry.

Note: Milestone 3 depends on Milestone 1 only for the type definitions in
`src/agent-protocol/types.ts`. It does NOT depend on the TaskStore or A2A Frontend. It can
be developed in parallel with Milestone 2.

#### Configuration

```yaml
checks:
  external-compliance:
    type: a2a

    # Agent endpoint (one of these is required)
    agent_card: "https://compliance.corp.com/.well-known/agent-card.json"
    # OR for local/known agents (skip card fetch):
    # agent_url: "http://localhost:9001"

    # Authentication (required if agent requires auth)
    auth:
      scheme: "bearer"              # Must match a scheme in Agent Card
      token_env: "COMPLIANCE_TOKEN" # Env var holding the credential

    # Message construction (Liquid-templated)
    message: |
      Review this pull request for SOC2 compliance.

      Repository: {{ pr.repo }}
      PR: #{{ pr.number }}
      Author: {{ pr.author }}

    # Optional: structured data Part (Liquid-templated)
    data:
      files: "{{ pr.files | json }}"
      diff: "{{ pr.diff }}"

    # Optional: file Part attachments
    # files:
    #   - url: "{{ pr.diff_url }}"
    #     media_type: "text/x-diff"

    # Execution mode
    blocking: true                  # Default: true (wait for completion)
    timeout: 300000                 # Default: 300000 (5 minutes)
    poll_interval: 2000             # Default: 2000 (2s between GetTask polls)

    # Multi-turn support
    max_turns: 3                    # Default: 1 (no multi-turn)
    on_input_required: |            # Liquid template for auto-reply
      Here's additional context:
      {{ pr.description }}
      {{ outputs['code-analysis'] | json }}

    # Output transformation (applied to artifacts)
    transform_js: |
      // 'output' is the completed AgentTask object
      const artifacts = output.artifacts || [];
      const textParts = artifacts.flatMap(a =>
        a.parts.filter(p => p.text).map(p => p.text)
      );
      return { text: textParts.join('\n\n') };

    # Standard check features work as expected
    depends_on: [security-scan]
    on_fail:
      goto: manual-review
    if: "{{ outputs['security-scan'].issues | size }} > 0"
```

#### Config Validation

`validateConfig()` checks:
- Exactly one of `agent_card` or `agent_url` is set
- `message` is a non-empty string
- `auth.scheme` is a supported type (`bearer`, `api_key`)
- `auth.token_env` resolves to a non-empty env var
- `max_turns` >= 1
- `timeout` > 0
- `poll_interval` > 0

#### Agent Card Caching

The provider fetches and caches Agent Cards:

```typescript
class AgentCardCache {
  private cache: Map<string, { card: AgentCard; fetchedAt: number }> = new Map();
  private ttl: number = 300_000; // 5 minutes

  async getCard(url: string): Promise<AgentCard> {
    const cached = this.cache.get(url);
    if (cached && Date.now() - cached.fetchedAt < this.ttl) {
      return cached.card;
    }
    const resp = await fetch(url);
    if (!resp.ok) {
      throw new AgentCardFetchError(url, resp.status, resp.statusText);
    }
    const card = await resp.json() as AgentCard;
    // Validate required fields
    if (!card.name || !card.supported_interfaces?.length) {
      throw new InvalidAgentCardError(url, 'Missing required fields');
    }
    this.cache.set(url, { card, fetchedAt: Date.now() });
    return card;
  }

  invalidate(url: string): void {
    this.cache.delete(url);
  }
}
```

#### Provider Implementation

New file: `src/providers/a2a-check-provider.ts`

```typescript
class A2ACheckProvider extends CheckProvider {
  private cardCache = new AgentCardCache();

  getName(): string { return 'a2a'; }

  async validateConfig(config: AgentCheckConfig): Promise<boolean> {
    if (!config.agent_card && !config.agent_url) return false;
    if (config.agent_card && config.agent_url) return false;
    if (!config.message) return false;
    if (config.auth?.token_env && !process.env[config.auth.token_env]) return false;
    return true;
  }

  async execute(
    prInfo: PRInfo,
    config: AgentCheckConfig,
    dependencyResults?: Map<string, ReviewSummary>,
    ctx?: ExecutionContext,
  ): Promise<ReviewSummary> {

    // 1. Resolve agent endpoint
    let agentUrl: string;
    if (config.agent_url) {
      agentUrl = config.agent_url;
    } else {
      const card = await this.cardCache.getCard(config.agent_card!);
      agentUrl = card.supported_interfaces[0].url;
    }

    // 2. Build auth headers
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.auth) {
      const token = process.env[config.auth.token_env!];
      if (config.auth.scheme === 'bearer') {
        headers['Authorization'] = `Bearer ${token}`;
      } else if (config.auth.scheme === 'api_key') {
        headers[config.auth.header_name ?? 'X-API-Key'] = token!;
      }
    }

    // 3. Build A2A Message (Liquid-render templates)
    const renderedMessage = renderLiquid(config.message, { pr: prInfo, outputs: dependencyResults });
    const parts: AgentPart[] = [{ text: renderedMessage, media_type: 'text/plain' }];

    if (config.data) {
      const renderedData = renderLiquidObject(config.data, { pr: prInfo, outputs: dependencyResults });
      parts.push({ data: renderedData, media_type: 'application/json' });
    }

    if (config.files) {
      for (const file of config.files) {
        parts.push({
          url: renderLiquid(file.url, { pr: prInfo }),
          media_type: file.media_type,
          filename: file.filename,
        });
      }
    }

    const a2aMessage: AgentMessage = {
      message_id: crypto.randomUUID(),
      role: 'user',
      parts,
    };

    // 4. Send message
    const sendReq: AgentSendMessageRequest = {
      message: a2aMessage,
      configuration: {
        blocking: config.blocking ?? true,
        accepted_output_modes: ['text/plain', 'text/markdown', 'application/json'],
      },
    };

    const startTime = Date.now();
    const timeout = config.timeout ?? 300_000;
    const pollInterval = config.poll_interval ?? 2000;

    let response = await this.sendMessage(agentUrl, sendReq, headers);

    // 5. Handle response
    // SendMessageResponse is Task | Message
    if ('message' in response) {
      // Direct message response (no task created)
      return this.messageToReviewSummary(response.message, config);
    }

    let task = response.task;

    // 6. Poll loop (if not blocking or task not yet terminal)
    let turnCount = 0;
    const maxTurns = config.max_turns ?? 1;

    while (!isTerminalState(task.status.state)) {
      // Check timeout
      if (Date.now() - startTime > timeout) {
        throw new A2ATimeoutError(task.id, timeout);
      }

      // Handle INPUT_REQUIRED
      if (task.status.state === 'input_required') {
        turnCount++;
        if (turnCount >= maxTurns) {
          throw new A2AMaxTurnsExceededError(task.id, maxTurns);
        }

        if (config.on_input_required) {
          // Auto-reply with rendered template
          const replyText = renderLiquid(config.on_input_required, {
            pr: prInfo,
            outputs: dependencyResults,
            task,
          });
          const followUp: AgentSendMessageRequest = {
            message: {
              message_id: crypto.randomUUID(),
              task_id: task.id,
              context_id: task.context_id,
              role: 'user',
              parts: [{ text: replyText, media_type: 'text/plain' }],
            },
            configuration: { blocking: config.blocking ?? true },
          };
          response = await this.sendMessage(agentUrl, followUp, headers);
          task = 'task' in response ? response.task : task;
          continue;
        } else {
          // No auto-reply configured, escalate
          throw new A2AInputRequiredError(
            task.id,
            task.status.message?.parts?.map(p => p.text).join('\n') ?? 'Agent requires input'
          );
        }
      }

      // Handle AUTH_REQUIRED
      if (task.status.state === 'auth_required') {
        throw new A2AAuthRequiredError(task.id);
      }

      // Poll for updates
      await sleep(pollInterval);
      task = await this.getTask(agentUrl, task.id, headers);
    }

    // 7. Process final task
    if (task.status.state === 'failed') {
      const errorMsg = task.status.message?.parts?.map(p => p.text).join('\n') ?? 'Task failed';
      throw new A2ATaskFailedError(task.id, errorMsg);
    }

    if (task.status.state === 'canceled' || task.status.state === 'rejected') {
      throw new A2ATaskRejectedError(task.id, task.status.state);
    }

    // 8. Transform artifacts to ReviewSummary
    return this.taskToReviewSummary(task, config);
  }

  private async sendMessage(url: string, req: AgentSendMessageRequest, headers: Record<string, string>): Promise<AgentSendMessageResponse> {
    const resp = await fetch(`${url}/message:send`, {
      method: 'POST',
      headers,
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(60_000), // 60s connection timeout
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new A2ARequestError(url, resp.status, body);
    }
    return resp.json();
  }

  private async getTask(url: string, taskId: string, headers: Record<string, string>): Promise<AgentTask> {
    const resp = await fetch(`${url}/tasks/${taskId}`, { headers });
    if (!resp.ok) {
      throw new A2ARequestError(url, resp.status, await resp.text());
    }
    return resp.json();
  }

  private taskToReviewSummary(task: AgentTask, config: AgentCheckConfig): ReviewSummary {
    // Apply transform_js if configured
    if (config.transform_js) {
      const transformed = executeSandbox(config.transform_js, { output: task });
      return normalizeToReviewSummary(transformed);
    }

    // Default: extract text from artifacts
    const textParts = task.artifacts.flatMap(a =>
      a.parts.filter(p => p.text).map(p => p.text!)
    );
    const dataParts = task.artifacts.flatMap(a =>
      a.parts.filter(p => p.data).map(p => p.data)
    );

    return {
      summary: textParts.join('\n\n'),
      issues: this.extractIssues(dataParts),
      data: task,
    };
  }

  private extractIssues(dataParts: unknown[]): ReviewIssue[] {
    // Same normalization logic as MCP provider:
    // - Array of issues -> use directly
    // - Object with .issues -> extract
    // - Auto-detect severity, message, file, line fields
    return normalizeIssues(dataParts);
  }
}

function isTerminalState(state: TaskState): boolean {
  return ['completed', 'failed', 'canceled', 'rejected'].includes(state);
}
```

#### Tests

- Config validation: all required/optional field combinations
- Agent Card fetch: success, 404, malformed, cache hit, cache miss, cache expiry
- Message construction: text only, text + data, text + data + files
- Liquid rendering in message and data fields
- Send message: blocking=true returns completed task
- Send message: blocking=false + poll loop until completed
- Poll loop: respects timeout, throws A2ATimeoutError
- Poll loop: respects poll_interval
- Multi-turn: INPUT_REQUIRED -> auto-reply via on_input_required -> COMPLETED
- Multi-turn: INPUT_REQUIRED without on_input_required -> throws A2AInputRequiredError
- Multi-turn: exceeds max_turns -> throws A2AMaxTurnsExceededError
- AUTH_REQUIRED -> throws A2AAuthRequiredError
- FAILED task -> throws A2ATaskFailedError
- CANCELED/REJECTED task -> throws A2ATaskRejectedError
- Transform: transform_js applied to completed task
- Transform: default text extraction from artifacts
- Issue normalization from data parts
- Auth: bearer token sent in header
- Auth: API key sent in configured header
- Error: agent unreachable (network error)
- Error: agent returns non-2xx HTTP status

#### Definition of Done

- [ ] `A2ACheckProvider` extends `CheckProvider`, registered in `CheckProviderRegistry`
- [ ] Config validation: agent_card/agent_url, message, auth, timeouts
- [ ] Agent Card fetch with TTL cache + validation
- [ ] Liquid-templated message construction (text, data, file Parts)
- [ ] A2A HTTP client: `POST /message:send` and `GET /tasks/{id}`
- [ ] Blocking mode: send with `blocking: true`, return result
- [ ] Polling mode: send with `blocking: false`, poll until terminal state
- [ ] Multi-turn: auto-reply on INPUT_REQUIRED via `on_input_required` template
- [ ] Max turns enforcement
- [ ] Timeout enforcement with clear error
- [ ] Auth negotiation: bearer token, API key
- [ ] Transform: `transform_js` sandbox execution on completed task
- [ ] Default artifact-to-ReviewSummary mapping
- [ ] Issue normalization (reuse MCP provider patterns)
- [ ] All error types: timeout, max_turns, input_required, auth, failed, rejected, network
- [ ] Unit tests with mock A2A server (all success + error paths)
- [ ] Integration test: end-to-end with real A2A server (use Milestone 2's frontend)

---

### Milestone 4: Async Task Queue

**Goal:** Decouple task acceptance from execution, enabling true async operation
where the A2A frontend returns immediately and work happens in the background.

**Why this fourth:** Milestones 1-3 work in blocking mode. This milestone adds the
async behavior that A2A defaults to. It also unlocks scalability — multiple workers
can poll the same task queue.

**What it is:** A polling-based task queue using the existing SQLite database,
similar to how the scheduler checks for due schedules on an interval.

#### Queue Mechanism

No new infrastructure. Reuse the pattern from `scheduler/scheduler.ts`:

```typescript
class TaskQueue {
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private activeCount = 0;

  constructor(
    private taskStore: TaskStore,
    private engine: StateMachineExecutionEngine,
    private eventBus: EventBus,
    private config: {
      pollInterval: number;         // Default: 1000ms
      maxConcurrent: number;        // Default: 5
      staleClaimTimeout: number;    // Default: 300000ms (5 min)
    },
    private workerId: string = crypto.randomUUID(),
  ) {}

  start(): void {
    this.running = true;
    this.schedulePoll();
    logger.info(`Task queue started (worker=${this.workerId}, maxConcurrent=${this.config.maxConcurrent})`);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    // Wait for active tasks to complete (with timeout)
    const shutdownTimeout = 30_000;
    const start = Date.now();
    while (this.activeCount > 0 && Date.now() - start < shutdownTimeout) {
      await sleep(100);
    }
    if (this.activeCount > 0) {
      logger.warn(`Task queue stopped with ${this.activeCount} active tasks`);
    }
  }

  private schedulePoll(): void {
    if (!this.running) return;
    this.timer = setTimeout(() => this.poll(), this.config.pollInterval);
  }

  private async poll(): Promise<void> {
    if (!this.running) return;

    try {
      // Only claim if under concurrency limit
      while (this.activeCount < this.config.maxConcurrent) {
        const task = this.taskStore.claimNextSubmitted(this.workerId);
        if (!task) break; // No more pending tasks

        this.activeCount++;
        // Execute in background (don't await, allows concurrent tasks)
        this.executeTask(task).finally(() => {
          this.activeCount--;
        });
      }
    } catch (err) {
      logger.error('Task queue poll error', err);
    }

    this.schedulePoll();
  }

  private async executeTask(task: AgentTask): Promise<void> {
    const span = tracer.startSpan('agent.queue.execute', {
      attributes: { 'agent.task.id': task.id },
    });

    try {
      // 1. Transition to WORKING
      this.taskStore.updateTaskState(task.id, 'working');

      // 2. Translate message to workflow input
      const input = messageToWorkflowInput(
        JSON.parse(task.request_message) as AgentMessage,
        task,
        {} as AgentProtocolConfig,
      );

      // 3. Execute via engine
      const result = await this.engine.executeChecks({
        workflow: task.workflow_id,
        inputs: input,
        metadata: {
          agentTaskId: task.id,
          agentContextId: task.context_id,
        },
      });

      // 4. Convert result to artifacts
      const artifacts = resultToArtifacts(result);
      for (const artifact of artifacts) {
        this.taskStore.addArtifact(task.id, artifact);
      }

      // 5. Set terminal state
      if (result.success) {
        this.taskStore.updateTaskState(task.id, 'completed');
      } else {
        this.taskStore.updateTaskState(task.id, 'failed', {
          message_id: crypto.randomUUID(),
          role: 'agent',
          parts: [{ text: result.error || 'Workflow execution failed' }],
        });
      }

    } catch (err) {
      logger.error(`Task ${task.id} execution failed`, err);
      try {
        this.taskStore.updateTaskState(task.id, 'failed', {
          message_id: crypto.randomUUID(),
          role: 'agent',
          parts: [{ text: err instanceof Error ? err.message : 'Unknown error' }],
        });
      } catch (storeErr) {
        logger.error(`Failed to update task ${task.id} state`, storeErr);
      }
    } finally {
      span.end();
    }
  }
}
```

#### Claim Mechanism

SQLite-based atomic claim (same pattern as scheduler's `tryAcquireLock`):

```sql
UPDATE agent_tasks
SET state = 'working',
    claimed_by = ?,
    claimed_at = datetime('now'),
    updated_at = datetime('now')
WHERE id = (
  SELECT id FROM agent_tasks
  WHERE state = 'submitted'
  AND (claimed_by IS NULL OR claimed_at < datetime('now', '-' || ? || ' seconds'))
  ORDER BY created_at ASC
  LIMIT 1
)
RETURNING *;
```

The second `?` is `staleClaimTimeout / 1000`. Tasks claimed more than N seconds ago
by a worker that hasn't completed them are reclaimed (handles worker crashes).

For enterprise (Knex on PostgreSQL):
```sql
UPDATE agent_tasks SET state = 'working', claimed_by = ?, claimed_at = NOW()
WHERE id = (
  SELECT id FROM agent_tasks
  WHERE state = 'submitted'
  AND (claimed_by IS NULL OR claimed_at < NOW() - INTERVAL '5 minutes')
  ORDER BY created_at ASC
  LIMIT 1
  FOR UPDATE SKIP LOCKED
) RETURNING *;
```

#### EventBus Integration (Engine -> Task State)

The A2A frontend listens to engine events and maps them to task state updates:

```typescript
// In A2AFrontend.start()

ctx.eventBus.on('CheckCompleted', (event: EventEnvelope<CheckCompletedPayload>) => {
  const taskId = event.metadata?.agentTaskId as string | undefined;
  if (!taskId) return; // Not an agent-protocol-initiated execution

  // Store intermediate artifacts as checks complete
  const artifact = checkResultToArtifact(event.payload);
  if (artifact) {
    this.taskStore.addArtifact(taskId, artifact);
  }
});

ctx.eventBus.on('CheckErrored', (event: EventEnvelope<CheckErroredPayload>) => {
  const taskId = event.metadata?.agentTaskId as string | undefined;
  if (!taskId) return;

  // Note: don't transition to FAILED here. The engine may continue
  // (depends on check criticality, on_fail routing). Only the final
  // engine result determines the task's terminal state.
  logger.warn(`Agent task ${taskId}: check ${event.payload.checkId} errored`);
});

ctx.eventBus.on('HumanInputRequested', (event: EventEnvelope<HumanInputRequestedPayload>) => {
  const taskId = event.metadata?.agentTaskId as string | undefined;
  if (!taskId) return;

  // Transition task to INPUT_REQUIRED
  this.taskStore.updateTaskState(taskId, 'input_required', {
    message_id: crypto.randomUUID(),
    role: 'agent',
    parts: [{ text: event.payload.prompt }],
  });

  // Also notify streaming subscribers (Milestone 5)
});
```

#### Integration with A2A Frontend's Non-Blocking Path

Before Milestone 4, the A2A frontend's non-blocking path (`blocking: false`) has
no queue. It simply creates the task as SUBMITTED and relies on the client polling.

With Milestone 4, the non-blocking path works properly:
1. Frontend creates task (SUBMITTED)
2. Returns task to client immediately
3. TaskQueue polls, claims, executes
4. Client polls `GET /tasks/{id}` to check progress

The frontend's `handleSendMessage` changes from:
```typescript
// Before Milestone 4: blocking fallback
return { task: taskStore.getTask(task.id)! }; // Always SUBMITTED, never progresses
```
to:
```typescript
// After Milestone 4: queue picks it up
return { task: taskStore.getTask(task.id)! }; // SUBMITTED, queue claims it ~1s later
```

No code change in the frontend. The queue is started alongside the frontend in
the `visor serve --agent-protocol` startup sequence.

#### Tests

- Queue polls and claims SUBMITTED tasks
- Queue respects max_concurrent (no more than N parallel executions)
- Concurrent workers: two queues on same DB don't double-claim
- Stale claim recovery: task claimed 6 minutes ago is reclaimed
- Task transitions: SUBMITTED -> WORKING -> COMPLETED
- Task transitions: SUBMITTED -> WORKING -> FAILED (with error message)
- Engine error: task marked FAILED with error details
- Graceful shutdown: active tasks finish before stop returns
- Graceful shutdown: timeout enforced
- INPUT_REQUIRED: engine pauses, task state updated, follow-up resumes
- OTel span created per task execution
- Queue handles empty DB (no tasks to claim)
- Queue recovers from taskStore errors (continues polling)

#### Definition of Done

- [ ] `TaskQueue` class with poll/claim/execute loop
- [ ] Atomic SQLite claim with stale timeout
- [ ] Enterprise Knex claim with `FOR UPDATE SKIP LOCKED`
- [ ] Configurable: poll_interval, max_concurrent, stale_claim_timeout
- [ ] Concurrent task execution (up to max_concurrent)
- [ ] EventBus -> TaskStore mapping (CheckCompleted, CheckErrored, HumanInputRequested)
- [ ] Graceful shutdown with drain timeout
- [ ] OTel span per task execution
- [ ] Unit tests for queue mechanics (claim, concurrency, stale recovery)
- [ ] Integration test: submit async -> poll -> COMPLETED
- [ ] Integration test: concurrent tasks respect limit

---

### Milestone 5: Streaming & Push Notifications

**Goal:** Real-time task updates via SSE streaming and webhook push notifications,
completing full A2A protocol compliance.

**Why this last:** Streaming and push are an enhancement layer. The core value (task
registry, agent discovery, async execution, external agent calls) works without
them. This milestone adds production polish and full spec compliance.

#### SSE Streaming

Two streaming endpoints:

**1. `POST /message:stream`** — Send a message, get SSE stream of updates:

```
POST /message:stream HTTP/1.1
Content-Type: application/json
Authorization: Bearer xxx

{ "message": { "message_id": "...", "role": "user", "parts": [...] } }

HTTP/1.1 200 OK
Content-Type: text/event-stream

data: {"type":"TaskStatusUpdateEvent","task_id":"abc","context_id":"ctx1","status":{"state":"working","timestamp":"..."}}

data: {"type":"TaskArtifactUpdateEvent","task_id":"abc","context_id":"ctx1","artifact":{...},"append":false,"last_chunk":false}

data: {"type":"TaskArtifactUpdateEvent","task_id":"abc","context_id":"ctx1","artifact":{...},"append":true,"last_chunk":true}

data: {"type":"TaskStatusUpdateEvent","task_id":"abc","context_id":"ctx1","status":{"state":"completed","timestamp":"..."}}
```

**2. `GET /tasks/{id}:subscribe`** — Subscribe to existing task updates:

```
GET /tasks/abc-123:subscribe HTTP/1.1
Authorization: Bearer xxx

HTTP/1.1 200 OK
Content-Type: text/event-stream

data: {"type":"TaskStatusUpdateEvent",...}
...
```

#### TaskStreamManager

Bridges EventBus events to SSE connections:

```typescript
class TaskStreamManager {
  private subscribers: Map<string, Set<ServerResponse>> = new Map();

  subscribe(taskId: string, res: ServerResponse): void {
    // Set SSE headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    if (!this.subscribers.has(taskId)) {
      this.subscribers.set(taskId, new Set());
    }
    this.subscribers.get(taskId)!.add(res);

    // Clean up on disconnect
    res.on('close', () => {
      this.subscribers.get(taskId)?.delete(res);
      if (this.subscribers.get(taskId)?.size === 0) {
        this.subscribers.delete(taskId);
      }
    });

    // Send keepalive every 30s
    const keepalive = setInterval(() => {
      if (res.writable) {
        res.write(': keepalive\n\n');
      } else {
        clearInterval(keepalive);
      }
    }, 30_000);
  }

  emit(taskId: string, event: TaskStatusUpdateEvent | TaskArtifactUpdateEvent): void {
    const subs = this.subscribers.get(taskId);
    if (!subs || subs.size === 0) return;

    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of subs) {
      if (res.writable) {
        res.write(data);
      }
    }

    // If terminal state, close all connections for this task
    if ('status' in event && isTerminalState(event.status.state)) {
      for (const res of subs) {
        res.end();
      }
      this.subscribers.delete(taskId);
    }
  }

  hasSubscribers(taskId: string): boolean {
    return (this.subscribers.get(taskId)?.size ?? 0) > 0;
  }
}
```

#### Push Notifications

Clients register webhook URLs per task. On state change, the server POSTs to them.

**Storage:**

```sql
CREATE TABLE IF NOT EXISTS agent_push_configs (
  id TEXT PRIMARY KEY,                    -- UUID
  task_id TEXT NOT NULL,                  -- FK to agent_tasks
  url TEXT NOT NULL,                      -- Webhook URL
  token TEXT,                             -- Verification token
  auth_scheme TEXT,                       -- e.g., "Bearer"
  auth_credentials TEXT,                  -- Token value
  created_at TEXT NOT NULL,
  FOREIGN KEY (task_id) REFERENCES agent_tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_agent_push_task ON agent_push_configs(task_id);
```

**PushNotificationManager:**

```typescript
class PushNotificationManager {
  constructor(private db: Database) {}

  create(config: AgentPushNotificationConfig): AgentPushNotificationConfig {
    const id = config.id ?? crypto.randomUUID();
    this.db.prepare(`INSERT INTO agent_push_configs ...`).run(id, config.task_id, config.url, ...);
    return { ...config, id };
  }

  get(taskId: string, configId: string): AgentPushNotificationConfig | null { ... }
  list(taskId: string): AgentPushNotificationConfig[] { ... }
  delete(taskId: string, configId: string): void { ... }

  async notifyAll(taskId: string, event: TaskStatusUpdateEvent | TaskArtifactUpdateEvent): Promise<void> {
    const configs = this.list(taskId);
    const deliveries = configs.map(config => this.deliver(config, event));
    await Promise.allSettled(deliveries);
  }

  private async deliver(
    config: AgentPushNotificationConfig,
    event: TaskStatusUpdateEvent | TaskArtifactUpdateEvent,
  ): Promise<void> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (config.auth_scheme && config.auth_credentials) {
      headers['Authorization'] = `${config.auth_scheme} ${config.auth_credentials}`;
    }

    // Retry with exponential backoff: 3 attempts, 1s/2s/4s
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const resp = await fetch(config.url, {
          method: 'POST',
          headers,
          body: JSON.stringify(event),
          signal: AbortSignal.timeout(10_000),
        });
        if (resp.ok) return;
        if (resp.status >= 400 && resp.status < 500) return; // Client error, don't retry
        // Server error, retry
      } catch (err) {
        logger.warn(`Push notification delivery attempt ${attempt + 1} failed for ${config.url}`, err);
      }
      await sleep(1000 * Math.pow(2, attempt));
    }
    logger.error(`Push notification delivery failed after 3 attempts for task ${config.task_id} to ${config.url}`);
  }
}
```

#### Capability Enforcement

Update the route handler to check Agent Card capabilities:

```typescript
if (url.pathname === '/message:stream' && req.method === 'POST') {
  if (!this.agentCard.capabilities?.streaming) {
    return sendError(res, 400, 'Streaming not supported', -32002);
  }
  return this.handleSendStreamingMessage(req, res);
}
```

#### Wiring: EventBus -> Stream + Push

```typescript
// In A2AFrontend, after Milestone 5
private onTaskStateChanged(taskId: string, event: TaskStatusUpdateEvent): void {
  // SSE streaming
  this.streamManager.emit(taskId, event);
  // Push notifications
  this.pushManager.notifyAll(taskId, event).catch(err => {
    logger.error('Push notification error', err);
  });
}
```

#### Update Agent Card Capabilities

After Milestone 5 is complete, set `capabilities.streaming: true` and
`capabilities.push_notifications: true` in the Agent Card file.

#### Tests

- SSE: subscribe to task, receive TaskStatusUpdateEvent on state change
- SSE: receive TaskArtifactUpdateEvent when check completes
- SSE: connection closed when task reaches terminal state
- SSE: multiple subscribers to same task
- SSE: keepalive sent every 30s
- SSE: client disconnect cleans up subscriber
- SSE: `message/stream` creates task + returns SSE stream
- SSE: `tasks/{id}:subscribe` on existing WORKING task
- Push: create config, verify stored
- Push: get, list, delete config CRUD
- Push: notification delivered on state change with correct auth header
- Push: retry on 5xx, no retry on 4xx
- Push: retry exhaustion logged as error
- Push: config cascade-deleted when task deleted
- Capability enforcement: streaming=false rejects stream requests
- Capability enforcement: push_notifications=false rejects push config creation

#### Definition of Done

- [ ] `TaskStreamManager` with subscribe/emit/cleanup
- [ ] SSE headers and keepalive
- [ ] `message/stream` endpoint: create task + stream events
- [ ] `tasks/{id}:subscribe` endpoint: subscribe to existing task
- [ ] Terminal state closes SSE connections
- [ ] `agent_push_configs` SQLite table
- [ ] `PushNotificationManager` CRUD + delivery
- [ ] Push delivery with retry (3 attempts, exponential backoff)
- [ ] Push auth header sent per config
- [ ] EventBus -> StreamManager + PushManager wiring
- [ ] Capability enforcement per Agent Card
- [ ] Agent Card capabilities updated to true
- [ ] Integration test: stream task from SUBMITTED to COMPLETED
- [ ] Integration test: push notification delivered end-to-end
- [ ] Integration test: capability enforcement

---

## IMPLEMENTATION ORDER & DEPENDENCIES

```
Milestone 1: Task Registry
    │
    ├──> Milestone 2: A2A Frontend (depends on 1)
    │       │
    │       └──> Milestone 4: Async Queue (depends on 1, 2)
    │               │
    │               └──> Milestone 5: Streaming & Push (depends on 2, 4)
    │
    └──> Milestone 3: A2A Provider (depends on 1 for types only)
```

**Parallel work:** Milestones 2 and 3 can be developed simultaneously.
Milestone 3 only needs the types from `src/agent-protocol/types.ts` (created in Milestone 1).

**Incremental value:**
- After M1+M2: Visor is a discoverable agent via A2A (blocking mode only)
- After M3: Visor can call external A2A agents from checks
- After M4: Full async operation (non-blocking mode works)
- After M5: Production-grade streaming and push notifications
- **Future:** New protocol bindings (ACP, etc.) add frontends/providers without touching M1 or M4

---

## WHAT WE ARE NOT DOING

1. **Not auto-generating Agent Cards from skills.yaml.** The Agent Card is a manual
   product artifact with different granularity than internal skills.

2. **Not adding gRPC.** A2A v0.3 supports gRPC, but JSON-RPC over HTTP is the
   primary binding and sufficient for our needs. gRPC can be added later.

3. **Not replacing existing frontends.** Slack, GitHub, CLI continue to work exactly
   as they do today. A2A is an additional frontend, not a replacement.

4. **Not building a service mesh.** No service discovery registry, no load balancing,
   no circuit breakers beyond basic retry.

5. **Not implementing extended Agent Card.** Post-auth cards with additional skills
   are an optimization for later.

6. **Not implementing multi-tenancy.** The `/{tenant}/` prefix routes from the A2A
   spec are deferred.

7. **Not implementing Agent Card signing (JWS).** Cryptographic card verification
   is deferred.

8. **Not implementing OAuth2/OIDC auth.** Starting with bearer token only. OAuth2
   flows add significant complexity for limited initial value.

9. **Not changing the state machine engine.** The engine is the proven core. A2A
   wraps it with protocol translation, not modification.

---

## RISKS & MITIGATIONS

| Risk | Impact | Mitigation |
|------|--------|------------|
| A2A spec still evolving (v0.3) | Breaking changes in v1.0 | Internal types (`AgentTask`, etc.) are protocol-agnostic; only the A2A frontend/provider contain protocol-specific code. A spec change only affects the thin translation layer. |
| New competing protocol emerges | Wasted A2A-specific work | Core primitives (task registry, queue, types) are protocol-neutral. Adding a new protocol = new frontend + new provider, no schema or core type changes. |
| SQLite polling latency | ~1s delay on task pickup | Configurable interval; for most use cases 1s is fine; can add direct notification via in-process signal later |
| Long-running tasks block workers | Queue starvation | `max_concurrent` config; stale claim timeout; per-task timeout in engine |
| Agent Card becomes stale | Callers get wrong capabilities | Manual curation is intentional; `version` field signals changes; capabilities start conservative (false) |
| Auth complexity | Many schemes to support | Start with bearer token only; add OAuth2/OIDC when needed |
| Multi-turn engine pausing | Complex state management | Reuse existing HumanInputCheckProvider pause/resume pattern; map A2A INPUT_REQUIRED 1:1 |
| Push notification delivery failures | Client misses updates | 3x retry with exponential backoff; client can always poll `GET /tasks/{id}` as fallback |
| Database growth from old tasks | Disk usage | Task TTL + cleanup sweep (configurable, default 7 days) |

---

## SUCCESS CRITERIA

1. A Visor workflow can be started by an external A2A client sending `POST /message:send`,
   and the client can poll `GET /tasks/{id}` for completion and retrieve artifacts.

2. A Visor check with `type: a2a` can call an external A2A agent, handle multi-turn
   (INPUT_REQUIRED), and use the response in downstream checks.

3. The existing Slack, GitHub, and CLI frontends continue to work unchanged.

4. The Agent Card at `/.well-known/agent-card.json` accurately represents capabilities
   and is parseable by any A2A-compliant client.

5. Non-blocking requests return within 100ms. Blocking requests complete within the
   workflow's natural execution time.

6. Task state transitions match the A2A spec exactly (no invalid transitions possible).

---

## FUTURE: Virtual Employees & Autonomous Agents

This RFC focuses on agent interoperability (communication). But the end goal is
broader: **virtual employees** — agents that autonomously perform sustained work
(HR screening, compliance monitoring, release management) without per-task human
initiation. This section captures architectural thinking for future milestones.

### The 5-Layer Architecture

Virtual employees require five layers, of which this RFC addresses only Layer 2:

| Layer | Concern | This RFC | Future Work |
|-------|---------|----------|-------------|
| **1. Triggers** | What initiates work (cron, webhook, event, A2A task) | Existing scheduler covers cron + webhooks | Event-driven triggers (GitHub events, Slack reactions, email) |
| **2. Communication** | How agents talk to each other and to users | **A2A protocol (this RFC)** | ACP, AAIF bindings |
| **3. Credentials** | How agents authenticate to third-party services | Visor config secrets + env vars | Vault integration, short-lived tokens, per-agent service accounts |
| **4. Intelligence** | How agents reason and make decisions | AI providers (Gemini, Claude, GPT) | Domain-specific fine-tuning, memory, learning from feedback |
| **5. Safety** | Guardrails, approvals, audit trails | Basic check fail/pass + on_fail routing | Approval workflows, budget limits, human-in-the-loop escalation, audit logs |

### Identity & Authorization (NIST Direction)

NIST's AI Agent Standards Initiative (Feb 2026 concept paper) is working on agent
identity and authorization. Key directions relevant to our architecture:

- **Agent identity via existing standards**: OAuth 2.0/2.1 client credentials, SPIFFE/SPIRE
  for workload identity, SCIM for agent provisioning/deprovisioning
- **Capability tokens**: Short-lived, scoped tokens that limit what an agent can do
  (e.g., "read Workable candidates" but not "delete them")
- **Delegation chains**: Proving that Agent B is acting on behalf of Agent A, which
  acts on behalf of User X

**Implication for Visor:** When we add credential management for virtual employees,
we should use OAuth 2.0 client credentials (not static tokens) and support scoped
capability tokens. The `agent_protocol.auth` config already has the right shape;
the future extension is per-agent, per-service credential vaults.

### Agent Lifecycle States (ACP Model)

IBM's Agent Communication Protocol (ACP) defines lifecycle states beyond A2A's
task states. These apply to the agent itself, not individual tasks:

```
INITIALIZING → ACTIVE → DEGRADED → RETIRING → RETIRED
```

This is relevant for virtual employees because:
- An HR agent that lost access to Workable is `DEGRADED`, not dead
- A retiring agent should drain its task queue before stopping
- Monitoring dashboards need agent health, not just task status

**Implication for Visor:** The `agent_tasks` table tracks task state. A future
`agent_registry` table would track agent lifecycle state, health checks, and
capability advertisements. This is not in scope for this RFC but the
protocol-agnostic naming (not `a2a_agents`) makes it natural to add later.

### Autonomous Job Patterns

Virtual employees need to run without per-task human initiation. Patterns:

1. **Scheduled jobs** (already supported): Cron-like triggers via Visor scheduler.
   E.g., "Every morning at 9am, check Workable for new candidates."

2. **Event-driven triggers** (future): React to external events.
   E.g., "When a new PR is opened, run security review automatically."
   This is partially covered by the GitHub frontend but not generalized.

3. **Continuous monitoring** (future): Long-running agents that watch for conditions.
   E.g., "Monitor Slack for questions about our API and answer them."
   Implementation: a long-lived Visor process with a streaming input frontend.

4. **Self-initiated work** (future, needs safety layer): Agent decides what to do.
   E.g., "Review all open PRs older than 3 days and nudge reviewers."
   This requires the safety layer (approval workflows, budget limits).

**Implication for Visor:** The existing scheduler + A2A task queue covers patterns
1 and 2. Patterns 3 and 4 need new trigger types and the safety layer (Layer 5).

### Credential Management Model (Future)

For virtual employees accessing third-party services:

```yaml
# Future config shape (NOT in this RFC)
agent_credentials:
  workable:
    type: oauth2_client_credentials
    token_url: "https://api.workable.com/oauth/token"
    client_id_env: "WORKABLE_CLIENT_ID"
    client_secret_env: "WORKABLE_CLIENT_SECRET"
    scopes: ["candidates:read", "candidates:write"]
    refresh_before_expiry: 300  # seconds

  github:
    type: github_app
    app_id_env: "GITHUB_APP_ID"
    private_key_env: "GITHUB_APP_KEY"
    installation_id_env: "GITHUB_INSTALLATION_ID"
```

This maps to how the current `auth` config works but adds token lifecycle
management (refresh, rotation) and per-service scoping.

### Standards Landscape Summary

| Standard | Owner | Covers | Status (Mar 2026) |
|----------|-------|--------|-------------------|
| **A2A** | Google → Linux Foundation | Agent-to-agent communication | v0.3, stable, 50+ partners |
| **MCP** | Anthropic → Linux Foundation | Agent-to-tool communication | Stable, widely adopted |
| **ACP** | IBM | Agent lifecycle, communication, K8s RBAC | Early, local-first focus |
| **AAIF** | Linux Foundation | Umbrella (MCP, AGENTS.md, goose) | Organizational, no spec |
| **NIST AI Agent** | NIST | Agent identity & authorization | Concept paper (Feb 2026) |
| **AGENTS.md** | Block (via AAIF) | Agent capability advertisement | Emerging, file-based |

**No single standard covers the full virtual employee lifecycle.** Our strategy:
adopt principles (stateful tasks, agent cards, async-first) through the
protocol-agnostic foundation, implement A2A first, and extend to other protocols
and layers as standards mature.

---

## APPENDIX: A2A Proto Reference (v0.3)

Key message types from `specification/a2a.proto`:

**Service methods:**
- `SendMessage(SendMessageRequest)` -> `SendMessageResponse` (Task | Message)
- `SendStreamingMessage(SendMessageRequest)` -> `stream StreamResponse`
- `GetTask(GetTaskRequest)` -> `Task`
- `ListTasks(ListTasksRequest)` -> `ListTasksResponse`
- `CancelTask(CancelTaskRequest)` -> `Task`
- `SubscribeToTask(SubscribeToTaskRequest)` -> `stream StreamResponse`
- Push notification config CRUD (Create, Get, List, Delete)
- `GetExtendedAgentCard` -> `AgentCard`

**Data types:**
- `AgentCard` — name, description, version, provider, supported_interfaces, capabilities, security_schemes, security_requirements, default_input_modes, default_output_modes, skills, signatures, icon_url
- `AgentSkill` — id, name, description, tags, examples, input_modes, output_modes, security_requirements
- `AgentCapabilities` — streaming, push_notifications, extensions, extended_agent_card
- `Task` — id, context_id, status, artifacts, history, metadata
- `TaskState` — SUBMITTED, WORKING, COMPLETED, FAILED, CANCELED, INPUT_REQUIRED, REJECTED, AUTH_REQUIRED
- `TaskStatus` — state, message, timestamp
- `Message` — message_id, context_id, task_id, role, parts, metadata, extensions, reference_task_ids
- `Part` — text | raw | url | data + metadata, filename, media_type
- `Artifact` — artifact_id, name, description, parts, metadata, extensions
- `SendMessageRequest` — message, configuration, metadata
- `SendMessageConfiguration` — accepted_output_modes, task_push_notification_config, history_length, blocking
- `TaskStatusUpdateEvent` — task_id, context_id, status, metadata
- `TaskArtifactUpdateEvent` — task_id, context_id, artifact, append, last_chunk, metadata
- `SecurityScheme` — api_key | http_auth | oauth2 | oidc | mtls (oneof)
- `TaskPushNotificationConfig` — tenant, id, task_id, url, token, authentication
