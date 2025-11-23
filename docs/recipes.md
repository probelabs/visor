## 📚 Examples & Recipes

### Minimal `.visor.yaml` starter
```yaml
version: "1.0"
steps:
  security:
    type: ai
    schema: code-review
    prompt: "Identify security vulnerabilities in changed files"
```

- Fast local pre-commit hook (Husky)
```bash
npx husky add .husky/pre-commit "npx -y @probelabs/visor@latest --tags local,fast --output table || exit 1"
```

### Chat-like workflows (human-input + ai)

Minimal chat loop (CLI/SDK):

```yaml
version: "1.0"

checks:
  ask:
    type: human-input
    group: chat
    prompt: |
      Please type your message.

  reply:
    type: ai
    group: chat
    depends_on: ask
    ai:
      disableTools: true
      allowedTools: []
      system_prompt: "You are general assistant, follow user instructions."
    prompt: |
      You are a concise, friendly assistant.

      Conversation so far (oldest → newest):
      {% assign history = '' | chat_history: 'ask', 'reply' %}
      {% for m in history %}
      {{ m.role | capitalize }}: {{ m.text }}
      {% endfor %}

      Latest user message:
      {{ outputs['ask'].text }}

      Reply naturally. Keep it short (1–2 sentences).

    guarantee: "(output?.text ?? '').length > 0"
    on_success:
      goto: ask
```

Notes:
- `ask` (human-input) produces `{ text, ts }` by default.
- `reply` (ai) responds and loops back to `ask`.
- `chat_history('ask','reply')` merges both histories by timestamp with roles:
  - `type: human-input` → `role: "user"`
  - `type: ai` → `role: "assistant"`

Slack chat using the same pattern:

```yaml
version: "1.0"

slack:
  version: "v1"
  mentions: all
  threads: required

frontends:
  - name: slack
    config:
      summary:
        enabled: false

checks:
  ask:
    type: human-input
    group: chat
    prompt: |
      Please type your message. (Posted only when the workflow is waiting.)

  reply:
    type: ai
    group: chat
    depends_on: ask
    ai:
      disableTools: true
      allowedTools: []
      # For chat-style Slack flows you can optionally turn off
      # automatic PR/issue + Slack XML context and rely solely on
      # chat_history + conversation objects:
      # skip_transport_context: true
    prompt: |
      You are a concise, friendly assistant.

      Conversation so far (oldest → newest):
      {% assign history = '' | chat_history: 'ask', 'reply' %}
      {% for m in history %}
      {{ m.role | capitalize }}: {{ m.text }}
      {% endfor %}

      Latest user message:
      {{ outputs['ask'].text }}

      Reply naturally. Keep it short (1–2 sentences).

    guarantee: "(output?.text ?? '').length > 0"
    on_success:
      goto: ask
```

Runtime behavior:
- First Slack message in a thread:
  - Treated as `ask` input.
  - `reply` posts into the same thread.
  - Engine loops to `ask`, posts a prompt, and saves a snapshot.
- Next Slack message in the same thread:
  - Resumes from snapshot.
  - `ask` consumes the new message.
  - `reply` posts a new answer and loops again.

Accessing normalized conversation context in prompts:

```liquid
{% if conversation %}
  Transport: {{ conversation.transport }}  {# 'slack', 'github', ... #}
  Thread: {{ conversation.thread.id }}
  {% for m in conversation.messages %}
    {{ m.user }} ({{ m.role }}): {{ m.text }}
  {% endfor %}
{% endif %}
```

- Under Slack, `conversation` and `slack.conversation` are the same
  normalized object.
- Under GitHub (PR/issue), `conversation` is built from the body +
  comment history using the same `{ role, user, text, timestamp }`
  structure.

Customizing chat_history (roles, text, limits):

```liquid
{% assign history = '' |
   chat_history:
     'ask',
     'clarify',
     'reply',
     direction: 'asc',
     limit: 50,
     text: {
       default_field: 'text',
       by_step: {
         'summarize': 'summary.text'
       }
     },
     roles: {
       by_step: {
         'summarize': 'system'
       }
     },
     role_map: 'ask=user,reply=assistant'
%}
{% for m in history %}
  [{{ m.step }}][{{ m.role }}] {{ m.text }}
{% endfor %}
```

Quick reference:
- `direction: 'asc' | 'desc'`, `limit: N`
- `text.default_field`, `text.by_step[step]`
- `roles.by_step[step]`, `roles.by_type[type]`, `roles.default`
- `role_map: 'step=role,other=role'` as a compact override

See also:
- `docs/human-input-provider.md`
- `docs/liquid-templates.md` (Chat History Helper)
- `docs/output-history.md`
- `examples/slack-simple-chat.yaml`

### Advanced routing & contracts (general patterns)

#### Inner loops vs. closing the loop

- **Close the loop**: Leaf steps use `on_success: goto: <entry-step>` to end the workflow and return to a single top-level `human-input`. Each new event (Slack message, webhook, CLI run) starts a fresh execution.
- **Close the loop**: Leaf steps use `on_success: goto: <entry-step>` to end the workflow and return to a single top-level `human-input`. Each new event (Slack message, webhook, CLI run) starts a fresh execution.
- **Inner loop**: Add a local `human-input` and route inside a sub‑flow:
  - Example shape: `router → section-confirm → section-answer → section-confirm`.
  - Use a control field (e.g. `output.done === true`) in `transitions` to exit the section back to the top-level entry step.
- This pattern is transport-agnostic and works for Slack, GitHub, HTTP workflows, etc.
- See: `examples/slack-simple-chat.yaml` for a concrete implementation of both patterns.

#### Declarative routing (`transitions`) instead of JS

- Prefer `on_success.transitions` / `on_finish.transitions` for branching:
  ```yaml
  on_success:
    transitions:
      - when: "output && output.intent === 'chat'"
        to: chat-answer
      - when: "output && output.intent === 'project_help'"
        to: project-intent
  ```
- Reserve `goto_js` / `run_js` for legacy or very dynamic use cases.
- More details: `docs/guides/fault-management-and-contracts.md`, `docs/loop-routing-refactor.md`.

- Pattern A — central router + transitions (explicit routing):
  - Use a single “router” step that sets control fields (e.g. `output.intent`, `output.kind`).
  - Declare all branching in one place via `on_success.transitions` on the router:
    ```yaml
    router:
      type: ai
      on_success:
        transitions:
          - when: "output.intent === 'chat'"
            to: chat-answer
          - when: "output.intent === 'status'"
            to: status-answer

    chat-answer:
      depends_on: [router]
      if: "outputs['router']?.intent === 'chat'"

    status-answer:
      depends_on: [router]
      if: "outputs['router']?.intent === 'status'"
    ```
  - Good when you want a single, centralized view of routing logic. Use `if` on branches for readability and to skip branches cleanly; reserve `assume` for hard dependency checks only.

- Pattern B — distributed routing via `depends_on` + `if`:
  - Omit transitions entirely and let each branch decide whether it should run:
    ```yaml
    router:
      type: ai
      # no on_success.transitions

    chat-answer:
      depends_on: [router]
      if: "outputs['router']?.intent === 'chat'"

    status-answer:
      depends_on: [router]
      if: "outputs['router']?.intent === 'status'"
    ```
  - The DAG (`depends_on`) defines possible flows; `if` conditions select the active branch(es) per run.
  - This works well when routing is simple or when you prefer fully local branch declarations over a central router table.

#### Criticality + `assume` + `guarantee` (recommended layout)

- Apply to **any** workflow, not just chat:
  - `external` – step changes **external state**:
    - Examples: GitHub comments/labels, HTTP POST/PUT/PATCH/DELETE, ticket creation, updating CI/CD or incident systems, filesystem writes in a shared location.
    - If someone can look elsewhere and see a change after this step, it’s usually `external`.
  - `internal` – step changes **the workflow’s control-plane**:
    - Examples: forEach parents that fan out work; steps with `on_* transitions/goto` that decide what runs next; script/memory steps that set flags used by `if`/`assume`/`guarantee`.
    - If it mostly “steers” the run (not user-facing output), treat it as `internal`.
  - `policy` – step enforces **org or safety rules**:
    - Examples: permission checks (who may deploy/label), change windows, compliance checks (branches, commit format, DCO/CLA).
    - Often used to gate `external` steps (e.g. only label when policy passes).
  - `info` – read-only / non-critical:
    - Examples: summaries, hints, dashboards, advisory AI steps that do not gate other critical steps and do not mutate anything directly.
- For `internal` / `external` steps, group fields in this order:
  ```yaml
  some-step:
    type: ai | script | command | ...
    group: ...
    depends_on: [...]
    criticality: internal    # or external / policy / info
    assume:
      - "upstream condition"       # never reference this step's own output here
    guarantee: "output?.field != null"   # assertions about this step's output
    schema:                           # JSON Schema when output is structured
      ...
  ```
- Use `assume` for preconditions about upstream state (memory, env, `outputs[...]`).
- Use `guarantee` for postconditions about this step’s own output (shape, control flags, size caps).
- For `info` steps, contracts are recommended but optional; keep `assume` + `guarantee` adjacent when present.
- More details: `docs/guides/criticality-modes.md`, `docs/guides/fault-management-and-contracts.md`.

#### JSON Schemas instead of `schema: plain`

- For structured outputs (routers, script integrations, control signals), prefer real JSON Schema:
  ```yaml
  router-step:
    schema:
      type: object
      properties:
        intent:
          type: string
          enum: [chat, summarize, escalate]
        target:
          type: string
      required: [intent]
  ```
- For text responses, it can still be useful to wrap in an object:
  ```yaml
  answer:
    schema:
      type: object
      properties:
        text: { type: string }
      required: [text]
    guarantee: "(output?.text ?? '').length > 0"
  ```
- Use `schema: plain` only when output shape is genuinely unconstrained.

Tip: When you define a JSON Schema, you generally do **not** need to tell the model “respond only as JSON”; describe the semantics in the prompt and let the renderer/schema enforce shape.

#### Expression style (`assume`, `guarantee`, `when`)

- Prefer clear, concise expressions:
  - `outputs['router']?.intent === 'chat'`
  - `!!outputs['status-fetch']?.project`
  - `output?.done === true`
- Avoid noisy fallbacks like `(outputs['x']?.kind ?? '') === 'status'` when `outputs['x']?.kind === 'status'` is equivalent.
- These conventions apply uniformly to any provider (`ai`, `command`, `script`, `github`, `http_client`, etc).

### More examples

- `docs/NPM_USAGE.md` – CLI usage and flags  
- `GITHUB_CHECKS.md` – Checks, outputs, and workflow integration  
- `examples/` – MCP, Jira, and advanced configs
