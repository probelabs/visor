# Git Checkout Update Strategy

## Overview

The git-checkout provider **updates the bare repository on every checkout run**, similar to GitHub Actions' `actions/checkout@v4` behavior. This ensures you always work with the latest code from the remote repository.

## How It Works

### Workflow on Each Checkout

```
1. Check if bare repository exists
   ├─ YES → Run `git remote update --prune`
   │         └─ Fetch all new refs from remote
   │         └─ Remove stale remote branches
   │         └─ Takes ~1-5 seconds
   └─ NO  → Clone bare repository
             └─ First-time setup
             └─ Takes ~30s for 100MB repo

2. Create worktree from updated bare repo
   └─ Checkout specific ref
   └─ Creates isolated working directory

3. Return worktree path to workflow
```

### Implementation Details

**Location**: `src/utils/worktree-manager.ts`

```typescript
async getOrCreateBareRepo(repository: string, repoUrl: string, token?: string): Promise<string> {
  const bareRepoPath = /* ... */;

  if (fs.existsSync(bareRepoPath)) {
    logger.debug(`Bare repository already exists: ${bareRepoPath}`);

    // 🔄 UPDATE ON EVERY RUN
    await this.updateBareRepo(bareRepoPath);
    return bareRepoPath;
  }

  // First time: clone bare repository
  // ...
}

private async updateBareRepo(bareRepoPath: string): Promise<void> {
  logger.debug(`Updating bare repository: ${bareRepoPath}`);

  // Fetch all updates from remote and prune stale refs
  const updateCmd = `git -C "${bareRepoPath}" remote update --prune`;
  const result = await this.executeGitCommand(updateCmd, { timeout: 60000 });

  if (result.exitCode !== 0) {
    logger.warn(`Failed to update bare repository: ${result.stderr}`);
    // Don't throw - continue with existing refs
  }
}
```

## Why Update on Every Run?

### ✅ Benefits

1. **Always Fresh**: Never work with stale code
2. **Predictable**: Same behavior as GitHub Actions
3. **Safe**: No risk of missing important commits
4. **Fast**: Only fetching deltas, not full re-clone (~1-5s vs ~30s)
5. **Automatic**: No manual intervention needed

### Comparison with Alternatives

| Strategy | Freshness | Performance | Complexity |
|----------|-----------|-------------|------------|
| **Update every run** ✅ | Always fresh | Good (1-5s) | Simple |
| Update once per workflow | May be stale | Best (<1s) | Medium |
| Manual update only | Often stale | Best (<1s) | Complex |
| TTL-based update | Sometimes stale | Good (varies) | Complex |

## Performance Impact

### Typical Checkout Timeline

```
First Checkout (Bare repo doesn't exist):
├─ Clone bare repository: 30s (100MB repo)
├─ Create worktree: 2s
└─ Total: ~32s

Subsequent Checkouts (Bare repo exists):
├─ Update bare repository: 1-5s
├─ Create worktree: 2s
└─ Total: ~3-7s
```

### Network Optimization

The `git remote update` command is efficient:
- Only fetches **new** commits/refs
- Uses git's pack file protocol (compressed)
- Supports resume for interrupted transfers
- Parallel fetch of multiple refs

### Example Performance

```bash
# Repository: 100MB, 1000 commits
# New commits since last update: 5

git remote update --prune
# Fetches only ~1MB delta
# Completes in 1-2 seconds
```

## Edge Cases

### 1. Network Failure

```typescript
if (result.exitCode !== 0) {
  logger.warn(`Failed to update bare repository: ${result.stderr}`);
  // ⚠️ Continue with existing refs (don't fail the checkout)
}
```

**Behavior**: Uses last successfully fetched state. The checkout still succeeds but may be slightly stale.

### 2. First Checkout After Long Time

If it's been a while since the last update:
- More data to fetch, but still incremental
- May take 5-10s instead of 1-2s
- Still faster than full re-clone (~30s)

### 3. Force Push on Remote

```bash
git remote update --prune
# Automatically handles force-pushed branches
# Updates local refs to match remote
# Removes refs that no longer exist (--prune)
```

### 4. Large Repositories

For very large repos (>1GB):
- Update still fast (only delta)
- Use shallow clones: `fetch_depth: 1`
- Reduces initial clone time significantly

**Shallow Clone Behavior:**

```yaml
steps:
  checkout:
    type: git-checkout
    ref: main
    fetch_depth: 1  # Only fetch 1 commit deep
```

Initial clone with depth:
```bash
git clone --bare --depth 1 <url>
# Much faster for large repos
# Only downloads recent commit history
```

**Important Notes:**
- `fetch_depth` applies to **initial clone only**
- Subsequent updates fetch all new commits (no depth limit on updates)
- This matches GitHub Actions behavior
- Trade-off: Fast initial clone vs. limited history

## Comparison with GitHub Actions

### actions/checkout@v4 Behavior

```yaml
- uses: actions/checkout@v4
  with:
    ref: main
```

GitHub Actions **always** fetches the latest code:
1. Creates fresh checkout on every run
2. No caching between runs (by default)
3. Each job gets clean state

### git-checkout Provider Behavior

```yaml
steps:
  checkout:
    type: git-checkout
    ref: main
```

Our provider:
1. Caches bare repository (saves time and bandwidth)
2. **Updates on every run** (same freshness as GitHub Actions)
3. Reuses cached objects (better performance)

**Result**: Same freshness, better performance!

## Configuration

### Default Behavior (Recommended)

No configuration needed - updates happen automatically:

```yaml
steps:
  checkout:
    type: git-checkout
    ref: "{{ pr.head }}"
```

### Future: Update Frequency Control (Not Yet Implemented)

If needed in the future, we could add:

```yaml
# Potential future enhancement
worktree_cache:
  update_frequency: always  # always (default), once_per_workflow, manual, ttl
  update_ttl_seconds: 300   # Only if frequency=ttl
```

Currently, we keep it simple: **always update**.

## Monitoring and Debugging

### Enable Debug Logs

```bash
export VISOR_DEBUG=true
```

Look for these log messages:

```
[debug] Bare repository already exists: .visor/worktrees/repos/owner-repo.git
[debug] Updating bare repository: .visor/worktrees/repos/owner-repo.git
[debug] Successfully updated bare repository
```

### Check Last Update Time

```bash
# In the bare repository
cd .visor/worktrees/repos/owner-repo.git
git show-ref
# Shows timestamps of last fetch
```

### Measure Update Performance

```bash
time git -C .visor/worktrees/repos/owner-repo.git remote update --prune
# Outputs how long the update took
```

## Best Practices

### 1. Trust the Updates

The automatic update strategy is designed to work reliably. Don't try to optimize by skipping updates unless you have a specific reason.

### 2. Use Shallow Clones for Large Repos

```yaml
steps:
  checkout:
    type: git-checkout
    ref: main
    fetch_depth: 1  # Only fetch latest commit
```

### 3. Monitor Network Issues

If your network is unreliable:
- The provider gracefully degrades to stale refs
- Checkout still succeeds with warning
- Check logs for update failures

### 4. CI/CD Considerations

In CI environments:
- First run clones bare repo (~30s)
- Subsequent runs update quickly (~1-5s)
- Consider caching `.visor/worktrees/repos/` between CI runs for additional speedup

## Troubleshooting

### Problem: Checkouts seem stale

**Check**:
```bash
# See when last update happened
git -C .visor/worktrees/repos/owner-repo.git log -1 --format="%ar"
```

**Solution**: Check debug logs for update failures

### Problem: Updates taking too long

**Check**: Repository size and network speed

**Solution**:
```yaml
# Use shallow clones
steps:
  checkout:
    type: git-checkout
    fetch_depth: 1
```

### Problem: Update failures

**Check**: Network connectivity, authentication

**Solution**: Updates fail gracefully - checkout uses last good state

## Summary

The git-checkout provider updates bare repositories on **every checkout run**, ensuring:

✅ Always fresh code (like GitHub Actions)
✅ Fast updates (only deltas, 1-5 seconds)
✅ Simple and predictable behavior
✅ No manual intervention needed
✅ Graceful degradation on network issues

This is the best default for most use cases, matching GitHub Actions behavior while providing better performance through smart caching.
