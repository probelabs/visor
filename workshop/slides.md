---
title: Visor — SDLC Automation & Code Review Orchestrator
separator: ^---$
verticalSeparator: ^--$
theme: black
css: custom.css
revealOptions:
  transition: slide
  slideNumber: true
  hash: true
  controls: true
  progress: true
  center: true
  width: 1280
  height: 720
  margin: 0.04
  minScale: 0.2
  maxScale: 2.0
---

<style>
.reveal h1 {
  font-size: 2.5em !important;
  font-weight: bold !important;
  color: #00D9FF !important;
  text-transform: uppercase !important;
  letter-spacing: 0.05em !important;
  margin-bottom: 0.5em !important;
  text-shadow: 2px 2px 4px rgba(0,0,0,0.5) !important;
  word-wrap: break-word !important;
  hyphens: auto !important;
}

.reveal h2 {
  font-size: 1.6em !important;
  font-weight: 600 !important;
  color: #7B68EE !important;
  margin-bottom: 0.8em !important;
  border-bottom: 3px solid #7B68EE !important;
  padding-bottom: 0.3em !important;
  display: block !important;
  word-wrap: break-word !important;
  hyphens: auto !important;
  overflow-wrap: break-word !important;
}

.reveal h3 {
  font-size: 1.2em !important;
  font-weight: 500 !important;
  color: #9ACD32 !important;
  margin-bottom: 0.6em !important;
  word-wrap: break-word !important;
  hyphens: auto !important;
}

.reveal p, .reveal ul, .reveal ol {
  font-size: 0.85em !important;
  line-height: 1.6 !important;
  color: #D3D3D3 !important;
}

.reveal pre {
  font-size: 0.45em !important;
  box-shadow: 0 5px 15px rgba(0,0,0,0.3) !important;
}

.reveal code {
  background: rgba(255,255,255,0.1) !important;
  padding: 0.2em 0.4em !important;
  border-radius: 3px !important;
}

.reveal pre code {
  background: transparent !important;
  padding: 0 !important;
}

.reveal strong {
  color: #FFD700 !important;
  font-weight: bold !important;
}
</style>

# Visor Workshop

Open‑source SDLC automation and code review orchestration.

<div style="display: flex; gap: 2em; font-size: 0.7em; margin-top: 1.5em;">

<div style="flex: 1;">

**What you'll learn:**
- Set up AI-powered code reviews with GitHub Actions
- Build custom workflows (release notes, audits, integrations)
- Orchestrate check pipelines with dependencies
- Integrate with Jira, Zendesk via MCP
- Debug and extend Visor

</div>

<div style="flex: 1;">

**After this workshop:**
- Deploy Visor to automate PR reviews in minutes
- Create custom checks for your codebase
- Build SDLC workflows beyond code review

</div>

</div>

Note:
- You can press `S` to open speaker notes during the talk.
- Use left/right for sections, up/down for deeper dives.

--

## Presenting This Deck

```bash
npm run workshop:setup   # one time; pins reveal-md
npm run workshop:serve   # starts local server (watch mode)
# Exports
npm run workshop:export  # static HTML → workshop/build
npm run workshop:pdf     # PDF → workshop/Visor-Workshop.pdf
```

Note:
`workshop:pdf:a4` is available too; `workshop:pdf:ci` adds Puppeteer flags.

--

## Agenda (Iceberg Format)

<div style="font-size: 0.75em;">

- Surface: What Visor is and quick start
- Layer 1: Core concepts and defaults
- Layer 2: Code review pipeline
- Layer 3: Customizing (tags, dependencies, templates)
- Layer 4: Architecture & internals
- Layer 5: SDLC automations (webhooks, HTTP, Jira)
- Layer 6: Nested runs, foreach/loops
- Layer 7: Debugging, logging, observability
- Layer 8: Extending providers and recipes

</div>

Note:
Keep the tempo brisk on surface levels; dive vertically where the room shows interest.

---

# What Is Visor?

<div style="max-width: 900px; margin: 0 auto;">

Config‑first automation for code review and SDLC workflows
with native GitHub checks/annotations.

<div style="text-align: left; margin-top: 1.2em; font-size: 0.75em;">

- Runs locally as a CLI and in CI/GitHub Actions
- Produces structured, predictable outputs (JSON, Markdown, SARIF)
- Composable checks with dependencies, tags, and templates
- Multi‑provider AI (or no‑AI) and HTTP/command integrations

</div>
</div>

Note:
“Orchestration” is the keyword: Visor coordinates checks, dependencies, and outputs; it does not hide logic.

--

## 90‑Second Quick Start

<div style="font-size: 0.65em; text-align: left; max-width: 900px; margin: 0 auto;">

**GitHub Action:**
```yaml
# .github/workflows/visor.yml
name: Visor
on: [pull_request, issues, issue_comment]
permissions:
  contents: read
  pull-requests: write
  issues: write
  checks: write
jobs:
  visor:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: probelabs/visor@v1
        env:
          GOOGLE_API_KEY: ${{ secrets.GOOGLE_API_KEY }}
```

**CLI:** `npx -y @probelabs/visor --output table`

</div>

Note:
The defaults live in `defaults/.visor.yaml`. Override with `.visor.yaml` in your project.

--

## What You Get Out of the Box

<div style="font-size: 0.7em; text-align: left; max-width: 900px; margin: 0 auto;">

**PR Code Reviews** — Security, performance, quality, and style analysis with GitHub check runs and `/review` commands

**Issue Assistant** — AI-powered triage, classification, and labeling suggestions

**Release Notes Generator** — Automatic release notes from git history and commits

**All Configurable** — Override defaults with `.visor.yaml`, customize checks and prompts

</div>

Note:
Everything works immediately after installation with sensible defaults. Customize only what you need.

--

## Lab 0 — First Run (2 min)

<div style="font-size: 0.75em; text-align: left; max-width: 1000px; margin: 0 auto;">

**1) Run defaults locally (all checks):**
```bash
npx -y @probelabs/visor --output table --debug
```

**2) Try JSON output to a file:**
```bash
npx -y @probelabs/visor --check security --output json --output-file visor-results.json
```

**3) Filter by tags (fast/local):**
```bash
npx -y @probelabs/visor --tags local,fast --max-parallelism 5
```

</div>

Note:
If no AI key is set, use mock provider via CLI flags in your demos.

---

# Core Concepts

The building blocks of Visor configuration

--

## Checks: Units of Work

<div style="font-size: 0.7em; text-align: left; max-width: 1000px; margin: 0 auto;">

A **check** is a single unit of work in your workflow:

```yaml
checks:
  security:
    type: ai
    prompt: "Find security vulnerabilities"
```

**Each check:**
- Has a unique name (`security`, `performance`, etc.)
- Executes via a provider (`ai`, `command`, `http`)
- Produces output (findings, data, results)
- Can depend on other checks
- Runs independently or in a dependency chain

**Use cases:** Code review, tests, linting, API calls, logging

</div>

--

## Providers: Execution Engines

<div style="font-size: 0.7em; text-align: left; max-width: 1000px; margin: 0 auto;">

**Provider** determines how a check executes:

```yaml
checks:
  ai-review:    { type: ai }        # AI analysis (Probe)
  run-tests:    { type: command }   # Shell command
  notify-slack: { type: http }      # HTTP webhook
  debug-log:    { type: logger }    # Structured logging
```

**Available providers:**
- `ai` — AI-powered analysis (Gemini, Claude, OpenAI, Bedrock)
- `command` — Execute shell commands/scripts
- `http` / `http_client` — Send/receive HTTP requests
- `logger` — Debug logging without side effects
- `noop` — Synchronization/orchestration point

</div>

--

## Dependencies: Execution Order

<div style="font-size: 0.7em; text-align: left; max-width: 1000px; margin: 0 auto;">

**`depends_on`** defines check execution order:

```yaml
checks:
  security:
    type: ai
    # Runs first (no dependencies)

  performance:
    type: ai
    depends_on: [security]  # Waits for security
    prompt: "Previous findings: {{ outputs['security'] | json }}"
```

**How it works:**
- Independent checks run in **parallel**
- Dependent checks wait for their dependencies
- Access outputs via `{{ outputs['check-name'] }}`
- Build complex workflows with dependency graphs

</div>

--

## Tags: Filter and Organize

<div style="font-size: 0.7em; text-align: left; max-width: 1000px; margin: 0 auto;">

**Tags** organize checks for selective execution:

```yaml
checks:
  quick-security:
    type: ai
    tags: [local, fast, security]

  comprehensive-audit:
    type: ai
    tags: [comprehensive, security]
```

**Run specific tags:**
```bash
# Fast local checks only
npx -y @probelabs/visor --tags local,fast

# Comprehensive checks
npx -y @probelabs/visor --tags comprehensive
```

**Common tag patterns:** `local`, `fast`, `comprehensive`, `security`, `ci`, `manual`

</div>

--

## Schemas: Structure Output

<div style="font-size: 0.7em; text-align: left; max-width: 1000px; margin: 0 auto;">

**Schema** defines output structure (JSON Schema):

```yaml
checks:
  custom-check:
    type: ai
    schema:
      type: object
      properties:
        issues:
          type: array
          items:
            type: string
```

**Special `code-review` schema:**
```yaml
checks:
  security:
    schema: code-review  # Required for GitHub annotations
```

**Enables:** GitHub check runs, inline annotations at file:line:column

</div>

--

## Groups: Organize Comments

<div style="font-size: 0.7em; text-align: left; max-width: 1000px; margin: 0 auto;">

**Groups** organize GitHub PR comments:

```yaml
checks:
  overview:
    type: ai
    group: overview  # Posted as separate comment

  security:
    type: ai
    group: review    # Grouped with other review checks
```

**Default groups:**
- `overview` — High-level summary
- `review` — Detailed findings
- `custom-group` — Your own grouping

**Result:** Clean, organized PR comments instead of spam

</div>

--

## Event Triggers: on

<div style="font-size: 0.65em; text-align: left; max-width: 1000px; margin: 0 auto;">

**`on`** — Control when checks run based on GitHub events:
```yaml
checks:
  quick-review:
    type: ai
    on: [pull_request_opened, pull_request_synchronize]
    prompt: "Quick review of new/updated PR"

  comprehensive-audit:
    type: ai
    on: [pull_request_review_requested]
    prompt: "Detailed review when explicitly requested"

  manual-only:
    type: ai
    on: [manual]  # Only via CLI or /review command
    prompt: "Deep dive analysis"
```

**Available events:**
- `pull_request_opened`, `pull_request_synchronize`, `pull_request_reopened`
- `pull_request_review_requested`, `issue_comment_created`
- `push`, `workflow_dispatch`, `schedule`, `manual`
- Omit `on` to run on all events

**Use cases:**
- Different checks for new PRs vs updates
- Manual-only expensive checks
- Scheduled audits with `on: [schedule]`

</div>

--

## Conditional Execution: if & fail_if

<div style="font-size: 0.7em; text-align: left; max-width: 1000px; margin: 0 auto;">

**`if`** — Run check conditionally:
```yaml
checks:
  large-pr-review:
    type: ai
    if: "{{ files | size }} > 10"  # Only if >10 files changed
    prompt: "Deep review for large PR"
```

**`fail_if`** — Fail based on condition:
```yaml
checks:
  security-gate:
    type: ai
    fail_if: "{{ outputs['security'] | size }} > 0"  # Fail if issues found
```

**Use cases:**
- `if` — Skip expensive checks for small PRs, run only when needed
- `fail_if` — Quality gates, enforce zero security issues, block on failures

</div>

--

## Default Code Review Pipeline

<div style="font-size: 0.62em; text-align: left; max-width: 950px; margin: 0 auto;">

**Flow:** `overview → security → performance → quality → style` with session reuse

```yaml
# defaults/.visor.yaml (excerpt)
checks:
  overview:
    type: ai
    schema: plain
    group: overview
    prompt: |
      Provide a high-level summary of this PR:
      - What changes are being made?
      - What is the scope and impact?
      - Any immediate concerns?

  security:
    type: ai
    schema: code-review
    group: review
    depends_on: [overview]
    reuse_ai_session: true
    prompt: |
      Review for security vulnerabilities:
      - SQL injection, XSS, CSRF risks
      - Authentication/authorization issues
      - Secrets or credentials in code
      - Input validation problems

  performance:
    type: ai
    schema: code-review
    group: review
    depends_on: [security]
    reuse_ai_session: true
    prompt: |
      Analyze performance implications:
      - Inefficient algorithms or N+1 queries
      - Memory leaks or resource issues
      - Blocking operations or race conditions

  quality:
    type: ai
    schema: code-review
    group: review
    depends_on: [performance]
    reuse_ai_session: true
    prompt: |
      Check code quality:
      - Readability and maintainability
      - Error handling and edge cases
      - Test coverage gaps
```

**Key features:** `schema: code-review` → GitHub annotations, `reuse_ai_session` → context continuity

</div>

--

## Lab 1 — Using Defaults (3 min)

<div style="font-size: 0.75em; text-align: left; max-width: 1000px; margin: 0 auto;">

Run only the `overview` and `security` checks:

```bash
npx -y @probelabs/visor --check overview,security --output table
```

Add `--debug` to see dependency decisions and timing.

</div>

---

# Code Review Workflow

Native GitHub integration with check runs and inline annotations

--

## Code Review Schema & Groups

<div style="font-size: 0.65em; text-align: left; max-width: 950px; margin: 0 auto;">

**The `code-review` schema enables GitHub annotations:**

```yaml
checks:
  overview:
    type: ai
    schema: code-review  # Required for GitHub check runs
    group: overview      # Separate comment
    prompt: "High-level PR summary"

  security:
    type: ai
    schema: code-review  # Required for inline annotations
    group: review        # Grouped with other reviews
    prompt: "Security analysis"

  performance:
    type: ai
    schema: code-review
    group: review        # Same group = same comment
    prompt: "Performance review"
```

**How groups work:**
- `group: overview` → Posted as separate comment
- `group: review` → All checks with this group posted together
- No group → Default behavior (separate comments)

**Result:** Clean, organized PR comments instead of spam

</div>

--

## Default Review Pipeline

<div style="font-size: 0.58em; text-align: left; max-width: 950px; margin: 0 auto;">

**Default checks included out-of-the-box:**

1. **`overview`** — High-level PR summary
2. **`security`** — Security vulnerabilities
3. **`performance`** — Performance issues
4. **`quality`** — Code quality & maintainability
5. **`style`** — Code style & best practices

**Key features:**
- Execution: `overview → security → performance → quality → style`
- AI session reuse maintains context across checks
- GitHub annotations at file:line:column
- Grouped comments prevent PR spam

**Run specific checks:** `npx @probelabs/visor --check security,performance`

</div>

--

## PR Comment Commands

<div style="font-size: 0.7em; text-align: left; max-width: 900px; margin: 0 auto;">

**Trigger reviews from PR comments:**

```
/review
```
```
/review --check security
```
```
/visor how does caching work?
```

**Use cases:**
- `/review` — Run full review pipeline
- `/review --check security` — Specific check only
- `/visor <question>` — Ask AI about the PR/codebase

</div>

Note:
Great demo: show a `/review` run, then a targeted `/review --check security` rerun.

--

## Lab 2 — Suppressions (2 min)

<div style="font-size: 0.75em; text-align: left; max-width: 900px; margin: 0 auto;">

Add a suppression near a flagged line:

```js
const testPassword = "demo123"; // visor-disable
```

Re‑run and confirm the warning is suppressed.

</div>

---

# Customizing Visor

Start from defaults, extend for your repo’s needs.

--

## Tags and Profiles

<div style="font-size: 0.68em; text-align: left; max-width: 950px; margin: 0 auto;">

**Tags organize checks for different environments and scenarios:**

```yaml
checks:
  debug-pr:
    type: logger
    tags: [local, fast]
    message: "PR #{{ pr.number }}: {{ files | size }} files changed"

  notify-slack:
    type: http
    tags: [ci]  # Only in CI/GitHub Actions
    method: POST
    url: "https://hooks.slack.com/services/XXX"
    body: |
      {"text": "PR #{{ pr.number }} reviewed: {{ outputs['security'] | json }}"}

  quick-security:
    type: ai
    tags: [local, fast, security]
    prompt: "Quick security scan of changed files"

  comprehensive-audit:
    type: ai
    tags: [ci, comprehensive, security]
    prompt: "Deep security audit with full context"
```

**Usage:**
```bash
# Local development - fast checks with debug logging
npx -y @probelabs/visor --tags local,fast

# CI environment - comprehensive checks with notifications
npx -y @probelabs/visor --tags ci,comprehensive
```

</div>

--

## Dependencies and Orchestration

<div style="font-size: 0.58em; text-align: left; max-width: 950px; margin: 0 auto;">

**Dependencies control execution order and data flow:**

```yaml
checks:
  # Phase 1: Run in parallel (no dependencies)
  security:
    type: ai
    schema: code-review
    prompt: "Find security vulnerabilities"

  test-results:
    type: command
    exec: "npm test --silent"

  # Phase 2: Wait for security, access its output
  performance:
    type: ai
    depends_on: [security]
    prompt: |
      Security findings: {{ outputs['security'] | json }}
      Now analyze performance issues, focusing on areas flagged above.

  # Phase 3: Wait for multiple checks
  final-report:
    type: ai
    depends_on: [security, performance, test-results]
    prompt: |
      Create comprehensive report:
      Security: {{ outputs['security'] | size }} issues
      Performance: {{ outputs['performance'] | size }} issues
      Tests: {{ outputs['test-results'] }}
```

**How it works:**
- `security` and `test-results` run in **parallel** (independent)
- `performance` waits for `security`, accesses its findings
- `final-report` waits for all 3, consolidates results
- Access outputs via `{{ outputs['check-name'] }}`

</div>

--

## Templates and Prompts

<div style="font-size: 0.6em; text-align: left; max-width: 950px; margin: 0 auto;">

**Liquid templates: inline or files, used everywhere**

**AI prompts:**
```yaml
checks:
  inline:  { type: ai, prompt: "Review {{ files | size }} files in {{ pr.title }}" }
  file:    { type: ai, prompt: ./prompts/security.liquid }
```

**Command execution:**
```yaml
checks:
  test:    { type: command, exec: "npm test -- {{ files | map: 'filename' | join: ' ' }}" }
```

**Logger messages:**
```yaml
checks:
  debug:   { type: logger, message: "PR #{{ pr.number }}: {{ files | json }}" }
```

**HTTP bodies:**
```yaml
checks:
  slack:   { type: http, body: '{"text": "{{ pr.title }}: {{ outputs.security | size }} issues"}' }
```

**Tips:** Use `| json` to debug objects, `{% readfile "path" %}` to include files

</div>

--

## Template Example: Accessing Previous Check Data

<div style="font-size: 0.65em; text-align: left; max-width: 1000px; margin: 0 auto;">

```yaml
checks:
  security-scan:
    type: ai
    schema: code-review  # Special schema for GitHub annotations
    prompt: "Analyze code for security issues"

  performance-review:
    type: ai
    depends_on: [security-scan]
    prompt: |
      Previous security findings: {{ outputs['security-scan'] | json }}

      Now review performance issues, focusing on areas flagged above.
```

**Access patterns:**
- `{{ outputs['check-name'] }}` — output from previous check
- `{{ pr.title }}` — PR metadata (title, number, author, etc.)
- `{{ pr.diff }}` — full diff content
- `{{ config.project.name }}` — project configuration

**Note:** `schema: code-review` enables GitHub check runs with inline annotations

</div>

--

## Extending & Customizing Defaults

<div style="font-size: 0.62em; text-align: left; max-width: 1050px; margin: 0 auto;">

```yaml
# .visor.yaml — customize defaults for your project
extends: defaults  # Inherit default checks and configuration

checks:
  # Disable a default check
  style:
    enabled: false

  # Override an existing check with additional context
  security:
    appendPrompt: |
      Focus on authentication flows in src/auth/.
      We use JWT tokens - check for token validation issues.

  # Add a new custom check
  database-review:
    type: ai
    schema: code-review
    depends_on: [security]
    prompt: "Review database queries for SQL injection and N+1 issues"
    tags: [local, comprehensive]
```

**Key patterns:**
- `extends: defaults` — inherit all default checks
- `enabled: false` — disable unwanted checks
- `appendPrompt` — add context without replacing the entire prompt
- Add new checks seamlessly alongside defaults

</div>

--

## Lab 3 — Your First Config (5 min)

<div style="font-size: 0.75em; text-align: left; max-width: 1000px; margin: 0 auto;">

Open `workshop/labs/lab-01-basic.yaml` and run:

```bash
npx -y @probelabs/visor --config workshop/labs/lab-01-basic.yaml \
  --tags local,fast --output table
```

Tweak a prompt and rerun. Then add a tag and filter by it.

</div>

---

# Architecture

<div style="font-size: 0.75em; text-align: left; max-width: 950px; margin: 0 auto;">

**High‑level flow:**

1. Event/CLI input
2. Load config (`.visor.yaml` or defaults)
3. Select checks (by `--check`, tags, or events)
4. Plan graph (dependencies, parallelism)
5. Execute providers (ai/http/command/claude-code/log)
6. Render templates → outputs (Markdown/JSON/SARIF)
7. Post to GitHub checks/annotations/comments (if configured)

</div>

--

## Components (Mental Model)

<div style="font-size: 0.75em; text-align: left; max-width: 950px; margin: 0 auto;">

- CLI and Action entrypoints (Node 18+)
- Config manager (load/merge/extends)
- Orchestrator (graph, parallelism, retries, fail‑fast)
- Providers: `ai`, `command`, `http`, `http_client`, `log`, `claude-code`
- Renderers: JSON → templates → outputs

</div>

Note:
This modularity is why SDLC automations beyond code review feel natural in Visor.

--

## The "AI" Provider: Probe Agent

<div style="font-size: 0.7em; text-align: left; max-width: 1000px; margin: 0 auto;">

When you use `type: ai`, Visor runs **Probe** — a specialized AI agent for code analysis.

**Key features:**
- Autonomous codebase exploration and review
- Multi-provider: Gemini, Claude, OpenAI, Bedrock
- Built-in tools: file search, grep, AST analysis

**Example:**
```yaml
checks:
  security:
    type: ai  # Runs Probe agent
    prompt: "Find security vulnerabilities"
```

**Probe workflow:** Search files → Analyze patterns → Use tools → Return structured findings

**Learn more:** [properlabs.com](https://properlabs.com)

</div>

--

## Schemas: Structure Your Outputs

<div style="font-size: 0.65em; text-align: left; max-width: 1000px; margin: 0 auto;">

**Custom schema:**
```yaml
checks:
  list-files:
    type: ai
    schema:
      type: object
      properties:
        files:
          type: array
          items:
            type: string
    prompt: "List security-sensitive files"
```

**Special `code-review` schema (GitHub integration):**
```yaml
checks:
  security:
    type: ai
    schema: code-review  # Required for GitHub check runs & annotations
    prompt: "Find security issues"
```

**Output:** Structured issues with file/line/column for GitHub inline annotations

**Key point:** Use `schema: code-review` for any check that should create GitHub annotations

</div>

--

## Environment Auto-Detection

<div style="font-size: 0.65em; text-align: left; max-width: 1000px; margin: 0 auto;">

**Visor automatically detects runtime and adapts:**

<div style="display: flex; gap: 2em; margin-top: 1em;">

<div style="flex: 1;">

**GitHub Actions** (`GITHUB_ACTIONS=true`):
- ✅ Check runs (pending/success/failure)
- ✅ Inline annotations (file:line:column)
- ✅ Grouped PR comments
- ✅ Access to `pr`, `files`, `event`
- ✅ Auto PR/issue detection

</div>

<div style="flex: 1;">

**CLI/Local** (manual):
- Console output (table/json/markdown/sarif)
- No GitHub API calls
- Use `--output-file` to save

</div>

</div>

**Example:** Same config, automatic adaptation

```yaml
checks:
  security:
    schema: code-review
    # GitHub Actions: check run + annotations
    # CLI: console output
```

</div>

--

## Template Context & Variables

<div style="font-size: 0.62em; text-align: left; max-width: 1000px; margin: 0 auto;">

**PR Context (available in prompts/commands):**
```liquid
{{ pr.number }} {{ pr.title }} {{ pr.author }}
{{ pr.baseBranch }} → {{ pr.headBranch }}
{{ pr.totalAdditions }} additions, {{ pr.totalDeletions }} deletions
```

**Files Array:**
```liquid
{% for file in files %}
  {{ file.filename }} ({{ file.status }})
  +{{ file.additions }} -{{ file.deletions }}
  {{ file.patch }}
{% endfor %}
```

**Check Outputs:**
```liquid
{{ outputs['security'] | json }}
{{ outputs['check-name'].issues | size }}
```

**Environment & Utils:**
```liquid
{{ env.CUSTOM_VAR }}
{{ utils.timestamp }} {{ utils.date }}
```

**Custom tags:**
- `{% readfile "path/to/file" %}` — include file content
- `{{ data | parse_json }}` — parse JSON strings

</div>

--

## Control Flow & Conditions

<div style="font-size: 0.65em; text-align: left; max-width: 1000px; margin: 0 auto;">

```yaml
checks:
  large-pr-review:
    type: ai
    if: "{{ files | size }} > 10"  # Only run if >10 files changed
    prompt: "Deep review for large PR"
    tags: [comprehensive]

  security-gate:
    type: ai
    fail_if: "{{ outputs['security'] | size }} > 0"  # Fail if issues found
    prompt: "Security check"

  process-output:
    type: command
    exec: "cat data.txt"
    transform: |
      {{ output | upcase }}  # Transform output with Liquid
    transform_js: |
      return output.split('\n').filter(line => line.includes('ERROR'));
```

**Key features:**
- `if` — conditional execution (JavaScript expression)
- `fail_if` — fail check based on condition
- `tags` — filter checks via `--tags local,fast`
- `transform` — Liquid template transformation
- `transform_js` — JavaScript transformation

</div>

---

# SDLC Automations

<div style="font-size: 0.58em; margin-top: 1em;">

- **Release Notes** — Generate from git history and publish to GitHub
- **Scheduled Audits** — Weekly security scans, daily dependency checks
- **Webhook Integrations** — Send findings to Slack, Discord, endpoints
- **Issue Management** — Sync with Jira, update tickets, track PR status
- **Custom Scripts** — Run any shell command (`type: command`)
- **MCP Integration** — Connect AI to external tools (Jira, Zendesk, filesystem, etc.)
- **Custom Workflows** — Trigger on any GitHub event or cron

**Key principle:** Same config works for PR reviews and SDLC automations
- `on: [manual]` for on-demand workflows
- `cron: "0 9 * * 1"` for scheduled tasks
- `type: http` or `http_client` for integrations
- `type: command` for shell scripts (`eslint`, `npm test`, custom tools)
- `ai_mcp_servers` for extending AI with external APIs and data

</div>

--

## Release Notes Automation

<div style="font-size: 0.62em; text-align: left; max-width: 1000px; margin: 0 auto;">

```yaml
checks:
  release-notes:
    type: ai
    on: [manual]  # Trigger manually or in release workflow
    prompt: |
      Generate professional release notes from:
      Git log: {{ env.GIT_LOG }}
      Diff stats: {{ env.GIT_DIFF_STAT }}
      Tag: {{ env.TAG_NAME }}
```

**Generate and publish:**
```bash
# Generate release notes
TAG_NAME=v1.0.0 GIT_LOG="$(git log --oneline -n 20)" \
GIT_DIFF_STAT="$(git diff --stat HEAD~20..HEAD)" \
npx -y @probelabs/visor --check release-notes --output markdown \
  --output-file release-notes.md

# Create GitHub release with generated notes
gh release create v1.0.0 --notes-file release-notes.md
```

</div>

--

## Cron & Scheduled Audits

<div style="font-size: 0.65em; text-align: left; max-width: 1000px; margin: 0 auto;">

```yaml
checks:
  weekly-security-audit:
    type: ai
    schema: code-review
    cron: "0 9 * * 1"  # Every Monday at 9 AM
    prompt: "Full security audit of main branch"

  dependency-check:
    type: command
    cron: "0 0 * * *"  # Daily at midnight
    exec: "npm audit --audit-level=moderate"
```

**GitHub Action trigger:**
```yaml
on:
  schedule:
    - cron: '0 9 * * 1'
```

</div>

--

## HTTP Webhooks & Integrations

<div style="font-size: 0.65em; text-align: left; max-width: 1000px; margin: 0 auto;">

```yaml
checks:
  github-webhook:
    type: http
    method: POST
    url: https://api.example.com/webhooks
    body: |
      {
        "pr": {{ pr | json }},
        "findings": {{ outputs['security'] | json }}
      }

  jira-status-sync:
    type: http_client
    depends_on: [security]
    url: https://company.atlassian.net/rest/api/2/issue/{{ env.JIRA_ISSUE }}
    method: PUT
    headers:
      Authorization: "Bearer {{ env.JIRA_TOKEN }}"
    body: |
      { "fields": { "status": "In Review" } }
```

</div>

--

## Demo: Running Examples

<div style="font-size: 0.75em; text-align: left; max-width: 1000px; margin: 0 auto;">

Try the example configs:

```bash
# HTTP integration
npx -y @probelabs/visor --config examples/http-integration-config.yaml \
  --check github-webhook --output table

# Cron webhook
npx -y @probelabs/visor --config examples/cron-webhook-config.yaml \
  --output table

# Jira integration
JIRA_ISSUE=PROJ-123 JIRA_TOKEN=xxx \
npx -y @probelabs/visor --config examples/jira-simple-example.yaml \
  --output markdown
```

</div>

--

## Lab 4 — Release Notes (5 min)

<div style="font-size: 0.7em; text-align: left; max-width: 1000px; margin: 0 auto;">

Simulate a release notes generation:

```bash
TAG_NAME=v1.0.0 GIT_LOG="$(git log --oneline -n 20)" \
GIT_DIFF_STAT="$(git diff --stat HEAD~20..HEAD)" \
npx -y @probelabs/visor --config defaults/.visor.yaml \
  --check release-notes --output markdown
```

</div>

Note:
This check is manual by design; perfect for tagged release pipelines.

---

# Nested Runs and Loops

Use `forEach` and loop patterns for multi-target checks

--

## forEach: Output Array, Dependent Runs Per Item

<div style="font-size: 0.62em; text-align: left; max-width: 1000px; margin: 0 auto;">

```yaml
checks:
  # Step 1: Output an array (forEach: true)
  get-changed-js-files:
    type: command
    exec: |
      echo '{{ files | json }}' | jq '[.[] | select(.filename | endswith(".js")) | .filename]'
    forEach: true  # Mark this check's output as an array

  # Step 2: Runs once for EACH file from above
  analyze-each-js-file:
    type: command
    depends_on: [get-changed-js-files]
    exec: |
      echo "Analyzing: {{ outputs.get-changed-js-files }}"
      # {{ outputs.get-changed-js-files }} is ONE file, not the array
      eslint "{{ outputs.get-changed-js-files }}"
```

**How it works:**
- `get-changed-js-files` outputs: `["file1.js", "file2.js", "file3.js"]`
- `analyze-each-js-file` runs 3 times, once per file
- Each run receives a single item, not the array

</div>

--

## forEach with AI: Dynamic Reviews

<div style="font-size: 0.62em; text-align: left; max-width: 1000px; margin: 0 auto;">

```yaml
checks:
  # AI outputs array of security-sensitive files
  list-security-concerns:
    type: ai
    forEach: true  # AI output (array) used for iteration
    schema:
      type: object
      properties:
        files:
          type: array
          items:
            type: string
    prompt: |
      List top 3 security-sensitive files as JSON array.
      Return: { "files": ["file1.js", "file2.py", "file3.yml"] }

  # Runs deep review for EACH security-sensitive file
  deep-security-review:
    type: ai
    schema: code-review
    depends_on: [list-security-concerns]
    prompt: |
      Detailed security review of: {{ outputs.list-security-concerns }}
      Focus only on this file and provide specific recommendations.
```

**Use cases:**
- List security files → review each individually
- Find all components → analyze each component
- Extract function names → document each function

</div>

--

## Lab 5 — foreach (5 min)

<div style="font-size: 0.75em; text-align: left; max-width: 1000px; margin: 0 auto;">

Run the foreach example and observe dependency propagation:

```bash
npx -y @probelabs/visor --config examples/forEach-example.yaml \
  --output table --debug
```

</div>

Note:
Great for monorepos (iterate packages/services) with shared prompts and per‑target context.

---

# Debugging & Observability

Tools and techniques for debugging Visor workflows

--

## Debug Flag: Verbose Execution Tracing

<div style="font-size: 0.68em; text-align: left; max-width: 1000px; margin: 0 auto;">

```bash
npx -y @probelabs/visor --check security --debug
```

**Shows:**
- Dependency graph resolution
- Check execution order and timing
- AI provider calls and responses
- Template rendering results
- forEach iteration details

**Use when:** Understanding execution flow, debugging dependencies, seeing what AI receives/returns

</div>

--

## Using log() in JavaScript Expressions

<div style="font-size: 0.68em; text-align: left; max-width: 1000px; margin: 0 auto;">

```yaml
checks:
  conditional-check:
    type: ai
    if: |
      log("Checking condition, outputs:", outputs);
      log("PR files count:", {{ files | size }});
      return {{ files | size }} > 5;
    prompt: "Review large PR with {{ files | size }} files"
```

**Output:** `🔍 Checking condition, outputs: {...}` in console

**Use when:** Debugging conditions, transforms, or any JavaScript expression

</div>

--

## Template Debugging with Liquid json Filter

<div style="font-size: 0.68em; text-align: left; max-width: 1000px; margin: 0 auto;">

```yaml
checks:
  debug-outputs:
    type: logger
    message: |
      All outputs: {{ outputs | json }}
      Security findings: {{ outputs['security'] | json }}
      PR data: {{ pr | json }}
```

**Use `type: logger`** for debugging without side effects

**Common patterns:**
- `{{ outputs | json }}` — see all previous check outputs
- `{{ pr | json }}` — inspect PR metadata
- `{{ files | json }}` — view changed files structure

</div>

--

## Structured Output Files

<div style="font-size: 0.68em; text-align: left; max-width: 1000px; margin: 0 auto;">

```bash
# JSON output for processing
npx -y @probelabs/visor --check security \
  --output json --output-file results.json

# SARIF for GitHub Code Scanning
npx -y @probelabs/visor --check security \
  --output sarif --output-file results.sarif

# Then analyze or upload
cat results.json | jq '.checks[].issues'
gh code-scanning upload-sarif -f results.sarif
```

**Use when:** Integrating with other tools, CI/CD pipelines, post-processing

</div>

--

## Debugging AI Checks (Probe Agent)

<div style="font-size: 0.7em; text-align: left; max-width: 1000px; margin: 0 auto;">

You can run Probe agent directly to debug AI check behavior:

```bash
# Run Probe directly in your project folder
cd /path/to/your/project
npx -y @probelabs/probe agent "Find security issues in authentication"
```

**When to use direct Probe debugging:**
- Test prompts before adding to Visor config
- Understand how Probe explores your codebase
- Iterate on AI check logic quickly
- Debug why a check isn't finding expected issues

**Example workflow:**
```bash
# 1. Test prompt with Probe directly
npx -y @probelabs/probe agent "Review error handling in src/api/"

# 2. Refine and add to Visor config
# 3. Run via Visor with --debug to see full execution
```

</div>

--

## Lab 6 — Debug & Logs (3 min)

<div style="font-size: 0.75em; text-align: left; max-width: 1000px; margin: 0 auto;">

Run the debug example config:

```bash
npx -y @probelabs/visor --config workshop/labs/lab-03-debug.yaml \
  --check debug-check --output markdown --debug
```

Open the log output and correlate with the rendered markdown.

</div>

---

# Providers and Extensibility

All available provider types with use cases

--

## AI Provider (Probe Agent)

<div style="font-size: 0.68em; text-align: left; max-width: 1000px; margin: 0 auto;">

```yaml
checks:
  security-review:
    type: ai
    schema: code-review
    prompt: "Find security vulnerabilities"
```

**Use cases:**
- Code review (security, performance, quality, style)
- Architecture analysis and recommendations
- Documentation generation
- Bug pattern detection
- Best practices validation

**Providers:** Gemini, Claude, OpenAI, Bedrock, or mock (offline)

</div>

--

## AI with MCP Servers

<div style="font-size: 0.6em; text-align: left; max-width: 1000px; margin: 0 auto;">

MCP (Model Context Protocol) gives AI access to external tools and data:

```yaml
checks:
  ticket-and-customer-review:
    type: ai
    ai_mcp_servers:
      jira:
        command: "npx"
        args: ["-y", "@orengrinker/jira-mcp-server"]
        env:
          JIRA_HOST: "company.atlassian.net"
          JIRA_EMAIL: "bot@company.com"
          JIRA_API_TOKEN: "{{ env.JIRA_TOKEN }}"
      zendesk:
        command: "npx"
        args: ["-y", "@zendesk/mcp-server-zendesk"]
        env:
          ZENDESK_SUBDOMAIN: "company"
          ZENDESK_API_TOKEN: "{{ env.ZENDESK_TOKEN }}"
    prompt: |
      1. Use Jira MCP to fetch ticket {{ env.TICKET_ID }}
      2. Use Zendesk MCP to search for related customer tickets about: {{ pr.title }}

      Then analyze:
      - Does the PR implement all Jira ticket requirements?
      - Are acceptance criteria met?
      - What is the customer impact based on Zendesk tickets?
      - Is the urgency justified?
```

**Popular MCP servers:** Probe, Jira, Confluence, Zendesk, Filesystem, GitHub

</div>

--

## Command Provider

<div style="font-size: 0.68em; text-align: left; max-width: 1000px; margin: 0 auto;">

```yaml
checks:
  run-tests:
    type: command
    exec: "npm test --silent"

  lint-code:
    type: command
    exec: "eslint src/ --format json"
    transform_js: |
      return JSON.parse(output).map(f => f.errorCount).reduce((a,b) => a+b, 0);
```

**Use cases:**
- Run linters (ESLint, Prettier, etc.)
- Execute test suites
- Build/compile checks
- Static analysis tools
- Custom shell scripts
- Extract data from codebase

</div>

--

## HTTP & HTTP Client Providers

<div style="font-size: 0.65em; text-align: left; max-width: 1000px; margin: 0 auto;">

**HTTP (send output to webhook):**
```yaml
checks:
  notify-slack:
    type: http
    method: POST
    url: "https://hooks.slack.com/services/XXX"
    body: |
      {"text": "PR #{{ pr.number }} has {{ outputs['security'] | size }} issues"}
```

**HTTP Client (fetch data from API):**
```yaml
checks:
  get-jira-status:
    type: http_client
    url: "https://jira.company.com/api/issue/{{ env.JIRA_ISSUE }}"
    headers:
      Authorization: "Bearer {{ env.JIRA_TOKEN }}"
    transform: |
      {{ data.fields.status.name }}
```

**Use cases:** Slack/Discord notifications, Jira integration, external API data, webhooks

</div>

--

## Logger Provider

<div style="font-size: 0.68em; text-align: left; max-width: 1000px; margin: 0 auto;">

```yaml
checks:
  debug-context:
    type: logger
    message: |
      PR Info: {{ pr | json }}
      Files changed: {{ files | size }}
      Previous outputs: {{ outputs | json }}
```

**Use cases:**
- Debugging templates and context
- Logging execution flow
- Conditional logging based on `if` conditions
- No side effects (doesn't call external services)

</div>

--

## Noop Provider (Orchestration)

<div style="font-size: 0.68em; text-align: left; max-width: 1000px; margin: 0 auto;">

```yaml
checks:
  wait-for-all:
    type: noop
    depends_on: [security, performance, quality]

  final-report:
    type: ai
    depends_on: [wait-for-all]
    prompt: |
      Summarize all findings:
      Security: {{ outputs['security'] | json }}
      Performance: {{ outputs['performance'] | json }}
```

**Use cases:**
- Synchronization point for parallel checks
- Orchestrating complex dependency graphs
- Collecting outputs before final processing

</div>

--

## Lab 4 — Classify → Select → Plan (8–10 min)

<div style="font-size: 0.7em; text-align: left; max-width: 950px; margin: 0 auto;">

**End‑to‑end planner:** Classifies tasks, runs per‑component agents, consolidates proposals.

**Run with mock provider:**
```bash
npx -y @probelabs/visor \
  --config workshop/labs/lab-04-planner.yaml \
  --output markdown --debug
```

**With custom task:**
```bash
TASK_DESC="Add caching to HTTP client" \
  npx -y @probelabs/visor \
  --config workshop/labs/lab-04-planner.yaml \
  --output markdown
```

</div>

Note:
For offline demos, unset AI keys to force mock provider:
`env -u GOOGLE_API_KEY -u ANTHROPIC_API_KEY -u OPENAI_API_KEY npx -y @probelabs/visor ...`

---

# Cheatsheet

<div style="font-size: 0.65em;">

```bash
# Run all checks from current config
npx -y @probelabs/visor --output table

# Filter by tags
npx -y @probelabs/visor --tags local,fast

# JSON/SARIF outputs
npx -y @probelabs/visor --check security --output json --output-file results.json
npx -y @probelabs/visor --check security --output sarif --output-file results.sarif

# Use a specific config
npx -y @probelabs/visor --config workshop/labs/lab-01-basic.yaml --tags local,fast

# Debugging
npx -y @probelabs/visor --debug
```

</div>

Note:
Close with Q&A or jump back to any iceberg layer based on questions.

---

# Real-World Examples

Let's explore production configurations

--

## Example 1: Default Configuration

<div style="font-size: 0.68em; text-align: left; max-width: 1000px; margin: 0 auto;">

**Visor's built-in defaults** — Everything out of the box:

```
https://github.com/probelabs/visor/blob/main/defaults/.visor.yaml
```

**What's included:**
- Complete PR review pipeline (overview → security → performance → quality → style)
- Issue assistant for automatic triage
- Release notes generator (manual trigger)
- All with AI session reuse for context flow
- GitHub annotations and check runs enabled

**Key takeaway:** Works immediately with zero config — just install and go

</div>

--

## Example 2: Team Customization

<div style="font-size: 0.68em; text-align: left; max-width: 1000px; margin: 0 auto;">

**Tyk Gateway's custom config** — Extending defaults for their needs:

```
https://github.com/TykTechnologies/tyk/blob/master/.visor.yaml
```

**Customizations shown:**
- `extends: defaults` — Inherits all default checks
- Custom prompts with team-specific context
- Additional checks for Go-specific patterns
- Project-specific security rules
- Tailored for their architecture and stack

**Key takeaway:** Start with defaults, override only what you need

</div>

--

## Example 3: Jira Automation Flow

<div style="font-size: 0.65em; text-align: left; max-width: 1000px; margin: 0 auto;">

**REFINE project's Jira workflow** — End-to-end ticket automation:

```
https://github.com/TykTechnologies/REFINE/blob/main/jira_analysis.yaml
```

<div style="display: flex; gap: 2em; margin-top: 1em;">

<div style="flex: 1;">

**Workflow demonstrated:**
1. Fetch Jira tickets via JQL query
2. AI analyzes ticket requirements
3. Suggests labels and priorities
4. Updates tickets automatically
5. Complete SDLC integration

</div>

<div style="flex: 1;">

**Technologies used:**
- Jira MCP server for API access
- AI provider for intelligent analysis
- HTTP client for ticket updates
- Liquid templates for dynamic queries

</div>

</div>

**Key takeaway:** Complex SDLC workflows with the same Visor primitives

</div>

--

## Try These Examples

<div style="font-size: 0.7em; text-align: left; max-width: 1000px; margin: 0 auto;">

**1. Run with defaults:**
```bash
# No config needed - uses built-in defaults
npx -y @probelabs/visor --output table
```

**2. Clone and customize:**
```bash
# Copy defaults as starting point
curl -o .visor.yaml https://raw.githubusercontent.com/probelabs/visor/main/defaults/.visor.yaml

# Or extend them
echo "extends: defaults" > .visor.yaml
```

**3. Explore Jira automation:**
```bash
# Download and run the Jira example
curl -o jira.yaml https://raw.githubusercontent.com/TykTechnologies/REFINE/main/jira_analysis.yaml
npx -y @probelabs/visor --config jira.yaml --output markdown
```

**Resources:**
- Defaults: `github.com/probelabs/visor/blob/main/defaults/.visor.yaml`
- Tyk example: `github.com/TykTechnologies/tyk/blob/master/.visor.yaml`
- Jira flow: `github.com/TykTechnologies/REFINE/blob/main/jira_analysis.yaml`

</div>

---

## Future: Agentic Automation

<div style="font-size: 0.65em; text-align: left; max-width: 1000px; margin: 0 auto;">

**Coming soon — AI agents that take action:**

**1. Auto-labeling issues & PRs:**
```yaml
checks:
  auto-label:
    type: ai
    prompt: |
      Analyze this {{ pr.title }} and suggest labels.
      Categories: bug, feature, docs, security, performance
    # Future: Auto-apply labels via GitHub API
```

**2. Auto-fix simple issues with `implement` tool:**
```yaml
checks:
  auto-fix:
    type: ai
    tools: [implement, run_tests]  # AI can edit code and run tests
    prompt: |
      Fix this issue if confidence is high:
      1. Analyze the reported problem
      2. Make minimal code changes
      3. Run tests to verify fix
      4. Comment on issue with results
```

**Use case: Issue submitted → AI analyzes → High confidence? → Auto-fix + test + comment**

**3. Full code agent workflow:**
- AI makes code changes via `implement` tool
- Runs tests automatically to verify changes
- Creates PR with fixes or requests human review
- Iterates on feedback until tests pass

**Key principle:** AI handles routine fixes, escalates complex issues to humans

</div>

---

# Learn More

<div style="font-size: 0.75em; text-align: center; margin-top: 2em;">

**📚 Documentation & Source Code:**
- **Visor GitHub:** [github.com/probelabs/visor](https://github.com/probelabs/visor)
- **Probe Labs:** [probelabs.com](https://probelabs.com)

**🔧 Real-World Automation Examples:**
- **REFINE Repository:** [github.com/TykTechnologies/REFINE](https://github.com/TykTechnologies/REFINE)
  - Jira automation workflows
  - SDLC integration examples
  - Production configs and patterns

**🚀 Get Started:**
```bash
npx -y @probelabs/visor --output table
```

</div>
