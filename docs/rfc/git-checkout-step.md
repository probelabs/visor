# RFC: Git Checkout Step Provider

## Status
**Accepted** - Implementation in progress

### Decision Record
- **Date**: 2025-11-21
- **Decision**: Implement git worktrees from day one
- **Rationale**: Provides the most scalable solution for parallel workflows, better disk efficiency, and matches our long-term vision. The complexity is manageable and the benefits justify the initial investment.

## Summary
Add a `git-checkout` check provider that enables workflows to checkout code from git repositories, supporting dynamic branch resolution, git worktrees for efficient multi-workflow execution, and proper cleanup strategies.

## Motivation

Currently, Visor workflows operate on the existing codebase in the working directory. To enable more advanced workflows, we need:

1. **Isolated workspaces**: Multiple workflows running in parallel need separate working directories
2. **Version flexibility**: Ability to checkout different branches, commits, or PRs
3. **Performance**: Reuse git objects across workflows via git worktrees
4. **Dynamic branches**: Checkout based on PR context or previous step outputs
5. **GitHub Actions parity**: Similar functionality to `actions/checkout@v4`

## Design Goals

- **Efficient**: Use git worktrees to share objects between multiple checkouts
- **Safe**: Proper cleanup on workflow completion, avoid orphaned worktrees
- **Flexible**: Support dynamic variable resolution for branches, refs, etc.
- **Compatible**: Work with existing workflow patterns and dependency chains
- **Configurable**: Allow global worktree cache location configuration

## Detailed Design

### 1. Provider Interface

```typescript
class GitCheckoutProvider extends CheckProvider {
  getName(): string {
    return 'git-checkout';
  }

  async execute(
    prInfo: PRInfo,
    config: GitCheckoutConfig,
    dependencyResults?: Map<string, ReviewSummary>,
    context?: ExecutionContext
  ): Promise<ReviewSummary> {
    // Implementation details below
  }
}
```

### 2. Configuration Schema

```yaml
version: "1.0"

# Optional global configuration
worktree_cache:
  enabled: true
  base_path: .visor/worktrees        # Default: .visor/worktrees/ in project root
  cleanup_on_exit: true              # Default: true
  max_age_hours: 24                  # Cleanup worktrees older than this

steps:
  checkout-pr:
    type: git-checkout

    # Git reference to checkout (supports dynamic variables)
    ref: "{{ pr.head }}"              # Can be: branch, tag, commit SHA, or "pr.head"/"pr.base"

    # Repository configuration
    repository: ""                     # Default: current repository (from prInfo.repo)
    token: "{{ env.GITHUB_TOKEN }}"   # Default: use GITHUB_TOKEN env var

    # Fetch configuration (similar to actions/checkout)
    fetch_depth: 1                    # Default: 1 (shallow clone)
    fetch_tags: false                 # Default: false
    submodules: false                 # Default: false, can be: true, false, 'recursive'

    # Worktree configuration
    working_directory: ""             # Default: auto-generated based on ref
    use_worktree: true                # Default: true (use worktrees for efficiency)
    clean: true                       # Default: true (clean working dir before checkout)

    # Advanced options
    sparse_checkout: []               # Optional: array of paths for sparse checkout
    lfs: false                        # Default: false (git-lfs support)

    # Standard check options
    timeout: 60                       # Default: 60 seconds
    criticality: internal
    assume: "true"
    guarantee: "output.success == true && output.path != null"

    # Cleanup behavior
    cleanup_on_failure: true          # Default: true
    persist_worktree: false           # Default: false (cleanup after workflow)
```

### 3. Output Schema

The provider returns a `ReviewSummary` with:

```typescript
{
  issues: [],  // Empty on success, contains error issues on failure
  output: {
    success: boolean,
    path: string,              // Absolute path to checked out code
    ref: string,               // Resolved ref that was checked out
    commit: string,            // Full commit SHA
    worktree_id: string,       // Unique worktree identifier
    repository: string,        // Repository that was checked out
    is_worktree: boolean,      // Whether this is a worktree or regular clone
  }
}
```

### 4. Git Worktree Architecture

#### 4.1 Worktree Storage Structure

By default, worktrees are stored in `.visor/worktrees/` in the project root:

```
.visor/worktrees/
├── repos/
│   ├── owner-repo1.git/          # Bare repository (shared)
│   │   ├── objects/               # Git objects (shared across worktrees)
│   │   ├── refs/
│   │   └── worktrees/
│   │       ├── worktree-abc123/  # Worktree metadata
│   │       └── worktree-def456/
│   └── owner-repo2.git/
└── worktrees/
    ├── owner-repo1-abc123/       # Actual working directory
    │   └── .git -> ../repos/owner-repo1.git/worktrees/worktree-abc123/
    └── owner-repo1-def456/
```

**Benefits of project-local storage:**
- Worktrees remain with the project
- Easy to locate and debug
- Can be excluded from version control (add `.visor/worktrees/` to `.gitignore`)
- Automatic cleanup when removing the project
- No pollution of system-wide temp directories

**Configuration:**
- Default: `.visor/worktrees/` (relative to project root)
- Environment variable: `VISOR_WORKTREE_PATH=/custom/path`
- Config file: `worktree_cache.base_path: /custom/path`

#### 4.2 Worktree Lifecycle

1. **Initialization**:
   - Check if bare repo exists at `${base_path}/repos/${owner}-${repo}.git`
   - If not, create: `git clone --bare ${repo_url} ${bare_repo_path}`
   - If exists, update: `git -C ${bare_repo_path} remote update`

2. **Worktree Creation**:
   - Generate unique worktree ID: `${repo}-${ref_sanitized}-${short_hash}`
   - Create worktree: `git -C ${bare_repo_path} worktree add ${worktree_path} ${ref}`
   - Track in metadata file: `${worktree_path}/.visor-metadata.json`

3. **Worktree Reuse**:
   - Check if worktree for same ref already exists
   - If `clean: true`, reset and clean: `git reset --hard && git clean -fdx`
   - If `clean: false`, reuse as-is

4. **Cleanup**:
   - On workflow completion: Remove worktree unless `persist_worktree: true`
   - On failure: Remove worktree if `cleanup_on_failure: true`
   - Command: `git -C ${bare_repo_path} worktree remove ${worktree_path} --force`

#### 4.3 Metadata Tracking

Each worktree maintains metadata for tracking and cleanup:

```json
{
  "worktree_id": "owner-repo-main-abc123",
  "created_at": "2025-11-21T10:00:00Z",
  "workflow_id": "workflow-xyz",
  "ref": "refs/heads/main",
  "commit": "1234567890abcdef",
  "repository": "owner/repo",
  "pid": 12345,
  "cleanup_on_exit": true
}
```

### 5. Dynamic Variable Resolution

The provider supports Liquid templates for dynamic values:

```yaml
steps:
  checkout-head:
    type: git-checkout
    ref: "{{ pr.head }}"           # Resolves to PR head branch

  checkout-base:
    type: git-checkout
    ref: "{{ pr.base }}"           # Resolves to PR base branch

  checkout-from-previous:
    type: git-checkout
    depends_on: [determine-branch]
    ref: "{{ outputs['determine-branch'].branch }}"  # From previous step

  checkout-with-depth:
    type: git-checkout
    ref: main
    fetch_depth: "{{ outputs.config.depth | default: 10 }}"  # Dynamic depth
```

### 6. Cleanup Strategies

#### 6.1 Automatic Cleanup (Default)

- **On workflow completion**: Remove all worktrees created by workflow
- **On process exit**: Cleanup handler removes worktrees (via `process.on('exit')`)
- **Stale worktree cleanup**: Background task removes worktrees older than `max_age_hours`

#### 6.2 Manual Cleanup

- **CLI command**: `visor worktree cleanup [--all] [--repo=owner/repo]`
- **Config option**: `persist_worktree: true` to keep worktree after workflow

#### 6.3 Cleanup Safety

- **Lock files**: Use lock files to prevent cleanup of active worktrees
- **PID tracking**: Check if PID in metadata is still alive before cleanup
- **Graceful degradation**: If cleanup fails, log warning but don't fail workflow

### 7. Error Handling

```typescript
// Timeout handling
if (timeoutExceeded) {
  return {
    issues: [{
      file: 'git-checkout',
      line: 0,
      ruleId: 'git-checkout/timeout',
      message: `Checkout timed out after ${timeout}s`,
      severity: 'error',
      category: 'logic',
    }],
    output: { success: false, error: 'timeout' }
  };
}

// Git command failures
if (exitCode !== 0) {
  return {
    issues: [{
      file: 'git-checkout',
      line: 0,
      ruleId: 'git-checkout/git_error',
      message: `Git checkout failed: ${stderr}`,
      severity: 'error',
      category: 'logic',
    }],
    output: { success: false, error: stderr }
  };
}

// Invalid ref
if (refNotFound) {
  return {
    issues: [{
      file: 'git-checkout',
      line: 0,
      ruleId: 'git-checkout/invalid_ref',
      message: `Invalid ref: ${ref}`,
      severity: 'error',
      category: 'logic',
    }],
    output: { success: false, error: 'invalid_ref' }
  };
}
```

### 8. Integration with Existing Providers

#### 8.1 Use with Command Provider

```yaml
steps:
  checkout:
    type: git-checkout
    ref: "{{ pr.head }}"

  build:
    type: command
    depends_on: [checkout]
    exec: "npm run build"
    working_directory: "{{ outputs.checkout.path }}"
    assume: "outputs.checkout.success"
```

#### 8.2 Use with MCP Provider

```yaml
steps:
  checkout:
    type: git-checkout
    ref: main

  analyze:
    type: mcp
    depends_on: [checkout]
    tool: analyze_codebase
    args:
      path: "{{ outputs.checkout.path }}"
```

### 9. GitHub Actions Compatibility

Mapping from `actions/checkout@v4` to our provider:

| actions/checkout | git-checkout | Notes |
|-----------------|--------------|-------|
| `ref` | `ref` | Direct mapping |
| `repository` | `repository` | Direct mapping |
| `token` | `token` | Direct mapping |
| `fetch-depth` | `fetch_depth` | Direct mapping |
| `fetch-tags` | `fetch_tags` | Direct mapping |
| `submodules` | `submodules` | Direct mapping |
| `clean` | `clean` | Direct mapping |
| `sparse-checkout` | `sparse_checkout` | Direct mapping |
| `lfs` | `lfs` | Direct mapping |
| `path` | `working_directory` | Different name |
| `persist-credentials` | N/A | Always use token |
| `set-safe-directory` | N/A | Handled automatically |

### 10. Implementation Phases

#### Phase 1: Basic Checkout (MVP)
- Single repository checkout
- Configurable ref/branch
- Basic error handling
- No worktrees (use regular clone)

#### Phase 2: Worktree Support
- Implement worktree architecture
- Bare repository caching
- Worktree reuse logic
- Metadata tracking

#### Phase 3: Advanced Features
- Sparse checkout
- Submodules support
- LFS support
- Parallel workflow safety

#### Phase 4: Cleanup & Optimization
- Automatic cleanup handlers
- Stale worktree cleanup
- CLI commands for management
- Performance optimizations

## Configuration Examples

### Example 1: Simple PR Checkout

```yaml
version: "1.0"
steps:
  checkout:
    type: git-checkout
    ref: "{{ pr.head }}"
```

### Example 2: Multiple Branch Checkout

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
    exec: "diff -r {{ outputs['checkout-head'].path }} {{ outputs['checkout-base'].path }}"
```

### Example 3: Cross-Repository Checkout

```yaml
version: "1.0"
steps:
  checkout-main-repo:
    type: git-checkout
    repository: owner/main-repo
    ref: main

  checkout-dependency:
    type: git-checkout
    repository: owner/dependency-repo
    ref: v1.0.0

  integration-test:
    type: command
    depends_on: [checkout-main-repo, checkout-dependency]
    exec: "./run-integration-tests.sh"
```

### Example 4: Deep Clone with Submodules

```yaml
version: "1.0"
steps:
  checkout-full:
    type: git-checkout
    ref: main
    fetch_depth: 0      # Full history
    fetch_tags: true    # Include all tags
    submodules: recursive
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
```

## Open Questions

1. **Worktree vs Clone**: Should we default to worktrees or regular clones? Worktrees are more efficient but have complexity.

2. **Cleanup timing**: Should cleanup happen:
   - Immediately after workflow completion?
   - On process exit?
   - Via background cleanup task?
   - All of the above?

3. **Concurrent workflows**: How do we handle multiple workflows trying to use the same worktree?
   - Lock files?
   - Clone per workflow?
   - Reference counting?

4. **Storage limits**: Should we:
   - Limit number of worktrees?
   - Limit total disk usage?
   - Add LRU eviction?

5. **Cross-platform**: How does this work on:
   - Linux (easy)
   - macOS (should work)
   - Windows (git worktrees have issues on older versions)

6. **Authentication**: How to handle:
   - Private repositories?
   - Token expiry?
   - SSH keys vs HTTPS tokens?

7. **Bare repository updates**: ✅ **RESOLVED**
   - **Decision**: Update on every checkout (like GitHub Actions)
   - **Implementation**: `git remote update --prune` runs before each worktree creation
   - **Benefit**: Always get latest code, no stale checkouts
   - **Performance**: ~1-5 seconds for update vs ~30s for full clone

8. **Error recovery**: If worktree is corrupted, should we:
   - Remove and recreate?
   - Fail the workflow?
   - Try to repair?

## Security Considerations

1. **Token handling**: Tokens must be:
   - Stored securely in environment
   - Not logged or exposed in output
   - Redacted from error messages

2. **Path traversal**: Validate `working_directory` to prevent:
   - Path traversal attacks (`../../etc/passwd`)
   - Writing to sensitive directories

3. **Resource exhaustion**: Limit:
   - Number of concurrent checkouts
   - Total disk usage
   - Number of worktrees per repository

4. **Cleanup safety**: Ensure cleanup doesn't:
   - Delete files outside worktree directories
   - Interfere with other processes
   - Remove the bare repository accidentally

## Performance Considerations

1. **Worktree benefits**:
   - Shared objects save disk space
   - Faster checkout (no object download)
   - Better for multiple checkouts of same repo

2. **Worktree overhead**:
   - Initial bare clone is slower
   - Metadata management complexity
   - Cleanup coordination

3. **Optimization opportunities**:
   - Shallow clones for most use cases
   - Reference clones for local development
   - Parallel fetch operations

## Testing Strategy

1. **Unit tests**:
   - Config validation
   - Template resolution
   - Error handling

2. **Integration tests**:
   - Worktree creation/deletion
   - Concurrent workflow handling
   - Cleanup operations

3. **E2E tests**:
   - Full workflow with checkout
   - Multiple repositories
   - Error scenarios

4. **Performance tests**:
   - Checkout speed vs regular clone
   - Concurrent checkout handling
   - Cleanup performance

## Documentation Requirements

1. **User documentation**:
   - Configuration reference
   - Common patterns
   - Troubleshooting guide

2. **Developer documentation**:
   - Architecture overview
   - Worktree management
   - Cleanup strategies

3. **Migration guide**:
   - From regular clones
   - From external checkout steps

## Alternatives Considered

### Alternative 1: No Worktrees, Just Clone
**Pros**: Simpler implementation, no cleanup complexity
**Cons**: Slower, wastes disk space, doesn't scale to multiple workflows

### Alternative 2: Use Docker Volumes
**Pros**: Isolated environments, easy cleanup
**Cons**: Requires Docker, overhead, not available everywhere

### Alternative 3: Use Existing Checkout Action
**Pros**: No implementation needed
**Cons**: Not integrated with workflow system, requires GitHub Actions environment

## Success Metrics

1. **Adoption**: Number of workflows using git-checkout step
2. **Performance**: Checkout time compared to regular clone
3. **Reliability**: Checkout success rate, cleanup success rate
4. **Disk usage**: Average disk savings with worktrees

## References

- [GitHub Actions checkout](https://github.com/actions/checkout)
- [Git worktree documentation](https://git-scm.com/docs/git-worktree)
- [Git sparse checkout](https://git-scm.com/docs/git-sparse-checkout)
- Visor check provider architecture (this codebase)

## Feedback Requested

1. Is the worktree approach the right one, or should we start simpler?
2. Are the configuration options sufficient? Any missing use cases?
3. How important is GitHub Actions compatibility?
4. What cleanup strategy feels safest and most intuitive?
5. Any concerns about the metadata tracking approach?

---

**Author**: Claude (with human guidance)
**Date**: 2025-11-21
**Version**: 0.1.0
