# Tools & Toolkits Guide

How to define, organize, and expose tools to AI agents in Visor — from simple API calls to complex multi-step workflows.

## Concepts

| Concept | What it does | One definition gives you |
|---------|-------------|------------------------|
| **Custom tool** (`type: command`) | Shell command with templates | 1 tool |
| **API tool bundle** (`type: api`) | OpenAPI spec → auto-generated tools | N tools (one per operationId) |
| **Workflow tool** (`type: workflow`) | Multi-step tool with custom logic | 1 tool |
| **Toolkit file** | A file with multiple tool definitions | N tools (loaded via `toolkit:`) |
| **Skill** | Groups tools + knowledge for AI agent routing | Activates tools when intent matches |

## Levels of Complexity

### Level 1: Simple Command Tool

A shell command exposed as a tool:

```yaml
tools:
  git-status:
    name: git-status
    description: Get current git status
    exec: "git status --porcelain"
    parseJson: false

steps:
  check:
    type: ai
    ai_custom_tools: [git-status]
    prompt: "Check the git status and summarize changes"
```

### Level 2: API Tool Bundle

Define an API with an OpenAPI spec. Each `operationId` becomes a separately callable tool.

```yaml
tools:
  my-api:
    type: api
    headers:
      Authorization: "Bearer ${API_TOKEN}"
    spec:
      openapi: 3.0.0
      servers: [{ url: "https://api.example.com" }]
      paths:
        /users:
          get:
            operationId: list_users
            parameters:
              - name: limit
                in: query
                schema: { type: integer }
            responses: { "200": { description: OK } }
        /users/{id}:
          get:
            operationId: get_user
            parameters:
              - name: id
                in: path
                required: true
                schema: { type: string }
            responses: { "200": { description: OK } }
```

This generates two tools: `list_users` and `get_user`. Use them in workflow steps:

```yaml
steps:
  fetch:
    type: mcp
    transport: custom
    method: get_user
    methodArgs:
      id: "{{ inputs.user_id }}"
```

Or expose to AI:

```yaml
steps:
  chat:
    type: ai
    ai_custom_tools: [my-api]    # AI sees list_users and get_user
```

### Level 3: Shared Tools via `extends`

When multiple workflows use the same API, extract tools into a shared file:

```yaml
# tools/api.yaml — shared tools, no steps
tools:
  my-api:
    type: api
    headers:
      Authorization: "Bearer ${API_TOKEN}"
    spec:
      openapi: 3.0.0
      servers: [{ url: "https://api.example.com" }]
      paths:
        /users: ...
        /users/{id}: ...
        /posts: ...
```

Each workflow extends it and adds only its custom logic:

```yaml
# workflows/get-user.yaml
extends: ../tools/api.yaml

id: get-user
inputs:
  - name: user_id
    required: true

steps:
  fetch:
    type: mcp
    transport: custom
    method: get_user
    methodArgs:
      id: "{{ inputs.user_id }}"
```

```yaml
# workflows/list-posts.yaml
extends: ../tools/api.yaml

id: list-posts
steps:
  fetch:
    type: mcp
    transport: custom
    method: list_posts
```

**Benefits:**
- Define API endpoints once
- Each workflow only contains its custom logic
- `extends` path is relative to the workflow file
- Tools, steps, env, and other config are deep-merged

### Level 4: Workflow Tool (inline)

Define a multi-step tool directly in the `tools:` section. The workflow is inlined — no separate file needed.

```yaml
tools:
  # Raw API tool
  my-api:
    type: api
    spec: ...

  # Multi-step composite tool
  smart-lookup:
    type: workflow
    name: smart-lookup
    description: Look up a user by email or ID
    inputs:
      - name: identifier
        required: true
        schema: { type: string }
    steps:
      resolve:
        type: script
        content: |
          const id = inputs.identifier;
          if (id.includes('@')) {
            return { type: 'email', value: id };
          }
          return { type: 'id', value: id };
      fetch:
        type: mcp
        transport: custom
        method: get_user
        depends_on: [resolve]
        methodArgs:
          id: "{{ outputs['resolve'].value }}"
```

**When to use inline vs file:**
- **Inline**: Small tools (2-3 steps), tightly coupled to the parent config
- **File**: Complex tools needing their own tests, reused across configs

### Level 5: Workflow Tool (file reference)

Reference an existing workflow file or registered workflow ID as a tool:

```yaml
tools:
  send-notification:
    type: workflow
    workflow: workflows/notify.yaml    # file path

  run-analysis:
    type: workflow
    workflow: data-analysis            # registry ID (must be imported)
```

### Level 6: Toolkit Reference

Load all tools from a file with a single reference:

```yaml
# In a skill or config
tools:
  all-slack:
    toolkit: tools/slack-toolkit.yaml
```

Where the toolkit file contains multiple tool definitions:

```yaml
# tools/slack-toolkit.yaml
tools:
  slack-api:
    type: api
    spec: ...              # generates 5 MCP tools

  send-dm:
    type: workflow
    workflow: send-dm       # registered workflow

  read-thread:
    type: workflow          # inline workflow
    steps: ...
```

One `toolkit:` reference → all tools from that file are expanded into the parent.

**With overrides** — apply properties to every expanded tool:

```yaml
all-slack:
  toolkit: tools/slack-toolkit.yaml
  blockedMethods: ["files_delete"]    # applied to each tool
```

## Exposing Tools to AI Agents

### Direct: `ai_custom_tools`

Reference tools by name on an AI step:

```yaml
steps:
  chat:
    type: ai
    ai_custom_tools: [git-status, my-api, smart-lookup]
```

### Dynamic: `ai_custom_tools_js`

Compute tools at runtime based on previous step outputs:

```yaml
steps:
  chat:
    type: ai
    ai_custom_tools_js: |
      const tools = ['git-status'];
      if (outputs['route'].needs_api) {
        tools.push({ workflow: 'data-analysis', args: { mode: 'fast' } });
      }
      return tools;
```

### Via Skills (assistant pattern)

Skills bundle tools + knowledge and activate based on user intent:

```yaml
# skills.yaml
- id: devops
  description: user wants to check CI, deploy, or manage infrastructure
  tools:
    # Object format (explicit)
    ci-status:
      workflow: ci-status
    deploy:
      workflow: deploy
      inputs: { env: staging }
  knowledge: |
    ## DevOps Tools
    - ci-status: Check CI pipeline status
    - deploy: Deploy to staging/production
```

**Array shorthand** — auto-resolves names from the workflow registry:

```yaml
- id: devops
  tools:
    - ci-status
    - deploy
```

**Toolkit reference** — load all tools from a file:

```yaml
- id: devops
  tools:
    devops:
      toolkit: tools/devops-toolkit.yaml
```

### Via MCP Servers

External MCP servers (stdio, SSE, HTTP):

```yaml
- id: jira
  tools:
    jira:
      command: uvx
      args: ["mcp-atlassian"]
      env:
        JIRA_URL: "${JIRA_URL}"
```

## Tool Types Comparison

| Type | Definition | Execution | Use Case |
|------|-----------|-----------|----------|
| `command` | `exec: "shell command"` | Shell execution | Git, file ops, scripts |
| `api` | `spec: { openapi spec }` | HTTP request | REST APIs |
| `workflow` (inline) | `steps: { ... }` | Workflow engine | Multi-step with custom logic |
| `workflow` (ref) | `workflow: id-or-path` | Workflow engine | Reusable complex operations |
| MCP server | `command: ...` or `url: ...` | External process | Third-party tools |

## File Organization Patterns

### Flat (simple projects)

```
workflows/
  my-workflow.yaml       # tools + steps + tests all in one
```

### Grouped by domain (recommended)

```
workflows/
  slack/
    api.yaml             # shared API definitions
    send-dm.yaml         # extends api.yaml
    search.yaml          # extends api.yaml
    read-thread.yaml     # extends api.yaml
  jira/
    api.yaml
    create-issue.yaml
    update-status.yaml
```

### Toolkit pattern (advanced)

```
tools/
  slack-toolkit.yaml     # all Slack tools in one file
  jira-toolkit.yaml      # all Jira tools in one file
config/
  skills.yaml            # references toolkits
```

## Testing

Workflows with tests are defined inline:

```yaml
tests:
  defaults:
    strict: true           # all steps must be covered
    ai_provider: mock      # no real AI/API calls

  cases:
    - name: happy-path
      event: manual
      fixture: local.minimal
      workflow_input:
        user_id: "U123"
      mocks:
        fetch-user:          # mock the MCP API response
          ok: true
          user: { id: "U123", name: "Alice" }
      expect:
        calls:
          - step: fetch-user
            exactly: 1
        workflow_output:
          - path: result.success
            equals: true
          - path: result.user.name
            equals: "Alice"
```

Run tests:

```bash
visor test --config workflows/slack/send-dm.yaml          # single file
visor test --config workflows/slack/                       # all in directory
visor test                                                 # all discovered
```

## How Tools Flow to the AI Agent

```
Config (tools: section)
  ↓
extends / imports              ← merge tools from parent configs / register workflows
  ↓
Skill activation               ← route-intent selects skills based on user message
  ↓
build-config                   ← merges activated skill tools into mcp_servers
  ↓
ai_mcp_servers_js              ← passes tool configs to AI step
  ↓
CustomToolsSSEServer           ← wraps tools as MCP endpoints (ephemeral HTTP server)
  ↓
ProbeAgent (AI)                ← calls tools via MCP protocol during conversation
```

## Quick Reference

| Want to... | Use... |
|-----------|--------|
| Call a shell command as a tool | `type: command` with `exec:` |
| Call a REST API | `type: api` with OpenAPI `spec:` |
| Share API definitions across workflows | `extends: shared-tools.yaml` |
| Add custom logic around API calls | Workflow with `type: mcp` + `type: script` steps |
| Define inline multi-step tool | `type: workflow` with `steps:` in tools section |
| Reference existing workflow as tool | `type: workflow` with `workflow: id-or-path` |
| Expose tool to AI step | `ai_custom_tools: [tool-name]` |
| Expose tools via skills | `tools: { my-tool: { workflow: my-workflow } }` |
| Load all tools from a file | `toolkit: path/to/tools.yaml` |
| List tools as simple names | Array syntax: `tools: ['tool-a', 'tool-b']` |
