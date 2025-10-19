# GitHub Checks API Integration

Visor now supports GitHub Checks API integration, allowing each configured check to appear as a separate check run in the GitHub PR interface with proper status reporting and issue annotations.

## Features

- **Individual Check Runs**: Each configured check appears as a separate GitHub check run
- **Real-time Status Updates**: Check runs show "in progress" while executing and complete with success/failure
- **Issue Annotations**: Issues are displayed as inline annotations on the PR files
- **Failure Conditions**: Support for custom failure conditions using simple expressions
- **Configurable**: Can be enabled/disabled via action inputs or configuration
- **Permission Handling**: Gracefully handles insufficient permissions with helpful error messages

## Configuration

### Action Inputs

```yaml
- uses: your-org/visor@main
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    # Enable/disable GitHub check runs (default: true)
    create-check: 'true'
    # Other Visor configurations...
```

### Visor Configuration (`.visor.yaml`)

```yaml
version: "1.0"

output:
  github_checks:
    # Enable/disable GitHub check runs (default: true)
    enabled: true
    # Create individual check runs per check (default: true)
    # If false, creates a single combined check run
    per_check: true
    # Custom name prefix for check runs (default: "Visor")
    name_prefix: "Visor AI"

steps:
  security-audit:
    type: ai
    prompt: "Review for security vulnerabilities"
    # Fail if critical issues found
    fail_if: "criticalIssues > 0"

  performance-review:
    type: ai
    prompt: "Analyze for performance issues"
    # Fail if more than 2 error-level issues
    fail_if: "errorIssues > 2"

# Global failure condition (applies to all checks)
fail_if: "criticalIssues > 0"
```

## Failure Conditions

Use simple expressions to define when checks should fail:

### Available Variables
- `totalIssues`: Total number of issues found
- `criticalIssues`: Number of critical severity issues
- `errorIssues`: Number of error severity issues
- `warningIssues`: Number of warning severity issues

### Examples
```yaml
fail_if: "criticalIssues > 0"           # Fail if any critical issues
fail_if: "errorIssues > 5"             # Fail if more than 5 errors
fail_if: "totalIssues > 10"            # Fail if more than 10 total issues
fail_if: "criticalIssues + errorIssues > 3"  # Fail if critical + error > 3
```

## GitHub Permissions

To use GitHub Checks API, your GitHub token needs the `checks:write` permission:

### GitHub Actions (default token)
The default `${{ secrets.GITHUB_TOKEN }}` includes `checks:write` permission by default.

### Personal Access Token (PAT)
If using a PAT, ensure it has the following scopes:
- `repo` (for private repositories)
- `public_repo` (for public repositories)

### GitHub App
If using GitHub App authentication, ensure the app has:
- **Repository permissions**: Checks (Write)

## Action Outputs

The action provides outputs about the GitHub checks:

```yaml
- name: Check Results
  run: |
    echo "Checks API Available: ${{ steps.visor.outputs.checks-api-available }}"
    echo "Check Runs Created: ${{ steps.visor.outputs.check-runs-created }}"
    echo "Check Run URLs: ${{ steps.visor.outputs.check-runs-urls }}"
```

## Error Handling

### Insufficient Permissions
If the GitHub token lacks `checks:write` permission:
- A warning is logged
- GitHub checks are skipped
- PR comments continue to work normally
- The action does not fail

### API Rate Limits
If GitHub API rate limits are hit:
- Individual check runs may fail
- Failed checks show appropriate error messages
- Other checks continue to execute

### Network Issues
If GitHub API is unavailable:
- Check creation is retried
- Failures are logged but don't stop the review
- PR comments serve as fallback

## Examples

### Basic Setup

```yaml
name: Visor Code Review
on:
  pull_request:
    types: [opened, synchronize]

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: your-org/visor@main
        with:
          github-token: ${{ secrets.GITHUB_TOKEN }}
          config-path: '.visor.yaml'
```

### With GitHub App Authentication

```yaml
- uses: your-org/visor@main
  with:
    app-id: ${{ secrets.VISOR_APP_ID }}
    private-key: ${{ secrets.VISOR_PRIVATE_KEY }}
    config-path: '.visor.yaml'
```

### Disable GitHub Checks

```yaml
- uses: your-org/visor@main
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
    create-check: 'false'  # Disable GitHub checks
    comment-on-pr: 'true'  # Still comment on PR
```

## Fork PR Support

### Overview

GitHub restricts permissions for workflows triggered by external contributors from forked repositories for security reasons. This affects check runs but not PR comments.

**Default behavior (`pull_request` trigger)**:
- ✅ Works for PRs from same repository (branch PRs)
- ❌ Check runs fail with 403 error for fork PRs
- ✅ PR comments work for all PRs (including forks)
- ✅ Visor gracefully falls back to comments only for forks

**For fork PR support with check runs** (use `pull_request_target` trigger):
- ✅ Works for both fork and branch PRs
- ✅ Check runs work for all PRs
- ⚠️ Security consideration: Workflow runs with write permissions

### Enabling Fork PR Support

To enable check runs for external contributor PRs, change the workflow trigger:

```yaml
name: Visor Code Review
on:
  pull_request_target:  # Instead of pull_request
    types: [opened, synchronize, edited]

permissions:
  contents: read
  pull-requests: write
  issues: write
  checks: write

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      # Explicitly checkout PR code (not base branch)
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.pull_request.head.sha }}

      - uses: probelabs/visor@v1
        with:
          # ... your configuration
```

**Key differences**:
1. **Trigger**: `pull_request_target` instead of `pull_request`
2. **Checkout**: Must specify `ref: ${{ github.event.pull_request.head.sha }}` to analyze PR code
3. **Security**: Workflow definition comes from base branch (protected from malicious modifications)

### Security Considerations

When using `pull_request_target`:

✅ **Safe** (Visor's approach):
- Workflow file is from base branch (can't be modified by PR)
- Only analyzes code (read-only operation)
- Uses controlled AI providers with API keys from secrets
- Comments and checks are the only write operations

⚠️ **Risks to avoid**:
- Don't execute arbitrary code from the PR (scripts, dependencies)
- Don't use `npm install` if package.json is modified by PR
- Don't run untrusted build commands

### Fallback Behavior

If check runs fail (403 error), Visor automatically:

1. **Logs clean error message**:
   ```
   ⚠️  Could not create check run for security: Resource not accessible by integration
   💬 Review will continue using PR comments instead
   ```

2. **Continues review**: All checks run normally
3. **Uses PR comments**: Full review posted as comment
4. **Fails if needed**: Action still fails if critical issues found

No code changes needed - fallback is automatic.

## Troubleshooting

### Check Runs Not Appearing
1. Verify token has `checks:write` permission
2. Check action logs for permission errors
3. Ensure `create-check: 'true'` (default)
4. Verify configuration `output.github_checks.enabled: true`
5. **For fork PRs**: Use `pull_request_target` trigger (see [Fork PR Support](#fork-pr-support))

### Check Runs Failing Unexpectedly
1. Review failure conditions in configuration
2. Check issue severity counts in check run details
3. Verify expressions use correct variable names
4. Test failure conditions with sample data

### Permission Denied Errors (403)
1. **For fork PRs**: This is expected with `pull_request` trigger - use `pull_request_target` or accept comment-only mode
2. For GitHub Apps: Check repository permissions include "Checks (Write)"
3. For PATs: Ensure token has appropriate repository scopes
4. For default token: Usually works out of the box for same-repo PRs

## Migration from Comments Only

If you're currently using Visor with only PR comments:

1. **No action required**: GitHub checks are enabled by default
2. **Customize check names**: Set `output.github_checks.name_prefix`
3. **Add failure conditions**: Define `fail_if` conditions for your checks
4. **Test in staging**: Verify checks appear correctly before production use

The integration is designed to be backward-compatible - existing configurations continue to work with the addition of GitHub checks.
