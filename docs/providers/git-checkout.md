# Git Checkout Provider

The `git-checkout` provider enables workflows to checkout code from git repositories using efficient worktree management for multi-workflow execution.

## Features

- **Git Worktrees**: Efficient disk usage by sharing git objects across checkouts
- **Dynamic Variables**: Support for Liquid templates to resolve branches/refs dynamically
- **Parallel Workflows**: Multiple workflows can checkout different branches simultaneously
- **Automatic Cleanup**: Worktrees are cleaned up when workflows complete
- **GitHub Actions Compatible**: Similar configuration to `actions/checkout@v4`

## Configuration

### Basic Usage

```yaml
version: "1.0"

steps:
  checkout:
    type: git-checkout
    ref: "{{ pr.head }}"
```

### Full Configuration Options

```yaml
steps:
  checkout-with-options:
    type: git-checkout

    # Required: Git reference to checkout
    ref: "{{ pr.head }}"              # Branch, tag, commit SHA, or dynamic variable

    # Optional: Repository (defaults to current PR repository)
    repository: owner/repo            # GitHub repository or URL

    # Optional: Authentication token (defaults to GITHUB_TOKEN env var)
    token: "{{ env.GITHUB_TOKEN }}"

    # Optional: Fetch configuration
    fetch_depth: 1                    # Shallow clone depth (default: full history)
    fetch_tags: false                 # Fetch tags (default: false)
    submodules: false                 # Checkout submodules (default: false)
                                      # Can be: true, false, or 'recursive'
    clone_timeout_ms: 300000          # Clone timeout in milliseconds (default: 300000 = 5 min)

    # Optional: Working directory (auto-generated if not specified)
    working_directory: /tmp/my-checkout

    # Optional: Worktree behavior
    use_worktree: true                # Use git worktrees (default: true)
    clean: true                       # Clean before checkout (default: true)

    # Optional: Advanced features
    sparse_checkout: []               # Sparse checkout paths
    lfs: false                        # Git LFS support (default: false)

    # Standard check options
    timeout: 60                       # Timeout in seconds (default: 60)
    criticality: internal
    depends_on: []
    if: "true"

    # Cleanup behavior
    cleanup_on_failure: true          # Cleanup if step fails (default: true)
    persist_worktree: false           # Keep worktree after workflow (default: false)
```

## Output

The provider returns the following output structure:

```typescript
{
  success: boolean,         // Whether checkout succeeded
  path: string,             // Absolute path to checked out code
  ref: string,              // Resolved ref that was checked out
  commit: string,           // Full commit SHA
  worktree_id: string,      // Unique worktree identifier
  repository: string,       // Repository that was checked out
  is_worktree: boolean,     // Whether this is a worktree
  workspace_path?: string,  // Human-readable path within workspace (when workspace isolation is enabled)
  error?: string,           // Error message if failed
}
```

## Examples

### Example 1: Checkout PR Head

```yaml
version: "1.0"

steps:
  checkout:
    type: git-checkout
    ref: "{{ pr.head }}"

  build:
    type: command
    depends_on: [checkout]
    exec: "npm run build"
    working_directory: "{{ outputs.checkout.path }}"
```

### Example 2: Checkout Multiple Branches

```yaml
version: "1.0"

steps:
  checkout-head:
    type: git-checkout
    ref: "{{ pr.head }}"

  checkout-base:
    type: git-checkout
    ref: "{{ pr.base }}"

  compare:
    type: command
    depends_on: [checkout-head, checkout-base]
    exec: |
      echo "Comparing branches:"
      echo "Head: {{ outputs['checkout-head'].commit }}"
      echo "Base: {{ outputs['checkout-base'].commit }}"
      diff -r "{{ outputs['checkout-head'].path }}" "{{ outputs['checkout-base'].path }}" || true
```

### Example 3: Cross-Repository Checkout

```yaml
version: "1.0"

steps:
  checkout-main:
    type: git-checkout
    repository: myorg/main-repo
    ref: main

  checkout-dependency:
    type: git-checkout
    repository: myorg/dependency-repo
    ref: v1.0.0
    token: "{{ env.DEPENDENCY_TOKEN }}"

  integration-test:
    type: command
    depends_on: [checkout-main, checkout-dependency]
    exec: ./scripts/integration-test.sh
    working_directory: "{{ outputs['checkout-main'].path }}"
    env:
      DEPENDENCY_PATH: "{{ outputs['checkout-dependency'].path }}"
```

### Example 4: Dynamic Branch Resolution

```yaml
version: "1.0"

steps:
  determine-branch:
    type: command
    exec: |
      if [ "{{ pr.base }}" == "main" ]; then
        echo '{"branch": "stable"}'
      else
        echo '{"branch": "{{ pr.base }}"}'
      fi
    transform_js: JSON.parse(output)

  checkout-resolved:
    type: git-checkout
    depends_on: [determine-branch]
    ref: "{{ outputs['determine-branch'].branch }}"
```

### Example 5: Sparse Checkout

```yaml
version: "1.0"

steps:
  checkout-partial:
    type: git-checkout
    ref: main
    sparse_checkout:
      - src/
      - tests/
      - package.json
      - package-lock.json

  test:
    type: command
    depends_on: [checkout-partial]
    exec: npm test
    working_directory: "{{ outputs['checkout-partial'].path }}"
```

### Example 6: Deep Clone with Full History

```yaml
version: "1.0"

steps:
  checkout-full:
    type: git-checkout
    ref: main
    fetch_depth: 0      # Full history
    fetch_tags: true    # Include all tags

  analyze-history:
    type: command
    depends_on: [checkout-full]
    exec: |
      git log --oneline --graph --all --decorate
      git describe --tags --always
    working_directory: "{{ outputs['checkout-full'].path }}"
```

### Example 7: Submodules Support

```yaml
version: "1.0"

steps:
  checkout-with-submodules:
    type: git-checkout
    ref: "{{ pr.head }}"
    submodules: recursive

  build-all:
    type: command
    depends_on: [checkout-with-submodules]
    exec: |
      npm install
      npm run build
    working_directory: "{{ outputs['checkout-with-submodules'].path }}"
```

### Example 8: Conditional Checkout

```yaml
version: "1.0"

steps:
  check-should-checkout:
    type: command
    exec: |
      # Only checkout if PR has specific label
      if [[ "{{ pr.labels }}" == *"needs-checkout"* ]]; then
        echo '{"should_checkout": true}'
      else
        echo '{"should_checkout": false}'
      fi
    transform_js: JSON.parse(output)

  checkout:
    type: git-checkout
    depends_on: [check-should-checkout]
    if: "outputs['check-should-checkout'].should_checkout"
    ref: "{{ pr.head }}"

  test:
    type: command
    depends_on: [checkout]
    if: "outputs.checkout?.success"
    exec: npm test
    working_directory: "{{ outputs.checkout.path }}"
```

### Example 9: Persistent Worktree for Multiple Workflows

```yaml
version: "1.0"

steps:
  checkout-persistent:
    type: git-checkout
    ref: main
    persist_worktree: true    # Keep after workflow completes
    working_directory: /tmp/persistent-workspace

  # This worktree will remain after the workflow completes
  # and can be reused by subsequent workflows
```

## Error Handling

The provider handles various error scenarios:

```yaml
steps:
  checkout:
    type: git-checkout
    ref: "{{ pr.head }}"
    guarantee: "output.success == true"

  handle-failure:
    type: command
    depends_on: [checkout]
    if: "!outputs.checkout.success"
    exec: |
      echo "Checkout failed: {{ outputs.checkout.error }}"
      exit 1
```

## Worktree Management

### How Worktrees Work

The provider uses git worktrees to efficiently manage multiple checkouts:

1. **Bare Repository**: A bare repository is cached at `${base_path}/repos/`
2. **Fetch Updates**: On each checkout, run `git remote update --prune` to get latest code
3. **Worktrees**: Working directories are created at `${base_path}/worktrees/`
4. **Shared Objects**: Git objects are shared between worktrees, saving disk space
5. **Automatic Cleanup**: Worktrees are cleaned up when workflows complete

**Important**: The bare repository is updated on **every checkout run**, ensuring you always get the latest code, similar to GitHub Actions behavior.

### Storage Structure

By default, worktrees are stored in `.visor/worktrees/` in your project root:

```
.visor/worktrees/
├── repos/
│   └── owner-repo.git/          # Bare repository (shared)
│       ├── objects/              # Git objects (shared)
│       └── worktrees/            # Worktree metadata
└── worktrees/
    ├── owner-repo-main-abc123/   # Worktree 1
    └── owner-repo-dev-def456/    # Worktree 2
```

**Benefits of project-local storage:**
- Worktrees stay with the project
- Easy to locate and debug
- Can be excluded from version control (add `.visor/worktrees/` to `.gitignore`)
- Automatic cleanup when removing the project

### Configuration

Configure worktree behavior globally in `.visor.yaml`:

```yaml
version: "1.0"

worktree_cache:
  enabled: true
  base_path: .visor/worktrees        # Default: .visor/worktrees/ in project root
  cleanup_on_exit: true              # Default: true
  max_age_hours: 24                  # Cleanup after 24 hours

steps:
  # ... your steps
```

**Environment Variable Override:**

You can also set the base path via environment variable:

```bash
export VISOR_WORKTREE_PATH=/custom/path/to/worktrees
```

This takes precedence over the config file.

### Automatic Worktree Cleanup

Worktrees are automatically cleaned up in the following scenarios:

- **On process exit**: When the visor process terminates normally
- **On SIGINT/SIGTERM**: When the process receives interrupt signals (Ctrl+C)
- **Age-based cleanup**: Worktrees older than `max_age_hours` are removed on subsequent runs
- **Stale process cleanup**: Worktrees from dead processes are automatically removed

To manually clean up worktrees, you can remove the `.visor/worktrees/` directory:

```bash
# Remove all worktrees for current project
rm -rf .visor/worktrees/
```

## Best Practices

### 1. Use Shallow Clones for Speed (Recommended for CI/CD)

```yaml
steps:
  checkout:
    type: git-checkout
    ref: "{{ pr.head }}"
    fetch_depth: 1    # Only fetch latest commit (much faster)
```

**Why shallow clones?**
- **Faster initial clone**: 5-10x faster for large repositories
- **Less bandwidth**: Only downloads recent commit history
- **Sufficient for most workflows**: Tests, builds, and deployments rarely need full history

**When to use full history (fetch_depth: 0 or omit):**
- Git operations that need history (e.g., `git log`, `git blame`)
- Generating changelogs
- License compliance scanning
- Full repository analysis

**Default behavior**: If `fetch_depth` is not specified, clones full history (all commits)

### 2. Cleanup Failed Checkouts

```yaml
steps:
  checkout:
    type: git-checkout
    ref: "{{ pr.head }}"
    cleanup_on_failure: true    # Remove on failure
```

### 3. Use Specific Working Directories for Predictability

```yaml
steps:
  checkout:
    type: git-checkout
    ref: "{{ pr.head }}"
    working_directory: /tmp/my-build-{{ pr.number }}
```

### 4. Validate Checkout Success

```yaml
steps:
  checkout:
    type: git-checkout
    ref: "{{ pr.head }}"
    guarantee: "output.success == true && output.commit != null"
```

### 5. Pass Checkout Path to Subsequent Steps

```yaml
steps:
  checkout:
    type: git-checkout
    ref: "{{ pr.head }}"

  build:
    type: command
    depends_on: [checkout]
    exec: npm run build
    working_directory: "{{ outputs.checkout.path }}"
    assume: "outputs.checkout.success"
```

## Troubleshooting

### Problem: Checkout Times Out

**Solution**: Increase the timeout or use shallow clones:

```yaml
steps:
  checkout:
    type: git-checkout
    ref: "{{ pr.head }}"
    fetch_depth: 1        # Shallow clone
    timeout: 120          # 2 minutes
```

### Problem: Authentication Fails

**Solution**: Ensure token is set correctly:

```yaml
steps:
  checkout:
    type: git-checkout
    ref: "{{ pr.head }}"
    token: "{{ env.GITHUB_TOKEN }}"   # Explicit token
```

### Problem: Worktrees Not Cleaned Up

**Solution**: Enable cleanup and check configuration:

```yaml
worktree_cache:
  cleanup_on_exit: true
  max_age_hours: 24

steps:
  checkout:
    type: git-checkout
    ref: "{{ pr.head }}"
    persist_worktree: false    # Don't persist
```

### Problem: Multiple Workflows Conflict

**Solution**: Use unique working directories:

```yaml
steps:
  checkout:
    type: git-checkout
    ref: "{{ pr.head }}"
    working_directory: /tmp/workflow-{{ inputs.workflow_id }}-checkout
```

### Problem: Disk Space Issues

**Solution**: Cleanup stale worktrees regularly:

```bash
# Via CLI
visor worktree cleanup

# Or configure automatic cleanup
worktree_cache:
  max_age_hours: 12    # Cleanup after 12 hours
```

## Comparison with GitHub Actions Checkout

| Feature | git-checkout | actions/checkout@v4 |
|---------|--------------|---------------------|
| Branch checkout | ✅ | ✅ |
| Tag checkout | ✅ | ✅ |
| Commit checkout | ✅ | ✅ |
| Shallow clone | ✅ | ✅ |
| Submodules | ✅ | ✅ |
| LFS | ✅ | ✅ |
| Sparse checkout | ✅ | ✅ |
| Dynamic variables | ✅ | ❌ |
| Worktrees | ✅ | ❌ |
| Multiple checkouts | ✅ | ✅ |
| Automatic cleanup | ✅ | ✅ |

## Performance Considerations

### Worktree Benefits

- **Disk savings**: Shared objects between checkouts
- **Faster checkouts**: No need to re-download objects
- **Parallel execution**: Multiple branches checked out simultaneously

### Benchmarks

Typical performance (example repository: 100MB):

| Operation | Time |
|-----------|------|
| First checkout (bare clone) | 30s |
| Subsequent checkout (worktree) | 5s |
| Regular clone (comparison) | 30s |

### Optimization Tips

1. Use shallow clones for CI: `fetch_depth: 1`
2. Limit sparse checkout to needed paths
3. Disable tags if not needed: `fetch_tags: false`
4. Reuse worktrees across workflows when possible

## Security Considerations

### Token Handling

- Tokens are never logged or exposed in output
- Use environment variables for tokens: `{{ env.GITHUB_TOKEN }}`
- Tokens are redacted from error messages

### Path Safety

- Working directory paths are validated to prevent traversal attacks
- Worktrees are isolated to configured base path

### Resource Limits

- Configure `max_age_hours` to prevent disk exhaustion
- Use timeouts to prevent hanging checkouts
- Monitor disk usage in `.visor/worktrees/` (or custom `VISOR_WORKTREE_PATH`)

## Related Documentation

- [Command Provider](../command-provider.md) - Execute commands in checked out code
- [Workflows](../workflows.md) - Compose multi-step workflows
- [Configuration Reference](../configuration.md) - Full configuration options
