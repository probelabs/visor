---
name: visor-agent-dev
description: Guide for building and extending visor AI assistants. Use when creating new skills, workflows, checks, or modifying assistant.yaml configurations. Covers the full development loop including YAML tests, config validation, real provider testing, and trace debugging.
argument-hint: [goal or skill description]
allowed-tools: Read, Grep, Glob, Bash, Edit, Write, Agent
---

# Visor Agent Development Skill

You are helping the user build or extend a visor-based AI assistant. Follow this structured workflow to ensure correctness, safety, and iterability.

## SAFETY RULES — READ FIRST

1. **NEVER run with real providers (`--no-mocks`) without user confirmation.** Real runs consume API credits and may trigger external side effects.
2. **NEVER modify or delete existing production configs** (e.g., the main `.visor.yaml` or `tyk-assistant.yaml`) without explicit user approval. Work on copies or new files.
3. **NEVER commit API keys, tokens, or secrets** into YAML files. Use `${ENV_VAR}` references.
4. **NEVER add `allowed_commands` patterns** like `rm:*`, `sudo:*`, `chmod:*`, or other destructive shell patterns to skills.
5. **NEVER run `visor` with `--slack`, `--telegram`, `--a2a`, or other runner flags** unless the user explicitly asks — these connect to live services.
6. **Ask before running any command that hits external APIs** (MCP servers, HTTP clients, etc.).
7. When writing `disallowed_commands` for skills, always include: `rm:*`, `sudo:*`, `shutdown:*`, `reboot:*`, `mkfs:*`, `dd:*`.

## RUNNING VISOR

All commands in this skill use `npx -y @probelabs/visor@latest` (aliased as `visor` below for brevity). When executing commands, **always use the full npx form** so it works out of the box without a global install:

```bash
npx -y @probelabs/visor@latest <command> [flags]
```

If the user has visor installed globally or as a project dependency, they may tell you to use `visor` directly — follow their preference.

## DEVELOPMENT WORKFLOW

Follow these steps in order. The goal is: **write tests first → validate config → iterate with mocks → graduate to real providers → debug with traces.**

### Step 1: Understand the Goal

Ask the user what they want to build:
- A new **skill** (knowledge + tools bundle for the assistant)?
- A new **workflow** (reusable multi-step pipeline)?
- A new **check** (standalone analysis step)?
- A modification to an existing assistant?

Study the existing assistant structure:
- Read the main assistant YAML (e.g., `assistant.yaml` or project-specific one)
- Read `config/skills.yaml`, `config/intents.yaml`, `config/projects.yaml` if they exist
- Read relevant `docs/` files for context on existing skills
- Look at `defaults/assistant.yaml` and `defaults/skills/` for built-in patterns

### Step 2: Write YAML Tests First

**Always start by writing tests.** Create a `*.tests.yaml` file:

```yaml
version: "1.0"
extends: ../assistant.yaml  # or path to your config

tests:
  defaults:
    strict: false
    ai_provider: mock

  cases:
    - name: skill-activates-on-relevant-question
      description: "Verify the new skill activates when expected"
      conversation:
        turns:
          - role: user
            text: "Your test question here"
            mocks:
              chat:
                text: "Expected AI response pattern"
                intent: chat
                skills: [your-new-skill]
            expect:
              calls:
                - step: chat
                  exactly: 1
              outputs:
                - step: chat
                  path: text
                  matches: "(?i)expected pattern"

    - name: skill-does-not-activate-irrelevant
      description: "Verify skill stays inactive for unrelated questions"
      conversation:
        turns:
          - role: user
            text: "Unrelated question"
            mocks:
              chat:
                text: "Generic response"
                intent: chat
                skills: []
            expect:
              outputs:
                - step: chat
                  path: skills
                  # Should NOT contain your skill
```

**Test assertion types:**
- `calls` — verify which steps ran and how many times
- `outputs` — check output values with `equals`, `matches` (regex), `contains`
- `prompts` — verify what was sent to AI with `contains` patterns
- `llm_judge` — use LLM to semantically evaluate responses

### Step 3: Validate Configuration

Run the linter to catch syntax/schema errors early:

```bash
npx -y @probelabs/visor@latest validate --config path/to/your-config.yaml
```

Fix any errors before proceeding. Common issues:
- Missing `version: "1.0"` at top
- Indentation errors in YAML
- Invalid check type names
- Missing required fields (`prompt` for ai checks, `exec` for command checks)

### Step 4: Run Tests with Mocks

**Run all cases in a test file:**
```bash
npx -y @probelabs/visor@latest test path/to/your.tests.yaml
```

**Run a single test case by name:**
```bash
npx -y @probelabs/visor@latest test path/to/your.tests.yaml --only "case-name"
# or equivalently:
npx -y @probelabs/visor@latest test path/to/your.tests.yaml --case "case-name"
```

The `--only` filter is a **case-insensitive substring match** — `--only "skill"` will match all cases whose name contains "skill".

**Run a specific stage within a multi-stage test case:**
```bash
npx -y @probelabs/visor@latest test path/to/your.tests.yaml --only "case-name#stage-name"
```

The `#` separator filters to a specific stage (e.g., conversation turn) within the case.

**Run all tests from a directory (auto-discovers `*.tests.yaml` files):**
```bash
npx -y @probelabs/visor@latest test tests/                    # discover all test files in tests/
npx -y @probelabs/visor@latest test .                         # discover from current directory
npx -y @probelabs/visor@latest test                           # same as above (default: cwd)
```

**Run multiple test suites in parallel:**
```bash
npx -y @probelabs/visor@latest test tests/ --max-suites 4     # run up to 4 test files simultaneously
```

**Control parallelism of checks within a single suite:**
```bash
npx -y @probelabs/visor@latest test path/to/your.tests.yaml --max-parallel 2
```

**Debugging options:**
```bash
npx -y @probelabs/visor@latest test path/to/your.tests.yaml --debug           # verbose output: mock matching, step execution
npx -y @probelabs/visor@latest test path/to/your.tests.yaml --bail             # stop on first failure
npx -y @probelabs/visor@latest test path/to/your.tests.yaml --progress detailed # detailed per-case output
npx -y @probelabs/visor@latest test path/to/your.tests.yaml --json results.json # structured JSON report
npx -y @probelabs/visor@latest test path/to/your.tests.yaml --report junit:results.xml  # JUnit XML for CI
npx -y @probelabs/visor@latest test path/to/your.tests.yaml --summary md:results.md     # Markdown summary
```

**Discovery and validation only (no execution):**
```bash
npx -y @probelabs/visor@latest test --list                    # list all discovered test cases
npx -y @probelabs/visor@latest test path/ --list              # list cases from specific path
npx -y @probelabs/visor@latest test --validate                # validate test YAML syntax only
```

**Typical iteration pattern — run one case at a time:**
```bash
# 1. List available cases to find the right name
npx -y @probelabs/visor@latest test path/to/your.tests.yaml --list

# 2. Run the specific case you're working on
npx -y @probelabs/visor@latest test path/to/your.tests.yaml --only "my-case" --debug

# 3. Once that passes, run all cases
npx -y @probelabs/visor@latest test path/to/your.tests.yaml

# 4. If a case fails, re-run just that case with debug
npx -y @probelabs/visor@latest test path/to/your.tests.yaml --only "failing-case" --debug --bail
```

Iterate on both the config and tests until all cases pass with mocks.

### Step 5: Run with Real Providers (ask user first!)

> **⚠️ IMPORTANT: Always ask the user before running this step.** Real provider runs cost money and may have side effects.

**Run all cases with real AI providers (no mocks at all):**
```bash
npx -y @probelabs/visor@latest test path/to/your.tests.yaml --no-mocks
```

**Selectively unmock only specific checks** (comma-separated list):
```bash
npx -y @probelabs/visor@latest test path/to/your.tests.yaml --no-mocks-for chat,route-intent
```
This uses real AI for `chat` and `route-intent` but keeps mocks for everything else.

**Combine with single-case targeting for cost control:**
```bash
npx -y @probelabs/visor@latest test path/to/your.tests.yaml --only "my-case" --no-mocks-for chat
```

**What `--no-mocks` does automatically:**
- Disables mock AI providers — uses real API calls (requires `GOOGLE_API_KEY`, `ANTHROPIC_API_KEY`, or `OPENAI_API_KEY`)
- Auto-enables telemetry — traces are written to `./output/traces/` as NDJSON
- Sets `VISOR_TEST_MODE=true` and increases history limits

### Step 6: Interactive Testing with --message

For conversational testing beyond YAML test suites — sends a real message through the full assistant pipeline:

```bash
npx -y @probelabs/visor@latest --config path/to/your-config.yaml --message "Your test question"
```

**`--message` automatically enables task tracking** — a task is created in the SQLite task store (`.visor/agent-tasks.db`). After execution, use `npx -y @probelabs/visor@latest tasks list` to find the task ID and inspect it.

**You can also pass a file as the message:**
```bash
npx -y @probelabs/visor@latest --config path/to/your-config.yaml --message "file:path/to/message.txt"
```

**The message is available in templates as:**
- `{{ conversation.current.text }}` — the message text
- `{{ conversation.messages }}` — full message array
- `{{ conversation.thread.id }}` — thread ID (auto-generated: `cli-<timestamp>`)

**For interactive multi-turn testing with the TUI:**
```bash
npx -y @probelabs/visor@latest --config path/to/your-config.yaml --message "Your question" --tui
```

**Enable debug output alongside `--message`:**
```bash
npx -y @probelabs/visor@latest --config path/to/your-config.yaml --message "Your question" --debug
```

**Typical flow: message → task ID → trace:**
```bash
# 1. Send a test message
npx -y @probelabs/visor@latest --config assistant.yaml --message "How does authentication work?"

# 2. Find the task ID
npx -y @probelabs/visor@latest tasks list

# 3. Inspect what happened
npx -y @probelabs/visor@latest tasks show <task-id>
npx -y @probelabs/visor@latest tasks trace <task-id> --full
```

### Step 7: Debug with Traces

After running with `--message` or `--no-mocks`, inspect execution traces:

```bash
# List recent tasks
npx -y @probelabs/visor@latest tasks list

# Show task details (use full ID or prefix)
npx -y @probelabs/visor@latest tasks show <task-id>

# View execution trace tree
npx -y @probelabs/visor@latest tasks trace <task-id>

# Full trace without truncation
npx -y @probelabs/visor@latest tasks trace <task-id> --full

# JSON format for programmatic analysis
npx -y @probelabs/visor@latest tasks trace <task-id> --output json
```

**What to look for in traces:**
- Which skills were activated (`route-intent` step outputs)
- Which MCP tools were called and their responses
- Step durations (performance bottlenecks)
- Error spans (failed steps with error attributes)
- `visor.check.id` and `visor.check.type` attributes

### Step 8: Evaluate Response Quality

For completed tasks, run LLM-based evaluation:

```bash
npx -y @probelabs/visor@latest tasks evaluate <task-id>
```

Or batch-evaluate recent tasks:
```bash
npx -y @probelabs/visor@latest tasks evaluate --last 10 --state completed
```

## CONFIGURATION PATTERNS

### Adding a New Skill

Skills go in `config/skills.yaml` (or inline in the assistant YAML):

```yaml
- id: my-new-skill
  description: "needs to [what triggers this skill]"
  # Dependencies — auto-activated when this skill is active
  requires: [code-explorer]
  # Knowledge injected into AI context
  knowledge: |
    ## My Skill Instructions

    When the user asks about X, follow these steps:
    1. First do A
    2. Then do B
    3. Return results in format C

    ### Important constraints
    - Never do D
    - Always verify E before F
  # Tools available when this skill is active
  tools:
    my-tool:
      command: npx
      args: [my-mcp-server]
      env:
        API_KEY: "${MY_API_KEY}"
      allowedMethods:
        - safe_read_method
        - safe_search_method
      blockedMethods:
        - delete_*
        - admin_*
  # Bash safety (optional)
  allowed_commands: ['grep:*', 'find:*', 'cat:*']
  disallowed_commands: ['rm:*', 'sudo:*', 'shutdown:*', 'reboot:*', 'mkfs:*', 'dd:*']
  # Set true to always activate regardless of classification
  always: false
```

### Adding a Workflow

Workflows are reusable multi-step pipelines in separate YAML files:

```yaml
version: "1.0"
id: my-workflow
name: My Workflow
description: Does X by combining steps A, B, C

inputs:
  - name: query
    required: true
    description: The input to process

steps:
  fetch-data:
    type: mcp
    transport: custom
    method: search
    methodArgs:
      query: "{{ inputs.query }}"

  process:
    type: ai
    depends_on: [fetch-data]
    prompt: |
      Process this data: {{ outputs['fetch-data'] | json }}

outputs:
  - name: result
    value_js: "return outputs?.['process']?.text ?? null;"
```

Register as a tool in a skill:
```yaml
tools:
  my-workflow-tool:
    workflow: my-workflow
    inputs: {}
```

### Adding a New Intent

Intents go in `config/intents.yaml`:

```yaml
- id: my-intent
  description: "user wants to [specific action]"
  default_skills: [my-skill-1, my-skill-2]
```

### Knowledge Files

Store detailed instructions in `docs/my-feature.md` and reference from skills:

```yaml
knowledge: |
  {% readfile "docs/my-feature.md" %}
```

## REFERENCE: KEY COMMANDS

All commands use `npx -y @probelabs/visor@latest` (shown as `visor` for brevity):

| Command | Purpose |
|---------|---------|
| `visor validate --config <path>` | Validate YAML config syntax and schema |
| `visor test <path>` | Run YAML test suite |
| `visor test <path> --only "case"` | Run single test case (substring match) |
| `visor test <path> --only "case#stage"` | Run specific stage within a case |
| `visor test <path> --list` | List discovered test cases without running |
| `visor test <path> --no-mocks` | Run with real AI providers (costs money!) |
| `visor test <path> --no-mocks-for <checks>` | Selectively use real providers |
| `visor test <path> --debug` | Verbose test output |
| `visor test <path> --bail` | Stop on first failure |
| `visor test <path> --max-suites N` | Run N test files in parallel |
| `visor --config <path> --message "text"` | Interactive single-message test |
| `visor --config <path> --message "text" --tui` | Interactive TUI mode |
| `visor tasks list` | List all tasks |
| `visor tasks show <id>` | Show task details |
| `visor tasks trace <id>` | Show execution trace tree |
| `visor tasks trace <id> --full` | Full trace without truncation |
| `visor tasks evaluate <id>` | Evaluate response quality |
| `visor init assistant` | Scaffold a new assistant config |

## REFERENCE: REAL AGENT EXAMPLE

Study the Oel assistant at `../refine/Oel/` for a production example:

```
Oel/
├── tyk-assistant.yaml          # Main entry (imports below)
├── config/
│   ├── intents.yaml            # 3 intents: chat, evaluate_ticket, release_notes
│   ├── skills.yaml             # 25+ skills with tools & knowledge
│   └── projects.yaml           # Repository catalog
├── docs/                       # 30+ knowledge files (3,600+ lines)
│   ├── code-exploration-tool.md
│   ├── engineer-tool.md
│   ├── jira-tools.md
│   └── ...
├── workflows/                  # Reusable pipelines
│   ├── refinement.yaml
│   ├── slack/
│   │   ├── slack-send-dm.yaml
│   │   └── slack-search.yaml
│   └── ...
└── tests/                      # YAML test suites
    ├── workable.tests.yaml
    └── ...
```

## DEBUGGING TIPS

1. **Use `log()` in JavaScript expressions** — outputs with 🔍 prefix:
   ```yaml
   fail_if: "log('Skills:', outputs['route-intent']?.skills); return false;"
   ```

2. **Use `{{ outputs | json }}` in Liquid templates** to dump state.

3. **Use a `logger` check** to inspect intermediate values:
   ```yaml
   checks:
     debug:
       type: logger
       depends_on: [previous-step]
       message: "Outputs: {{ outputs | json }}"
   ```

4. **Enable debug mode:** `npx -y @probelabs/visor@latest --debug --config ...`

5. **Check trace spans** for timing and error details: `npx -y @probelabs/visor@latest tasks trace <id> --full`

## ITERATIVE DEVELOPMENT LOOP

```
┌──────────────────────────────────────────────────────────────────┐
│  1. Write/update tests (.tests.yaml)                             │
│  2. npx -y @probelabs/visor@latest validate --config ...         │
│  3. npx -y @probelabs/visor@latest test ... (with mocks)         │
│  4. Fix config, re-test                                          │
│  5. Ask user → ... test --no-mocks                               │
│  6. ... --message "..." (interactive)                            │
│  7. ... tasks trace <id> (debug)                                 │
│  8. Iterate until working                                        │
└──────────────────────────────────────────────────────────────────┘
```

When the user describes their goal ($ARGUMENTS), start at Step 1 and work through the loop systematically.
