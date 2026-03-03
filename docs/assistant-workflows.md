# Assistant Workflows

Three composable workflows for building AI-powered assistants, bundled with Visor:

| Workflow | Purpose |
|----------|---------|
| [**assistant**](#assistant) | Full AI assistant with skills, tools, knowledge, and bash commands |
| [**code-talk**](#code-talk) | Multi-project code exploration with references and confidence scoring |
| [**intent-router**](#intent-router) | Intent classification and skill/tag selection |

Import them using the `visor://` protocol:

```yaml
imports:
  - visor://assistant.yaml
```

## Quick Start

```yaml
version: "1.0"

imports:
  - visor://assistant.yaml

checks:
  ask:
    type: human-input
    prompt: "How can I help?"

  chat:
    type: workflow
    depends_on: [ask]
    workflow: assistant
    args:
      question: "{{ outputs['ask'].text }}"
      system_prompt: "You are a helpful engineering assistant."
      intents:
        - id: chat
          description: general Q&A or small talk
        - id: code_help
          description: questions about code or architecture
          default_skills: [code-explorer]
      skills:
        - id: code-explorer
          description: needs codebase exploration or code search
          tools:
            code-talk:
              workflow: code-talk
              inputs:
                projects:
                  - id: backend
                    repo: my-org/backend
                    description: Backend API service
          allowed_commands: ['git:log:*', 'git:diff:*']
    on_success:
      goto: ask
```

Run it:
```bash
visor run config.yaml --tui
# or
visor run config.yaml --message "How does authentication work?"
```

---

## assistant

High-level AI assistant workflow. Combines intent routing, dynamic skill activation, tool orchestration, knowledge injection, and bash command control into a single declarative configuration.

### How It Works

```
User message
    |
    v
[1. route-intent]       -- classify intent + select skills
    |
    v
[2. build-config]       -- add intent default skills, expand dependencies, collect tools/knowledge/bash
    |
    v
[3. generate-response]  -- AI generates response with dynamic tools + knowledge
    |
    v
Output: { text, intent, tags, topic }
```

### Inputs

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `question` | string | yes | | The user's message |
| `intents` | array | yes | | Intent definitions for routing (`[{id, description, default_skills?}]`) |
| `skills` | array | no | `[]` | Skill definitions (recommended over tags) |
| `tags` | array | no | `[]` | Tag definitions (legacy, use skills instead) |
| `knowledge` | array | no | `[]` | Standalone knowledge blocks (legacy) |
| `mcp_servers` | array | no | `[]` | Standalone MCP servers (legacy) |
| `system_prompt` | string | no | `"You are a helpful AI assistant..."` | System prompt for the AI |
| `guidelines` | string | no | `""` | Additional guidelines appended to the prompt |
| `routing_instructions` | string | no | `""` | Extra instructions for the intent classifier |
| `history` | array | no | `[]` | Conversation history (`[{role, text}]`) |
| `max_iterations` | number | no | `30` | Maximum AI tool-use iterations |

### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `text` | string | The AI's response |
| `intent` | string | Classified intent ID |
| `tags` | array | Classified tag/skill IDs |
| `topic` | string | Rewritten question (1-2 sentences) |

### Skills

Skills are the core building block. Each skill bundles a description (for classification), knowledge (for context), tools (for capabilities), and bash permissions (for command access) into a single unit.

```yaml
skills:
  - id: code-explorer
    description: needs codebase exploration or implementation details
    knowledge: |
      You can explore code across multiple repositories.
      Always cite file paths and line numbers.
    tools:
      code-talk:
        workflow: code-talk
        inputs:
          projects:
            - id: backend
              repo: my-org/backend
              description: Backend API
    allowed_commands: ['git:log:*', 'git:show:*', 'git:diff:*']

  - id: engineer
    description: user wants code changes, a PR, or a feature implemented
    requires: [code-explorer]  # auto-activates code-explorer
    tools:
      engineer:
        workflow: engineer
        inputs: {}
    allowed_commands: ['git:*', 'npm:*']
    disallowed_commands: ['git:push:--force', 'git:reset:--hard']
```

#### Skill Fields

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `id` | string | yes | Unique identifier (used for classification and `requires`) |
| `description` | string | yes | When this skill should activate (the classifier reads this) |
| `knowledge` | string | no | Context injected into the AI prompt when active |
| `tools` | object | no | Tools available when active (see [Tool Types](#tool-types)) |
| `requires` | array | no | Other skill IDs to auto-activate alongside this one |
| `allowed_commands` | array | no | Bash patterns this skill can run (e.g. `['git:log:*']`) |
| `disallowed_commands` | array | no | Bash patterns this skill must not run (e.g. `['git:push:--force']`) |

#### Skill Activation

1. The user sends a message
2. The intent-router classifies the intent and selects relevant skills based on their `description` fields
3. `default_skills` from the selected intent are always added
4. `requires` dependencies are expanded recursively (cycles handled, diamonds deduplicated)
5. For each active skill:
   - Knowledge is injected into the AI prompt (wrapped in `<skill>` XML blocks)
   - Tools are added to the AI's available MCP servers
   - Bash allow/deny patterns are collected and applied

#### Tool Types

Skills support three types of tools:

**Workflow tools** - call another Visor workflow:
```yaml
tools:
  code-talk:
    workflow: code-talk
    inputs:
      projects:
        - id: backend
          repo: my-org/backend
```

**MCP command tools** - run an external MCP server process:
```yaml
tools:
  atlassian:
    command: uvx
    args: [mcp-atlassian]
    env:
      JIRA_URL: "${JIRA_URL}"
      JIRA_API_TOKEN: "${JIRA_API_TOKEN}"
    allowedMethods: [jira_get_issue, jira_search, jira_create_issue]
```

**Built-in tools** - tools provided by the Visor runtime:
```yaml
tools:
  scheduler:
    tool: schedule
```

When multiple skills expose the same server name, their `allowedMethods` are merged (duplicates removed).

#### Bash Command Patterns

Patterns use colon-separated segments with glob support:

| Pattern | Matches |
|---------|---------|
| `git:log:*` | `git log`, `git log --oneline`, etc. |
| `git:*` | Any git command |
| `npm:test` | Only `npm test` |
| `docker:*` | Any docker command |
| `git:push:--force` | Specifically `git push --force` (for deny) |

When skills are activated, all their `allowed_commands` are collected into a single allow list and all `disallowed_commands` into a deny list. Deny takes precedence over allow.

### Intents

Intents are broad routing categories. Keep them general (3-6 intents is typical):

```yaml
intents:
  - id: chat
    description: general Q&A, follow-up questions, small talk
  - id: code_help
    description: questions about code, implementation, or architecture
    default_skills: [code-explorer]
  - id: task
    description: create, update, or execute something
```

`default_skills` ensures specific skills are always active for that intent, even if the classifier returns no skills.

### Knowledge Injection

There are two ways to inject knowledge:

**Via skills (recommended):**
```yaml
skills:
  - id: onboarding
    description: questions about onboarding, setup, or getting started
    knowledge: |
      ## Onboarding Guide
      1. Clone the repo: git clone ...
      2. Install deps: npm install
      3. Run tests: npm test
```

Knowledge can be loaded from files using `{% readfile %}`:
```yaml
skills:
  - id: architecture
    description: questions about system architecture or design
    knowledge: |
      {% readfile "docs/architecture.md" %}
```

**Via standalone knowledge blocks (legacy):**
```yaml
knowledge:
  - tags: [onboarding]
    content: |
      ## Onboarding Guide
      ...
  - intent: code_help
    content: |
      ## Code Guidelines
      ...
```

### Standalone MCP Servers (Legacy)

For tag/intent-conditional MCP servers without skills:

```yaml
mcp_servers:
  - tags: [jira]
    name: atlassian
    server:
      command: uvx
      args: [mcp-atlassian]
      env:
        JIRA_URL: "${JIRA_URL}"
  - tags: [confluence]
    name: atlassian-confluence
    server:
      command: uvx
      args: [mcp-atlassian]
      env:
        CONFLUENCE_URL: "${CONFLUENCE_URL}"
```

### Explicit Markers

Users can override classification with markers in their message:

- **`#skill`** - force a skill to activate: `"Deploy the app #devops"`
- **`%intent`** - force an intent: `"What is this? %code_help"`

Markers are stripped from the rewritten topic.

### Full Example

```yaml
version: "1.0"

imports:
  - visor://assistant.yaml

slack:
  version: "v1"
  mentions: all
  threads: required

checks:
  chat:
    type: workflow
    workflow: assistant
    assume: ["true"]
    args:
      question: "{{ conversation.current.text }}"

      system_prompt: |
        You are an engineering assistant for Acme Corp.
        You can explore code, manage Jira tickets, and help with deployments.

      intents:
        - id: chat
          description: general Q&A, follow-up questions, small talk
        - id: code_help
          description: questions about code, architecture, or implementation
          default_skills: [code-explorer]
        - id: task
          description: create, update, or execute something

      skills:
        - id: capabilities
          description: user asks what this assistant can do
          knowledge: |
            I can explore code across repos, search Jira tickets,
            and help with code changes via PRs.

        - id: code-explorer
          description: needs codebase exploration or code search
          tools:
            code-talk:
              workflow: code-talk
              inputs:
                projects:
                  - id: backend
                    repo: acme/backend
                    description: Go backend API
                  - id: frontend
                    repo: acme/frontend
                    description: React frontend
          allowed_commands: ['git:log:*', 'git:show:*', 'git:diff:*']

        - id: engineer
          description: user wants code changes, a PR, or a feature
          requires: [code-explorer]
          tools:
            engineer:
              workflow: engineer
              inputs: {}
          allowed_commands: ['git:*', 'npm:*']
          disallowed_commands: ['git:push:--force', 'git:reset:--hard']

        - id: jira
          description: mentions Jira, ticket IDs like PROJ-123, or needs ticket info
          tools:
            atlassian:
              command: uvx
              args: [mcp-atlassian]
              env:
                JIRA_URL: "${JIRA_URL}"
                JIRA_API_TOKEN: "${JIRA_API_TOKEN}"
              allowedMethods: [jira_get_issue, jira_search, jira_create_issue]
    on_success:
      goto: chat
```

---

## code-talk

AI-powered code exploration workflow. Routes questions to relevant repositories, checks out code, explores it with specialized tools (search, extract, delegate), and returns answers with file references and confidence scoring.

### How It Works

```
Question + project list
    |
    v
[1. checkout-docs]      -- shallow-clone documentation repo
    |
    v
[2. route-projects]     -- AI selects which projects to explore
    |
    v
[3. checkout-projects]  -- shallow-clone selected repos (parallel)
    |
    v
[4. explore-code]       -- AI explores code with tools + bash
    |
    v
Output: { answer, references, confidence, projects_explored }
```

### Inputs

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `question` | string | yes | | The code question to answer |
| `architecture` | string | yes | | Architecture description (file path or inline markdown) |
| `docs_repo` | string | yes | | Documentation repo (`owner/name`) |
| `projects` | array | yes | | Available projects (`[{id, repo, description}]`) |
| `docs_ref` | string | no | `"main"` | Git ref for the docs repository |
| `max_projects` | number | no | `3` | Maximum code repos to checkout (excludes docs) |
| `routing_prompt` | string | no | `""` | Additional instructions for project routing |
| `exploration_prompt` | string | no | `""` | Additional instructions for code exploration |
| `ai_model` | string | no | | Override AI model for exploration |

### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `answer` | object | `{text: string, summary?: string}` - the answer with references |
| `references` | array | Code references with file, lines, URL, snippet |
| `confidence` | string | `"high"`, `"medium"`, or `"low"` |
| `confidence_reason` | string | Why confidence is not high (empty when high) |
| `projects_explored` | array | List of explored project IDs |
| `projects_explored_details` | array | `[{id, repo, description, reason}]` |

#### Reference Format

Each reference in the `references` array:

```json
{
  "project": "backend",
  "file": "src/auth/jwt.go",
  "lines": [42, 50],
  "url": "https://github.com/org/repo/blob/main/src/auth/jwt.go#L42-L50",
  "snippet": "JWT validation middleware"
}
```

The `answer.text` always ends with a `## References` section containing clickable links.

#### Confidence Scoring

| Level | Meaning |
|-------|---------|
| `high` | Claims directly backed by code/documentation evidence |
| `medium` | Some evidence found but investigation has gaps |
| `low` | Insufficient evidence or significant ambiguity |

`confidence_reason` explains what's missing when confidence is not high.

### Exploration Capabilities

The AI has access to:

- **Code tools**: search, extract, query, listFiles, searchFiles
- **Delegate tool**: spawn sub-agents for deep investigation of specific components
- **Git commands**: `log`, `diff`, `show`, `blame`, `checkout`, `branch`, `tag`, `fetch`, `status`, `ls-files`
- **GitHub CLI**: `gh pr view`, `gh pr diff`, `gh pr checks`, `gh issue view`, `gh run view --log`, `gh api`
- **File tools**: `ls`, `find`, `cat`, `head`, `tail`, `wc`, `grep`

Shallow clones are handled automatically - the AI fetches specific branches/tags as needed.

### Usage

#### As a Standalone Workflow

```yaml
imports:
  - visor://code-talk.yaml

checks:
  explore:
    type: workflow
    workflow: code-talk
    args:
      question: "How does the rate limiter work?"
      architecture: |
        # Architecture
        ## Projects
        | ID | Description |
        |----|-------------|
        | gateway | API gateway with rate limiting |
        | backend | Core business logic |
      docs_repo: my-org/docs
      projects:
        - id: gateway
          repo: my-org/gateway
          description: API gateway with middleware, rate limiting, auth
        - id: backend
          repo: my-org/backend
          description: Core business logic and data layer
      max_projects: 2
```

#### As a Skill Tool in Assistant

```yaml
skills:
  - id: code-explorer
    description: needs codebase exploration or code search
    tools:
      code-talk:
        workflow: code-talk
        inputs:
          architecture: |
            # Project Architecture
            ...
          docs_repo: my-org/docs
          projects:
            - id: backend
              repo: my-org/backend
              description: Backend API
```

#### As an AI Custom Tool

```yaml
checks:
  assistant:
    type: ai
    prompt: "Help the user with technical questions."
    ai_custom_tools:
      - workflow: code-talk
        args:
          architecture: "# Architecture description"
          projects:
            - id: my-project
              repo: my-org/my-repo
              description: Main codebase
          max_projects: 1
```

See `examples/code-talk-workflow.yaml` and `examples/code-talk-as-tool.yaml`.

---

## intent-router

Lightweight intent classification workflow. Classifies the user's intent, rewrites the request as a short question, and selects relevant skills or tags. Used internally by the assistant workflow, but can also be used standalone for custom routing.

### How It Works

```
User message + intent/skill catalog
    |
    v
[1. classify]  -- AI picks intent, rewrites question, selects skills
    |
    v
Output: { intent, topic, skills/tags }
```

### Inputs

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `question` | string | yes | | The user's message to classify |
| `intents` | array | yes | | Intent definitions (`[{id, description}]`) |
| `skills` | array | no | `[]` | Skill definitions (`[{id, description, requires?}]`) |
| `tags` | array | no | `[]` | Tag definitions (`[{id, description}]`) - legacy |
| `routing_instructions` | string | no | `""` | Additional routing rules |

When both `skills` and `tags` are provided, `skills` takes precedence.

### Outputs

| Field | Type | Description |
|-------|------|-------------|
| `intent` | string | Selected intent ID |
| `topic` | string | Short rewritten question (ends with `?`) |
| `skills` | array | Selected skill IDs (when using skills mode) |
| `tags` | array | Selected tag IDs (when using tags mode) |
| `raw` | object | Full classifier output |
| `error` | string\|null | Error if explicit `%intent` marker was invalid |

### Skills vs Tags

**Skills (recommended)** support a `requires` array for dependency chains. When a skill is selected, the assistant workflow automatically expands its dependencies.

```yaml
skills:
  - id: engineer
    description: user wants code changes or a PR
    requires: [code-explorer]  # auto-activates code-explorer too
  - id: code-explorer
    description: needs codebase exploration
```

**Tags (legacy)** are flat identifiers with no dependency support:

```yaml
tags:
  - id: codebase
    description: needs code context
  - id: jira
    description: needs Jira access
```

### Explicit Markers

Users can force classification with markers in their message:

| Marker | Effect | Example |
|--------|--------|---------|
| `#skill_id` | Forces that skill to be selected | `"Deploy it #devops"` |
| `%intent_id` | Forces that intent to be used | `"Help me %code_help"` |

Markers are stripped from the topic output. Invalid `%intent` markers produce an error in the `error` output field.

### Conversation Context

The router respects Slack/GitHub thread context:
- Short follow-ups ("ok", "do it", "yes") are understood as continuations
- Pronoun references ("it", "this", "that") are connected to recent context
- The topic is reconstructed with full context from the thread

### Usage

#### Standalone Routing

```yaml
imports:
  - visor://intent-router.yaml

checks:
  route:
    type: workflow
    workflow: intent-router
    args:
      question: "{{ outputs['ask'].text }}"
      intents:
        - id: chat
          description: general Q&A or small talk
        - id: code_help
          description: questions about code, debugging, or architecture
        - id: task
          description: create, update, or execute something
      skills:
        - id: jira
          description: request references Jira tickets or needs Jira data
        - id: code-explorer
          description: needs codebase exploration or implementation details

  # Route to different handlers based on intent
  handle-chat:
    type: ai
    depends_on: [route]
    if: "outputs.route.intent === 'chat'"
    prompt: "Answer: {{ outputs.route.topic }}"

  handle-code:
    type: workflow
    depends_on: [route]
    if: "outputs.route.intent === 'code_help'"
    workflow: code-talk
    args:
      question: "{{ outputs.route.topic }}"
      ...
```

See `examples/intent-router-workflow.yaml`.

---

## Composition Patterns

### Pattern 1: Assistant with Multiple Skills

The most common pattern. The assistant workflow handles routing, skill activation, and response generation internally:

```yaml
workflow: assistant
args:
  question: "{{ message }}"
  intents:
    - id: chat
      description: general Q&A
    - id: code_help
      description: code questions
      default_skills: [code-explorer]
    - id: task
      description: create or execute something
  skills:
    - id: code-explorer
      description: needs code exploration
      tools:
        code-talk:
          workflow: code-talk
          inputs: { projects: [...] }
      allowed_commands: ['git:log:*', 'git:diff:*']

    - id: jira
      description: needs Jira access
      tools:
        atlassian:
          command: uvx
          args: [mcp-atlassian]
          env: { JIRA_URL: "${JIRA_URL}" }

    - id: engineer
      description: wants code changes
      requires: [code-explorer]
      tools:
        engineer:
          workflow: engineer
          inputs: {}
      allowed_commands: ['git:*', 'npm:*']
      disallowed_commands: ['git:push:--force']
```

### Pattern 2: Custom Routing with intent-router

Use intent-router directly when you need custom post-routing logic:

```yaml
checks:
  route:
    type: workflow
    workflow: intent-router
    args:
      question: "{{ message }}"
      intents:
        - id: summarize
          description: summarize a thread
        - id: code_help
          description: code questions
      skills:
        - id: jira
          description: needs Jira
        - id: codebase
          description: needs code context

  # Different workflows per intent
  summarize:
    depends_on: [route]
    if: "outputs.route.intent === 'summarize'"
    type: ai
    prompt: "Summarize the thread."

  explore:
    depends_on: [route]
    if: "outputs.route.intent === 'code_help'"
    type: workflow
    workflow: code-talk
    args:
      question: "{{ outputs.route.topic }}"
      ...
```

### Pattern 3: Code Exploration as an On-Demand Tool

Let the AI decide when to explore code:

```yaml
checks:
  assistant:
    type: ai
    prompt: "Help the user with their question: {{ message }}"
    ai_custom_tools:
      - workflow: code-talk
        args:
          projects:
            - id: backend
              repo: my-org/backend
              description: Backend API
```

The AI calls the code-talk tool only when it needs code context, rather than exploring on every message.

---

## Deployment Modes

All workflows support:

| Mode | Command |
|------|---------|
| **CLI (single message)** | `visor run config.yaml --message "Hello"` |
| **CLI (interactive TUI)** | `visor run config.yaml --tui` |
| **Slack bot** | `visor run config.yaml --slack` |
| **GitHub Action** | Use `@probelabs/visor-action` |

---

## Examples

| File | Description |
|------|-------------|
| `examples/code-talk-workflow.yaml` | Standalone code exploration |
| `examples/code-talk-as-tool.yaml` | Code exploration as an AI tool |
| `examples/intent-router-workflow.yaml` | Intent routing with conditional handlers |
