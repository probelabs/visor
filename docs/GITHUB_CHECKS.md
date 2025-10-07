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

checks:
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

## Troubleshooting

### Check Runs Not Appearing
1. Verify token has `checks:write` permission
2. Check action logs for permission errors
3. Ensure `create-check: 'true'` (default)
4. Verify configuration `output.github_checks.enabled: true`

### Check Runs Failing Unexpectedly
1. Review failure conditions in configuration
2. Check issue severity counts in check run details
3. Verify expressions use correct variable names
4. Test failure conditions with sample data

### Permission Denied Errors
1. For GitHub Apps: Check repository permissions include "Checks (Write)"
2. For PATs: Ensure token has appropriate repository scopes
3. For default token: Usually works out of the box

## Migration from Comments Only

If you're currently using Visor with only PR comments:

1. **No action required**: GitHub checks are enabled by default
2. **Customize check names**: Set `output.github_checks.name_prefix`
3. **Add failure conditions**: Define `fail_if` conditions for your checks
4. **Test in staging**: Verify checks appear correctly before production use

The integration is designed to be backward-compatible - existing configurations continue to work with the addition of GitHub checks.
