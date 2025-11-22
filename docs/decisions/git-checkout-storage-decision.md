# Storage Location Decision: Project-Local by Default

## Decision

The git-checkout provider now uses **project-local storage** (`.visor/worktrees/`) by default instead of system temp directories.

## Rationale

### Why Project-Local?

1. **Simplicity**: Worktrees stay with the project, making them easier to find and manage
2. **Predictability**: Always know where worktrees are located
3. **Cleanup**: Removing the project automatically removes all worktrees
4. **Debugging**: Easy to inspect worktree contents during development
5. **Isolation**: Each project has its own worktree cache
6. **No Pollution**: Doesn't clutter system-wide temp directories

### Why Not System Temp?

While system temp directories (/tmp, etc.) have automatic OS cleanup, they have drawbacks:
- Harder to locate for debugging
- Scattered across the filesystem
- May persist longer than needed
- Harder to manage manually
- Less intuitive for users

## Implementation

### Default Location

```
<project-root>/.visor/worktrees/
├── repos/              # Bare repositories
└── worktrees/          # Working directories
```

### Configuration Hierarchy

1. **Environment Variable** (highest priority):
   ```bash
   export VISOR_WORKTREE_PATH=/custom/path/to/worktrees
   ```

2. **Config File**:
   ```yaml
   worktree_cache:
     base_path: /custom/path/to/worktrees
   ```

3. **Default** (if nothing configured):
   ```
   .visor/worktrees/  # In project root
   ```

## User Experience

### For New Users

- Works out of the box
- No configuration needed
- Worktrees appear in predictable location
- Easy to understand and debug

### For Advanced Users

- Full control via environment variable or config
- Can use system temp if preferred: `VISOR_WORKTREE_PATH=/tmp/visor-worktrees`
- Can share worktrees across projects: `VISOR_WORKTREE_PATH=~/.visor/shared-worktrees`

## .gitignore Recommendation

Users should add to their `.gitignore`:

```gitignore
# Visor worktree cache
.visor/worktrees/
```

This is documented in:
- `docs/providers/git-checkout.md`
- `docs/providers/gitignore-recommendation.md`

## Migration

### From Previous Versions

If we had previously used system temp directories, users upgrading would:
1. Old worktrees in `/tmp` would gradually be cleaned up by age
2. New worktrees created in `.visor/worktrees/`
3. No manual migration needed

### Changing Storage Location

Users can change the location at any time:

```yaml
worktree_cache:
  base_path: /new/location
```

Old worktrees are not automatically migrated. They will:
- Be cleaned up by age-based cleanup
- Or can be manually removed

## Examples

### Development (Default)

```yaml
# No configuration needed
steps:
  checkout:
    type: git-checkout
    ref: "{{ pr.head }}"
```

Worktrees created in: `.visor/worktrees/`

### CI/CD (Ephemeral)

```bash
# In CI environment
export VISOR_WORKTREE_PATH=/tmp/ci-worktrees-${CI_JOB_ID}
```

Worktrees created in job-specific temp directory, automatically cleaned by CI system.

### Shared Across Projects

```bash
# Global setting
export VISOR_WORKTREE_PATH=~/.cache/visor/worktrees
```

Multiple projects share the same worktree cache, maximizing disk efficiency.

## Benefits Summary

| Aspect | Project-Local | System Temp |
|--------|--------------|-------------|
| Discoverability | ✅ Easy | ❌ Hard |
| Cleanup | ✅ Delete project | ⚠️ OS-dependent |
| Debugging | ✅ Accessible | ❌ Scattered |
| Predictability | ✅ Always same | ❌ Varies |
| Multi-project | ⚠️ Per-project | ✅ Shared |
| Disk usage | ⚠️ Per-project | ✅ Centralized |

## Trade-offs

### Project-Local Advantages
- Simplicity and predictability
- Easy discovery and debugging
- Natural cleanup when project deleted
- Intuitive for new users

### Project-Local Disadvantages
- Uses project disk space (can be large)
- Separate cache per project (less sharing)
- Users must add to `.gitignore`

### Mitigation
- Environment variable override for power users
- Clear documentation about `.gitignore`
- Age-based cleanup to prevent bloat
- Option to use shared location if desired

## Conclusion

Project-local storage is the **better default** for most users, while power users can opt into system-wide or shared storage via configuration.

This decision prioritizes:
1. User experience over disk optimization
2. Simplicity over flexibility (for defaults)
3. Predictability over advanced features (for defaults)

Advanced users retain full control through configuration options.
