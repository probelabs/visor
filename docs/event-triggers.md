# Visor Event Triggers

This document explains what events trigger Visor and how to identify the context from logs.

## Trigger Modes

Visor can be triggered in two main modes:

### 1. Manual CLI Mode
- **When**: Running `visor` command locally
- **Log indicator**: `🖥️  Mode: Manual CLI`
- **Context**: Local git repository analysis

### 2. GitHub Action Mode
- **When**: Triggered by GitHub webhook events
- **Log indicator**: `🤖 Mode: GitHub Action`
- **Context**: Based on GitHub event type

## GitHub Events

When running as a GitHub Action, Visor responds to these events:

### Pull Request Events (`pull_request`)
- **Actions**: `opened`, `synchronize`, `edited`
- **Trigger mapping**:
  - `opened` → `pr_opened`
  - `synchronize` / `edited` → `pr_updated`
- **Log format**:
  ```
  🤖 Mode: GitHub Action
  📂 Repository: owner/repo
  📋 Event: pull_request (action: opened)
  🎯 Trigger: pr_opened
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

## Configuration

Checks are configured to run on specific triggers using the `on` field:

```yaml
checks:
  security-check:
    on: [pr_opened, pr_updated]  # Only runs on PR events
    type: ai
    # ... rest of config

  issue-assistant:
    on: [issue_comment, issue_opened]  # Runs on issue events
    type: ai
    # ... rest of config
```

If `on` is not specified, the check can run on any event type.

### Using goto_event to simulate a different trigger for a jump

Sometimes you want to “re-run” an ancestor step as if a different event happened (e.g., from an `issue_comment` flow you want to re-execute a PR step under `pr_updated`). Use `goto_event` together with `goto`:

```yaml
checks:
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

During that inline execution, event filtering and `if:` expressions see the simulated event. The current step is then re-run once. For a full PR re-run from an issue comment, synthesize a PR event and re-invoke the action entrypoint (see failure-routing docs for details).
