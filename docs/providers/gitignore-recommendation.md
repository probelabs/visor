# .gitignore Recommendation for Worktrees

When using the git-checkout provider, worktrees are stored locally in your project by default. You should add the worktree directory to your `.gitignore` to avoid committing temporary checkout directories.

## Recommended .gitignore Entry

Add this to your `.gitignore` file:

```gitignore
# Visor worktree cache
.visor/worktrees/
```

## Why Exclude Worktrees?

1. **Temporary Nature**: Worktrees are temporary working directories created during workflow execution
2. **Size**: Worktrees can be large, especially with full git history
3. **Duplication**: Worktrees contain copies of your repository code
4. **Machine-Specific**: Worktree paths and metadata are specific to the machine running the workflow

## What Gets Stored in .visor/worktrees/

```
.visor/worktrees/
├── repos/              # Bare repositories (contain git objects)
│   └── *.git/
└── worktrees/          # Working directories (contain checked out code)
    └── */
```

Both directories should be excluded from version control.

## Complete .gitignore Example

```gitignore
# Node modules
node_modules/

# Build output
dist/
build/

# Environment files
.env
.env.local

# IDE
.vscode/
.idea/

# Visor
.visor/worktrees/      # Exclude worktree cache
# .visor/config.yaml   # Keep your config (optional)
```

## Alternative: Exclude All .visor/

If you prefer to keep all Visor-related files out of version control:

```gitignore
# Visor (exclude all)
.visor/
!.visor/config.yaml    # But keep the config file
```

## CI/CD Considerations

In CI/CD environments:
- Worktrees are automatically cleaned up after workflow execution
- The `.visor/worktrees/` directory is created fresh on each run
- No need to cache worktrees between CI runs (they're specific to each job)

## Custom Storage Location

If you use a custom storage location via `VISOR_WORKTREE_PATH` or config:

```yaml
worktree_cache:
  base_path: /tmp/my-worktrees  # Custom location
```

Then you don't need to add anything to `.gitignore` since the worktrees are stored outside your project.
