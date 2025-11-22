# Shallow Clone Support

## Overview

The git-checkout provider supports **shallow clones** via the `fetch_depth` parameter, which can significantly speed up initial repository clones for large repositories.

## Usage

```yaml
steps:
  checkout:
    type: git-checkout
    ref: "{{ pr.head }}"
    fetch_depth: 1  # Only fetch latest commit
```

## How It Works

### Initial Clone

When `fetch_depth` is specified, the initial bare repository clone uses `--depth`:

```bash
git clone --bare --depth 1 https://github.com/owner/repo.git
```

**What this does:**
- Only downloads the specified number of commits
- Much smaller download size
- Faster clone time (5-10x for large repos)
- Limited commit history

### Subsequent Updates

After the initial clone, updates do **NOT** use depth limits:

```bash
git remote update --prune  # No --depth flag
```

**Why?**
- Ensures you get all new commits since last update
- Prevents missing important changes
- Matches GitHub Actions behavior
- Still fast (only fetching deltas)

## Performance Impact

### Example: Large Repository (1GB, 10,000 commits)

| Scenario | Full Clone | Shallow Clone (depth=1) | Speedup |
|----------|-----------|-------------------------|---------|
| Initial clone | 60s | 8s | 7.5x |
| Clone size | 1GB | 150MB | 85% reduction |
| Bandwidth | 1GB | 150MB | 85% reduction |

### Example: Medium Repository (100MB, 1,000 commits)

| Scenario | Full Clone | Shallow Clone (depth=1) | Speedup |
|----------|-----------|-------------------------|---------|
| Initial clone | 15s | 3s | 5x |
| Clone size | 100MB | 20MB | 80% reduction |
| Bandwidth | 100MB | 20MB | 80% reduction |

## Common Depth Values

| fetch_depth | Use Case | Pros | Cons |
|-------------|----------|------|------|
| **1** | CI/CD, testing, builds | Fastest, minimal bandwidth | No history |
| **10** | Recent history needed | Fast, some history | Limited history |
| **50** | More history needed | Good balance | Moderate size |
| **0 or omit** | Full analysis | Complete history | Slow, large |

## When to Use Shallow Clones

### ✅ Recommended For:

1. **CI/CD Pipelines**
   ```yaml
   checkout:
     type: git-checkout
     ref: "{{ pr.head }}"
     fetch_depth: 1
   ```

2. **Building/Testing**
   - Only latest code needed
   - Don't need commit history
   - Fast feedback important

3. **Large Repositories**
   - Repositories > 500MB
   - Many commits (> 10,000)
   - Limited bandwidth

4. **Deployment Workflows**
   - Just need latest version
   - No git operations on history

### ❌ Not Recommended For:

1. **Git History Operations**
   ```bash
   git log          # Needs history
   git blame        # Needs history
   git bisect       # Needs history
   ```

2. **Changelog Generation**
   - Need commit messages
   - Need commit dates
   - Need author information

3. **License Compliance**
   - Scanning full repository history
   - Tracking license changes

4. **Repository Analysis**
   - Code churn analysis
   - Contributor statistics
   - Full repository metrics

## Examples

### Example 1: Fast CI Build

```yaml
version: "1.0"

steps:
  # Fast shallow checkout
  checkout:
    type: git-checkout
    ref: "{{ pr.head }}"
    fetch_depth: 1

  # Run tests (doesn't need history)
  test:
    type: command
    depends_on: [checkout]
    exec: npm test
    working_directory: "{{ outputs.checkout.path }}"
```

### Example 2: Changelog Generation (Needs History)

```yaml
version: "1.0"

steps:
  # Full history checkout
  checkout:
    type: git-checkout
    ref: "{{ pr.head }}"
    # No fetch_depth - gets full history

  # Generate changelog (needs git log)
  changelog:
    type: command
    depends_on: [checkout]
    exec: |
      git log --oneline --since="1 month ago"
    working_directory: "{{ outputs.checkout.path }}"
```

### Example 3: Different Depths for Different Repos

```yaml
version: "1.0"

steps:
  # Large repo - shallow clone
  checkout-main:
    type: git-checkout
    repository: myorg/large-monorepo
    ref: main
    fetch_depth: 1

  # Small repo - full history
  checkout-docs:
    type: git-checkout
    repository: myorg/documentation
    ref: main
    # No fetch_depth - full history
```

### Example 4: Conditional Depth Based on Event

```yaml
version: "1.0"

steps:
  determine-depth:
    type: command
    exec: |
      # Shallow for PRs, full for releases
      if [ "{{ pr.number }}" != "" ]; then
        echo '{"depth": 1}'
      else
        echo '{"depth": 0}'
      fi
    transform_js: JSON.parse(output)

  checkout:
    type: git-checkout
    depends_on: [determine-depth]
    ref: "{{ pr.head || 'main' }}"
    fetch_depth: "{{ outputs['determine-depth'].depth }}"
```

## Limitations

### 1. Limited History

**Problem**: Can't access commits beyond depth

```bash
git log --all  # Only shows shallow history
git blame file.txt  # May fail if file older than depth
```

**Solution**: Use full clone for history operations

### 2. Shallow Clone Warning

Git will warn about shallow repositories:

```
You are in a shallow clone with history truncated to 1 commit
```

This is expected and safe to ignore for most use cases.

### 3. Some Git Operations Don't Work

Operations that need full history may fail:

```bash
git bisect    # Needs full history
git describe --tags  # May fail
git rebase    # Limited
```

### 4. Converting Shallow to Full

If you need full history later:

```bash
git fetch --unshallow  # Convert to full clone
```

However, this defeats the purpose of shallow clones.

## Technical Details

### Shallow Clone Command

```bash
# What we run for initial clone
git clone --bare --depth 1 https://github.com/owner/repo.git
```

**Flags:**
- `--bare`: Creates bare repository (no working directory)
- `--depth 1`: Only fetch 1 commit deep

### Update Command (No Depth)

```bash
# What we run for updates
git -C /path/to/bare/repo remote update --prune
```

**Important**: No `--depth` flag on updates!

### Why No Depth on Updates?

1. **Avoid Missing Commits**: New commits should be fetched completely
2. **Prevent Gaps**: Depth on updates can create discontinuous history
3. **Match GitHub Actions**: Same behavior as `actions/checkout@v4`
4. **Still Fast**: Only fetching deltas since last update

## Comparison with GitHub Actions

### actions/checkout@v4

```yaml
- uses: actions/checkout@v4
  with:
    ref: main
    fetch-depth: 1
```

**Behavior:**
- Initial checkout uses `--depth 1`
- Each job gets fresh shallow clone
- No updates (always fresh clone)

### git-checkout Provider

```yaml
steps:
  checkout:
    type: git-checkout
    ref: main
    fetch_depth: 1
```

**Behavior:**
- Initial clone uses `--depth 1` ✅ Same
- Subsequent runs update without depth ✅ Better (caches bare repo)
- Faster subsequent runs ✅ Better (reuses objects)

## Troubleshooting

### Problem: "Shallow fetch failed"

**Cause**: Some git servers don't support shallow clones

**Solution**: Omit `fetch_depth` to use full clone

### Problem: "Git operation needs full history"

**Cause**: Using shallow clone for history operation

**Solution**: Use full clone for that step:

```yaml
steps:
  # Shallow for build
  checkout-build:
    type: git-checkout
    ref: "{{ pr.head }}"
    fetch_depth: 1

  # Full for analysis
  checkout-analysis:
    type: git-checkout
    ref: "{{ pr.head }}"
    # No fetch_depth - full history
```

### Problem: "Performance not improved"

**Possible causes:**
1. Repository is already small
2. Network is not the bottleneck
3. Bare repo already cached (first run is slow, subsequent fast)

**Check**: Time the first vs. second checkout

## Best Practices

### 1. Default to Shallow in CI

```yaml
# Good default for most CI workflows
steps:
  checkout:
    type: git-checkout
    ref: "{{ pr.head }}"
    fetch_depth: 1
```

### 2. Full Clone for Development

```yaml
# Local development - full history useful
steps:
  checkout:
    type: git-checkout
    ref: main
    # No fetch_depth - full history for git log, etc.
```

### 3. Document Why You Need Full History

```yaml
steps:
  checkout:
    type: git-checkout
    ref: main
    # Full history needed for changelog generation
    # fetch_depth intentionally omitted
```

### 4. Monitor Clone Times

Log clone times to optimize:

```yaml
steps:
  checkout:
    type: git-checkout
    ref: "{{ pr.head }}"
    fetch_depth: 1

  log-time:
    type: logger
    depends_on: [checkout]
    message: "Checkout completed in {{ outputs.checkout.time }}s"
```

## Summary

**Shallow clones are:**
- ✅ Much faster for large repositories (5-10x)
- ✅ Use less bandwidth (80-90% reduction)
- ✅ Perfect for CI/CD workflows
- ✅ Recommended for most use cases
- ⚠️ Limited for git history operations
- ⚠️ Not suitable for analysis requiring full history

**Recommendation**: Use `fetch_depth: 1` by default in CI/CD, omit for development and analysis workflows.
