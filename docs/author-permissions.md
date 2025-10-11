# Author Permissions

Visor provides powerful author permission checking functions that allow you to customize workflows based on the PR author's relationship to the repository. These functions use GitHub's `author_association` field to determine the author's permission level.

## Table of Contents

- [Overview](#overview)
- [Permission Hierarchy](#permission-hierarchy)
- [Available Functions](#available-functions)
- [Use Cases](#use-cases)
- [Local Mode Behavior](#local-mode-behavior)
- [Best Practices](#best-practices)
- [Examples](#examples)

## Overview

Author permission functions are available in:

**JavaScript contexts:**
- `if` conditions - Control whether checks run
- `fail_if` conditions - Fail checks based on author permissions
- `transform_js` - Transform outputs based on permissions
- `goto_js` / `run_js` - Dynamic routing based on permissions

**Liquid templates:**
- AI prompts - Customize prompts based on author
- Command templates - Dynamic command generation
- Messages - Personalized welcome messages

These functions enable you to:
- Run different workflows for internal vs external contributors
- Apply stricter checks to first-time contributors
- Auto-approve PRs from trusted team members
- Block sensitive changes from non-members
- Welcome new contributors with custom messages

## Permission Hierarchy

GitHub provides the following permission levels (from highest to lowest):

| Level | Description | Includes |
|-------|-------------|----------|
| `OWNER` | Repository owner | Owner only |
| `MEMBER` | Organization member | Owner, Members |
| `COLLABORATOR` | Invited collaborator | Owner, Members, Collaborators |
| `CONTRIBUTOR` | Has contributed before | Owner, Members, Collaborators, Contributors |
| `FIRST_TIME_CONTRIBUTOR` | First PR to this repo | Everyone except FIRST_TIMER |
| `FIRST_TIMER` | First GitHub contribution ever | FIRST_TIMER only |
| `NONE` | No association | No one |

## Available Functions

### `hasMinPermission(level)`

**Check if author has AT LEAST the specified permission level** (>= logic)

```javascript
hasMinPermission('MEMBER')      // true for OWNER, MEMBER
hasMinPermission('COLLABORATOR') // true for OWNER, MEMBER, COLLABORATOR
hasMinPermission('CONTRIBUTOR')  // true for all except FIRST_TIME_CONTRIBUTOR, FIRST_TIMER
```

**When to use:**
- Most flexible option for hierarchical permission checks
- Use when you want "this permission or higher"
- Recommended for most use cases

**Examples:**
```yaml
# Run security scan for non-members
if: "!hasMinPermission('MEMBER')"

# Allow auto-merge for collaborators and above
if: "hasMinPermission('COLLABORATOR')"

# Require manual review for new contributors
fail_if: "!hasMinPermission('CONTRIBUTOR') && criticalIssues > 0"
```

### `isOwner()`

Check if the author is the repository owner.

```yaml
# Only owners can deploy to production
deploy-prod:
  type: command
  exec: npm run deploy:prod
  if: "isOwner()"

# Skip review for owner
skip-review:
  type: command
  exec: gh pr review --approve
  if: "isOwner()"
```

### `isMember()`

Check if the author is an organization member or owner.

```yaml
# Members can skip certain checks
quick-check:
  type: command
  exec: npm run test:quick
  if: "isMember()"

# Non-members need full security scan
full-security-scan:
  type: command
  exec: npm run security:full
  if: "!isMember()"
```

### `isCollaborator()`

Check if the author is an invited collaborator (or higher).

```yaml
# Collaborators can bypass certain validations
bypass-format-check:
  type: command
  exec: echo "Skipping format check"
  if: "!isCollaborator()"

# Auto-approve for collaborators with passing tests
auto-approve:
  type: command
  exec: gh pr review --approve
  if: "isCollaborator() && outputs.tests.success === true"
```

### `isContributor()`

Check if the author has contributed to the repository before.

```yaml
# Welcome returning contributors
welcome-back:
  type: command
  exec: gh pr comment --body "Welcome back!"
  if: "isContributor() && !isMember()"

# Skip CLA check for known contributors
cla-check:
  type: command
  exec: ./scripts/check-cla.sh
  if: "!isContributor()"
```

### `isFirstTimer()`

Check if this is the author's first contribution to this repo or to GitHub.

```yaml
# Welcome first-time contributors
welcome-message:
  type: command
  exec: |
    gh pr comment --body "🎉 Welcome to the project! Thanks for your first contribution!"
  if: "isFirstTimer()"

# Require extra care from first-timers
strict-review:
  type: command
  exec: gh pr review --request-changes
  fail_if: "isFirstTimer() && (criticalIssues > 0 || errorIssues > 2)"
```

## Use Cases

### 1. Tiered Security Scanning

Run different levels of security scanning based on trust level:

```yaml
checks:
  # Quick scan for trusted members
  security-quick:
    type: command
    exec: npm run security:quick
    if: "hasMinPermission('MEMBER')"

  # Deep scan for collaborators
  security-standard:
    type: command
    exec: npm run security:standard
    if: "hasMinPermission('COLLABORATOR') && !hasMinPermission('MEMBER')"

  # Full scan for external contributors
  security-full:
    type: command
    exec: npm run security:full
    if: "!hasMinPermission('COLLABORATOR')"
```

### 2. Protecting Sensitive Files

Block changes to sensitive files from non-members:

```yaml
checks:
  protect-sensitive:
    type: command
    exec: echo "Checking sensitive files..."
    fail_if: |
      !isMember() && files.some(f =>
        f.filename.startsWith('secrets/') ||
        f.filename.startsWith('.github/workflows/') ||
        f.filename === '.env' ||
        f.filename.endsWith('.key') ||
        f.filename.endsWith('.pem')
      )
```

### 3. Auto-Approval Workflow

Automatically approve PRs from trusted contributors when checks pass:

```yaml
checks:
  tests:
    type: command
    exec: npm test

  lint:
    type: command
    exec: npm run lint

  auto-approve:
    type: command
    depends_on: [tests, lint]
    exec: gh pr review --approve
    if: |
      // Only auto-approve for collaborators
      hasMinPermission('COLLABORATOR') &&
      // All checks must pass
      outputs.tests.error === false &&
      outputs.lint.error === false &&
      // No critical issues
      totalIssues === 0
```

### 4. Welcome New Contributors

Create a welcoming experience for first-time contributors:

```yaml
checks:
  welcome-first-timer:
    type: command
    exec: |
      gh pr comment --body "$(cat <<'EOF'
      👋 Welcome to the project! Thank you for your first contribution!

      Here are some tips:
      - Make sure all tests pass
      - Follow our code style guide
      - Ask questions in the comments if you need help

      Our team will review your PR soon!
      EOF
      )"
    if: "isFirstTimer()"

  assign-mentor:
    type: command
    exec: gh pr edit --add-assignee mentor-bot
    if: "isFirstTimer()"
```

### 5. Conditional Review Requirements

Require different levels of review based on changes and author:

```yaml
checks:
  require-review:
    type: command
    exec: gh pr review --request-changes
    fail_if: |
      // First-timers need approval for any PR
      (isFirstTimer()) ||
      // Non-collaborators need approval for large PRs
      (!hasMinPermission('COLLABORATOR') && pr.totalAdditions > 500) ||
      // Non-members need approval for sensitive files
      (!isMember() && files.some(f =>
        f.filename.includes('security') ||
        f.filename.includes('auth')
      ))
```

### 6. Deployment Gates

Control who can deploy to different environments:

```yaml
checks:
  deploy-staging:
    type: command
    exec: ./scripts/deploy.sh staging
    if: "hasMinPermission('COLLABORATOR')"

  deploy-production:
    type: command
    exec: ./scripts/deploy.sh production
    if: "hasMinPermission('MEMBER')"
    fail_if: |
      // Extra validation for production
      !isOwner() && (
        pr.title.includes('WIP') ||
        pr.title.includes('Draft') ||
        outputs.tests.failed > 0
      )
```

### 7. Skip Checks for Trusted Users

Save CI resources by skipping checks for trusted contributors:

```yaml
checks:
  expensive-integration-tests:
    type: command
    exec: npm run test:integration
    # Skip for members (they know what they're doing)
    if: "!isMember()"

  format-check:
    type: command
    exec: npm run format:check
    # Members can skip (we trust them to format correctly)
    if: "!hasMinPermission('COLLABORATOR')"
```

### 8. Using in Liquid Templates

Permission filters are also available in Liquid templates for prompts, commands, and messages:

```yaml
checks:
  # Customize AI prompts based on author permission
  code-review:
    type: ai
    prompt: |
      {% if pr.authorAssociation | is_member %}
      Review this PR from team member {{ pr.author }}.
      Focus on architecture and design patterns.
      {% else %}
      Review this PR from external contributor {{ pr.author }}.
      Pay extra attention to:
      - Security best practices
      - Code quality and style
      - Proper error handling
      {% endif %}

      Changed files:
      {% for file in files %}
      - {{ file.filename }} (+{{ file.additions }}, -{{ file.deletions }})
      {% endfor %}

  # Conditional welcome messages
  welcome:
    type: command
    exec: |
      gh pr comment --body "$(cat <<'EOF'
      {% if pr.authorAssociation | is_first_timer %}
      🎉 Welcome to the project! Thank you for your first contribution!

      Here's what happens next:
      1. Our CI will run automated tests
      2. A maintainer will review your changes
      3. We may request some changes

      Feel free to ask questions in the comments!
      {% elsif pr.authorAssociation | is_contributor %}
      👋 Welcome back, {{ pr.author }}! Thanks for another contribution.
      {% else %}
      Thank you for your contribution, {{ pr.author }}!
      {% endif %}
      EOF
      )"

  # Dynamic command selection
  security-scan:
    type: command
    exec: |
      {% if pr.authorAssociation | has_min_permission: "MEMBER" %}
      npm run security:quick
      {% else %}
      npm run security:full
      {% endif %}

  # Conditional approval message
  auto-approve-message:
    type: command
    depends_on: [tests, lint]
    exec: |
      {% if pr.authorAssociation | has_min_permission: "COLLABORATOR" %}
      gh pr review --approve --body "✅ Auto-approved: All checks passed for trusted contributor"
      {% else %}
      gh pr comment --body "✅ All checks passed! A maintainer will review soon."
      {% endif %}
    if: "totalIssues === 0"
```

**Available Liquid filters:**
- `pr.authorAssociation | has_min_permission: "LEVEL"`
- `pr.authorAssociation | is_owner`
- `pr.authorAssociation | is_member`
- `pr.authorAssociation | is_collaborator`
- `pr.authorAssociation | is_contributor`
- `pr.authorAssociation | is_first_timer`

See [Liquid Templates Guide](./liquid-templates.md#author-permission-filters) for more details.

## Local Mode Behavior

When running Visor locally (outside of GitHub Actions):

- **All permission checks return `true`** (treated as owner)
- **`isFirstTimer()` returns `false`**
- This prevents blocking local development and testing

Detection logic:
```javascript
// Visor detects local mode by checking for GITHUB_ACTIONS env var
const isLocal = !process.env.GITHUB_ACTIONS;
```

You can test permission logic locally by temporarily setting:
```bash
export GITHUB_ACTIONS=true
```

## Best Practices

### 1. Use `hasMinPermission()` for Most Cases

Prefer `hasMinPermission()` over individual checks for cleaner logic:

```yaml
# ✅ Good - Clear hierarchical check
if: "!hasMinPermission('MEMBER')"

# ❌ Less clear - Manual hierarchy
if: "!isOwner() && !isMember()"
```

### 2. Combine with Other Conditions

Permission checks work great with other context variables:

```yaml
fail_if: |
  // Non-members can't modify critical files
  !hasMinPermission('MEMBER') && files.some(f =>
    f.filename.startsWith('core/')
  ) ||
  // Non-collaborators need clean builds
  !hasMinPermission('COLLABORATOR') && outputs.build.error === true
```

### 3. Document Your Permission Requirements

Add comments to explain permission logic:

```yaml
checks:
  deploy:
    type: command
    exec: ./deploy.sh
    # Only members can deploy - they understand the deployment process
    # and have been trained on rollback procedures
    if: "hasMinPermission('MEMBER')"
```

### 4. Be Welcoming to New Contributors

Use permission checks to create a positive experience:

```yaml
# ✅ Good - Welcoming and helpful
if: "isFirstTimer()"
exec: gh pr comment --body "Welcome! Thanks for contributing!"

# ✅ Good - Clear expectations
fail_if: "isFirstTimer() && criticalIssues > 0"

# ❌ Avoid - Too restrictive without guidance
fail_if: "!isMember()"
```

### 5. Test Your Permission Logic

Always test permission-based workflows:

```yaml
# Add a check that logs permission info for debugging
debug-permissions:
  type: command
  exec: |
    echo "Author: {{ pr.author }}"
    echo "Association: {{ pr.authorAssociation }}"
  if: |
    log("isOwner:", isOwner());
    log("isMember:", isMember());
    log("isCollaborator:", isCollaborator());
    true  // Always run this check
```

### 6. Fail Gracefully

Provide clear messages when permission checks fail:

```yaml
checks:
  check-permissions:
    type: command
    exec: echo "Permission check"
    fail_if: |
      const notAllowed = !hasMinPermission('COLLABORATOR') &&
        files.some(f => f.filename.startsWith('infrastructure/'));

      if (notAllowed) {
        log("❌ Non-collaborators cannot modify infrastructure files");
        log("Please request review from a team member");
      }

      notAllowed
```

## Examples

### Complete Workflow Example

Here's a complete example showing how to use author permissions in a real workflow:

```yaml
version: "1.0"

checks:
  # 1. Welcome new contributors
  welcome:
    type: command
    exec: |
      gh pr comment --body "👋 Welcome! Thanks for your first contribution.
      A maintainer will review your PR soon."
    if: "isFirstTimer()"

  # 2. Run appropriate test suite based on trust level
  tests-quick:
    type: command
    exec: npm run test:unit
    if: "hasMinPermission('MEMBER')"

  tests-full:
    type: command
    exec: npm run test:all
    if: "!hasMinPermission('MEMBER')"

  # 3. Security scanning for external contributors
  security-scan:
    type: command
    exec: npm run security:scan
    if: "!hasMinPermission('COLLABORATOR')"

  # 4. Protect sensitive files
  check-sensitive-files:
    type: command
    exec: echo "Checking sensitive files..."
    fail_if: |
      !isMember() && files.some(f =>
        f.filename.includes('secrets') ||
        f.filename.includes('.env')
      )

  # 5. Require review for significant changes from non-members
  require-review:
    type: command
    depends_on: [tests-full, tests-quick]
    exec: gh pr review --request-changes
    fail_if: |
      // Large PRs from non-members need review
      (!hasMinPermission('MEMBER') && pr.totalAdditions > 300) ||
      // Any critical issues need review
      (criticalIssues > 0)

  # 6. Auto-approve for trusted contributors
  auto-approve:
    type: command
    depends_on: [tests-full, tests-quick, security-scan]
    exec: gh pr review --approve && gh pr merge --auto --squash
    if: |
      // Only for collaborators and above
      hasMinPermission('COLLABORATOR') &&
      // All checks passed
      totalIssues === 0 &&
      // Tests passed (check whichever ran)
      ((outputs["tests-quick"] && outputs["tests-quick"].error === false) ||
       (outputs["tests-full"] && outputs["tests-full"].error === false))
```

## Related Documentation

- [Liquid Templates](./liquid-templates.md) - Template syntax and variables
- [Debugging Guide](./debugging.md) - Debugging JavaScript expressions
- [Command Provider](./command-provider.md) - Command execution and transforms
- [Configuration Reference](./configuration.md) - Full configuration options
