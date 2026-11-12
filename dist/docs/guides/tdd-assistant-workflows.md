# Test-Driven Development for Assistant Workflows

Build and iterate on AI assistant workflows using visor's test framework. This guide covers the full cycle: define your workflow, write tests with mocks, then run against real AI to iterate on prompt quality and assertions.

## The TDD Cycle

1. **Define the workflow** — skills, tools, knowledge, intents
2. **Write tests with mocks** — expected conversations and assertions
3. **Run with mocks** — validate structure, routing, and assertion logic
4. **Run with `--no-mocks`** — real AI + real tools, iterate on quality
5. **Refine** — fix prompts, relax over-strict assertions, improve knowledge

## Setting Up

### Project Structure

```
my-assistant/
├── assistant.yaml           # main workflow config
├── config/
│   └── skills.yaml          # skill definitions
├── docs/
│   └── api-reference.md     # knowledge docs for skills
├── tests/
│   └── skills.tests.yaml    # test file
└── .env                     # API tokens (not committed)
```

### Test File Basics

Test files extend your main config:

```yaml
# tests/skills.tests.yaml
version: "1.0"
extends: "../assistant.yaml"

tests:
  defaults:
    strict: false    # required for --no-mocks (internal steps run without expectations)

  cases:
    - name: basic-question
      conversation:
        routing: { max_loops: 2 }
        turns:
          - role: user
            text: "What services do we run?"
            mocks:
              chat:
                text: "We run 3 services: API gateway, dashboard, and pump."
                intent: chat
                skills: []
            expect:
              outputs:
                - step: chat
                  path: text
                  matches: "(?i)gateway|dashboard|pump"
```

Key fields:
- **`extends`** — imports the full workflow so the test runner knows all steps, skills, and routing
- **`strict: false`** — prevents failures from internal steps (routing, config building) that don't have assertions
- **`conversation`** — sugar syntax that auto-expands turns into flow stages with message history

## Writing Conversation Tests

### Single-Turn Test

The simplest test: one user message, assert on the response.

```yaml
- name: greeting
  conversation:
    routing: { max_loops: 2 }
    turns:
      - role: user
        text: "Hello, who are you?"
        mocks:
          chat:
            text: "I'm your engineering assistant. I can help with code, deployments, and more."
            intent: chat
            skills: []
        expect:
          calls:
            - step: chat
              exactly: 1
          outputs:
            - step: chat
              path: text
              matches: "(?i)assistant|help"
```

### Multi-Turn Conversation

Each turn's history automatically includes previous turns. Mock response text becomes assistant messages in subsequent turns.

```yaml
- name: code-explore-then-explain
  conversation:
    routing: { max_loops: 2 }
    turns:
      - role: user
        text: "Find the authentication middleware in the backend service"
        mocks:
          chat:
            text: "Found `auth.go` in `internal/middleware/`. It checks JWT tokens."
            intent: chat
            skills: [code-explorer]
        expect:
          outputs:
            - step: chat
              path: text
              matches: "(?i)auth|middleware"

      - role: user
        text: "Explain how the JWT validation works in that auth middleware you found"
        mocks:
          chat:
            text: "The middleware extracts the Bearer token, validates the signature..."
            intent: chat
            skills: [code-explorer]
        expect:
          llm_judge:
            - step: chat
              turn: current
              path: text
              prompt: "Does the response explain JWT validation with technical details?"
              schema:
                properties:
                  explains_jwt:
                    type: boolean
                required: [explains_jwt]
              assert:
                explains_jwt: true
```

### Mock Response Format

Mocks simulate what the `chat` step returns:

```yaml
mocks:
  chat:
    text: "The response text..."
    intent: chat              # which intent was classified
    skills: [code-explorer]   # which skills were activated
```

Use **fictional data** in mocks. The mock text becomes the assistant message in subsequent turn history.

## Assertion Types

### Regex Matching (`outputs`)

Pattern-match on response fields:

```yaml
expect:
  outputs:
    - step: chat
      path: text
      matches: "(?i)kubernetes|k8s"
    - step: chat
      turn: current        # only check this turn's output
      path: text
      matches: "(?i)deploy"
```

### Call Counting (`calls`)

Assert how many times a step ran:

```yaml
expect:
  calls:
    - step: chat
      exactly: 1
```

### LLM Judge (`llm_judge`)

Semantic evaluation — assert on meaning, not exact text. This is the most powerful assertion for AI responses:

```yaml
expect:
  llm_judge:
    - step: chat
      turn: current
      path: text
      prompt: |
        Does the response provide a clear architectural overview
        with component names and their responsibilities?
      schema:
        properties:
          names_components:
            type: boolean
            description: "Names specific components or services?"
          explains_responsibilities:
            type: boolean
            description: "Explains what each component does?"
        required: [names_components, explains_responsibilities]
      assert:
        names_components: true
        explains_responsibilities: true
```

The judge returns a JSON object matching your schema. `assert` checks specific fields. You can include fields in the schema for observability without asserting them.

### Cross-Turn Assertions

Reference previous turns using `turn: N` (1-based):

```yaml
# In turn 2, verify turn 1 was good too
expect:
  llm_judge:
    - step: chat
      turn: current
      path: text
      prompt: "Does turn 2 build on the context from turn 1?"
      ...
    - step: chat
      turn: 1
      path: text
      prompt: "Did turn 1 provide a good foundation?"
      ...
```

## Running Tests

```bash
# Validate structure (no AI calls)
visor test --config tests/skills.tests.yaml

# Run a single case
visor test --config tests/skills.tests.yaml --case basic-question

# Run with real AI and real tools
visor test --config tests/skills.tests.yaml --no-mocks

# Real AI, single case
visor test --config tests/skills.tests.yaml --case basic-question --no-mocks

# Debug mode
visor test --config tests/skills.tests.yaml --case basic-question --no-mocks --debug
```

### Mock vs No-Mock Mode

| | Mock mode | `--no-mocks` |
|--|-----------|-------------|
| AI calls | Mocked responses | Real AI provider |
| Tools | Not called | Real tool execution |
| `routing.max_loops` | Use `0` | Use `2+` (AI needs iterations for tool calls) |
| `strict` | Can be `true` | Must be `false` (internal steps fire) |
| Speed | Fast (seconds) | Slow (AI latency + tool calls) |
| Use for | Structure validation, CI | Prompt quality iteration |

## Iterating with `--no-mocks`

This is where the real work happens. Common issues and fixes:

### AI ignores tool guidance

**Symptom:** AI calls wrong endpoint, uses wrong arguments, or skips required steps.

**Fix:** Improve the knowledge doc with explicit instructions:

```yaml
# In your skill knowledge:
knowledge: |
  ### Important: Always search by project ID
  When looking up items, **always** use `/projects/{id}/items`
  — never the global `/items` endpoint which returns all projects.
```

Also make user prompts more specific:

```yaml
# Before (too vague):
text: "List the items in review"

# After (explicit):
text: "List the items in review stage for the Backend project"
```

### Assertion too strict for real responses

**Symptom:** Mock includes specific details but real AI response formats them differently.

**Fix:** Keep the field in the schema for observability but remove from `assert`:

```yaml
schema:
  properties:
    lists_items:
      type: boolean
    includes_links:
      type: boolean
      description: "Includes profile links?"
  required: [lists_items, includes_links]
assert:
  lists_items: true
  # includes_links intentionally not asserted — real API
  # doesn't always return this without extra calls
```

### Turn 2 loses context from Turn 1

**Symptom:** AI asks "which items?" instead of referencing turn 1 results.

**Fix:** Make follow-up prompts self-contained:

```yaml
# Before:
text: "Now compare these candidates"

# After:
text: "Now compare the 3 candidates you just evaluated for the SRE role"
```

### `strict: false` not working

**Symptom:** Test fails with "Step executed without expect: chat.route-intent".

**Fix:** `strict: false` must be at the **test case level** or in `tests.defaults`, not inside `conversation:`:

```yaml
# Wrong — ignored by conversation sugar:
conversation:
  strict: false
  turns: ...

# Correct — applied to expanded flow stages:
- name: my-test
  strict: false
  conversation:
    turns: ...

# Or set globally:
tests:
  defaults:
    strict: false
```

## Example: Adding an API Integration Skill

Here's a complete example adding an external REST API as a skill.

### 1. Define the Skill

```yaml
# config/skills.yaml
- id: hr-system
  description: |
    request relates to recruiting, hiring pipeline, candidates,
    job postings, or HR pipeline management.
    Examples: "list candidates", "show open positions", "evaluate candidate"
  tools:
    hr-api:
      type: http_client
      base_url: "https://api.hr-system.com/v3"
      auth:
        type: bearer
        token: "${HR_API_TOKEN}"
      headers:
        Content-Type: "application/json"
  knowledge: |
    {% readfile "docs/hr-api-reference.md" %}
```

### 2. Write the Knowledge Doc

```markdown
## HR API Reference

Call the `hr-api` tool with these arguments:

| Argument | Required | Description |
|----------|----------|-------------|
| `path`   | yes      | API path (e.g. `/jobs`, `/candidates/{id}`) |
| `method` | no       | HTTP method (default: `GET`) |
| `query`  | no       | Query parameters |
| `body`   | no       | Request body for POST/PUT |

### Endpoints

| Operation | Method | Path |
|-----------|--------|------|
| List jobs | GET | `/jobs` |
| List candidates | GET | `/jobs/{id}/candidates` |
| Get candidate | GET | `/jobs/{id}/candidates/{cid}` |

### Important
Always use job-specific endpoints (`/jobs/{id}/candidates`)
— never the global `/candidates` endpoint.
```

### 3. Write Tests

```yaml
# tests/hr.tests.yaml
version: "1.0"
extends: "../assistant.yaml"

tests:
  defaults:
    strict: false

  cases:
    - name: hr-pipeline-stats
      description: "Show candidate counts per pipeline stage"
      conversation:
        routing: { max_loops: 2 }
        turns:
          - role: user
            text: "Show me candidate statistics per stage for the SRE role"
            mocks:
              chat:
                text: |
                  Pipeline for **Site Reliability Engineer**:
                  | Stage | Count |
                  |-------|-------|
                  | Sourced | 12 |
                  | Applied | 8 |
                  | Screening | 5 |
                intent: chat
                skills: [hr-system]
            expect:
              outputs:
                - step: chat
                  path: text
                  matches: "(?i)sourced|applied|screen"
              llm_judge:
                - step: chat
                  turn: current
                  path: text
                  prompt: |
                    Does the response show candidates broken down
                    by pipeline stage with numbers?
                  schema:
                    properties:
                      has_stage_breakdown:
                        type: boolean
                      covers_multiple_stages:
                        type: boolean
                  assert:
                    has_stage_breakdown: true
                    covers_multiple_stages: true
```

### 4. Iterate

```bash
# First: validate test structure
visor test --config tests/hr.tests.yaml

# Then: run against real AI + API
visor test --config tests/hr.tests.yaml --no-mocks

# Iterate on a specific failing case
visor test --config tests/hr.tests.yaml --case hr-pipeline-stats --no-mocks --debug
```

Each iteration typically involves:
1. Run `--no-mocks` and read the failure
2. Fix the knowledge doc (wrong endpoint? missing guidance?) or the user prompt (too vague?)
3. Relax assertions that are too strict for real responses
4. Re-run until green

## Example: MCP Command Tool Skill

Skills can also use external MCP servers:

```yaml
# config/skills.yaml
- id: jira
  description: |
    request relates to Jira issues, tickets, sprints, or project tracking.
  tools:
    atlassian:
      command: uvx
      args: [mcp-atlassian]
      env:
        JIRA_URL: "${JIRA_URL}"
        JIRA_API_TOKEN: "${JIRA_API_TOKEN}"
      allowedMethods: [jira_get_issue, jira_search, jira_create_issue]
  knowledge: |
    You have access to Jira via the atlassian MCP tool.
    Use `jira_search` with JQL queries to find issues.
    Use `jira_get_issue` with an issue key like `PROJ-123`.
```

Test the same way — conversation sugar works identically regardless of tool type.

## Checklist

When adding a new skill with tests:

- [ ] Add skill to `config/skills.yaml` with description, tools, and knowledge
- [ ] Write knowledge doc in `docs/` (be explicit about which endpoints/methods to use)
- [ ] Add secrets to `.env`
- [ ] Create `tests/<skill>.tests.yaml` with `extends`
- [ ] Write first test case with mocks — run `visor test` to validate
- [ ] Run with `--no-mocks` — iterate on knowledge doc and prompts
- [ ] Add multi-turn tests for complex flows
- [ ] Relax assertions that are too strict for real responses

## Related Documentation

- [Getting Started](../testing/getting-started.md) — test framework basics
- [DSL Reference](../testing/dsl-reference.md) — complete test YAML schema
- [Assertions](../testing/assertions.md) — all assertion types including LLM judge
- [Flows](../testing/flows.md) — multi-stage tests and conversation sugar
- [Fixtures and Mocks](../testing/fixtures-and-mocks.md) — mock format reference
- [Cookbook](../testing/cookbook.md) — copy-pasteable test recipes
- [Assistant Workflows](../assistant-workflows.md) — skills, intents, and tool types
- [Tools & Toolkits](../tools-and-toolkits.md) — tool definition reference
