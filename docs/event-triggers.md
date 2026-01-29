# Visor Event Triggers

This document explains what events trigger Visor and how to identify the context from logs.

## Trigger Modes

Visor can be triggered in two main modes:

### 1. Manual CLI Mode
- **When**: Running `visor` command locally
- **Log indicator**: `🖥️  Mode: Manual CLI`
- **Context**: Local git repository analysis
- **Event simulation**: Use `--event` flag to simulate GitHub events (see [CLI Event Simulation](#cli-event-simulation))

### 2. GitHub Action Mode
- **When**: Triggered by GitHub webhook events
- **Log indicator**: `🤖 Mode: GitHub Action`
- **Context**: Based on GitHub event type

## GitHub Events

When running as a GitHub Action, Visor responds to these events:

### Pull Request Events (`pull_request`)
- **Actions**: `opened`, `synchronize`, `edited`, `closed`
- **Trigger mapping**:
  - `opened` → `pr_opened`
  - `synchronize` / `edited` → `pr_updated`
  - `closed` → `pr_closed`
- **Log format**:
  ```
  🤖 Mode: GitHub Action
  📂 Repository: owner/repo
  📋 Event: pull_request (action: opened)
  🎯 Trigger: pr_opened
  🔀 Context: Pull Request #123
  ```

### Pull Request Review Events (`pull_request_review`)
- **Actions**: `submitted`, `edited`, `dismissed`
- **Trigger mapping**: `pr_updated`
- **Log format**:
  ```
  🤖 Mode: GitHub Action
  📂 Repository: owner/repo
  📋 Event: pull_request_review (action: submitted)
  🎯 Trigger: pr_updated
  🔀 Context: Pull Request #123
  ```

### Issue Events (`issues`)
- **Actions**: `opened`, `edited`, etc.
- **Trigger mapping**: `issue_opened`
- **Log format**:
  ```
  🤖 Mode: GitHub Action
  📂 Repository: owner/repo
  📋 Event: issues (action: opened)
  🎯 Trigger: issue_opened
  🎫 Context: Issue #456
  ```

### Issue Comment Events (`issue_comment`)
- **Actions**: `created`, `edited`
- **Trigger mapping**: `issue_comment`
- **Context**: Can be on either a Pull Request or an Issue
- **Note**: The EventMapper class may treat PR comments as `pr_updated` for advanced routing, but the GitHub Action entry point maps all issue comments to `issue_comment`.
- **Log format** (on PR):
  ```
  🤖 Mode: GitHub Action
  📂 Repository: owner/repo
  📋 Event: issue_comment (action: created)
  🎯 Trigger: issue_comment
  💬 Context: Comment on Pull Request #123
  ```
- **Log format** (on Issue):
  ```
  🤖 Mode: GitHub Action
  📂 Repository: owner/repo
  📋 Event: issue_comment (action: created)
  🎯 Trigger: issue_comment
  💬 Context: Comment on Issue #456
  ```

### Schedule Events (`schedule`)
- **Trigger mapping**: `schedule`
- **Use case**: Cron-triggered workflows
- **Log format**:
  ```
  🤖 Mode: GitHub Action
  📂 Repository: owner/repo
  📋 Event: schedule
  🎯 Trigger: schedule
  ```

### Workflow Dispatch Events (`workflow_dispatch`)
- **Trigger mapping**: `schedule` (treated as scheduled execution)
- **Use case**: Manual workflow triggers
- **Log format**:
  ```
  🤖 Mode: GitHub Action
  📂 Repository: owner/repo
  📋 Event: workflow_dispatch
  🎯 Trigger: schedule
  ```

## Example Logs

### Before (old logging):
```
Event: issue_comment, Owner: TykTechnologies, Repo: tyk
```

### After (improved logging):
```
🤖 Mode: GitHub Action
📂 Repository: TykTechnologies/tyk
📋 Event: issue_comment (action: created)
🎯 Trigger: issue_comment
💬 Context: Comment on Pull Request #123
📚 Total checks in loaded config: 10
📚 Available checks: release-notes, overview, security, performance, quality, style, review-all, issue-assistant, dependency, connectivity
🔧 Checks to run for issue_comment: review-all, issue-assistant
```

## Understanding the Log Output

1. **Mode**: Tells you if this is a manual CLI run or GitHub Action
2. **Repository**: The owner/repo being analyzed
3. **Event**: The raw GitHub event name and action
4. **Trigger**: The internal event type Visor uses for configuration
5. **Context**: Specific context (PR number, Issue number, etc.)
6. **Available checks**: All checks defined in configuration
7. **Checks to run**: Which checks will execute for this event

## Recursion Prevention

When Visor posts a comment on an issue or PR, GitHub triggers a new `issue_comment` event. To prevent infinite loops, Visor automatically skips processing its own comments by detecting:

1. **Bot username**: `visor[bot]`, `github-actions[bot]`, `probelabs[bot]`, or any user with `type: Bot`
2. **Visor markers**: Comments containing `<!-- visor-comment-id:` or `*Powered by [Visor](...)*`

**Example log (expected behavior):**
```
✓ Skipping bot's own comment to prevent recursion. Author: probelabs[bot], Type: Bot, Has markers: true
```

This is **normal and correct** - it means:
- Issue opened → Bot posts comment → Comment triggers event → Bot detects its own comment → Skips ✅

## Event Flow Example

**When an issue is opened:**

1. **Event 1**: `issues` (action: opened)
   ```
   🤖 Mode: GitHub Action
   📋 Event: issues (action: opened)
   🎯 Trigger: issue_opened
   🎫 Context: Issue #456
   🔧 Checks to run: issue-assistant
   ✅ Posted issue assistant results to issue #456
   ```

2. **Event 2**: `issue_comment` (action: created) - Bot's own comment
   ```
   🤖 Mode: GitHub Action
   📋 Event: issue_comment (action: created)
   🎯 Trigger: issue_comment
   💬 Context: Comment on Issue #456
   ✓ Skipping bot's own comment to prevent recursion. Author: probelabs[bot], Type: Bot, Has markers: true
   ```

## Available Event Triggers

The complete list of event triggers that can be used in the `on` field:

| Trigger | Description |
|---------|-------------|
| `pr_opened` | Pull request was opened |
| `pr_updated` | Pull request was updated (synchronize, edited, or review submitted) |
| `pr_closed` | Pull request was closed (merged or dismissed) |
| `issue_opened` | Issue was opened |
| `issue_comment` | Comment on an issue (not a PR) |
| `manual` | Manual CLI invocation |
| `schedule` | Scheduled execution (cron or workflow_dispatch) |
| `webhook_received` | HTTP webhook was received (via http_input provider) |

## Configuration

Steps are configured to run on specific triggers using the `on` field:

```yaml
steps:
  security-check:
    on: [pr_opened, pr_updated]  # Only runs on PR events
    type: ai
    # ... rest of config

  issue-assistant:
    on: [issue_comment, issue_opened]  # Runs on issue events
    type: ai
    # ... rest of config

  scheduled-report:
    on: [schedule]  # Only runs on scheduled triggers
    type: ai
    schedule: "0 9 * * 1"  # Every Monday at 9am
    # ... rest of config

  webhook-handler:
    on: [webhook_received]  # Only runs when webhook is received
    type: http_input
    # ... rest of config
```

If `on` is not specified, the check can run on any event type (except `manual`-only checks when using `--event all`).

### Using goto_event to simulate a different trigger for a jump

Sometimes you want to "re-run" an ancestor step as if a different event happened (e.g., from an `issue_comment` flow you want to re-execute a PR step under `pr_updated`). Use `goto_event` together with `goto` in `on_success` or `on_fail` blocks:

```yaml
steps:
  overview:
    type: ai
    on: [pr_opened, pr_updated]

  security:
    type: ai
    depends_on: [overview]
    on: [pr_opened, pr_updated]
    on_success:
      goto: overview
      goto_event: pr_updated  # simulate PR update for the inline jump
```

During that inline execution, event filtering and `if:` expressions see the simulated event. The current step is then re-run once.

The `goto_event` field accepts any valid `EventTrigger` value:
- `pr_opened`, `pr_updated`, `pr_closed`
- `issue_opened`, `issue_comment`
- `manual`, `schedule`, `webhook_received`

For complete documentation on failure routing, retry policies, and loop control, see [Failure Routing](./failure-routing.md).

## CLI Event Simulation

When running Visor locally via CLI, you can simulate GitHub events to test event-based check filtering. This is useful for testing your configuration locally before deploying to GitHub Actions.

### Usage

```bash
# Simulate a PR update event
visor --event pr_updated

# Simulate a PR opened event
visor --event pr_opened

# Simulate a PR closed event
visor --event pr_closed

# Simulate an issue comment event
visor --event issue_comment

# Simulate an issue opened event
visor --event issue_opened

# Simulate a manual trigger (runs checks with on: [manual])
visor --event manual

# Simulate a scheduled trigger
visor --event schedule

# Run all checks regardless of event filters (default)
visor --event all
```

### Auto-Detection

Visor automatically detects the appropriate event based on the checks being run:

- **Code-review schemas** → Defaults to `pr_updated`
- **Other schemas** → Defaults to `all` (no filtering)

```bash
# These two are equivalent when running checks with code-review schema
visor --check security
visor --check security --event pr_updated
```

### Event Filtering Behavior

| Flag | Behavior | Use Case |
|------|----------|----------|
| `--event pr_opened` | Only runs checks with `on: [pr_opened]` | Test PR opened scenario |
| `--event pr_updated` | Only runs checks with `on: [pr_updated]` | Test PR update scenario locally |
| `--event pr_closed` | Only runs checks with `on: [pr_closed]` | Test PR close/merge scenario |
| `--event issue_opened` | Only runs checks with `on: [issue_opened]` | Test issue opened scenario |
| `--event issue_comment` | Only runs checks with `on: [issue_comment]` | Test comment assistant |
| `--event manual` | Only runs checks with `on: [manual]` | Test manual-triggered checks |
| `--event schedule` | Only runs checks with `on: [schedule]` | Test scheduled/cron checks |
| `--event all` | Runs all checks (except manual-only) | Default behavior, ignores `on:` filters |
| (no flag) | Auto-detects based on schema | Smart default |

### Example Workflow

**Testing PR review locally before pushing:**

```bash
# 1. Make changes on a feature branch
git checkout -b feature/new-feature

# 2. Simulate PR update event to see what checks would run
visor --event pr_updated --analyze-branch-diff

# 3. Review the output and fix any issues

# 4. Push and open PR (GitHub Actions will run the same checks)
git push origin feature/new-feature
```

### Combining with Other Flags

Event simulation works alongside other CLI flags:

```bash
# Analyze branch diff with PR update event
visor --event pr_updated --analyze-branch-diff

# Run specific checks with event filtering
visor --check security --check style --event pr_opened

# Debug mode with event simulation
visor --event pr_updated --debug

# JSON output with event filtering
visor --event issue_comment --output json
```

### Log Output

When using event simulation, you'll see:

```
🎯 Simulating event: pr_updated
▶ Running check: overview [1/4]
▶ Running check: security [2/4]
```

When using `--event all`:

```
🎯 Event filtering: DISABLED (running all checks regardless of event triggers)
```

### Common Patterns

**Test all PR checks locally:**
```bash
visor --event pr_updated --analyze-branch-diff
```

**Test issue assistant:**
```bash
# Issue assistants typically run on issue_comment or issue_opened
visor --event issue_comment
```

**Run everything (useful for local development):**
```bash
visor --event all  # or just: visor
```

## Related Documentation

- [Configuration](./configuration.md) - Full configuration reference including check types
- [CI/CLI Mode](./ci-cli-mode.md) - Running Visor in CI environments
- [Failure Routing](./failure-routing.md) - Auto-fix loops and `goto_event` usage
- [Commands](./commands.md) - CLI commands and PR comment commands
- [Tag Filtering](./tag-filtering.md) - Selective check execution with tags
